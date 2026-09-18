#!/usr/bin/env python3
"""Plan generic ComponentSet conversions from a Figma hierarchy analysis."""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any


STRUCTURAL_NAMES = {
    "Bg",
    "Content",
    "Footer",
    "Header",
    "ListRoot",
    "ProgressSection",
    "ScrollView",
    "TabBar",
    "Viewport",
}

GENERATED_PREFIXES = (
    "ComponentLibrary_",
    "ComponentSourceBackup_",
    "VariantSource_",
)

INDEXED_NAME_RE = re.compile(r"^\[(?P<base>[A-Za-z][A-Za-z0-9]*)_(?P<index>\d+)(?:_(?P<state>[^\]]+))?\]$")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def result_of(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    return result if isinstance(result, dict) else payload


def node_id_of(node: dict[str, Any]) -> str:
    return str(node.get("id") or node.get("nodeId") or "")


def strip_brackets(name: str) -> str:
    text = str(name or "").strip()
    if text.startswith("[") and text.endswith("]"):
        return text[1:-1]
    return text


def is_generated_or_structural(name: str) -> bool:
    plain = strip_brackets(name)
    return plain in STRUCTURAL_NAMES or any(plain.startswith(prefix) for prefix in GENERATED_PREFIXES)


def indexed_name_parts(name: str) -> dict[str, str] | None:
    match = INDEXED_NAME_RE.match(str(name or "").strip())
    if not match:
        return None
    base = match.group("base")
    if base in STRUCTURAL_NAMES:
        return None
    state = match.group("state") or f"Variant{match.group('index')}"
    return {
        "base": base,
        "index": match.group("index"),
        "state": state,
    }


def bounds_of(node: dict[str, Any]) -> dict[str, float]:
    bounds = node.get("bounds") if isinstance(node.get("bounds"), dict) else {}
    return {
        "x": float(bounds.get("x") or node.get("x") or 0),
        "y": float(bounds.get("y") or node.get("y") or 0),
        "width": float(bounds.get("width") or node.get("width") or 0),
        "height": float(bounds.get("height") or node.get("height") or 0),
    }


def child_index(node: dict[str, Any], fallback: int) -> int:
    value = node.get("index")
    return int(value) if isinstance(value, int) else fallback


def collect_nodes(result: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = result.get("nodes")
    output = [node for node in nodes if isinstance(node, dict)] if isinstance(nodes, list) else []
    if output:
        return output
    direct = result.get("directChildren")
    if isinstance(direct, list):
        root_id = str(result.get("rootNodeId") or "")
        output.append({
            "id": root_id,
            "name": str(result.get("rootName") or ""),
            "type": str(result.get("nodeType") or ""),
            "parentId": "",
            "index": 0,
            "bounds": result.get("rootBounds") if isinstance(result.get("rootBounds"), dict) else {},
        })
        for index, child in enumerate(node for node in direct if isinstance(node, dict)):
            item = dict(child)
            item["parentId"] = root_id
            item.setdefault("index", index)
            output.append(item)
    return output


def build_children_by_parent(nodes: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_parent: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in nodes:
        parent_id = str(node.get("parentId") or "")
        if parent_id:
            by_parent[parent_id].append(node)
    for parent_id, children in by_parent.items():
        children.sort(key=lambda node: child_index(node, 0))
    return by_parent


def normalize_state(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip()).strip("_")
    return text or "Default"


def candidate_group_from_children(parent: dict[str, Any], children: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    parent_id = node_id_of(parent)
    parent_name = str(parent.get("name") or "")
    if not parent_id or is_generated_or_structural(parent_name) and strip_brackets(parent_name).startswith("Component"):
        return None, None

    source_rows: list[dict[str, Any]] = []
    skipped_instances = 0
    for fallback, child in enumerate(children):
        child_type = str(child.get("type") or "")
        child_name = str(child.get("name") or "")
        if child_type == "INSTANCE":
            skipped_instances += 1
            continue
        if child_type in {"COMPONENT", "COMPONENT_SET"}:
            continue
        if child_type != "FRAME" or is_generated_or_structural(child_name):
            continue
        parts = indexed_name_parts(child_name)
        if not parts:
            continue
        source_rows.append({
            "node": child,
            "parts": parts,
            "index": child_index(child, fallback),
            "bounds": bounds_of(child),
        })

    if skipped_instances and not source_rows:
        return None, {
            "code": "skippedAlreadyInstance",
            "parentId": parent_id,
            "parentName": parent_name,
            "instanceCount": skipped_instances,
        }
    if len(source_rows) < 2:
        return None, None

    by_base: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in source_rows:
        by_base[row["parts"]["base"]].append(row)
    base, rows = max(by_base.items(), key=lambda item: len(item[1]))
    if len(rows) < 2:
        return None, None

    direct_child_ids = {node_id_of(child) for child in children}
    row_ids = [node_id_of(row["node"]) for row in rows]
    if any(not node_id for node_id in row_ids):
        return None, {"code": "emptyNodeId", "parentId": parent_id, "parentName": parent_name}
    if len(set(row_ids)) != len(row_ids):
        return None, {"code": "duplicateNodeId", "parentId": parent_id, "parentName": parent_name}
    if any(node_id not in direct_child_ids for node_id in row_ids):
        return None, {"code": "nonDirectChildSource", "parentId": parent_id, "parentName": parent_name}

    rows.sort(key=lambda row: row["index"])
    states = [normalize_state(row["parts"]["state"]) for row in rows]
    duplicate_state = len(set(states)) != len(states)
    groups = []
    for row, state in zip(rows, states):
        index_value = row["parts"]["index"]
        properties = {"State": state}
        if duplicate_state:
            properties["Index"] = index_value
        groups.append({
            "name": str(row["node"].get("name") or ""),
            "nodeIds": [node_id_of(row["node"])],
            "value": state,
            "properties": properties,
        })

    return {
        "schemaVersion": 1,
        "target": {
            "nodeId": parent_id,
            "name": parent_name,
        },
        "componentSetName": base,
        "variantProperty": "State",
        "replaceOriginalsWithInstances": True,
        "createBackup": True,
        "groups": groups,
        "metadata": {
            "generatedBy": "plan_auto_component_sets",
            "parentId": parent_id,
            "parentName": parent_name,
            "sourceRule": "indexed-sibling-frame-name",
            "duplicateStateRequiresIndex": duplicate_state,
            "sourceNodeCount": len(groups),
        },
    }, None


def find_auto_component_set_plans(analysis_payload: dict[str, Any]) -> dict[str, Any]:
    result = result_of(analysis_payload)
    nodes = collect_nodes(result)
    by_id = {node_id_of(node): node for node in nodes if node_id_of(node)}
    children_by_parent = build_children_by_parent(nodes)
    plans: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen_targets: set[str] = set()

    for parent_id, children in children_by_parent.items():
        parent = by_id.get(parent_id, {"id": parent_id, "name": ""})
        plan, skip = candidate_group_from_children(parent, children)
        if skip:
            skipped.append(skip)
        if not plan:
            continue
        target_id = str(plan.get("target", {}).get("nodeId") or "")
        component_set_name = str(plan.get("componentSetName") or "")
        key = f"{target_id}:{component_set_name}"
        if key in seen_targets:
            continue
        seen_targets.add(key)
        plans.append(plan)

    return {
        "status": "completed",
        "rootNodeId": str(result.get("rootNodeId") or ""),
        "rootName": str(result.get("rootName") or ""),
        "planCount": len(plans),
        "plans": plans,
        "skipped": skipped,
        "warnings": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Plan generic ComponentSet conversions from hierarchy analysis")
    parser.add_argument("--analysis", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = find_auto_component_set_plans(load_json(args.analysis))
    write_json(args.output, report)
    print(json.dumps({
        "status": report["status"],
        "output": args.output.as_posix(),
        "planCount": report["planCount"],
        "skippedCount": len(report["skipped"]),
    }, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
