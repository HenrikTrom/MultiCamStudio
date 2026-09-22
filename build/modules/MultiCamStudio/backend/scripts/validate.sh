#!/bin/bash

calib_dir=/home/docker/workspace/workspace/multi-camera-calib

/usr/bin/python3 $calib_dir/scripts/check_transform.py $CAMERA_SETTINGS_FILE