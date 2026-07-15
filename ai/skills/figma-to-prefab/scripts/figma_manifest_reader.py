#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Compact reader for figma-to-prefab MCP manifest artifacts.

The MCP export can write large node/image manifests, and image exports may carry
base64 payloads. This reader prints a bounded summary for agent decisions without
loading full JSON into the conversation.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


DEFAULT_MANIFEST_DIR = Path(".tmp/figma-to-prefab")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def safe_number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def summarize_nodes(node_manifest: dict[str, Any], max_samples: int) -> dict[str, Any]:
    nodes = node_manifest.get("nodes") if isinstance(node_manifest.get("nodes"), list) else []
    by_type: Counter[str] = Counter(str(node.get("type") or "UNKNOWN") for node in nodes if isinstance(node, dict))
    root_id = str(node_manifest.get("rootNodeId") or "")
    root = next((node for node in nodes if isinstance(node, dict) and str(node.get("id") or "") == root_id), None)
    if root is None and nodes:
        root = nodes[0] if isinstance(nodes[0], dict) else None

    child_counts = []
    large_nodes = []
    text_samples = []
    instance_samples = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        child_ids = node.get("childIds") if isinstance(node.get("childIds"), list) else []
        if child_ids:
            child_counts.append(len(child_ids))
        bounds = node.get("relativeBounds") if isinstance(node.get("relativeBounds"), dict) else node.get("bounds")
        area = 0.0
        if isinstance(bounds, dict):
            area = safe_number(bounds.get("width")) * safe_number(bounds.get("height"))
        if area > 0:
            large_nodes.append({
                "id": node.get("id"),
                "name": node.get("name"),
                "type": node.get("type"),
                "area": round(area, 2),
            })
        if node.get("type") == "TEXT" and len(text_samples) < max_samples:
            text_samples.append({
                "id": node.get("id"),
                "name": node.get("name"),
                "characters": str(node.get("characters") or "")[:80],
                "fontSize": node.get("fontSize"),
            })
        if node.get("type") == "INSTANCE" and len(instance_samples) < max_samples:
            component = node.get("component") if isinstance(node.get("component"), dict) else {}
            instance_samples.append({
                "id": node.get("id"),
                "name": node.get("name"),
                "componentName": component.get("componentName") or component.get("mainComponentName"),
                "componentSetName": component.get("componentSetName") or component.get("mainComponentSetName"),
            })

    large_nodes.sort(key=lambda item: item["area"], reverse=True)
    return {
        "root": {
            "id": root.get("id") if root else root_id,
            "name": root.get("name") if root else node_manifest.get("rootName"),
            "type": root.get("type") if root else None,
            "childCount": len(root.get("childIds", [])) if root else None,
            "bounds": root.get("relativeBounds") or root.get("bounds") if root else node_manifest.get("rootBounds"),
        },
        "nodeCount": len(nodes),
        "nodeTypes": dict(sorted(by_type.items())),
        "maxChildCount": max(child_counts) if child_counts else 0,
        "largeNodeSamples": large_nodes[:max_samples],
        "textSamples": text_samples,
        "instanceSamples": instance_samples,
    }


def summarize_exports(image_manifest: dict[str, Any], max_samples: int) -> dict[str, Any]:
    exports = image_manifest.get("exports") if isinstance(image_manifest.get("exports"), list) else []
    by_type: Counter[str] = Counter(str(item.get("imageType") or item.get("sliceKind") or "UNKNOWN") for item in exports if isinstance(item, dict))
    missing_base64 = []
    large_exports = []
    total_base64_chars = 0
    for item in exports:
        if not isinstance(item, dict):
            continue
        raw = item.get("base64")
        if raw:
            total_base64_chars += len(str(raw))
        else:
            missing_base64.append({"nodeId": item.get("nodeId"), "nodePath": item.get("nodePath")})
        byte_length = safe_number(item.get("byteLength"))
        if byte_length > 0:
            large_exports.append({
                "nodeId": item.get("nodeId"),
                "nodePath": item.get("nodePath"),
                "imageType": item.get("imageType"),
                "sliceKind": item.get("sliceKind"),
                "byteLength": int(byte_length),
            })
    large_exports.sort(key=lambda item: item["byteLength"], reverse=True)
    return {
        "exportCount": len(exports),
        "imageTypes": dict(sorted(by_type.items())),
        "missingBase64Count": len(missing_base64),
        "missingBase64Samples": missing_base64[:max_samples],
        "largeExportSamples": large_exports[:max_samples],
        "totalBase64Chars": total_base64_chars,
    }


def build_summary(manifest_dir: Path, max_samples: int) -> dict[str, Any]:
    node_path = manifest_dir / "figma_node_manifest.json"
    image_path = manifest_dir / "image_export_manifest.json"
    result_path = manifest_dir / "figma_to_prefab_mcp_result.json"

    node_manifest = load_json(node_path) if node_path.exists() else {}
    image_manifest = load_json(image_path) if image_path.exists() else {}
    result_payload = load_json(result_path) if result_path.exists() else {}
    result = result_payload.get("result") if isinstance(result_payload.get("result"), dict) else result_payload
    result = result if isinstance(result, dict) else {}
    warnings = result.get("warnings") if isinstance(result.get("warnings"), list) else []
    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    blocking = result.get("blockingErrors") if isinstance(result.get("blockingErrors"), list) else []

    return {
        "manifestDir": manifest_dir.as_posix(),
        "files": {
            "nodeManifest": node_path.as_posix() if node_path.exists() else "",
            "imageManifest": image_path.as_posix() if image_path.exists() else "",
            "result": result_path.as_posix() if result_path.exists() else "",
        },
        "result": {
            "status": result.get("status"),
            "rootNodeId": result.get("rootNodeId") or node_manifest.get("rootNodeId"),
            "rootName": result.get("rootName") or node_manifest.get("rootName"),
            "warningCount": len(warnings),
            "blockingErrorCount": len(blocking),
            "errorCount": len(errors),
            "warningSamples": warnings[:max_samples],
            "blockingErrorSamples": blocking[:max_samples],
            "errorSamples": errors[:max_samples],
        },
        "nodes": summarize_nodes(node_manifest, max_samples),
        "images": summarize_exports(image_manifest, max_samples),
    }


def render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Figma To Prefab Manifest Summary",
        "",
        f"- manifestDir: `{summary['manifestDir']}`",
        f"- status: `{summary['result'].get('status')}`",
        f"- root: `{summary['result'].get('rootName')}` (`{summary['result'].get('rootNodeId')}`)",
        f"- nodes: `{summary['nodes'].get('nodeCount')}`",
        f"- exports: `{summary['images'].get('exportCount')}`",
        f"- warnings/errors/blocking: `{summary['result'].get('warningCount')}` / `{summary['result'].get('errorCount')}` / `{summary['result'].get('blockingErrorCount')}`",
        "",
        "## Node Types",
    ]
    for key, value in summary["nodes"].get("nodeTypes", {}).items():
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## Image Types"])
    for key, value in summary["images"].get("imageTypes", {}).items():
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## Large Nodes"])
    for item in summary["nodes"].get("largeNodeSamples", []):
        lines.append(f"- `{item.get('id')}` {item.get('type')} `{item.get('name')}` area={item.get('area')}")
    lines.extend(["", "## Large Exports"])
    for item in summary["images"].get("largeExportSamples", []):
        lines.append(f"- `{item.get('nodeId')}` {item.get('imageType')}/{item.get('sliceKind')} `{item.get('nodePath')}` bytes={item.get('byteLength')}")
    if summary["result"].get("warningSamples"):
        lines.extend(["", "## Warning Samples"])
        for item in summary["result"]["warningSamples"]:
            lines.append(f"- {item}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Compact figma-to-prefab manifest reader")
    parser.add_argument("--manifest-dir", type=Path, default=DEFAULT_MANIFEST_DIR)
    parser.add_argument("--output", type=Path, default=Path(".tmp/figma-to-prefab/manifest_summary.md"))
    parser.add_argument("--json-output", type=Path, default=Path(".tmp/figma-to-prefab/manifest_summary.json"))
    parser.add_argument("--max-samples", type=int, default=8)
    parser.add_argument("--stdout-json", action="store_true")
    args = parser.parse_args()

    summary = build_summary(args.manifest_dir, max(0, args.max_samples))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_markdown(summary), encoding="utf-8")
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    compact = {
        "status": summary["result"].get("status"),
        "manifestDir": summary["manifestDir"],
        "summary": args.output.as_posix(),
        "jsonSummary": args.json_output.as_posix(),
        "rootNodeId": summary["result"].get("rootNodeId"),
        "rootName": summary["result"].get("rootName"),
        "nodeCount": summary["nodes"].get("nodeCount"),
        "exportCount": summary["images"].get("exportCount"),
        "warningCount": summary["result"].get("warningCount"),
        "blockingErrorCount": summary["result"].get("blockingErrorCount"),
        "errorCount": summary["result"].get("errorCount"),
    }
    print("[SUMMARY_JSON]")
    print(json.dumps(summary if args.stdout_json else compact, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
