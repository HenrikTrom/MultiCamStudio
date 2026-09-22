#include <flirmulticamera/FlirCamera.h>
#include <flirmulticamera/videoIO.h>
#include <spdlog/spdlog.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace flirmulticamera;

namespace {
std::atomic<bool> recording{true};

void request_stop(int) { recording.store(false); }

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
}  // namespace

int main(int argc, char** argv) {
  struct sigaction action {};
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGTERM, &action, nullptr);

  try {
    const std::string config_file = argc > 1 ? argv[1] : default_config_path();
    CameraSettings settings;
    spdlog::info("Loading camera settings from {}", config_file);
    load_camera_settings(config_file, settings);
    if (settings.save_dir.empty()) {
#ifdef CONFIG_DIR
      settings.save_dir = std::string(CONFIG_DIR) + "/../outputs";
#else
      throw std::runtime_error("Camera settings contain no save_dir");
#endif
    }
    if (settings.SNs.empty()) {
      throw std::runtime_error("Camera settings contain no serial numbers");
    }
    const char* configured_name = std::getenv("RECORDING_NAME");
    const std::string recording_name =
        configured_name != nullptr && configured_name[0] != '\0'
            ? configured_name
            : "recording";
    const std::filesystem::path recording_directory =
        std::filesystem::path(settings.save_dir) / recording_name;
    std::filesystem::create_directories(recording_directory);
    spdlog::info("Recording name: {}", recording_name);
    spdlog::info("Recording output directory: {}",
                 recording_directory.string());

    FlirCameraHandler cameras(settings);
    if (!cameras.Configure()) {
      throw std::runtime_error("Could not configure FlirCameraHandler");
    }

    VideoWriter writer{
        static_cast<std::uint32_t>(settings.width),
        static_cast<std::uint32_t>(settings.height),
        static_cast<float>(settings.fps),
        settings.codec,
        settings.pixel_format,
    };
    std::vector<std::string> filenames(settings.SNs.size());
    for (std::size_t index = 0; index < settings.SNs.size(); ++index) {
      filenames[index] =
          (recording_directory / (settings.SNs[index] + ".mp4")).string();
      spdlog::info("Opening output {}", filenames[index]);
    }
    writer.Open(filenames);
    cameras.Start();
    spdlog::info("Synchronized recording started for {} cameras", filenames.size());

    std::vector<Frame> frames;
    std::uint64_t frame_count = 0;
    while (recording.load()) {
      if (!cameras.Get(frames)) {
        std::this_thread::sleep_for(std::chrono::microseconds(50));
        continue;
      }
      std::vector<Spinnaker::ImagePtr> buffer;
      buffer.reserve(frames.size());
      for (auto& frame : frames) {
        if (frame.frameData != nullptr && !frame.frameData->IsIncomplete()) {
          buffer.push_back(frame.frameData);
        }
      }
      if (buffer.size() != filenames.size()) {
        spdlog::warn("Skipping incomplete synchronized set: got {} of {} frames",
                     buffer.size(), filenames.size());
        continue;
      }
      writer.Write(buffer);
      ++frame_count;
      if (frame_count == 1 || frame_count % 100 == 0) {
        spdlog::info("Recorded {} synchronized frames", frame_count);
      }
    }

    spdlog::info("Stopping recorder after {} synchronized frames", frame_count);
    cameras.Stop();
    writer.Close();
    spdlog::info("Recording completed successfully");
  } catch (const std::exception& error) {
    spdlog::error("{}", error.what());
    return 1;
  }
  return 0;
}
