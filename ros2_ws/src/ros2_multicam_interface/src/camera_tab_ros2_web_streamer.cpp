// Adapted from backend/src/fast_flir_web_streamer.cpp: same H.264/fMP4 wire format.
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <sensor_msgs/image_encodings.hpp>
#include <nlohmann/json.hpp>
#include <deque>
#include <fstream>
#include <iostream>
#include <cctype>
#include <cerrno>
#include <limits>
#include <set>

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
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using Image = sensor_msgs::msg::Image;
using Json = nlohmann::json;

namespace {

using namespace std::chrono_literals;

constexpr const char* kDefaultBrowserCodec = "avc1.64002A";  // Until the first image is encoded.

std::string h264_browser_codec(const AVCodecContext* context) {
  const auto* data = context->extradata;
  const int size = context->extradata_size;
  const auto tag = [](std::uint8_t profile, std::uint8_t compatibility, std::uint8_t level) {
    constexpr char hex[] = "0123456789ABCDEF";
    std::string result = "avc1.";
    for (const auto byte : {profile, compatibility, level}) {
      result += hex[byte >> 4];
      result += hex[byte & 15];
    }
    return result;
  };
  // AVCDecoderConfigurationRecord or an Annex B SPS, depending on the encoder.
  if (size >= 4 && data[0] == 1) return tag(data[1], data[2], data[3]);
  for (int i = 0; i + 6 < size; ++i)
    if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 && (data[i + 3] & 31) == 7)
      return tag(data[i + 4], data[i + 5], data[i + 6]);
  throw std::runtime_error("H.264 encoder did not provide profile/level information");
}

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

constexpr int kPreviewFps = 30;
constexpr auto kPreviewPeriod = std::chrono::nanoseconds(33333334);
using Clock = std::chrono::steady_clock;

std::string env_or(const char* name, const char* fallback) {
  const char* value = std::getenv(name);
  return value && *value ? value : fallback;
}

bool send_all(int socket, const void* data, std::size_t size) {
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  while (size > 0 && running.load()) {
    const auto sent = ::send(socket, bytes, size, MSG_NOSIGNAL);
    if (sent < 0 && errno == EINTR) continue;
    if (sent <= 0) return false;
    bytes += sent;
    size -= static_cast<std::size_t>(sent);
  }
  return size == 0;
}

bool send_text(int socket, const std::string& text) {
  return send_all(socket, text.data(), text.size());
}

void respond(int socket, int status, const std::string& content_type,
             const std::string& body) {
  const char* reason = status == 200 ? "OK" : status == 503 ? "Service Unavailable" : "Not Found";
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
  return env_or("CAMERA_CALIBRATION_FILE",
                "/home/docker/workspace/cfg/CameraCalibrationSettings.json");
}

// Rates use receipt/encode times, independent of ROS timestamps or /clock.
class WindowRate {
 public:
  void tick(Clock::time_point now) {
    last_ = now;
    times_.push_back(now);
    prune(now);
    ++total_;
  }
  double hz(Clock::time_point now) {
    prune(now);
    if (times_.size() < 2) return 0.0;
    return (times_.size() - 1) / std::chrono::duration<double>(times_.back() - times_.front()).count();
  }
  bool active(Clock::time_point now) const {
    return total_ && now - last() < 2s;
  }
  Clock::time_point last() const { return last_; }
  std::uint64_t total() const { return total_; }
 private:
  void prune(Clock::time_point now) {
    while (!times_.empty() && now - times_.front() >= 2s) times_.pop_front();
  }
  std::deque<Clock::time_point> times_;
  std::uint64_t total_{0};
  Clock::time_point last_{};
};

// The encoder owns one latest-input slot and one latest-output slot. Acquisition
// therefore never waits for NVENC or for a slow browser: old preview frames are
// overwritten instead of building latency.
class Fmp4Channel {
 public:
  struct Fragment {
    std::vector<std::uint8_t> bytes;
    std::uint64_t sequence{0};
    std::uint64_t timestamp_us{0};
    bool keyframe{false};
  };

  Fmp4Channel(int bitrate_mbit, std::string camera_id, std::string encoder)
      : bitrate_mbit_(bitrate_mbit), camera_id_(std::move(camera_id)),
        requested_encoder_(std::move(encoder)) {
    worker_ = std::thread([this] {
      try {
        encode_loop();
      } catch (const std::exception& error) {
        spdlog::error("Camera {}: {}", camera_id_, error.what());
        std::lock_guard<std::mutex> lock(fragment_mutex_);
        error_ = error.what();
      }
      stop_.store(true);
      fragment_condition_.notify_all();
    });
  }

  Fmp4Channel(const Fmp4Channel&) = delete;
  Fmp4Channel& operator=(const Fmp4Channel&) = delete;

  ~Fmp4Channel() {
    stop_.store(true);
    input_condition_.notify_all();
    fragment_condition_.notify_all();
    if (worker_.joinable()) worker_.join();

    if (format_context_ != nullptr) {
      if (!initialization_segment_.empty()) av_write_trailer(format_context_);
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

  void record_input(bool valid) {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    input_rate_.tick(Clock::now());
    invalid_frames_ += !valid;
    image_error_ = valid ? "" : "Expected rgb8 with positive even dimensions and a complete image buffer";
  }

  void submit(Image::ConstSharedPtr image) {
    std::lock_guard<std::mutex> lock(input_mutex_);
    pending_image_ = std::move(image);  // One retained ROS message; no pixel copy.
    input_condition_.notify_one();
  }

  bool wait_until_ready() {
    std::unique_lock<std::mutex> lock(fragment_mutex_);
    fragment_condition_.wait_for(lock, 1s, [&] {
      return ready_ || stop_.load() || !running.load();
    });
    return ready_ && !stop_.load();
  }

  Json metadata() const {
    std::lock_guard<std::mutex> lock(fragment_mutex_);
    std::lock_guard<std::mutex> stats_lock(stats_mutex_);
    const auto now = Clock::now();
    const bool online = input_rate_.active(now);
    const bool preview_active = output_rate_.active(now) && !stop_.load();
    return {{"width", ready_ ? width_ : 0}, {"height", ready_ ? height_ : 0},
            {"ready", ready_ && !stop_.load()}, {"error", error_},
            {"image_error", image_error_}, {"online", online},
            {"preview_active", preview_active},
            {"input_fps", online ? input_rate_.hz(now) : 0.0},
            {"stream_fps", preview_active ? output_rate_.hz(now) : 0.0},
            {"last_image_age_ms", input_rate_.total() ? Json(std::chrono::duration_cast<
                std::chrono::milliseconds>(now - input_rate_.last()).count()) : Json(nullptr)},
            {"received_frames", input_rate_.total()}, {"invalid_frames", invalid_frames_},
            {"encoded_frames", output_rate_.total()},
            {"encoder", ready_ ? active_encoder_ : ""},
            {"codec", ready_ ? active_codec_ : kDefaultBrowserCodec}};
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
    auto* self = static_cast<Fmp4Channel*>(opaque);
    self->muxed_bytes_.insert(self->muxed_bytes_.end(), bytes, bytes + size);
    return size;
  }

  void set_encoder_option(const char* name, const char* value) {
    const int result = av_opt_set(codec_context_->priv_data, name, value, 0);
    if (result < 0) {
      spdlog::debug("Camera {}: encoder option {}={} unavailable ({})", camera_id_,
                    name, value, ffmpeg_error(result));
    }
  }

  void initialize_encoder() {
    std::string encoder_error;
    const auto open_encoder = [this, &encoder_error](const char* name) {
      const AVCodec* codec = avcodec_find_encoder_by_name(name);
      if (!codec) {
        encoder_error = std::string("FFmpeg has no encoder named ") + name;
        spdlog::warn("Camera {}: {}", camera_id_, encoder_error);
        return false;
      }
      codec_context_ = avcodec_alloc_context3(codec);
      if (!codec_context_) throw std::bad_alloc();
      codec_context_->width = width_;
      codec_context_->height = height_;
      codec_context_->pix_fmt = AV_PIX_FMT_YUV420P;
      // Preserve real elapsed time for slow/intermittent ROS publishers.
      codec_context_->time_base = AVRational{1, 90000};
      codec_context_->framerate = AVRational{kPreviewFps, 1};
      codec_context_->bit_rate = static_cast<std::int64_t>(bitrate_mbit_) * 1000000;
      codec_context_->rc_max_rate = codec_context_->bit_rate;
      codec_context_->rc_buffer_size = codec_context_->bit_rate / kPreviewFps * 4;
      codec_context_->gop_size = kPreviewFps;
      codec_context_->max_b_frames = 0;
      codec_context_->profile = FF_PROFILE_H264_HIGH;
      // Let the encoder choose a valid level for the actual resolution and rate.
      // Level 4.2 cannot encode 2048x1536 (12,288 macroblocks > its 8,704 limit).
      codec_context_->thread_count = 1;
      codec_context_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
      if (std::string(name) == "h264_nvenc") {
        set_encoder_option("preset", "p1");
        set_encoder_option("tune", "ull");
        set_encoder_option("rc", "cbr");
        set_encoder_option("zerolatency", "1");
        set_encoder_option("delay", "0");
        set_encoder_option("forced-idr", "1");
      } else {
        set_encoder_option("preset", "ultrafast");
        set_encoder_option("tune", "zerolatency");
        set_encoder_option("x264-params", "scenecut=0:force-cfr=0:cabac=1:8x8dct=1");
      }
      set_encoder_option("profile", "high");
      const int result = avcodec_open2(codec_context_, codec, nullptr);
      if (result < 0) {
        encoder_error = std::string("Could not open encoder ") + name + ": " + ffmpeg_error(result);
        spdlog::warn("Camera {}: {}", camera_id_, encoder_error);
        avcodec_free_context(&codec_context_);
        return false;
      }
      active_encoder_ = name;
      active_codec_ = h264_browser_codec(codec_context_);
      spdlog::info("Camera {}: {}x{}, {}, {}, preview limit {} Hz", camera_id_,
                   width_, height_, name, active_codec_, kPreviewFps);
      return true;
    };
    bool opened = false;
    if (requested_encoder_ == "auto" || requested_encoder_ == "h264_nvenc") {
      opened = open_encoder("h264_nvenc");
    }
    if (!opened && (requested_encoder_ == "auto" || requested_encoder_ == "libx264")) {
      opened = open_encoder("libx264");
    }
    if (!opened) throw std::runtime_error(encoder_error);

    frame_ = av_frame_alloc();
    packet_ = av_packet_alloc();
    if (frame_ == nullptr || packet_ == nullptr) throw std::bad_alloc();
    frame_->format = codec_context_->pix_fmt;
    frame_->width = width_;
    frame_->height = height_;
    check_ffmpeg(av_frame_get_buffer(frame_, 32), "Could not allocate YUV frame");

    sws_context_ = sws_getContext(
        width_, height_, AV_PIX_FMT_RGB24, width_, height_, codec_context_->pix_fmt,
        SWS_FAST_BILINEAR, nullptr, nullptr, nullptr);
    if (sws_context_ == nullptr) {
      throw std::runtime_error("Could not create RGB to YUV converter");
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
      Image::ConstSharedPtr image;
      {
        std::unique_lock<std::mutex> lock(input_mutex_);
        input_condition_.wait(lock, [&] {
          return pending_image_ || stop_.load() || !running.load();
        });
        // New arrivals replace the slot while we wait. No catch-up bursts and
        // no duplicate frames when a publisher runs below the preview limit.
        input_condition_.wait_until(lock, next_frame_, [&] {
          return stop_.load() || !running.load();
        });
        if (stop_.load() || !running.load()) break;
        image.swap(pending_image_);
      }
      const auto now = Clock::now();
      next_frame_ = now + kPreviewPeriod;
      if (!codec_context_) {
        width_ = static_cast<int>(image->width);
        height_ = static_cast<int>(image->height);
        initialize_encoder();
        initialize_muxer();
        {
          std::lock_guard<std::mutex> lock(fragment_mutex_);
          ready_ = true;
        }
        fragment_condition_.notify_all();
        epoch_ = now;
      }
      if (image->width != static_cast<unsigned>(width_) ||
          image->height != static_cast<unsigned>(height_)) {
        if (!resolution_warned_) spdlog::warn(
            "Camera {} changed resolution; restart streamer to apply it", camera_id_);
        resolution_warned_ = true;
        continue;
      }

      check_ffmpeg(av_frame_make_writable(frame_), "YUV frame is not writable");
      const std::uint8_t* source_planes[] = {image->data.data(), nullptr, nullptr,
                                             nullptr};
      const int source_strides[] = {static_cast<int>(image->step), 0, 0, 0};
      const int rows = sws_scale(sws_context_, source_planes, source_strides, 0,
                                 height_, frame_->data, frame_->linesize);
      if (rows != height_) {
        spdlog::warn("Camera {}: pixel conversion returned {} of {} rows",
                     camera_id_, rows, height_);
        continue;
      }

      frame_->pts = av_rescale_q(
          std::chrono::duration_cast<std::chrono::microseconds>(now - epoch_).count(),
          AVRational{1, 1000000}, codec_context_->time_base);
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
        packet_->duration = codec_context_->time_base.den / kPreviewFps;
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
        {
          std::lock_guard<std::mutex> lock(stats_mutex_);
          output_rate_.tick(Clock::now());
        }
        fragment_condition_.notify_all();
        av_packet_unref(packet_);
      }
    }
  }

  int width_{0};
  int height_{0};
  int bitrate_mbit_;
  std::string camera_id_;

  AVCodecContext* codec_context_{nullptr};
  AVFrame* frame_{nullptr};
  AVPacket* packet_{nullptr};
  SwsContext* sws_context_{nullptr};
  AVFormatContext* format_context_{nullptr};
  AVStream* stream_{nullptr};
  std::vector<std::uint8_t> muxed_bytes_;
  std::vector<std::uint8_t> initialization_segment_;
  std::string requested_encoder_;
  std::string active_encoder_;
  std::string active_codec_;
  std::string error_;
  bool ready_{false};
  bool resolution_warned_{false};
  Clock::time_point next_frame_{};
  Clock::time_point epoch_{};

  std::atomic<bool> stop_{false};
  std::atomic<bool> force_keyframe_{true};
  std::mutex input_mutex_;
  std::condition_variable input_condition_;
  Image::ConstSharedPtr pending_image_;
  std::thread worker_;

  mutable std::mutex stats_mutex_;
  mutable WindowRate input_rate_;
  mutable WindowRate output_rate_;
  std::uint64_t invalid_frames_{0};
  std::string image_error_;
  mutable std::mutex fragment_mutex_;
  std::condition_variable fragment_condition_;
  Fragment latest_fragment_;
};

class RosCameraBank : public rclcpp::Node {
 public:
  RosCameraBank(const std::string& config_file, int bitrate_mbit,
                const std::string& encoder)
      : Node("mcs_camera_web_streamer") {
    std::ifstream input(config_file);
    if (!input) throw std::runtime_error("Cannot open calibration settings: " + config_file);
    const auto config = Json::parse(input);
    camera_ids_ = config.at("serial_numbers").get<std::vector<std::string>>();
    if (camera_ids_.empty()) throw std::runtime_error("serial_numbers must not be empty");
    const auto topic_template = env_or("ROS_IMAGE_TOPIC_TEMPLATE",
                                        "/grasshopper/camera_{serial}/image_raw");
    const auto serial_position = topic_template.find("{serial}");
    if (serial_position == std::string::npos ||
        topic_template.find("{serial}", serial_position + 8) != std::string::npos) {
      throw std::runtime_error("ROS_IMAGE_TOPIC_TEMPLATE must contain exactly one {serial}");
    }
    std::set<std::string> ids;
    for (const auto& id : camera_ids_) {
      if (id.empty() || !std::all_of(id.begin(), id.end(), [](unsigned char c) {
            return std::isalnum(c) || c == '_';
          }) || !ids.insert(id).second) {
        throw std::runtime_error("Camera IDs must be unique nonempty letters/digits/underscores");
      }
      const auto index = channels_.size();
      channels_.push_back(std::make_unique<Fmp4Channel>(bitrate_mbit, id, encoder));
      auto topic = topic_template;
      topic.replace(serial_position, 8, id);
      topics_.push_back(std::move(topic));
      // A depth-one best-effort subscription works with both best-effort and
      // reliable image publishers without queuing stale preview frames.
      subscriptions_.push_back(create_subscription<Image>(
          topics_.back(), rclcpp::SensorDataQoS().keep_last(1),
          [this, index](Image::ConstSharedPtr image) {
            const std::uint64_t row_bytes = std::uint64_t(image->width) * 3;
            const std::uint64_t required = std::uint64_t(image->step) * image->height;
            const bool valid = !(image->encoding != sensor_msgs::image_encodings::RGB8 ||
                image->width == 0 || image->height == 0 ||
                (image->width & 1) || (image->height & 1) ||
                image->width > std::numeric_limits<int>::max() ||
                image->height > std::numeric_limits<int>::max() ||
                image->step > std::numeric_limits<int>::max() ||
                image->step < row_bytes || image->data.size() < required);
            channels_[index]->record_input(valid);
            if (!valid) {
              RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000,
                  "Ignoring invalid image on %s: expected rgb8, positive even dimensions, "
                  "step >= width*3 and data.size >= step*height", topics_[index].c_str());
              return;
            }
            channels_[index]->submit(std::move(image));
          }));
      spdlog::info("Camera {} subscribes to {} (sensor_msgs/msg/Image, rgb8)",
                   id, topics_.back());
    }
  }

  std::size_t size() const { return channels_.size(); }
  Fmp4Channel& channel(std::size_t index) { return *channels_.at(index); }
  Json metadata() const {
    Json cameras = Json::array();
    std::size_t online_count = 0, streaming_count = 0;
    for (std::size_t i = 0; i < size(); ++i) {
      auto camera = channels_[i]->metadata();
      online_count += camera["online"].get<bool>();
      streaming_count += camera["preview_active"].get<bool>();
      camera["publisher_count"] = count_publishers(topics_[i]);
      camera.update({{"id", camera_ids_[i]}, {"name", "Camera " + std::to_string(i + 1)},
                     {"topic", topics_[i]}, {"stream", "/api/cameras/" + std::to_string(i) + "/stream"},
                     {"fps", kPreviewFps}, {"encoding", "rgb8"}});
      cameras.push_back(std::move(camera));
    }
    return {{"streaming", true}, {"transport", "fmp4"}, {"cameras", cameras},
            {"configured_cameras", size()}, {"online_cameras", online_count},
            {"streaming_cameras", streaming_count}, {"rate_window_seconds", 2},
            {"offline_timeout_seconds", 2}};
  }

 private:
  std::vector<std::string> camera_ids_;
  std::vector<std::string> topics_;
  std::vector<std::unique_ptr<Fmp4Channel>> channels_;
  std::vector<rclcpp::Subscription<Image>::SharedPtr> subscriptions_;
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

void stream_camera(int socket, RosCameraBank& cameras, std::size_t index) {
  auto& channel = cameras.channel(index);
  if (!channel.wait_until_ready()) {
    respond(socket, 503, "application/json",
            "{\"error\":\"Waiting for a valid rgb8 image or encoder unavailable\"}");
    return;
  }
  const std::string header =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/x-flir-fmp4\r\n"
      "Access-Control-Allow-Origin: *\r\n"
      "Cache-Control: no-store, no-cache, must-revalidate\r\n"
      "X-Accel-Buffering: no\r\n"
      "Connection: close\r\n\r\n";
  if (!send_text(socket, header)) return;
  if (!send_record(socket, 0x01, 0, channel.initialization_segment())) return;

  channel.request_keyframe();
  std::uint64_t sequence = 0;
  bool waiting_for_keyframe = true;
  while (running.load()) {
    Fmp4Channel::Fragment fragment;
    if (!channel.wait_for_fragment(sequence, fragment)) {
      char byte;
      const auto peek = ::recv(socket, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
      if (peek == 0 || (peek < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) break;
      if (!channel.metadata()["error"].get<std::string>().empty()) break;
      continue;
    }
    if (sequence && fragment.sequence != sequence + 1) {
      // A slow browser may miss P-frames from the latest-output slot. Resume
      // only at an IDR, so it never decodes against missing reference frames.
      waiting_for_keyframe = true;
      channel.request_keyframe();
    }
    sequence = fragment.sequence;
    if (waiting_for_keyframe && !fragment.keyframe) continue;
    waiting_for_keyframe = false;
    const std::uint8_t flags = fragment.keyframe ? 0x02 : 0x00;
    if (!send_record(socket, flags, fragment.timestamp_us, fragment.bytes)) break;
  }
}

const char* kPlayerHtml = R"HTML(<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MCS ROS 2 live view</title>
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
  <header><h1>MCS ROS 2 live view</h1><span id="summary">Connecting…</span></header>
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
  const current=await (await fetch('/api/cameras',{cache:'no-store'})).json();
  const latest=current.cameras.find(item=>item.id===camera.id);
  if(!latest?.ready)throw new Error(latest?.error||'Waiting for images');
  camera.codec=latest.codec;
  if(!window.MediaSource)throw new Error('This browser has no MediaSource support');
  const mime=`video/mp4; codecs="${camera.codec}"`;
  if(!MediaSource.isTypeSupported(mime))throw new Error(`Unsupported codec ${camera.codec}`);
  const ms=new MediaSource();const url=URL.createObjectURL(ms);video.src=url;await sourceOpen(ms);URL.revokeObjectURL(url);
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
  document.querySelector('#summary').textContent=`${data.cameras.length} camera${data.cameras.length===1?'':'s'} · ROS 2 RGB8 · preview limit 30 Hz`;
  const grid=document.querySelector('#grid');
  for(const camera of data.cameras){const card=document.createElement('article'),title=document.createElement('div'),name=document.createElement('strong'),status=document.createElement('span'),viewport=document.createElement('div'),video=document.createElement('video'),canvas=document.createElement('canvas');title.className='title';viewport.className='viewport';canvas.className='focus-canvas';name.textContent=`${camera.name} · ${camera.id}`;status.className='status';status.textContent='Connecting…';title.append(name,status);video.muted=true;video.autoplay=true;video.playsInline=true;canvas.setAttribute('aria-label',`${camera.name} focus-peaking preview`);viewport.append(video,canvas);card.append(title,viewport);grid.append(card);new FocusPeakingRenderer(video,canvas,viewport,status);(async()=>{while(true){try{await playCamera(camera,video,status)}catch(e){status.textContent='Waiting for images · '+e.message;status.className='status error'}await new Promise(r=>setTimeout(r,2000))}})()}
}
main().catch(e=>{document.querySelector('#summary').textContent=e.message;document.querySelector('#summary').className='error'});
</script>
</body></html>)HTML";

void handle_client(int socket, RosCameraBank& cameras) {
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

  if (method == "GET" && (path == "/" || path == "/index.html")) {
    respond(socket, 200, "text/html; charset=utf-8", kPlayerHtml);
    ::close(socket);
    return;
  }
  if (method == "POST" && path == "/api/shutdown") {
    respond(socket, 200, "application/json", "{\"status\":\"stopping\"}");
    running.store(false);
  } else if (method == "GET" && path == "/api/health") {
    respond(socket, 200, "application/json",
            std::string("{\"status\":\"ok\",\"cameras\":") +
                std::to_string(cameras.size()) + "}");
  } else if (method == "GET" && path == "/api/cameras") {
    respond(socket, 200, "application/json", cameras.metadata().dump());
  } else {
    const std::string prefix = "/api/cameras/";
    const std::string suffix = "/stream";
    if (method == "GET" && path.size() > prefix.size() + suffix.size() &&
        path.compare(0, prefix.size(), prefix) == 0 &&
        path.compare(path.size() - suffix.size(), suffix.size(), suffix) == 0) {
      try {
        const std::string number = path.substr(
            prefix.size(), path.size() - prefix.size() - suffix.size());
        if (number.empty() || !std::all_of(number.begin(), number.end(),
            [](unsigned char c) { return std::isdigit(c); })) throw std::invalid_argument("index");
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

// Own every HTTP worker and reap completed requests. Polling status must not
// accumulate joinable threads over the lifetime of a recording session.
class HttpWorkers {
 public:
  ~HttpWorkers() {
    running.store(false);
    for (auto& client : clients_) client.thread.join();
  }
  void accept(int socket, RosCameraBank& cameras) {
    for (auto it = clients_.begin(); it != clients_.end();) {
      if (it->done->load()) { it->thread.join(); it = clients_.erase(it); }
      else ++it;
    }
    if (clients_.size() >= 64) { ::close(socket); return; }
    auto done = std::make_shared<std::atomic<bool>>(false);
    clients_.push_back({std::thread([socket, &cameras, done] {
      try { handle_client(socket, cameras); }
      catch (const std::exception& error) {
        spdlog::warn("HTTP request: {}", error.what());
        ::close(socket);
      }
      done->store(true);
    }), done});
  }
 private:
  struct Client { std::thread thread; std::shared_ptr<std::atomic<bool>> done; };
  std::vector<Client> clients_;
};

class RosSpinner {
 public:
  explicit RosSpinner(const std::shared_ptr<RosCameraBank>& cameras) {
    executor_.add_node(cameras);
    thread_ = std::thread([this] {
      try { executor_.spin(); }
      catch (const std::exception& error) {
        spdlog::error("ROS executor: {}", error.what());
        running.store(false);
      }
    });
  }
  ~RosSpinner() { executor_.cancel(); thread_.join(); }
 private:
  rclcpp::executors::SingleThreadedExecutor executor_;
  std::thread thread_;
};

// Exercise the real RGB -> H.264 -> fragmented MP4 path without ROS discovery,
// physical cameras, disk output or HTTP clients. Encoder enumeration is not enough.
int check_encoder(const std::string& encoder, int width, int height, int count) {
  if (encoder != "h264_nvenc" && encoder != "libx264" && encoder != "auto")
    throw std::runtime_error("Encoder must be h264_nvenc, libx264 or auto");
  if (width < 2 || width > 8192 || height < 2 || height > 8192 || (width & 1) || (height & 1) || count < 1 || count > 32)
    throw std::runtime_error("Probe dimensions must be even, 2..8192; channels must be 1..32");
  std::vector<std::unique_ptr<Fmp4Channel>> channels;
  for (int i = 0; i < count; ++i)
    channels.push_back(std::make_unique<Fmp4Channel>(4, "encoder-check-" + std::to_string(i), encoder));
  auto image = std::make_shared<Image>();
  image->width = width;
  image->height = height;
  image->encoding = "rgb8";
  image->step = image->width * 3;
  image->data.resize(image->step * image->height, 128);
  const auto deadline = Clock::now() + 10s;
  std::vector<bool> encoded(count, false);
  while (Clock::now() < deadline) {
    for (int i = 0; i < count; ++i) if (!encoded[i]) channels[i]->submit(image);
    for (int i = 0; i < count; ++i) {
      if (encoded[i]) continue;
      Fmp4Channel::Fragment fragment;
      encoded[i] = channels[i]->wait_for_fragment(0, fragment) && !fragment.bytes.empty();
      const auto status = channels[i]->metadata();
      if (!status.at("error").get<std::string>().empty())
        throw std::runtime_error("Channel " + std::to_string(i) + ": " + status.at("error").get<std::string>());
    }
    if (std::all_of(encoded.begin(), encoded.end(), [](bool value) { return value; })) {
      Json statuses = Json::array();
      for (auto& channel : channels) {
        const auto status = channel->metadata();
        statuses.push_back({{"encoder", status.at("encoder")}, {"codec", status.at("codec")}});
      }
      std::cout << Json({{"success", true}, {"channels", statuses},
        {"width", width}, {"height", height}}).dump() << '\n';
      return 0;
    }
  }
  throw std::runtime_error("Encoder check timed out without producing H.264 video");
}

}  // namespace

int main(int argc, char** argv) {
  spdlog::set_level(spdlog::level::info);
  av_log_set_level(AV_LOG_WARNING);
  if (argc > 1 && std::string(argv[1]) == "--help") {
    std::cout << "Usage: camera_tab_ros2_web_streamer [calibration.json] [port] [Mbit/s per camera]\n"
                 "       camera_tab_ros2_web_streamer --check-encoder [h264_nvenc|libx264|auto] [width height channels]\n"
                 "Environment: CAMERA_CALIBRATION_FILE, ROS_IMAGE_TOPIC_TEMPLATE, "
                 "STREAMER_PORT, STREAMER_BITRATE_MBIT, STREAMER_ENCODER=auto|libx264|h264_nvenc\n"
                 "Input: sensor_msgs/msg/Image rgb8; output limit: 30 Hz.\n";
    return 0;
  }
  if (argc > 1 && std::string(argv[1]) == "--check-encoder") {
    try {
      if (argc != 2 && argc != 3 && argc != 6) throw std::runtime_error("Invalid arguments; see --help");
      return check_encoder(argc >= 3 ? argv[2] : "h264_nvenc", argc == 6 ? std::stoi(argv[3]) : 1280,
                           argc == 6 ? std::stoi(argv[4]) : 720, argc == 6 ? std::stoi(argv[5]) : 1);
    } catch (const std::exception& error) {
      spdlog::error("{}", error.what());
      return 1;
    }
  }
  struct sigaction action {};
  action.sa_handler = request_shutdown;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGTERM, &action, nullptr);

  int result = 0;
  try {
    if (argc > 4) throw std::runtime_error("Too many arguments; see --help");
    const std::string config_file = argc > 1 ? argv[1] : default_config_path();
    const int port = std::stoi(argc > 2 ? argv[2] : env_or("STREAMER_PORT", "8080"));
    const int bitrate_mbit = std::stoi(argc > 3 ? argv[3] : env_or("STREAMER_BITRATE_MBIT", "4"));
    const auto encoder = env_or("STREAMER_ENCODER", "auto");
    if (port < 1 || port > 65535 || bitrate_mbit < 1 || bitrate_mbit > 1000 ||
        (encoder != "auto" && encoder != "h264_nvenc" && encoder != "libx264")) {
      throw std::runtime_error("Invalid port, bitrate or encoder; see --help");
    }
    spdlog::info("Requested preview encoder: {}", encoder);
    rclcpp::init(0, nullptr, rclcpp::InitOptions(), rclcpp::SignalHandlerOptions::None);
    auto cameras = std::make_shared<RosCameraBank>(config_file, bitrate_mbit, encoder);
    RosSpinner spinner(cameras);
    HttpWorkers clients;

    const int server = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (server < 0) throw std::runtime_error("Could not create server socket");
    int reuse = 1;
    ::setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    const auto bind_address = env_or("STREAMER_BIND_ADDRESS", "0.0.0.0");
    if (::inet_pton(AF_INET, bind_address.c_str(), &address.sin_addr) != 1) {
      ::close(server);
      throw std::runtime_error("Invalid STREAMER_BIND_ADDRESS");
    }
    address.sin_port = htons(static_cast<std::uint16_t>(port));
    if (::bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0 ||
        ::listen(server, 32) < 0) {
      ::close(server);
      throw std::runtime_error("Could not bind HTTP server to port " + std::to_string(port));
    }
    spdlog::info("Open http://HOST:{} ({} Mbit/s per camera, {} Hz limit)",
                 port, bitrate_mbit, kPreviewFps);
    while (running.load()) {
      pollfd listener{server, POLLIN, 0};
      const int ready = ::poll(&listener, 1, 100);
      if (!running.load()) break;
      if (ready < 0) {
        if (errno == EINTR) continue;
        spdlog::error("HTTP listener poll failed");
        result = 1;
        break;
      }
      if (ready == 0) continue;
      const int client = ::accept4(server, nullptr, nullptr, SOCK_CLOEXEC);
      if (client >= 0) clients.accept(client, *cameras);
    }
    ::close(server);
  } catch (const std::exception& error) {
    running.store(false);
    spdlog::error("{}", error.what());
    result = 1;
  }
  rclcpp::shutdown();
  return result;
}
