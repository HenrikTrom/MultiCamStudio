# MultiCam Control Studio ROS2: installation and everyday use

MCS subscribes to ROS 2 Jazzy camera publishers. It provides a browser interface
for checking images, recording ROS bags and synchronized PNGs, and calibrating the camera
setup. Camera acquisition, exposure settings, triggers, and hardware clock
synchronization are managed by your publishers.

## First installation

Use a Linux host with Docker Engine and the `docker compose` command. ROS does
not have to be installed on the host. Your camera publishers must be reachable
on the configured ROS domain and publish `sensor_msgs/msg/Image` with `rgb8`
encoding. An NVIDIA GPU is optional; CPU encoding works with the default Compose
configuration. CPU previews require H.264 MediaSource support; GPU previews use
HEVC/H.265 and require HEVC MediaSource support on the browser/device.

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

1. Open Record and choose a recordings directory inside the data mount.
2. Select topics in the checkbox menu. Configured camera topics are checked by
   default; other discovered ROS topics can also be recorded.
3. Select **Start ROS bag**. Selected messages are saved at their published rates,
   with their original payloads and header timestamps, in MCAP format.
4. Select **Stop recording** and wait for the bag metadata to finalize.

The default host output is `data/recordings/YYYY-MM-DD-HH-mm-ss/`, containing
the `.mcap` bag, `metadata.yaml`, and `session.json`. Names use local 24-hour time
(`TZ=Europe/Berlin` by default), including seconds. An existing same-second
directory is never overwritten; retry in the next second.

**Record frame** saves one lossless PNG per configured camera, independently of
the topic checkboxes, in `data/recordings/frame_YYYY-MM-DD-HH-mm-ss/`. It also
writes `frame_timestamps.jsonl` and `session.json`. Frame capture can run while
a ROS bag is recording.

For synchronized PNG capture, cameras must publish valid RGB8 images of the same
resolution with nonzero, increasing timestamps from a common clock. The recorder
matches headers within `RECORD_SYNC_TOLERANCE_MS` (5 ms by default); it does not
synchronize hardware clocks. A ROS bag preserves messages as received and does
not pair, resample, or synchronize them.

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

Calibration saves the original ROS RGB8 pixel values directly into lossless PNGs
at the source resolution. It does not record videos or extract frames with
FFmpeg, and it does not need a GPU or a working video encoder. The PNG capture
executable also provides Record frame and does not link FFmpeg libraries.
Images are matched using their ROS header timestamps and the configured tolerance.

Each attempt is stored under the mounted data/storage directory:

```text
data/calibration/<session>/
  capture/
    images/cam<serial>-0001.png  # same index is one synchronized camera set
    images/cam<serial>-0002.png
    frame_timestamps.jsonl
    session.json
  settings.json
  logs/
  validation/
```

The GUI checks that all expected PNGs exist before passing `capture/images`
directly to the calibration solver. `MCS_DATA_DIR` selects the host storage root.
Failed or cancelled captures retain earlier complete sets for inspection and do
not publish a calibration result. Existing capture directories are never reused.

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

## Optional GPU encoding

Install a working NVIDIA driver and configure NVIDIA Container Toolkit for Docker
on the host. `nvidia-smi` must work on that host. The selected GPU must support
NVENC HEVC encoding. Docker Compose 2.30 or newer is required for `gpus: all`.

```sh
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml up -d --build --force-recreate
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml exec multicamstudio mcs-check-gpu
```

The GPU override exposes NVIDIA's video driver libraries and explicitly selects
`hevc_nvenc` for previews, replacing the base Compose `STREAMER_ENCODER` CPU
default. An existing `.env` with `STREAMER_ENCODER=libx264` does not prevent GPU
previews. ROS bag and PNG recording require no video encoder.
Plain `docker compose up -d` uses CPU mode;
the GPU filename is not loaded automatically. Use both `-f` arguments on subsequent
`up`/recreate commands, including after `.env` changes.

`mcs-check-gpu` opens NVENC and produces HEVC video from a synthetic image through
the real preview encoding path. It needs no publishers and creates no recording.
A successful `nvidia-smi` or a listing of available FFmpeg encoders alone does not
prove encoding works. The check exits nonzero on failure and does not fall back
to CPU. Inspect its FFmpeg error for missing driver libraries, unsupported drivers
or GPUs, or exhausted encoder resources.

For eight 2048x1536 cameras, stop previews first to free their encoder sessions,
then check that resolution and simultaneous channel count:

```sh
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml exec multicamstudio mcs-check-gpu 2048 1536 8
```

This holds all requested encoder sessions open together and checks each produces
video. It tests initialization and encoding, not sustained ROS/browser throughput.
The encoder selects the HEVC level for the actual dimensions; the browser receives
the matching `hvc1` profile/tier/level/constraints from the MP4 decoder configuration.
HEVC playback support depends on the browser, operating system and decoder.

To inspect the effective configuration before starting:

```sh
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml config
```

With images arriving, `/api/cameras` reports each preview's actual `encoder`.
GPU previews fail explicitly if NVENC cannot open, rather than silently falling
back to CPU. NVENC offloads compression; image reception and RGB
conversion can still use CPU.

`GPU_STREAMER_ENCODER` overrides the preview
choice in GPU mode. The normal Compose file continues to
work without NVIDIA or USB device access.

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
| Preview unsupported by browser | GPU mode needs HEVC/H.265 MediaSource support; CPU mode needs H.264 support. The error reports the selected codec. |
| GPU previews fail with 2048x1536 images | Rebuild with the current source to use HEVC NVENC with automatic level selection. Run the probe at the actual resolution and channel count. |
| NVENC fails or previews have encoder errors | Run `mcs-check-gpu` in GPU mode; check the host driver/toolkit, video capability, GPU support, and available encoder sessions. |

To check the installed runtime artifacts without acquiring cameras:

```sh
docker compose exec multicamstudio mcs-check-runtime
```

Development and detailed technical options are described in
[the ROS 2 development guide](ros2_ws/README.md).
