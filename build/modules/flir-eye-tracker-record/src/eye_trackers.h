#pragma once

#include <rapidjson/document.h>
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
};

struct Reply {
  bool connected = false;
  std::string message;
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
