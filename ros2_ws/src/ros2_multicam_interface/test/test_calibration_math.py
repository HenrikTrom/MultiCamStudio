#!/usr/bin/env python3
"""Numerical regression: distortion and non-identity reference camera poses."""
import json
from pathlib import Path
import sys
import tempfile
import cv2
import numpy as np
sys.path.insert(0, '/opt/mcs/ros2/lib/ros2_multicam_interface')
from check_calibration import load_calibration, triangulate_and_reproject, validate

points = np.array([[-120, -70, 1400], [80, -50, 1550], [-60, 90, 1600], [100, 100, 1700]], dtype=float)
cameras, observations, entries = {}, {}, []
for index, sn in enumerate(['101', '202', '303']):
    rotation_vector = np.array([0.01 * index, 0.05 + index * 0.02, -0.01], dtype=float)
    rotation, _ = cv2.Rodrigues(rotation_vector)
    pose = np.eye(4)
    pose[:3, :3] = rotation
    pose[:3, 3] = [35 - index * 180, 20 + index * 10, 50 + index * 5]
    intrinsic = np.array([[800, 0, 320], [0, 805, 240], [0, 0, 1]], dtype=float)
    distortion = np.array([-0.12, 0.03, 0.001, -0.002, 0.001])
    observed, _ = cv2.projectPoints(points, rotation_vector, pose[:3, 3], intrinsic, distortion)
    cameras[sn] = {'K': intrinsic, 'pose': pose, 'distortion': distortion}
    observations[sn] = observed.reshape(-1, 2)
    entries.append({'SerialNumber': sn, 'Intrinsic': intrinsic.flatten().tolist(),
                    'Extrinsic': pose.flatten().tolist(), 'Distortion': distortion.tolist()})
projected, errors = triangulate_and_reproject(observations, cameras)
assert max(float(np.max(error)) for error in errors.values()) < 0.001, errors
with tempfile.TemporaryDirectory() as temporary:
    path = Path(temporary) / 'Calibration640x480.json'
    path.write_text(json.dumps({'CAMERAS': entries}))
    load_calibration(path, ['101', '202', '303'])
    entries[0]['Intrinsic'][0] = float('nan')
    path.write_text(json.dumps({'CAMERAS': entries}))
    try:
        load_calibration(path, ['101', '202', '303'])
        raise AssertionError('Invalid calibration was accepted')
    except ValueError:
        pass
    try:
        validate({'101': np.zeros((120, 160, 3), dtype=np.uint8),
                  '202': np.zeros((120, 162, 3), dtype=np.uint8)}, {}, path, Path(temporary) / 'result')
        raise AssertionError('Mixed resolutions were accepted')
    except ValueError as error:
        assert 'same resolution' in str(error)
print('PASS: distorted observations, non-identity poses, invalid calibration, resolution validation')
