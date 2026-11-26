#!/usr/bin/env bash
# Compilation and dependency installation belong exclusively to this dev entrypoint.
set -eo pipefail
source "/opt/ros/${ROS_DISTRO}/setup.bash"

cd /workspaces/ros2_ws
colcon --log-base log/devel build \
  --build-base build/devel --install-base install/devel --merge-install \
  --packages-select ros2_multicam_interface \
  --cmake-args -DCMAKE_BUILD_TYPE=RelWithDebInfo
source install/devel/setup.bash

export ROS_STREAMER_EXECUTABLE="$PWD/install/devel/lib/ros2_multicam_interface/camera_tab_ros2_web_streamer"
export ROS_RECORDER_EXECUTABLE="$PWD/install/devel/lib/ros2_multicam_interface/recording_tab_ros2_image_recorder"
export ROS_CALIBRATION_RECORDER_EXECUTABLE="$PWD/install/devel/lib/ros2_multicam_interface/calibration_tab_ros2_image_recorder"
export ROS_CALIBRATION_CHECK_SCRIPT="$PWD/install/devel/lib/ros2_multicam_interface/check_calibration.py"
export MCS_API_PORT="${MCS_API_PORT:-5175}"
if [[ "${PORT:-5173}" == "$MCS_API_PORT" || "${STREAMER_PORT:-8080}" == "$MCS_API_PORT" ]]; then
  echo 'PORT, MCS_API_PORT and STREAMER_PORT must be different.' >&2
  exit 1
fi

cd /workspaces/mcs-web
npm ci --no-audit --no-fund

backend_pid=
frontend_pid=
cleanup() {
  trap - EXIT INT TERM
  [[ -z "$frontend_pid" ]] || kill -TERM "$frontend_pid" 2>/dev/null || true
  [[ -z "$backend_pid" ]] || kill -TERM "$backend_pid" 2>/dev/null || true
  [[ -z "$frontend_pid" ]] || wait "$frontend_pid" 2>/dev/null || true
  [[ -z "$backend_pid" ]] || wait "$backend_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
PORT="$MCS_API_PORT" node server/server.mjs &
backend_pid=$!
node node_modules/vite/bin/vite.js --host 0.0.0.0 --port "${PORT:-5173}" --strictPort &
frontend_pid=$!
set +e
wait -n "$backend_pid" "$frontend_pid"
result=$?
set -e
exit "$result"
