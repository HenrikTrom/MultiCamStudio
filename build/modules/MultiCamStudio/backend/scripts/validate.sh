#!/bin/bash

calib_dir=/home/docker/workspace/build/modules/multi-camera-calib
echo $CAMERA_CALIBRATION_FILE $CAMERA_SETTINGS_FILE
/usr/bin/python3 $calib_dir/scripts/check_transform.py $CAMERA_CALIBRATION_FILE $CAMERA_SETTINGS_FILE /home/docker/workspace/data