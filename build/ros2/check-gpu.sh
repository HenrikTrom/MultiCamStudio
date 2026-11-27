#!/usr/bin/env bash
# A real NVENC encode, not just nvidia-smi or a compiled-in encoder listing.
set -eo pipefail
source "/opt/ros/${ROS_DISTRO}/setup.bash"
source /opt/mcs/ros2/setup.bash
echo 'Testing NVENC with synthetic images (default 1280x720, one channel; optional: width height channels).'
if /opt/mcs/ros2/lib/ros2_multicam_interface/camera_tab_ros2_web_streamer --check-encoder h264_nvenc "$@"; then
  exit 0
fi
echo 'NVENC unavailable. Check the host NVIDIA driver, NVIDIA Container Toolkit, GPU Compose override, video driver capability, and available encoder sessions.' >&2
exit 1
