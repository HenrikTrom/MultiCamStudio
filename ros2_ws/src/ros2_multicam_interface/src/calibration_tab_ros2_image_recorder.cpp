#include "ros2_multicam_interface/synchronized_recorder.hpp"
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <iomanip>
#include <sstream>
#include <stdexcept>

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
