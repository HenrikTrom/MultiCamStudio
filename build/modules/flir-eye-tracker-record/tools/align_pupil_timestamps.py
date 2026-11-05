#!/usr/bin/env python3
"""Map an exported Pupil CSV into the recorder's CLOCK_MONOTONIC domain."""

import argparse
import bisect
import csv
import json
import math
import os
from pathlib import Path
import tempfile


def load_estimates(path, tracker):
    """Read estimates in acquisition order; refuse ambiguous clock resets."""
    grouped = {}
    with open(path, encoding="utf-8") as source:
        for line in source:
            record = json.loads(line)
            if record.get("record_type") != "estimate" or not record.get("success"):
                continue
            if tracker not in (record["tracker"], record["endpoint"]):
                continue
            grouped.setdefault(record["endpoint"], []).append(record)
    if len(grouped) != 1:
        raise ValueError("Select exactly one tracker with successful measurements by name or endpoint")
    points = []
    for record in next(iter(grouped.values())):
        pupil = record["pupil_time_s"]
        offset = record["estimated_host_minus_pupil_s"]
        host = pupil + offset
        if not all(math.isfinite(value) for value in (pupil, offset, host)):
            raise ValueError("Non-finite clock estimate")
        if points and (pupil <= points[-1][0] or host <= points[-1][0] + points[-1][1]):
            raise ValueError("Clock discontinuity: split the recording into clock epochs before alignment")
        points.append((pupil, offset))
    if len(points) < 2:
        raise ValueError("At least two clock estimates are required to interpolate")
    return points


def host_time_ns(pupil, points):
    if not math.isfinite(pupil) or not points[0][0] <= pupil <= points[-1][0]:
        raise ValueError(f"Pupil timestamp {pupil} lies outside the measured clock range")
    position = min(max(bisect.bisect_right(points, (pupil, math.inf)) - 1, 0), len(points) - 2)
    left, right = points[position], points[position + 1]
    weight = (pupil - left[0]) / (right[0] - left[0])
    offset = left[1] + weight * (right[1] - left[1])
    return round((pupil + offset) * 1_000_000_000)


def align_csv(clock_log, tracker, input_path, output_path, timestamp_column):
    if Path(input_path).resolve() == Path(output_path).resolve():
        raise ValueError("Input and output CSV paths must differ")
    if Path(clock_log).resolve() == Path(output_path).resolve():
        raise ValueError("Output must not overwrite the clock log")
    points = load_estimates(clock_log, tracker)
    temporary_path = None
    try:
        with open(input_path, newline="", encoding="utf-8-sig") as source:
            reader = csv.DictReader(source)
            if not reader.fieldnames or timestamp_column not in reader.fieldnames:
                raise ValueError(f"Missing CSV column: {timestamp_column}")
            if "host_monotonic_ns" in reader.fieldnames:
                raise ValueError("CSV already contains host_monotonic_ns")
            with tempfile.NamedTemporaryFile(mode="w", newline="", encoding="utf-8",
                                             dir=Path(output_path).parent, delete=False) as output:
                temporary_path = output.name
                writer = csv.DictWriter(output, fieldnames=reader.fieldnames + ["host_monotonic_ns"])
                writer.writeheader()
                for line_number, row in enumerate(reader, 2):
                    try:
                        row["host_monotonic_ns"] = str(host_time_ns(float(row[timestamp_column]), points))
                    except (ValueError, TypeError) as error:
                        raise ValueError(f"CSV row {line_number}: {error}") from error
                    writer.writerow(row)
        os.replace(temporary_path, output_path)
        temporary_path = None
    finally:
        if temporary_path:
            os.unlink(temporary_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clock_log", help="Session clock_measurements.jsonl")
    parser.add_argument("input_csv", help="Exported Pupil CSV, with timestamps in seconds")
    parser.add_argument("output_csv")
    parser.add_argument("--tracker", required=True, help="Tracker name or tcp:// endpoint")
    parser.add_argument("--timestamp-column", required=True, help="For example gaze_timestamp or pupil_timestamp")
    args = parser.parse_args()
    try:
        align_csv(args.clock_log, args.tracker, args.input_csv, args.output_csv, args.timestamp_column)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Alignment failed: {error}\n")


if __name__ == "__main__":
    main()
