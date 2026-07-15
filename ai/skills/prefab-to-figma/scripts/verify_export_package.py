#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""验证 prefab-to-figma 导出包，并输出统一审核报告。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from prefab_to_figma import build_export_audit_report  # noqa: E402


def main() -> int:
    """命令行入口，读取导出 JSON 并写出审核报告。"""

    parser = argparse.ArgumentParser(description="验证 prefab-to-figma 导出包")
    parser.add_argument("--package", required=True, help="prefab-to-figma.json 路径")
    parser.add_argument("--output-report", default="", help="审核报告 JSON 输出路径")
    args = parser.parse_args()

    package_path = Path(args.package)
    if not package_path.exists():
        result = _missing_package_result(package_path)
    else:
        package = json.loads(package_path.read_text(encoding="utf-8-sig"))
        result = build_export_audit_report(package, package_path.parent)

    if args.output_report:
        output_path = Path(args.output_report)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))

    print(f"Verify export package allPass={result['allPass']}")
    return 0 if result["allPass"] else 2


def _missing_package_result(package_path: Path) -> dict[str, Any]:
    """生成导出包缺失时的统一阻塞报告。"""

    error = {
        "code": "packageMissing",
        "message": "prefab-to-figma 导出包不存在",
        "details": [{"path": str(package_path)}],
    }
    return {
        "allPass": False,
        "blockingErrors": [error],
        "warnings": [],
        "summary": {"packagePath": str(package_path)},
        "checks": {
            "packageExists": {
                "pass": False,
                "summary": {"path": str(package_path)},
                "details": [{"path": str(package_path)}],
            },
        },
        "artifacts": {"packagePath": str(package_path)},
    }


if __name__ == "__main__":
    raise SystemExit(main())
