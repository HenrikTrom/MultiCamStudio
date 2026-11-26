#!/usr/bin/env bash
set -e
source "/opt/ros/${ROS_DISTRO}/setup.bash"
source /opt/mcs/ros2/setup.bash
exec "$@"
