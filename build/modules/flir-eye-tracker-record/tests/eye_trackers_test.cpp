#include "eye_trackers.h"
#include "timestamp_log.h"
#include "clock_measurements.h"
#include <zmq.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
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
  std::vector<std::string> commands() {
    std::lock_guard<std::mutex> lock(mutex_);
    return commands_;
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

std::vector<rapidjson::Document> read_clock_log(const std::filesystem::path& path) {
  std::ifstream input(path);
  std::string line;
  std::vector<rapidjson::Document> records;
  while (std::getline(input, line)) {
    rapidjson::Document record;
    record.Parse(line.c_str());
    check(!record.HasParseError(), "Each clock log line must be complete JSON");
    records.push_back(std::move(record));
  }
  return records;
}

void clock_tests(const std::filesystem::path& path) {
  bool rejected_path = false;
  try { hrsoc::ClockMeasurements log({}, path.parent_path()); }
  catch (const std::runtime_error&) { rejected_path = true; }
  check(rejected_path, "An unwritable clock log must fail instead of silently losing measurements");
  std::atomic<int> calls{0};
  Remote clock([&](const std::string& command) {
    check(command == "t", "Clock measurement must only read the Pupil clock");
    timespec now{};
    clock_gettime(CLOCK_MONOTONIC, &now);
    std::ostringstream reply;
    reply << std::setprecision(17) << now.tv_sec + now.tv_nsec / 1e9 - 60.0;
    // Deliberately introduce asymmetric latency into one reading per burst.
    if (++calls % 10 == 0) std::this_thread::sleep_for(std::chrono::milliseconds(40));
    return reply.str();
  });
  hrsoc::EyeTrackerSettings settings{{{"Clock", clock.endpoint}}, 100, 1000};
  settings.clock_measurement_interval_ms = 1000;
  {
    hrsoc::ClockMeasurements log(settings, path);
    log.start();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(4);
    while (calls < 20 && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    check(calls >= 20, "Periodic measurements must run while recording");
    log.check();
    log.stop();
    log.stop();
  }
  auto records = read_clock_log(path);
  check(std::string(records[0]["host_clock"].GetString()) == "CLOCK_MONOTONIC", "Clock domain must match FLIR callbacks");
  bool before = false, during = false, after = false, excluded_slow_reply = false;
  for (const auto& record : records) {
    const std::string type = record["record_type"].GetString();
    if (type == "measurement" && record["success"].GetBool()) {
      const auto begin = std::stoll(record["host_before_ns"].GetString());
      const auto end = std::stoll(record["host_after_ns"].GetString());
      check(end >= begin && end - begin == std::stoll(record["round_trip_ns"].GetString()), "Clock log must preserve bracketed request times");
      check(std::isfinite(record["pupil_time_s"].GetDouble()), "Pupil times must be numeric seconds");
      if (end - begin >= 35000000 && !record["used_in_estimate"].GetBool()) excluded_slow_reply = true;
    }
    if (type != "estimate") continue;
    check(record["success"].GetBool(), "Mock clock must produce valid estimates");
    check(record["accepted_sample_count"].GetUint64() <= 7, "Slowest 30 percent of each complete burst must be excluded");
    check(std::abs(record["estimated_host_minus_pupil_s"].GetDouble() - 60.0) < 0.01,
          "Estimated offset must recover the known 60 second clock difference");
    const std::string phase = record["phase"].GetString();
    before |= phase == "before";
    during |= phase == "during";
    after |= phase == "after";
  }
  check(before && during && after && excluded_slow_reply, "Clock log must contain all phases and reject high latency readings");

  // Waiting for the next interval must not delay Stop.
  settings.clock_measurement_interval_ms = 60000;
  settings.clock_measurement_samples = 3;
  {
    hrsoc::ClockMeasurements log(settings, path);
    log.start();
    auto begin = std::chrono::steady_clock::now();
    log.stop();
    check(std::chrono::steady_clock::now() - begin < std::chrono::seconds(1), "Stop must wake an idle measurement worker");
  }
  for (const std::string invalid : {"nan", "inf", "12.3garbage", "OK", ""}) {
    Remote malformed([&](const std::string&) { return invalid; });
    settings.trackers = {{"Malformed", malformed.endpoint}};
    {
      hrsoc::ClockMeasurements log(settings, path);
      log.start();
      log.stop();
    }
    records = read_clock_log(path);
    for (const auto& record : records) {
      if (std::string(record["record_type"].GetString()) == "metadata") continue;
      check(!record["success"].GetBool(), "Malformed clock replies must be logged as failures");
      check(!record.HasMember("estimated_host_minus_pupil_s"), "Invalid replies must never produce clock offsets");
    }
  }
  Remote timeout([](const std::string&) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    return "1.0";
  });
  settings.trackers = {{"Timeout", timeout.endpoint}};
  {
    hrsoc::ClockMeasurements log(settings, path);
    log.start();
    log.stop();
  }
  records = read_clock_log(path);
  check(records.size() == 5 && !records[1]["success"].GetBool(), "Timeouts must be logged and stop the current burst");

  std::atomic<int> retries{0};
  Remote recovering([&](const std::string&) {
    if (++retries == 4) return std::string("Clock unavailable");
    return std::string("40.0");
  });
  settings.trackers = {{"Recovering", recovering.endpoint}};
  settings.clock_measurement_interval_ms = 1000;
  {
    hrsoc::ClockMeasurements log(settings, path);
    log.start();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(4);
    while (retries < 7 && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    check(retries >= 7, "Clock sampling must retry after a failed burst");
    log.check();
    log.stop();
  }
  bool failed_burst = false, recovered_burst = false;
  for (const auto& record : read_clock_log(path)) {
    if (std::string(record["record_type"].GetString()) != "estimate" ||
        std::string(record["phase"].GetString()) != "during") continue;
    if (!record["success"].GetBool()) failed_burst = true;
    else if (failed_burst) recovered_burst = true;
  }
  check(failed_burst && recovered_burst, "A failed clock burst must not terminate the background worker");

  settings.trackers.clear();
  {
    hrsoc::ClockMeasurements log(settings, path);
    log.start();
  }
  check(read_clock_log(path).size() == 1, "FLIR-only sessions must not generate tracker measurements");
  settings.trackers = {{"Clock", clock.endpoint}};
  try {
    hrsoc::ClockMeasurements log(settings, path);
    log.start();
    throw std::runtime_error("Capture failed");
  } catch (const std::runtime_error&) {}
  records = read_clock_log(path);
  check(std::string(records.back()["phase"].GetString()) == "after", "Exception unwinding must take final clock measurements");
  std::filesystem::remove(path);
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
    for (const auto* config : {R"({"eye_trackers":[],"clock_measurement_interval_ms":0})",
                               R"({"eye_trackers":[],"clock_measurement_samples":2})"}) {
      { std::ofstream file(path); file << config; }
      rejected = false;
      try { hrsoc::load_eye_tracker_settings(path.string()); } catch (const std::exception&) { rejected = true; }
      check(rejected, "Invalid clock measurement settings must be rejected");
    }
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
    clock_tests(path);
    std::cout << "Eye tracker control tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
