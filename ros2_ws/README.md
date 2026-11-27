# MultiCamStudio ROS 2 setup

The default container launches the MCS web GUI and the ROS 2 Jazzy image preview
service together. The Streamer tab shows live images and topic statistics. The Record tab saves
ROS bags and synchronized PNGs, and Calibration provides capture, solving, and live ROS
validation. `multi-camera-calib` is unchanged.

## Build and launch

From the repository root on the Linux ROS host:

```sh
docker compose build
docker compose up -d
```

Open **http://localhost:5173** (or the Docker host's address). `PORT` in `.env`
controls the GUI port. The internal `STREAMER_PORT` defaults to 8080 and must be
different from `PORT`; browsers use the GUI port for both the app and streams.
The preview service starts automatically. Its Start/Stop controls leave the GUI
running. Unexpected preview-process exits trigger automatic restart.

After code changes, use `docker compose up -d --build`. After configuration
changes, use `docker compose up -d --force-recreate`. Check the service with
`docker compose ps` and `docker compose logs -f`; stop with `docker compose down`.

The runtime image contains the compiled C++ executable, prebuilt React assets,
a Node server using only built-in modules, and the prebuilt calibration tool. Startup installs no dependencies
and performs no compilation. The final runtime stage starts the GUI even when
camera publishers are absent or the preview process fails to initialize.

## Camera connection settings

Camera publishers run separately. MCS subscribes; it does not configure, trigger,
or start cameras. Camera IDs and order come from
`cfg/CameraCalibrationSettings.json` → `serial_numbers`. ROS connections are set
in `.env`:

```dotenv
PORT=5173
ROS_DOMAIN_ID=97
RMW_IMPLEMENTATION=rmw_fastrtps_cpp
ROS_AUTOMATIC_DISCOVERY_RANGE=SUBNET
FASTDDS_BUILTIN_TRANSPORTS=UDPv4
ROS_IMAGE_TOPIC_TEMPLATE=/grasshopper/camera_{serial}/image_raw
STREAMER_PORT=8080
STREAMER_BITRATE_MBIT=4
STREAMER_ENCODER=libx264
```

The topic template must contain exactly one `{serial}` placeholder. For serial
`19037266`, this template subscribes to
`/grasshopper/camera_19037266/image_raw`. Another valid template is
`/images/camera_{serial}`. A ROS path component cannot start with a numeric serial.

The configuration is mounted read-only. The GUI's Settings dialog shows the
current domain, topic template, preview limit, and IDs. Edit `.env` or the JSON
file on the host and recreate the container to apply changes. Legacy direct
camera and eye-tracker settings are not used.

Compose uses host networking and host IPC. Fast DDS defaults to UDP so publishers
with private container IPC can deliver images. When all participants share host
IPC and compatible user permissions, `FASTDDS_BUILTIN_TRANSPORTS=DEFAULT` enables
shared memory. See the [Fast DDS Docker requirements](https://fast-dds.docs.eprosima.com/en/v2.14.7/docker/shm_docker.html).
The ROS domain must match the publishers. `rmw_cyclonedds_cpp` is also installed.

## Streamer tab and statistics

Each configured camera has a tile showing its ROS topic, resolution, publisher
count, measured **Input Hz**, and measured **Preview Hz**. The header counts topics
actually delivering images, rather than configured IDs or advertised publishers.

Rates use a sliding two-second window and the steady clock. A topic becomes
offline after two seconds without an image; its displayed rates become zero.
An advertised publisher without received images is not counted online. Invalid
images still count as topic traffic, but show an image-format error and cannot
produce a preview. A missing topic appears automatically when images arrive;
preview connections retry after failures. The 30 Hz value is the preview ceiling,
not an assumed source frequency. Preview Hz measures encoded output, rather than
browser rendering performance.

The existing focus-peaking controls, histograms, grid layouts, enlargement, and
light/dark themes remain available. Frozen/offline images are covered with their
connection status instead of being labeled LIVE.

## Image and transport contract

- Input: `sensor_msgs/msg/Image`, **`encoding: rgb8`**, with positive even dimensions
  for YUV420 video. Padded rows are supported through `Image.step`.
- Best-effort, volatile, depth-one subscriptions accept both best-effort and
  reliable publishers. Other encodings and malformed buffers are rejected.
- Each camera retains one latest input and one latest encoded fragment, with a
  30 Hz encoding ceiling. Slower publishers are not duplicated or accelerated.
- Dimensions are learned from the first valid image. Restart the preview service
  after a resolution change. Recording and calibration validate one shared resolution across all cameras.
- Browser transport is HEVC Main (`hevc_nvenc`) or CPU H.264 High (`libx264`) in
  fragmented MP4 with the reference streamer's 13-byte record framing. The encoder
  selects the level for the actual dimensions. HEVC uses an `hvc1` sample entry;
  the browser codec string includes the profile/tier/level/constraints from `hvcC`.
  H.264 uses `avc1` with profile/level from the SPS. The browser/device must support
  MediaSource playback of the selected codec; HEVC availability varies by platform.
- The default `STREAMER_ENCODER=libx264` uses CPU encoding and skips GPU probes.
  `STREAMER_ENCODER=auto` is also available to try NVENC with CPU fallback.

For NVIDIA acceleration with NVIDIA Container Toolkit installed:

```sh
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml up -d --build --force-recreate
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml exec multicamstudio mcs-check-gpu
```

The GPU override exposes the video driver and selects `hevc_nvenc` explicitly for
previews, overriding the base configuration's CPU preview default.
It requires Docker Compose >= 2.30, a working host NVIDIA driver, NVIDIA Container
Toolkit, and a GPU supporting NVENC HEVC. Always keep both Compose files when
recreating the service. Use `GPU_STREAMER_ENCODER` to override the preview choice
in GPU mode. ROS bag and PNG recording require no video encoder.
CPU throughput depends on camera count and resolution.

`mcs-check-gpu` encodes synthetic 1280x720 RGB through the preview's real HEVC/fMP4
path without initializing ROS discovery or accessing cameras. The native command
is `camera_tab_ros2_web_streamer --check-encoder [hevc_nvenc|libx264|auto] [width height channels]`, with
`hevc_nvenc` as the probe default. Explicit `hevc_nvenc` never falls back to CPU;
only `auto` permits fallback. No FFmpeg CLI or compiler is needed in production.
After stopping active previews, use `mcs-check-gpu 2048 1536 8` to test eight
simultaneous sessions at that resolution. The check reports the actual encoder
and browser codec for each channel. It does not benchmark sustained frame rate.
The regression script `test/test_encoder.py` checks 2048x1536 with CPU encoding;
use `--encoder hevc_nvenc --channels 8` in a GPU-enabled test container to check
concurrent NVENC sessions. `STREAMER_EXECUTABLE` can select a freshly built binary.

## Recording

The Record tab provides a checkbox menu of discovered ROS topics. Configured
camera topics are selected by default, including cameras not currently online.
Choose a directory inside the mounted data folder and select **Start ROS bag**.
The `record_rosbag.py` supervisor runs native `ros2 bag record` with the selected
topics and MCAP storage. Image payloads and header timestamps are preserved at
published rates; messages are not matched, resized, or video encoded.

Default output is `data/recordings/YYYY-MM-DD-HH-mm-ss/`, containing an `.mcap`
file, rosbag2 `metadata.yaml`, and a completion `session.json` with topic names,
message count, and start/finish times. The name uses local 24-hour time; `TZ`
defaults to `Europe/Berlin`. Seconds prevent minute-level collisions. An existing
same-second directory is rejected, never overwritten. Stop recording before
shutting down the host. Stop and Docker shutdown signal the native recorder to
flush data and finalize metadata; an interrupted or failed bag is reported as an
error.

**Record frame** runs the PNG recorder in one-set mode. It saves every configured
camera, independently of the topic checkboxes, in
`data/recordings/frame_YYYY-MM-DD-HH-mm-ss/`:

- `cam<serial>.png`: original RGB8 pixel values as lossless PNGs.
- `frame_timestamps.jsonl`: batch timestamp, each camera's original timestamp in
  nanoseconds, and the maximum spread. Preserve 64-bit integer precision.
- `session.json`: resolution, source cameras, synchronization statistics, and
  completion status.

PNG matching uses `sensor_msgs/Image.header.stamp`. Every camera must publish
nonzero timestamps from a common, increasing clock. Maximum spread defaults to
**5 ms** (`RECORD_SYNC_TOLERANCE_MS`). This does not trigger cameras or synchronize
hardware clocks. Unmatched messages are dropped rather than duplicated. The
matching queue holds at most 32 images per camera. Valid RGB8 images must have
positive dimensions and share one resolution; padded rows and odd dimensions
are supported. Missing cameras, invalid images, clock resets, resolution changes,
or prolonged loss of matched sets fail the capture. `RECORD_START_TIMEOUT_SEC`
defaults to 15 and `RECORD_STALL_TIMEOUT_SEC` to 5.

Frame capture can run while a ROS bag is recording. Calibration excludes both
operations. Previews can remain running throughout. The former video recording
executable and its encoder/frame-rate settings have been removed.

## Calibration workflow

1. Make the rigid ChArUco board visible to every camera. Select **Run calibration**
   and move the board through varied positions and angles during capture.
2. The dedicated `calibration_tab_ros2_image_recorder` checks RGB8 images and equal
   resolutions, matches header timestamps, and writes synchronized lossless PNG
   sets directly from the topic messages. No video is recorded or unpacked, and
   the executable has no FFmpeg/video-encoder dependency. Defaults are 30 sets at
   500 ms spacing (about 15 seconds), controlled by `CALIBRATION_CAPTURE_FRAMES`
   and `CALIBRATION_CAPTURE_INTERVAL_MS`. Use 3–999 sets.
3. The original native `Multi_Camera_Calibration` runs on those images and a copy
   of the settings. No code in the `multi-camera-calib` submodule is modified.
4. Keep the board visible for live validation. `check_calibration.py` receives a
   new synchronized ROS image set, detects shared ChArUco corners, undistorts
   observations, triangulates them, and reprojects through each camera's full
   pose and lens distortion. At least four shared corners in all cameras are
   required. The preview marks observed corners green and reprojections red.
5. A candidate is published only after validation passes. The default mean
   reprojection limit is **5 px**, configurable through
   `CALIBRATION_MAX_REPROJECTION_ERROR_PX`. The GUI shows the measured error.

Every attempt has a new `data/calibration/<session>/` directory containing its
settings snapshot, capture images/timestamps, candidate calibration, validation
report, and annotated images. Captures live in `capture/images/`. PNG names are exactly
`cam<serial>-0001.png`, etc., as expected by the unchanged calibrator. The capture
executable also implements the one-shot Record frame action via `--frame`.
PNG pixel values are preserved exactly (RGB/BGR channel ordering is adapted for
OpenCV's writer), with no resizing, white balancing, or lossy compression. Padded
ROS rows and odd image dimensions are supported for PNGs. A failed set is removed
without deleting previous complete sets. `session.json` identifies `capture_format:
"png"`, the image directory, resolution, frame count and source camera IDs.

The GUI checks the capture manifest and every expected PNG before invoking
`Multi_Camera_Calibration <capture>/images <settings-snapshot>`. Missing or invalid
PNG files stop the capture stage; there is no FFmpeg extraction stage.

For standalone capture, in a container shell with the ROS environment sourced:

```sh
/opt/mcs/ros2/lib/ros2_multicam_interface/calibration_tab_ros2_image_recorder \
  /home/docker/workspace/cfg/CameraCalibrationSettings.json \
  /home/docker/workspace/data/calibration/manual-capture
```

Omit the output argument to use `CALIBRATION_OUTPUT_DIR`, or a unique new directory
under `${CALIBRATION_DATA}/calibration/` if it is unset. The capture count/interval
use `CALIBRATION_CAPTURE_FRAMES` and `CALIBRATION_CAPTURE_INTERVAL_MS`. The older backend `record.sh`
and `calibrate.sh` entry points now invoke ROS PNG capture and solve directly from
its `images` directory as well. They accept an explicit capture directory or use
`CALIBRATION_OUTPUT_DIR` (default `${CALIBRATION_DATA}/calib_images`). Use a new
directory on every capture; no stored images or videos are deleted automatically.

Successful results are atomically copied to the configuration's `savedir` as
`Calibration<width>x<height>.json`. That directory must be inside the mounted data
folder (default `data/logs`). Existing results are backed up under `archive/`
before replacement. `data/calibration/latest.json` identifies the published
candidate and latest validation preview. Failed attempts retain their session
artifacts and leave the published calibration intact.

**Quick validation** checks the published calibration using new ROS images,
without recapturing a dataset or solving again. Existing legacy
`data/logs/Calibration<width>x<height>.json` files are also recognized. Calibration
status and logs survive navigation between tabs. **Cancel calibration** stops
the current process without publishing an incomplete result. The 3D view and
Copy calibration actions use the latest published result.

The validation script can also run directly inside the container:

```sh
/opt/mcs/python/bin/python3 \
  /opt/mcs/ros2/lib/ros2_multicam_interface/check_calibration.py \
  "$CAMERA_CALIBRATION_FILE" /tmp/validation \
  --calibration-file /home/docker/workspace/data/logs/Calibration1024x768.json
```

## APIs on the GUI port

| Endpoint | Behavior |
| --- | --- |
| `GET /` | MCS React GUI |
| `GET /healthz` | GUI health and preview-service availability |
| `GET /api/cameras` | Configured/online/preview counts and per-camera statistics |
| `GET /api/cameras/<index>/stream` | Framed HEVC or H.264/fMP4; 503 before encoder readiness |
| `GET /local-api/camera-stream/status?after=<log-id>` | Preview-process status and bounded logs |
| `POST /local-api/camera-stream/start` | Start preview service |
| `POST /local-api/camera-stream/stop` | Stop preview service without stopping GUI |
| `GET /local-api/config` | Read-only ROS and calibration configuration |
| `GET /local-api/recorder/config` | Discovered topics, camera defaults, storage, timestamp/time zone |
| `GET /local-api/recorder/status?after=<log-id>` | Recording state, progress, errors, logs |
| `POST /local-api/recorder/start` | Start an MCAP ROS bag: `{saveDirectory, topics}`; omitted topics default to configured cameras |
| `POST /local-api/recorder/stop` | Finalize and stop the ROS bag |
| `POST /local-api/recorder/frame` | Save one synchronized PNG set: `{saveDirectory}` |
| `POST /local-api/calibration/run` | Start capture → calibration → validation |
| `POST /local-api/calibration/validate` | Validate the latest calibration with ROS images |
| `POST /local-api/calibration/cancel` | Cancel the current calibration attempt |
| `GET /local-api/calibration/status?after=<log-id>` | Stages, progress, result, logs |
| `GET /local-api/calibration/latest-json` | Latest published camera parameters |
| `GET /local-api/calibration/result` | Latest validation preview |

Camera metadata includes `online`, `preview_active`, `input_fps`, `stream_fps`,
`publisher_count`, `received_frames`, `encoded_frames`, `invalid_frames`, and
`last_image_age_ms`. `ready` means encoder initialization; `online` means recent
image traffic. `fps: 30` remains the advertised preview limit for compatibility.

## Production and development images

| Image target | Purpose | Startup |
| --- | --- | --- |
| `runtime` (default Compose) | Installed ROS executables, calibration solver, Python validation, prebuilt React GUI, Node API | Sources ROS and executes the server; no dependency installation or application builds |
| `devel` (explicit override) | Runtime dependencies, GCC/CMake/colcon/npm, source workspaces, Vite | Incremental ROS build, locked frontend dependency installation, API and hot-reload GUI |

The production stage uses `ros:jazzy-ros-core-noble`. Build stages use the
compiler-equipped ROS base image. The runtime has no GCC, make, colcon, npm, or
frontend `node_modules`; ROS core retains its packaged CMake dependency. C++
source/workspaces are not copied or mounted into the production image. The
Python dependencies and all application binaries are installed during image
construction. `mcs-check-runtime` checks their presence, shared libraries, imports,
and compiler/build-runner separation as part of the image build.

Only configuration and data directories are mounted in production. Their host
locations can be changed through `MCS_CONFIG_DIR` and `MCS_DATA_DIR`. Compose
requires those directories to exist and never silently creates root-owned bind
paths. Runtime data ownership follows the `.env` UID/GID settings. `.env.example`
contains only the current ROS settings; obsolete direct-camera variables are not
used. The packaged configuration also allows the image to launch without a
source checkout when run directly with Docker.

Normal use remains:

```sh
docker compose build
docker compose up -d
```

`pull_policy: never` uses the locally built or loaded image. A built image starts
without dependency downloads, and the GUI stays available while topics are
offline. After loading a transferred image, `docker compose up -d --no-build`
explicitly disables image building too.

## Development

Stop production before using its default ports. Then use the explicit override:

```sh
docker compose down
docker compose -f docker-compose.yaml -f docker-compose.devel.yaml up -d --build
```

Open the GUI on the usual **http://localhost:5173**. The development entrypoint
builds the ROS package, installs frontend dependencies from the lockfile, and
starts the API plus Vite. It does not require shell commands inside the container.
Frontend changes reload automatically. To rebuild C++ or restart the Node API
after source changes:

```sh
docker compose -f docker-compose.yaml -f docker-compose.devel.yaml restart
```

The ROS workspace is mounted at `/workspaces/ros2_ws`; frontend/API source is
mounted at `/workspaces/mcs-web`. Development build products use separate
`build/devel`, `install/devel`, and `log/devel` paths, preserving other local ROS
build layouts. `node_modules`, frontend `dist`, and generated ROS directories are
ignored by Git and excluded from Docker's source context.

The development GUI uses `PORT` (5173); its API uses `MCS_API_PORT` (5175), and the
ROS streamer uses `STREAMER_PORT` (8080). Vite proxies API/health requests, so
browsers still use one GUI origin. If running production and development
side-by-side, give all three ports distinct unused values and use a separate
Compose project name.

For a development shell without triggering the entrypoint's automatic build:

```sh
docker compose -f docker-compose.yaml -f docker-compose.devel.yaml run --rm \
  --entrypoint /ros_entrypoint.sh multicamstudio bash
```

The shared development image already contains the unmodified calibration binary,
OpenCV headers/libraries, Python validation dependencies, and native build tools.
For manual native work, source Jazzy and use colcon; installed scripts and
executables live in `install/devel/lib/ros2_multicam_interface` for the automated
merged install. The compatibility `build/modules/MultiCamStudio/build_install.sh`
and `start.sh` now invoke the production Docker build and Compose launch.

To return to the prebuilt production image:

```sh
docker compose -f docker-compose.yaml -f docker-compose.devel.yaml down
docker compose up -d
```

## Tests

Synthetic ROS images verify rates, input validation, real HEVC/H.264 decoding, padded
RGB rows, publisher-vs-image liveness, offline timeouts, and recovery:

```sh
docker build -f build/Dockerfile --target builder -t mcs-ros2-test:jazzy .
docker run --rm -e ROS_DOMAIN_ID=123 \
  -v "$PWD/ros2_ws/src/ros2_multicam_interface/test:/tests:ro" \
  mcs-ros2-test:jazzy python3 /tests/test_streamer.py
```

Production web-server tests cover static assets, stream proxying, configuration,
preview Stop/Start, and crash recovery:

```sh
docker build -f build/Dockerfile --target frontend-builder -t mcs-web-test .
docker run --rm mcs-web-test npm test
```

`frontend/tests/browser-smoke.mjs` runs with Playwright 1.56.1 and Google Chrome
installed (the default browser channel is `chrome`) in a separate test environment. It checks real video decoding,
measured rates, missing-feed recovery, Settings, and preview Stop/Start. Set
`BASE_URL` to the running GUI and provide a writable `/artifacts` directory for
the screenshot. These browser tests require camera publishers with valid images.

### Recording and calibration regression tests

These tests use synthetic ROS publishers and temporary data directories; they
leave physical camera control and existing calibration outputs untouched:

```sh
docker run --rm -e ROS_DOMAIN_ID=125 \
  -v "$PWD/ros2_ws/src/ros2_multicam_interface/test:/tests:ro" \
  mcs-ros2:jazzy /opt/mcs/python/bin/python3 /tests/test_rosbag.py

docker run --rm -e ROS_DOMAIN_ID=126 \
  -v "$PWD/ros2_ws/src/ros2_multicam_interface/test:/tests:ro" \
  mcs-ros2:jazzy /opt/mcs/python/bin/python3 /tests/test_recorder.py

docker run --rm \
  -v "$PWD/ros2_ws/src/ros2_multicam_interface/test:/tests:ro" \
  mcs-ros2:jazzy /opt/mcs/python/bin/python3 /tests/test_calibration_math.py

docker run --rm -e ROS_DOMAIN_ID=127 \
  -v "$PWD/ros2_ws/src/ros2_multicam_interface/test:/tests:ro" \
  mcs-ros2:jazzy /opt/mcs/python/bin/python3 /tests/test_calibration_pipeline.py
```

The last test exercises the actual native solver and live ROS validation end to
end, including quick validation, resolution rejection, publication preservation,
and HTTP ROS bag controls with simultaneous PNG frame capture. The Node test suite also covers cancellation,
mutual exclusion, archival, and process failure. `tests/browser-stage3.mjs` checks
branding, real Record controls, and Calibration controls with Chrome. It creates
a short, timestamped verification bag and PNG frame set under `data/test/ros2-stage3-verification`.

### Production cold-start verification

Build the default image, then run this test without any network interface or
application source mount (only the test runner is mounted):

```sh
docker run --rm --network none \
  -v "$PWD/ros2_ws/src/ros2_multicam_interface/test:/tests:ro" \
  mcs-ros2:jazzy /opt/mcs/python/bin/python3 /tests/test_runtime.py
```

It checks runtime artifacts, absence of native compilers/application build
runners, two consecutive offline GUI starts, preview Stop/Start, graceful
shutdown, and unchanged binary timestamps. The production image also runs
`mcs-check-runtime` during construction; it can be rerun with
`docker compose exec multicamstudio mcs-check-runtime`.
