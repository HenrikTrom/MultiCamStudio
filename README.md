# MultiCamStudio

![Overview](/content/output.gif)

MultiCamStudio provides a browser interface for checking FLIR camera feeds, calibrating a multi-camera setup, and recording synchronized videos. It is intended for laboratory recording workflows, including behavioral research.

Read the [installation and researcher instructions](instructions.md) for Spinnaker container setup, launching the GUI, camera checks, calibration, recording, and automatic startup with crontab.

## Important: adapt the camera configuration

Before use, edit [camera settings](cfg/camera_settings_1024x768.json) and [camera calibration settings](cfg/CameraCalibrationSettings.json) for your hardware. Use the actual camera serial numbers in both files. Set `master_serial` to the camera sending the synchronization signal through the trigger cable, and set `master_line` and `slave_line` to match the connected output and input lines. `main_cam_serial` selects the calibration's reference frame and can differ from the trigger master.

When adding cameras, add a full entry to `cams`, add the same serial to calibration `serial_numbers`, update `FLIR_CAMERA_COUNT` in `.env`, and rebuild the container. See [camera configuration instructions](instructions.md#important-adapt-the-camera-and-calibration-settings) for details.

## Important: prepare a rigid calibration board

Print the [calibration pattern](build/modules/multi-camera-calib/content/board_pattern.MCC_Patt1040x720.bmp) at **1040 × 720 mm including the border**, with **80 mm squares**, and glue it to a flat, stiff surface. We used a 10 cm “Pressholzplatte” (pressed-wood board). **A wobbly, bent, or flexible pattern deteriorates calibration accuracy.** See [board preparation instructions](instructions.md#create-the-calibration-board) for printing and mounting checks.

Host command examples use `<path-to-MultiCamStudio>` as a placeholder for your checkout's absolute path. Replace it before running commands; the fixed paths inside the container remain as documented.
