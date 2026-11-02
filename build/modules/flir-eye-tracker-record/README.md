# FLIR + eye tracker recording

The **HRSoc Recorder** tab in MultiCamStudio shares the Record tab's session name,
save directory, timer, camera source list, start/stop controls and logging console.
It runs `flir_eye_tracker_recorder`, using `FlirCameraHandler` and `VideoWriter`
from `flirmulticamera`, following `apps/synchronized_videos.cpp`.

## Configure eye trackers

Edit [`cfg/eye_tracker_settings.json`](../../../cfg/eye_tracker_settings.json) in the
repository root. Each item in `eye_trackers` defines a name,
IP address (or hostname) and Pupil Remote port. Add or remove items to change the
number of eye trackers. An empty array enables FLIR-only recording. Duplicate
endpoints are rejected. The defaults use the two addresses in HRSocRecorder's
reference configuration; replace these with your devices' actual addresses.

```json
{
  "timeout_ms": 1000,
  "refresh_interval_ms": 2000,
  "eye_trackers": [
    { "name": "Participant 1", "ip": "192.168.1.10", "port": 50020 },
    { "name": "Participant 2", "ip": "192.168.1.11", "port": 50020 }
  ]
}
```

Enable the Network API / Pupil Remote plugin in Pupil Capture on each eye tracker
computer and allow access from the recording server. The panel automatically
checks `v` and displays connection availability and version/error messages,
including while FLIR recording is stopped. It reloads configuration changes on
the next check. Connection availability does not verify gaze quality or actual
remote recording state.

The recorder sends `R <session-name>` and `r`, checks acknowledgements, and sends
stop to all attempted trackers if a start fails. Requests have bounded timeouts;
trackers are controlled in parallel. Eye tracker recordings stay on their Pupil
Capture computers under the same session name. Set their recording roots in
Pupil Capture, or mount the desired shared storage on those computers.

These commands coordinate recording. FLIR synchronization uses the existing
hardware trigger configuration. Pupil Remote start commands do not synchronize
the eye tracker and FLIR clocks; see the [Pupil Network API documentation](https://docs.pupil-labs.com/core/developer/network-api/)
for timing and clock synchronization guidance. The recorder does not reset Pupil clocks.

## Output

The selected save directory defaults to `save_dir` in the camera settings. Both
recording tabs accept a per-session override. A new subdirectory is created for
the session, and an existing session directory is rejected to avoid overwriting:

```text
<save-directory>/<session-name>/
  <camera-serial>.mp4           # one synchronized video per camera
  frame_timestamps.json
  camera_settings.json          # snapshot of recording configuration
  eye_tracker_settings.json     # snapshot of tracker configuration
```

`frame_timestamps.json` contains one entry per synchronized video frame written,
indexed from zero. Each entry has `host_unix_ns` (the host wall-clock time at
enqueue) and a `cameras` map keyed by serial number. Each camera entry contains:

- `frame_counter`: the library's acquisition counter; gaps can indicate drops.
- `camera_timestamp_ns`: the image's raw FLIR clock timestamp.
- `aligned_monotonic_ns`: the library's `imgTimestamp`, aligned to host monotonic time.
- `host_monotonic_ns`: the callback's `CLOCK_MONOTONIC` timestamp.

All nanosecond timestamps and acquisition counters are decimal **strings** to
preserve 64-bit precision in JavaScript. Clock domains are distinct; Unix time is
not interchangeable with camera or monotonic time. Incomplete synchronized sets
are skipped in both videos and JSON. Metadata streams to disk instead of growing
in memory; the JSON footer is finalized on Stop, SIGINT, SIGTERM, and handled
exceptions. A forced kill or power loss can leave the JSON without its footer.

Both recorder tabs, camera streaming and calibration share the cameras. Starting
a recorder stops the streamer; another recorder or streamer cannot start until
the active recorder exits. Stop waits for encoder and timestamp finalization.

## Build and run

The MultiCamStudio backend CMake build includes this module. The Dockerfile
installs `libzmq3-dev` for its ZeroMQ dependency. From the repository root:

```sh
docker compose build multicamstudio
docker compose up -d --force-recreate multicamstudio
```

For a standalone build in an environment with installed `flirmulticamera`,
`cpp_utils`, Spinnaker, RapidJSON, spdlog and ZeroMQ development packages:

```sh
cmake -S build/modules/flir-eye-tracker-record -B /tmp/hrsoc-build -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/hrsoc-build --parallel
ctest --test-dir /tmp/hrsoc-build --output-on-failure
/tmp/hrsoc-build/flir_eye_tracker_recorder --status cfg/eye_tracker_settings.json
RECORDING_NAME=session-001 RECORDING_SAVE_DIR=/path/to/recordings \
  /tmp/hrsoc-build/flir_eye_tracker_recorder cfg/camera_settings_1024x768.json \
  cfg/eye_tracker_settings.json
```

Camera count must match the library's compiled `FLIR_CAMERA_COUNT`, as with the
existing synchronized recording example. Camera exposure/trigger/encoder
settings continue to come from the existing camera configuration.

`CAMERA_SETTINGS_FILE` and `EYE_TRACKER_SETTINGS_FILE` override configuration paths.
`FLIR_EYE_RECORDER_EXECUTABLE` overrides the executable used by the web app. Its
default is `/opt/modules/MultiCamStudio/backend/build/flir-eye-tracker-record/flir_eye_tracker_recorder`.
The Docker Compose default for eye tracker settings is
`/home/docker/workspace/cfg/eye_tracker_settings.json` in the mounted checkout,
so editing the JSON does not require an image rebuild.

Run `npm run test:recorder` in `MultiCamStudio/frontend` to test the process API
with mock executables. Eye tracker networking and timestamp-file tests can run
without FLIR dependencies using `-DBUILD_FLIR_EYE_RECORDER=OFF`. Hardware capture
still requires the configured FLIR cameras, trigger wiring, encoder and Pupil
Capture instances.
