#include "ros2_multicam_interface/synchronized_recorder.hpp"
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <iomanip>
#include <sstream>
#include <stdexcept>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cctype>
#include <cstdlib>
#include <ctime>
#include <thread>
#include <deque>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <limits>
#include <mutex>
#include <set>

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
void event(const Json& data) { std::cout << data.dump() << std::endl; }
std::int64_t stamp(const Image& image) {
  return std::int64_t(image.header.stamp.sec) * 1000000000LL + image.header.stamp.nanosec;
}

class Recorder : public rclcpp::Node {
 public:
  Recorder(Json config, fs::path output, bool calibration, OutputFactory factory)
      : Node(calibration ? "mcs_calibration_recorder" : "mcs_frame_capture"),
        config_(std::move(config)), output_(std::move(output)), calibration_(calibration), factory_(std::move(factory)) {
    ids_ = config_.at("serial_numbers").get<std::vector<std::string>>();
    std::set<std::string> unique;
    for (const auto& id : ids_) {
      if (id.empty() || !std::all_of(id.begin(), id.end(), [](unsigned char c) { return std::isalnum(c) || c == '_'; }) || !unique.insert(id).second)
        throw std::runtime_error("Camera IDs must be unique letters, digits or underscores");
    }
    if (ids_.empty()) throw std::runtime_error("No cameras configured");
    tolerance_ns_ = static_cast<std::int64_t>(setting("RECORD_SYNC_TOLERANCE_MS", 5, 0, 100) * 1e6);
    start_timeout_ = setting("RECORD_START_TIMEOUT_SEC", 15, 1, 120);
    stall_timeout_ = setting("RECORD_STALL_TIMEOUT_SEC", 5, 1, 120);
    max_frames_ = calibration_ ? static_cast<std::uint64_t>(setting("CALIBRATION_CAPTURE_FRAMES", 30, 1, 999)) : 1;
    period_ns_ = calibration_ ? setting("CALIBRATION_CAPTURE_INTERVAL_MS", 500, 1, 60000) * 1e6 : 1;
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
      {"topics", topics_}, {"width", width_}, {"height", height_},
      {"frames", frames}, {"target_frames", max_frames_}, {"max_skew_ns", max_skew_ns_.load()}, {"sync_tolerance_ns", tolerance_ns_}, {"dropped_frames", dropped_},
      {"calibration_capture", calibration_}, {"timestamp_clock", "ROS image header"},
      {"capture_format", "png"},
      {"image_directory", fs::absolute(calibration_ ? output_ / "images" : output_).string()}};
  }
  int record() {
    if (fs::exists(output_)) throw std::runtime_error("Session directory already exists; choose a new name");
    fs::create_directories(output_.parent_path());
    if (!fs::create_directory(output_)) throw std::runtime_error("Cannot reserve session directory");
    std::uint64_t frames = 0;
    std::ofstream timestamps;
    std::unique_ptr<CaptureOutput> destination;
    auto begun = Clock::now(), last_match = begun, last_progress = begun;
    std::int64_t origin = 0, last_slot = -1;
    std::string failure;
    try {
      destination = factory_(output_);
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
          destination->open(ids_);
          event({{"event", "ready"}, {"width", width_}, {"height", height_}, {"cameras", ids_.size()},
                 {"capture_format", "png"}});
        }
        destination->write(batch, frames);
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
    if (destination) {
      try { destination->finish(); } catch (const std::exception& error) { if (failure.empty()) failure = error.what(); }
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
        image->width > std::numeric_limits<int>::max() || image->height > std::numeric_limits<int>::max() ||
        image->step > std::numeric_limits<int>::max() || std::uint64_t(image->step) < std::uint64_t(image->width) * 3 ||
        image->data.size() < std::uint64_t(image->step) * image->height) {
      fail("expected complete rgb8 images with positive dimensions"); return;
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
  OutputFactory factory_;
  std::vector<std::string> ids_, topics_;
  std::vector<std::deque<Image::ConstSharedPtr>> queues_;
  std::vector<std::uint64_t> dropped_;
  std::vector<std::int64_t> last_stamps_;
  std::vector<rclcpp::Subscription<Image>::SharedPtr> subscriptions_;
  std::mutex mutex_;
  std::string error_;
  int width_{0}, height_{0};
  std::int64_t tolerance_ns_{5000000};
  std::uint64_t max_frames_{0};
  std::atomic<std::int64_t> max_skew_ns_{0};
  double period_ns_{0}, start_timeout_{15}, stall_timeout_{5};
};
} // namespace

int run_recorder(int argc, char** argv, bool calibration, OutputFactory factory) {
  if (argc > 1 && std::string(argv[1]) == "--help") {
    std::cout << "Usage: calibration_tab_ros2_image_recorder [--frame] [calibration.json] [new-output-directory]\n"
                 "RGB8 images, matching nonzero ROS header timestamps, equal resolution.\n"
                 "Synchronization: RECORD_SYNC_TOLERANCE_MS, RECORD_START_TIMEOUT_SEC, RECORD_STALL_TIMEOUT_SEC.\n";
    if (calibration)
      std::cout << "Output: lossless images/cam<serial>-0001.png, frame_timestamps.jsonl, session.json.\n"
                   "Environment: CALIBRATION_OUTPUT_DIR, CALIBRATION_DATA, CALIBRATION_CAPTURE_FRAMES, CALIBRATION_CAPTURE_INTERVAL_MS.\n";
    else std::cout << "Output: one synchronized cam<serial>.png per camera, frame_timestamps.jsonl, session.json.\n";
    return 0;
  }
  std::signal(SIGINT, stop_signal); std::signal(SIGTERM, stop_signal);
  int result = 1;
  try {
    std::ifstream input(argc > 1 ? argv[1] : env("CAMERA_CALIBRATION_FILE", "/home/docker/workspace/cfg/CameraCalibrationSettings.json"));
    if (!input) throw std::runtime_error("Cannot open camera calibration settings");
    const auto config = Json::parse(input);
    if (argc > 3) throw std::runtime_error("Too many arguments; see --help");
    auto output = argc > 2 ? std::string(argv[2]) : env("CALIBRATION_OUTPUT_DIR");
    if (output.empty()) {
      const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
      std::tm local{};
      localtime_r(&now, &local);
      char timestamp[32]{};
      std::strftime(timestamp, sizeof(timestamp), "%Y-%m-%d-%H-%M-%S", &local);
      output = (fs::path(env("CALIBRATION_DATA", "/home/docker/workspace/data")) /
          (calibration ? "calibration" : "recordings") / ((calibration ? std::string() : "frame_") + timestamp)).string();
    }
    rclcpp::init(0, nullptr, rclcpp::InitOptions(), rclcpp::SignalHandlerOptions::None);
    auto node = std::make_shared<Recorder>(config, output, calibration, std::move(factory));
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

namespace {
namespace fs = std::filesystem;

class PngCapture final : public mcs::CaptureOutput {
 public:
  PngCapture(const fs::path& directory, bool frame) : images_(frame ? directory : directory / "images"), frame_(frame) {
    if (!frame && !fs::create_directory(images_)) throw std::runtime_error("Calibration image directory already exists");
  }
  void open(const std::vector<std::string>& serials) override { serials_ = serials; }
  void write(const mcs::ImageBatch& batch, std::uint64_t frame_index) override {
    if (batch.size() != serials_.size()) throw std::runtime_error("Incomplete calibration image set");
    std::vector<fs::path> temporary, destinations, published;
    try {
      for (std::size_t i = 0; i < batch.size(); ++i) {
        std::ostringstream name;
        name << "cam" << serials_[i];
        if (!frame_) name << '-' << std::setw(4) << std::setfill('0') << frame_index + 1;
        const auto destination = images_ / (name.str() + ".png");
        if (fs::exists(destination)) throw std::runtime_error("Calibration image already exists: " + destination.string());
        destinations.push_back(destination);
        temporary.push_back(images_ / (name.str() + ".tmp.png"));
        const auto& image = *batch[i];
        cv::Mat rgb(static_cast<int>(image.height), static_cast<int>(image.width), CV_8UC3,
                    const_cast<std::uint8_t*>(image.data.data()), image.step), bgr;
        // OpenCV expects BGR for PNG writing. Pixel values and source resolution
        // are preserved exactly; no resizing, color correction or video codec.
        cv::cvtColor(rgb, bgr, cv::COLOR_RGB2BGR);
        if (!cv::imwrite(temporary.back().string(), bgr, {cv::IMWRITE_PNG_COMPRESSION, 1}))
          throw std::runtime_error("Cannot save calibration PNG: " + destination.string());
      }
      for (std::size_t i = 0; i < temporary.size(); ++i) {
        fs::rename(temporary[i], destinations[i]);
        published.push_back(destinations[i]);
      }
    } catch (...) {
      // Retain previous complete sets, but do not leave a partial current set.
      std::error_code ignored;
      for (const auto& path : temporary) fs::remove(path, ignored);
      for (const auto& path : published) fs::remove(path, ignored);
      throw;
    }
  }
  void finish() override {}
 private:
  fs::path images_;
  bool frame_;
  std::vector<std::string> serials_;
};
}

int main(int argc, char** argv) {
  const bool frame = argc > 1 && std::string(argv[1]) == "--frame";
  return mcs::run_recorder(frame ? argc - 1 : argc, frame ? argv + 1 : argv, !frame, [frame](const fs::path& directory) {
    return std::make_unique<PngCapture>(directory, frame);
  });
}
