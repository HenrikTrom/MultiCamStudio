#!/usr/bin/env bash
set -eo pipefail
# These compatibility entry points use ROS image capture, never video extraction.
if [[ -f "/opt/ros/${ROS_DISTRO:-jazzy}/setup.bash" ]]; then
  source "/opt/ros/${ROS_DISTRO:-jazzy}/setup.bash"
fi
if [[ -f /opt/mcs/ros2/setup.bash ]]; then source /opt/mcs/ros2/setup.bash; fi
settings="${CAMERA_CALIBRATION_FILE:-/home/docker/workspace/cfg/CameraCalibrationSettings.json}"
storage="${CALIBRATION_DATA:-/home/docker/workspace/data}"

if (( $# > 1 )); then echo 'Usage: record.sh [new-capture-directory]' >&2; exit 2; fi
capture="${1:-${CALIBRATION_OUTPUT_DIR:-$storage/calib_images}}"
recorder="${ROS_CALIBRATION_RECORDER_EXECUTABLE:-/opt/mcs/ros2/lib/ros2_multicam_interface/calibration_tab_ros2_image_recorder}"
echo "Saving synchronized ROS topic PNGs to $capture/images"
exec "$recorder" "$settings" "$capture"
