#!/bin/bash

set -euo pipefail
echo "Starting recording for calibration in..."
for ((counter = 10; counter >= 0; counter--)); do
    echo "$counter"
    sleep 1
done

calib_dir=/home/docker/workspace/build/modules/multi-camera-calib
mcs_dir=/home/docker/workspace/build/modules/MultiCamStudio

input_dir=$CALIBRATION_DATA/calib_videos
output_dir=$CALIBRATION_DATA/calib_images

# create backup of old calibration
/usr/bin/python3 $calib_dir/scripts/create_backup.py $CALIBRATION_DATA/logs

# ----------------------------------------------------------------
# Comment out if you have your own camera api/synchronized images
# In this case, just place your images in this folder, or add your recording pipeline here
# ----------------------------------------------------------------
# delete old files:
rm -rf $input_dir/*.mp4
rm -rf $output_dir/*.png

# change fps and output dir
/usr/bin/python3 $mcs_dir/backend/scripts/overwrite_settings_calib.py $CAMERA_SETTINGS_FILE $calib_dir/cfg/adapted_settings.json
# record 30 frames
/opt/modules/flirmulticamera/build/record_synchronized_videos $calib_dir/cfg/adapted_settings.json 30


if [ -d "$input_dir" ];
then
    echo "Extracting frames to $output_dir"
else
	echo Error: "$input_dir directory does not exist."
    exit
fi

# Loop through .mp4 files in the directory and extract images
for video_file in "$input_dir"/*.mp4; do
    if [ -f "$video_file" ]; then
        # Extract the filename without extension
        filename=$(basename "$video_file" .mp4)
        
        ffmpeg -hide_banner -i $video_file "$output_dir/cam$filename-%4d.png"
        
        echo "Frames extracted for $video_file"
    fi
    
done
# ----------------------------------------------------------------

echo "Frame extraction complete, running calibration"