#!/usr/bin/env python3
"""Regression for full-resolution H.264 previews, without ROS publishers.

CPU: python3 test_encoder.py
GPU: python3 test_encoder.py --encoder h264_nvenc --channels 8
"""
import argparse
import json
import os
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--encoder', choices=['libx264', 'h264_nvenc'], default='libx264')
    parser.add_argument('--channels', type=int, default=1)
    args = parser.parse_args()
    binary = os.environ.get('STREAMER_EXECUTABLE',
                            '/opt/mcs/ros2/lib/ros2_multicam_interface/camera_tab_ros2_web_streamer')
    probe = subprocess.run([binary, '--check-encoder', args.encoder, '2048', '1536', str(args.channels)],
                           capture_output=True, text=True, timeout=30)
    assert probe.returncode == 0, probe.stdout + probe.stderr
    result = json.loads(next(line for line in probe.stdout.splitlines() if line.startswith('{')))
    assert result['success'] and (result['width'], result['height']) == (2048, 1536), result
    assert len(result['channels']) == args.channels, result
    for channel in result['channels']:
        assert channel['encoder'] == args.encoder, result
        assert channel['codec'].startswith('avc1.64'), result
        # 2048x1536 exceeds level 4.2's max frame size even below 30 fps.
        assert int(channel['codec'][-2:], 16) >= 50, result
    rejected = subprocess.run([binary, '--check-encoder', args.encoder, '2047', '1536', '1'],
                              capture_output=True, text=True, timeout=10)
    assert rejected.returncode != 0, rejected.stdout
    print(f'PASS: {args.channels} simultaneous 2048x1536 {args.encoder} previews; matching H.264 level; odd dimensions rejected')


if __name__ == '__main__':
    main()
