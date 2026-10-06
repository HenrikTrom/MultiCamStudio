#!/usr/bin/env python3

import json
import argparse


def main():
    parser = argparse.ArgumentParser(
        description="Replace a value in a JSON file."
    )
    parser.add_argument("input", help="Input JSON file")
    parser.add_argument("output", help="Output JSON file")

    args = parser.parse_args()

    # Read JSON
    with open(args.input, "r") as f:
        data = json.load(f)

    data["fps"] = 2
    data["save_dir"] = "/home/docker/workspace/data/calib_videos"

    # Write modified JSON
    with open(args.output, "w") as f:
        json.dump(data, f, indent=4)

if __name__ == "__main__":
    main()