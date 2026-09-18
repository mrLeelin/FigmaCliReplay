"""
Figma 层级整理产物健康检查。

职责：
- 检查计划、验证和流水线产物是否存在乱码占位符。
- 汇总计划覆盖率、重复节点和阻塞错误，便于快速复核。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List


def load_json(path: Path) -> Dict[str, Any]:
    """读取 UTF-8 或 UTF-8-BOM JSON 文件。"""
    return json.loads(path.read_text(encoding="utf-8-sig"))


def text_markers(path: Path) -> List[str]:
    """检查文本文件中是否存在常见乱码占位符。"""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    markers: List[str] = []
    if "\ufffd" in text:
        markers.append("U+FFFD")
    if "???" in text:
        markers.append("???")
    return markers


def plan_summary(path: Path, payload: Dict[str, Any]) -> Dict[str, Any]:
    """提取整理计划的关键质量摘要。"""
    groups = payload.get("groups") if isinstance(payload.get("groups"), list) else []
    node_ids = [str(node_id) for group in groups if isinstance(group, dict) for node_id in group.get("childNodeIds", [])]
    duplicate_ids = sorted({node_id for node_id in node_ids if node_ids.count(node_id) > 1})
    return {
        "path": path.as_posix(),
        "type": "plan",
        "groupCount": len(groups),
        "plannedNodeCount": len(node_ids),
        "duplicateNodeCount": len(duplicate_ids),
        "blockingErrorCount": len(payload.get("blockingErrors") or []),
        "warningCount": len(payload.get("warnings") or []),
        "quality": payload.get("summary", {}).get("quality", {}),
    }


def generic_json_summary(path: Path, payload: Dict[str, Any]) -> Dict[str, Any]:
    """提取通用 JSON 产物摘要。"""
    return {
        "path": path.as_posix(),
        "type": "json",
        "status": payload.get("status"),
        "allPass": payload.get("allPass"),
        "blockingErrorCount": len(payload.get("blockingErrors") or []),
        "warningCount": len(payload.get("warnings") or []),
    }


def inspect_path(path: Path) -> Dict[str, Any]:
    """检查单个产物路径。"""
    item: Dict[str, Any] = {"path": path.as_posix(), "exists": path.exists()}
    if not path.exists():
        item["blockingErrors"] = [{"code": "missingArtifact", "message": "产物文件不存在。"}]
        return item

    markers = text_markers(path)
    item["textMarkers"] = markers
    if path.suffix.lower() == ".json":
        payload = load_json(path)
        if isinstance(payload.get("groups"), list):
            item.update(plan_summary(path, payload))
        else:
            item.update(generic_json_summary(path, payload))
    else:
        item["type"] = path.suffix.lower().lstrip(".") or "text"
    return item


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="检查 Figma 层级整理产物健康状态")
    parser.add_argument("paths", nargs="+", type=Path, help="要检查的 JSON/Markdown/TXT 产物路径")
    return parser.parse_args()


def main() -> int:
    """命令行入口。"""
    args = parse_args()
    artifacts = [inspect_path(path) for path in args.paths]
    failed = any(item.get("blockingErrors") or item.get("textMarkers") for item in artifacts)
    report = {
        "allPass": not failed,
        "artifactCount": len(artifacts),
        "artifacts": artifacts,
    }
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report["allPass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
