# MultiCam Control Studio ROS2: installation and everyday use

MCS subscribes to ROS 2 Jazzy camera publishers. It provides a browser interface
for checking images, recording synchronized videos, and calibrating the camera
setup. Camera acquisition, exposure settings, triggers, and hardware clock
synchronization are managed by your publishers.

## First installation

Use a Linux host with Docker Engine and the `docker compose` command. ROS does
not have to be installed on the host. Your camera publishers must be reachable
on the configured ROS domain and publish `sensor_msgs/msg/Image` with `rgb8`
encoding. An NVIDIA GPU is optional; CPU encoding works with the default Compose
configuration. A browser with H.264 MediaSource support, such as Google Chrome,
is needed for previews.

Clone with the required calibration submodules:

```sh
git clone --recurse-submodules <repository-url>
cd MultiCamStudio
```

For an existing checkout that does not yet have the submodule files:

```sh
git submodule update --init --recursive
```

Copy `.env.example` to `.env` only on a new installation. Keep your existing `.env`
when updating. Set:

- `UID` and `GID` to the output of `id -u` and `id -g`, so recordings belong to
  your account.
- `ROS_DOMAIN_ID` and `ROS_IMAGE_TOPIC_TEMPLATE` to match your publishers.
- `PORT` if the default GUI port 5173 is occupied.

Edit `cfg/CameraCalibrationSettings.json` with the actual camera serial numbers,
reference camera, and board settings. Topic `{serial}` placeholders are expanded
using the IDs in `serial_numbers`; camera count changes need no native rebuild.

The checked-in `cfg` and `data` directories are mounted automatically. To use
other host directories, set `MCS_CONFIG_DIR` and `MCS_DATA_DIR` in `.env`; create
those directories first and place the configuration JSON in the config directory.
The calibration JSON's `savedir` uses the fixed container path
`/home/docker/workspace/data/logs`, including when the host data directory changes.

## Build once and start

```sh
docker compose build
docker compose up -d
```

The first build downloads and compiles the required dependencies in build stages.
Subsequent builds reuse Docker's cache. Normal startup executes installed
binaries and prebuilt GUI assets. It does not use GCC, colcon, npm, or a source
workspace, and it needs no dependency downloads.

Open **http://localhost:5173** or the Docker host's address and configured `PORT`.
The GUI opens on the Streamer tab and the preview service starts automatically.
If publishers are not running yet, the GUI stays available and shows offline
camera topics until images arrive.

Useful commands:

```sh
docker compose ps
docker compose logs -f
docker compose down
```

Closing a browser tab leaves MCS running. Docker's restart policy restarts the
production service after an unexpected exit or host reboot, once Docker is up.
A deliberate `docker compose down` leaves it stopped.

## Check camera images

The Streamer header reports how many configured topics are actually delivering
images. Each tile shows the topic name, resolution, measured input Hz, measured
preview Hz, and publisher count. A publisher without received images is not
counted online. Topics become offline after two seconds without an image.

Preview encoding is limited to 30 Hz; a slower publisher remains slower. Start
and Stop affect the preview service while the GUI remains available. Use the
focus-peaking controls, histograms, layout selector, and enlarged view to check
framing, lighting, and focus.

## Record a session

1. Check that all intended camera topics are online and have the same resolution.
2. Open Record, choose a new session name, a save directory inside the data mount,
   and the desired recording frequency.
3. Select Start recording. Recording starts after a matched image set arrives.
4. Select Stop recording and wait for finalization before shutting down the host.

The default host output is `data/recordings/<session>/`: one MP4 per camera,
`frame_timestamps.jsonl`, and `session.json`. All successful recordings have
matching frame indices and batch presentation times. The source timestamp log
records each camera's actual time and the spread within every saved set.

Publishers must use nonzero, increasing timestamps from a common clock. The
recorder matches timestamps within the configured tolerance (5 ms by default);
it does not synchronize the hardware itself. Unmatched frames are dropped rather
than duplicated. A missing camera, resolution change, invalid image, or clock
reset is reported as an error. Inspect the session status and frame/drop counts
before using a recording for analysis.

## Calibrate and validate

Use the provided [ChArUco pattern](build/modules/multi-camera-calib/content/board_pattern.MCC_Patt1040x720.bmp)
at **1040 × 720 mm including its border**, with **80 mm squares**, if using the
supplied board settings. Mount it flat on a rigid backing; a flexible or bent
board degrades calibration accuracy.

1. Make the board visible in every camera and open Calibration.
2. Select Run calibration. Move the board through different positions and angles
   during capture (30 synchronized sets over about 15 seconds by default).
3. Keep it visible for the final live-image validation. The GUI reports the
   capture, solve, and validation stages and shows the reprojection result.
4. Use Quick validation later to check the latest calibration without solving
   again. The 3D view and Copy calibration controls use the published result.

Capture checks that all images share one resolution. The original
`multi-camera-calib` code is used without modifications. A new calibration is
published only after live validation passes; an existing result is archived
before replacement. Every attempt retains its own images, settings, report, and
candidate under `data/calibration`. Cancellation or a failed check leaves the
published calibration intact.

## Update, restart, or move an installation

After source changes:

```sh
docker compose build
docker compose up -d
```

After `.env` or camera-ID changes:

```sh
docker compose up -d --force-recreate
```

Data and configuration live in host directories, so replacing a container or
rebuilding an image preserves them. Back up those directories as you would other
laboratory data. Stop recordings or calibration jobs before updating the service.

A built production image can also be transferred to another machine:

```sh
docker save mcs-ros2:jazzy -o mcs-ros2-jazzy.tar
# On the destination host, with Compose/config/data directories prepared:
docker load -i mcs-ros2-jazzy.tar
docker compose up -d --no-build
```

The destination needs the Compose file, its `.env`, configuration, and a writable
data directory; application sources are not mounted into the production container.
Use the same CPU architecture for a transferred image.

## Optional GPU previews

With NVIDIA Container Toolkit configured on the host:

```sh
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml up -d
```

This selects NVENC explicitly for previews. Recording uses its independent
`RECORD_ENCODER` setting; its CPU default avoids requiring additional GPU encoder
sessions. The normal Compose file does not require NVIDIA or USB device access.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| GUI unavailable | `docker compose ps` and `docker compose logs`; open the configured `PORT`, usually 5173. |
| Bind directory missing | Create the configured `MCS_CONFIG_DIR`/`MCS_DATA_DIR` before starting. |
| Permission denied saving data | Match `.env` UID/GID to your account and use a data directory that account can write. |
| Topics offline | Confirm publisher domain, topic template, `rgb8` encoding, and ROS network discovery. |
| Publishers visible but images missing | Keep the default UDP transport when publishers use private container IPC. |
| Recorder cannot match frames | Check nonzero acquisition timestamps, their common clock, and synchronization tolerance. |
| Calibration cannot find the board | Keep sufficient common ChArUco corners visible in every view and match the board settings. |
| Preview unsupported by browser | Use a browser with H.264 MediaSource support. |

To check the installed runtime artifacts without acquiring cameras:

```sh
docker compose exec multicamstudio mcs-check-runtime
```

Development and detailed technical options are described in
[the ROS 2 development guide](ros2_ws/README.md).
