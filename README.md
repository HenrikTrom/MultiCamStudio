# MultiCam Control Studio ROS2

A browser GUI for viewing ROS 2 Jazzy camera images, recording synchronized videos,
and calibrating multi-camera setups.

From a checkout with its submodules initialized:

```sh
docker compose build
docker compose up -d
```

Open **http://localhost:5173**. This launches the complete GUI and preview service.
The production image starts prebuilt code; it installs no dependencies and runs no
application build commands at startup.

For a new host, copy [.env.example](.env.example) to `.env`, set `UID`/`GID` to match
`id -u` / `id -g`, and match the ROS domain/topic template to your publishers. Keep
your existing `.env` when updating this checkout. Camera IDs and board settings are
in [cfg/CameraCalibrationSettings.json](cfg/CameraCalibrationSettings.json).

- **Streamer:** live RGB8 images, actual online-topic counts, input/preview rates,
  histograms, and focus peaking. Previews are capped at 30 Hz.
- **Record:** aligned H.264 camera videos with source timestamp logs and resolution
  checks. Each session gets its own directory under `data/recordings`.
- **Calibration:** synchronized image capture, the unchanged `multi-camera-calib`
  solver, and validation against new ROS images. Existing calibration versions are
  preserved before publishing a validated replacement.

CPU encoding is the default. To expose an NVIDIA GPU for preview encoding:

```sh
docker compose -f docker-compose.yaml -f docker-compose.gpu.yaml up -d
```

Development is explicit and separate from normal startup:

```sh
docker compose down
docker compose -f docker-compose.yaml -f docker-compose.devel.yaml up -d --build
```

The development container builds the ROS workspace incrementally, starts the same
process API, and serves the GUI with frontend hot reload. To return to production,
stop that development configuration and run `docker compose up -d`.

See [installation and everyday use](instructions.md) for setup, recording,
calibration, updates, and troubleshooting. See [technical setup and development](ros2_ws/README.md)
for data formats, synchronization, Docker stages, APIs, and verification commands.
The [archived direct-camera instructions](docs/legacy-direct-camera.md) are retained
for reference.
