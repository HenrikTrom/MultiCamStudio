#!/bin/bash


calib_dir=/opt/modules/multi-camera-calib

# compute transform
$calib_dir/build/Multi_Camera_Calibration \
    $CALIBRATION_DATA/calib_images \ 
    $CAMERA_CALIBRATION_FILE

