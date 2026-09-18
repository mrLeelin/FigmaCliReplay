"""
Figma 层级整理结果验证器。

读取整理前分析结果、整理计划和 apply 结果，验证节点守恒、分组数量、原始节点归属与视觉边界误差。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple


DEFAULT_TOLERANCE = 0.01


def load_json(path: Path) -> Dict[str, Any]:
    """读取 UTF-8 或 UTF-8-BOM JSON 文件。"""
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    """写入 JSON 验证报告。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def result_of(payload: Dict[str, Any]) -> Dict[str, Any]:
    """兼容 Relay 外层 result 包装。"""
    result = payload.get("result")
    return result if isinstance(result, dict) else payload


def make_error(code: str, message: str, details: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """创建统一错误对象。"""
    return {"code": code, "message": message, "details": details or {}}


def direct_children(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """读取根直接子节点。"""
    children = result.get("directChildren")
    return [child for child in children if isinstance(child, dict)] if isinstance(children, list) else []


def node_id_of(node: Dict[str, Any]) -> str:
    """读取节点 id，兼容 nodeId 字段。"""
    return str(node.get("id") or node.get("nodeId") or "")


def bounds_of(node: Dict[str, Any]) -> Dict[str, float]:
    """读取节点绝对边界。"""
    bounds = node.get("bounds") or node.get("absoluteBounds") or {}
    if not isinstance(bounds, dict):
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}
    return {
        "x": float(bounds.get("x") or 0),
        "y": float(bounds.get("y") or 0),
        "width": float(bounds.get("width") or 0),
        "height": float(bounds.get("height") or 0),
    }


def bounds_delta(a: Dict[str, float], b: Dict[str, float]) -> float:
    """计算两个边界的最大字段差异。"""
    return max(abs(a[key] - b[key]) for key in ("x", "y", "width", "height"))


def planned_original_ids(plan: Dict[str, Any]) -> List[str]:
    """读取计划中所有原始节点 id。"""
    ids: List[str] = []
    for group in plan.get("groups", []):
        for node_id in group.get("childNodeIds", []):
            ids.append(str(node_id))
    return ids


def plan_target_node_id(plan: Dict[str, Any]) -> str:
    """读取计划目标节点 id。"""
    target = plan.get("target")
    if not isinstance(target, dict):
        return ""
    return str(target.get("nodeId") or "")


def normalize_name(value: str) -> str:
    return str(value or "").strip().strip("[]").lower()


def is_list_container_name(name: str) -> bool:
    text = normalize_name(name)
    return text in {"scrollview", "viewport", "content", "list"} or text.endswith("list")


def is_scrollview_name(name: str) -> bool:
    return normalize_name(name) == "scrollview"


def is_viewport_name(name: str) -> bool:
    return normalize_name(name) == "viewport"


def is_content_name(name: str) -> bool:
    return normalize_name(name) == "content"


def is_item_name(name: str) -> bool:
    text = normalize_name(name)
    if "tabitem" in text:
        return False
    return "item" in text or text.startswith("cell") or text.startswith("row")


def is_tab_item_name(name: str) -> bool:
    text = normalize_name(name)
    return "tabitem" in text or "daytab" in text or text.startswith("tab_") or text.startswith("tab-")


def is_progress_track_name(name: str) -> bool:
    text = normalize_name(name)
    return "progresstrack" in text or "progressbar" in text or text in {"track", "bar"}


def is_reward_slot_name(name: str) -> bool:
    text = normalize_name(name)
    return "rewardslot" in text or text.startswith("milestone") or text.startswith("reward_")


def has_progress_marker_name(name: str) -> bool:
    text = normalize_name(name)
    return any(token in text for token in ("jdtbig3", "marker", "tick", "milestone"))


def semantic_intent_of_plan(plan: Dict[str, Any]) -> Dict[str, bool]:
    """Read generic semantic intent from plan quality metadata and group names."""
    summary = plan.get("summary") if isinstance(plan.get("summary"), dict) else {}
    quality = summary.get("quality") if isinstance(summary.get("quality"), dict) else {}
    intent = quality.get("semanticIntent") if isinstance(quality.get("semanticIntent"), dict) else {}
    group_names = [str(group.get("name") or "") for group in plan.get("groups", []) if isinstance(group, dict)]
    has_item_groups = any(is_item_name(name) for name in group_names)
    has_tab_groups = any(is_tab_item_name(name) for name in group_names)
    has_list_container = any(is_list_container_name(name) for name in group_names)
    has_scroll_chain = (
        any(is_scrollview_name(name) for name in group_names)
        and any(is_viewport_name(name) for name in group_names)
        and any(is_content_name(name) for name in group_names)
    )
    return {
        "listLike": bool(intent.get("listLike")) or has_item_groups or has_list_container,
        "tabLike": bool(intent.get("tabLike")) or has_tab_groups,
        "hasItemGroups": has_item_groups,
        "hasTabItemGroups": has_tab_groups,
        "hasListContainer": has_list_container,
        "hasScrollViewChain": has_scroll_chain,
    }


def target_is_list_container(before_result: Dict[str, Any], plan: Dict[str, Any]) -> bool:
    """Return true when the current verification target is already a list container."""
    candidates = [
        str(before_result.get("rootName") or ""),
        str(before_result.get("nodeName") or ""),
    ]
    target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    candidates.append(str(target.get("name") or ""))
    return any(is_list_container_name(name) for name in candidates if name)


def target_is_content_container(before_result: Dict[str, Any], plan: Dict[str, Any]) -> bool:
    """Return true when items are being grouped directly inside an existing Content node."""
    candidates = [
        str(before_result.get("rootName") or ""),
        str(before_result.get("nodeName") or ""),
    ]
    target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    candidates.append(str(target.get("name") or ""))
    return any(is_content_name(name) for name in candidates if name)


def progress_marker_plan_errors(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Detect marker/tick nodes left under a progress track while reward slots exist."""
    groups = [group for group in plan.get("groups", []) if isinstance(group, dict)]
    has_reward_slots = any(is_reward_slot_name(str(group.get("name") or "")) for group in groups)
    if not has_reward_slots:
        return []

    errors: List[Dict[str, Any]] = []
    for group in groups:
        group_name = str(group.get("name") or "")
        if not is_progress_track_name(group_name):
            continue
        child_names = [str(name or "") for name in group.get("childNames", [])]
        marker_names = [name for name in child_names if has_progress_marker_name(name)]
        if marker_names:
            errors.append(make_error("progressMarkerNotInRewardSlot", "Progress markers must be owned by RewardSlot/Milestone groups, not ProgressTrack.", {
                "group": group_name,
                "markerNames": marker_names,
                "required": "Move marker/tick/jdtbig3 nodes into the corresponding RewardSlot/Milestone group; keep ProgressTrack for track/fill/slice nodes.",
            }))
    return errors


def verify(before: Dict[str, Any], after: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
    """执行完整验证并返回统一报告。"""
    before_result = result_of(before)
    after_result = result_of(after)
    before_children = direct_children(before_result)
    after_original_nodes_raw = after_result.get("originalNodesAfter")
    after_original_nodes = after_result.get("originalNodesAfter")
    if not isinstance(after_original_nodes, list):
        after_original_nodes = []

    blocking_errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    planned_ids = planned_original_ids(plan)
    planned_set = set(planned_ids)
    before_by_id = {node_id_of(node): node for node in before_children if node_id_of(node)}
    after_by_id = {node_id_of(node): node for node in after_original_nodes if node_id_of(node)}
    before_root_id = str(before_result.get("rootNodeId") or "")
    after_root_id = str(after_result.get("rootNodeId") or "")
    plan_root_id = plan_target_node_id(plan)

    after_status = str(after_result.get("status") or "")
    if after_status != "completed" or after_result.get("allPass") is not True or after_result.get("blockingErrors"):
        blocking_errors.append(make_error("applyResultNotCompleted", "apply 结果未完成或包含阻塞错误。", {
            "status": after_result.get("status"),
            "allPass": after_result.get("allPass"),
            "blockingErrors": after_result.get("blockingErrors") or [],
        }))

    if not plan_root_id:
        blocking_errors.append(make_error("missingPlanTargetNodeId", "整理计划缺少 target.nodeId。"))
    if before_root_id and plan_root_id and before_root_id != plan_root_id:
        blocking_errors.append(make_error("planTargetBeforeRootMismatch", "计划目标节点与整理前 rootNodeId 不一致。", {
            "beforeRootNodeId": before_root_id,
            "planTargetNodeId": plan_root_id,
        }))
    if after_root_id and before_root_id and after_root_id != before_root_id:
        blocking_errors.append(make_error("rootNodeIdMismatch", "整理前后 rootNodeId 不一致。", {
            "beforeRootNodeId": before_root_id,
            "afterRootNodeId": after_root_id,
        }))
    if after_root_id and plan_root_id and after_root_id != plan_root_id:
        blocking_errors.append(make_error("planTargetAfterRootMismatch", "计划目标节点与整理后 rootNodeId 不一致。", {
            "afterRootNodeId": after_root_id,
            "planTargetNodeId": plan_root_id,
        }))

    if not isinstance(after_original_nodes_raw, list):
        blocking_errors.append(make_error("missingOriginalNodesAfter", "apply 结果缺少 originalNodesAfter，无法验证原始节点守恒。"))

    duplicate_ids = sorted({node_id for node_id in planned_ids if planned_ids.count(node_id) > 1})
    if duplicate_ids:
        blocking_errors.append(make_error("duplicatePlannedIds", "计划中存在重复节点 id。", {"nodeIds": duplicate_ids}))

    before_set = set(before_by_id.keys())
    if before_set != planned_set:
        blocking_errors.append(make_error("plannedIdsMismatch", "计划节点集合与整理前直接子节点不一致。", {
            "missingInPlan": sorted(before_set - planned_set),
            "extraInPlan": sorted(planned_set - before_set),
        }))

    if set(after_by_id.keys()) != planned_set:
        blocking_errors.append(make_error("afterOriginalIdsMismatch", "整理后原始节点集合与计划不一致。", {
            "missingAfter": sorted(planned_set - set(after_by_id.keys())),
            "extraAfter": sorted(set(after_by_id.keys()) - planned_set),
        }))

    tolerance = float(plan.get("options", {}).get("preserveAbsoluteBoundsTolerance") or DEFAULT_TOLERANCE)
    drift_nodes: List[Dict[str, Any]] = []
    for node_id in sorted(planned_set):
        before_node = before_by_id.get(node_id)
        after_node = after_by_id.get(node_id)
        if not before_node or not after_node:
            continue
        delta = bounds_delta(bounds_of(before_node), bounds_of(after_node))
        if delta > tolerance:
            drift_nodes.append({"nodeId": node_id, "delta": delta, "name": before_node.get("name", "")})
    if drift_nodes:
        blocking_errors.append(make_error("boundsDrift", "整理后存在视觉边界漂移。", {"nodes": drift_nodes[:50], "count": len(drift_nodes)}))

    after_top_groups = after_result.get("topLevelGroups")
    original_parent_errors: List[Dict[str, Any]] = []
    expected_group_ids = set()
    if isinstance(after_top_groups, list):
        actual_names = [str(group.get("name") or "") for group in after_top_groups if isinstance(group, dict)]
        expected_names = [str(group.get("name") or "") for group in plan.get("groups", [])]
        expected_group_ids = {
            str(group.get("id") or "")
            for group in after_top_groups
            if isinstance(group, dict) and str(group.get("name") or "") in expected_names and group.get("id")
        }
        if actual_names != expected_names:
            blocking_errors.append(make_error("topLevelGroupsMismatch", "整理后顶层分组顺序或名称与计划不一致。", {
                "actual": actual_names,
                "expected": expected_names,
            }))
        for node in after_original_nodes:
            if not isinstance(node, dict):
                continue
            parent_id = str(node.get("parentId") or "")
            if parent_id not in expected_group_ids:
                original_parent_errors.append({
                    "nodeId": node_id_of(node),
                    "name": str(node.get("name") or ""),
                    "parentId": parent_id,
                })
        if original_parent_errors:
            blocking_errors.append(make_error("originalNodeParentGroupsMismatch", "整理后原始节点未全部归入本次计划创建的顶层分组。", {
                "nodes": original_parent_errors[:50],
                "count": len(original_parent_errors),
            }))
    else:
        warnings.append(make_error("missingTopLevelGroups", "apply 结果缺少 topLevelGroups，无法验证顶层组顺序。"))

    screenshot = after_result.get("screenshot")
    screenshot_ok = isinstance(screenshot, dict) and bool(screenshot.get("path") or screenshot.get("base64") or screenshot.get("byteLength"))
    if not screenshot_ok:
        warnings.append(make_error("missingScreenshot", "apply 结果缺少截图。"))

    semantic_intent = semantic_intent_of_plan(plan)
    target_list_container = target_is_list_container(before_result, plan)
    target_content_container = target_is_content_container(before_result, plan)
    if semantic_intent["listLike"] and semantic_intent["hasItemGroups"] and not semantic_intent["hasScrollViewChain"] and not target_content_container:
        blocking_errors.append(make_error("scrollViewChainMissing", "List-like hierarchy with item groups must include ScrollView/Viewport/Content, unless grouping directly inside an existing Content node.", {
            "required": "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]",
        }))
    if semantic_intent["tabLike"] and not semantic_intent["hasTabItemGroups"]:
        blocking_errors.append(make_error("tabItemsMissing", "Tab-like hierarchy must be split to TabItem groups.", {
            "required": "[Tabs] > [TabItem_*]",
        }))
    blocking_errors.extend(progress_marker_plan_errors(plan))

    checks = {
        "applyCompleted": {"pass": after_status == "completed" and after_result.get("allPass") is True and not after_result.get("blockingErrors")},
        "rootNodeIdStable": {"pass": bool(before_root_id) and before_root_id == after_root_id},
        "planTargetMatchesBeforeRoot": {"pass": bool(plan_root_id) and before_root_id == plan_root_id},
        "planTargetMatchesAfterRoot": {"pass": bool(plan_root_id) and after_root_id == plan_root_id},
        "originalNodesAfterPresent": {"pass": isinstance(after_original_nodes_raw, list)},
        "originalNodeSet": {"pass": before_set == planned_set and set(after_by_id.keys()) == planned_set},
        "originalNodeCountPreserved": {"pass": len(before_set) == len(planned_ids) == len(after_by_id)},
        "originalNodeParentGroupsValid": {"pass": not original_parent_errors},
        "noDuplicatePlannedIds": {"pass": not duplicate_ids, "duplicates": duplicate_ids},
        "boundsPreserved": {"pass": not drift_nodes, "tolerance": tolerance, "driftCount": len(drift_nodes)},
        "topLevelGroupsMatchPlan": {"pass": not any(error.get("code") == "topLevelGroupsMismatch" for error in blocking_errors)},
        "screenshotPresent": {"pass": screenshot_ok},
        "semanticDepthSatisfied": {
            "pass": not any(error.get("code") in {"scrollViewChainMissing", "tabItemsMissing", "progressMarkerNotInRewardSlot"} for error in blocking_errors),
            "intent": {**semantic_intent, "targetIsListContainer": target_list_container, "targetIsContentContainer": target_content_container},
        },
    }

    return {
        "allPass": not blocking_errors,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "summary": {
            "beforeDirectChildCount": len(before_children),
            "plannedOriginalNodeCount": len(planned_ids),
            "afterOriginalNodeCount": len(after_by_id),
            "plannedGroupCount": len(plan.get("groups", [])),
        },
        "checks": checks,
        "artifacts": {
            "beforeRootNodeId": before_result.get("rootNodeId"),
            "afterRootNodeId": after_result.get("rootNodeId"),
            "planTargetNodeId": plan_root_id,
        },
    }


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="验证 Figma 层级整理结果")
    parser.add_argument("--before", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/analysis_result.json"), help="整理前 analyze 结果")
    parser.add_argument("--after", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/apply_result.json"), help="整理后 apply 结果")
    parser.add_argument("--plan", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/cleanup_plan.json"), help="整理计划 JSON")
    parser.add_argument("--output", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/verify_result.json"), help="验证报告输出路径")
    parser.add_argument("--verbose-result", action="store_true", help="在 stdout 打印完整验证报告；默认只打印轻量摘要")
    return parser.parse_args()


def build_cli_summary(report: Dict[str, Any], output_path: Path) -> Dict[str, Any]:
    """构建命令行轻量输出，完整验证报告只写入文件。"""
    return {
        "status": "completed" if report.get("allPass") else "failed",
        "output": output_path.as_posix(),
        "allPass": report.get("allPass"),
        "summary": report.get("summary", {}),
        "warningCodes": [warning.get("code") for warning in report.get("warnings", []) if isinstance(warning, dict)],
        "blockingErrorCodes": [error.get("code") for error in report.get("blockingErrors", []) if isinstance(error, dict)],
    }


def main() -> int:
    """命令行入口。"""
    args = parse_args()
    report = verify(load_json(args.before), load_json(args.after), load_json(args.plan))
    write_json(args.output, report)
    output = report if args.verbose_result else build_cli_summary(report, args.output)
    print(json.dumps(output, ensure_ascii=True, indent=2))
    return 0 if report.get("allPass") else 2


if __name__ == "__main__":
    raise SystemExit(main())
