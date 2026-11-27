#!/usr/bin/env python3
"""ROS integration tests for timestamp matching, one-shot frames and calibration PNG capture."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import cv2
import numpy as np
import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image

BIN = Path('/opt/mcs/ros2/lib/ros2_multicam_interface')
IDS = ['101', '202', '303']


def run_case(root, name, *, calibration=True, mismatch=False, zero=False, unsynchronized=False,
             manual_stop=False, stall=False, odd=False):
    prefix = f'/mcs_record_test_{os.getpid()}/{name}/camera_'
    node = rclpy.create_node('mcs_record_test_' + name)
    publishers = [node.create_publisher(Image, prefix + sn, qos_profile_sensor_data) for sn in IDS]
    stop = threading.Event()
    missing = threading.Event()
    epoch = time.time_ns()
    def pixels(width, height, camera, sequence):
        y, x = np.indices((height, width))
        return np.stack([(x + sequence + camera * 17) % 256,
                         (y * 3 + sequence * 7) % 256,
                         (x + y * 5 + camera * 23) % 256], axis=2).astype(np.uint8)
    def publish():
        sequence = 0
        while not stop.is_set():
            for index, publisher in enumerate(publishers):
                if index == 2 and (missing.is_set() or sequence % 4 == 0):
                    continue
                message = Image()
                message.width = 162 if mismatch and index == 2 else 161 if odd else 160
                message.height = 121 if odd else 120
                message.step = message.width * 3 + 16
                message.encoding = 'rgb8'
                timestamp = 0 if zero else epoch + sequence * 40_000_000 + index * (10_000_000 if unsynchronized else 1_000_000)
                message.header.stamp.sec, message.header.stamp.nanosec = divmod(timestamp, 1_000_000_000)
                padded = np.zeros((message.height, message.step), dtype=np.uint8)
                padded[:, :message.width * 3] = pixels(message.width, message.height, index, sequence).reshape(message.height, message.width * 3)
                message.data = padded.tobytes()
                publisher.publish(message)
            sequence += 1
            stop.wait(0.04)
    config = root / (name + '.json')
    config.write_text(json.dumps({'serial_numbers': IDS, 'main_cam_serial': IDS[0]}))
    output = root / name
    environment = {**os.environ, 'ROS_IMAGE_TOPIC_TEMPLATE': prefix + '{serial}',
        'CALIBRATION_CAPTURE_FRAMES': '100' if manual_stop or stall else '3', 'CALIBRATION_CAPTURE_INTERVAL_MS': '10',
        'RECORD_SYNC_TOLERANCE_MS': '3', 'RECORD_START_TIMEOUT_SEC': '2', 'RECORD_STALL_TIMEOUT_SEC': '1'}
    executable = BIN / 'calibration_tab_ros2_image_recorder'
    thread = threading.Thread(target=publish)
    log_path = root / (name + '.log')
    with log_path.open('w') as log:
        process = subprocess.Popen([str(executable), *([] if calibration else ['--frame']), str(config), str(output)], env=environment, stdout=log, stderr=log)
        thread.start()
        try:
            if manual_stop or stall:
                deadline = time.monotonic() + 8
                while '"event":"progress"' not in log_path.read_text():
                    assert time.monotonic() < deadline and process.poll() is None, log_path.read_text()
                    time.sleep(0.05)
                if stall:
                    missing.set()
                else:
                    time.sleep(0.3)
                    process.send_signal(signal.SIGTERM)
            code = process.wait(timeout=12)
        finally:
            stop.set(); thread.join()
            if process.poll() is None:
                process.kill(); process.wait()
            node.destroy_node()
    assert output.exists(), log_path.read_text()
    manifest = json.loads((output / 'session.json').read_text())
    failure = mismatch or zero or unsynchronized or stall or (calibration and manual_stop)
    assert code == int(failure), (manifest, log_path.read_text())
    assert manifest['status'] == ('failed' if failure else 'complete'), manifest
    if mismatch or zero or unsynchronized:
        assert manifest['frames'] == 0 and not list(output.glob('*.mp4')), manifest
        return
    rows = [json.loads(line) for line in (output / 'frame_timestamps.jsonl').read_text().splitlines()]
    assert len(rows) == manifest['frames'] and len(rows) > 0
    assert all(row['skew_ns'] == 2_000_000 for row in rows)
    assert all(row['source_timestamps_ns'][2] - row['source_timestamps_ns'][0] == 2_000_000 for row in rows)
    assert all((row['source_timestamps_ns'][0] - epoch) // 40_000_000 % 4 != 0 for row in rows)
    assert len({row['source_timestamps_ns'][0] for row in rows}) == len(rows)
    assert manifest['capture_format'] == 'png' and manifest['calibration_capture'] == calibration
    assert not list(output.rglob('*.mp4')) and not list(output.rglob('*.tmp.png'))
    images = output / 'images' if calibration else output
    assert Path(manifest['image_directory']) == images
    assert len(list(images.glob('*.png'))) == len(rows) * len(IDS)
    if not manual_stop and not stall: assert len(rows) == (3 if calibration else 1)
    for camera, sn in enumerate(IDS):
        for index, row in enumerate(rows, 1):
            name = f'cam{sn}-{index:04d}.png' if calibration else f'cam{sn}.png'
            image = cv2.imread(str(images / name))
            sequence = (row['source_timestamps_ns'][camera] - epoch - camera * 1_000_000) // 40_000_000
            expected = pixels(manifest['width'], manifest['height'], camera, sequence)[:, :, ::-1]
            assert image is not None and np.array_equal(image, expected), (sn, index)


def main():
    rclpy.init()
    try:
        with tempfile.TemporaryDirectory(prefix='mcs-recorder-') as temporary:
            root = Path(temporary)
            for name, options in [('capture', {}), ('capture_odd', {'odd': True}),
                    ('resolution', {'mismatch': True}), ('zero', {'zero': True}),
                    ('skew', {'unsynchronized': True}), ('stop', {'manual_stop': True}),
                    ('stall', {'stall': True}), ('frame', {'calibration': False}),
                    ('frame_odd', {'calibration': False, 'odd': True})]:
                run_case(root, name, **options)
                print('PASS:', name, flush=True)
            capture = root / 'capture'
            original = {path: path.read_bytes() for path in capture.rglob('*') if path.is_file()}
            repeated = subprocess.run([str(BIN / 'calibration_tab_ros2_image_recorder'),
                                       str(root / 'capture.json'), str(capture)], capture_output=True, timeout=10)
            assert repeated.returncode != 0
            assert all(path.read_bytes() == content for path, content in original.items())
            print('PASS: existing PNG capture is never overwritten', flush=True)
    finally:
        rclpy.shutdown()


if __name__ == '__main__':
    main()
