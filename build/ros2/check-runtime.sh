#!/usr/bin/env bash
# Validate installed runtime artifacts. This does not acquire cameras or build code.
set -eo pipefail
source "/opt/ros/${ROS_DISTRO}/setup.bash"
source /opt/mcs/ros2/setup.bash

# ROS core includes CMake as a ROS dependency. Preserve that package, but keep
# native compilers and application build/dependency runners out of production.
for tool in gcc g++ c++ make colcon npm npx; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "Unexpected development tool in runtime: $tool" >&2
    exit 1
  fi
done
for program in camera_tab_ros2_web_streamer recording_tab_ros2_image_recorder calibration_tab_ros2_image_recorder; do
  "/opt/mcs/ros2/lib/ros2_multicam_interface/$program" --help >/dev/null
done
for program in /opt/mcs/ros2/lib/ros2_multicam_interface/*recorder /opt/mcs/calibration/bin/Multi_Camera_Calibration; do
  if ldd "$program" | grep -q 'not found'; then
    echo "Missing shared library for $program" >&2
    exit 1
  fi
done
node --check /opt/mcs/web/server/server.mjs
node --check /opt/mcs/web/server/workflows.mjs
test -s /opt/mcs/web/dist/index.html
test -s /opt/mcs/calibration/source/cfg/CameraCalibrationSettings.schema.json
/opt/mcs/python/bin/python3 - <<'PY'
import cv2
import numpy
import rclpy
from sensor_msgs.msg import Image
assert hasattr(cv2.aruco, 'CharucoDetector')
print('Runtime ready: prebuilt GUI, ROS streamer/recorders, calibration solver and Python validation')
PY
