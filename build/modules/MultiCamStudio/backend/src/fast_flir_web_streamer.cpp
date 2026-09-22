#include <flirmulticamera/FlirCamera.h>

#include <spdlog/spdlog.h>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace flirmulticamera;

namespace {

using namespace std::chrono_literals;

constexpr int kDefaultPort = 8080;
constexpr int kDefaultBitrateMbit = 4;
constexpr const char* kBrowserCodec = "avc1.64002A";  // H.264 High, level 4.2

// FFmpeg made the custom AVIO write buffer const in libavformat 61
// (FFmpeg 7). Keep one source compatible with both API variants.
#if LIBAVFORMAT_VERSION_MAJOR >= 61
using AvioWriteByte = const std::uint8_t;
#else
using AvioWriteByte = std::uint8_t;
#endif

std::atomic<bool> running{true};

void request_shutdown(int) { running.store(false); }

std::string ffmpeg_error(int value) {
  char text[AV_ERROR_MAX_STRING_SIZE]{};
  av_strerror(value, text, sizeof(text));
  return text;
}

void check_ffmpeg(int value, const std::string& operation) {
  if (value < 0) {
    throw std::runtime_error(operation + ": " + ffmpeg_error(value));
  }
}

struct InputPixelFormat {
  AVPixelFormat format;
  int bytes_per_pixel;
};

InputPixelFormat input_pixel_format(const std::string& name) {
  if (name == "RGB8") return {AV_PIX_FMT_RGB24, 3};
  if (name == "BGR8") return {AV_PIX_FMT_BGR24, 3};
  if (name == "YCbCr422_8_CbYCrY") return {AV_PIX_FMT_UYVY422, 2};
  if (name == "BayerGB8") return {AV_PIX_FMT_BAYER_GBRG8, 1};
  throw std::runtime_error("Unsupported camera pixel format for streaming: " + name);
}

bool send_all(int socket, const void* data, std::size_t size) {
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  while (size > 0 && running.load()) {
    const auto sent = ::send(socket, bytes, size, MSG_NOSIGNAL);
    if (sent <= 0) return false;
    bytes += sent;
    size -= static_cast<std::size_t>(sent);
  }
  return size == 0;
}

bool send_text(int socket, const std::string& text) {
  return send_all(socket, text.data(), text.size());
}

std::string json_escape(const std::string& value) {
  std::ostringstream result;
  for (const unsigned char c : value) {
    switch (c) {
      case '"': result << "\\\""; break;
      case '\\': result << "\\\\"; break;
      case '\b': result << "\\b"; break;
      case '\f': result << "\\f"; break;
      case '\n': result << "\\n"; break;
      case '\r': result << "\\r"; break;
      case '\t': result << "\\t"; break;
      default:
        if (c < 0x20) {
          result << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<int>(c) << std::dec;
        } else {
          result << static_cast<char>(c);
        }
    }
  }
  return result.str();
}

void respond(int socket, int status, const std::string& content_type,
             const std::string& body) {
  const char* reason = status == 200 ? "OK" : "Not Found";
  std::ostringstream header;
  header << "HTTP/1.1 " << status << ' ' << reason
         << "\r\nContent-Type: " << content_type
         << "\r\nContent-Length: " << body.size()
         << "\r\nAccess-Control-Allow-Origin: *"
         << "\r\nCache-Control: no-store"
         << "\r\nConnection: close\r\n\r\n";
  send_text(socket, header.str());
  send_text(socket, body);
}

std::string default_config_path() {
  if (const char* path = std::getenv("CAMERA_SETTINGS_FILE");
      path != nullptr && path[0] != '\0') {
    return path;
  }
#ifdef CONFIG_DIR
  return std::string(CONFIG_DIR) + "/1024x768_example.json";
#else
  throw std::runtime_error(
      "Set CAMERA_SETTINGS_FILE or pass the camera JSON as argv[1]");
#endif
}

// The encoder owns one latest-input slot and one latest-output slot. Acquisition
// therefore never waits for NVENC or for a slow browser: old preview frames are
// overwritten instead of building latency.
class NvencFmp4Channel {
 public:
  struct Fragment {
    std::vector<std::uint8_t> bytes;
    std::uint64_t sequence{0};
    std::uint64_t timestamp_us{0};
    bool keyframe{false};
  };

  NvencFmp4Channel(int width, int height, int fps, int bitrate_mbit,
                   InputPixelFormat source_format, std::string camera_id)
      : width_(width),
        height_(height),
        fps_(std::max(1, fps)),
        bitrate_mbit_(bitrate_mbit),
        source_format_(source_format),
        camera_id_(std::move(camera_id)) {
    if ((width_ & 1) != 0 || (height_ & 1) != 0) {
      throw std::runtime_error("NV12 streaming needs even image dimensions");
    }
    initialize_encoder();
    initialize_muxer();
    worker_ = std::thread(&NvencFmp4Channel::encode_loop, this);
  }

  NvencFmp4Channel(const NvencFmp4Channel&) = delete;
  NvencFmp4Channel& operator=(const NvencFmp4Channel&) = delete;

  ~NvencFmp4Channel() {
    stop_.store(true);
    input_condition_.notify_all();
    fragment_condition_.notify_all();
    if (worker_.joinable()) worker_.join();

    if (format_context_ != nullptr) {
      av_write_trailer(format_context_);
      if (format_context_->pb != nullptr) {
        av_freep(&format_context_->pb->buffer);
        avio_context_free(&format_context_->pb);
      }
      avformat_free_context(format_context_);
    }
    sws_freeContext(sws_context_);
    av_packet_free(&packet_);
    av_frame_free(&frame_);
    avcodec_free_context(&codec_context_);
  }

  void submit(const std::uint8_t* source, int source_stride) {
    if (source == nullptr || source_stride <= 0) return;
    std::lock_guard<std::mutex> lock(input_mutex_);
    const std::size_t size = static_cast<std::size_t>(source_stride) * height_;
    pending_pixels_.resize(size);
    std::memcpy(pending_pixels_.data(), source, size);
    pending_stride_ = source_stride;
    input_available_ = true;
    input_condition_.notify_one();
  }

  const std::vector<std::uint8_t>& initialization_segment() const {
    return initialization_segment_;
  }

  void request_keyframe() { force_keyframe_.store(true); }

  bool wait_for_fragment(std::uint64_t after_sequence, Fragment& result) {
    std::unique_lock<std::mutex> lock(fragment_mutex_);
    fragment_condition_.wait_for(lock, 500ms, [&] {
      return latest_fragment_.sequence > after_sequence || stop_.load() ||
             !running.load();
    });
    if (latest_fragment_.sequence <= after_sequence) return false;
    result = latest_fragment_;
    return true;
  }

 private:
  static int write_muxed_bytes(void* opaque, AvioWriteByte* bytes, int size) {
    auto* self = static_cast<NvencFmp4Channel*>(opaque);
    self->muxed_bytes_.insert(self->muxed_bytes_.end(), bytes, bytes + size);
    return size;
  }

  void set_encoder_option(const char* name, const char* value) {
    const int result = av_opt_set(codec_context_->priv_data, name, value, 0);
    if (result < 0) {
      spdlog::debug("Camera {}: NVENC option {}={} unavailable ({})", camera_id_,
                    name, value, ffmpeg_error(result));
    }
  }

  void initialize_encoder() {
    const AVCodec* codec = avcodec_find_encoder_by_name("h264_nvenc");
    if (codec == nullptr) {
      throw std::runtime_error(
          "FFmpeg has no h264_nvenc encoder; install an NVENC-enabled build");
    }

    codec_context_ = avcodec_alloc_context3(codec);
    if (codec_context_ == nullptr) throw std::bad_alloc();

    codec_context_->width = width_;
    codec_context_->height = height_;
    codec_context_->pix_fmt = AV_PIX_FMT_NV12;
    codec_context_->time_base = AVRational{1, fps_};
    codec_context_->framerate = AVRational{fps_, 1};
    codec_context_->bit_rate =
        static_cast<std::int64_t>(bitrate_mbit_) * 1024 * 1024;
    codec_context_->rc_min_rate = codec_context_->bit_rate;
    codec_context_->rc_max_rate = codec_context_->bit_rate;
    codec_context_->rc_buffer_size = codec_context_->bit_rate / fps_ * 4;
    codec_context_->gop_size = fps_;       // normal join delay <= 1 s
    codec_context_->max_b_frames = 0;      // no frame reordering/latency
    codec_context_->profile = FF_PROFILE_H264_HIGH;
    codec_context_->level = 42;
    codec_context_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

#if LIBAVCODEC_VERSION_MAJOR < 59
    // FFmpeg 4.x uses the legacy NVENC preset names. "llhp" is the
    // low-latency/high-performance counterpart of the newer p1 + ull setup.
    set_encoder_option("preset", "llhp");
#else
    set_encoder_option("preset", "p1");
    set_encoder_option("tune", "ull");
#endif
    set_encoder_option("rc", "cbr");
    set_encoder_option("zerolatency", "1");
    set_encoder_option("delay", "0");
    set_encoder_option("forced-idr", "1");
    set_encoder_option("profile", "high");
    set_encoder_option("level", "4.2");

    check_ffmpeg(avcodec_open2(codec_context_, codec, nullptr),
                 "Could not open h264_nvenc for camera " + camera_id_);

    frame_ = av_frame_alloc();
    packet_ = av_packet_alloc();
    if (frame_ == nullptr || packet_ == nullptr) throw std::bad_alloc();
    frame_->format = codec_context_->pix_fmt;
    frame_->width = width_;
    frame_->height = height_;
    check_ffmpeg(av_frame_get_buffer(frame_, 32), "Could not allocate NV12 frame");

    sws_context_ = sws_getContext(
        width_, height_, source_format_.format, width_, height_, AV_PIX_FMT_NV12,
        SWS_FAST_BILINEAR, nullptr, nullptr, nullptr);
    if (sws_context_ == nullptr) {
      throw std::runtime_error("Could not create RGB/YUV to NV12 converter");
    }
  }

  void initialize_muxer() {
    check_ffmpeg(avformat_alloc_output_context2(&format_context_, nullptr, "mp4",
                                                nullptr),
                 "Could not create fragmented-MP4 muxer");
    if (format_context_ == nullptr) {
      throw std::runtime_error("Could not create fragmented-MP4 muxer");
    }

    stream_ = avformat_new_stream(format_context_, nullptr);
    if (stream_ == nullptr) throw std::bad_alloc();
    stream_->time_base = codec_context_->time_base;
    check_ffmpeg(avcodec_parameters_from_context(stream_->codecpar,
                                                 codec_context_),
                 "Could not copy H.264 stream parameters");

    constexpr int kAvioBufferSize = 64 * 1024;
    auto* avio_buffer = static_cast<unsigned char*>(av_malloc(kAvioBufferSize));
    if (avio_buffer == nullptr) throw std::bad_alloc();
    format_context_->pb = avio_alloc_context(
        avio_buffer, kAvioBufferSize, 1, this, nullptr, &write_muxed_bytes,
        nullptr);
    if (format_context_->pb == nullptr) {
      av_free(avio_buffer);
      throw std::bad_alloc();
    }
    format_context_->flags |= AVFMT_FLAG_CUSTOM_IO;

    AVDictionary* options = nullptr;
    av_dict_set(&options, "movflags",
                "empty_moov+default_base_moof+frag_custom+omit_tfhd_offset",
                0);
    const int result = avformat_write_header(format_context_, &options);
    av_dict_free(&options);
    check_ffmpeg(result, "Could not write fragmented-MP4 header");
    avio_flush(format_context_->pb);
    initialization_segment_.swap(muxed_bytes_);
    if (initialization_segment_.empty()) {
      throw std::runtime_error("MP4 muxer produced an empty initialization segment");
    }
  }

  void encode_loop() {
    while (!stop_.load() && running.load()) {
      std::vector<std::uint8_t> pixels;
      int source_stride = 0;
      {
        std::unique_lock<std::mutex> lock(input_mutex_);
        input_condition_.wait(lock, [&] {
          return input_available_ || stop_.load() || !running.load();
        });
        if (stop_.load() || !running.load()) break;
        pixels.swap(pending_pixels_);
        source_stride = pending_stride_;
        input_available_ = false;
      }

      check_ffmpeg(av_frame_make_writable(frame_), "NV12 frame is not writable");
      const std::uint8_t* source_planes[] = {pixels.data(), nullptr, nullptr,
                                             nullptr};
      const int source_strides[] = {source_stride, 0, 0, 0};
      const int rows = sws_scale(sws_context_, source_planes, source_strides, 0,
                                 height_, frame_->data, frame_->linesize);
      if (rows != height_) {
        spdlog::warn("Camera {}: pixel conversion returned {} of {} rows",
                     camera_id_, rows, height_);
        continue;
      }

      frame_->pts = frame_number_++;
      frame_->pict_type = force_keyframe_.exchange(false) ? AV_PICTURE_TYPE_I
                                                          : AV_PICTURE_TYPE_NONE;
      const int send_result = avcodec_send_frame(codec_context_, frame_);
      if (send_result < 0) {
        spdlog::error("Camera {}: avcodec_send_frame failed: {}", camera_id_,
                      ffmpeg_error(send_result));
        continue;
      }

      while (true) {
        const int receive_result = avcodec_receive_packet(codec_context_, packet_);
        if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) break;
        if (receive_result < 0) {
          spdlog::error("Camera {}: avcodec_receive_packet failed: {}", camera_id_,
                        ffmpeg_error(receive_result));
          break;
        }

        const bool keyframe = (packet_->flags & AV_PKT_FLAG_KEY) != 0;
        const std::int64_t original_pts = packet_->pts;
        packet_->stream_index = stream_->index;
        // Set duration in the codec time base before rescaling it to the MP4
        // stream time base (which the muxer is free to change in write_header).
        packet_->duration = 1;
        av_packet_rescale_ts(packet_, codec_context_->time_base,
                             stream_->time_base);

        muxed_bytes_.clear();
        const int write_result = av_write_frame(format_context_, packet_);
        // With frag_custom, a null packet explicitly closes the current
        // fragment. This avoids the one-packet delay of frag_every_frame in
        // older MOV muxers and guarantees bytes for the very first keyframe.
        const int fragment_result =
            write_result < 0 ? write_result
                             : av_write_frame(format_context_, nullptr);
        avio_flush(format_context_->pb);
        if (write_result < 0 || fragment_result < 0 || muxed_bytes_.empty()) {
          spdlog::error("Camera {}: MP4 fragment creation failed: {}", camera_id_,
                        write_result < 0 ? ffmpeg_error(write_result)
                        : fragment_result < 0 ? ffmpeg_error(fragment_result)
                                         : "empty fragment");
          av_packet_unref(packet_);
          continue;
        }

        Fragment next;
        next.bytes.swap(muxed_bytes_);
        next.keyframe = keyframe;
        const std::int64_t pts =
            original_pts == AV_NOPTS_VALUE ? frame_->pts : original_pts;
        next.timestamp_us = static_cast<std::uint64_t>(
            av_rescale_q(pts, codec_context_->time_base, AVRational{1, 1000000}));
        {
          std::lock_guard<std::mutex> lock(fragment_mutex_);
          next.sequence = latest_fragment_.sequence + 1;
          latest_fragment_ = std::move(next);
        }
        fragment_condition_.notify_all();
        av_packet_unref(packet_);
      }
    }
  }

  int width_;
  int height_;
  int fps_;
  int bitrate_mbit_;
  InputPixelFormat source_format_;
  std::string camera_id_;

  AVCodecContext* codec_context_{nullptr};
  AVFrame* frame_{nullptr};
  AVPacket* packet_{nullptr};
  SwsContext* sws_context_{nullptr};
  AVFormatContext* format_context_{nullptr};
  AVStream* stream_{nullptr};
  std::vector<std::uint8_t> muxed_bytes_;
  std::vector<std::uint8_t> initialization_segment_;
  std::int64_t frame_number_{0};

  std::atomic<bool> stop_{false};
  std::atomic<bool> force_keyframe_{true};
  std::mutex input_mutex_;
  std::condition_variable input_condition_;
  std::vector<std::uint8_t> pending_pixels_;
  int pending_stride_{0};
  bool input_available_{false};
  std::thread worker_;

  std::mutex fragment_mutex_;
  std::condition_variable fragment_condition_;
  Fragment latest_fragment_;
};

class FlirCameraBank {
 public:
  FlirCameraBank(const std::string& config_file, int bitrate_mbit) {
    load_camera_settings(config_file, settings_);
    camera_ids_ = settings_.SNs;
    if (camera_ids_.empty()) {
      throw std::runtime_error("Camera configuration contains no serial numbers");
    }
    fps_ = std::max(1, static_cast<int>(std::lround(settings_.fps)));
    const auto pixel_format = input_pixel_format(settings_.pixel_format);

    camera_ = std::make_unique<FlirCameraHandler>(settings_);
    if (!camera_->Configure()) {
      throw std::runtime_error("Could not configure FlirCameraHandler");
    }

    channels_.reserve(camera_ids_.size());
    for (const auto& id : camera_ids_) {
      channels_.push_back(std::make_unique<NvencFmp4Channel>(
          static_cast<int>(settings_.width), static_cast<int>(settings_.height),
          fps_, bitrate_mbit, pixel_format, id));
    }
  }

  FlirCameraBank(const FlirCameraBank&) = delete;
  FlirCameraBank& operator=(const FlirCameraBank&) = delete;

  ~FlirCameraBank() {
    running.store(false);
    if (capture_thread_.joinable()) capture_thread_.join();
  }

  void start() { capture_thread_ = std::thread(&FlirCameraBank::capture_loop, this); }
  std::size_t size() const { return channels_.size(); }
  int fps() const { return fps_; }
  int width() const { return static_cast<int>(settings_.width); }
  int height() const { return static_cast<int>(settings_.height); }
  const std::vector<std::string>& camera_ids() const { return camera_ids_; }
  NvencFmp4Channel& channel(std::size_t index) { return *channels_.at(index); }

 private:
  void capture_loop() {
    camera_->Start();
    spdlog::info("FLIR capture and NVENC streaming started");
    while (running.load()) {
      std::vector<Frame> captured;
      if (!camera_->Get(captured)) {
        std::this_thread::sleep_for(50us);
        continue;
      }
      const std::size_t count = std::min(captured.size(), channels_.size());
      for (std::size_t i = 0; i < count; ++i) {
        const auto& image = captured[i].frameData;
        if (image == nullptr || image->IsIncomplete()) continue;
        if (static_cast<int>(image->GetWidth()) != width() ||
            static_cast<int>(image->GetHeight()) != height()) {
          spdlog::warn("Camera {} returned {}x{}, configured for {}x{}",
                       camera_ids_[i], image->GetWidth(), image->GetHeight(),
                       width(), height());
          continue;
        }
        channels_[i]->submit(static_cast<const std::uint8_t*>(image->GetData()),
                             static_cast<int>(image->GetStride()));
      }
    }
    camera_->Stop();
  }

  CameraSettings settings_;
  std::unique_ptr<FlirCameraHandler> camera_;
  std::vector<std::string> camera_ids_;
  std::vector<std::unique_ptr<NvencFmp4Channel>> channels_;
  int fps_{1};
  std::thread capture_thread_;
};

void put_u32_be(std::uint8_t* output, std::uint32_t value) {
  output[0] = static_cast<std::uint8_t>(value >> 24);
  output[1] = static_cast<std::uint8_t>(value >> 16);
  output[2] = static_cast<std::uint8_t>(value >> 8);
  output[3] = static_cast<std::uint8_t>(value);
}

void put_u64_be(std::uint8_t* output, std::uint64_t value) {
  for (int i = 7; i >= 0; --i) {
    output[7 - i] = static_cast<std::uint8_t>(value >> (i * 8));
  }
}

// Record: flags:u8, payload_size:u32be, timestamp_us:u64be, payload.
bool send_record(int socket, std::uint8_t flags, std::uint64_t timestamp_us,
                 const std::vector<std::uint8_t>& payload) {
  if (payload.size() > UINT32_MAX) return false;
  std::uint8_t header[13]{};
  header[0] = flags;
  put_u32_be(header + 1, static_cast<std::uint32_t>(payload.size()));
  put_u64_be(header + 5, timestamp_us);
  return send_all(socket, header, sizeof(header)) &&
         send_all(socket, payload.data(), payload.size());
}

void stream_camera(int socket, FlirCameraBank& cameras, std::size_t index) {
  const std::string header =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/x-flir-fmp4\r\n"
      "Access-Control-Allow-Origin: *\r\n"
      "Cache-Control: no-store, no-cache, must-revalidate\r\n"
      "X-Accel-Buffering: no\r\n"
      "Connection: close\r\n\r\n";
  if (!send_text(socket, header)) return;

  auto& channel = cameras.channel(index);
  if (!send_record(socket, 0x01, 0, channel.initialization_segment())) return;

  channel.request_keyframe();
  std::uint64_t sequence = 0;
  bool waiting_for_keyframe = true;
  while (running.load()) {
    NvencFmp4Channel::Fragment fragment;
    if (!channel.wait_for_fragment(sequence, fragment)) continue;
    sequence = fragment.sequence;
    if (waiting_for_keyframe && !fragment.keyframe) continue;
    waiting_for_keyframe = false;
    const std::uint8_t flags = fragment.keyframe ? 0x02 : 0x00;
    if (!send_record(socket, flags, fragment.timestamp_us, fragment.bytes)) break;
  }
}

std::string camera_json(const FlirCameraBank& cameras) {
  std::ostringstream json;
  json << "{\"streaming\":true,\"transport\":\"fmp4\",\"cameras\":[";
  for (std::size_t i = 0; i < cameras.size(); ++i) {
    if (i != 0) json << ',';
    json << "{\"id\":\"" << json_escape(cameras.camera_ids()[i])
         << "\",\"name\":\"Camera " << (i + 1)
         << "\",\"stream\":\"/api/cameras/" << i
         << "/stream\",\"codec\":\"" << kBrowserCodec
         << "\",\"width\":" << cameras.width()
         << ",\"height\":" << cameras.height()
         << ",\"fps\":" << cameras.fps() << '}';
  }
  return json.str() + "]}";
}

#ifndef FLIR_STREAMER_API_ONLY
const char* kPlayerHtml = R"HTML(<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FLIR live view</title>
  <style>
    :root{color-scheme:dark;background:#101316;color:#e9edf0;font:14px system-ui,sans-serif}
    body{margin:0;padding:22px} header{display:flex;align-items:baseline;gap:14px;margin-bottom:14px;flex-wrap:wrap}
    h1{font-size:21px;margin:0} #summary,.status{color:#98a5ae}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px}
    .controls{display:flex;align-items:center;gap:12px 18px;flex-wrap:wrap;padding:10px 12px;margin-bottom:18px;background:#181d21;border:1px solid #2c343a;border-radius:9px}
    .controls label{display:flex;align-items:center;gap:7px;color:#c9d1d6;white-space:nowrap}.controls input[type=range]{width:112px}.controls output{width:38px;color:#98a5ae;font-variant-numeric:tabular-nums}.controls input[type=color]{width:28px;height:24px;padding:0;border:0;background:none}
    article{background:#181d21;border:1px solid #2c343a;border-radius:10px;overflow:hidden;box-shadow:0 5px 20px #0005}
    .title{display:flex;justify-content:space-between;padding:10px 12px}.viewport{position:relative;background:#060708;aspect-ratio:4/3}.viewport video,.viewport canvas{display:block;width:100%;height:100%;object-fit:contain}.viewport canvas{display:none;position:absolute;inset:0}.peaking .viewport.focus-ready canvas{display:block}.peaking .viewport.focus-ready video{visibility:hidden}
    .error{color:#ff8f87}
  </style>
</head>
<body>
  <header><h1>FLIR live view</h1><span id="summary">Connecting…</span></header>
  <section class="controls" aria-label="Focus peaking controls">
    <label><input id="peakEnabled" type="checkbox" checked> Focus peaking</label>
    <label>Threshold <input id="peakThreshold" type="range" min="0.02" max="0.40" step="0.01" value="0.14"><output></output></label>
    <label>Softness <input id="peakSoftness" type="range" min="0.01" max="0.20" step="0.01" value="0.05"><output></output></label>
    <label>Opacity <input id="peakOpacity" type="range" min="0.10" max="1.00" step="0.05" value="0.85"><output></output></label>
    <label>Radius <input id="peakRadius" type="range" min="1" max="4" step="0.5" value="1"><output></output></label>
    <label>Max FPS <input id="peakFps" type="range" min="5" max="60" step="5" value="30"><output></output></label>
    <label>Color <input id="peakColor" type="color" value="#ff1818"></label>
  </section>
  <main class="grid" id="grid"></main>
<script>
const focusPeaking={enabled:true,threshold:.14,softness:.05,opacity:.85,radius:1,maxFps:30,color:[1,.009,.009]};
function bindFocusControls(){
  const bind=(id,key,digits=2)=>{const input=document.querySelector(id),output=input.nextElementSibling;const update=()=>{focusPeaking[key]=Number(input.value);output.value=Number(input.value).toFixed(digits)};input.addEventListener('input',update);update()};
  bind('#peakThreshold','threshold');bind('#peakSoftness','softness');bind('#peakOpacity','opacity');bind('#peakRadius','radius',1);bind('#peakFps','maxFps',0);
  const enabled=document.querySelector('#peakEnabled');const setEnabled=()=>{focusPeaking.enabled=enabled.checked;document.body.classList.toggle('peaking',focusPeaking.enabled)};enabled.addEventListener('change',setEnabled);setEnabled();
  const color=document.querySelector('#peakColor');color.addEventListener('input',()=>{const n=parseInt(color.value.slice(1),16);focusPeaking.color=[((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255]});color.dispatchEvent(new Event('input'));
}
class ByteQueue {
  constructor(){this.parts=[];this.offset=0;this.length=0}
  push(x){this.parts.push(x);this.length+=x.byteLength}
  read(n){const out=new Uint8Array(n);let p=0;while(p<n){const a=this.parts[0];const take=Math.min(n-p,a.byteLength-this.offset);out.set(a.subarray(this.offset,this.offset+take),p);p+=take;this.offset+=take;this.length-=take;if(this.offset===a.byteLength){this.parts.shift();this.offset=0}}return out}
  peek(n){const out=this.read(n);this.parts.unshift(out);this.offset=0;this.length+=n;return out}
}
class FocusPeakingRenderer {
  constructor(video,canvas,viewport,status){
    this.video=video;this.canvas=canvas;this.viewport=viewport;this.status=status;this.lastDraw=0;
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,preserveDrawingBuffer:false});
    if(!gl){status.textContent='Live · WebGL2 unavailable';return}this.gl=gl;
    const vertex=`#version 300 es
      in vec2 aPosition;out vec2 vUv;
      void main(){vUv=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}`;
    const fragment=`#version 300 es
      precision highp float;
      uniform sampler2D uFrame;uniform vec2 uTexel;uniform float uThreshold;uniform float uSoftness;uniform float uOpacity;uniform float uRadius;uniform vec3 uPeakColor;
      in vec2 vUv;out vec4 outColor;
      float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
      void main(){
        vec3 base=texture(uFrame,vUv).rgb;vec2 d=uTexel*uRadius;
        float gx=luma(texture(uFrame,vUv+vec2(d.x,0.)).rgb)-luma(texture(uFrame,vUv-vec2(d.x,0.)).rgb);
        float gy=luma(texture(uFrame,vUv+vec2(0.,d.y)).rgb)-luma(texture(uFrame,vUv-vec2(0.,d.y)).rgb);
        float edge=length(vec2(gx,gy));float peak=smoothstep(uThreshold,uThreshold+uSoftness,edge);
        outColor=vec4(mix(base,uPeakColor,peak*uOpacity),1.);
      }`;
    const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader};
    try{const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));this.program=program;
      this.uniform={texel:gl.getUniformLocation(program,'uTexel'),threshold:gl.getUniformLocation(program,'uThreshold'),softness:gl.getUniformLocation(program,'uSoftness'),opacity:gl.getUniformLocation(program,'uOpacity'),radius:gl.getUniformLocation(program,'uRadius'),color:gl.getUniformLocation(program,'uPeakColor')};
      const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);viewport.classList.add('focus-ready');this.schedule();
    }catch(error){status.textContent=`Live · focus shader: ${error.message}`;status.className='status error'}
  }
  schedule(){if(this.video.requestVideoFrameCallback)this.video.requestVideoFrameCallback((now)=>this.draw(now));else requestAnimationFrame((now)=>this.draw(now))}
  draw(now){this.schedule();if(!this.gl||!focusPeaking.enabled||this.video.readyState<2)return;if(now-this.lastDraw<1000/focusPeaking.maxFps)return;this.lastDraw=now;
    const gl=this.gl,w=this.video.videoWidth,h=this.video.videoHeight;if(!w||!h)return;if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;gl.viewport(0,0,w,h)}
    gl.useProgram(this.program);gl.bindTexture(gl.TEXTURE_2D,this.texture);try{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,this.video)}catch(_){return}
    gl.uniform2f(this.uniform.texel,1/w,1/h);gl.uniform1f(this.uniform.threshold,focusPeaking.threshold);gl.uniform1f(this.uniform.softness,focusPeaking.softness);gl.uniform1f(this.uniform.opacity,focusPeaking.opacity);gl.uniform1f(this.uniform.radius,focusPeaking.radius);gl.uniform3fv(this.uniform.color,focusPeaking.color);gl.drawArrays(gl.TRIANGLES,0,6);
  }
}
async function sourceOpen(ms){if(ms.readyState==='open')return;await new Promise((ok,bad)=>{ms.addEventListener('sourceopen',ok,{once:true});ms.addEventListener('sourceclose',()=>bad(new Error('MediaSource closed')),{once:true})})}
async function playCamera(camera,video,status){
  if(!window.MediaSource)throw new Error('This browser has no MediaSource support');
  const mime=`video/mp4; codecs="${camera.codec}"`;
  if(!MediaSource.isTypeSupported(mime))throw new Error(`Unsupported codec ${camera.codec}`);
  const ms=new MediaSource();video.src=URL.createObjectURL(ms);await sourceOpen(ms);
  const sb=ms.addSourceBuffer(mime);sb.mode='segments';
  const appendQueue=[];let initAppended=false;
  const pump=()=>{if(sb.updating||appendQueue.length===0||ms.readyState!=='open')return;const item=appendQueue.shift();try{sb.appendBuffer(item.data);if(item.init)initAppended=true}catch(e){status.textContent=e.message;status.className='status error'}};
  sb.addEventListener('updateend',()=>{
    if(video.buffered.length){const end=video.buffered.end(video.buffered.length-1);if(video.paused)video.play().catch(()=>{});if(end-video.currentTime>.35)video.currentTime=Math.max(0,end-.08);if(video.buffered.start(0)<end-3&&!sb.updating){try{sb.remove(0,end-2)}catch(_){}}}
    status.textContent='Live';pump();
  });
  const enqueue=(data,flags)=>{
    const init=(flags&1)!==0,key=(flags&2)!==0;
    appendQueue.push({data,init,key});
    if(appendQueue.length>20){let lastKey=-1;for(let i=0;i<appendQueue.length;i++)if(appendQueue[i].key)lastKey=i;if(lastKey>0){const keepInit=!initAppended?appendQueue.find(x=>x.init):null;appendQueue.splice(0,lastKey);if(keepInit&&!appendQueue[0].init)appendQueue.unshift(keepInit)}}
    pump();
  };
  const response=await fetch(camera.stream,{cache:'no-store'});if(!response.ok||!response.body)throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(),bytes=new ByteQueue();let header=null;
  while(true){const {value,done}=await reader.read();if(done)break;bytes.push(value);
    while(true){if(!header){if(bytes.length<13)break;const h=bytes.read(13),v=new DataView(h.buffer,h.byteOffset,h.byteLength);header={flags:h[0],size:v.getUint32(1,false)}}if(bytes.length<header.size)break;enqueue(bytes.read(header.size),header.flags);header=null}
  }
  throw new Error('Stream ended');
}
async function main(){
  bindFocusControls();
  const response=await fetch('/api/cameras',{cache:'no-store'});if(!response.ok)throw new Error(`Camera API: HTTP ${response.status}`);const data=await response.json();
  document.querySelector('#summary').textContent=`${data.cameras.length} camera${data.cameras.length===1?'':'s'} · H.264 NVENC`;
  const grid=document.querySelector('#grid');
  for(const camera of data.cameras){const card=document.createElement('article'),title=document.createElement('div'),name=document.createElement('strong'),status=document.createElement('span'),viewport=document.createElement('div'),video=document.createElement('video'),canvas=document.createElement('canvas');title.className='title';viewport.className='viewport';canvas.className='focus-canvas';name.textContent=`${camera.name} · ${camera.id}`;status.className='status';status.textContent='Connecting…';title.append(name,status);video.muted=true;video.autoplay=true;video.playsInline=true;canvas.setAttribute('aria-label',`${camera.name} focus-peaking preview`);viewport.append(video,canvas);card.append(title,viewport);grid.append(card);new FocusPeakingRenderer(video,canvas,viewport,status);playCamera(camera,video,status).catch(e=>{status.textContent=e.message;status.className='status error'})}
}
main().catch(e=>{document.querySelector('#summary').textContent=e.message;document.querySelector('#summary').className='error'});
</script>
</body></html>)HTML";
#endif

void handle_client(int socket, FlirCameraBank& cameras) {
  timeval timeout{2, 0};
  ::setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  ::setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

  char buffer[4096]{};
  const auto received = ::recv(socket, buffer, sizeof(buffer) - 1, 0);
  if (received <= 0) {
    ::close(socket);
    return;
  }
  std::istringstream request(
      std::string(buffer, static_cast<std::size_t>(received)));
  std::string method;
  std::string path;
  request >> method >> path;

#ifndef FLIR_STREAMER_API_ONLY
  if (method == "GET" && (path == "/" || path == "/index.html")) {
    respond(socket, 200, "text/html; charset=utf-8", kPlayerHtml);
    ::close(socket);
    return;
  }
#endif
  if (method == "POST" && path == "/api/shutdown") {
    respond(socket, 200, "application/json", "{\"status\":\"stopping\"}");
    running.store(false);
  } else if (method == "GET" && path == "/api/health") {
    respond(socket, 200, "application/json",
            std::string("{\"status\":\"ok\",\"cameras\":") +
                std::to_string(cameras.size()) + "}");
  } else if (method == "GET" && path == "/api/cameras") {
    respond(socket, 200, "application/json", camera_json(cameras));
  } else {
    const std::string prefix = "/api/cameras/";
    const std::string suffix = "/stream";
    if (method == "GET" && path.size() > prefix.size() + suffix.size() &&
        path.compare(0, prefix.size(), prefix) == 0 &&
        path.compare(path.size() - suffix.size(), suffix.size(), suffix) == 0) {
      try {
        const std::string number = path.substr(
            prefix.size(), path.size() - prefix.size() - suffix.size());
        const std::size_t index = std::stoul(number);
        if (index < cameras.size()) {
          stream_camera(socket, cameras, index);
        } else {
          respond(socket, 404, "application/json",
                  "{\"error\":\"camera not found\"}");
        }
      } catch (...) {
        respond(socket, 404, "application/json",
                "{\"error\":\"camera not found\"}");
      }
    } else {
      respond(socket, 404, "application/json", "{\"error\":\"not found\"}");
    }
  }
  ::close(socket);
}

}  // namespace

int main(int argc, char** argv) {
  spdlog::set_level(spdlog::level::info);
  av_log_set_level(AV_LOG_WARNING);

  struct sigaction action {};
  action.sa_handler = request_shutdown;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGTERM, &action, nullptr);

  try {
    const std::string config_file = argc > 1 ? argv[1] : default_config_path();
    const int port = argc > 2 ? std::stoi(argv[2]) : kDefaultPort;
    const int bitrate_mbit = argc > 3 ? std::stoi(argv[3]) : kDefaultBitrateMbit;
    if (port < 1 || port > 65535 || bitrate_mbit < 1) {
      throw std::runtime_error("Usage: fast_flir_web_streamer [config] [port] [Mbit/s per camera]");
    }

    FlirCameraBank cameras(config_file, bitrate_mbit);
    cameras.start();

    const int server = ::socket(AF_INET, SOCK_STREAM, 0);
    if (server < 0) throw std::runtime_error("Could not create server socket");
    int reuse = 1;
    ::setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = htons(static_cast<std::uint16_t>(port));
    if (::bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0 ||
        ::listen(server, 32) < 0) {
      ::close(server);
      throw std::runtime_error("Could not bind HTTP server to port " +
                               std::to_string(port));
    }

    spdlog::info("Open http://HOST:{} ({} Mbit/s per camera)", port,
                 bitrate_mbit);
    std::vector<std::thread> clients;
    while (running.load()) {
      pollfd listener{server, POLLIN, 0};
      const int ready = ::poll(&listener, 1, 100);
      if (!running.load()) break;
      if (ready < 0) {
        if (errno == EINTR) continue;
        throw std::runtime_error("HTTP listener poll failed");
      }
      if (ready == 0) continue;
      sockaddr_in client_address{};
      socklen_t client_size = sizeof(client_address);
      const int client = ::accept(
          server, reinterpret_cast<sockaddr*>(&client_address), &client_size);
      if (client >= 0) {
        clients.emplace_back(handle_client, client, std::ref(cameras));
      }
    }
    ::close(server);
    running.store(false);
    for (auto& client : clients) {
      if (client.joinable()) client.join();
    }
  } catch (const std::exception& error) {
    running.store(false);
    spdlog::error("{}", error.what());
    return 1;
  }
  return 0;
}
