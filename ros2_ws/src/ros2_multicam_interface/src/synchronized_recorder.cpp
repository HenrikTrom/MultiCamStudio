#include "ros2_multicam_interface/synchronized_recorder.hpp"
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <nlohmann/json.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cctype>
#include <cstdlib>
#include <thread>
#include <deque>
#include <filesystem>
#include <fstream>
#include <future>
#include <iomanip>
#include <iostream>
#include <limits>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>

namespace mcs {
namespace {
using Json = nlohmann::json;
using Image = sensor_msgs::msg::Image;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
std::atomic<bool> requested_stop{false};
void stop_signal(int) { requested_stop.store(true); }
std::string env(const char* key, const std::string& fallback = "") {
  const auto* value = std::getenv(key);
  return value && *value ? value : fallback;
}
double setting(const char* key, double fallback, double low, double high) {
  const auto value = std::stod(env(key, std::to_string(fallback)));
  if (!std::isfinite(value) || value < low || value > high) throw std::runtime_error(std::string("Invalid ") + key);
  return value;
}
void check(int code, const char* operation) {
  if (code >= 0) return;
  char buffer[AV_ERROR_MAX_STRING_SIZE]{};
  av_strerror(code, buffer, sizeof(buffer));
  throw std::runtime_error(std::string(operation) + ": " + buffer);
}
void event(const Json& data) { std::cout << data.dump() << std::endl; }
std::int64_t stamp(const Image& image) {
  return std::int64_t(image.header.stamp.sec) * 1000000000LL + image.header.stamp.nanosec;
}

// One writer per camera, with identical batch timestamps and no frame duplication.
class VideoWriter {
 public:
  VideoWriter(const fs::path& path, int width, int height, int fps) {
    try {
      check(avformat_alloc_output_context2(&format_, nullptr, "mp4", path.c_str()), "Create MP4");
      const auto requested = env("RECORD_ENCODER", "libx264");
      if (requested != "libx264" && requested != "h264_nvenc") throw std::runtime_error("RECORD_ENCODER must be libx264 or h264_nvenc");
      const auto* codec = avcodec_find_encoder_by_name(requested.c_str());
      if (!codec) throw std::runtime_error("Recording encoder is unavailable: " + requested);
      codec_ = avcodec_alloc_context3(codec);
      if (!codec_) throw std::bad_alloc();
      codec_->width = width;
      codec_->height = height;
      codec_->pix_fmt = AV_PIX_FMT_YUV420P;
      codec_->time_base = AVRational{1, 90000};
      codec_->framerate = AVRational{fps, 1};
      codec_->gop_size = fps;
      codec_->max_b_frames = 0;
      codec_->thread_count = 1;
      codec_->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
      if (requested == "libx264") {
        av_opt_set(codec_->priv_data, "preset", "ultrafast", 0);
        av_opt_set(codec_->priv_data, "tune", "zerolatency", 0);
        av_opt_set(codec_->priv_data, "crf", "18", 0);
      } else {
        av_opt_set(codec_->priv_data, "preset", "p1", 0);
        av_opt_set(codec_->priv_data, "tune", "ull", 0);
        codec_->bit_rate = 12000000;
      }
      check(avcodec_open2(codec_, codec, nullptr), "Open recording encoder");
      stream_ = avformat_new_stream(format_, nullptr);
      if (!stream_) throw std::bad_alloc();
      stream_->time_base = codec_->time_base;
      stream_->avg_frame_rate = codec_->framerate;
      check(avcodec_parameters_from_context(stream_->codecpar, codec_), "Copy stream parameters");
      check(avio_open(&format_->pb, path.c_str(), AVIO_FLAG_WRITE), "Open video file");
      check(avformat_write_header(format_, nullptr), "Write MP4 header");
      header_written_ = true;
      frame_ = av_frame_alloc();
      packet_ = av_packet_alloc();
      if (!frame_ || !packet_) throw std::bad_alloc();
      frame_->format = codec_->pix_fmt;
      frame_->width = width;
      frame_->height = height;
      check(av_frame_get_buffer(frame_, 32), "Allocate recording frame");
      converter_ = sws_getContext(width, height, AV_PIX_FMT_RGB24, width, height,
          AV_PIX_FMT_YUV420P, SWS_FAST_BILINEAR, nullptr, nullptr, nullptr);
      if (!converter_) throw std::runtime_error("Cannot create recording pixel converter");
    } catch (...) { release(); throw; }
  }
  ~VideoWriter() { release(); }
  void write(const Image& image, std::int64_t relative_ns) {
    check(av_frame_make_writable(frame_), "Make frame writable");
    const std::uint8_t* data[] = {image.data.data(), nullptr, nullptr, nullptr};
    const int strides[] = {static_cast<int>(image.step), 0, 0, 0};
    if (sws_scale(converter_, data, strides, 0, codec_->height, frame_->data, frame_->linesize) != codec_->height)
      throw std::runtime_error("Incomplete RGB conversion");
    frame_->pts = av_rescale_q(relative_ns, AVRational{1, 1000000000}, codec_->time_base);
    check(avcodec_send_frame(codec_, frame_), "Encode video frame");
    drain();
  }
  void finish() {
    if (!header_written_) return;
    check(avcodec_send_frame(codec_, nullptr), "Flush encoder");
    drain();
    check(av_write_trailer(format_), "Finalize MP4");
    header_written_ = false;
    check(avio_closep(&format_->pb), "Close video");
  }
 private:
  void drain() {
    while (true) {
      const int result = avcodec_receive_packet(codec_, packet_);
      if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) break;
      check(result, "Receive encoded packet");
      packet_->duration = 90000 / codec_->framerate.num;
      av_packet_rescale_ts(packet_, codec_->time_base, stream_->time_base);
      packet_->stream_index = stream_->index;
      const int written = av_interleaved_write_frame(format_, packet_);
      av_packet_unref(packet_);
      check(written, "Write video packet");
    }
  }
  void release() noexcept {
    if (header_written_) { try { finish(); } catch (...) {} }
    if (format_ && format_->pb) avio_closep(&format_->pb);
    avformat_free_context(format_);
    sws_freeContext(converter_);
    av_frame_free(&frame_);
    av_packet_free(&packet_);
    avcodec_free_context(&codec_);
  }
  AVFormatContext* format_{nullptr};
  AVCodecContext* codec_{nullptr};
  AVStream* stream_{nullptr};
  AVFrame* frame_{nullptr};
  AVPacket* packet_{nullptr};
  SwsContext* converter_{nullptr};
  bool header_written_{false};
};

class Recorder : public rclcpp::Node {
 public:
  Recorder(Json config, fs::path output, bool calibration)
      : Node(calibration ? "mcs_calibration_recorder" : "mcs_video_recorder"),
        config_(std::move(config)), output_(std::move(output)), calibration_(calibration) {
    ids_ = config_.at("serial_numbers").get<std::vector<std::string>>();
    std::set<std::string> unique;
    for (const auto& id : ids_) {
      if (id.empty() || !std::all_of(id.begin(), id.end(), [](unsigned char c) { return std::isalnum(c) || c == '_'; }) || !unique.insert(id).second)
        throw std::runtime_error("Camera IDs must be unique letters, digits or underscores");
    }
    if (ids_.empty()) throw std::runtime_error("No cameras configured");
    fps_ = static_cast<int>(setting("RECORD_FPS", 30, 1, 240));
    tolerance_ns_ = static_cast<std::int64_t>(setting("RECORD_SYNC_TOLERANCE_MS", 5, 0, 100) * 1e6);
    start_timeout_ = setting("RECORD_START_TIMEOUT_SEC", 15, 1, 120);
    stall_timeout_ = setting("RECORD_STALL_TIMEOUT_SEC", 5, 1, 120);
    max_frames_ = static_cast<std::uint64_t>(setting(calibration ? "CALIBRATION_CAPTURE_FRAMES" : "RECORD_MAX_FRAMES", calibration ? 30 : 0, calibration ? 1 : 0, calibration ? 999 : 100000000));
    const auto interval = setting("CALIBRATION_CAPTURE_INTERVAL_MS", 500, 1, 60000);
    period_ns_ = calibration_ ? interval * 1e6 : 1e9 / fps_;
    const auto topic_template = env("ROS_IMAGE_TOPIC_TEMPLATE", "/grasshopper/camera_{serial}/image_raw");
    const auto position = topic_template.find("{serial}");
    if (position == std::string::npos || topic_template.find("{serial}", position + 8) != std::string::npos)
      throw std::runtime_error("ROS_IMAGE_TOPIC_TEMPLATE must contain exactly one {serial}");
    queues_.resize(ids_.size());
    dropped_.resize(ids_.size());
    last_stamps_.resize(ids_.size());
    for (std::size_t index = 0; index < ids_.size(); ++index) {
      auto topic = topic_template;
      topic.replace(position, 8, ids_[index]);
      topics_.push_back(topic);
      subscriptions_.push_back(create_subscription<Image>(topic, rclcpp::SensorDataQoS().keep_last(4),
          [this, index](Image::ConstSharedPtr image) { receive(index, std::move(image)); }));
    }
  }
  Json metadata(std::uint64_t frames, const std::string& status, const std::string& error = "") {
    std::lock_guard<std::mutex> lock(mutex_);
    return {{"version", 1}, {"status", status}, {"error", error}, {"serial_numbers", ids_},
      {"topics", topics_}, {"width", width_}, {"height", height_}, {"fps", fps_},
      {"frames", frames}, {"target_frames", max_frames_}, {"max_skew_ns", max_skew_ns_.load()}, {"sync_tolerance_ns", tolerance_ns_}, {"dropped_frames", dropped_},
      {"calibration_capture", calibration_}, {"timestamp_clock", "ROS image header"}};
  }
  int record() {
    if (fs::exists(output_)) throw std::runtime_error("Session directory already exists; choose a new name");
    fs::create_directories(output_.parent_path());
    if (!fs::create_directory(output_)) throw std::runtime_error("Cannot reserve session directory");
    std::uint64_t frames = 0;
    std::ofstream timestamps;
    std::vector<std::unique_ptr<VideoWriter>> videos;
    auto begun = Clock::now(), last_match = begun, last_progress = begun;
    std::int64_t origin = 0, last_slot = -1;
    std::string failure;
    try {
      if (calibration_) fs::create_directory(output_ / "images");
      timestamps.open(output_ / "frame_timestamps.jsonl");
      timestamps.exceptions(std::ios::failbit | std::ios::badbit);
      while (!requested_stop.load()) {
        std::vector<Image::ConstSharedPtr> batch;
        {
          std::lock_guard<std::mutex> lock(mutex_);
          if (!error_.empty()) throw std::runtime_error(error_);
          while (std::all_of(queues_.begin(), queues_.end(), [](const auto& queue) { return !queue.empty(); })) {
            auto low = stamp(*queues_[0].front()), high = low;
            std::size_t oldest = 0;
            for (std::size_t i = 1; i < queues_.size(); ++i) {
              const auto time = stamp(*queues_[i].front());
              if (time < low) { low = time; oldest = i; }
              high = std::max(high, time);
            }
            if (high - low <= tolerance_ns_) {
              for (auto& queue : queues_) { batch.push_back(queue.front()); queue.pop_front(); }
              break;
            }
            queues_[oldest].pop_front();
            ++dropped_[oldest];
          }
        }
        const auto now = Clock::now();
        if (batch.empty()) {
          const auto limit = frames ? stall_timeout_ : start_timeout_;
          if (std::chrono::duration<double>(now - (frames ? last_match : begun)).count() > limit)
            throw std::runtime_error("Timed out waiting for synchronized RGB8 images from all cameras; check image timestamps and synchronization tolerance");
          std::this_thread::sleep_for(1ms);
          continue;
        }
        last_match = now;
        std::vector<std::int64_t> stamps;
        for (const auto& image : batch) stamps.push_back(stamp(*image));
        const auto high = *std::max_element(stamps.begin(), stamps.end());
        if (!origin) origin = high;
        const auto slot = static_cast<std::int64_t>((high - origin) / period_ns_);
        if (slot <= last_slot) continue;
        last_slot = slot;
        max_skew_ns_.store(std::max(max_skew_ns_.load(), high - *std::min_element(stamps.begin(), stamps.end())));
        if (!frames) {
          if (!calibration_) for (const auto& id : ids_)
            videos.push_back(std::make_unique<VideoWriter>(output_ / (id + ".mp4"), width_, height_, fps_));
          event({{"event", "ready"}, {"width", width_}, {"height", height_}, {"cameras", ids_.size()}});
        }
        for (std::size_t i = 0; i < batch.size(); ++i) {
          if (calibration_) {
            cv::Mat rgb(height_, width_, CV_8UC3, const_cast<std::uint8_t*>(batch[i]->data.data()), batch[i]->step), bgr;
            cv::cvtColor(rgb, bgr, cv::COLOR_RGB2BGR);
            std::ostringstream filename;
            filename << "cam" << ids_[i] << '-' << std::setw(4) << std::setfill('0') << (frames + 1) << ".png";
            if (!cv::imwrite((output_ / "images" / filename.str()).string(), bgr)) throw std::runtime_error("Cannot save calibration image");
          } else videos[i]->write(*batch[i], high - origin);
        }
        timestamps << Json({{"frame", frames}, {"batch_timestamp_ns", high},
          {"source_timestamps_ns", stamps}, {"skew_ns", high - *std::min_element(stamps.begin(), stamps.end())}}).dump() << '\n';
        timestamps.flush();
        ++frames;
        if (frames == 1 || now - last_progress > 1s || (max_frames_ && frames == max_frames_)) {
          auto progress = metadata(frames, "recording"); progress["event"] = "progress";
          event(progress); last_progress = now;
        }
        if (max_frames_ && frames >= max_frames_) break;
      }
      if (!frames) throw std::runtime_error("Capture stopped before the first synchronized frame");
      if (calibration_ && frames != max_frames_) throw std::runtime_error("Calibration capture was cancelled before all image sets were saved");
    } catch (const std::exception& error) { failure = error.what(); }
    for (auto& video : videos) {
      try { video->finish(); } catch (const std::exception& error) { if (failure.empty()) failure = error.what(); }
    }
    try { if (timestamps.is_open()) timestamps.close(); }
    catch (const std::exception& error) { if (failure.empty()) failure = error.what(); }
    auto manifest = metadata(frames, failure.empty() ? "complete" : "failed", failure);
    manifest["config"] = config_;
    std::ofstream file(output_ / "session.json");
    file.exceptions(std::ios::failbit | std::ios::badbit);
    file << manifest.dump(2) << '\n'; file.close();
    manifest["event"] = "complete";
    event(manifest);
    return failure.empty() ? 0 : 1;
  }
 private:
  void receive(std::size_t index, Image::ConstSharedPtr image) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!error_.empty()) return;
    const auto fail = [this, index](const std::string& text) { error_ = "Camera " + ids_[index] + ": " + text; };
    if (image->encoding != "rgb8" || !image->width || !image->height ||
        (image->width & 1) || (image->height & 1) ||
        image->width > std::numeric_limits<int>::max() || image->height > std::numeric_limits<int>::max() ||
        image->step > std::numeric_limits<int>::max() || std::uint64_t(image->step) < std::uint64_t(image->width) * 3 ||
        image->data.size() < std::uint64_t(image->step) * image->height) {
      fail("expected complete rgb8 images with positive even dimensions"); return;
    }
    if (!width_) { width_ = static_cast<int>(image->width); height_ = static_cast<int>(image->height); }
    if (image->width != static_cast<unsigned>(width_) || image->height != static_cast<unsigned>(height_)) {
      fail("all cameras must keep the same resolution (expected " + std::to_string(width_) + "x" + std::to_string(height_) + ")"); return;
    }
    const auto time = stamp(*image);
    if (image->header.stamp.sec < 0 || image->header.stamp.nanosec >= 1000000000 || time <= 0) {
      fail("a nonzero ROS header timestamp is required for synchronization"); return;
    }
    if (time < last_stamps_[index]) { fail("ROS image timestamps moved backwards"); return; }
    if (time == last_stamps_[index]) { ++dropped_[index]; return; }
    last_stamps_[index] = time;
    if (queues_[index].size() >= 32) { queues_[index].pop_front(); ++dropped_[index]; }
    queues_[index].push_back(std::move(image));
  }
  Json config_;
  fs::path output_;
  bool calibration_;
  std::vector<std::string> ids_, topics_;
  std::vector<std::deque<Image::ConstSharedPtr>> queues_;
  std::vector<std::uint64_t> dropped_;
  std::vector<std::int64_t> last_stamps_;
  std::vector<rclcpp::Subscription<Image>::SharedPtr> subscriptions_;
  std::mutex mutex_;
  std::string error_;
  int width_{0}, height_{0}, fps_{30};
  std::int64_t tolerance_ns_{5000000};
  std::uint64_t max_frames_{0};
  std::atomic<std::int64_t> max_skew_ns_{0};
  double period_ns_{0}, start_timeout_{15}, stall_timeout_{5};
};
} // namespace

int run_recorder(int argc, char** argv, bool calibration) {
  if (argc > 1 && std::string(argv[1]) == "--help") {
    std::cout << "Usage: recorder [calibration.json] [new-session-directory]\n"
                 "RGB8 images, matching nonzero ROS header timestamps, equal resolution.\n"
                 "Environment: RECORD_FPS, RECORD_SYNC_TOLERANCE_MS, RECORD_MAX_FRAMES, "
                 "CALIBRATION_CAPTURE_FRAMES, CALIBRATION_CAPTURE_INTERVAL_MS, RECORD_ENCODER.\n";
    return 0;
  }
  av_log_set_level(AV_LOG_ERROR);
  std::signal(SIGINT, stop_signal); std::signal(SIGTERM, stop_signal);
  int result = 1;
  try {
    std::ifstream input(argc > 1 ? argv[1] : env("CAMERA_CALIBRATION_FILE", "/home/docker/workspace/cfg/CameraCalibrationSettings.json"));
    if (!input) throw std::runtime_error("Cannot open camera calibration settings");
    const auto config = Json::parse(input);
    const auto output = argc > 2 ? std::string(argv[2]) : env("RECORDING_OUTPUT_DIR");
    if (output.empty()) throw std::runtime_error("RECORDING_OUTPUT_DIR is required");
    rclcpp::init(0, nullptr, rclcpp::InitOptions(), rclcpp::SignalHandlerOptions::None);
    auto node = std::make_shared<Recorder>(config, output, calibration);
    rclcpp::executors::SingleThreadedExecutor executor;
    executor.add_node(node);
    auto worker = std::async(std::launch::async, [&] { return node->record(); });
    try {
      while (worker.wait_for(0ms) != std::future_status::ready) {
        // Process every ready camera once. A small execution-time budget can
        // starve later subscriptions when large RGB messages take time to read.
        executor.spin_some();
        std::this_thread::sleep_for(1ms);
      }
    } catch (...) { requested_stop.store(true); worker.wait(); throw; }
    result = worker.get();
  } catch (const std::exception& error) {
    event({{"event", "error"}, {"error", error.what()}});
  }
  rclcpp::shutdown();
  return result;
}
} // namespace mcs
