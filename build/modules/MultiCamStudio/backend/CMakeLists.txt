cmake_minimum_required(VERSION 3.16)
project(fast_flir_web_streamer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)
find_package(PkgConfig REQUIRED)
find_package(fmt CONFIG REQUIRED)
find_package(spdlog REQUIRED)
find_package(cpp_utils CONFIG REQUIRED)
find_package(flirmulticamera CONFIG REQUIRED)

pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET
  libavcodec
  libavformat
  libavutil
  libswscale
)

add_executable(fast_flir_web_streamer
  src/streamer.cpp
)

add_executable(flir_recorder
  src/recorder.cpp
)

# If the exported target in your parent project has a namespace, replace
# flirmulticamera below with that target (for example, flirmulticamera::flirmulticamera).
target_link_libraries(fast_flir_web_streamer PRIVATE
  flirmulticamera
  spdlog::spdlog
  PkgConfig::FFMPEG
  Threads::Threads
)

target_compile_options(fast_flir_web_streamer PRIVATE
  -Wall -Wextra -Wpedantic
)

target_link_libraries(flir_recorder PRIVATE
  flirmulticamera
  spdlog::spdlog
  Threads::Threads
)

target_compile_options(flir_recorder PRIVATE
  -Wall -Wextra -Wpedantic
)
