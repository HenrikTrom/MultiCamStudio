#!/usr/bin/env bash
set -eo pipefail
# These compatibility entry points use ROS image capture, never video extraction.
if [[ -f "/opt/ros/${ROS_DISTRO:-jazzy}/setup.bash" ]]; then
  source "/opt/ros/${ROS_DISTRO:-jazzy}/setup.bash"
fi
if [[ -f /opt/mcs/ros2/setup.bash ]]; then source /opt/mcs/ros2/setup.bash; fi
settings="${CAMERA_CALIBRATION_FILE:-/home/docker/workspace/cfg/CameraCalibrationSettings.json}"
storage="${CALIBRATION_DATA:-/home/docker/workspace/data}"

if (( $# > 1 )); then echo 'Usage: calibrate.sh [capture-directory-or-image-directory]' >&2; exit 2; fi
images="${1:-${CALIBRATION_OUTPUT_DIR:-$storage/calib_images}}"
if [[ -d "$images/images" ]]; then images="$images/images"; fi
if [[ ! -d "$images" ]]; then echo "Calibration PNG directory not found: $images" >&2; exit 1; fi
solver="${ROS_CALIBRATOR_EXECUTABLE:-/opt/mcs/calibration/bin/Multi_Camera_Calibration}"
# Preserve previous results for users of these manual compatibility scripts.
"${MCS_PYTHON_EXECUTABLE:-/opt/mcs/python/bin/python3}" - "$settings" "$storage" <<'PY'
import json
from pathlib import Path
import shutil
import sys
import uuid

settings = json.loads(Path(sys.argv[1]).read_text())
directory = Path(settings.get('savedir', str(Path(sys.argv[2]) / 'logs')))
for previous in directory.glob('Calibration*x*.json'):
    if previous.is_file():
        archive = directory / 'archive'
        archive.mkdir(exist_ok=True)
        shutil.copy2(previous, archive / (str(uuid.uuid4()) + '-' + previous.name))
PY
exec "$solver" "$images" "$settings"
