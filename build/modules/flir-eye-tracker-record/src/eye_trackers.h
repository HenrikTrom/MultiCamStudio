#pragma once

#include <rapidjson/document.h>
#include <cstdint>
#include <string>
#include <vector>

namespace hrsoc {
struct EyeTracker {
  std::string name;
  std::string endpoint;
};

struct EyeTrackerSettings {
  std::vector<EyeTracker> trackers;
  int timeout_ms = 1000;
  int refresh_interval_ms = 2000;
  int clock_measurement_interval_ms = 5000;
  int clock_measurement_samples = 10;
};

struct Reply {
  bool connected = false;
  std::string message;
  std::int64_t host_before_ns = 0;
  std::int64_t host_after_ns = 0;
};

// Own a socket on one thread. Reuse it for a burst; reconnect after errors.
class PupilRemote {
 public:
  PupilRemote(EyeTracker tracker, int timeout_ms);
  ~PupilRemote();
  PupilRemote(const PupilRemote&) = delete;
  PupilRemote& operator=(const PupilRemote&) = delete;
  Reply request(const std::string& command);
 private:
  EyeTracker tracker_;
  int timeout_ms_;
  void* context_ = nullptr;
  void* socket_ = nullptr;
};

rapidjson::Document load_json(const std::string& path);
std::string json_string(const std::string& value);
EyeTrackerSettings load_eye_tracker_settings(const std::string& path);
Reply request(const EyeTracker& tracker, const std::string& command, int timeout_ms);
std::vector<Reply> probe(const EyeTrackerSettings& settings);
std::string status_json(const EyeTrackerSettings& settings);

// Stop every tracker we attempted to start, even if its start reply was lost.
class EyeTrackerRecording {
 public:
  explicit EyeTrackerRecording(EyeTrackerSettings settings);
  ~EyeTrackerRecording();
  void start(const std::string& session_name);
  bool stop();
 private:
  EyeTrackerSettings settings_;
  std::vector<EyeTracker> attempted_;
};
}  // namespace hrsoc
