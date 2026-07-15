"""
Figma 层级整理计划生成器。

只读消费 MCP Relay 分析结果，按命名语义和保序原则生成用户确认用的分组计划。
脚本不访问 Figma，不写入 Figma。
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Dict, Iterable, List, Optional, Tuple


GROUP_KEYWORDS: List[Tuple[str, List[str]]] = [
    ("[Overlay]", ["overlay", "bubble", "tooltip", "popup", "toast", "badge", "float", "qp", "qipao", "气泡", "浮层", "弹窗", "提示"]),
    ("[Actions]", ["close", "bottom", "footer", "back", "btn_close", "button", "btn", "ok", "cancel", "关闭", "底部", "返回", "按钮"]),
    ("[Header]", ["header", "title", "top", "logo", "tips", "desc", "标题", "顶部", "说明"]),
    ("[Progress]", ["progress", "bar", "milestone", "slider", "fill", "jdt", "进度", "里程碑"]),
    ("[List]", ["task", "card", "item", "cell", "row", "tab", "day", "collect", "claim", "login", "locked", "任务", "领取", "登录", "已完成", "锁", "天", "页签", "选中"]),
    ("[Background]", ["bg", "background", "mask", "panel", "base", "frame", "db", "slice", "背景", "底", "遮罩", "框", "面板"]),
    ("[Fx]", ["fx", "effect", "light", "glow", "star", "shine", "decor", "特效", "光效", "装饰"]),
    ("[Content]", ["text", "label", "content", "num", "count", "文本", "内容", "数量"]),
]

PRIORITY = {
    "[Background]": 0,
    "[Header]": 10,
    "[Content]": 20,
    "[Progress]": 30,
    "[List]": 40,
    "[Actions]": 50,
    "[Overlay]": 60,
    "[Fx]": 70,
    "[Unclassified]": 90,
}

PSD_PREFIX_RE = re.compile(r"^\s*(?P<number>\d{1,4})[_\-\s]+(?P<label>.+?)\s*$")

class PlanError(RuntimeError):
    """表示输入数据不足以生成安全整理计划。"""


@dataclass(frozen=True)
class Bounds:
    """表示节点边界，并提供常用几何计算。"""

    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        """读取右边界坐标。"""
        return self.x + self.width

    @property
    def bottom(self) -> float:
        """读取下边界坐标。"""
        return self.y + self.height

    @property
    def area(self) -> float:
        """读取边界面积。"""
        return max(0.0, self.width) * max(0.0, self.height)

    @property
    def center_x(self) -> float:
        """读取中心点 X 坐标。"""
        return self.x + self.width * 0.5

    @property
    def center_y(self) -> float:
        """读取中心点 Y 坐标。"""
        return self.y + self.height * 0.5


def load_json(path: Path) -> Dict[str, Any]:
    """读取 UTF-8 或 UTF-8-BOM JSON 文件。"""
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    """写入 JSON 文件并确保目录存在。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_name(value: str) -> str:
    """清理节点名称，便于关键词匹配。"""
    text = str(value or "").strip().strip("'").strip('"')
    text = re.sub(r"^\[|\]$", "", text)
    text = re.sub(r"^\d+[_\-\s]+", "", text)
    return text.lower()


def node_haystack(node: Dict[str, Any]) -> str:
    """构建节点匹配文本，包含名称、路径和文本内容。"""
    values = [node.get("name", ""), node.get("path", ""), node.get("characters", "")]
    return " ".join(normalize_name(str(value)) for value in values)


def classify_node(node: Dict[str, Any]) -> str:
    """按命名语义给直接子节点分配候选分组。"""
    haystack = node_haystack(node)
    for group_name, keywords in GROUP_KEYWORDS:
        if any(keyword.lower() in haystack for keyword in keywords):
            return group_name
    if str(node.get("type") or "").upper() == "TEXT":
        return "[Content]"
    return "[Unclassified]"


def node_id_of(node: Dict[str, Any]) -> str:
    """读取节点 id，兼容 nodeId 字段。"""
    return str(node.get("id") or node.get("nodeId") or "")


def psd_prefix_record(node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Return a PSD numeric-prefix record from a direct child name, if present."""
    match = PSD_PREFIX_RE.match(str(node.get("name") or ""))
    if not match:
        return None
    try:
        number = int(match.group("number"))
    except ValueError:
        return None
    return {
        "number": number,
        "label": match.group("label"),
        "nodeId": node_id_of(node),
        "name": str(node.get("name") or ""),
        "sourceIndex": int(node.get("index") or 0),
        "node": node,
    }


def bounds_of(node: Dict[str, Any]) -> Optional[Bounds]:
    """读取节点相对边界，缺失时回退到绝对边界。"""
    raw = node.get("relativeBounds") or node.get("bounds") or node.get("absoluteBounds") or node.get("absoluteBoundingBox")
    if not isinstance(raw, dict):
        return None
    try:
        bounds = Bounds(
            x=float(raw.get("x")),
            y=float(raw.get("y")),
            width=float(raw.get("width")),
            height=float(raw.get("height")),
        )
    except (TypeError, ValueError):
        return None
    if bounds.width <= 0 or bounds.height <= 0:
        return None
    return bounds


def union_bounds(nodes: Iterable[Dict[str, Any]]) -> Optional[Bounds]:
    """计算一组节点的联合边界。"""
    bounds_list = [bounds for node in nodes if (bounds := bounds_of(node)) is not None]
    if not bounds_list:
        return None
    left = min(bounds.x for bounds in bounds_list)
    top = min(bounds.y for bounds in bounds_list)
    right = max(bounds.right for bounds in bounds_list)
    bottom = max(bounds.bottom for bounds in bounds_list)
    return Bounds(left, top, right - left, bottom - top)


def overlap_area(a: Bounds, b: Bounds) -> float:
    """计算两个边界的重叠面积。"""
    width = max(0.0, min(a.right, b.right) - max(a.x, b.x))
    height = max(0.0, min(a.bottom, b.bottom) - max(a.y, b.y))
    return width * height


def overlap_ratio(a: Bounds, b: Bounds) -> float:
    """计算较小节点面积口径下的重叠比例。"""
    smallest = min(a.area, b.area)
    if smallest <= 0:
        return 0.0
    return overlap_area(a, b) / smallest


def is_large_background(node: Dict[str, Any], root_bounds: Bounds) -> bool:
    """判断节点是否像区域背景或面板底图。"""
    bounds = bounds_of(node)
    if not bounds:
        return False
    if bounds.area >= root_bounds.area * 0.18:
        return True
    return bounds.width >= root_bounds.width * 0.72 and bounds.height >= root_bounds.height * 0.12


def is_action_node(node: Dict[str, Any], root_bounds: Bounds) -> bool:
    """判断节点是否像底部或关闭类操作节点。"""
    bounds = bounds_of(node)
    if not bounds:
        return False
    haystack = node_haystack(node)
    name_hit = any(keyword in haystack for keyword in ("close", "back", "btn_close", "关闭", "返回"))
    bottom_hit = bounds.center_y >= root_bounds.height * 0.82
    compact_hit = bounds.width <= root_bounds.width * 0.55 and bounds.height <= root_bounds.height * 0.18
    return name_hit or (bottom_hit and compact_hit)


def is_progress_node(node: Dict[str, Any], root_bounds: Bounds) -> bool:
    """判断节点是否像进度条、轨道或里程碑元素。"""
    bounds = bounds_of(node)
    if not bounds:
        return False
    haystack = node_haystack(node)
    if any(keyword in haystack for keyword in ("progress", "slider", "milestone", "bar", "jdt", "进度", "里程碑")):
        return True
    wide_short = bounds.width >= root_bounds.width * 0.45 and bounds.height <= root_bounds.height * 0.08
    return wide_short and root_bounds.height * 0.2 <= bounds.center_y <= root_bounds.height * 0.55


def is_overlay_node(node: Dict[str, Any], all_nodes: List[Dict[str, Any]], root_bounds: Bounds) -> bool:
    """判断节点是否像覆盖在主体上的浮层。"""
    bounds = bounds_of(node)
    if not bounds:
        return False
    haystack = node_haystack(node)
    if any(keyword in haystack for keyword in ("overlay", "bubble", "tooltip", "popup", "toast", "badge", "float", "qp", "qipao", "气泡", "浮层", "提示")):
        return True
    return False


def find_overlay_nodes(nodes: List[Dict[str, Any]], root_bounds: Bounds) -> List[Dict[str, Any]]:
    """从显式浮层种子向周边扩展，得到完整浮层节点集合。"""
    seeds = [node for node in nodes if is_overlay_node(node, nodes, root_bounds)]
    if not seeds:
        return []
    seed_bounds = union_bounds(seeds)
    if not seed_bounds:
        return seeds
    expanded = Bounds(
        seed_bounds.x - root_bounds.width * 0.06,
        seed_bounds.y - root_bounds.height * 0.04,
        seed_bounds.width + root_bounds.width * 0.12,
        seed_bounds.height + root_bounds.height * 0.08,
    )
    seed_indices = [int(node.get("index") or 0) for node in seeds]
    min_seed_index = min(seed_indices)
    max_seed_index = max(seed_indices)
    overlay_ids = {node_id_of(node) for node in seeds}
    for node in nodes:
        if node_id_of(node) in overlay_ids or is_large_background(node, root_bounds):
            continue
        node_index = int(node.get("index") or 0)
        if node_index < min_seed_index - 6 or node_index > max_seed_index + 6:
            continue
        bounds = bounds_of(node)
        if not bounds or bounds.area > root_bounds.area * 0.08:
            continue
        center_inside = expanded.x <= bounds.center_x <= expanded.right and expanded.y <= bounds.center_y <= expanded.bottom
        if center_inside or overlap_ratio(bounds, expanded) >= 0.25:
            overlay_ids.add(node_id_of(node))
    return [node for node in sorted_children(nodes) if node_id_of(node) in overlay_ids]


def find_result_payload(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """Return the innermost analyze result from MCP wrapper payloads."""
    current: Any = analysis
    for _ in range(8):
        if not isinstance(current, dict):
            break
        if isinstance(current.get("directChildren"), list) or isinstance(current.get("nodes"), list):
            return current
        nested = current.get("result")
        if not isinstance(nested, dict):
            return current
        current = nested
    return current if isinstance(current, dict) else analysis


def get_direct_children(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """从分析结果中读取根节点直接子节点列表。"""
    children = result.get("directChildren")
    if isinstance(children, list):
        return [child for child in children if isinstance(child, dict)]

    nodes = result.get("nodes")
    root_id = str(result.get("rootNodeId") or result.get("nodeId") or "")
    if isinstance(nodes, list) and root_id:
        return [node for node in nodes if isinstance(node, dict) and str(node.get("parentId") or "") == root_id]

    raise PlanError("分析结果缺少 directChildren，无法生成安全分组计划。")


def sorted_children(children: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按原 sibling index 排序，缺失时保持输入顺序。"""
    indexed = []
    for fallback_index, node in enumerate(children):
        index = node.get("index")
        if not isinstance(index, int):
            index = fallback_index
        copied = dict(node)
        copied["index"] = index
        indexed.append(copied)
    return sorted(indexed, key=lambda item: item["index"])


def collect_y_bands(nodes: List[Dict[str, Any]], root_bounds: Bounds) -> List[List[Dict[str, Any]]]:
    """按垂直中心点把节点聚合成粗区域。"""
    candidates = [node for node in sorted_children(nodes) if bounds_of(node) is not None]
    if not candidates:
        return [sorted_children(nodes)]

    heights = [bounds_of(node).height for node in candidates if bounds_of(node) is not None]
    typical_height = median(heights) if heights else root_bounds.height * 0.05
    gap_threshold = max(root_bounds.height * 0.08, typical_height * 1.35, 72.0)

    ordered = sorted(candidates, key=lambda item: (bounds_of(item).center_y if bounds_of(item) else 0.0, int(item.get("index") or 0)))
    bands: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    current_center = 0.0
    for node in ordered:
        bounds = bounds_of(node)
        if not bounds:
            continue
        if not current:
            current = [node]
            current_center = bounds.center_y
            continue
        if abs(bounds.center_y - current_center) > gap_threshold:
            bands.append(sorted_children(current))
            current = [node]
            current_center = bounds.center_y
            continue
        current.append(node)
        current_center = sum(bounds_of(item).center_y for item in current if bounds_of(item) is not None) / len(current)
    if current:
        bands.append(sorted_children(current))
    return bands


def semantic_group_for_band(nodes: List[Dict[str, Any]], root_bounds: Bounds, position: int, total: int) -> str:
    """根据区域位置、形态和命名语义选择通用分组名。"""
    if not nodes:
        return "[Unclassified]"
    band_bounds = union_bounds(nodes)
    if not band_bounds:
        return "[Unclassified]"

    semantic_counts: Dict[str, int] = {}
    for node in nodes:
        group_name = classify_node(node)
        semantic_counts[group_name] = semantic_counts.get(group_name, 0) + 1

    if semantic_counts.get("[Actions]", 0) >= max(1, len(nodes) // 2):
        return "[Actions]"
    if semantic_counts.get("[Overlay]", 0) >= max(1, len(nodes) // 2):
        return "[Overlay]"
    if semantic_counts.get("[Progress]", 0) >= max(1, len(nodes) // 3):
        return "[Progress]"
    if band_bounds.center_y <= root_bounds.height * 0.24 or position == 0:
        return "[Header]"
    if band_bounds.center_y >= root_bounds.height * 0.82 and len(nodes) <= 4:
        return "[Actions]"
    if len(nodes) >= 8:
        return "[List]"
    return "[Content]"


def background_anchor_nodes(nodes: List[Dict[str, Any]], root_bounds: Bounds) -> List[Dict[str, Any]]:
    """挑选可作为区域锚点的大面板背景节点。"""
    candidates = [node for node in sorted_children(nodes) if is_large_background(node, root_bounds)]
    filtered: List[Dict[str, Any]] = []
    for node in candidates:
        bounds = bounds_of(node)
        if not bounds:
            continue
        covered_by_existing = False
        for existing in filtered:
            existing_bounds = bounds_of(existing)
            if existing_bounds and overlap_ratio(bounds, existing_bounds) >= 0.92 and existing_bounds.area >= bounds.area:
                covered_by_existing = True
                break
        if not covered_by_existing:
            filtered.append(node)
    return filtered


def assign_nodes_to_anchors(
    nodes: List[Dict[str, Any]],
    anchors: List[Dict[str, Any]],
    root_bounds: Bounds,
) -> Tuple[List[Tuple[Dict[str, Any], List[Dict[str, Any]]]], List[Dict[str, Any]]]:
    """把节点按重叠关系归属到最近的大面板锚点。"""
    buckets: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]] = [(anchor, [anchor]) for anchor in anchors]
    leftovers: List[Dict[str, Any]] = []
    for node in sorted_children(nodes):
        if node in anchors:
            continue
        bounds = bounds_of(node)
        if not bounds:
            leftovers.append(node)
            continue
        best_index = -1
        best_score = 0.0
        for index, anchor in enumerate(anchors):
            anchor_bounds = bounds_of(anchor)
            if not anchor_bounds:
                continue
            overlap = overlap_ratio(bounds, anchor_bounds)
            center_inside = anchor_bounds.x - root_bounds.width * 0.03 <= bounds.center_x <= anchor_bounds.right + root_bounds.width * 0.03
            center_inside = center_inside and anchor_bounds.y - root_bounds.height * 0.03 <= bounds.center_y <= anchor_bounds.bottom + root_bounds.height * 0.03
            score = overlap + (0.35 if center_inside else 0.0)
            if score > best_score:
                best_score = score
                best_index = index
        if best_index >= 0 and best_score >= 0.28:
            buckets[best_index][1].append(node)
        else:
            leftovers.append(node)
    return buckets, leftovers


def anchor_group_name(anchor: Dict[str, Any], group_nodes: List[Dict[str, Any]], root_bounds: Bounds, position: int) -> str:
    """根据锚点区域位置和内容密度选择通用分组名。"""
    group_bounds = union_bounds(group_nodes)
    if not group_bounds:
        return "[Content]"
    if group_bounds.center_y <= root_bounds.height * 0.3 or position == 0:
        return "[Header]"
    if any(is_progress_node(node, root_bounds) for node in group_nodes):
        progress_count = sum(1 for node in group_nodes if is_progress_node(node, root_bounds) or classify_node(node) == "[Progress]")
        if progress_count >= max(2, len(group_nodes) // 5):
            return "[Progress]"
    if len(group_nodes) >= 8:
        return "[List]"
    return "[Content]"


def split_anchor_bucket(anchor: Dict[str, Any], nodes: List[Dict[str, Any]], root_bounds: Bounds) -> List[Tuple[str, List[Dict[str, Any]]]]:
    """对过大的锚点桶按内部功能带继续拆分。"""
    if len(nodes) < 14:
        return [(anchor_group_name(anchor, nodes, root_bounds, 0), nodes)]

    bucket_bounds = union_bounds(nodes)
    if not bucket_bounds or bucket_bounds.height < root_bounds.height * 0.18:
        return [(anchor_group_name(anchor, nodes, root_bounds, 0), nodes)]

    overlay_nodes = find_overlay_nodes(nodes, root_bounds)
    overlay_ids = {node_id_of(node) for node in overlay_nodes}
    body_nodes = [node for node in nodes if node_id_of(node) not in overlay_ids]
    progress_nodes = [node for node in body_nodes if is_progress_node(node, root_bounds)]
    progress_bounds = union_bounds(progress_nodes)

    result: List[Tuple[str, List[Dict[str, Any]]]] = []
    used_ids = set()
    if progress_bounds and len(progress_nodes) >= 2 and progress_bounds.center_y <= root_bounds.height * 0.58:
        progress_band: List[Dict[str, Any]] = []
        for node in body_nodes:
            bounds = bounds_of(node)
            if not bounds:
                continue
            close_y = abs(bounds.center_y - progress_bounds.center_y) <= max(root_bounds.height * 0.055, progress_bounds.height * 1.4)
            horizontal_overlap = bounds.right >= progress_bounds.x - root_bounds.width * 0.04 and bounds.x <= progress_bounds.right + root_bounds.width * 0.04
            compact = bounds.area <= root_bounds.area * 0.08 or is_progress_node(node, root_bounds)
            if close_y and horizontal_overlap and compact:
                progress_band.append(node)
                used_ids.add(node_id_of(node))

        before_progress = [
            node for node in body_nodes
            if node_id_of(node) not in used_ids and bounds_of(node) and bounds_of(node).center_y < progress_bounds.center_y
        ]
        after_progress = [
            node for node in body_nodes
            if node_id_of(node) not in used_ids and bounds_of(node) and bounds_of(node).center_y >= progress_bounds.center_y
        ]
        if before_progress:
            result.append(("[Content]", before_progress))
        if progress_band:
            result.append(("[Progress]", progress_band))
        if after_progress:
            result.append(("[List]", after_progress))
    else:
        result.append((anchor_group_name(anchor, body_nodes, root_bounds, 0), body_nodes))

    if overlay_nodes:
        result.append(("[Overlay]", overlay_nodes))
    return result or [(anchor_group_name(anchor, nodes, root_bounds, 0), nodes)]


def unique_group_name(base_name: str, existing: Dict[str, int]) -> str:
    """生成不重复的通用分组名。"""
    count = existing.get(base_name, 0) + 1
    existing[base_name] = count
    if count == 1:
        return base_name
    suffix = base_name.rstrip("]")
    return f"{suffix}{count}]"


def make_group(group_name: str, nodes: List[Dict[str, Any]], reason: str) -> Dict[str, Any]:
    """从节点列表构建 MCP Relay 可消费的分组计划。"""
    ordered_nodes = sorted_children(nodes)
    return {
        "name": group_name,
        "reason": reason,
        "count": len(ordered_nodes),
        "childNodeIds": [node_id_of(node) for node in ordered_nodes],
        "childNames": [str(node.get("name") or "") for node in ordered_nodes[:12]],
        "sourceIndices": [int(node.get("index") or 0) for node in ordered_nodes],
    }


def build_group_reason(group_name: str) -> str:
    """为分组生成可读原因，便于用户确认。"""
    reasons = {
        "[Bg]": "PSD 导入面板底图、背景切片或大面积底板元素。",
        "[Background]": "背景、底板、遮罩或大面积面板元素。",
        "[Header]": "标题、顶部装饰或说明文案。",
        "[Actions]": "底部操作区、关闭按钮、返回按钮或主要操作按钮。",
        "[Progress]": "进度条、轨道、里程碑文本或进度奖励元素。",
        "[ProgressSection]": "进度条、里程碑奖励、进度文本和阶段奖励组成的进度区域。",
        "[List]": "重复卡片、列表项、页签或成组内容项。",
        "[ListRoot]": "纵向重复内容列表的根容器，后续应继续包装 ScrollView / Viewport / Content。",
        "[TabBar]": "横向页签、日期或状态切换区域，后续应继续拆分为 TabItem。",
        "[Overlay]": "覆盖在主体区域上的气泡、提示、角标或浮层。",
        "[Fx]": "光效、特效或装饰层。",
        "[Content]": "未归入明确业务区的文本或内容节点。",
        "[Unclassified]": "命名语义不足，需要人工复核。",
    }
    return reasons.get(group_name, "按命名语义和原始顺序归入该组。")


def center_y_of(node: Dict[str, Any]) -> Optional[float]:
    """Return node center y when bounds are available."""
    bounds = bounds_of(node)
    return bounds.center_y if bounds else None


def high_coverage_psd_prefix_hints(semantic_hints: Optional[Dict[str, Any]], children: List[Dict[str, Any]]) -> bool:
    """Return true when PSD prefix hints are strong enough to help root grouping."""
    if not isinstance(semantic_hints, dict) or semantic_hints.get("kind") != "psd-prefix-hints":
        return False
    coverage = semantic_hints.get("coverage") if isinstance(semantic_hints.get("coverage"), dict) else {}
    try:
        coverage_ratio = float(coverage.get("coverageRatio") or 0)
        prefixed_count = int(coverage.get("prefixedNodeCount") or 0)
    except (TypeError, ValueError):
        return False
    warnings = semantic_hints.get("warnings") if isinstance(semantic_hints.get("warnings"), list) else []
    warning_codes = {str(warning.get("code") or "") for warning in warnings if isinstance(warning, dict)}
    segments = semantic_hints.get("segments") if isinstance(semantic_hints.get("segments"), list) else []
    return (
        coverage_ratio >= 0.65
        and prefixed_count >= min(12, max(0, len(children)))
        and len(segments) >= 3
        and "duplicatePsdPrefixes" not in warning_codes
        and "singleLargePrefixRun" not in warning_codes
    )


def maybe_group(group_name: str, nodes: List[Dict[str, Any]], reason: str) -> Optional[Dict[str, Any]]:
    """Build a group only when it has children."""
    if not nodes:
        return None
    return make_group(group_name, nodes, reason)


def center_values(nodes: List[Dict[str, Any]], axis: str) -> List[float]:
    """Return sorted center values for bounded nodes."""
    values: List[float] = []
    for node in nodes:
        bounds = bounds_of(node)
        if not bounds:
            continue
        values.append(bounds.center_x if axis == "x" else bounds.center_y)
    return sorted(values)


def distinct_center_count(values: List[float], min_gap: float) -> int:
    """Count distinct center bands with a minimum gap."""
    distinct: List[float] = []
    for value in values:
        if not distinct or abs(value - distinct[-1]) >= min_gap:
            distinct.append(value)
    return len(distinct)


def compact_horizontal_hint(nodes: List[Dict[str, Any]]) -> bool:
    """Accept small tab/date strips that are too small for the generic detector."""
    bounded = [node for node in nodes if bounds_of(node) is not None]
    if len(bounded) < 3:
        return False
    heights = [bounds_of(node).height for node in bounded if bounds_of(node) is not None]
    y_values = center_values(bounded, "y")
    if not y_values:
        return False
    y_span = max(y_values) - min(y_values)
    max_y_span = max(96.0, (median(heights) if heights else 48.0) * 2.5)
    return y_span <= max_y_span and distinct_center_count(center_values(bounded, "x"), 32.0) >= 3


def compact_vertical_hint(nodes: List[Dict[str, Any]]) -> bool:
    """Accept small vertical row stacks that are too small for the generic detector."""
    bounded = [node for node in nodes if bounds_of(node) is not None]
    if len(bounded) < 3:
        return False
    widths = [bounds_of(node).width for node in bounded if bounds_of(node) is not None]
    median_width = median(widths) if widths else 0.0
    wide_enough = median_width >= 120.0
    return wide_enough and distinct_center_count(center_values(bounded, "y"), 32.0) >= 3


def psd_hint_segment_nodes(
    segment: Dict[str, Any],
    node_by_id: Dict[str, Dict[str, Any]],
    node_by_source_index: Dict[int, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Resolve hint segment nodes from nodeIds, falling back to sourceIndices."""
    nodes: List[Dict[str, Any]] = []
    seen: set[str] = set()
    node_ids = segment.get("nodeIds") if isinstance(segment.get("nodeIds"), list) else []
    for value in node_ids:
        node = node_by_id.get(str(value))
        node_id = node_id_of(node) if node else ""
        if node and node_id and node_id not in seen:
            nodes.append(node)
            seen.add(node_id)
    if nodes:
        return sorted_children(nodes)

    source_indices = segment.get("sourceIndices") if isinstance(segment.get("sourceIndices"), list) else []
    for value in source_indices:
        try:
            source_index = int(value)
        except (TypeError, ValueError):
            continue
        node = node_by_source_index.get(source_index)
        node_id = node_id_of(node) if node else ""
        if node and node_id and node_id not in seen:
            nodes.append(node)
            seen.add(node_id)
    return sorted_children(nodes)


def psd_hint_segment_passes_geometry(name: str, nodes: List[Dict[str, Any]], root_bounds: Bounds) -> bool:
    """Gate semantic hint segments with geometry before they can shape a plan."""
    if not nodes:
        return False
    if name == "[TabBar]":
        return has_horizontal_repetition(nodes) or compact_horizontal_hint(nodes)
    if name == "[ListRoot]":
        return has_vertical_repetition(nodes) or compact_vertical_hint(nodes)
    if name == "[Bg]":
        group_bounds = union_bounds(nodes)
        return (
            any(is_large_background(node, root_bounds) for node in nodes)
            or bool(group_bounds and group_bounds.area >= root_bounds.area * 0.16)
        )
    if name == "[ProgressSection]":
        group_bounds = union_bounds(nodes)
        return (
            len(nodes) >= 3
            and (
                any(is_progress_node(node, root_bounds) for node in nodes)
                or bool(group_bounds and group_bounds.width >= root_bounds.width * 0.35 and group_bounds.height <= root_bounds.height * 0.25)
            )
        )
    return False


def build_psd_prefix_segment_groups(
    children: List[Dict[str, Any]],
    root_bounds: Bounds,
    semantic_hints: Optional[Dict[str, Any]],
) -> Optional[List[Dict[str, Any]]]:
    """Build groups from prefix runs only when each run has matching geometry."""
    if not high_coverage_psd_prefix_hints(semantic_hints, children):
        return None
    segments = semantic_hints.get("segments") if isinstance(semantic_hints.get("segments"), list) else []
    if not segments:
        return None

    sorted_nodes = sorted_children(children)
    node_by_id = {node_id_of(node): node for node in sorted_nodes if node_id_of(node)}
    node_by_source_index = {int(node.get("index") or 0): node for node in sorted_nodes}
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    used_ids: set[str] = set()

    allowed_names = {"[TabBar]", "[Bg]", "[ProgressSection]", "[ListRoot]"}
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        candidate_name = str(segment.get("candidateName") or "")
        if candidate_name not in allowed_names:
            continue
        nodes = psd_hint_segment_nodes(segment, node_by_id, node_by_source_index)
        nodes = [node for node in nodes if node_id_of(node) and node_id_of(node) not in used_ids]
        if not psd_hint_segment_passes_geometry(candidate_name, nodes, root_bounds):
            continue
        grouped.setdefault(candidate_name, []).extend(nodes)
        used_ids.update(node_id_of(node) for node in nodes if node_id_of(node))

    if len(grouped) < 2:
        return None

    leftover_nodes = [node for node in sorted_nodes if node_id_of(node) not in used_ids]
    planned: List[Dict[str, Any]] = []
    for group_name, group_nodes in grouped.items():
        if not psd_hint_segment_passes_geometry(group_name, group_nodes, root_bounds):
            return None
        planned.append(make_group(group_name, group_nodes, build_group_reason(group_name)))
    if leftover_nodes:
        planned.extend(build_geometry_groups(leftover_nodes, root_bounds))

    planned = order_groups_for_visual_stack(planned)
    planned_ids = [node_id for group in planned for node_id in group.get("childNodeIds", [])]
    expected_ids = [node_id_of(node) for node in sorted_nodes if node_id_of(node)]
    if set(planned_ids) != set(expected_ids) or len(planned_ids) != len(set(planned_ids)):
        return None
    return planned


def build_psd_prefix_geometry_groups(
    children: List[Dict[str, Any]],
    root_bounds: Bounds,
    semantic_hints: Optional[Dict[str, Any]],
) -> Optional[List[Dict[str, Any]]]:
    """Build stricter PSD-import root containers from prefix coverage plus geometry gates."""
    if not high_coverage_psd_prefix_hints(semantic_hints, children):
        return None

    def fallback_to_segment_groups() -> Optional[List[Dict[str, Any]]]:
        return build_psd_prefix_segment_groups(children, root_bounds, semantic_hints)

    sorted_nodes = sorted_children(children)
    assigned: set[str] = set()

    def pick(predicate: Any) -> List[Dict[str, Any]]:
        picked: List[Dict[str, Any]] = []
        for node in sorted_nodes:
            node_id = node_id_of(node)
            if not node_id or node_id in assigned:
                continue
            if predicate(node):
                picked.append(node)
                assigned.add(node_id)
        return picked

    def y_between(node: Dict[str, Any], low: float, high: float) -> bool:
        center_y = center_y_of(node)
        return center_y is not None and root_bounds.height * low <= center_y <= root_bounds.height * high

    footer_nodes = pick(lambda node: y_between(node, 0.90, 1.05))
    tab_nodes = pick(lambda node: y_between(node, 0.74, 0.90))
    bg_nodes = pick(lambda node: is_large_background(node, root_bounds))
    progress_nodes = pick(lambda node: y_between(node, 0.22, 0.34) or (is_progress_node(node, root_bounds) and y_between(node, 0.18, 0.36)))
    list_nodes = pick(lambda node: y_between(node, 0.34, 0.74))
    header_nodes = pick(lambda node: y_between(node, 0.0, 0.24))
    leftover_nodes = [node for node in sorted_nodes if node_id_of(node) not in assigned]

    if len(tab_nodes) < 6 or not has_horizontal_repetition(tab_nodes):
        return fallback_to_segment_groups()
    if len(bg_nodes) < 2:
        return fallback_to_segment_groups()
    if len(list_nodes) < 6 or not has_vertical_repetition(list_nodes):
        return fallback_to_segment_groups()
    if len(progress_nodes) < 4:
        return fallback_to_segment_groups()

    groups = [
        maybe_group("[Actions]", footer_nodes, build_group_reason("[Actions]")),
        maybe_group("[TabBar]", tab_nodes, build_group_reason("[TabBar]")),
        maybe_group("[Bg]", bg_nodes, build_group_reason("[Bg]")),
        maybe_group("[ProgressSection]", progress_nodes, build_group_reason("[ProgressSection]")),
        maybe_group("[ListRoot]", list_nodes, build_group_reason("[ListRoot]")),
        maybe_group("[Header]", header_nodes, build_group_reason("[Header]")),
        maybe_group("[Content]", leftover_nodes, "PSD prefix/geometry gates could not safely assign these nodes to a stronger root container."),
    ]
    planned = [group for group in groups if group is not None]
    planned_ids = [node_id for group in planned for node_id in group.get("childNodeIds", [])]
    expected_ids = [node_id_of(node) for node in sorted_nodes if node_id_of(node)]
    if set(planned_ids) != set(expected_ids) or len(planned_ids) != len(set(planned_ids)):
        return fallback_to_segment_groups()
    return planned or fallback_to_segment_groups()


def build_geometry_groups(children: List[Dict[str, Any]], root_bounds: Bounds) -> List[Dict[str, Any]]:
    """按空间区域和轻量语义生成通用分组。"""
    sorted_nodes = sorted_children(children)
    action_nodes = [node for node in sorted_nodes if is_action_node(node, root_bounds)]
    remaining = [node for node in sorted_nodes if node not in action_nodes]
    groups: List[Dict[str, Any]] = []
    used_names: Dict[str, int] = {}

    anchors = background_anchor_nodes(remaining, root_bounds)
    anchor_buckets, leftovers = assign_nodes_to_anchors(remaining, anchors, root_bounds)
    for position, (_anchor, bucket_nodes) in enumerate(anchor_buckets):
        splits = split_anchor_bucket(_anchor, bucket_nodes, root_bounds)
        for group_name, split_nodes in splits:
            if len(splits) == 1:
                group_name = anchor_group_name(_anchor, split_nodes, root_bounds, position)
            groups.append(make_group(unique_group_name(group_name, used_names), split_nodes, build_group_reason(group_name)))

    assigned = {node_id_of(node) for _anchor, bucket_nodes in anchor_buckets for node in bucket_nodes}
    unassigned = [node for node in leftovers if node_id_of(node) not in assigned]
    if unassigned:
        progress_nodes = [node for node in unassigned if is_progress_node(node, root_bounds)]
        rest_nodes = [node for node in unassigned if node not in progress_nodes]
        if progress_nodes:
            groups.append(make_group(unique_group_name("[Progress]", used_names), progress_nodes, build_group_reason("[Progress]")))
        bands = collect_y_bands(rest_nodes, root_bounds)
        total_bands = len(bands)
        for position, band_nodes in enumerate(bands):
            group_name = semantic_group_for_band(band_nodes, root_bounds, position, total_bands)
            groups.append(make_group(unique_group_name(group_name, used_names), band_nodes, build_group_reason(group_name)))

    if action_nodes:
        groups.append(make_group(unique_group_name("[Actions]", used_names), action_nodes, build_group_reason("[Actions]")))

    return order_groups_for_visual_stack(groups)


def order_groups_for_visual_stack(groups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按原始层级大致排序，并把浮层放到较靠后位置。"""
    def sort_key(group: Dict[str, Any]) -> Tuple[int, int]:
        name = str(group.get("name") or "")
        indices = [int(index) for index in group.get("sourceIndices", [])]
        first_index = min(indices) if indices else 0
        if name.startswith("[Background]"):
            return (0, first_index)
        if name.startswith("[Overlay]"):
            return (80, first_index)
        if name.startswith("[Actions]"):
            return (90, first_index)
        return (20, first_index)

    return sorted(groups, key=sort_key)


def group_children(children: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按语义分组并保留组内原始 sibling 顺序。"""
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for child in sorted_children(children):
        group_name = classify_node(child)
        buckets.setdefault(group_name, []).append(child)

    groups: List[Dict[str, Any]] = []
    # 分组顺序优先按原 sibling 首次出现顺序，减少跨组重排导致的遮挡变化风险。
    ordered_group_names = sorted(
        buckets.keys(),
        key=lambda value: min(int(node.get("index") or 0) for node in buckets[value]),
    )
    for group_name in ordered_group_names:
        group_nodes = buckets[group_name]
        groups.append({
            "name": group_name,
            "reason": build_group_reason(group_name),
            "count": len(group_nodes),
            "childNodeIds": [str(node.get("id") or node.get("nodeId") or "") for node in group_nodes],
            "childNames": [str(node.get("name") or "") for node in group_nodes[:12]],
            "sourceIndices": [int(node.get("index") or 0) for node in group_nodes],
        })
    return groups


def validate_groups(groups: List[Dict[str, Any]], expected_count: int) -> List[Dict[str, Any]]:
    """验证计划中没有漏节点或重复节点。"""
    errors: List[Dict[str, Any]] = []
    seen: Dict[str, str] = {}
    duplicates: List[Dict[str, str]] = []
    missing_ids = 0

    for group in groups:
        for node_id in group.get("childNodeIds", []):
            if not node_id:
                missing_ids += 1
                continue
            if node_id in seen:
                duplicates.append({"nodeId": node_id, "firstGroup": seen[node_id], "secondGroup": group.get("name", "")})
            seen[node_id] = group.get("name", "")

    if duplicates:
        errors.append({"code": "duplicateNodeIds", "message": "计划中存在重复节点。", "details": {"duplicates": duplicates}})
    if missing_ids:
        errors.append({"code": "missingNodeIds", "message": "计划中存在空节点 id。", "details": {"count": missing_ids}})
    if len(seen) != expected_count:
        errors.append({
            "code": "nodeCountMismatch",
            "message": "计划节点数与根直接子节点数量不一致。",
            "details": {"actual": len(seen), "expected": expected_count},
        })
    return errors


def find_large_groups(groups: List[Dict[str, Any]], expected_count: int) -> List[Dict[str, Any]]:
    """找出吞掉过多节点的粗糙分组。"""
    if expected_count <= 0:
        return []
    results: List[Dict[str, Any]] = []
    for group in groups:
        count = int(group.get("count") or 0)
        ratio = count / expected_count
        if count >= 8 and ratio >= 0.7:
            results.append({
                "name": group.get("name", ""),
                "count": count,
                "ratio": round(ratio, 3),
            })
    return results


def infer_prefix_hint_name(records: List[Dict[str, Any]], root_bounds: Optional[Bounds]) -> str:
    """Infer a generic group name for a PSD numeric-prefix run."""
    nodes = [record.get("node") for record in records if isinstance(record.get("node"), dict)]
    labels = " ".join(normalize_name(str(record.get("label") or "")) for record in records)
    if any(token in labels for token in ("tab", "btn", "toggle", "select")) or has_horizontal_repetition(nodes):
        return "[TabBar]"
    if any(token in labels for token in ("bg", "background", "mask", "panel", "base")):
        return "[Bg]"
    if has_vertical_repetition(nodes):
        return "[ListRoot]"
    if root_bounds and nodes and all(is_large_background(node, root_bounds) for node in nodes):
        return "[Bg]"
    return "[Content]"


def build_psd_prefix_hints(children: List[Dict[str, Any]], root_bounds: Optional[Bounds]) -> Dict[str, Any]:
    """Build reporting-only PSD numeric-prefix hints from direct child names."""
    records = [record for child in sorted_children(children) if (record := psd_prefix_record(child))]
    if not records:
        return {
            "schemaVersion": 1,
            "kind": "psd-prefix-hints",
            "hintOnly": True,
            "segments": [],
            "coverage": {"prefixedNodeCount": 0, "directChildCount": len(children), "coverageRatio": 0.0},
            "warnings": [],
        }

    records.sort(key=lambda item: (int(item["number"]), int(item["sourceIndex"])))
    segments: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    for record in records:
        if not current or int(record["number"]) == int(current[-1]["number"]) + 1:
            current.append(record)
            continue
        segments.append(current)
        current = [record]
    if current:
        segments.append(current)

    duplicate_numbers = sorted({
        int(record["number"])
        for record in records
        if sum(1 for other in records if int(other["number"]) == int(record["number"])) > 1
    })
    segment_payloads: List[Dict[str, Any]] = []
    for segment in segments:
        numbers = [int(record["number"]) for record in segment]
        node_ids = [str(record["nodeId"]) for record in segment if record.get("nodeId")]
        nodes = [record["node"] for record in segment if isinstance(record.get("node"), dict)]
        union = union_bounds(nodes)
        segment_payloads.append({
            "hintOnly": True,
            "candidateName": infer_prefix_hint_name(segment, root_bounds),
            "startPrefix": numbers[0],
            "endPrefix": numbers[-1],
            "count": len(segment),
            "nodeIds": node_ids,
            "sourceIndices": [int(record["sourceIndex"]) for record in segment],
            "sampleNames": [str(record["name"]) for record in segment[:8]],
            "bounds": {
                "x": union.x,
                "y": union.y,
                "width": union.width,
                "height": union.height,
            } if union else None,
            "usedSignals": ["numericPrefixContinuity", "bounds", "sourceIndex"],
            "ignoredForScoring": ["name", "path", "characters"],
        })

    prefixed_count = len(records)
    warnings: List[Dict[str, Any]] = []
    if duplicate_numbers:
        warnings.append({"code": "duplicatePsdPrefixes", "numbers": duplicate_numbers})
    if len(segment_payloads) == 1 and prefixed_count >= 8:
        warnings.append({"code": "singleLargePrefixRun", "count": prefixed_count})

    return {
        "schemaVersion": 1,
        "kind": "psd-prefix-hints",
        "hintOnly": True,
        "segments": segment_payloads,
        "coverage": {
            "prefixedNodeCount": prefixed_count,
            "directChildCount": len(children),
            "coverageRatio": round(prefixed_count / len(children), 4) if children else 0.0,
        },
        "warnings": warnings,
    }


def find_sparse_groups(groups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """找出源 sibling 分布过散、可能仍需拆分的分组。"""
    results: List[Dict[str, Any]] = []
    for group in groups:
        indices = sorted(int(index) for index in group.get("sourceIndices", []))
        if len(indices) < 6:
            continue
        span = indices[-1] - indices[0] + 1
        density = len(indices) / span if span else 1.0
        if density < 0.45:
            results.append({
                "name": group.get("name", ""),
                "sourceIndices": indices,
                "density": round(density, 3),
            })
    return results


def collect_planner_metrics(children: List[Dict[str, Any]], groups: List[Dict[str, Any]], planner_name: str) -> Dict[str, Any]:
    """统计计划覆盖率、分组规模和算法产物质量。"""
    expected_ids = {node_id_of(node) for node in children if node_id_of(node)}
    planned_ids = [str(node_id) for group in groups for node_id in group.get("childNodeIds", [])]
    duplicate_ids = sorted({node_id for node_id in planned_ids if planned_ids.count(node_id) > 1})
    covered = len(set(planned_ids) & expected_ids)
    group_sizes = [int(group.get("count") or 0) for group in groups]
    max_group_size = max(group_sizes) if group_sizes else 0
    coverage_ratio = covered / len(expected_ids) if expected_ids else 1.0
    largest_group_ratio = max_group_size / len(expected_ids) if expected_ids else 0.0
    return {
        "planner": planner_name,
        "coverageRatio": round(coverage_ratio, 4),
        "coveredNodeCount": covered,
        "expectedNodeCount": len(expected_ids),
        "duplicateNodeCount": len(duplicate_ids),
        "largestGroupSize": max_group_size,
        "largestGroupRatio": round(largest_group_ratio, 4),
        "groupNames": [str(group.get("name") or "") for group in groups],
    }


def index_list_of(group: Dict[str, Any]) -> List[int]:
    """Return sorted source indices for a plan group."""
    indices: List[int] = []
    for value in group.get("sourceIndices", []):
        try:
            indices.append(int(value))
        except (TypeError, ValueError):
            continue
    return sorted(indices)


def has_vertical_repetition(nodes: List[Dict[str, Any]]) -> bool:
    """Detect list-like repeated rows from geometry, without page-specific names."""
    bounded = [node for node in nodes if bounds_of(node) is not None]
    if len(bounded) < 6:
        return False
    tall_rows = [
        node for node in bounded
        if (bounds_of(node) and bounds_of(node).width >= 180 and bounds_of(node).height >= 40)
    ]
    if len(tall_rows) >= 3:
        centers = sorted(round(bounds_of(node).center_y, 1) for node in tall_rows if bounds_of(node))
        distinct_rows: List[float] = []
        for y in centers:
            if not distinct_rows or abs(y - distinct_rows[-1]) >= 24:
                distinct_rows.append(y)
        if len(distinct_rows) >= 3:
            return True
    y_values = sorted(round(bounds_of(node).center_y, 1) for node in bounded if bounds_of(node))
    bands: List[List[float]] = []
    for y in y_values:
        if not bands or abs(y - bands[-1][-1]) > 64:
            bands.append([y])
        else:
            bands[-1].append(y)
    return sum(1 for band in bands if len(band) >= 3) >= 3


def has_horizontal_repetition(nodes: List[Dict[str, Any]]) -> bool:
    """Detect tab-like repeated columns from geometry, without page-specific names."""
    bounded = [node for node in nodes if bounds_of(node) is not None]
    if len(bounded) < 6:
        return False
    wide_cols = [
        node for node in bounded
        if (bounds_of(node) and bounds_of(node).width >= 40 and bounds_of(node).height >= 40)
    ]
    if len(wide_cols) < 4:
        return False
    centers = sorted(round(bounds_of(node).center_x, 1) for node in wide_cols if bounds_of(node))
    distinct_cols: List[float] = []
    for x in centers:
        if not distinct_cols or abs(x - distinct_cols[-1]) >= 32:
            distinct_cols.append(x)
    return len(distinct_cols) >= 4


def has_repeated_group_rows(groups: List[Dict[str, Any]], children: List[Dict[str, Any]]) -> bool:
    """Detect when current plan groups are already coarse vertical list rows."""
    row_bounds: List[Bounds] = []
    for group in groups:
        nodes = group_nodes_by_ids(children, group)
        group_bounds = union_bounds(nodes)
        if group_bounds and group_bounds.width >= 180 and group_bounds.height >= 40:
            row_bounds.append(group_bounds)
    if len(row_bounds) < 3:
        return False
    row_bounds.sort(key=lambda bounds: bounds.center_y)
    distinct_rows: List[Bounds] = []
    for bounds in row_bounds:
        if not distinct_rows or abs(bounds.center_y - distinct_rows[-1].center_y) >= 32:
            distinct_rows.append(bounds)
    if len(distinct_rows) < 3:
        return False
    widths = [bounds.width for bounds in distinct_rows]
    avg_width = sum(widths) / len(widths)
    similar_widths = sum(1 for width in widths if abs(width - avg_width) <= max(80.0, avg_width * 0.25))
    return similar_widths >= 3


def group_nodes_by_ids(children: List[Dict[str, Any]], group: Dict[str, Any]) -> List[Dict[str, Any]]:
    ids = {str(node_id) for node_id in group.get("childNodeIds", [])}
    return [node for node in children if node_id_of(node) in ids]


def group_name_text(group: Dict[str, Any]) -> str:
    return normalize_name(str(group.get("name") or ""))


def has_progress_marker_name(value: str) -> bool:
    text = normalize_name(value)
    return any(token in text for token in ("jdtbig3", "marker", "tick", "milestone"))


def node_has_progress_marker_name(node: Dict[str, Any]) -> bool:
    return any(has_progress_marker_name(str(value or "")) for value in (node.get("name"), node.get("path"), node.get("characters")))


def group_is_progress_track(group: Dict[str, Any]) -> bool:
    text = group_name_text(group)
    return "progresstrack" in text or "progressbar" in text or text in {"track", "bar"}


def group_is_reward_slot(group: Dict[str, Any]) -> bool:
    text = group_name_text(group)
    return "rewardslot" in text or text.startswith("milestone") or text.startswith("reward_")


def reward_marker_ownership_issues(groups: List[Dict[str, Any]], children: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Find marker/tick nodes that should travel with reward slots, not the progress track."""
    has_reward_slots = any(group_is_reward_slot(group) for group in groups)
    if not has_reward_slots:
        return []

    issues: List[Dict[str, Any]] = []
    for group in groups:
        if not group_is_progress_track(group):
            continue
        nodes = group_nodes_by_ids(children, group)
        marker_nodes = [node for node in nodes if node_has_progress_marker_name(node)]
        if not marker_nodes:
            continue
        issues.append({
            "name": str(group.get("name") or ""),
            "code": "progressMarkerNotInRewardSlot",
            "markerNames": [str(node.get("name") or "") for node in marker_nodes[:12]],
            "sourceIndices": index_list_of(group),
            "requiredStructure": "Move marker/tick/jdtbig3 nodes into matching [RewardSlot_*] or [Milestone_*] groups; keep [ProgressTrack] for track/fill/slice nodes only.",
        })
    return issues


def semantic_depth_issues(groups: List[Dict[str, Any]], children: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Find groups that still look like unexpanded list/tab structures."""
    issues: List[Dict[str, Any]] = []
    plan_has_list_rows = has_repeated_group_rows(groups, children)
    issues.extend(reward_marker_ownership_issues(groups, children))
    for group in groups:
        nodes = group_nodes_by_ids(children, group)
        group_name = str(group.get("name") or "")
        count = len(nodes)
        if count < 6:
            continue
        issue = {
            "name": group_name,
            "count": count,
            "sourceIndices": index_list_of(group),
            "sampleNames": [str(node.get("name") or "") for node in nodes[:8]],
        }
        normalized_group_name = normalize_name(group_name)
        if "tabbar" in normalized_group_name:
            issues.append({
                **issue,
                "code": "needsTabItemSplit",
                "requiredStructure": "[TabBar] > [TabItem_*]",
            })
        elif "progresssection" in normalized_group_name:
            issues.append({
                **issue,
                "code": "semanticGroupStillCoarse",
                "requiredStructure": "[ProgressSection] > [ProgressBar] + [Milestone_*] / [RewardSlot_*]",
            })
        elif "listroot" in normalized_group_name:
            issues.append({
                **issue,
                "code": "needsListItemSplit",
                "requiredStructure": "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*] or [ListRoot] > [List] > [Item_*]",
            })
        elif plan_has_list_rows or has_vertical_repetition(nodes):
            issues.append({
                **issue,
                "code": "needsListItemSplit",
                "requiredStructure": "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*] or [ListRoot] > [List] > [Item_*]",
            })
        elif has_horizontal_repetition(nodes):
            issues.append({
                **issue,
                "code": "needsTabItemSplit",
                "requiredStructure": "[TabBar] > [TabItem_*]",
            })
        elif count >= 12:
            issues.append({
                **issue,
                "code": "semanticGroupStillCoarse",
                "requiredStructure": "Split into reusable child units or document why it is static.",
            })
    return issues


def build_plan_warnings(
    groups: List[Dict[str, Any]],
    children: List[Dict[str, Any]],
    metrics: Dict[str, Any],
    semantic_hints: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """根据计划质量生成需要人工复核的 warning。"""
    warnings: List[Dict[str, Any]] = []
    if len(children) == 1:
        only_child = children[0]
        warnings.append({
            "code": "singleDirectChild",
            "message": "目标节点只有一个直接子节点，可能选中了冗余外层包装；应优先分析内层节点。",
            "details": {
                "nextTargetNodeId": node_id_of(only_child),
                "nextTargetName": str(only_child.get("name") or ""),
                "nextTargetType": str(only_child.get("type") or ""),
            },
        })

    if any(str(group.get("name") or "").startswith("[Unclassified]") for group in groups):
        warnings.append({"code": "hasUnclassified", "message": "存在未分类分组，应用前需要人工确认。"})

    non_contiguous = find_non_contiguous_groups(groups)
    if non_contiguous:
        warnings.append({
            "code": "nonContiguousGroups",
            "message": "部分分组的原始 sibling 序号不连续，应用前需要确认不会改变遮挡关系。",
            "details": {"groups": non_contiguous},
        })

    sparse_groups = find_sparse_groups(groups)
    if sparse_groups:
        warnings.append({
            "code": "sparseGroups",
            "message": "部分分组源节点分布较散，可能仍需按子区域继续拆分。",
            "details": {"groups": sparse_groups},
        })

    large_groups = find_large_groups(groups, len(children))
    if large_groups:
        warnings.append({
            "code": "largeGroups",
            "message": "存在过大的分组，自动计划可能仍然偏粗。",
            "details": {"groups": large_groups},
        })

    if semantic_hints and semantic_hints.get("segments"):
        warnings.append({
            "code": "psdPrefixHintsAvailable",
            "message": "PSD numeric-prefix runs are available as reporting-only hints; they must not bypass geometry/repeat-cluster gates.",
            "details": {
                "hintOnly": True,
                "coverage": semantic_hints.get("coverage", {}),
                "segments": [
                    {
                        "candidateName": segment.get("candidateName"),
                        "startPrefix": segment.get("startPrefix"),
                        "endPrefix": segment.get("endPrefix"),
                        "count": segment.get("count"),
                        "sampleNames": segment.get("sampleNames", []),
                    }
                    for segment in semantic_hints.get("segments", [])
                    if isinstance(segment, dict)
                ],
            },
        })

    if float(metrics.get("coverageRatio") or 0) < 1.0 or int(metrics.get("duplicateNodeCount") or 0) > 0:
        warnings.append({
            "code": "coverageRisk",
            "message": "计划覆盖率或重复节点检查存在风险，请优先处理 blockingErrors。",
            "details": metrics,
        })
    for issue in semantic_depth_issues(groups, children):
        warnings.append({
            "code": issue["code"],
            "message": "Plan is still too coarse for production hierarchy cleanup.",
            "details": issue,
        })
    return warnings


def build_plan(analysis: Dict[str, Any], semantic_hints: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """从分析 JSON 构建层级整理计划。"""
    result = find_result_payload(analysis)
    children = get_direct_children(result)
    root_bounds_raw = result.get("rootBounds") if isinstance(result.get("rootBounds"), dict) else {}
    root_bounds = Bounds(
        x=0.0,
        y=0.0,
        width=float(root_bounds_raw.get("width") or 0),
        height=float(root_bounds_raw.get("height") or 0),
    )
    if root_bounds.width > 0 and root_bounds.height > 0 and all(bounds_of(child) is not None for child in children):
        psd_groups = build_psd_prefix_geometry_groups(children, root_bounds, semantic_hints)
        if psd_groups:
            groups = psd_groups
            planner_name = "psd-prefix-geometry-v1"
        else:
            groups = build_geometry_groups(children, root_bounds)
            planner_name = "geometry-v1"
    else:
        groups = group_children(children)
        planner_name = "semantic-fallback-v1"
    errors = validate_groups(groups, len(children))
    metrics = collect_planner_metrics(children, groups, planner_name)
    warnings = build_plan_warnings(groups, children, metrics, semantic_hints)
    for warning in warnings:
        if not isinstance(warning, dict):
            continue
        code = str(warning.get("code") or "")
        if code in {"needsListItemSplit", "needsTabItemSplit", "semanticGroupStillCoarse", "progressMarkerNotInRewardSlot"}:
            errors.append({
                "code": code,
                "message": "Plan must be expanded to reusable child units before apply.",
                "details": warning.get("details") if isinstance(warning.get("details"), dict) else {},
            })

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
            "rootBounds": root_bounds_raw,
            "quality": metrics,
            "semanticHints": {
                "kind": semantic_hints.get("kind"),
                "hintOnly": bool(semantic_hints.get("hintOnly")),
                "segmentCount": len(semantic_hints.get("segments", [])) if isinstance(semantic_hints.get("segments"), list) else 0,
                "coverage": semantic_hints.get("coverage", {}),
            } if semantic_hints else None,
        },
        "groups": groups,
        "warnings": warnings,
        "blockingErrors": errors,
    }


def find_non_contiguous_groups(groups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """找出源 sibling 序号不连续的分组，提示人工关注遮挡顺序。"""
    results: List[Dict[str, Any]] = []
    for group in groups:
        indices = sorted(int(index) for index in group.get("sourceIndices", []))
        if len(indices) <= 1:
            continue
        expected = list(range(indices[0], indices[-1] + 1))
        if indices != expected:
            results.append({
                "name": group.get("name", ""),
                "sourceIndices": indices,
            })
    return results


def write_report(path: Path, plan: Dict[str, Any]) -> None:
    """写入 Markdown 计划报告，供用户确认。"""
    lines = [
        "# Figma 层级整理计划",
        "",
        f"目标节点：`{plan['target'].get('name')}` / `{plan['target'].get('nodeId')}`",
        f"直接子节点：{plan['summary'].get('directChildCount')}",
        f"计划顶层组：{plan['summary'].get('groupCount')}",
        "",
        "## 分组",
        "",
    ]
    for group in plan.get("groups", []):
        lines.append(f"### {group.get('name')}（{group.get('count')} 个）")
        lines.append(f"原因：{group.get('reason')}")
        child_names = group.get("childNames") or []
        if child_names:
            lines.append("示例节点：")
            for name in child_names:
                lines.append(f"- {name}")
        lines.append("")

    if plan.get("warnings"):
        lines.append("## 警告")
        for warning in plan["warnings"]:
            lines.append(f"- {warning.get('code')}: {warning.get('message')}")
        lines.append("")

    if plan.get("blockingErrors"):
        lines.append("## 阻塞错误")
        for error in plan["blockingErrors"]:
            lines.append(f"- {error.get('code')}: {error.get('message')}")
        lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def limit_values(values: Iterable[Any], limit: int) -> Tuple[List[Any], bool]:
    """返回有限数量的值，并标记是否被截断。"""
    items = list(values)
    return items[:limit], len(items) > limit


def diagnostic_action_for_warning(code: str) -> str:
    """根据 warning 类型给出下一步诊断动作。"""
    actions = {
        "largeGroups": "REPLAN_INNER_GROUP",
        "sparseGroups": "SPLIT_BY_Y_BANDS",
        "nonContiguousGroups": "CHECK_Z_ORDER_THEN_REPLAN",
        "hasUnclassified": "REVIEW_UNCLASSIFIED_NAMES",
        "coverageRisk": "FIX_COVERAGE_BEFORE_APPLY",
        "singleDirectChild": "ANALYZE_INNER_CHILD",
    }
    return actions.get(code, "MANUAL_REVIEW")


def group_lookup(plan: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """按分组名索引计划分组。"""
    return {
        str(group.get("name") or ""): group
        for group in plan.get("groups", [])
        if isinstance(group, dict)
    }


def build_diagnostic_report(plan: Dict[str, Any]) -> str:
    """构建轻量计划质量诊断报告，避免回读完整 analysis JSON。"""
    summary = plan.get("summary") if isinstance(plan.get("summary"), dict) else {}
    quality = summary.get("quality") if isinstance(summary.get("quality"), dict) else {}
    warnings = [warning for warning in plan.get("warnings", []) if isinstance(warning, dict)]
    groups_by_name = group_lookup(plan)
    warning_codes = [str(warning.get("code") or "") for warning in warnings]
    lines = [
        "# Figma 层级整理计划诊断",
        "",
        "## DIAGNOSTIC_SUMMARY",
        "",
        f"- target: `{plan.get('target', {}).get('name')}` / `{plan.get('target', {}).get('nodeId')}`",
        f"- directChildCount: {summary.get('directChildCount')}",
        f"- groupCount: {summary.get('groupCount')}",
        f"- planner: {quality.get('planner')}",
        f"- coverageRatio: {quality.get('coverageRatio')}",
        f"- largestGroupSize: {quality.get('largestGroupSize')}",
        f"- largestGroupRatio: {quality.get('largestGroupRatio')}",
        f"- warningCodes: {', '.join(warning_codes) if warning_codes else 'none'}",
        "",
    ]

    semantic_hints = summary.get("semanticHints") if isinstance(summary.get("semanticHints"), dict) else {}
    if semantic_hints:
        lines.extend([
            "## SEMANTIC_HINTS",
            "",
            f"- kind: {semantic_hints.get('kind')}",
            f"- hintOnly: {semantic_hints.get('hintOnly')}",
            f"- segmentCount: {semantic_hints.get('segmentCount')}",
            f"- coverage: {json.dumps(semantic_hints.get('coverage', {}), ensure_ascii=False)}",
            "- rule: Hints are reporting-only and must not bypass geometry, repeat-cluster, unique-assignment, or validator gates.",
            "",
        ])

    if not warnings:
        lines.extend([
            "## 诊断结论",
            "",
            "- action: OK_TO_REVIEW_PLAN_REPORT",
            "- reason: 当前计划没有质量 warning；仍需按标准流程审阅 cleanup_plan.md 后再决定是否 apply。",
            "",
        ])
    else:
        lines.extend([
            "## 问题组",
            "",
        ])

    for warning in warnings:
        code = str(warning.get("code") or "")
        details = warning.get("details") if isinstance(warning.get("details"), dict) else {}
        warning_groups = details.get("groups") if isinstance(details.get("groups"), list) else []
        lines.append(f"### {code}")
        lines.append("")
        lines.append(f"- message: {warning.get('message')}")
        lines.append(f"- action: {diagnostic_action_for_warning(code)}")
        if not warning_groups:
            lines.append(f"- details: {json.dumps(details, ensure_ascii=False)}")
            lines.append("")
            continue

        for item in warning_groups:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            group = groups_by_name.get(name, {})
            indices = item.get("sourceIndices") if isinstance(item.get("sourceIndices"), list) else group.get("sourceIndices", [])
            names = group.get("childNames") if isinstance(group.get("childNames"), list) else []
            limited_indices, indices_truncated = limit_values(indices, 20)
            limited_names, names_truncated = limit_values(names, 12)
            lines.append(f"- group: `{name}`")
            lines.append(f"  - count: {item.get('count', group.get('count'))}")
            if "ratio" in item:
                lines.append(f"  - ratio: {item.get('ratio')}")
            if "density" in item:
                lines.append(f"  - density: {item.get('density')}")
            lines.append(f"  - sourceIndices: {limited_indices}")
            if indices_truncated:
                lines.append("  - sourceIndicesTruncated: true")
            if limited_names:
                lines.append(f"  - sampleNames: {json.dumps(limited_names, ensure_ascii=False)}")
            if names_truncated:
                lines.append("  - sampleNamesTruncated: true")
        lines.append("")

    if plan.get("blockingErrors"):
        lines.extend([
            "## 阻塞错误",
            "",
            "- action: FIX_BLOCKING_ERRORS_BEFORE_APPLY",
        ])
        for error in plan["blockingErrors"]:
            if isinstance(error, dict):
                lines.append(f"- {error.get('code')}: {error.get('message')}")
        lines.append("")

    lines.extend([
        "## 使用规则",
        "",
        "- 计划太粗、largeGroups、sparseGroups 或 nonContiguousGroups 时，先读本诊断报告。",
        "- 不要为了理解粗计划回读完整 analysis_result.json 或完整节点树。",
        "- 本报告只用于人工/LLM 诊断；apply 和 verify 仍使用完整 plan JSON 与 analyze/apply JSON。",
    ])
    return "\n".join(lines)


def write_diagnostic_report(path: Path, plan: Dict[str, Any]) -> None:
    """写入轻量计划诊断报告。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(build_diagnostic_report(plan), encoding="utf-8")


def check_text_artifacts(paths: Iterable[Path]) -> Dict[str, Any]:
    """Check generated text artifacts for common encoding damage."""
    checked: List[Dict[str, Any]] = []
    has_problem = False
    for path in paths:
        item = {
            "path": path.as_posix(),
            "exists": path.exists(),
            "containsReplacementChar": False,
            "containsQuestionRuns": False,
        }
        if path.exists():
            text = path.read_text(encoding="utf-8", errors="replace")
            item["containsReplacementChar"] = "\ufffd" in text
            item["containsQuestionRuns"] = "???" in text
        has_problem = has_problem or bool(item["containsReplacementChar"] or item["containsQuestionRuns"] or not item["exists"])
        checked.append(item)
    return {
        "ok": not has_problem,
        "checked": checked,
    }


def build_cli_summary(
    plan: Dict[str, Any],
    plan_path: Path,
    report_path: Path,
    diagnostic_path: Path,
    hints_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """构建命令行轻量输出，完整内容只写入文件。"""
    summary = plan.get("summary") if isinstance(plan.get("summary"), dict) else {}
    quality = summary.get("quality") if isinstance(summary.get("quality"), dict) else {}
    artifact_check = check_text_artifacts([plan_path, report_path, diagnostic_path])
    return {
        "status": "completed" if not plan.get("blockingErrors") else "blocked",
        "plan": plan_path.as_posix(),
        "report": report_path.as_posix(),
        "diagnosticReport": diagnostic_path.as_posix(),
        "summary": {
            "directChildCount": summary.get("directChildCount"),
            "groupCount": summary.get("groupCount"),
            "planner": quality.get("planner"),
            "largestGroupRatio": quality.get("largestGroupRatio"),
            "semanticHints": summary.get("semanticHints"),
        },
        "semanticHints": hints_path.as_posix() if hints_path else None,
        "warningCodes": [warning.get("code") for warning in plan.get("warnings", []) if isinstance(warning, dict)],
        "blockingErrorCodes": [error.get("code") for error in plan.get("blockingErrors", []) if isinstance(error, dict)],
        "artifactCheck": artifact_check,
    }


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="生成 Figma 层级整理计划")
    parser.add_argument("--analysis", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/analysis_result.json"), help="MCP Relay 分析结果 JSON")
    parser.add_argument("--plan", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/cleanup_plan.json"), help="输出整理计划 JSON")
    parser.add_argument("--report", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/cleanup_plan.md"), help="输出 Markdown 报告")
    parser.add_argument("--diagnostic-report", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/cleanup_plan_diagnostic.md"), help="输出轻量计划诊断报告")
    parser.add_argument("--semantic-hints", type=Path, default=None, help="Optional reporting-only semantic hints JSON")
    parser.add_argument("--detect-psd-prefix-hints", action="store_true", help="Detect PSD numeric-prefix hints from direct child names")
    parser.add_argument("--psd-prefix-hints-output", type=Path, default=Path(".tmp/figma-hierarchy-cleanup/psd_prefix_hints.json"), help="Output path for detected PSD prefix hints")
    parser.add_argument("--verbose-result", action="store_true", help="在 stdout 打印完整计划 warning；默认只打印轻量摘要")
    parser.add_argument("--allow-blocking", action="store_true", help="即使存在阻塞错误也写出计划")
    return parser.parse_args()


def main() -> int:
    """命令行入口。"""
    args = parse_args()
    analysis = load_json(args.analysis)
    semantic_hints: Optional[Dict[str, Any]] = None
    hints_path: Optional[Path] = None
    if args.semantic_hints:
        semantic_hints = load_json(args.semantic_hints)
        hints_path = args.semantic_hints
    elif args.detect_psd_prefix_hints:
        result = find_result_payload(analysis)
        children = get_direct_children(result)
        root_bounds_raw = result.get("rootBounds") if isinstance(result.get("rootBounds"), dict) else {}
        root_bounds = Bounds(
            x=0.0,
            y=0.0,
            width=float(root_bounds_raw.get("width") or 0),
            height=float(root_bounds_raw.get("height") or 0),
        )
        semantic_hints = build_psd_prefix_hints(children, root_bounds if root_bounds.width > 0 and root_bounds.height > 0 else None)
        write_json(args.psd_prefix_hints_output, semantic_hints)
        hints_path = args.psd_prefix_hints_output
    plan = build_plan(analysis, semantic_hints)
    write_json(args.plan, plan)
    write_report(args.report, plan)
    write_diagnostic_report(args.diagnostic_report, plan)
    if args.verbose_result:
        output = {
            **build_cli_summary(plan, args.plan, args.report, args.diagnostic_report, hints_path),
            "warnings": plan.get("warnings", []),
            "blockingErrors": plan.get("blockingErrors", []),
        }
    else:
        output = build_cli_summary(plan, args.plan, args.report, args.diagnostic_report, hints_path)
    print(json.dumps(output, ensure_ascii=True, indent=2))
    if plan.get("blockingErrors") and not args.allow_blocking:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
