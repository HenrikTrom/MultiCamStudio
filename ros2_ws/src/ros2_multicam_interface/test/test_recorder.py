#!/usr/bin/env python3
"""ROS integration tests for timestamp matching, MP4 finalization and PNG capture."""
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


def run_case(root, name, *, calibration=False, mismatch=False, zero=False, unsynchronized=False,
             manual_stop=False, stall=False):
    prefix = f'/mcs_record_test_{os.getpid()}/{name}/camera_'
    node = rclpy.create_node('mcs_record_test_' + name)
    publishers = [node.create_publisher(Image, prefix + sn, qos_profile_sensor_data) for sn in IDS]
    stop = threading.Event()
    missing = threading.Event()
    epoch = time.time_ns()
    def publish():
        sequence = 0
        while not stop.is_set():
            for index, publisher in enumerate(publishers):
                if index == 2 and (missing.is_set() or sequence % 4 == 0):
                    continue
                message = Image()
                message.width = 162 if mismatch and index == 2 else 160
                message.height = 120
                message.step = message.width * 3 + 16
                message.encoding = 'rgb8'
                timestamp = 0 if zero else epoch + sequence * 40_000_000 + index * (10_000_000 if unsynchronized else 1_000_000)
                message.header.stamp.sec, message.header.stamp.nanosec = divmod(timestamp, 1_000_000_000)
                pixel = [200, 0, 0] if index == 0 else [0, 0, 200]
                message.data = (bytes(pixel) * message.width + bytes(16)) * message.height
                publisher.publish(message)
            sequence += 1
            stop.wait(0.04)
    config = root / (name + '.json')
    config.write_text(json.dumps({'serial_numbers': IDS, 'main_cam_serial': IDS[0]}))
    output = root / name
    environment = {**os.environ, 'ROS_IMAGE_TOPIC_TEMPLATE': prefix + '{serial}', 'RECORD_FPS': '60',
        'RECORD_MAX_FRAMES': '0' if manual_stop or stall else '12',
        'CALIBRATION_CAPTURE_FRAMES': '3', 'CALIBRATION_CAPTURE_INTERVAL_MS': '10',
        'RECORD_SYNC_TOLERANCE_MS': '3', 'RECORD_START_TIMEOUT_SEC': '2', 'RECORD_STALL_TIMEOUT_SEC': '1'}
    executable = BIN / ('calibration_tab_ros2_image_recorder' if calibration else 'recording_tab_ros2_image_recorder')
    thread = threading.Thread(target=publish)
    log_path = root / (name + '.log')
    with log_path.open('w') as log:
        process = subprocess.Popen([str(executable), str(config), str(output)], env=environment, stdout=log, stderr=log)
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
    failure = mismatch or zero or unsynchronized or stall
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
    if calibration:
        assert len(rows) == 3
        for sn in IDS:
            for index in range(1, 4):
                image = cv2.imread(str(output / 'images' / f'cam{sn}-{index:04d}.png'))
                assert image is not None and image.shape == (120, 160, 3)
        assert cv2.imread(str(output / 'images' / 'cam101-0001.png'))[0, 0, 2] > 190
    else:
        for sn in IDS:
            video = cv2.VideoCapture(str(output / (sn + '.mp4')))
            count = 0
            while True:
                ok, image = video.read()
                if not ok:
                    break
                assert image.shape == (120, 160, 3)
                if sn == '101': assert float(np.mean(image[:, :, 2])) > 180
                count += 1
            video.release()
            assert count == len(rows), (sn, count, len(rows))
        if not manual_stop and not stall:
            assert len(rows) == 12
            assert sum(manifest['dropped_frames']) > 0


def main():
    rclpy.init()
    try:
        with tempfile.TemporaryDirectory(prefix='mcs-recorder-') as temporary:
            root = Path(temporary)
            for name, options in [('video', {}), ('capture', {'calibration': True}),
                    ('resolution', {'mismatch': True}), ('zero', {'zero': True}),
                    ('skew', {'unsynchronized': True}), ('stop', {'manual_stop': True}),
                    ('stall', {'stall': True})]:
                run_case(root, name, **options)
                print('PASS:', name, flush=True)
    finally:
        rclpy.shutdown()


if __name__ == '__main__':
    main()
