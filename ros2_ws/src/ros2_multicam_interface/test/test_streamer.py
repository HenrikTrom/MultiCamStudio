#!/usr/bin/env python3
"""End-to-end test with synthetic ROS images, HTTP records, and FFmpeg decoding.

Run inside the development image with the installed runtime mounted at /opt/mcs/ros2.
No physical cameras or GPU are needed. See ros2_ws/README.md.
"""
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

import rclpy
from rclpy.qos import QoSProfile, ReliabilityPolicy, qos_profile_sensor_data
from sensor_msgs.msg import Image


EXECUTABLE = os.environ.get(
    "STREAMER_EXECUTABLE", "/opt/mcs/ros2/lib/ros2_multicam_interface/camera_tab_ros2_web_streamer"
)


def image(width=160, height=120, encoding="rgb8", padding=16):
    msg = Image()
    msg.width, msg.height, msg.encoding = width, height, encoding
    msg.step = width * 3 + padding
    # Red pixels, with deliberately green/blue padding to detect stride errors.
    msg.data = (bytes([255, 0, 0]) * width + bytes([0, 255, 255, 0]) * (padding // 4)) * height
    return msg


def read_exact(response, size):
    output = bytearray()
    while len(output) < size:
        block = response.read(size - len(output))
        if not block:
            raise AssertionError("Stream ended unexpectedly")
        output.extend(block)
    return bytes(output)


def capture(port, index, duration=2.5):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", f"/api/cameras/{index}/stream")
    response = connection.getresponse()
    assert response.status == 200, (response.status, response.read())
    video = bytearray()
    timestamps = []
    flags = []
    started = time.monotonic()
    try:
        while time.monotonic() - started < duration:
            flag, size, timestamp = struct.unpack(">BIQ", read_exact(response, 13))
            assert 0 < size < 10_000_000
            video.extend(read_exact(response, size))
            flags.append(flag)
            if not flag & 1:
                timestamps.append(timestamp)
    finally:
        response.close()
        connection.close()
    assert flags[0] == 1 and flags[1] & 2, flags[:3]
    assert len(timestamps) > 5
    rate = (len(timestamps) - 1) * 1_000_000 / (timestamps[-1] - timestamps[0])
    return rate, timestamps, video


def run():
    rclpy.init()
    node = rclpy.create_node("mcs_streamer_test")
    topic_base = f"/mcs_test_{os.getpid()}/camera_"
    publishers = [
        node.create_publisher(Image, topic_base + "19037266/image_raw", qos_profile_sensor_data),
        node.create_publisher(Image, topic_base + "19246521/image_raw", QoSProfile(
            depth=1, reliability=ReliabilityPolicy.RELIABLE)),
        node.create_publisher(Image, topic_base + "20174578/image_raw", qos_profile_sensor_data),
        node.create_publisher(Image, topic_base + "19338645/image_raw", qos_profile_sensor_data),
    ]
    stop = threading.Event()
    late = threading.Event()
    pause_fast = threading.Event()
    good = image()
    invalid = [image(encoding="bgr8"), image(width=159), image()]
    invalid[-1].data = b"short"
    bad_stride = image()
    bad_stride.step = 1
    invalid.append(bad_stride)

    def publish():
        next_times = [0.0] * 4
        rates = [90, 10, 20, 30]
        count = 0
        while not stop.is_set():
            now = time.monotonic()
            for index, publisher in enumerate(publishers):
                if now < next_times[index]:
                    continue
                next_times[index] = now + 1 / rates[index]
                if (index == 3 and not late.is_set()) or (index == 0 and pause_fast.is_set()):
                    continue
                msg = invalid[count % len(invalid)] if index == 2 else good
                msg.header.stamp = node.get_clock().now().to_msg()
                publisher.publish(msg)
            count += 1
            stop.wait(0.001)

    with tempfile.TemporaryDirectory(prefix="mcs-test-") as temporary:
        folder = Path(temporary)
        config = folder / "calibration.json"
        config.write_text(json.dumps({"serial_numbers": ["19037266", "19246521", "20174578", "19338645"]}))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {**os.environ, "CAMERA_CALIBRATION_FILE": str(config), "STREAMER_PORT": str(port),
               "ROS_IMAGE_TOPIC_TEMPLATE": topic_base + "{serial}/image_raw", "STREAMER_ENCODER": os.environ.get("TEST_STREAMER_ENCODER", "libx264")}
        with (folder / "streamer.log").open("w+") as log:
            process = subprocess.Popen([EXECUTABLE], env=env, stdout=log, stderr=log)
            worker = threading.Thread(target=publish)
            worker.start()

            def get(path):
                with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=3) as response:
                    return json.load(response)

            try:
                deadline = time.monotonic() + 15
                while True:
                    assert process.poll() is None, "Streamer exited during startup"
                    try:
                        cameras = get("/api/cameras")["cameras"]
                        if cameras[0]["ready"] and cameras[1]["ready"]:
                            break
                    except (OSError, urllib.error.URLError):
                        pass
                    assert time.monotonic() < deadline, "Startup/discovery timed out"
                    time.sleep(0.1)
                assert len(cameras) == 4
                assert [c["id"] for c in cameras] == ["19037266", "19246521", "20174578", "19338645"]
                assert cameras[0]["topic"] == topic_base + "19037266/image_raw"
                assert cameras[0]["width"] == 160 and cameras[0]["height"] == 120
                assert all(c["fps"] == 30 for c in cameras)
                assert not cameras[2]["ready"] and not cameras[3]["ready"]
                for path in ("/api/cameras/2/stream", "/api/cameras/3/stream"):
                    try:
                        get(path)
                        raise AssertionError("Unavailable topic should return 503")
                    except urllib.error.HTTPError as error:
                        assert error.code == 503
                for path in ("/api/cameras/99/stream", "/api/cameras/0junk/stream"):
                    try:
                        get(path)
                        raise AssertionError("Invalid index should return 404")
                    except urllib.error.HTTPError as error:
                        assert error.code == 404
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    fast = pool.submit(capture, port, 0)
                    slow = pool.submit(capture, port, 1)
                    fast_rate, timestamps, video = fast.result()
                    slow_rate, _, _ = slow.result()
                assert 25 < fast_rate <= 30.2, fast_rate
                assert all(b - a >= 32_000 for a, b in zip(timestamps, timestamps[1:])), timestamps
                assert 8 < slow_rate < 12, slow_rate
                snapshot = get("/api/cameras")
                stats = snapshot["cameras"]
                assert snapshot["configured_cameras"] == 4
                assert snapshot["online_cameras"] == 3  # Invalid images are still topic traffic.
                assert snapshot["streaming_cameras"] == 2
                assert 70 < stats[0]["input_fps"] < 100, stats[0]
                assert 25 < stats[0]["stream_fps"] <= 30.3, stats[0]
                assert 8 < stats[1]["input_fps"] < 12
                assert stats[0]["publisher_count"] == 1
                assert stats[2]["online"] and not stats[2]["preview_active"]
                assert stats[2]["invalid_frames"] > 0 and stats[2]["image_error"]
                assert stats[2]["encoded_frames"] == 0
                assert not stats[3]["online"] and stats[3]["last_image_age_ms"] is None
                path = folder / "preview.mp4"
                path.write_bytes(video)
                probe = json.loads(subprocess.check_output([
                    "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                    "stream=codec_name,profile,level,width,height", "-of", "json", str(path)]))
                stream = probe["streams"][0]
                assert stream['codec_name'] == 'h264' and stream['profile'] == 'High', stream
                assert (stream['width'], stream['height']) == (160, 120), stream
                assert cameras[0]['codec'].startswith('avc1.64'), cameras[0]
                assert int(cameras[0]['codec'][-2:], 16) == stream['level'], (cameras[0], stream)
                assert cameras[0]['encoder'] == env['STREAMER_ENCODER'], cameras[0]
                pixels = subprocess.check_output([
                    "ffmpeg", "-v", "error", "-i", str(path), "-frames:v", "1",
                    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
                assert len(pixels) == 160 * 120 * 3
                assert min(pixels[0::3]) > 220 and max(pixels[1::3]) < 30 and max(pixels[2::3]) < 30
                late.set()
                deadline = time.monotonic() + 5
                while not get("/api/cameras")["cameras"][3]["ready"]:
                    assert time.monotonic() < deadline
                    time.sleep(0.1)
                late_rate, _, _ = capture(port, 3, 0.7)
                assert 20 < late_rate <= 30.2
                pause_fast.set()
                time.sleep(2.5)
                snapshot = get("/api/cameras")
                inactive = snapshot["cameras"][0]
                assert not inactive["online"] and not inactive["preview_active"], inactive
                assert inactive["input_fps"] == inactive["stream_fps"] == 0
                assert inactive["last_image_age_ms"] >= 2000
                assert inactive["publisher_count"] == 1  # A publisher alone is not online.
                assert snapshot["online_cameras"] == 3
                pause_fast.clear()
                deadline = time.monotonic() + 5
                while not get("/api/cameras")["cameras"][0]["online"]:
                    assert time.monotonic() < deadline
                    time.sleep(0.1)
                # Repeated short HTTP requests must not retain finished workers.
                for _ in range(100):
                    get("/api/health")
                task_count = len(list(Path(f"/proc/{process.pid}/task").iterdir()))
                assert task_count < 40, task_count
                # SIGTERM also wakes idle/offline encoders and active stream clients.
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    pending = pool.submit(capture, port, 1, 10)
                    time.sleep(0.2)
                    process.send_signal(signal.SIGTERM)
                    assert process.wait(timeout=5) == 0
                    try:
                        pending.result()
                    except (AssertionError, OSError):
                        pass
                print(f"PASS: 90 Hz input -> {fast_rate:.2f} Hz; 10 Hz input -> {slow_rate:.2f} Hz")
                print(f"PASS: best-effort/reliable QoS, padded RGB8 decode, H.264 High level {stream['level'] / 10:g}, invalid images,")
                print("      online/offline rates, invalid/late topics, publisher counts, worker cleanup, SIGTERM")
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read())
                raise
            finally:
                stop.set()
                worker.join()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    run()
