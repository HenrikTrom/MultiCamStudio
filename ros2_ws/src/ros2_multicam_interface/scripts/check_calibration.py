#!/usr/bin/env python3
"""Validate calibration against a synchronized ROS RGB8 image set.

Adapted from multi-camera-calib/scripts/check_transform.py without camera SDKs.
Triangulation undistorts detections; reprojection uses each camera's full pose
and distortion, including when the reference camera pose is not identity.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import sys
import cv2
import numpy as np
from ros_images import capture_synchronized


def load_calibration(path, serials):
    document = json.loads(Path(path).read_text())
    cameras = {}
    for entry in document["CAMERAS"]:
        sn = entry["SerialNumber"]
        if sn in cameras:
            raise ValueError("Duplicate camera in calibration: " + sn)
        matrix = np.asarray(entry["Intrinsic"], dtype=float).reshape(3, 3)
        pose = np.asarray(entry["Extrinsic"], dtype=float).reshape(4, 4)
        distortion = np.asarray(entry["Distortion"], dtype=float).reshape(-1)
        if not all(np.isfinite(value).all() for value in (matrix, pose, distortion)):
            raise ValueError("Calibration contains non-finite camera parameters")
        if matrix[0, 0] <= 0 or matrix[1, 1] <= 0 or abs(np.linalg.det(matrix)) < 1e-12:
            raise ValueError("Invalid camera intrinsics for " + sn)
        if not np.allclose(pose[3], [0, 0, 0, 1], atol=1e-5) or not np.allclose(
                pose[:3, :3] @ pose[:3, :3].T, np.eye(3), atol=1e-3):
            raise ValueError("Invalid camera pose for " + sn)
        cameras[sn] = {"K": matrix, "pose": pose, "distortion": distortion}
    if set(cameras) != set(serials) or len(serials) < 2:
        raise ValueError("Calibration must contain exactly the configured cameras (at least two)")
    return cameras, document


def detect_patterns(images, settings, output):
    dictionary = cv2.aruco.getPredefinedDictionary(settings["charuco_params_dict"])
    square = settings["charuco_params_square_size"]
    board = cv2.aruco.CharucoBoard((settings["pattern_size_first"], settings["pattern_size_second"]),
        square, square * settings["charuco_params_marker_to_square_ratio"], dictionary)
    board.setLegacyPattern(True)  # Match the unchanged native calibrator.
    parameters = cv2.aruco.DetectorParameters()
    parameters.markerBorderBits = settings["charuco_params_marker_border_pixel"]
    detector = cv2.aruco.CharucoDetector(board, detectorParams=parameters)
    detected = {}
    for sn, image in images.items():
        corners, ids, markers, marker_ids = detector.detectBoard(image)
        if ids is None or corners is None or len(ids) < 4:
            raise ValueError(f"Not enough ChArUco corners in camera {sn}; make the calibration board visible")
        detected[sn] = {int(index): point for index, point in zip(ids.flatten(), corners.reshape(-1, 2))}
        annotated = image.copy()
        cv2.aruco.drawDetectedCornersCharuco(annotated, corners, ids)
        if marker_ids is not None:
            cv2.aruco.drawDetectedMarkers(annotated, markers, marker_ids)
        if not cv2.imwrite(str(output / f"{sn}_detected.png"), annotated):
            raise OSError("Could not write validation detection image")
        print(f"Camera {sn}: {len(ids)} ChArUco corners", flush=True)
    common = sorted(set.intersection(*(set(points) for points in detected.values())))
    if len(common) < 4:
        raise ValueError("At least four common ChArUco corners must be visible in all cameras")
    return {sn: np.array([detected[sn][index] for index in common], dtype=float) for sn in images}


def triangulate_and_reproject(observations, cameras):
    serials = list(observations)
    count = len(observations[serials[0]])
    normalized = {sn: cv2.undistortPoints(points.reshape(-1, 1, 2), cameras[sn]["K"],
        cameras[sn]["distortion"]).reshape(-1, 2) for sn, points in observations.items()}
    points = []
    for index in range(count):
        rows = []
        for sn in serials:
            x, y = normalized[sn][index]
            projection = cameras[sn]["pose"][:3]
            rows.extend([x * projection[2] - projection[0], y * projection[2] - projection[1]])
        _, singular, vectors = np.linalg.svd(rows)
        homogeneous = vectors[-1]
        if singular[-2] < 1e-10 or abs(homogeneous[3]) < 1e-12:
            raise ValueError("Degenerate triangulation; check camera baselines and calibration")
        point = homogeneous[:3] / homogeneous[3]
        if not np.isfinite(point).all() or any((cameras[sn]["pose"] @ np.r_[point, 1])[2] <= 0 for sn in serials):
            raise ValueError("Triangulation put a board corner behind a camera")
        points.append(point)
    projected, errors = {}, {}
    for sn in serials:
        camera = cameras[sn]
        rotation, _ = cv2.Rodrigues(camera["pose"][:3, :3])
        coordinates, _ = cv2.projectPoints(np.asarray(points), rotation, camera["pose"][:3, 3],
            camera["K"], camera["distortion"])
        projected[sn] = coordinates.reshape(-1, 2)
        errors[sn] = np.linalg.norm(projected[sn] - observations[sn], axis=1)
    return projected, errors


def validate(images, settings, calibration_file, output, threshold=5.0):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    dimensions = {image.shape[:2] for image in images.values()}
    if len(dimensions) != 1:
        raise ValueError("All camera images must have the same resolution")
    height, width = next(iter(dimensions))
    cameras, document = load_calibration(calibration_file, list(images))
    match = re.search(r"Calibration(\d+)x(\d+)\.json$", str(calibration_file))
    expected = (document.get("image_width"), document.get("image_height"))
    if all(expected):
        if expected != (width, height):
            raise ValueError("Calibration resolution does not match the ROS images")
    elif not match or tuple(map(int, match.groups())) != (width, height):
        raise ValueError("Cannot verify calibration resolution against the ROS images")
    observations = detect_patterns(images, settings, output)
    projected, errors = triangulate_and_reproject(observations, cameras)
    serial = settings["main_cam_serial"]
    if serial not in images:
        raise ValueError("main_cam_serial must be a configured camera")
    preview = images[serial].copy()
    for observed, predicted in zip(observations[serial], projected[serial]):
        cv2.circle(preview, tuple(np.round(observed).astype(int)), 4, (0, 255, 0), 1)
        cv2.drawMarker(preview, tuple(np.round(predicted).astype(int)), (0, 0, 255), cv2.MARKER_CROSS, 14, 1)
    if not cv2.imwrite(str(output / "back_projeced3d.jpg"), preview):
        raise OSError("Could not save validation preview")
    values = np.concatenate(list(errors.values()))
    mean = float(np.mean(values))
    report = {"passed": mean <= threshold, "mean_reprojection_error_px": mean,
        "max_reprojection_error_px": float(np.max(values)), "threshold_px": threshold,
        "points": len(observations[serial]), "width": width, "height": height,
        "per_camera_mean_px": {sn: float(np.mean(error)) for sn, error in errors.items()},
        "calibration_file": str(calibration_file)}
    (output / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("calib_settings_file")
    parser.add_argument("data_dir", help="New validation output directory")
    parser.add_argument("--calibration-file")
    parser.add_argument("--timeout", type=float, default=float(os.getenv("RECORD_START_TIMEOUT_SEC", 15)))
    parser.add_argument("--sync-tolerance-ms", type=float, default=float(os.getenv("RECORD_SYNC_TOLERANCE_MS", 5)))
    parser.add_argument("--max-error-px", type=float, default=float(os.getenv("CALIBRATION_MAX_REPROJECTION_ERROR_PX", 5)))
    args = parser.parse_args()
    if not all(math.isfinite(value) and value > 0 for value in (args.timeout, args.max_error_px)) or not 0 <= args.sync_tolerance_ms <= 100:
        raise ValueError("Invalid validation timeout, tolerance or error threshold")
    settings = json.loads(Path(args.calib_settings_file).read_text())
    images, stamps = capture_synchronized(settings, args.timeout, args.sync_tolerance_ms)
    height, width = next(iter(images.values())).shape[:2]
    calibration = args.calibration_file or str(Path(settings["savedir"]) / f"Calibration{width}x{height}.json")
    report = validate(images, settings, calibration, args.data_dir, args.max_error_px)
    report["source_timestamps_ns"] = stamps
    (Path(args.data_dir) / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    if not report["passed"]:
        print(json.dumps({"event": "error", "error": f"Mean reprojection error {report['mean_reprojection_error_px']:.2f} px exceeds the {args.max_error_px:g} px limit"}), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"event": "error", "error": f"Calibration validation failed: {error}"}), flush=True)
        sys.exit(1)
