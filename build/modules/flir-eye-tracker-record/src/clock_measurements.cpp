#include "clock_measurements.h"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <future>
#include <iostream>
#include <locale>
#include <sstream>
#include <stdexcept>

namespace hrsoc {
namespace {
struct Sample {
  Reply reply;
  double pupil = 0;
  double offset = 0;
  bool valid = false;
  bool used = false;
  std::string error;
};

std::vector<Sample> sample_clock(const EyeTracker& tracker, const EyeTrackerSettings& settings,
                               const std::atomic<bool>* cancelled) {
  PupilRemote remote(tracker, settings.timeout_ms);
  std::vector<Sample> samples;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  for (int i = 0; i < settings.clock_measurement_samples; ++i) {
    if ((cancelled && cancelled->load()) || std::chrono::steady_clock::now() >= deadline) break;
    Sample sample;
    sample.reply = remote.request("t");
    if (!sample.reply.connected) {
      sample.error = sample.reply.message;
    } else {
      std::istringstream input(sample.reply.message);
      input.imbue(std::locale::classic());
      if (!(input >> sample.pupil) || !std::isfinite(sample.pupil)) {
        sample.error = "Pupil time is not a finite number";
      } else {
        input >> std::ws;
        if (!input.eof()) sample.error = "Unexpected text after Pupil time";
      }
      if (sample.error.empty()) {
        sample.offset = sample.reply.host_before_ns / 1e9 +
            (sample.reply.host_after_ns - sample.reply.host_before_ns) / 2e9 - sample.pupil;
        sample.valid = std::isfinite(sample.offset);
        if (!sample.valid) sample.error = "Invalid clock offset";
      }
    }
    samples.push_back(sample);
    // One timeout per tracker per burst bounds shutdown and recovery delays.
    if (!sample.valid) break;
  }
  return samples;
}

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;
void string(Writer& writer, const char* key, const std::string& value) {
  writer.Key(key);
  writer.String(value.c_str(), static_cast<rapidjson::SizeType>(value.size()));
}
void common(Writer& writer, const char* type, const char* phase, std::uint64_t batch,
            const EyeTracker& tracker) {
  writer.StartObject();
  string(writer, "record_type", type);
  string(writer, "phase", phase);
  writer.Key("batch_index"); writer.Uint64(batch);
  string(writer, "tracker", tracker.name);
  string(writer, "endpoint", tracker.endpoint);
}
}

ClockMeasurements::ClockMeasurements(EyeTrackerSettings settings, const std::filesystem::path& path)
    : settings_(std::move(settings)), output_(path) {
  if (!output_) throw std::runtime_error("Cannot open " + path.string());
  output_ << "{\"record_type\":\"metadata\",\"schema_version\":1,"
             "\"host_clock\":\"CLOCK_MONOTONIC\",\"host_timestamp_unit\":\"nanoseconds\","
             "\"integer_encoding\":\"decimal strings\",\"pupil_timestamp_unit\":\"seconds\","
             "\"mapping\":\"host_monotonic_s = pupil_time_s + estimated_host_minus_pupil_s\","
             "\"method\":\"host request midpoint; discard slowest 30% of valid samples\","
             "\"burst_budget_ms\":2000,"
             "\"interval_ms\":" << settings_.clock_measurement_interval_ms <<
             ",\"samples_per_burst\":" << settings_.clock_measurement_samples << "}\n";
  output_.flush();
  if (!output_) throw std::runtime_error("Cannot write clock measurement metadata");
}

ClockMeasurements::~ClockMeasurements() {
  try { stop(); }
  catch (const std::exception& error) { std::cerr << "Clock measurements: " << error.what() << '\n'; }
}

void ClockMeasurements::start() {
  if (started_ || closed_) throw std::logic_error("Clock measurements already started or closed");
  started_ = true;
  measure("before");
  if (settings_.trackers.empty()) return;
  worker_ = std::thread([this] {
    try {
      std::unique_lock<std::mutex> lock(mutex_);
      while (!wake_.wait_for(lock, std::chrono::milliseconds(settings_.clock_measurement_interval_ms),
                             [this] { return stopping_.load(); })) {
        lock.unlock();
        measure("during");
        lock.lock();
      }
    } catch (...) {
      std::lock_guard<std::mutex> lock(mutex_);
      error_ = std::current_exception();
    }
  });
}

void ClockMeasurements::check() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (error_) std::rethrow_exception(error_);
}

void ClockMeasurements::stop() {
  if (closed_) return;
  closed_ = true;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  wake_.notify_all();
  if (worker_.joinable()) worker_.join();
  std::exception_ptr final_error;
  try {
    if (started_) measure("after");
    output_.flush();
    if (!output_) throw std::runtime_error("Cannot flush clock_measurements.jsonl");
  } catch (...) { final_error = std::current_exception(); }
  output_.close();
  if (!final_error && output_.fail())
    final_error = std::make_exception_ptr(std::runtime_error("Cannot close clock_measurements.jsonl"));
  check();
  if (final_error) std::rethrow_exception(final_error);
}

void ClockMeasurements::measure(const char* phase) {
  const auto batch = batch_++;
  std::vector<std::future<std::vector<Sample>>> pending;
  for (const auto& tracker : settings_.trackers)
    pending.push_back(std::async(std::launch::async, [this, tracker, phase] {
      return sample_clock(tracker, settings_, std::string(phase) == "during" ? &stopping_ : nullptr);
    }));
  for (std::size_t t = 0; t < pending.size(); ++t) {
    const auto& tracker = settings_.trackers[t];
    auto samples = pending[t].get();
    std::vector<std::size_t> accepted;
    for (std::size_t i = 0; i < samples.size(); ++i)
      if (samples[i].valid) accepted.push_back(i);
    std::sort(accepted.begin(), accepted.end(), [&](std::size_t a, std::size_t b) {
      return samples[a].reply.host_after_ns - samples[a].reply.host_before_ns <
             samples[b].reply.host_after_ns - samples[b].reply.host_before_ns;
    });
    // Round up the retained 70%; never drop the only available valid sample.
    accepted.resize(accepted.size() - accepted.size() * 3 / 10);
    for (auto i : accepted) samples[i].used = true;
    for (std::size_t i = 0; i < samples.size(); ++i) {
      const auto& sample = samples[i];
      rapidjson::StringBuffer buffer;
      Writer writer(buffer);
      common(writer, "measurement", phase, batch, tracker);
      writer.Key("sample_index"); writer.Uint64(i);
      writer.Key("success"); writer.Bool(sample.valid);
      writer.Key("used_in_estimate"); writer.Bool(sample.used);
      if (sample.reply.connected) string(writer, "raw_reply", sample.reply.message);
      if (sample.reply.host_before_ns) {
        string(writer, "host_before_ns", std::to_string(sample.reply.host_before_ns));
        string(writer, "host_after_ns", std::to_string(sample.reply.host_after_ns));
        string(writer, "round_trip_ns", std::to_string(sample.reply.host_after_ns - sample.reply.host_before_ns));
      }
      if (sample.valid) {
        writer.Key("pupil_time_s"); writer.Double(sample.pupil);
        writer.Key("estimated_host_minus_pupil_s"); writer.Double(sample.offset);
      } else {
        string(writer, "error", sample.error);
        std::cerr << "Pupil clock measurement failed for " << tracker.name << ": " << sample.error << '\n';
      }
      writer.EndObject();
      output_ << buffer.GetString() << '\n';
    }
    rapidjson::StringBuffer buffer;
    Writer writer(buffer);
    common(writer, "estimate", phase, batch, tracker);
    writer.Key("success"); writer.Bool(!accepted.empty());
    writer.Key("sample_count"); writer.Uint64(samples.size());
    writer.Key("accepted_sample_count"); writer.Uint64(accepted.size());
    if (!accepted.empty()) {
      double mean = 0, pupil_mean = 0, variance = 0;
      for (auto i : accepted) {
        mean += samples[i].offset / accepted.size();
        pupil_mean += samples[i].pupil / accepted.size();
      }
      for (auto i : accepted) variance += std::pow(samples[i].offset - mean, 2) / accepted.size();
      writer.Key("pupil_time_s"); writer.Double(pupil_mean);
      writer.Key("estimated_host_minus_pupil_s"); writer.Double(mean);
      writer.Key("offset_jitter_s"); writer.Double(std::sqrt(variance));
      const auto& fastest = samples[accepted.front()].reply;
      string(writer, "min_round_trip_ns", std::to_string(fastest.host_after_ns - fastest.host_before_ns));
    }
    writer.EndObject();
    output_ << buffer.GetString() << '\n';
    // JSON Lines stays readable after interruption; persist every completed burst.
    output_.flush();
    if (!output_) throw std::runtime_error("Cannot write clock_measurements.jsonl (check available storage)");
  }
}
}  // namespace hrsoc
