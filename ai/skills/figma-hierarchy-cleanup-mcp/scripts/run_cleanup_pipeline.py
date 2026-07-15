"""
Figma 层级整理一键流水线。

职责：
- 串联 MCP Relay health、analyze、plan、apply、verify，减少人工重复命令。
- 中间整理默认不截图，只在最后一次 apply 截图，降低 Figma 导出耗时。
- 支持把已创建的语义组继续包成 ScrollView / Viewport / Content 等通用嵌套结构。
"""

from __future__ import annotations

import argparse
import json
import re
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Tuple

from figma_hierarchy_cleanup_mcp_client import (
    DEFAULT_RELAY_URL,
    DEFAULT_OUTPUT_DIR,
    assert_completed,
    build_component_set_from_node_groups_job,
    configure_target,
    ensure_mcp_companion,
    extract_figma_target,
    result_of_payload,
    save_screenshot_if_present,
    submit_job,
    write_json,
)
from plan_auto_component_sets import find_auto_component_set_plans
from plan_figma_hierarchy_cleanup import build_plan, build_psd_prefix_hints, get_direct_children, find_result_payload, write_diagnostic_report, write_report
from verify_figma_hierarchy_cleanup import verify


class PipelineError(RuntimeError):
    """表示流水线无法继续执行。"""


def load_json(path: Path) -> Dict[str, Any]:
    """读取 UTF-8 或 UTF-8-BOM JSON 文件。"""
    return json.loads(path.read_text(encoding="utf-8-sig"))


def result_of(payload: Dict[str, Any]) -> Dict[str, Any]:
    """兼容 MCP Relay 外层 result 包装。"""
    result = payload.get("result")
    return result if isinstance(result, dict) else payload


def direct_children_of(analysis_payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """读取分析结果中的直接子节点。"""
    result = result_of(analysis_payload)
    children = result.get("directChildren")
    return [child for child in children if isinstance(child, dict)] if isinstance(children, list) else []


def node_id_of(node: Dict[str, Any]) -> str:
    """读取节点 id，兼容 nodeId 字段。"""
    return str(node.get("id") or node.get("nodeId") or "")


def normalize_group_name(name: str) -> str:
    """把分组名规范化为方括号格式。"""
    text = str(name or "").strip()
    if not text:
        raise PipelineError("wrapper-chain 中存在空分组名")
    if text.startswith("[") and text.endswith("]"):
        return text
    return f"[{text.strip('[]')}]"


def parse_wrapper_chain(value: str) -> List[str]:
    """解析 [ListRoot]>[ScrollView]>[Viewport]>[Content] 形式的包装链。"""
    parts = [normalize_group_name(part) for part in value.replace("/", ">").split(">") if part.strip()]
    if len(parts) < 2:
        raise PipelineError(f"wrapper-chain 至少需要两个节点：{value}")
    return parts


def run_timed_step(timings: List[Dict[str, Any]], name: str, func: Any) -> Any:
    """执行一个流水线步骤并记录耗时。"""
    started_at = time.perf_counter()
    try:
        result = func()
    except Exception:
        elapsed = time.perf_counter() - started_at
        timings.append({"name": name, "elapsedSeconds": round(elapsed, 3), "status": "failed"})
        raise
    elapsed = time.perf_counter() - started_at
    timings.append({"name": name, "elapsedSeconds": round(elapsed, 3), "status": "completed"})
    return result


def submit_and_save_job(
    relay_url: str,
    job: Dict[str, Any],
    output_path: Path,
    screenshot_suffix: str,
    timeout: float,
    interval: float,
) -> Dict[str, Any]:
    """提交 MCP Relay 任务，先保存结果再检查状态，方便失败时排查。"""
    result_payload = submit_job(relay_url, job, timeout, interval)
    save_screenshot_if_present(result_payload, output_path, screenshot_suffix)
    write_json(output_path, result_payload)
    assert_completed(result_payload)
    return result_payload


def analyze_node(
    args: argparse.Namespace,
    relay_url: str,
    target: Dict[str, str],
    output_path: Path,
    include_screenshot: bool,
) -> Dict[str, Any]:
    """分析指定 Figma 节点，并保存分析结果。"""
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_HIERARCHY_CLEANUP_ANALYZE",
        "name": args.job_name,
        "target": target,
        "options": {
            "includeHidden": not args.exclude_hidden,
            "includeScreenshot": include_screenshot,
            "maxDepth": args.max_depth,
        },
        "assets": [],
    }
    return submit_and_save_job(relay_url, job, output_path, "analysis", args.timeout, args.interval)


def apply_plan(
    args: argparse.Namespace,
    relay_url: str,
    plan: Dict[str, Any],
    output_path: Path,
    include_screenshot: bool,
) -> Dict[str, Any]:
    """应用已确认的整理计划，并保存 apply 结果。"""
    target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    node_id = str(target.get("nodeId") or "")
    if not node_id:
        raise PipelineError("整理计划缺少 target.nodeId")
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_HIERARCHY_CLEANUP_APPLY",
        "name": args.job_name,
        "target": {"nodeId": node_id},
        "plan": plan,
        "options": {"includeScreenshot": include_screenshot},
        "assets": [],
    }
    return submit_and_save_job(relay_url, job, output_path, "apply", args.timeout, args.interval)


def export_screenshot(
    args: argparse.Namespace,
    relay_url: str,
    target: Dict[str, str],
    output_path: Path,
) -> Dict[str, Any]:
    """Export only a PNG screenshot for a target node without full hierarchy analysis."""
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_EXPORT_NODE_SCREENSHOT",
        "name": args.job_name,
        "target": target,
        "options": {},
        "assets": [],
    }
    return submit_and_save_job(relay_url, job, output_path, "screenshot", args.timeout, args.interval)


def apply_component_set_plan(
    args: argparse.Namespace,
    relay_url: str,
    plan: Dict[str, Any],
    output_path: Path,
    include_screenshot: bool,
) -> Dict[str, Any]:
    """Create a ComponentSet from a generated node-group plan and save the result."""
    class ComponentSetArgs:
        pass

    component_args = ComponentSetArgs()
    component_args.job_name = f"{args.job_name}_AutoComponentSet"
    component_args.figma_url = ""
    component_args.node_id = ""
    component_args.file_key = ""
    component_args.no_screenshot = not include_screenshot
    job = build_component_set_from_node_groups_job(plan, component_args)  # type: ignore[arg-type]
    return submit_and_save_job(relay_url, job, output_path, "component_set", args.timeout, args.interval)


def build_wrapper_plan(analysis_payload: Dict[str, Any], wrapper_name: str) -> Dict[str, Any]:
    """把当前节点的全部直接子节点包进一个指定名称的子分组。"""
    result = result_of(analysis_payload)
    children = direct_children_of(analysis_payload)
    if not children:
        raise PipelineError(f"{wrapper_name} 包装失败：当前节点没有直接子节点")

    child_ids = [node_id_of(child) for child in children]
    if any(not node_id for node_id in child_ids):
        raise PipelineError(f"{wrapper_name} 包装失败：存在空 nodeId")

    return {
        "schemaVersion": 1,
        "operation": "figma-hierarchy-cleanup",
        "target": {
            "nodeId": str(result.get("rootNodeId") or result.get("nodeId") or ""),
            "name": str(result.get("rootName") or result.get("nodeName") or ""),
            "fileKey": str(result.get("fileKey") or ""),
            "url": str(result.get("url") or ""),
        },
        "options": {
            "preserveAbsoluteBoundsTolerance": 0.01,
            "createGroupType": "FRAME",
            "renameOriginalNodes": False,
            "allowVisualChanges": False,
        },
        "summary": {
            "directChildCount": len(children),
            "groupCount": 1,
            "rootBounds": result.get("rootBounds") if isinstance(result.get("rootBounds"), dict) else {},
            "pipelineGeneratedWrapper": wrapper_name,
        },
        "groups": [{
            "name": wrapper_name,
            "reason": "流水线生成的通用包装层，用于生产化 ScrollView / Viewport / Content 等嵌套结构。",
            "count": len(children),
            "childNodeIds": child_ids,
            "childNames": [str(child.get("name") or "") for child in children[:12]],
            "sourceIndices": [
                int(child.get("index") if isinstance(child.get("index"), int) else fallback_index)
                for fallback_index, child in enumerate(children)
            ],
        }],
        "warnings": [],
        "blockingErrors": [],
    }


def submit_wrap_chain(
    args: argparse.Namespace,
    relay_url: str,
    target: Dict[str, str],
    wrapper_chain: List[str],
    output_path: Path,
    include_screenshot: bool,
) -> Dict[str, Any]:
    """Create a full wrapper chain in one relay round-trip."""
    if len(wrapper_chain) < 2:
        raise PipelineError("wrap-chain requires at least two names")
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_HIERARCHY_WRAP_CHAIN",
        "name": args.job_name,
        "target": target,
        "wrapperChain": wrapper_chain,
        "options": {"includeScreenshot": include_screenshot},
        "assets": [],
    }
    return submit_and_save_job(relay_url, job, output_path, "wrap_chain", args.timeout, args.interval)


def build_plan_from_groups(analysis_payload: Dict[str, Any], groups: List[Dict[str, Any]], reason: str) -> Dict[str, Any]:
    """Build a cleanup plan from explicit generic groups."""
    result = result_of(analysis_payload)
    children = direct_children_of(analysis_payload)
    expected_ids = [node_id_of(child) for child in children]
    planned_ids = [str(child_id) for group in groups for child_id in group.get("childNodeIds", [])]
    duplicate_ids = sorted({node_id for node_id in planned_ids if planned_ids.count(node_id) > 1})
    if set(expected_ids) != set(planned_ids) or duplicate_ids:
        raise PipelineError(
            "genericNestedPlanMismatch: planned ids must cover each current direct child exactly once; "
            f"missing={sorted(set(expected_ids) - set(planned_ids))}, "
            f"extra={sorted(set(planned_ids) - set(expected_ids))}, duplicates={duplicate_ids}"
        )
    return {
        "schemaVersion": 1,
        "operation": "figma-hierarchy-cleanup",
        "target": {
            "nodeId": str(result.get("rootNodeId") or result.get("nodeId") or ""),
            "name": str(result.get("rootName") or result.get("nodeName") or ""),
            "fileKey": str(result.get("fileKey") or ""),
            "url": str(result.get("url") or ""),
        },
        "options": {
            "preserveAbsoluteBoundsTolerance": 0.01,
            "createGroupType": "FRAME",
            "renameOriginalNodes": False,
            "allowVisualChanges": False,
        },
        "summary": {
            "directChildCount": len(children),
            "groupCount": len(groups),
            "pipelineGeneratedNested": True,
            "reason": reason,
        },
        "groups": groups,
        "warnings": [],
        "blockingErrors": [],
    }


def bounds_of_child(node: Dict[str, Any]) -> Dict[str, float]:
    raw = node.get("relativeBounds") if isinstance(node.get("relativeBounds"), dict) else node.get("bounds")
    raw = raw if isinstance(raw, dict) else {}
    return {
        "x": float(raw.get("x") or 0),
        "y": float(raw.get("y") or 0),
        "width": float(raw.get("width") or 0),
        "height": float(raw.get("height") or 0),
    }


def center_of_child(node: Dict[str, Any]) -> Tuple[float, float]:
    bounds = bounds_of_child(node)
    return bounds["x"] + bounds["width"] * 0.5, bounds["y"] + bounds["height"] * 0.5


def cluster_children_by_axis(children: List[Dict[str, Any]], axis: str, tolerance: float) -> List[List[Dict[str, Any]]]:
    indexed = list(enumerate(children))
    coord_index = 0 if axis == "x" else 1
    indexed.sort(key=lambda item: center_of_child(item[1])[coord_index])
    clusters: List[List[Tuple[int, Dict[str, Any]]]] = []
    for original_index, child in indexed:
        coord = center_of_child(child)[coord_index]
        if not clusters:
            clusters.append([(original_index, child)])
            continue
        last_coord = sum(center_of_child(item[1])[coord_index] for item in clusters[-1]) / len(clusters[-1])
        if abs(coord - last_coord) <= tolerance:
            clusters[-1].append((original_index, child))
        else:
            clusters.append([(original_index, child)])
    return [[child for _index, child in sorted(cluster, key=lambda item: item[0])] for cluster in clusters]


def group_name(prefix: str, index: int, children: List[Dict[str, Any]]) -> str:
    state = infer_state_suffix(children)
    return f"[{prefix}_{index}{('_' + state) if state else ''}]"


def infer_state_suffix(children: List[Dict[str, Any]]) -> str:
    text = " ".join(
        str(value or "").lower()
        for child in children
        for value in (child.get("name"), child.get("path"), child.get("characters"))
    )
    if "selected" in text or "select" in text:
        return "Selected"
    if "complete" in text or "completed" in text:
        return "Completed"
    if "claim" in text or "reward" in text:
        return "Claimable"
    if "lock" in text or "locked" in text:
        return "Locked"
    if "progress" in text or "current" in text:
        return "InProgress"
    return ""


def build_axis_item_plan(analysis_payload: Dict[str, Any], prefix: str, axis: str, reason: str) -> Dict[str, Any]:
    children = direct_children_of(analysis_payload)
    if len(children) < 4:
        raise PipelineError(f"{prefix} generic split requires at least 4 direct children")
    clusters = [cluster for cluster in cluster_children_by_axis(children, axis, 72.0) if cluster]
    if len(clusters) < 2:
        raise PipelineError(f"{prefix} generic split could not find repeated clusters")
    groups: List[Dict[str, Any]] = []
    for index, cluster in enumerate(clusters, start=1):
        cluster = sorted(cluster, key=lambda child: int(child.get("index") if isinstance(child.get("index"), int) else 0))
        cluster_ids = [node_id_of(child) for child in cluster]
        if any(not node_id for node_id in cluster_ids):
            raise PipelineError(f"{prefix} generic split found empty node id")
        groups.append({
            "name": group_name(prefix, index, cluster),
            "reason": reason,
            "count": len(cluster),
            "childNodeIds": cluster_ids,
            "childNames": [str(child.get("name") or "") for child in cluster[:12]],
            "sourceIndices": [
                int(child.get("index") if isinstance(child.get("index"), int) else fallback)
                for fallback, child in enumerate(cluster)
            ],
        })
    return build_plan_from_groups(analysis_payload, groups, reason)


def build_progress_nested_plan(analysis_payload: Dict[str, Any]) -> Dict[str, Any]:
    children = direct_children_of(analysis_payload)
    if len(children) < 4:
        raise PipelineError("ProgressSection generic split requires at least 4 direct children")
    bounded = [(index, child, bounds_of_child(child)) for index, child in enumerate(children)]
    root = result_of(analysis_payload)
    root_bounds = root.get("rootBounds") if isinstance(root.get("rootBounds"), dict) else {}
    root_width = float(root_bounds.get("width") or 0)
    bar_indices = [
        index for index, _child, bounds in bounded
        if bounds["width"] >= max(160.0, root_width * 0.35) and bounds["height"] <= 80.0
    ]
    if not bar_indices:
        bar_indices = [0]
    first_bar = min(bar_indices)
    last_bar = max(bar_indices)
    groups: List[Dict[str, Any]] = []
    cursor = 0
    if first_bar > 0:
        raise PipelineError("ProgressSection split found nodes below ProgressBar range; stop instead of guessing")
    bar_children = children[first_bar:last_bar + 1]
    groups.append({
        "name": "[ProgressBar]",
        "reason": "Generic progress section split: wide low-height nodes form the progress bar.",
        "count": len(bar_children),
        "childNodeIds": [node_id_of(child) for child in bar_children],
        "childNames": [str(child.get("name") or "") for child in bar_children[:12]],
        "sourceIndices": [int(child.get("index") if isinstance(child.get("index"), int) else idx) for idx, child in enumerate(bar_children)],
    })
    cursor = last_bar + 1
    milestone_clusters = cluster_children_by_axis(children[cursor:], "x", 72.0)
    if len(milestone_clusters) < 2:
        raise PipelineError("ProgressSection split could not find repeated milestones")
    for index, cluster in enumerate(milestone_clusters, start=1):
        groups.append({
            "name": group_name("Milestone", index, cluster),
            "reason": "Generic progress section split: repeated horizontal clusters form milestones.",
            "count": len(cluster),
            "childNodeIds": [node_id_of(child) for child in cluster],
            "childNames": [str(child.get("name") or "") for child in cluster[:12]],
            "sourceIndices": [int(child.get("index") if isinstance(child.get("index"), int) else fallback) for fallback, child in enumerate(cluster)],
        })
    return build_plan_from_groups(analysis_payload, groups, "Generic ProgressSection split")


def plan_child_ids(plan: Dict[str, Any]) -> List[str]:
    """Return wrapper plan child ids in planned order."""
    ids: List[str] = []
    for group in plan.get("groups", []):
        if not isinstance(group, dict):
            continue
        for node_id in group.get("childNodeIds", []):
            ids.append(str(node_id))
    return ids


def assert_plan_matches_analysis(
    plan: Dict[str, Any],
    analysis_payload: Dict[str, Any],
    context: str,
    require_order: bool = True,
) -> None:
    """Fail before apply when a wrapper plan was built from stale children."""
    result = result_of(analysis_payload)
    plan_target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    plan_target_id = str(plan_target.get("nodeId") or "")
    analysis_target_id = str(result.get("rootNodeId") or result.get("nodeId") or "")
    if plan_target_id != analysis_target_id:
        raise PipelineError(
            f"staleWrapperPlan: {context} target mismatch; "
            f"plan.target.nodeId={plan_target_id}, current.rootNodeId={analysis_target_id}"
        )

    current_ids = [node_id_of(child) for child in direct_children_of(analysis_payload)]
    planned_ids = plan_child_ids(plan)
    if planned_ids == current_ids:
        return
    current_set = set(current_ids)
    planned_set = set(planned_ids)
    duplicate_ids = sorted({node_id for node_id in planned_ids if planned_ids.count(node_id) > 1})
    if not require_order and current_set == planned_set and not duplicate_ids and len(planned_ids) == len(current_ids):
        return
    raise PipelineError(
        "staleWrapperPlan: "
        f"{context} child ids do not match current direct children; "
        f"missingCurrentChildIds={sorted(current_set - planned_set)}, "
        f"extraStaleChildIds={sorted(planned_set - current_set)}, "
        f"duplicatePlannedIds={duplicate_ids}"
    )


def _created_group_sources(apply_payload: Dict[str, Any]) -> List[Tuple[str, List[Dict[str, Any]]]]:
    """Return every supported created-group list from an apply payload."""
    result = result_of_payload(apply_payload)
    shallow_result = result_of(apply_payload)
    sources: List[Tuple[str, List[Dict[str, Any]]]] = []
    for source_name, container in (
        ("result.artifacts.createdGroups", result.get("artifacts") if isinstance(result, dict) else {}),
        ("result.createdGroups", result if isinstance(result, dict) else {}),
        ("result.topLevelGroups", result if isinstance(result, dict) else {}),
        ("payload.result.artifacts.createdGroups", shallow_result.get("artifacts") if isinstance(shallow_result, dict) else {}),
        ("payload.result.createdGroups", shallow_result if isinstance(shallow_result, dict) else {}),
        ("payload.result.topLevelGroups", shallow_result if isinstance(shallow_result, dict) else {}),
        ("payload.createdGroups", apply_payload),
        ("payload.topLevelGroups", apply_payload),
    ):
        if not isinstance(container, dict):
            continue
        key = source_name.rsplit(".", 1)[-1]
        value = container.get(key)
        if isinstance(value, list):
            groups = [item for item in value if isinstance(item, dict)]
            if groups:
                sources.append((source_name, groups))
    return sources


def extract_single_created_group_id(apply_payload: Dict[str, Any], group_name: str) -> str:
    """Read exactly one new group id from apply result data; never guess."""
    matches: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str, str]] = set()
    all_groups: List[Dict[str, str]] = []
    for source_name, groups in _created_group_sources(apply_payload):
        for group in groups:
            node_id = str(group.get("id") or group.get("nodeId") or "")
            name = str(group.get("name") or "")
            if name:
                all_groups.append({"source": source_name, "name": name, "id": node_id})
            key = (source_name, name, node_id)
            if name != group_name or key in seen:
                continue
            seen.add(key)
            matches.append({"source": source_name, "id": node_id, "name": name})

    ids = sorted({str(item.get("id") or "") for item in matches if str(item.get("id") or "")})
    if len(ids) == 1:
        return ids[0]
    if len(ids) > 1:
        raise PipelineError(
            f"created group {group_name} matched multiple ids: {ids}; stop instead of guessing a nodeId"
        )
    raise PipelineError(
        f"created group {group_name} was not found in apply result; "
        f"available groups={all_groups}; stop instead of guessing a nodeId"
    )


def created_group_id(apply_payload: Dict[str, Any], group_name: str) -> str:
    """Compatibility wrapper; keep all id handoff on the strict extractor."""
    return extract_single_created_group_id(apply_payload, group_name)


def find_created_group(apply_payload: Dict[str, Any], group_name: str, group_id: str) -> Dict[str, Any]:
    """Find the exact created group record returned by apply."""
    for _source_name, groups in _created_group_sources(apply_payload):
        for group in groups:
            if str(group.get("name") or "") == group_name and str(group.get("id") or group.get("nodeId") or "") == group_id:
                return group
    return {}


def synthesize_wrapper_analysis(
    apply_payload: Dict[str, Any],
    wrapper_name: str,
    wrapper_id: str,
    parent_target: Dict[str, str],
) -> Dict[str, Any]:
    """Build the next wrapper before-analysis from the previous apply result.

    This is valid only for the just-created wrapper because apply returns the
    exact original nodes after they were moved into that wrapper.
    """
    result = result_of_payload(apply_payload)
    group = find_created_group(apply_payload, wrapper_name, wrapper_id)
    children = result.get("originalNodesAfter") if isinstance(result.get("originalNodesAfter"), list) else []
    children = [
        child for child in children
        if isinstance(child, dict) and str(child.get("parentId") or "") == wrapper_id
    ]
    direct_children = []
    for index, child in enumerate(child for child in children if isinstance(child, dict)):
        item = dict(child)
        item["index"] = index
        item["parentId"] = wrapper_id
        item.setdefault("visible", True)
        direct_children.append(item)
    if not direct_children:
        raise PipelineError(f"{wrapper_name} synthetic analysis failed: previous apply returned no originalNodesAfter")
    root_bounds = group.get("bounds") if isinstance(group.get("bounds"), dict) else {}
    if not root_bounds:
        root_bounds = result.get("rootBounds") if isinstance(result.get("rootBounds"), dict) else {}
    payload = {
        "status": "completed",
        "allPass": True,
        "rootNodeId": wrapper_id,
        "rootName": wrapper_name,
        "nodeType": str(group.get("type") or "FRAME"),
        "fileKey": str(parent_target.get("fileKey") or result.get("fileKey") or ""),
        "rootBounds": root_bounds,
        "directChildCount": len(direct_children),
        "directChildren": direct_children,
        "nodes": [],
        "topLevelGroups": [],
        "blockingErrors": [],
        "warnings": [{
            "code": "syntheticBeforeAnalysis",
            "message": "Generated from previous apply result to skip a redundant full analyze call."
        }],
        "summary": {
            "rootNodeId": wrapper_id,
            "rootName": wrapper_name,
            "directChildCount": len(direct_children),
            "nodeCount": len(direct_children),
            "synthetic": True,
            "source": "previous-apply-originalNodesAfter"
        },
        "checks": {
            "rootHasChildren": {"pass": len(direct_children) > 0},
            "syntheticSourceComplete": {"pass": True}
        },
        "artifacts": {
            "synthetic": True,
            "sourceApplyRootNodeId": result.get("rootNodeId"),
            "createdGroupId": wrapper_id,
            "createdGroupName": wrapper_name
        }
    }
    return payload


def normalize_path_parts(value: str) -> List[str]:
    """Parse a semantic child path like [ListRoot]>[ScrollView]>[Content]."""
    return [normalize_group_name(part) for part in value.replace("/", ">").split(">") if part.strip()]


def find_child_group_in_analysis(analysis_payload: Dict[str, Any], group_name: str) -> str:
    """Find a direct child group id in an analysis payload by name."""
    matches = [
        node_id_of(child)
        for child in direct_children_of(analysis_payload)
        if str(child.get("name") or "") == group_name and node_id_of(child)
    ]
    if len(matches) == 1:
        return matches[0]
    raise PipelineError(f"expected exactly one direct child named {group_name}, found {matches}")


def analysis_for_created_path(
    root_apply: Dict[str, Any],
    path: str,
    root_target: Dict[str, str],
    analyses_by_id: Dict[str, Dict[str, Any]],
    analyses_by_path: Dict[str, Tuple[str, Dict[str, Any]]] | None = None,
) -> Tuple[str, Dict[str, Any]]:
    """Resolve a created-group path and return its synthesized analysis."""
    parts = normalize_path_parts(path)
    if not parts:
        raise PipelineError("empty semantic stage path")
    normalized_path = ">".join(parts)
    if analyses_by_path and normalized_path in analyses_by_path:
        return analyses_by_path[normalized_path]
    current_name = parts[0]
    current_id = extract_single_created_group_id(root_apply, current_name)
    current_analysis = analyses_by_id.get(current_id)
    if current_analysis is None:
        current_analysis = synthesize_wrapper_analysis(root_apply, current_name, current_id, root_target)
        analyses_by_id[current_id] = current_analysis
    for child_name in parts[1:]:
        child_id = find_child_group_in_analysis(current_analysis, child_name)
        current_id = child_id
        current_name = child_name
        current_analysis = analyses_by_id.get(current_id)
        if current_analysis is None:
            raise PipelineError(
                f"no synthesized analysis available for {path}; missing child analysis for {current_name}/{current_id}"
            )
    return current_id, current_analysis


def verify_and_save(before: Dict[str, Any], after: Dict[str, Any], plan: Dict[str, Any], output_path: Path) -> Dict[str, Any]:
    """执行验证并写入验证报告。"""
    report = verify(before, after, plan)
    write_json(output_path, report)
    if not report.get("allPass"):
        raise PipelineError(f"验证失败：{report.get('blockingErrors')}")
    return report


def make_child_target(parent_target: Dict[str, str], node_id: str) -> Dict[str, str]:
    """基于父目标信息创建子节点 target。"""
    return {
        "url": str(parent_target.get("url") or ""),
        "fileKey": str(parent_target.get("fileKey") or ""),
        "nodeId": node_id,
    }


def write_pipeline_report(path: Path, report: Dict[str, Any]) -> None:
    """写入流水线总报告。"""
    write_json(path, report)


def build_pipeline_cli_summary(report: Dict[str, Any], output_path: Path) -> Dict[str, Any]:
    """构建命令行轻量输出，完整流水线报告只写入文件。"""
    root = report.get("root") if isinstance(report.get("root"), dict) else {}
    return {
        "status": report.get("status"),
        "output": output_path.as_posix(),
        "workDir": report.get("workDir"),
        "root": {
            "analysis": root.get("analysis"),
            "plan": root.get("plan"),
            "report": root.get("report"),
            "diagnosticReport": root.get("diagnosticReport"),
            "warningCodes": [warning.get("code") for warning in root.get("warnings", []) if isinstance(warning, dict)],
            "blockingErrorCodes": [error.get("code") for error in root.get("blockingErrors", []) if isinstance(error, dict)],
            "quality": root.get("quality"),
        },
        "summary": report.get("summary", {}),
        "quality": report.get("quality", {}),
        "stepCount": len(report.get("steps", [])) if isinstance(report.get("steps"), list) else 0,
        "error": report.get("error"),
    }


def find_text_artifact_issues(paths: List[Path]) -> List[Dict[str, Any]]:
    """检查文本产物中是否存在常见乱码占位符。"""
    issues: List[Dict[str, Any]] = []
    for path in paths:
        if not path.exists() or path.suffix.lower() not in {".json", ".md", ".txt"}:
            continue
        text = path.read_text(encoding="utf-8-sig", errors="replace")
        markers = []
        if "\ufffd" in text:
            markers.append("U+FFFD")
        if "???" in text:
            markers.append("???")
        if markers:
            issues.append({"path": path.as_posix(), "markers": markers})
    return issues


def collect_pipeline_quality(plan: Dict[str, Any], timings: List[Dict[str, Any]], artifact_paths: List[Path]) -> Dict[str, Any]:
    """汇总计划质量、耗时和产物健康信息。"""
    elapsed_seconds = round(sum(float(item.get("elapsedSeconds") or 0) for item in timings), 3)
    slow_steps = [
        {"name": item.get("name"), "elapsedSeconds": item.get("elapsedSeconds")}
        for item in timings
        if float(item.get("elapsedSeconds") or 0) >= 10.0
    ]
    quality = plan.get("summary", {}).get("quality")
    if not isinstance(quality, dict):
        quality = {}
    return {
        "elapsedSeconds": elapsed_seconds,
        "slowSteps": slow_steps,
        "planQuality": quality,
        "artifactIssues": find_text_artifact_issues(artifact_paths),
    }


def root_blocking_errors_are_deferred(args: argparse.Namespace, plan: Dict[str, Any]) -> bool:
    """Allow root semantic-depth gates only when this run has explicit nested stages."""
    errors = [error for error in plan.get("blockingErrors", []) if isinstance(error, dict)]
    if not errors:
        return False
    allowed_codes = {"needsListItemSplit", "needsTabItemSplit", "semanticGroupStillCoarse"}
    if any(str(error.get("code") or "") not in allowed_codes for error in errors):
        return False
    group_names = [str(group.get("name") or "") for group in plan.get("groups", []) if isinstance(group, dict)]
    has_list_root = "[ListRoot]" in group_names
    has_tab_bar = "[TabBar]" in group_names
    has_progress_section = "[ProgressSection]" in group_names
    has_list_wrapper_chain = any(
        bool(chain) and chain[0] == "[ListRoot]" and "[Content]" in chain
        for chain in [parse_wrapper_chain(value) for value in getattr(args, "wrapper_chain", [])]
    )
    for error in errors:
        code = str(error.get("code") or "")
        details = error.get("details") if isinstance(error.get("details"), dict) else {}
        name = str(details.get("name") or "")
        if code == "needsTabItemSplit":
            if name == "[TabBar]" and args.auto_nested_generic and has_tab_bar:
                continue
            return False
        if code == "needsListItemSplit":
            if name == "[ListRoot]" and has_list_wrapper_chain:
                continue
            return False
        if code == "semanticGroupStillCoarse":
            if name == "[ProgressSection]" and args.auto_nested_generic and has_progress_section:
                continue
            return False
    return True


def parse_nested_target(value: str) -> Tuple[str, str]:
    """Parse an explicit live nested target in the form [Name]=nodeId."""
    if "=" not in value:
        raise PipelineError(f"nestedTargetFormatInvalid: expected [Name]=nodeId, got {value}")
    name, node_id = value.split("=", 1)
    name = name.strip()
    node_id = node_id.strip()
    if not name or not node_id:
        raise PipelineError(f"nestedTargetFormatInvalid: expected non-empty name and nodeId, got {value}")
    return name, node_id


def nested_builder_for_name(name: str) -> Optional[Any]:
    """Return the generic nested planner for a supported semantic container."""
    if name == "[TabBar]":
        return lambda payload: build_axis_item_plan(payload, "TabItem", "x", "Generic TabBar split")
    if name == "[ProgressSection]":
        return build_progress_nested_plan
    if name == "[Content]":
        return lambda payload: build_axis_item_plan(payload, "Item", "y", "Generic list content split")
    return None


def run_explicit_nested_targets(args: argparse.Namespace, relay_url: str, root_target: Dict[str, str], work_dir: Path) -> Tuple[int, Dict[str, Any]]:
    """Resume generic nested cleanup from explicit live target ids without touching the root."""
    timings: List[Dict[str, Any]] = []
    artifact_paths: List[Path] = []
    health = run_timed_step(timings, "health", lambda: ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout))
    pipeline_report: Dict[str, Any] = {
        "status": "planned",
        "workDir": work_dir.as_posix(),
        "health": health,
        "root": {"target": root_target, "skippedAnalyze": True, "skippedApply": True},
        "steps": [],
        "timings": timings,
        "summary": {"explicitNestedTargetCount": len(args.nested_target), "rootSkipped": True},
        "quality": {},
    }
    if not args.apply_confirmed:
        pipeline_report["message"] = "已读取 explicit nested targets；未提供 --apply-confirmed，因此没有写入 Figma。"
        return 0, pipeline_report
    for value in args.nested_target:
        name, node_id = parse_nested_target(value)
        builder = nested_builder_for_name(name)
        if builder is None:
            raise PipelineError(f"nestedTargetUnsupported: {name}")
        step_report = execute_nested_generic_stage(
            args,
            relay_url,
            root_target,
            work_dir,
            timings,
            artifact_paths,
            name,
            node_id,
            builder,
        )
        pipeline_report["steps"].append(step_report)
    pipeline_report["status"] = "completed"
    pipeline_report["summary"]["completedStepCount"] = len(pipeline_report["steps"])
    pipeline_report["quality"] = collect_pipeline_quality({"summary": {}}, timings, artifact_paths)
    return 0, pipeline_report


def plan_root(
    args: argparse.Namespace,
    root_analysis: Dict[str, Any],
    plan_path: Path,
    report_path: Path,
    diagnostic_path: Path,
) -> Dict[str, Any]:
    """生成或读取根节点整理计划。"""
    if args.plan:
        plan = load_json(args.plan)
    else:
        semantic_hints = None
        if args.detect_psd_prefix_hints:
            result = find_result_payload(root_analysis)
            children = get_direct_children(result)
            root_bounds_raw = result.get("rootBounds") if isinstance(result.get("rootBounds"), dict) else {}
            from plan_figma_hierarchy_cleanup import Bounds

            root_bounds = Bounds(
                x=0.0,
                y=0.0,
                width=float(root_bounds_raw.get("width") or 0),
                height=float(root_bounds_raw.get("height") or 0),
            )
            semantic_hints = build_psd_prefix_hints(
                children,
                root_bounds if root_bounds.width > 0 and root_bounds.height > 0 else None,
            )
            hints_path = plan_path.with_name("01_root_psd_prefix_hints.json")
            write_json(hints_path, semantic_hints)
        plan = build_plan(root_analysis, semantic_hints)
        write_json(plan_path, plan)
        write_report(report_path, plan)
        write_diagnostic_report(diagnostic_path, plan)
    if plan.get("blockingErrors") and root_blocking_errors_are_deferred(args, plan):
        plan.setdefault("warnings", []).append({
            "code": "rootBlockingErrorsDeferredToPipeline",
            "message": "Root plan semantic-depth errors are deferred because this run explicitly includes nested cleanup stages.",
            "details": {"deferredCodes": [error.get("code") for error in plan.get("blockingErrors", []) if isinstance(error, dict)]},
        })
        plan["blockingErrors"] = []
        write_json(plan_path, plan)
        write_report(report_path, plan)
        write_diagnostic_report(diagnostic_path, plan)
    if plan.get("blockingErrors") and not args.allow_blocking_plan:
        raise PipelineError(f"根整理计划存在阻塞错误：{plan.get('blockingErrors')}")
    return plan


def build_wrapper_entry_analysis(
    args: argparse.Namespace,
    relay_url: str,
    root_target: Dict[str, str],
    work_dir: Path,
    timings: List[Dict[str, Any]],
) -> Tuple[str, Dict[str, str], Dict[str, Any], Path]:
    """Return the live starting analysis for a wrapper-only resume."""
    if not args.wrapper_root_node_id:
        raise PipelineError("--skip-root-apply requires --wrapper-root-node-id")
    wrapper_root_name = normalize_group_name(args.wrapper_root_name or args.wrapper_root_node_id)
    target = make_child_target(root_target, args.wrapper_root_node_id)
    analysis_path = work_dir / "04_wrapper_root_analysis.json"
    analysis = run_timed_step(
        timings,
        f"{wrapper_root_name}_live_analyze",
        lambda: analyze_node(args, relay_url, target, analysis_path, False),
    )
    analysis_result = result_of(analysis)
    actual_name = str(analysis_result.get("rootName") or analysis_result.get("nodeName") or "")
    if args.wrapper_root_name and actual_name and actual_name != wrapper_root_name:
        raise PipelineError(
            "wrapperRootMismatch: live wrapper root name does not match requested root; "
            f"requested={wrapper_root_name}, actual={actual_name}"
        )
    return wrapper_root_name, target, analysis, analysis_path


def execute_nested_generic_stage(
    args: argparse.Namespace,
    relay_url: str,
    root_target: Dict[str, str],
    work_dir: Path,
    timings: List[Dict[str, Any]],
    artifact_paths: List[Path],
    stage_name: str,
    target_id: str,
    plan_builder: Any,
) -> Dict[str, Any]:
    safe_name = stage_name.strip("[]").replace(" ", "_")
    analysis_path = work_dir / f"30_{safe_name}_analysis.json"
    plan_path = work_dir / f"31_{safe_name}_plan.json"
    report_path = work_dir / f"31_{safe_name}_plan.md"
    diagnostic_path = work_dir / f"31_{safe_name}_plan_diagnostic.md"
    apply_path = work_dir / f"32_{safe_name}_apply.json"
    verify_path = work_dir / f"33_{safe_name}_verify.json"
    target = make_child_target(root_target, target_id)
    analysis = run_timed_step(
        timings,
        f"{stage_name}_analyze",
        lambda: analyze_node(args, relay_url, target, analysis_path, False),
    )
    plan = run_timed_step(timings, f"{stage_name}_generic_plan", lambda: plan_builder(analysis))
    run_timed_step(
        timings,
        f"{stage_name}_preflight",
        lambda: assert_plan_matches_analysis(plan, analysis, f"{stage_name}_generic", require_order=False),
    )
    write_json(plan_path, plan)
    write_report(report_path, plan)
    write_diagnostic_report(diagnostic_path, plan)
    apply_payload = run_timed_step(
        timings,
        f"{stage_name}_apply",
        lambda: apply_plan(args, relay_url, plan, apply_path, False),
    )
    verify_report = run_timed_step(
        timings,
        f"{stage_name}_verify",
        lambda: verify_and_save(analysis, apply_payload, plan, verify_path),
    )
    artifact_paths.extend([analysis_path, plan_path, report_path, diagnostic_path, apply_path, verify_path])
    return {
        "name": stage_name,
        "analysis": analysis_path.as_posix(),
        "plan": plan_path.as_posix(),
        "report": report_path.as_posix(),
        "diagnosticReport": diagnostic_path.as_posix(),
        "apply": apply_path.as_posix(),
        "verify": verify_path.as_posix(),
        "allPass": verify_report.get("allPass"),
        "warnings": verify_report.get("warnings", []),
    }


def component_set_result_summary(payload: Dict[str, Any]) -> Dict[str, Any]:
    result = result_of_payload(payload)
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    checks = result.get("checks") if isinstance(result.get("checks"), dict) else {}
    screenshot = result.get("screenshot") if isinstance(result.get("screenshot"), dict) else {}
    return {
        "status": result.get("status"),
        "allPass": result.get("allPass"),
        "componentSetId": summary.get("componentSetId"),
        "componentSetName": summary.get("componentSetName"),
        "variantCount": summary.get("variantCount"),
        "replacedInstanceCount": summary.get("replacedInstanceCount"),
        "backupFrameId": summary.get("backupFrameId"),
        "checks": checks,
        "screenshotPath": screenshot.get("path"),
    }


def execute_auto_component_sets(
    args: argparse.Namespace,
    relay_url: str,
    root_target: Dict[str, str],
    work_dir: Path,
    timings: List[Dict[str, Any]],
    artifact_paths: List[Path],
) -> Dict[str, Any]:
    """Analyze the latest tree, plan generic ComponentSets, apply them, and report skips."""
    analysis_path = work_dir / "70_auto_component_sets_analysis.json"
    plan_report_path = work_dir / "71_auto_component_sets_plans.json"
    analysis = run_timed_step(
        timings,
        "auto_component_sets_analyze",
        lambda: analyze_node(args, relay_url, root_target, analysis_path, False),
    )
    plan_report = run_timed_step(timings, "auto_component_sets_plan", lambda: find_auto_component_set_plans(analysis))
    write_json(plan_report_path, plan_report)
    artifact_paths.extend([analysis_path, plan_report_path])

    steps: List[Dict[str, Any]] = []
    plans = plan_report.get("plans") if isinstance(plan_report.get("plans"), list) else []
    for index, plan in enumerate(plans, start=1):
        if not isinstance(plan, dict):
            continue
        component_name = str(plan.get("componentSetName") or f"ComponentSet{index}")
        parent_name = str((plan.get("target") or {}).get("name") or component_name)
        safe_name = re.sub(r"[^A-Za-z0-9_]+", "_", f"{index:02d}_{parent_name}_{component_name}").strip("_")
        plan_path = work_dir / f"72_auto_component_set_{safe_name}_plan.json"
        apply_path = work_dir / f"73_auto_component_set_{safe_name}_apply.json"
        write_json(plan_path, plan)
        artifact_paths.append(plan_path)
        apply_payload = run_timed_step(
            timings,
            f"auto_component_set_{component_name}_apply",
            lambda current_plan=plan, current_path=apply_path: apply_component_set_plan(
                args,
                relay_url,
                current_plan,
                current_path,
                False,
            ),
        )
        artifact_paths.append(apply_path)
        steps.append({
            "name": component_name,
            "target": plan.get("target"),
            "plan": plan_path.as_posix(),
            "apply": apply_path.as_posix(),
            "summary": component_set_result_summary(apply_payload),
        })

    return {
        "name": "AutoComponentSet",
        "analysis": analysis_path.as_posix(),
        "planReport": plan_report_path.as_posix(),
        "planCount": len(plans),
        "appliedCount": len(steps),
        "steps": steps,
        "skipped": plan_report.get("skipped", []),
        "warnings": plan_report.get("warnings", []),
    }


def run_pipeline(args: argparse.Namespace) -> Tuple[int, Dict[str, Any]]:
    """执行完整整理流水线。"""
    timings: List[Dict[str, Any]] = []
    work_dir = args.work_dir
    work_dir.mkdir(parents=True, exist_ok=True)
    relay_url = args.relay_url.rstrip("/")
    root_target = extract_figma_target(args.figma_url, args.node_id, args.file_key)
    if args.nested_target:
        return run_explicit_nested_targets(args, relay_url, root_target, work_dir)
    wrapper_chain_values = list(args.wrapper_chain)
    wrapper_chains = [parse_wrapper_chain(value) for value in wrapper_chain_values]
    root_apply_count = 0 if args.skip_root_apply else 1
    total_apply_steps = root_apply_count + sum(max(0, len(chain) - 1) for chain in wrapper_chains) if args.apply_confirmed else 0
    apply_step_index = 0

    health = run_timed_step(timings, "health", lambda: ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout))
    root_analysis_path = work_dir / "00_root_analysis.json"
    root_plan_path = work_dir / "01_root_plan.json"
    root_report_path = work_dir / "01_root_plan.md"
    root_diagnostic_path = work_dir / "01_root_plan_diagnostic.md"

    root_analysis = run_timed_step(
        timings,
        "root_analyze",
        lambda: analyze_node(args, relay_url, root_target, root_analysis_path, bool(args.screenshot_analysis)),
    )
    root_plan = run_timed_step(
        timings,
        "root_plan",
        lambda: plan_root(args, root_analysis, root_plan_path, root_report_path, root_diagnostic_path),
    )
    artifact_paths: List[Path] = [root_analysis_path, root_plan_path, root_report_path, root_diagnostic_path]

    pipeline_report: Dict[str, Any] = {
        "status": "planned",
        "workDir": work_dir.as_posix(),
        "health": health,
        "root": {
            "target": root_target,
            "analysis": root_analysis_path.as_posix(),
            "plan": (args.plan or root_plan_path).as_posix() if isinstance(args.plan or root_plan_path, Path) else str(args.plan),
            "report": root_report_path.as_posix() if not args.plan else "",
            "diagnosticReport": root_diagnostic_path.as_posix() if not args.plan else "",
            "summary": root_plan.get("summary", {}),
            "warnings": root_plan.get("warnings", []),
            "blockingErrors": root_plan.get("blockingErrors", []),
            "quality": root_plan.get("summary", {}).get("quality", {}),
        },
        "wrapperChains": wrapper_chains,
        "steps": [],
        "timings": timings,
        "summary": {
            "plannedApplyStepCount": root_apply_count + sum(max(0, len(chain) - 1) for chain in wrapper_chains),
            "wrapperChainCount": len(wrapper_chains),
            "finalScreenshotExpected": not args.no_final_screenshot,
            "skipRootApply": bool(args.skip_root_apply),
        },
        "quality": {},
    }

    if not args.apply_confirmed:
        pipeline_report["message"] = "已完成 analyze + plan；未提供 --apply-confirmed，因此没有写入 Figma。"
        pipeline_report["quality"] = collect_pipeline_quality(root_plan, timings, artifact_paths)
        return 0, pipeline_report

    root_apply: Dict[str, Any] = {}
    if args.skip_root_apply:
        if args.plan:
            raise PipelineError("--skip-root-apply cannot be combined with --plan")
        pipeline_report["root"]["skippedApply"] = True
        pipeline_report["steps"].append({
            "name": "root",
            "skippedApply": True,
            "reason": "wrapper-only resume from a live current Figma node",
        })
    else:
        apply_step_index += 1
        root_apply_path = work_dir / "02_root_apply.json"
        root_verify_path = work_dir / "03_root_verify.json"
        include_root_screenshot = False
        root_apply = run_timed_step(
            timings,
            "root_apply",
            lambda: apply_plan(args, relay_url, root_plan, root_apply_path, include_root_screenshot),
        )
        root_verify = run_timed_step(
            timings,
            "root_verify",
            lambda: verify_and_save(root_analysis, root_apply, root_plan, root_verify_path),
        )
        artifact_paths.extend([root_apply_path, root_verify_path])
        pipeline_report["steps"].append({
            "name": "root",
            "apply": root_apply_path.as_posix(),
            "verify": root_verify_path.as_posix(),
            "allPass": root_verify.get("allPass"),
            "warnings": root_verify.get("warnings", []),
        })

    analyses_by_id: Dict[str, Dict[str, Any]] = {}
    analyses_by_path: Dict[str, Tuple[str, Dict[str, Any]]] = {}
    for chain_index, chain in enumerate(wrapper_chains, start=1):
        if args.skip_root_apply:
            current_name, current_target, current_analysis, entry_analysis_path = build_wrapper_entry_analysis(
                args,
                relay_url,
                root_target,
                work_dir,
                timings,
            )
            if chain[0] != current_name:
                raise PipelineError(
                    "wrapperChainRootMismatch: wrapper-chain first node must match --wrapper-root-name; "
                    f"chainRoot={chain[0]}, wrapperRoot={current_name}"
                )
            current_node_id = str(current_target.get("nodeId") or "")
            artifact_paths.append(entry_analysis_path)
            pipeline_report["steps"].append({
                "name": f"{current_name}_live_entry",
                "analysis": entry_analysis_path.as_posix(),
                "analysisSource": "live-wrapper-root",
                "createdGroupId": current_node_id,
            })
            current_path = current_name
            analyses_by_id[current_node_id] = current_analysis
            analyses_by_path[current_path] = (current_node_id, current_analysis)
        else:
            current_name = chain[0]
            current_node_id = extract_single_created_group_id(root_apply, current_name)
            pipeline_report["steps"][-1]["createdGroupId"] = current_node_id
            current_target = make_child_target(root_target, current_node_id)
            current_analysis = synthesize_wrapper_analysis(root_apply, current_name, current_node_id, root_target)
            analyses_by_id[current_node_id] = current_analysis
            current_path = current_name
            analyses_by_path[current_path] = (current_node_id, current_analysis)
        if args.fast_wrapper_chain and len(chain) > 2:
            prefix = f"{10 + chain_index:02d}_fast_{current_name.strip('[]').replace(' ', '_')}_chain"
            wrap_apply_path = work_dir / f"{prefix}_apply.json"
            wrap_payload = run_timed_step(
                timings,
                f"{current_name}_fast_wrap_chain",
                lambda target=current_target, path=wrap_apply_path, chain_value=chain: submit_wrap_chain(
                    args,
                    relay_url,
                    target,
                    chain_value,
                    path,
                    False,
                ),
            )
            artifact_paths.append(wrap_apply_path)
            wrap_result = result_of_payload(wrap_payload)
            created = wrap_result.get("artifacts", {}).get("createdGroups") if isinstance(wrap_result.get("artifacts"), dict) else []
            if not isinstance(created, list) or not created:
                raise PipelineError(f"{current_name} fast wrapper-chain returned no createdGroups")
            for created_group in created:
                if not isinstance(created_group, dict):
                    continue
                group_id = str(created_group.get("id") or created_group.get("nodeId") or "")
                group_name = str(created_group.get("name") or "")
                if group_id and group_name:
                    analyses_by_id[group_id] = {
                        "status": "completed",
                        "allPass": True,
                        "rootNodeId": group_id,
                        "rootName": group_name,
                        "fileKey": str(root_target.get("fileKey") or ""),
                        "directChildren": [],
                        "warnings": [{"code": "fastWrapperChainCreated", "message": "Created by FIGMA_HIERARCHY_WRAP_CHAIN."}],
                    }
            deepest_id = str(wrap_result.get("artifacts", {}).get("deepestGroupId") or wrap_result.get("summary", {}).get("deepestGroupId") or "")
            deepest_name = str(wrap_result.get("artifacts", {}).get("deepestGroupName") or wrap_result.get("summary", {}).get("deepestGroupName") or chain[-1])
            if not deepest_id:
                raise PipelineError(f"{current_name} fast wrapper-chain missing deepestGroupId")
            pipeline_report["steps"].append({
                "name": f"{current_name}_fast_wrapper_chain",
                "apply": wrap_apply_path.as_posix(),
                "allPass": wrap_result.get("allPass"),
                "createdGroups": created,
                "deepestGroupId": deepest_id,
                "deepestGroupName": deepest_name,
            })
            current_name = deepest_name
            current_node_id = deepest_id
            current_target = make_child_target(root_target, current_node_id)
            current_path = ">".join(chain)
            analyses_by_path[current_path] = (current_node_id, analyses_by_id.get(current_node_id, {}))
            continue
        for depth_index, wrapper_name in enumerate(chain[1:], start=1):
            safe_parent = current_name.strip("[]").replace(" ", "_")
            safe_child = wrapper_name.strip("[]").replace(" ", "_")
            prefix = f"{10 + chain_index:02d}_{depth_index:02d}_{safe_parent}_to_{safe_child}"
            analysis_path = work_dir / f"{prefix}_analysis.json"
            plan_path = work_dir / f"{prefix}_plan.json"
            report_path = work_dir / f"{prefix}_plan.md"
            diagnostic_path = work_dir / f"{prefix}_plan_diagnostic.md"
            apply_path = work_dir / f"{prefix}_apply.json"
            verify_path = work_dir / f"{prefix}_verify.json"

            analysis = run_timed_step(
                timings,
                f"{current_name}_synthetic_analysis",
                lambda payload=current_analysis, path=analysis_path: (write_json(path, payload), payload)[1],
            )
            wrapper_plan = run_timed_step(
                timings,
                f"{current_name}_plan_{wrapper_name}",
                lambda payload=analysis, name=wrapper_name: build_wrapper_plan(payload, name),
            )
            run_timed_step(
                timings,
                f"{current_name}_preflight_{wrapper_name}",
                lambda plan=wrapper_plan, payload=analysis, context=f"{current_name}->{wrapper_name}": assert_plan_matches_analysis(plan, payload, context),
            )
            write_json(plan_path, wrapper_plan)
            write_report(report_path, wrapper_plan)
            write_diagnostic_report(diagnostic_path, wrapper_plan)
            artifact_paths.extend([analysis_path, plan_path, report_path, diagnostic_path])

            apply_step_index += 1
            include_screenshot = False
            apply_payload = run_timed_step(
                timings,
                f"{current_name}_apply_{wrapper_name}",
                lambda plan=wrapper_plan, path=apply_path, screenshot=include_screenshot: apply_plan(args, relay_url, plan, path, screenshot),
            )
            verify_report = run_timed_step(
                timings,
                f"{current_name}_verify_{wrapper_name}",
                lambda before=analysis, after=apply_payload, plan=wrapper_plan, path=verify_path: verify_and_save(before, after, plan, path),
            )
            artifact_paths.extend([apply_path, verify_path])
            pipeline_report["steps"].append({
                "name": f"{current_name}->{wrapper_name}",
                "analysis": analysis_path.as_posix(),
                "analysisSource": "previous-apply-originalNodesAfter",
                "plan": plan_path.as_posix(),
                "report": report_path.as_posix(),
                "diagnosticReport": diagnostic_path.as_posix(),
                "apply": apply_path.as_posix(),
                "verify": verify_path.as_posix(),
                "allPass": verify_report.get("allPass"),
                "warnings": verify_report.get("warnings", []),
            })
            current_name = wrapper_name
            current_node_id = extract_single_created_group_id(apply_payload, wrapper_name)
            pipeline_report["steps"][-1]["createdGroupId"] = current_node_id
            current_target = make_child_target(root_target, current_node_id)
            current_analysis = synthesize_wrapper_analysis(apply_payload, current_name, current_node_id, current_target)
            analyses_by_id[current_node_id] = current_analysis
            current_path = f"{current_path}>{current_name}"
            analyses_by_path[current_path] = (current_node_id, current_analysis)

    if args.auto_nested_generic and not args.skip_root_apply:
        nested_targets: List[Tuple[str, str, Any]] = []
        root_created = []
        root_result = result_of_payload(root_apply)
        artifacts = root_result.get("artifacts") if isinstance(root_result.get("artifacts"), dict) else {}
        if isinstance(artifacts.get("createdGroups"), list):
            root_created = [item for item in artifacts.get("createdGroups", []) if isinstance(item, dict)]
        for group in root_created:
            name = str(group.get("name") or "")
            node_id = str(group.get("id") or group.get("nodeId") or "")
            if not node_id:
                continue
            if name == "[TabBar]":
                nested_targets.append((name, node_id, lambda payload: build_axis_item_plan(payload, "TabItem", "x", "Generic TabBar split")))
            elif name == "[ProgressSection]":
                nested_targets.append((name, node_id, build_progress_nested_plan))
        for step in pipeline_report.get("steps", []):
            if not isinstance(step, dict):
                continue
            if str(step.get("deepestGroupName") or "") == "[Content]" and step.get("deepestGroupId"):
                nested_targets.append(("[Content]", str(step.get("deepestGroupId")), lambda payload: build_axis_item_plan(payload, "Item", "y", "Generic list content split")))
        seen_nested: set[Tuple[str, str]] = set()
        for stage_name, target_id, builder in nested_targets:
            key = (stage_name, target_id)
            if key in seen_nested:
                continue
            seen_nested.add(key)
            step_report = execute_nested_generic_stage(
                args,
                relay_url,
                root_target,
                work_dir,
                timings,
                artifact_paths,
                stage_name,
                target_id,
                builder,
            )
            pipeline_report["steps"].append(step_report)

    if args.auto_component_sets and not args.skip_root_apply:
        auto_component_sets = execute_auto_component_sets(args, relay_url, root_target, work_dir, timings, artifact_paths)
        pipeline_report["steps"].append(auto_component_sets)
        pipeline_report["autoComponentSets"] = auto_component_sets

    if not args.no_final_screenshot:
        screenshot_path = work_dir / "99_final_screenshot.json"
        screenshot_payload = run_timed_step(
            timings,
            "final_screenshot",
            lambda: export_screenshot(args, relay_url, root_target, screenshot_path),
        )
        artifact_paths.append(screenshot_path)
        screenshot_result = result_of_payload(screenshot_payload)
        screenshot_info = screenshot_result.get("screenshot") if isinstance(screenshot_result.get("screenshot"), dict) else {}
        pipeline_report["finalScreenshot"] = {
            "result": screenshot_path.as_posix(),
            "path": screenshot_info.get("path"),
            "byteLength": screenshot_info.get("byteLength"),
        }

    pipeline_report["status"] = "completed"
    pipeline_report["timings"] = timings
    pipeline_report["summary"] = {
        "applyStepCount": total_apply_steps,
        "wrapperChainCount": len(wrapper_chains),
        "elapsedSeconds": round(sum(float(item.get("elapsedSeconds") or 0) for item in timings), 3),
        "autoComponentSetCount": (
            pipeline_report.get("autoComponentSets", {}).get("appliedCount", 0)
            if isinstance(pipeline_report.get("autoComponentSets"), dict) else 0
        ),
        "finalScreenshotExpected": not args.no_final_screenshot,
    }
    pipeline_report["quality"] = collect_pipeline_quality(root_plan, timings, artifact_paths)
    return 0, pipeline_report


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="运行 Figma 层级整理快速流水线")
    parser.add_argument("--figma-url", default="", help="Figma URL，可包含 node-id")
    parser.add_argument("--file-key", default="", help="Figma file key，可选")
    parser.add_argument("--node-id", default="", help="Figma node id，可选")
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL, help="本地 MCP Relay 地址")
    parser.add_argument("--bridge-url", dest="relay_url", default=DEFAULT_RELAY_URL, help=argparse.SUPPRESS)
    parser.add_argument("--startup-timeout", type=float, default=10.0, help="等待 MCP Relay 启动秒数")
    parser.add_argument("--timeout", type=float, default=300.0, help="等待 Figma 结果秒数")
    parser.add_argument("--interval", type=float, default=0.5, help="轮询间隔秒数")
    parser.add_argument("--job-name", default="Figma_Hierarchy_Cleanup_Pipeline", help="MCP Relay job 名称")
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_OUTPUT_DIR / "pipeline", help="流水线输出目录")
    parser.add_argument("--max-depth", type=int, default=8, help="分析节点树最大深度")
    parser.add_argument("--exclude-hidden", action="store_true", help="分析时排除隐藏节点；默认包含隐藏节点")
    parser.add_argument("--screenshot-analysis", action="store_true", help="根节点分析阶段也导出截图；默认不截图")
    parser.add_argument("--no-final-screenshot", action="store_true", help="最后一次 apply 也不截图")
    parser.add_argument("--apply-confirmed", action="store_true", help="确认已获用户同意后才真正写入 Figma")
    parser.add_argument("--skip-root-apply", action="store_true", help="Resume wrapper cleanup from an already-created live group; root apply is skipped.")
    parser.add_argument("--wrapper-root-node-id", default="", help="Live Figma node id to use as the first wrapper-chain node when --skip-root-apply is set.")
    parser.add_argument("--wrapper-root-name", default="", help="Expected live wrapper root name, for example [ListRoot].")
    parser.add_argument("--auto-nested-generic", action="store_true", help="After root/wrapper apply, split generic TabBar, ProgressSection, and list Content children automatically.")
    parser.add_argument("--auto-component-sets", default=True, action=argparse.BooleanOptionalAction, help="After cleanup, automatically create generic ComponentSet variants for clear repeated sibling frames.")
    parser.add_argument("--fast-wrapper-chain", default=True, action=argparse.BooleanOptionalAction, help="Use FIGMA_HIERARCHY_WRAP_CHAIN for multi-layer wrapper chains when available.")
    parser.add_argument("--allow-blocking-plan", action="store_true", help="允许存在 blockingErrors 的计划继续执行")
    parser.add_argument("--plan", type=Path, default=None, help="使用已人工确认的根计划 JSON；不传则自动生成")
    parser.add_argument("--detect-psd-prefix-hints", action="store_true", help="Detect PSD numeric-prefix hints and feed them into root planning gates")
    parser.add_argument("--nested-target", action="append", default=[], help="Resume generic nested cleanup from a live child, format \"[TabBar]=nodeId\". Supported names: [TabBar], [ProgressSection], [Content].")
    parser.add_argument("--verbose-result", action="store_true", help="在 stdout 打印完整流水线报告；默认只打印轻量摘要")
    parser.add_argument(
        "--wrapper-chain",
        action="append",
        default=[],
        help="追加嵌套包装链，例如 \"[ListRoot]>[ScrollView]>[Viewport]>[Content]\"，可重复传入",
    )
    parser.add_argument("--output", type=Path, default=None, help="流水线总报告路径")
    parser.add_argument("--session-id", default="", help="Target Figma plugin sessionId")
    parser.add_argument("--no-preflight", action="store_true", help="Skip live plugin target preflight")
    return parser.parse_args()


def main() -> int:
    """命令行入口。"""
    args = parse_args()
    configure_target(args.file_key, args.session_id, not args.no_preflight)
    output_path = args.output or (args.work_dir / "pipeline_result.json")
    try:
        exit_code, report = run_pipeline(args)
    except Exception as exc:
        report = {
            "status": "failed",
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }
        write_pipeline_report(output_path, report)
        output = report if args.verbose_result else build_pipeline_cli_summary(report, output_path)
        print("[SUMMARY_JSON]")
        print(json.dumps(output, ensure_ascii=True, indent=2))
        return 2
    write_pipeline_report(output_path, report)
    output = report if args.verbose_result else build_pipeline_cli_summary(report, output_path)
    print("[SUMMARY_JSON]")
    print(json.dumps(output, ensure_ascii=True, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
