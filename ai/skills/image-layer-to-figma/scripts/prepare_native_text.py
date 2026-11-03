#!/usr/bin/env python3
"""Prepare ordinary UI text as native Text before the existing Relay import."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "client"))
from native_text import NativeTextError, prepare_native_text  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = prepare_native_text(args.manifest, args.plan, args.out_dir)
    except (NativeTextError, OSError, ValueError, TypeError) as error:
        parser.exit(2, f"prepare_native_text: {error}\n")
    print(json.dumps({key: report[key] for key in (
        "status", "nativeTextCount", "decorativeRasterTextCount", "layerCount", "figmaWrites")},
        ensure_ascii=False))


if __name__ == "__main__":
    main()
