#include "eye_trackers.h"
#include "timestamp_log.h"
#include <zmq.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace {
void check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

class Remote {
 public:
  explicit Remote(std::function<std::string(const std::string&)> reply) : reply_(std::move(reply)) {
    context_ = zmq_ctx_new();
    socket_ = zmq_socket(context_, ZMQ_REP);
    const int timeout = 50, linger = 0;
    zmq_setsockopt(socket_, ZMQ_RCVTIMEO, &timeout, sizeof(timeout));
    zmq_setsockopt(socket_, ZMQ_LINGER, &linger, sizeof(linger));
    check(zmq_bind(socket_, "tcp://127.0.0.1:*") == 0, "Could not bind mock Pupil Remote");
    char address[256];
    std::size_t length = sizeof(address);
    zmq_getsockopt(socket_, ZMQ_LAST_ENDPOINT, address, &length);
    endpoint = address;
    worker_ = std::thread([this] {
      while (running_) {
        char buffer[1024];
        const int count = zmq_recv(socket_, buffer, sizeof(buffer), 0);
        if (count < 0) continue;
        const std::string command(buffer, count);
        {
          std::lock_guard<std::mutex> lock(mutex_);
          commands_.push_back(command);
        }
        const auto response = reply_(command);
        zmq_send(socket_, response.data(), response.size(), 0);
      }
    });
  }
  ~Remote() {
    running_ = false;
    worker_.join();
    zmq_close(socket_);
    zmq_ctx_term(context_);
  }
  bool received(const std::string& command) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& value : commands_) if (value == command) return true;
    return false;
  }
  std::string endpoint;
 private:
  void* context_;
  void* socket_;
  std::function<std::string(const std::string&)> reply_;
  std::atomic<bool> running_{true};
  std::mutex mutex_;
  std::vector<std::string> commands_;
  std::thread worker_;
};

std::string respond(const std::string& command) {
  if (command == "v") return "3.5.0";
  return "OK";
}
}  // namespace

int main() {
  try {
    const auto path = std::filesystem::temp_directory_path() /
        ("hrsoc-settings-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
    { std::ofstream file(path); file << R"({"eye_trackers":[],"timeout_ms":100})"; }
    check(hrsoc::load_eye_tracker_settings(path.string()).trackers.empty(), "Zero eye trackers must be supported");
    { std::ofstream file(path); file << R"({"eye_trackers":[],"timeout_ms":0})"; }
    bool rejected = false;
    try { hrsoc::load_eye_tracker_settings(path.string()); } catch (const std::exception&) { rejected = true; }
    check(rejected, "Invalid timeout must be rejected");
    { std::ofstream file(path); file << R"({"eye_trackers":[{"name":"a","ip":"127.0.0.1","port":1234},{"name":"b","ip":"127.0.0.1","port":1234}]})"; }
    rejected = false;
    try { hrsoc::load_eye_tracker_settings(path.string()); } catch (const std::exception&) { rejected = true; }
    check(rejected, "Duplicate endpoints must be rejected");
    {
      hrsoc::TimestampLog log(path);
    }
    auto timestamps = hrsoc::load_json(path.string());
    check(timestamps["frames"].Empty() && timestamps["frame_count"].GetUint64() == 0, "Empty sessions must produce valid JSON");
    try {
      hrsoc::TimestampLog log(path);
      log.append(R"({"video_frame_index":0,"camera_timestamp_ns":"18446744073709551615"})");
      log.append(R"({"video_frame_index":1,"camera_timestamp_ns":"18446744073709551616"})");
      throw std::runtime_error("Simulate capture failure");
    } catch (const std::runtime_error&) {}
    timestamps = hrsoc::load_json(path.string());
    check(timestamps["frames"].Size() == 2 && timestamps["frame_count"].GetUint64() == 2, "Capture failure must finalize timestamp JSON");
    check(std::string(timestamps["frames"][0]["camera_timestamp_ns"].GetString()) == "18446744073709551615", "Nanosecond timestamps must retain integer precision");
    std::filesystem::remove(path);

    Remote remote(respond);
    hrsoc::EyeTrackerSettings settings{{{"Pupil 1", remote.endpoint}}, 100, 1000};
    rapidjson::Document status;
    status.Parse(hrsoc::status_json(settings).c_str());
    check(!status.HasParseError() && status["trackers"][0]["connected"].GetBool(), "Status must report reachable trackers");
    check(status["trackers"][0]["message"].GetString() == std::string("3.5.0"), "Status must include Pupil version");
    {
      hrsoc::EyeTrackerRecording recording(settings);
      recording.start("session");
    }
    check(remote.received("R session") && remote.received("r"), "RAII must stop remote recording");

    Remote denied([](const std::string& command) { return command == "v" ? "3.5.0" : command == "r" ? "Recording stopped." : "Recording not available"; });
    settings.trackers.push_back({"Pupil 2", denied.endpoint});
    rejected = false;
    try {
      hrsoc::EyeTrackerRecording recording(settings);
      recording.start("partial");
    } catch (const std::exception&) { rejected = true; }
    check(rejected && denied.received("r"), "Partial starts must be rolled back, including rejected/ambiguous replies");

    Remote slow([](const std::string&) {
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
      return "3.5.0";
    });
    check(!hrsoc::request({"Slow", slow.endpoint}, "v", 100).connected, "Status probes must time out");
    std::this_thread::sleep_for(std::chrono::milliseconds(180));
    check(hrsoc::request({"Recovered", remote.endpoint}, "v", 100).connected, "A timeout must not poison subsequent requests");
    std::cout << "Eye tracker control tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
