#!/usr/bin/env bash
set -eo pipefail
# These compatibility entry points use ROS image capture, never video extraction.
if [[ -f "/opt/ros/${ROS_DISTRO:-jazzy}/setup.bash" ]]; then
  source "/opt/ros/${ROS_DISTRO:-jazzy}/setup.bash"
fi
if [[ -f /opt/mcs/ros2/setup.bash ]]; then source /opt/mcs/ros2/setup.bash; fi
settings="${CAMERA_CALIBRATION_FILE:-/home/docker/workspace/cfg/CameraCalibrationSettings.json}"
storage="${CALIBRATION_DATA:-/home/docker/workspace/data}"

if (( $# > 1 )); then echo 'Usage: validate.sh [new-validation-directory]' >&2; exit 2; fi
output="${1:-${CALIBRATION_VALIDATION_DIR:-$storage/test}}"
validator="${ROS_CALIBRATION_CHECK_SCRIPT:-/opt/mcs/ros2/lib/ros2_multicam_interface/check_calibration.py}"
python="${MCS_PYTHON_EXECUTABLE:-/opt/mcs/python/bin/python3}"
exec "$python" "$validator" "$settings" "$output"
