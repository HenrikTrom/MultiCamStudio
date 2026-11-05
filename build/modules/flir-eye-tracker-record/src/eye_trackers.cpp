#include "eye_trackers.h"

#include <rapidjson/error/en.h>
#include <rapidjson/istreamwrapper.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <zmq.h>
#include <fstream>
#include <future>
#include <iostream>
#include <set>
#include <stdexcept>
#include <time.h>

namespace hrsoc {
rapidjson::Document load_json(const std::string& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("Cannot open JSON settings: " + path);
  rapidjson::IStreamWrapper stream(input);
  rapidjson::Document document;
  document.ParseStream(stream);
  if (document.HasParseError() || !document.IsObject()) {
    throw std::runtime_error("Invalid JSON object in " + path);
  }
  return document;
}

std::string json_string(const std::string& value) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.String(value.c_str(), static_cast<rapidjson::SizeType>(value.size()));
  return buffer.GetString();
}

EyeTrackerSettings load_eye_tracker_settings(const std::string& path) {
  auto document = load_json(path);
  EyeTrackerSettings settings;
  const auto integer = [&](const char* key, int fallback, int minimum, int maximum) {
    if (!document.HasMember(key)) return fallback;
    const auto& value = document[key];
    if (!value.IsInt() || value.GetInt() < minimum || value.GetInt() > maximum)
      throw std::runtime_error(std::string(key) + " is outside the allowed range");
    return value.GetInt();
  };
  settings.timeout_ms = integer("timeout_ms", 1000, 100, 5000);
  settings.refresh_interval_ms = integer("refresh_interval_ms", 2000, 1000, 60000);
  settings.clock_measurement_interval_ms = integer("clock_measurement_interval_ms", 5000, 1000, 60000);
  settings.clock_measurement_samples = integer("clock_measurement_samples", 10, 3, 60);
  if (!document.HasMember("eye_trackers") || !document["eye_trackers"].IsArray())
    throw std::runtime_error("eye_trackers must be an array");
  if (document["eye_trackers"].Size() > 32)
    throw std::runtime_error("At most 32 eye trackers are supported");
  std::set<std::string> endpoints;
  for (const auto& value : document["eye_trackers"].GetArray()) {
    if (!value.IsObject() || !value.HasMember("name") || !value["name"].IsString() ||
        !value.HasMember("ip") || !value["ip"].IsString() ||
        !value.HasMember("port") || !value["port"].IsInt() ||
        value["port"].GetInt() < 1 || value["port"].GetInt() > 65535)
      throw std::runtime_error("Each eye tracker needs a name, IP address and port (1–65535)");
    const std::string name = value["name"].GetString();
    const std::string ip = value["ip"].GetString();
    if (name.empty() || ip.empty() || ip.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:") != std::string::npos)
      throw std::runtime_error("Eye tracker name/IP is empty or invalid");
    const std::string host = ip.find(':') == std::string::npos ? ip : "[" + ip + "]";
    const std::string endpoint = "tcp://" + host + ":" + std::to_string(value["port"].GetInt());
    if (!endpoints.insert(endpoint).second)
      throw std::runtime_error("Duplicate eye tracker endpoint: " + endpoint);
    settings.trackers.push_back({name, endpoint});
  }
  return settings;
}

namespace {
std::int64_t monotonic_ns() {
  timespec now{};
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0)
    throw std::runtime_error("Cannot read CLOCK_MONOTONIC");
  return static_cast<std::int64_t>(now.tv_sec) * 1000000000LL + now.tv_nsec;
}
}

PupilRemote::PupilRemote(EyeTracker tracker, int timeout_ms)
    : tracker_(std::move(tracker)), timeout_ms_(timeout_ms), context_(zmq_ctx_new()) {}

PupilRemote::~PupilRemote() {
  if (socket_) zmq_close(socket_);
  if (context_) zmq_ctx_term(context_);
}

Reply PupilRemote::request(const std::string& command) {
  if (!context_) return {false, "Cannot create ZeroMQ context"};
  const auto failed = [&](const std::string& message, std::int64_t before = 0) {
    if (socket_) zmq_close(socket_);
    socket_ = nullptr;
    return Reply{false, message, before, before ? monotonic_ns() : 0};
  };
  if (!socket_) {
    socket_ = zmq_socket(context_, ZMQ_REQ);
    if (!socket_) return {false, "Cannot create ZeroMQ socket"};
    const int linger = 0;
    if (zmq_setsockopt(socket_, ZMQ_LINGER, &linger, sizeof(linger)) != 0 ||
        zmq_setsockopt(socket_, ZMQ_SNDTIMEO, &timeout_ms_, sizeof(timeout_ms_)) != 0 ||
        zmq_setsockopt(socket_, ZMQ_RCVTIMEO, &timeout_ms_, sizeof(timeout_ms_)) != 0 ||
        zmq_connect(socket_, tracker_.endpoint.c_str()) != 0)
      return failed(std::string("Request failed: ") + zmq_strerror(zmq_errno()));
  }
  const auto before = monotonic_ns();
  if (zmq_send(socket_, command.data(), command.size(), 0) < 0)
    return failed(std::string("Request failed: ") + zmq_strerror(zmq_errno()), before);
  zmq_msg_t message;
  zmq_msg_init(&message);
  const int received = zmq_msg_recv(&message, socket_, 0);
  const int error = zmq_errno();
  const auto after = monotonic_ns();
  std::string reply;
  if (received >= 0)
    reply.assign(static_cast<const char*>(zmq_msg_data(&message)), zmq_msg_size(&message));
  zmq_msg_close(&message);
  if (received < 0) {
    auto result = failed(std::string("No reply: ") + zmq_strerror(error), before);
    result.host_after_ns = after;
    return result;
  }
  if (reply.empty()) return {false, "Empty reply", before, after};
  return {true, reply, before, after};
}

Reply request(const EyeTracker& tracker, const std::string& command, int timeout_ms) {
  PupilRemote remote(tracker, timeout_ms);
  return remote.request(command);
}

std::vector<Reply> probe(const EyeTrackerSettings& settings) {
  std::vector<std::future<Reply>> pending;
  for (const auto& tracker : settings.trackers)
    pending.push_back(std::async(std::launch::async, [tracker, &settings] {
      return request(tracker, "v", settings.timeout_ms);
    }));
  std::vector<Reply> replies;
  for (auto& task : pending) replies.push_back(task.get());
  return replies;
}

std::string status_json(const EyeTrackerSettings& settings) {
  const auto replies = probe(settings);
  std::string json = "{\"refreshIntervalMs\":" + std::to_string(settings.refresh_interval_ms) + ",\"trackers\":[";
  for (std::size_t i = 0; i < replies.size(); ++i) {
    if (i) json += ',';
    json += "{\"name\":" + json_string(settings.trackers[i].name) +
            ",\"endpoint\":" + json_string(settings.trackers[i].endpoint) +
            ",\"connected\":" + (replies[i].connected ? "true" : "false") +
            ",\"message\":" + json_string(replies[i].message) + "}";
  }
  return json + "]}";
}

EyeTrackerRecording::EyeTrackerRecording(EyeTrackerSettings settings) : settings_(std::move(settings)) {}
EyeTrackerRecording::~EyeTrackerRecording() { stop(); }

void EyeTrackerRecording::start(const std::string& session_name) {
  const auto replies = probe(settings_);
  for (std::size_t i = 0; i < replies.size(); ++i)
    if (!replies[i].connected)
      throw std::runtime_error(settings_.trackers[i].name + ": " + replies[i].message);
  attempted_ = settings_.trackers;
  std::vector<std::future<Reply>> pending;
  for (const auto& tracker : attempted_)
    pending.push_back(std::async(std::launch::async, [tracker, this, session_name] {
      return request(tracker, "R " + session_name, settings_.timeout_ms);
    }));
  std::string failure;
  for (std::size_t i = 0; i < pending.size(); ++i) {
    const auto& tracker = attempted_[i];
    const auto reply = pending[i].get();
    std::cout << tracker.name << " start: " << reply.message << std::endl;
    if (!reply.connected || (reply.message != "OK" && reply.message != "Recording started."))
      failure += tracker.name + " (" + reply.message + ") ";
  }
  if (!failure.empty()) throw std::runtime_error("Eye tracker did not accept recording command: " + failure);
}

bool EyeTrackerRecording::stop() {
  bool success = true;
  std::vector<std::future<Reply>> pending;
  for (const auto& tracker : attempted_)
    pending.push_back(std::async(std::launch::async, [tracker, this] {
      return request(tracker, "r", settings_.timeout_ms);
    }));
  for (std::size_t i = 0; i < pending.size(); ++i) {
    const auto& tracker = attempted_[i];
    const auto reply = pending[i].get();
    const bool confirmed = reply.connected && (reply.message == "OK" || reply.message == "Recording stopped.");
    (confirmed ? std::cout : std::cerr) << tracker.name << " stop: " << reply.message << std::endl;
    success = success && confirmed;
  }
  attempted_.clear();
  return success;
}
}  // namespace hrsoc
