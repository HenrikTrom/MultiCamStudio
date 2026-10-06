# MultiCamStudio: installation and researcher instructions

This guide describes the code in this repository. Hardware-dependent steps need to be checked on your laboratory computer before participant recording. The first installation is best done with your laboratory's technical support; everyday use is through a web browser.

## 1. What the application does

MultiCamStudio connects to compatible FLIR cameras and offers three pages:

| Page | Purpose |
| --- | --- |
| **Camera Check** | View the cameras and check framing, lighting, and focus. |
| **Calibration** | Record a calibration board, calculate camera geometry, and check the result. |
| **Record** | Save synchronized camera videos in a named session folder. |

**Synchronization** means the cameras are configured to capture corresponding frames together, using a master camera and trigger connections. Your technician must verify the wiring and settings. **Calibration** describes the lenses and relative camera positions so that another analysis tool can relate views or reconstruct positions in three dimensions. This application records and calibrates; it does not perform psychological scoring or behavioral analysis.

The **GUI** (graphical user interface) is the browser window containing these controls. **Spinnaker** is the manufacturer's software for communicating with the cameras. A **container** is the packaged software environment in which the application runs; Docker manages it.

## 2. Prepare the laboratory computer

The supplied configuration uses Linux, USB cameras, an NVIDIA GPU, and Docker's NVIDIA runtime. It is not a ready-made Windows or macOS installation. The current `.env` selects an Ubuntu 20.04 container with CUDA 11.8.0; the container's Ubuntu version is separate from the host computer's operating system.

Before building, arrange the following:

- A working NVIDIA driver, Docker Engine with the `docker compose` command, and the NVIDIA Container Toolkit configured for Docker. Follow the [NVIDIA installation guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) for the host setup.
- Permission for your user account to run Docker commands, including unattended commands at boot. Confirm `docker info` works without an interactive password prompt.
- Compatible FLIR cameras, sufficient USB bandwidth, and synchronization cables. The camera library documents testing with five Grasshopper GS3-U3-32S-4C cameras; other models require verification.
- Host USB permissions and buffer settings appropriate for the cameras. The container installs Spinnaker internally, but its installation does not configure the host's USB permissions or boot settings. Have your technician follow the SDK's Linux hardware instructions and confirm camera access, for example with SpinView, before proceeding.
- A rigid ChArUco calibration board matching the calibration settings. This is a checkerboard with coded markers; an arbitrary checkerboard is not a substitute.
- Enough disk space for the planned sessions, and a browser that can display the video streams.

Close other camera applications before using MultiCamStudio so that they do not compete for camera access.

## 3. Install Spinnaker and build the container

Run commands in a terminal on the host computer. Replace `<path-to-MultiCamStudio>` with your checkout's absolute path before running commands, including in the autostart script and crontab. Keep the fixed `/home/docker/workspace` paths inside the container unchanged unless you also change the container mount and application configuration.

### 3.1. Obtain the repository's dependency modules

From the repository root (the folder containing `docker-compose.yaml`):

```bash
cd "<path-to-MultiCamStudio>"
git submodule update --init --recursive
```

This downloads `cpp_utils`, `flirmulticamera`, and `multi-camera-calib` into `build/modules/`. They are needed during the image build.

### 3.2. Place the Spinnaker installer in the build folder

Download the appropriate Linux AMD64 SDK archive from the manufacturer's [Spinnaker SDK download page](https://www.teledynevisionsolutions.com/products/spinnaker-sdk/). The installer in this repository specifically expects **Spinnaker 2.5.0.80** and this exact filename:

```text
build/spinnaker/spinnaker-2.5.0.80-amd64-pkg.tar.gz
```

For example, if the matching archive is in your Downloads folder:

```bash
cp ~/Downloads/spinnaker-2.5.0.80-amd64-pkg.tar.gz build/spinnaker/
```

Leave the archive compressed. The Dockerfile copies this folder into the image, and `install_spinnaker.sh` extracts it and runs `install_spinnaker_auto.sh` to install the SDK packages. The archive is intentionally ignored by Git.

If that older archive is unavailable, ask your technician to adapt and test the installer and container dependencies for an available SDK. Renaming a different version's archive is insufficient: the extraction directory is also hard-coded.

### 3.3. Adjust the configuration for this computer

Edit the existing `.env` file in the repository root with a text editor. Docker Compose reads it automatically; you do not need to source it in your shell.

| Setting | What to check |
| --- | --- |
| `UID`, `GID` | Match the recording user's values from `id -u` and `id -g` on the host, so saved files are accessible. |
| `FLIR_GID` | Match the group used for host camera access, if applicable; your technician should check the host's Spinnaker setup. |
| `FLIR_CAMERA_COUNT` | Match the number of cameras in your setup. |
| `CUDA_VERSION`, `CUDA_ARCH_BIN` | Match the GPU and compatible driver/toolchain. |
| `CPP_OPTIMIZATIONS` | Check CPU compatibility. The supplied value targets `skylake-avx512`, which is unsuitable for some computers. |
| `TAG1` | Image name suffix; the supplied value produces `my/multicamstudio`. |
| `CAMERA_SETTINGS_FILE` | Normally `/home/docker/workspace/cfg/camera_settings_1024x768.json`. |
| `CAMERA_CALIBRATION_FILE` | Normally `/home/docker/workspace/cfg/CameraCalibrationSettings.json`. |
| `CALIBRATION_DATA` | Normally `/home/docker/workspace/data`. |

The repository is mounted inside the container at `/home/docker/workspace`. Paths in configuration files must use the container's paths, even if the host checkout is elsewhere.

Edit `cfg/camera_settings_1024x768.json` for the actual camera serial numbers, trigger wiring, and recording output folder (`save_dir`). The supplied `save_dir` points at an older workspace layout. For a folder inside this checkout, a suitable example is `/home/docker/workspace/data/recordings`; on the host that becomes `data/recordings/`. Match the serial numbers and physical board dimensions in `cfg/CameraCalibrationSettings.json` as well.

### Important: adapt the camera and calibration settings

These files must describe **your actual cameras**, rather than the example laboratory setup. Stop streaming and recording before editing them. Find each camera's serial number on its label or in SpinView, and keep a list linking each serial to its physical position, such as “front” or “left.” Store serial numbers as quoted strings in JSON.

In [camera settings](cfg/camera_settings_1024x768.json):

- **`cams`** contains one complete object per camera. Set each object's `serial` to a real, connected camera, with no duplicate serials. Its other fields control exposure, gain, black level, and image offsets.
- **`master_serial`** identifies the camera whose output is connected through the trigger cable to the other cameras. It must be one of the serials in `cams`. The software configures this camera to run at the requested frame rate and output an `ExposureActive` signal; the other cameras are configured to trigger from the cable signal.
- **`master_line`** selects the master's physical output line. **`slave_line`** selects the input line receiving that signal on the other cameras. These are camera line names such as `Line2` or `Line3`, not camera numbers. Match them to the actual connector wiring and your camera model. This configuration supplies one shared `slave_line` value for all slave cameras, so wire/configure them consistently.

The supplied camera configuration uses master serial `20174578` and `Line3` for both master and slaves. Some dependency examples use master `Line2` and slave `Line3`; do not copy those values unless they match your wiring. Have your technician verify the pin assignments and electrical connection for your camera model.

In [camera calibration settings](cfg/CameraCalibrationSettings.json):

- **`serial_numbers` must contain exactly the same camera serials as `cams` in the camera settings**, once each. Keeping the same order makes the files easier to compare. Do not leave disconnected cameras in either list.
- **`main_cam_serial`** selects the camera defining the calibration's **reference frame**: the coordinate origin and axes used to express the relative camera positions. It must be in both serial lists. Choose a stable reference camera and document the choice for later 3D analysis. Changing it changes the coordinate frame used to describe the setup.
- The calibration reference camera and trigger master have separate roles. `main_cam_serial` can differ from `master_serial`; in the supplied files they are `19037266` and `20174578`, respectively. Choosing a calibration reference does not change trigger wiring.
- Set the board fields to match the printed board: `pattern_size_first`, `pattern_size_second`, `charuco_params_dict`, `charuco_params_square_size`, and `charuco_params_marker_to_square_ratio`. Set `savedir` to the calibration result folder inside the container.

For example, if `cams` contains serials `19037266`, `19246521`, and `20174578`, the matching calibration fields are:

```json
{
  "serial_numbers": ["19037266", "19246521", "20174578"],
  "main_cam_serial": "19037266"
}
```

This is a partial example: retain the other calibration fields in the actual file.

#### Add a new camera

1. Connect the camera to USB and the synchronization cable. Verify access and identify its serial number in SpinView, then close SpinView before acquisition.
2. In the camera settings file, duplicate an existing complete object within `cams`. Replace its `serial` with the new serial and adjust its supported camera settings. Separate JSON objects with commas; do not add a trailing comma after the last object.
3. Add that same serial to `serial_numbers` in the calibration settings. Keep `main_cam_serial` and `master_serial` valid; change them only if the reference camera or trigger master changes.
4. Update `FLIR_CAMERA_COUNT` in `.env` to the total number of cameras. The supplied `flirmulticamera/build_install.sh` enables a fixed camera count at build time, so **rebuild the image** with `docker compose build multicamstudio`, then recreate the service with `docker compose up -d --force-recreate multicamstudio`. Rebuilding only the application backend at startup does not update that library's camera count.
5. Check USB bandwidth, synchronization, and all actual feeds in **Camera Check**. Run a new calibration and a short recording, then confirm that the new serial has its own playable MP4 file. The Record page's fixed source list does not automatically reflect added cameras.

To remove a camera, remove its object and calibration serial, update the count, and rebuild similarly. Choose a new master or reference camera if the removed camera served either role. The GUI Settings editor changes existing values; use a text editor to add or remove camera entries.

### 3.4. Build the image

```bash
docker compose build multicamstudio
```

This builds OpenCV, installs Spinnaker and the camera/calibration libraries, and installs the tools used by the GUI. Allow time for downloads and compilation. A successful build returns to the terminal without an error.

**Known build issue in this checkout:** `build/Dockerfile` runs `build/setup/user.sh` twice. That script unconditionally creates the `docker` group and user. The second execution can fail because they already exist. Before building, have your technician remove the duplicate user-creation block or make that script safe to run again. These instructions document the issue; they do not change the Dockerfile.

## 4. Launch the container and open the GUI

From the repository root:

```bash
docker compose up -d multicamstudio
docker compose logs -f multicamstudio
```

`-d` leaves the container running in the background. The startup script first rebuilds the application's C++ backend and then installs frontend dependencies and starts the browser server. Wait until the logs show the Vite server is ready. Press **Ctrl+C** to leave the log viewer; the detached container stays running.

Open **http://localhost:5173** in a browser on the laboratory computer. From another computer with permitted network access, use `http://<laboratory-computer-IP>:5173`. The Compose configuration uses the host's network, so no extra port mapping is required on the intended Linux setup. Keep access within the laboratory's approved network: this development server has no login screen.

The GUI uses port **5173**; the camera streamer uses port **8080**. The GUI starts the camera streamer when you click **Start stream**. Opening the page alone does not guarantee that a streamer is running.

Useful host commands:

```bash
docker compose ps
docker compose logs --tail=100 multicamstudio
docker compose stop multicamstudio
docker compose up -d multicamstudio
```

Stop any recording in the GUI before stopping the container. Closing the browser is not a stop command for a running recording.

Every container start currently rebuilds the backend and deletes/reinstalls the frontend's `node_modules` and lock file. Startup can be slow and may need internet access even after the image has been built. If logs report an executable-format error for `startup.sh`, ask your technician to add a Bash shebang (`#!/bin/bash`) to that script or change the Compose command to `/bin/bash /home/docker/workspace/startup.sh`.

## 5. Check the cameras before each session

1. Open **Camera Check** and click **Start stream** if the streamer is stopped.
2. Confirm that an actual image appears for every expected camera. Identify views by camera serial number and compare them with your setup record.
3. Select one, two, or three grid columns to make the views easier to inspect. Click a camera image to enlarge it; click again or press **Esc** to close the enlarged view.
4. Check that the participant's expected movement area is visible, that views are unobstructed, and that lighting is consistent.
5. Adjust the physical lenses for focus. **Focus peaking** highlights image edges as an aid; it does not focus the lens automatically. Toggle it off to inspect the underlying image. Threshold changes which edges are highlighted; opacity and color change their appearance. The histogram shows the distribution of brightness and color in the preview.
6. Review **Camera service** messages for connection or acquisition errors.

Grid layout and focus-peaking controls affect the browser preview, not the recorded camera settings. Displayed status text alone is insufficient evidence of usable footage; check the images and a short test recording.

## 6. Calibrate the setup

Calibrate after changing camera positions, lenses, focus, or image geometry. Keep the calibrated arrangement fixed during your recordings.

### Create the calibration board

1. Obtain the [ChArUco board pattern](build/modules/multi-camera-calib/content/board_pattern.MCC_Patt1040x720.bmp), available after initializing the submodules. This is the pattern matching the supplied calibration configuration.
2. Print it at **1040 × 720 mm (104 × 72 cm), including the white border**. Use a print shop or an image editor such as GIMP to set the physical dimensions. Disable automatic “fit to page” scaling and preserve the proportions.
3. Measure the printed squares with a ruler: each should be **80 × 80 mm**. The patterned area is **11 × 7 squares**, or 880 × 560 mm; the complete print includes the surrounding border. The supplied marker-to-square ratio is **0.75**, corresponding to 60 mm markers, with dictionary ID **0**. Keep these values consistent with `CameraCalibrationSettings.json`. Incorrect dimensions give an incorrect spatial scale.
4. **Glue the pattern to a flat, stiff surface**, smoothing it evenly to avoid bubbles, creases, or loose areas. We used a **10 cm “Pressholzplatte”** (pressed-wood board). The essential requirement is that the full pattern stays flat and rigid while being held and moved.
5. Let the adhesive set and inspect the board for bending, unevenness, or reflections that hide markers. Check the square dimensions again after mounting.

**A wobbly or flexible pattern will deteriorate calibration accuracy.** The calibration assumes the corners lie on one flat board with fixed spacing. If the pattern bends or moves relative to its backing during capture, that assumption fails and camera geometry can be estimated incorrectly. Use a rigid backing rather than holding an unmounted paper print, and replace a warped board before calibration.

If you print at a different size, measure the actual square size and update `charuco_params_square_size` in millimeters. Keep the square counts, marker ratio, and dictionary matched to the pattern; record the dimensions used with your calibration results.

### Run the workflow

1. Finish and stop any participant recording first. **Run calibration** and **Quick validation** stop the recorder and camera streamer to release the cameras.
2. Open **Calibration**. Click the guide animation to enlarge it if useful.
3. Place the board where all cameras can see its markers, then click **Run calibration**.
4. Watch **Calibration output** for the countdown. The capture script counts from 10 down to 0, then requests 30 frames at 2 frames per second (approximately 15 seconds of acquisition).
5. During acquisition, move the board smoothly through different positions and angles within the shared viewing area. Keep the markers visible and avoid fast motion that blurs them.
6. Follow the **Capture → Calibrate → Validate** indicators and inspect the output messages. Capture makes images, Calibrate estimates camera parameters, and Validate acquires a fresh view of the board to check the geometry. Keep the board available for that final step.
7. Examine the **Validation preview** and reported mean back-projection error in pixels. Back-projection compares predicted image locations with detected board features. Agree on acceptance criteria with your methods lead; this repository does not define a universal pass threshold.
8. **3D view** displays camera geometry; drag to rotate and scroll to zoom. **Copy JSON** copies the calibration data as text for archiving or use with another tool.
9. Return to **Camera Check** and click **Start stream** when ready to inspect views again.

**Quick validation** skips the calibration-video capture and parameter calculation, but still accesses the cameras to acquire a fresh board image. It requires an existing calibration and a visible board.

An existing preview can appear when opening the page. Its presence does not prove that the current camera arrangement has just passed validation. Check the latest run's messages and save the calibration associated with your session.

### Calibration setup issues to resolve before use

The current checkout contains inconsistent paths and a script formatting issue. Ask your technician to check these before relying on calibration:

- `backend/scripts/record.sh` calls `build/modules/MultiCamStudio/scripts/create_backup.py`, which is absent here. A backup script exists in `build/modules/multi-camera-calib/scripts/`. The capture script also deletes existing calibration MP4 and PNG files in its input/output folders, so archive needed calibration data before another run.
- `overwrite_settings_calib.py` writes calibration videos to `/home/docker/workspace/workspace/multi-camera-calib/data/videos`, while `record.sh` reads `$CALIBRATION_DATA/calib_videos`. These must refer to the same capture output.
- `backend/scripts/calibrate.sh` has a space after the backslash on the image-directory argument line. Correct the line continuation so that the calibration program receives both arguments.
- `validate.sh` writes results beneath `/home/docker/workspace/data/test`, while the GUI expects the preview in `/home/docker/workspace/workspace/multi-camera-calib/test`. Ensure the output folder exists and the GUI reads the actual result.
- **Copy JSON** and **3D view** read the latest calibration JSON from an older workspace path in `frontend/vite.config.ts`; the supplied calibration settings save to `/home/docker/workspace/data/logs`. Align those paths and confirm the intended file is served.

## 7. Record a research session

1. Complete a short test recording and playback check before collecting participant data.
2. Open **Record** and enter a unique **Session name**, for example `P012_visit1_taskA_2026-10-06`. The initial suggestion is a date/time name. Names are limited to 120 characters; characters other than letters, digits, underscores, dots, and hyphens are replaced with underscores.
3. Click **Start recording**. Starting recording stops live preview so the recorder can use the cameras.
4. Check **Recorder output** for `Synchronized recording started` and increasing recorded-frame counts. The timer starts when the recorder process launches, so the timer alone does not confirm that video frames are being saved.
5. Conduct the task. Watch for recorder errors, including incomplete synchronized frame sets being skipped.
6. Click **Stop recording** and wait for completion messages, including `Recording completed successfully`, before shutting down the application.
7. Open the session folder and check that every expected camera has a playable, non-empty video with the expected duration and content. Record any acquisition problems in the session notes.
8. Click **Start stream** on **Camera Check** if you need previews for the next session.

**Current display limitation:** the Record page's source list, “5 streams writing,” readiness labels, 20 FPS source metadata, and “1.8 GB / minute” storage estimate are fixed display values. Actual camera selection, recording frame rate, and output location come from the camera JSON file; the supplied file requests 60 FPS. Use configuration, recorder logs, disk space, and recorded files to verify the session.

### Find the saved videos

Videos are saved as:

```text
<save_dir>/<session-name>/<camera-serial-number>.mp4
```

With `save_dir` set to `/home/docker/workspace/data/recordings`, a host-side example is:

```text
data/recordings/P012_visit1_taskA_2026-10-06/19037266.mp4
```

The output directory is also printed in **Recorder output**. There is one MP4 per configured camera, rather than one combined video. Use a fresh session name to avoid collisions with existing files. Archive the matching camera settings, calibration settings/results, and session notes with the videos so later analysis can identify the setup used.

## 8. Change settings through the GUI

Click **Settings** in the sidebar. Choose **Camera** or **Calibration**, edit values, and click **Validate and save**. This edits the two files in `cfg/`; it does not add or remove fields or camera entries. Changing the number of cameras requires configuration-file editing and may require rebuilding the camera library.

| Camera setting | Plain-language meaning |
| --- | --- |
| `fps` | Requested frames per second; choose it according to the timing needs of your task. |
| `img_width`, `img_height` | Recorded image dimensions in pixels. |
| `exposure_time` | How long the camera collects light; this affects brightness and motion blur. |
| `gain` | Brightness amplification, which can also increase image noise. |
| `save_dir` | Output folder, expressed as a path inside the container. |
| `serial`, `master_serial`, `master_line`, `slave_line` | Camera identities and synchronization wiring; have technical support check them. |

Saving validates the files against JSON schemas. It does not test camera compatibility, synchronization, board measurements, or scientific suitability. Stop acquisition before changing settings, then restart the relevant stream/recording to load them. Recalibrate when changes affect camera geometry. The files edited by Settings are fixed paths in `vite.config.ts`; if your technician changes the environment variables to select other files, make sure the GUI edits those same files.

## 9. Start the container automatically at boot with crontab

Configure this only after manual startup and a test recording work. This starts the service at boot; it does not open a browser or start participant recording. Use the recording user's crontab, and ensure that user can access Docker without a password. Docker and the host cron service must themselves start at boot.

1. Locate Docker with `command -v docker`. The example below assumes `/usr/bin/docker`.
2. Create `autostart-multicamstudio.sh` in your repository root with the following contents. Replace the checkout path and Docker executable path if needed:

```bash
#!/bin/bash
set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
export DISPLAY="${DISPLAY:-}"
cd "<path-to-MultiCamStudio>"

# Allow up to two minutes for the Docker daemon to become available.
for attempt in {1..24}; do
    if /usr/bin/docker info >/dev/null 2>&1; then
        exec /usr/bin/docker compose up -d multicamstudio
    fi
    sleep 5
done
echo "Docker was not ready; MultiCamStudio was not started." >&2
exit 1
```

An empty `DISPLAY` is sufficient for the browser interface; this example does not launch desktop tools such as SpinView. The script uses the already built image and runs Compose from the repository folder so `.env` and the workspace mount resolve correctly.

3. Test the script on the host:

```bash
chmod +x autostart-multicamstudio.sh
./autostart-multicamstudio.sh
```

4. Run `crontab -e` and add this single line, adapting the paths to match your checkout:

```cron
@reboot /bin/bash "<path-to-MultiCamStudio>/autostart-multicamstudio.sh" >> "<path-to-MultiCamStudio>/data/logs/container-autostart.log" 2>&1
```

The log directory must exist and be writable before boot; this checkout includes `data/logs`. Use an absolute path without spaces or have your technician quote it appropriately. Confirm the saved entry with `crontab -l`.

5. At a convenient time with no recording running, reboot the host. After startup, check `data/logs/container-autostart.log`, `docker compose ps`, and `docker compose logs --tail=100 multicamstudio`, then open **http://localhost:5173**. The cron log covers the launch command; application/build output is in the Compose logs.

Cron runs once at boot and does not restart the container after later failures. This Compose file has no restart policy. If startup fails because of GPU readiness, dependency downloads, or compilation, inspect the logs and resolve the cause before relying on unattended startup. Remove the `@reboot` line with `crontab -e` to disable autostart.

## 10. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Image build cannot find Spinnaker | Verify the archive version, exact filename, and placement in `build/spinnaker/`. |
| Build says the `docker` user/group exists | Resolve the duplicate user-creation block described in section 3.4. |
| NVIDIA runtime/GPU error | Ask technical support to check the host driver and Container Toolkit configuration. |
| Browser cannot open the GUI | Check `docker compose ps` and logs; wait for Vite startup and check port 5173 is free. |
| GUI opens but has no camera pictures | Click **Start stream**; inspect Camera service logs, USB access, serial numbers, and competing camera applications. Port 8080 must be available. |
| Recording ends immediately or produces no useful videos | Inspect Recorder output, camera/trigger configuration, codec/GPU support, output-folder permissions, and free disk space. |
| Calibration fails or preview/JSON is missing | Check board visibility and dimensions, then the script/path issues in section 6. |
| Video timing or duration differs from expectations | Compare actual videos with the requested FPS and recorder logs; check skipped-frame warnings and synchronization with your technician. |
| Autostart fails but manual launch works | Check the cron log, absolute paths, Docker permissions, daemon availability, and whether startup needs internet access. |

When requesting help, include the operation you attempted, the camera setup, and the relevant error/log lines. Avoid attaching identifiable participant footage unless your laboratory's approved support process allows it.

## Repository references

These are the implementation sources behind this guide:

- [Container definition](docker-compose.yaml), [image build](build/Dockerfile), [startup script](startup.sh), and [Spinnaker installation script](build/spinnaker/install_spinnaker.sh).
- [Camera configuration](cfg/camera_settings_1024x768.json) and [calibration configuration](cfg/CameraCalibrationSettings.json).
- [GUI and local process control](build/modules/MultiCamStudio/frontend/vite.config.ts), [camera page](build/modules/MultiCamStudio/frontend/src/components/CameraPage.tsx), [calibration page](build/modules/MultiCamStudio/frontend/src/components/CalibrationPage.tsx), and [record page](build/modules/MultiCamStudio/frontend/src/components/RecordPage.tsx).
- [Recorder and output naming](build/modules/MultiCamStudio/backend/src/recorder.cpp) and [calibration scripts](build/modules/MultiCamStudio/backend/scripts/).
- [Camera library documentation](build/modules/flirmulticamera/Readme.md) and [calibration library documentation](build/modules/multi-camera-calib/README.md) (available after initializing submodules).
