#!/usr/bin/env python3
"""Verify topic discovery, selected-topic MCAP recording and graceful metadata flush."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time

import rclpy
from rclpy.qos import qos_profile_sensor_data
from rclpy.serialization import deserialize_message
import rosbag2_py
from sensor_msgs.msg import Image
from std_msgs.msg import String


def main():
    script = os.environ.get('ROS_BAG_RECORDER_SCRIPT', '/opt/mcs/ros2/lib/ros2_multicam_interface/record_rosbag.py')
    rclpy.init()
    node = rclpy.create_node('mcs_bag_test')
    prefix = '/mcs_bag_test_' + str(os.getpid())
    image_topic, extra_topic, ignored_topic = prefix + '/camera', prefix + '/_selected', prefix + '/ignored'
    image_publisher = node.create_publisher(Image, image_topic, qos_profile_sensor_data)
    extra_publisher = node.create_publisher(String, extra_topic, 10)
    ignored_publisher = node.create_publisher(String, ignored_topic, 10)
    stop = threading.Event()
    def publish():
        while not stop.is_set():
            image = Image()
            image.width, image.height, image.step, image.encoding = 8, 6, 24, 'rgb8'
            image.header.stamp = node.get_clock().now().to_msg()
            image.data = bytes([17, 43, 201]) * 48
            image_publisher.publish(image)
            extra_publisher.publish(String(data='selected'))
            ignored_publisher.publish(String(data='excluded'))
            stop.wait(0.03)
    worker = threading.Thread(target=publish)
    worker.start()
    process = None
    try:
        discovery = subprocess.check_output([sys.executable, script, '--list-topics'], text=True, timeout=10)
        topics = {topic['name'] for topic in json.loads(discovery)['topics']}
        assert {image_topic, extra_topic, ignored_topic} <= topics, topics
        with tempfile.TemporaryDirectory(prefix='mcs-rosbag-') as directory:
            output = Path(directory) / '2026-11-27-16-56-23'
            process = subprocess.Popen([sys.executable, script, '--output', str(output), '--topics', image_topic, extra_topic],
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            lines = []
            # Read incrementally so readiness is visible before the recorder exits.
            reader = threading.Thread(target=lambda: [lines.append(line) for line in process.stdout], daemon=True)
            reader.start()
            deadline = time.monotonic() + 15
            while not any('"event": "ready"' in line for line in lines):
                assert process.poll() is None and time.monotonic() < deadline, ''.join(lines)
                time.sleep(0.05)
            # Opening storage precedes DDS subscriptions. Start the measured
            # capture interval only once both test publishers have a reader.
            while not all(publisher.get_subscription_count() for publisher in [image_publisher, extra_publisher]):
                assert process.poll() is None and time.monotonic() < deadline, ''.join(lines)
                rclpy.spin_once(node, timeout_sec=0.05)
            time.sleep(1)
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=25) == 0, ''.join(lines)
            reader.join(timeout=3)
            assert (output / 'metadata.yaml').is_file()
            assert json.loads((output / 'session.json').read_text())['status'] == 'complete'
            bag = rosbag2_py.SequentialReader()
            bag.open(rosbag2_py.StorageOptions(uri=str(output), storage_id='mcap'), rosbag2_py.ConverterOptions('', ''))
            recorded = {entry.name for entry in bag.get_all_topics_and_types()}
            assert recorded == {image_topic, extra_topic}, recorded
            counts = {name: 0 for name in recorded}
            while bag.has_next():
                name, data, timestamp = bag.read_next()
                assert timestamp > 0
                counts[name] += 1
                if name == image_topic:
                    image = deserialize_message(data, Image)
                    assert image.width == 8 and bytes(image.data) == bytes([17, 43, 201]) * 48
                    assert image.header.stamp.sec > 0
                else:
                    assert deserialize_message(data, String).data == 'selected'
            assert min(counts.values()) > 5, counts
            previous = (output / 'metadata.yaml').read_bytes()
            repeated = subprocess.run([sys.executable, script, '--output', str(output), '--topics', image_topic],
                                      capture_output=True, timeout=10)
            assert repeated.returncode != 0 and (output / 'metadata.yaml').read_bytes() == previous
            print('PASS: discovered topics; selected camera and extra topic recorded as MCAP; unselected topic excluded; exact source messages; graceful stop; no overwrite', counts)
    finally:
        if process and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try: process.wait(timeout=25)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
        stop.set(); worker.join()
        node.destroy_node(); rclpy.shutdown()


if __name__ == '__main__':
    main()
