#!/bin/bash


calib_dir=/opt/modules/multi-camera-calib
# calib_dir=/home/docker/workspace/build/modules/multi-camera-calib

# compute transform
$calib_dir/build/Multi_Camera_Calibration $CALIBRATION_DATA/calib_images $CAMERA_CALIBRATION_FILE

