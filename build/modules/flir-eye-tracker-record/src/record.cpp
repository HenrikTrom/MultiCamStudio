#include "eye_trackers.h"
#include "timestamp_log.h"
#include "clock_measurements.h"
#include <flirmulticamera/FlirCamera.h>
#include <flirmulticamera/videoIO.h>
#include <spdlog/spdlog.h>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace flirmulticamera;
namespace fs = std::filesystem;

namespace {
volatile std::sig_atomic_t running = 1;
void request_stop(int) { running = 0; }

std::string environment(const char* key, const std::string& fallback = "") {
  const char* value = std::getenv(key);
  return value && *value ? value : fallback;
}

std::int64_t unix_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}

struct Capture {
  FlirCameraHandler& cameras;
  VideoWriter& writer;
  bool opened = false;
  ~Capture() {
    try { cameras.Stop(); } catch (const std::exception& error) { spdlog::error("Camera stop: {}", error.what()); }
    if (opened) {
      try { writer.Close(); } catch (const std::exception& error) { spdlog::error("Video close: {}", error.what()); }
    }
  }
};

std::string timestamp_entry(const std::vector<Frame>& frames,
                          const std::vector<std::string>& serials, std::uint64_t index) {
  std::string entry = "{\"video_frame_index\":" + std::to_string(index) +
      ",\"host_unix_ns\":" + hrsoc::json_string(std::to_string(unix_ns())) + ",\"cameras\":{";
  for (std::size_t i = 0; i < frames.size(); ++i) {
    const auto& frame = frames[i];
    if (i) entry += ',';
    const auto monotonic = static_cast<std::int64_t>(frame.Timestamp.tv_sec) * 1000000000LL + frame.Timestamp.tv_nsec;
    entry += hrsoc::json_string(serials[i]) + ":{\"frame_counter\":" + hrsoc::json_string(std::to_string(frame.FrameCounter)) +
        ",\"camera_timestamp_ns\":" + hrsoc::json_string(std::to_string(frame.frameData->GetTimeStamp())) +
        ",\"aligned_monotonic_ns\":" + hrsoc::json_string(std::to_string(frame.imgTimestamp)) +
        ",\"host_monotonic_ns\":" + hrsoc::json_string(std::to_string(monotonic)) + "}";
  }
  return entry + "}}";
}
}  // namespace

int main(int argc, char** argv) {
  std::signal(SIGINT, request_stop);
  std::signal(SIGTERM, request_stop);
  spdlog::flush_on(spdlog::level::info);
  try {
    const std::string eye_path = environment("EYE_TRACKER_SETTINGS_FILE",
        "/home/docker/workspace/cfg/eye_tracker_settings.json");
    if (argc > 1 && std::string(argv[1]) == "--status") {
      std::cout << hrsoc::status_json(hrsoc::load_eye_tracker_settings(argc > 2 ? argv[2] : eye_path)) << std::endl;
      return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--help") {
      std::cout << "flir_eye_tracker_recorder [camera.json [eye_tracker_settings.json]]\n"
                   "flir_eye_tracker_recorder --status [eye_tracker_settings.json]\n"
                   "Environment: CAMERA_SETTINGS_FILE, EYE_TRACKER_SETTINGS_FILE, RECORDING_NAME, RECORDING_SAVE_DIR\n";
      return 0;
    }
    const auto eyes = hrsoc::load_eye_tracker_settings(argc > 2 ? argv[2] : eye_path);
    const std::string camera_path = argc > 1 ? argv[1] : environment("CAMERA_SETTINGS_FILE");
    if (camera_path.empty()) throw std::runtime_error("Set CAMERA_SETTINGS_FILE or pass camera.json");
    CameraSettings settings;
    if (!load_camera_settings(camera_path, settings)) throw std::runtime_error("Invalid camera settings");
    if (settings.SNs.size() != GLOBAL_CONST_NCAMS || settings.SNs.empty())
      throw std::runtime_error("Camera count must match the flirmulticamera build's FLIR_CAMERA_COUNT");
    settings.save_dir = environment("RECORDING_SAVE_DIR", settings.save_dir);
    if (settings.save_dir.empty()) throw std::runtime_error("Choose a save directory");
    const std::string name = environment("RECORDING_NAME", "recording_" + std::to_string(unix_ns()));
    if (name == "." || name == ".." || name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-") != std::string::npos)
      throw std::runtime_error("Session name may only contain letters, numbers, underscores, dots and hyphens");
    const fs::path directory = fs::path(settings.save_dir) / name;
    fs::create_directories(directory.parent_path());
    if (!fs::create_directory(directory))
      throw std::runtime_error("Session directory already exists; choose another name: " + directory.string());
    spdlog::info("Recording output directory: {}", directory.string());
    fs::copy_file(camera_path, directory / "camera_settings.json");
    fs::copy_file(argc > 2 ? argv[2] : eye_path, directory / "eye_tracker_settings.json");
    hrsoc::TimestampLog timestamps(directory / "frame_timestamps.json");
    hrsoc::EyeTrackerRecording eye_recording(eyes);
    hrsoc::ClockMeasurements clock_measurements(eyes, directory / "clock_measurements.jsonl");
    FlirCameraHandler cameras(settings);
    if (!cameras.Configure()) throw std::runtime_error("Could not configure FlirCameraHandler");
    VideoWriter writer{static_cast<std::uint32_t>(settings.width),
                       static_cast<std::uint32_t>(settings.height),
                       static_cast<float>(settings.fps), settings.codec, settings.pixel_format};
    Capture capture{cameras, writer};
    std::vector<std::string> filenames;
    for (const auto& serial : settings.SNs) filenames.push_back((directory / (serial + ".mp4")).string());
    writer.Open(filenames);
    capture.opened = true;
    if (!running) return 0;
    clock_measurements.start();
    if (!running) return 0;
    eye_recording.start(name);
    if (!running) return 0;
    cameras.Start();
    spdlog::info("Synchronized recording started: {} cameras, {} eye trackers", filenames.size(), eyes.trackers.size());
    std::vector<Frame> frames;
    std::uint64_t frame_count = 0;
    auto last_frame = std::chrono::steady_clock::now();
    while (running) {
      clock_measurements.check();
      if (!cameras.Get(frames)) {
        if (std::chrono::steady_clock::now() - last_frame > std::chrono::seconds(10))
          throw std::runtime_error("No synchronized FLIR frames received for 10 seconds");
        std::this_thread::sleep_for(std::chrono::microseconds(50));
        continue;
      }
      std::vector<Spinnaker::ImagePtr> buffer;
      for (auto& frame : frames)
        if (frame.frameData != nullptr && !frame.frameData->IsIncomplete()) buffer.push_back(frame.frameData);
      if (buffer.size() != filenames.size()) {
        for (auto& frame : frames) if (frame.frameData != nullptr) frame.frameData->Release();
        spdlog::warn("Skipping incomplete synchronized frame set");
        continue;
      }
      // Read metadata before handing image ownership to the asynchronous writer.
      const auto entry = timestamp_entry(frames, settings.SNs, frame_count);
      writer.Write(buffer);
      timestamps.append(entry);
      last_frame = std::chrono::steady_clock::now();
      ++frame_count;
      if (frame_count == 1 || frame_count % 100 == 0) spdlog::info("Recorded {} synchronized frames", frame_count);
    }
    cameras.Stop();
    const bool eyes_stopped = eye_recording.stop();
    clock_measurements.stop();
    if (!timestamps.close()) throw std::runtime_error("Could not finalize frame_timestamps.json");
    spdlog::info("Recording stopped after {} synchronized frames", frame_count);
    return eyes_stopped ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << "HRSoc recorder: " << error.what() << std::endl;
    return 1;
  }
}
