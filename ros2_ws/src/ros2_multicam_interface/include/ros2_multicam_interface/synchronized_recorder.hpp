#pragma once
#include <sensor_msgs/msg/image.hpp>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace mcs {
using ImageBatch = std::vector<sensor_msgs::msg::Image::ConstSharedPtr>;

// Timestamp matching shared by calibration PNG sets and one-shot frame capture.
class CaptureOutput {
 public:
  virtual ~CaptureOutput() = default;
  virtual void open(const std::vector<std::string>& serials) = 0;
  virtual void write(const ImageBatch& images, std::uint64_t frame_index) = 0;
  virtual void finish() = 0;
};
using OutputFactory = std::function<std::unique_ptr<CaptureOutput>(const std::filesystem::path&)>;
int run_recorder(int argc, char** argv, bool calibration, OutputFactory factory);
}
