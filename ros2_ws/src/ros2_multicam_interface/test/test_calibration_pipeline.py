#!/usr/bin/env python3
"""Production HTTP -> ROS capture -> unchanged solver -> live ROS validation."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import cv2
import numpy as np
import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image


def main():
    rclpy.init()
    node = rclpy.create_node('mcs_calibration_pipeline_test')
    ids = ['101', '202']
    prefix = f'/mcs_calibration_test_{os.getpid()}/camera_'
    publishers = [node.create_publisher(Image, prefix + sn, qos_profile_sensor_data) for sn in ids]
    dictionary = cv2.aruco.getPredefinedDictionary(0)
    board = cv2.aruco.CharucoBoard((11, 7), 80, 60, dictionary)
    board.setLegacyPattern(True)
    pattern = board.generateImage((880, 560), marginSize=0, borderBits=1)
    intrinsic = np.array([[700, 0, 320], [0, 705, 240], [0, 0, 1]], dtype=float)
    rotation, _ = cv2.Rodrigues(np.array([0, 0.025, 0], dtype=float))
    texture_corners = np.array([[0, 0], [879, 0], [879, 559], [0, 559]], dtype=np.float32)
    board_corners = np.array([[0, 0, 0], [880, 0, 0], [880, 560, 0], [0, 560, 0]], dtype=float)
    scenes = []
    generator = np.random.default_rng(2026)
    for index in range(24):
        vector = generator.uniform([-0.3, -0.3, -0.15], [0.3, 0.3, 0.15])
        board_rotation, _ = cv2.Rodrigues(vector)
        translation = np.array([-440, -280, 1800]) + generator.uniform([-60, -40, -150], [60, 40, 150])
        world = (board_rotation @ board_corners.T).T + translation
        pair = []
        for camera in range(2):
            camera_rotation = np.eye(3) if camera == 0 else rotation
            camera_translation = np.zeros(3) if camera == 0 else np.array([-150, 5, 0])
            coordinates = (camera_rotation @ world.T).T + camera_translation
            pixels = (intrinsic @ coordinates.T).T
            pixels = (pixels[:, :2] / pixels[:, 2:]).astype(np.float32)
            homography = cv2.getPerspectiveTransform(texture_corners, pixels)
            image = cv2.warpPerspective(pattern, homography, (640, 480), borderValue=255)
            pair.append(cv2.cvtColor(image, cv2.COLOR_GRAY2RGB).tobytes())
        scenes.append(pair)
    stop = threading.Event()
    wrong_resolution = threading.Event()
    epoch = time.time_ns()
    def publish():
        sequence = 0
        while not stop.is_set():
            pair = scenes[(sequence // 6) % len(scenes)]
            for index, publisher in enumerate(publishers):
                message = Image()
                message.width = 642 if wrong_resolution.is_set() and index == 1 else 640
                message.height = 480
                message.step = message.width * 3
                message.encoding = 'rgb8'
                data = pair[index] if message.width == 640 else bytes(message.step * message.height)
                message.data = data
                timestamp = epoch + sequence * 33_333_333 + index * 1_000_000
                message.header.stamp.sec, message.header.stamp.nanosec = divmod(timestamp, 1_000_000_000)
                publisher.publish(message)
            sequence += 1
            stop.wait(1 / 30)
    worker = threading.Thread(target=publish)
    with tempfile.TemporaryDirectory(prefix='mcs-calibration-e2e-') as temporary:
        root = Path(temporary)
        data = root / 'data'; data.mkdir()
        config = root / 'settings.json'
        config.write_text(json.dumps({'serial_numbers': ids, 'main_cam_serial': ids[0], 'savedir': str(data / 'logs'),
            'pattern_size_first': 11, 'pattern_size_second': 7, 'charuco_params_border_size': 1,
            'charuco_params_dict': 0, 'charuco_params_marker_border_pixel': 1,
            'charuco_params_marker_to_square_ratio': 0.75, 'charuco_params_square_size': 80}))
        environment = {**os.environ, 'PORT': '15173', 'STREAMER_PORT': '18080',
            'CAMERA_CALIBRATION_FILE': str(config), 'CALIBRATION_DATA': str(data),
            'ROS_IMAGE_TOPIC_TEMPLATE': prefix + '{serial}', 'STREAMER_ENCODER': 'libx264',
            'CALIBRATION_CAPTURE_FRAMES': '18', 'CALIBRATION_CAPTURE_INTERVAL_MS': '200',
            'RECORD_SYNC_TOLERANCE_MS': '3', 'RECORD_START_TIMEOUT_SEC': '10'}
        with (root / 'server.log').open('w+') as log:
            process = subprocess.Popen(['node', '/opt/mcs/web/server/server.mjs'], env=environment, stdout=log, stderr=log)
            worker.start()
            def call(path, values=None):
                request = urllib.request.Request('http://127.0.0.1:15173' + path,
                    data=None if values is None else json.dumps(values).encode(),
                    headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=20) as response:
                    return json.load(response)
            def finished():
                deadline = time.monotonic() + 150
                while True:
                    state = call('/local-api/calibration/status')
                    if not state['running']:
                        return state
                    assert time.monotonic() < deadline, state
                    time.sleep(0.25)
            try:
                deadline = time.monotonic() + 15
                while True:
                    try:
                        if call('/healthz')['streaming']:
                            break
                    except (OSError, urllib.error.URLError):
                        pass
                    assert process.poll() is None and time.monotonic() < deadline
                    time.sleep(0.1)
                call('/local-api/calibration/run', {})
                state = finished()
                assert state['result']['success'], state
                assert all(value == 'success' for value in state['stages'].values()), state
                assert state['result']['report']['mean_reprojection_error_px'] < 5, state
                published = data / 'logs/Calibration640x480.json'
                original = published.read_bytes()
                assert json.loads(original)['image_width'] == 640
                print('PASS: ROS capture -> unchanged native calibration -> live ROS reprojection', state['result']['report'], flush=True)
                call('/local-api/calibration/validate', {})
                quick = finished()
                assert quick['result']['success'], quick
                assert quick['stages']['capture'] == quick['stages']['calibrate'] == 'pending'
                print('PASS: quick ROS calibration validation', flush=True)
                wrong_resolution.set()
                time.sleep(0.2)
                call('/local-api/calibration/run', {})
                failed = finished()
                assert not failed['result']['success'] and failed['stages']['capture'] == 'error', failed
                assert 'resolution' in failed['result']['error'], failed
                assert published.read_bytes() == original
                print('PASS: mismatched resolution blocked before calibration; published result preserved', flush=True)
                wrong_resolution.clear()
                time.sleep(0.2)
                call('/local-api/recorder/start', {'name': 'record-e2e', 'fps': 30})
                time.sleep(0.5)
                call('/local-api/recorder/stop', {})
                output = data / 'recordings/record-e2e'
                manifest = json.loads((output / 'session.json').read_text())
                assert manifest['status'] == 'complete' and manifest['frames'] > 3, manifest
                counts = []
                for sn in ids:
                    video = cv2.VideoCapture(str(output / (sn + '.mp4')))
                    count = 0
                    while video.read()[0]: count += 1
                    counts.append(count); video.release()
                assert counts == [manifest['frames']] * 2, (counts, manifest)
                print('PASS: HTTP recording lifecycle and finalized, aligned MP4s', counts, flush=True)
            except BaseException:
                log.flush(); log.seek(0)
                print(log.read(), flush=True)
                raise
            finally:
                stop.set(); worker.join()
                process.send_signal(signal.SIGTERM)
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
