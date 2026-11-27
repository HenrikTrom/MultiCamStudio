cmake_minimum_required(VERSION 3.16)
project(fast_flir_web_streamer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
include(CTest)

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
