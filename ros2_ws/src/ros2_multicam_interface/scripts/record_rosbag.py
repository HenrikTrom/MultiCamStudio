#!/usr/bin/env python3
"""Record selected ROS topics with rosbag2, or discover topics for the GUI."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

output_lock = threading.Lock()


def output_line(line):
    # Keep native logs and JSON events on separate lines across both threads.
    with output_lock:
        print(line, flush=True)


def event(kind, **values):
    output_line(json.dumps({'event': kind, **values}))


def list_topics():
    import rclpy
    rclpy.init()
    node = rclpy.create_node('mcs_topic_menu_' + str(os.getpid()))
    try:
        # Allow a full DDS discovery announcement interval, including existing
        # publishers that did not answer our initial announcement.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.05)
        topics = [{'name': name, 'types': types} for name, types in node.get_topic_names_and_types()]
        print(json.dumps({'topics': sorted(topics, key=lambda value: value['name'])}), flush=True)
    finally:
        node.destroy_node()
        rclpy.shutdown()


def record(output, topics):
    import yaml
    if not topics or any(not re.fullmatch(r'/[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)*', topic) for topic in topics):
        raise ValueError('Select at least one valid ROS topic')
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    # rosbag2 requires a nonexistent output directory. An exclusive sidecar
    # reserves its name without precreating that directory or overwriting data.
    lock = output.parent / ('.' + output.name + '.lock')
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    process = None
    stop = threading.Event()
    started_at = time.time()
    ready = False
    try:
        if output.exists():
            raise ValueError('Recording directory already exists; wait for the next second')
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: stop.set())
        command = ['ros2', 'bag', 'record', '--storage', 'mcap', '--output', str(output),
                   '--disable-keyboard-controls', '--include-hidden-topics', '--topics', *dict.fromkeys(topics)]
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, bufsize=1)
        def logs():
            for line in process.stdout:
                output_line(line.rstrip())
        reader = threading.Thread(target=logs, daemon=True)
        reader.start()
        last_progress = 0.0
        while process.poll() is None and not stop.is_set():
            files = list(output.glob('*.mcap'))
            if files and not ready:
                ready = True
                event('ready', topics=topics, output_directory=str(output), capture_format='rosbag2')
            if ready and time.monotonic() - last_progress >= 1:
                size = sum(path.stat().st_size for path in files)
                event('progress', bytes_written=size, topics=topics, status='recording')
                last_progress = time.monotonic()
            stop.wait(0.1)
        if process.poll() is None:
            process.send_signal(signal.SIGINT)  # Flush the bag and write metadata.yaml.
            try:
                process.wait(timeout=18)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise RuntimeError('ROS bag did not finalize within 18 seconds')
        reader.join(timeout=3)
        if process.returncode != 0:
            raise RuntimeError(f'ros2 bag record exited with code {process.returncode}; see ROS output')
        metadata_path = output / 'metadata.yaml'
        if not ready or not metadata_path.is_file():
            raise RuntimeError('ROS bag stopped before writing valid bag metadata')
        metadata = yaml.safe_load(metadata_path.read_text())['rosbag2_bagfile_information']
        session = {'status': 'complete', 'capture_format': 'rosbag2', 'topics': topics,
                   'message_count': metadata.get('message_count', 0),
                   'started_at': started_at, 'finished_at': time.time()}
        (output / 'session.json').write_text(json.dumps(session, indent=2) + '\n')
        event('complete', **session)
        return 0
    except BaseException as error:
        event('error', error=str(error))
        return 1
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list-topics', action='store_true')
    parser.add_argument('--output')
    parser.add_argument('--topics', nargs='+')
    args = parser.parse_args()
    if args.list_topics:
        list_topics()
        return 0
    if not args.output or not args.topics:
        parser.error('--output and --topics are required for recording')
    return record(args.output, args.topics)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        event('error', error=str(error))
        sys.exit(1)
