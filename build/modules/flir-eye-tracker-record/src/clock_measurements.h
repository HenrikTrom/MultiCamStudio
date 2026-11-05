#pragma once

#include "eye_trackers.h"
#include <atomic>
#include <condition_variable>
#include <exception>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <thread>

namespace hrsoc {
// Read Pupil clocks without resetting them. The capture thread only calls check().
class ClockMeasurements {
 public:
  ClockMeasurements(EyeTrackerSettings settings, const std::filesystem::path& path);
  ~ClockMeasurements();
  void start();  // Initial burst, then periodic background measurements.
  void stop();   // Join the worker, take the final burst and flush the log.
  void check();  // Propagate background/storage failures to the capture loop.
 private:
  void measure(const char* phase);
  EyeTrackerSettings settings_;
  std::ofstream output_;
  std::thread worker_;
  std::mutex mutex_;
  std::condition_variable wake_;
  std::exception_ptr error_;
  std::atomic<bool> stopping_{false};
  bool started_ = false;
  bool closed_ = false;
  std::uint64_t batch_ = 0;
};
}  // namespace hrsoc
