import csv
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from align_pupil_timestamps import align_csv, host_time_ns, load_estimates


class AlignmentTests(unittest.TestCase):
    def test_interpolates_offset_and_preserves_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log, source, output = root / "clock.jsonl", root / "gaze.csv", root / "aligned.csv"
            records = [
                {"record_type": "metadata"},
                {"record_type": "measurement", "success": True},
                {"record_type": "estimate", "success": False},
            ]
            for pupil, offset in [(40.0, 60.0), (50.0, 60.002)]:
                records.append({"record_type": "estimate", "success": True, "tracker": "Pupil 1",
                                "endpoint": "tcp://localhost:50020", "pupil_time_s": pupil,
                                "estimated_host_minus_pupil_s": offset})
            log.write_text("".join(json.dumps(record) + "\n" for record in records))
            source.write_text("gaze_timestamp,confidence\n40,0.9\n45,0.8\n50,1.0\n")
            align_csv(log, "Pupil 1", source, output, "gaze_timestamp")
            with output.open() as result:
                rows = list(csv.DictReader(result))
            self.assertEqual([row["host_monotonic_ns"] for row in rows],
                             ["100000000000", "105001000000", "110002000000"])
            self.assertEqual(rows[1]["confidence"], "0.8")
            self.assertEqual(load_estimates(log, "tcp://localhost:50020"), [(40.0, 60.0), (50.0, 60.002)])
            with self.assertRaises(ValueError):
                load_estimates(log, "unknown")
            # Failed conversion must preserve an existing output file.
            output.write_text("existing output")
            source.write_text("gaze_timestamp\n1\n")
            with self.assertRaises(ValueError):
                align_csv(log, "Pupil 1", source, output, "gaze_timestamp")
            self.assertEqual(output.read_text(), "existing output")
            with self.assertRaises(ValueError):
                align_csv(log, "Pupil 1", source, source, "gaze_timestamp")
            # Backward Pupil time makes a mapping ambiguous.
            records[-1]["pupil_time_s"] = 30
            log.write_text("".join(json.dumps(record) + "\n" for record in records))
            with self.assertRaisesRegex(ValueError, "discontinuity"):
                load_estimates(log, "Pupil 1")

    def test_refuses_extrapolation_and_nonfinite_time(self):
        for pupil in (39.0, 51.0, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                host_time_ns(pupil, [(40.0, 60.0), (50.0, 60.0)])


if __name__ == "__main__":
    unittest.main()
