#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

namespace hrsoc {
// Stream JSON without retaining the session in RAM. Finalize on shutdown and
// exception unwinding. Call close() explicitly to check storage failures.
class TimestampLog {
 public:
  explicit TimestampLog(const std::filesystem::path& path) : output_(path) {
    if (!output_) throw std::runtime_error("Cannot open " + path.string());
    output_ << "{\"timestamp_unit\":\"nanoseconds\",\"integer_encoding\":\"decimal strings\",\"frames\":[\n";
    output_.flush();
  }
  ~TimestampLog() {
    if (!close()) std::cerr << "Could not finalize frame_timestamps.json\n";
  }
  void append(const std::string& entry) {
    output_ << (count_ ? ",\n" : "") << entry;
    ++count_;
    if (count_ % 60 == 0) output_.flush();
    if (!output_) throw std::runtime_error("Could not write frame timestamps (check available storage)");
  }
  bool close() {
    if (!output_.is_open()) return true;
    output_ << "\n],\"frame_count\":" << count_ << "}\n";
    output_.flush();
    const bool success = static_cast<bool>(output_);
    output_.close();
    return success;
  }
 private:
  std::ofstream output_;
  std::uint64_t count_ = 0;
};
}  // namespace hrsoc
