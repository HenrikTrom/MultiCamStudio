#!/usr/bin/env python3
"""Verify a source-free production image can start and restart MCS offline.

Run in the final image with `docker run --network none ...`. No compiler,
package installation, source checkout, physical cameras or GPU is needed.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def main():
    for executable in ['gcc', 'g++', 'c++', 'make', 'colcon', 'npm', 'npx']:
        assert shutil.which(executable) is None, executable
    assert not Path('/workspaces/ros2_ws').exists()
    assert not Path('/opt/mcs/web/node_modules').exists()
    binaries = [Path('/opt/mcs/ros2/lib/ros2_multicam_interface') / executable for executable in
        ['camera_tab_ros2_web_streamer', 'calibration_tab_ros2_image_recorder']]
    binaries.append(Path('/opt/mcs/calibration/bin/Multi_Camera_Calibration'))
    mtimes = {path: path.stat().st_mtime_ns for path in binaries}
    subprocess.run(['/usr/local/bin/mcs-check-runtime'], check=True)
    with tempfile.TemporaryDirectory(prefix='mcs-runtime-') as temporary:
        root = Path(temporary)
        data = root / 'data'; data.mkdir()
        config = root / 'settings.json'
        settings = json.loads(Path('/home/docker/workspace/cfg/CameraCalibrationSettings.json').read_text())
        settings['serial_numbers'] = ['101', '202']
        settings['main_cam_serial'] = '101'
        settings['savedir'] = str(data / 'logs')
        config.write_text(json.dumps(settings))
        port, streamer_port = free_port(), free_port()
        while streamer_port == port:
            streamer_port = free_port()
        environment = {**os.environ, 'PORT': str(port), 'STREAMER_PORT': str(streamer_port),
            'CAMERA_CALIBRATION_FILE': str(config), 'CALIBRATION_DATA': str(data),
            'ROS_DOMAIN_ID': '129', 'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST',
            'STREAMER_ENCODER': 'libx264'}
        def request(path, method='GET', timeout=3):
            req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method)
            return urllib.request.urlopen(req, timeout=timeout)
        for attempt in range(2):
            started = time.monotonic()
            with (root / f'start-{attempt}.log').open('w+') as log:
                process = subprocess.Popen(['/mcs-entrypoint.sh', 'node', '/opt/mcs/web/server/server.mjs'],
                    env=environment, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 15
                    while True:
                        assert process.poll() is None
                        try:
                            with request('/healthz') as response:
                                if json.load(response)['streaming']:
                                    break
                        except (OSError, urllib.error.URLError):
                            pass
                        assert time.monotonic() < deadline, 'GUI did not start'
                        time.sleep(0.1)
                    with request('/') as response:
                        assert '<title>MultiCam Control Studio ROS2</title>' in response.read().decode()
                    with request('/api/cameras') as response:
                        cameras = json.load(response)
                        assert cameras['configured_cameras'] == 2
                        assert cameras['online_cameras'] == 0
                        assert all(camera['input_fps'] == camera['stream_fps'] == 0 for camera in cameras['cameras'])
                    with request('/local-api/recorder/config', timeout=10) as response:
                        assert len(json.load(response)['cameras']) == 2
                    with request('/local-api/camera-stream/stop', 'POST') as response:
                        assert not json.load(response)['streaming']
                    with request('/healthz') as response:
                        assert response.status == 200
                    with request('/local-api/camera-stream/start', 'POST') as response:
                        assert json.load(response)['streaming']
                    print(f'PASS: offline runtime start {attempt + 1}, GUI ready in {time.monotonic() - started:.2f}s', flush=True)
                except BaseException:
                    log.flush(); log.seek(0); print(log.read(), flush=True)
                    raise
                finally:
                    process.send_signal(signal.SIGTERM)
                    try:
                        assert process.wait(timeout=15) == 0
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(); raise
                log.flush(); log.seek(0)
                output = log.read()
                for forbidden in ['colcon build', 'npm ci', 'npm install', 'npm run build', 'cmake --build']:
                    assert forbidden not in output, output
        assert {path: path.stat().st_mtime_ns for path in binaries} == mtimes
    print('PASS: no native compiler/build runner or source checkout; prebuilt binaries unchanged')


if __name__ == '__main__':
    main()
