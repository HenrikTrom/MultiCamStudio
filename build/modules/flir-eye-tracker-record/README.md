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
  "clock_measurement_interval_ms": 5000,
  "clock_measurement_samples": 10,
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
the eye tracker and FLIR clocks. The recorder measures their relationship using
lowercase `t` clock queries; it never sends uppercase `T` or resets Pupil clocks.
See [Pupil Network API documentation](https://docs.pupil-labs.com/core/developer/network-api/).

## Output

The selected save directory defaults to `save_dir` in the camera settings. Both
recording tabs accept a per-session override. A new subdirectory is created for
the session, and an existing session directory is rejected to avoid overwriting:

```text
<save-directory>/<session-name>/
  <camera-serial>.mp4           # one synchronized video per camera
  frame_timestamps.json
  clock_measurements.jsonl       # raw Pupil clock readings and offset estimates
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

## Pupil clock measurements and alignment

Every session saves `clock_measurements.jsonl`, with one complete JSON object per
line. With the default settings, the recorder queries each tracker's current
Pupil time ten times before sending recording-start commands, then performs
another burst every five seconds on a background thread. It takes a final burst
after recording stops, including on normal exception unwinding. Initial and final
bursts can add network wait time to Start/Stop. During recording, network requests
never run on the FLIR capture thread. Trackers are measured in parallel, with a
dedicated reusable connection for each burst.

`clock_measurement_interval_ms` controls the wait between background bursts
(1000–60000 ms); `clock_measurement_samples` controls burst size (3–60). Existing
configuration files that omit these fields use 5000 ms and 10 samples.
An empty tracker array produces only the log's metadata line.

The log starts with a `metadata` record describing units, clock domain, mapping,
and measurement settings. Each `measurement` record contains:

- `tracker`, `endpoint`, `phase` (`before`, `during`, or `after`), `batch_index`, and `sample_index`.
- `host_before_ns` and `host_after_ns`: host `CLOCK_MONOTONIC` immediately before
  sending `t` and after receiving its reply, matching the clock used by FLIR metadata.
- `pupil_time_s`: the numeric Pupil time returned by `t`, in seconds.
- `round_trip_ns`, the original `raw_reply` when available, and `estimated_host_minus_pupil_s`.
- `success` and `used_in_estimate`. Failed replies have an `error` instead of an offset.

Host nanoseconds are decimal strings, while Pupil seconds and offsets are JSON
numbers. Each successful sample estimates:

```text
host_midpoint_s = host_before_ns / 1e9 + (host_after_ns - host_before_ns) / 2e9
estimated_host_minus_pupil_s = host_midpoint_s - pupil_time_s
host_monotonic_s = pupil_time_s + estimated_host_minus_pupil_s
```

For each tracker and burst, an `estimate` record averages offsets after discarding
the slowest 30% of valid round trips (rounding the retained count up). It records
the accepted count, mean `pupil_time_s`, mean offset, minimum round trip, and
`offset_jitter_s` (population standard deviation of accepted offsets). All raw
samples remain available. A burst interrupted by Stop may contain fewer samples.
Malformed/nonfinite replies and timeouts are logged without inventing offsets;
the next periodic burst retries. A failed query ends that tracker's current burst.
Each burst also stops issuing queries after two seconds, allowing an in-flight
query to finish within the configured timeout. Slow trackers can therefore produce
fewer samples than requested without holding up Start/Stop for a full burst.
Connection failures do not stop an otherwise healthy capture, but clock-log
storage failures are surfaced to the recording process and stop it.

Logs are flushed after each tracker's completed burst. JSON Lines needs no footer;
after a forced kill, ignore any incomplete last line. This is software clock
mapping, not hardware exposure synchronization. The midpoint assumes roughly
symmetric request/reply delays; jitter is not a guaranteed accuracy bound.
Validate actual video timing with a shared visible event. The Pupil Time Sync
plugin can run alongside measurements, but clock adjustments or resets must be
reviewed before interpolating across them.

To align an exported Pupil CSV, run this from the repository root:

```sh
python3 build/modules/flir-eye-tracker-record/tools/align_pupil_timestamps.py \
  /path/to/session/clock_measurements.jsonl \
  /path/to/pupil/exports/gaze_positions.csv \
  /path/to/session/gaze_aligned.csv \
  --tracker "Eye tracker 1" --timestamp-column gaze_timestamp
```

Use the configured tracker name (or its full `tcp://` endpoint) and the actual
timestamp column in your export. The helper uses successful burst estimates,
linearly interpolates the offset between surrounding Pupil times, and appends
`host_monotonic_ns` to each row. Compare that column to FLIR's
`aligned_monotonic_ns`, not its callback time or `host_unix_ns`. These remain
estimates, and streams may have different sampling rates.

The helper refuses extrapolation, missing measurements, and backward/nonincreasing
clock estimates. It cannot detect every clock adjustment: inspect raw measurements
and jitter, and split recordings into separate clock epochs if a clock changes
discontinuously. It preserves the input CSV and only replaces the output after a
successful conversion. Python 3's standard library is sufficient.

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
