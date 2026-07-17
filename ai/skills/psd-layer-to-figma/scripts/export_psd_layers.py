#!/usr/bin/env python3
"""导出 PSD 图层为 PNG，并生成 Figma 分层导入所需 manifest。"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from PIL import Image, ImageChops, ImageStat
except ImportError as exc:  # pragma: no cover
    raise SystemExit("缺少 Pillow，请先安装 pillow 后再运行本脚本。") from exc


COMMON_COMPONENT_MARKERS = ("common_", "common-")
COMMON_COMPONENT_PREFIX_PATTERN = re.compile(r"^\s*common(?:\s*[_-]\s*|\s+)", re.IGNORECASE)
COMPONENT_SEARCH_STRATEGY_REQUIRED = "required"
COMPONENT_SEARCH_STRATEGY_AUTO = "auto"
COMMON_COMPONENT_AUTO_REPLACE_THRESHOLD = 0.88
AUTO_COMPONENT_AUTO_REPLACE_THRESHOLD = 0.92
AUTO_COMPONENT_SUGGEST_THRESHOLD = 0.80
COMPONENT_SEARCH_MIN_SCORE_GAP = 0.08
PSD_PREFIX_PATTERN = re.compile(r"^\s*(?P<number>\d{1,4})[_\-\s]+(?P<label>.+?)\s*$")
DEFAULT_COMMON_LIBRARY = {
    "fileKey": "ly2b1kkcvLtNBFPSQi4XO4",
    "nodeId": "62:115",
    "url": (
        "https://www.figma.com/design/ly2b1kkcvLtNBFPSQi4XO4/"
        "%E6%8E%A8%E5%B8%81%E6%9C%BA_%E8%B5%84%E6%BA%90%E5%BA%93"
        "?node-id=62-115&t=I1nHCQaOSZE1Q7R4-1"
    ),
}
NINE_SLICE_MARKERS = (
    "jiugongv3_",
    "jiugong_v3_",
    "jiugong-v3_",
    "jiugongh3_",
    "jiugong_h3_",
    "jiugong-h3_",
    "jiugong_",
    "nine_slice_",
    "nine-slice_",
    "9slice_",
)
NINE_SLICE_MARKER_PATTERN = re.compile(
    r"(jiugong\s*[_-]?\s*(?:v3|h3)?(?:\s*[_-]\s*|\s+)|nine\s*[_\-\s]\s*slice(?:\s*[_-]\s*|\s+|$)|9\s*[_\-\s]*slice(?:\s*[_-]\s*|\s+|$))",
    re.IGNORECASE,
)
FORCED_SLICE_TYPE_PATTERN = re.compile(r"\bjiugong\s*[_-]?\s*(v3|h3)(?:\s*[_-]\s*|\s+|$)", re.IGNORECASE)
NINE_SLICE_NAMESPACE = "prefab_to_figma"
NINE_SLICE_INFER_RATIO = 0.25  # 仅作为视觉推算失败时的最终 fallback
NINE_SLICE_VISUAL_MIN_BORDER = 4  # 视觉推算最小 border 像素
NINE_SLICE_VISUAL_MAX_RATIO = 0.45  # 视觉推算单侧最大不超过轴向 45%
NINE_SLICE_EDGE_SAMPLE_RATIO = 0.60  # 视觉边缘检测时参与采样的中心区域比例
NINE_SLICE_EDGE_STABLE_RUN = 3  # 连续多少行/列接近中心区域后判定为可拉伸区域
NINE_SLICE_EDGE_DIFF_THRESHOLD = 12.0  # RGB 单通道平均差异低于该值时视为接近中心区域
NINE_SLICE_FULL_SECTION_ALPHA_THRESHOLD = 240  # 三切片完整截面进入稳定区所需的最低 alpha
NINE_SLICE_H3_CAP_MIN_RATIO = 0.45  # 横向三切片端帽宽松保护，按高度计算主轴下限
NINE_SLICE_V3_CAP_MIN_RATIO = 0.12  # 纵向三切片端帽宽松保护，按宽度计算主轴下限
NINE_SLICE_ROUND_RECT_EDGE_ALPHA_THRESHOLD = 1  # 圆角九宫边缘轮廓检测使用的最低 alpha
NINE_SLICE_ROUND_RECT_MIN_INSET_RATIO = 0.12  # 边缘内缩超过短边该比例时认为是大圆角九宫
NINE_SLICE_ROUND_RECT_SAFETY_MULTIPLIER = 1.25  # 圆角轮廓转九宫保护区时的安全放大系数
NINE_SLICE_ROUND_RECT_MIN_CENTER = 20.0  # 圆角保护后中心区域至少保留的像素宽高
NINE_SLICE_MERGE_REPEAT_MULTIPLIER = 1.5  # 视觉结果比重复检测大很多时的宽松合并倍率
NINE_SLICE_MERGE_MAX_RATIO = 0.20  # 自动合并后的 9-slice 单边最大比例
NINE_SLICE_MERGE_MAX_PIXELS = 96.0  # 自动合并后的 9-slice 单边最大像素值
NINE_SLICE_FAMILY_SAME_AXIS_TOLERANCE = 3.0  # 同族尺寸推断时，认为宽/高一致的像素容差
NINE_SLICE_FAMILY_CHANGED_AXIS_MIN_DELTA = 40.0  # 同族尺寸推断时，认为另一轴发生变化的最小像素差
TEXT_FONT_FALLBACK_CANDIDATES = [
    {"family": "Lilita One", "style": "Regular"},
    {"family": "Luckiest Guy", "style": "Regular"},
    {"family": "Paytone One", "style": "Regular"},
    {"family": "Titan One", "style": "Regular"},
    {"family": "Chewy", "style": "Regular"},
    {"family": "Baloo 2", "style": "ExtraBold"},
    {"family": "Fredoka", "style": "Bold"},
    {"family": "Fredoka One", "style": "Regular"},
]
DESCRIPTOR_NUMBER_PATTERN = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)"


def _u16(data: bytes, offset: int) -> int:
    """读取 PSD 大端无符号 16 位整数。"""
    return struct.unpack(">H", data[offset:offset + 2])[0]


def _i16(data: bytes, offset: int) -> int:
    """读取 PSD 大端有符号 16 位整数。"""
    return struct.unpack(">h", data[offset:offset + 2])[0]


def _u32(data: bytes, offset: int) -> int:
    """读取 PSD 大端无符号 32 位整数。"""
    return struct.unpack(">I", data[offset:offset + 4])[0]


def _i32(data: bytes, offset: int) -> int:
    """读取 PSD 大端有符号 32 位整数。"""
    return struct.unpack(">i", data[offset:offset + 4])[0]


def _read_psd_layer_id(tag_payloads: Dict[str, bytes]) -> Optional[int]:
    """Read Photoshop's stable layer identifier from the ``lyid`` block."""
    payload = tag_payloads.get("lyid")
    if payload is None or len(payload) < 4:
        return None
    value = struct.unpack(">I", payload[:4])[0]
    return value if value > 0 else None


def _find_duplicate_layer_ids(layers: List[Dict[str, object]]) -> List[int]:
    seen = set()
    duplicates = set()
    for layer in layers:
        layer_id = layer.get("layerId")
        if not isinstance(layer_id, int) or layer_id <= 0:
            continue
        if layer_id in seen:
            duplicates.add(layer_id)
        seen.add(layer_id)
    return sorted(duplicates)


def _safe_name(name: str, fallback: str) -> str:
    """把 PSD 图层名转换为适合文件名使用的安全名称。"""
    cleaned = re.sub(r"[^\w.\- \u4e00-\u9fff]+", "_", name, flags=re.UNICODE).strip()
    return (cleaned[:80] or fallback).rstrip(".")


def _detect_nine_slice_marker(name: str) -> Optional[str]:
    """检测 PSD 图层名是否包含九宫标记。"""
    lower_name = name.lower()
    for marker in NINE_SLICE_MARKERS:
        if marker in lower_name:
            return marker
    match = NINE_SLICE_MARKER_PATTERN.search(name)
    if match:
        return match.group(0)
    return None


def _detect_forced_slice_type(name: str) -> Optional[str]:
    """根据 jiugongv3/jiugongh3 命名前缀识别强制三切片类型。"""
    match = FORCED_SLICE_TYPE_PATTERN.search(name)
    if not match:
        return None
    marker = match.group(1).lower()
    if marker == "v3":
        return "v3-slice"
    if marker == "h3":
        return "h3-slice"
    return None


def _nine_slice_family_key(name: str) -> Optional[str]:
    """提取九宫图层同族键，用于同宽不同高/同高不同宽的自动三切片推断。"""
    if _detect_forced_slice_type(name):
        return None
    marker = _detect_nine_slice_marker(name)
    if marker is None:
        return None
    match = NINE_SLICE_MARKER_PATTERN.search(name)
    if match:
        suffix = name[match.end():]
    else:
        suffix = name.lower().replace(marker, "", 1)
    normalized = _normalize_semantic_suffix(suffix).lower()
    normalized = re.sub(r"[\s_-]*\d+$", "", normalized)
    normalized = normalized.strip("_- ")
    return normalized or None


def _detect_common_component_marker(name: str) -> Optional[str]:
    """检测 PSD 图层名是否以通用组件标记开头。"""
    lower_name = name.lower()
    for marker in COMMON_COMPONENT_MARKERS:
        if lower_name.startswith(marker):
            return marker
    match = COMMON_COMPONENT_PREFIX_PATTERN.match(name)
    if match:
        return match.group(0)
    return None


def _normalize_semantic_suffix(suffix: str) -> str:
    """规范化语义前缀后的名称片段，保留主体命名但统一分隔符。"""
    cleaned = suffix.strip(" _-\t\r\n")
    cleaned = re.sub(r"\s*([_-])\s*", r"\1", cleaned)
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned.strip("_-")


def _canonical_nine_slice_marker(marker: Optional[str]) -> str:
    """把九宫标记统一为 manifest 中稳定可比较的前缀。"""
    marker_text = (marker or "").strip().lower()
    forced_slice_type = _detect_forced_slice_type(marker_text)
    if forced_slice_type == "v3-slice":
        return "jiugongv3_"
    if forced_slice_type == "h3-slice":
        return "jiugongh3_"
    if marker_text.startswith("jiugong"):
        return "jiugong_"
    if marker_text.startswith("9"):
        return "9slice_"
    return "nine_slice_"


def _normalize_layer_semantics(raw_name: str, semantic_mode: str) -> Dict[str, Any]:
    """根据已识别的语义模式写入稳定的图层命名预处理信息。"""
    normalized_name = raw_name.strip()
    warnings: List[str] = []

    common_marker = _detect_common_component_marker(raw_name)
    nine_slice_marker = _detect_nine_slice_marker(raw_name)

    if semantic_mode == "common-component" and common_marker:
        query = _normalize_semantic_suffix(raw_name[len(common_marker):])
        normalized_name = f"common_{query}" if query else "common_"
        if common_marker.lower() not in COMMON_COMPONENT_MARKERS or normalized_name != raw_name:
            warnings.append(
                f"common layer name normalized to '{normalized_name}' from '{raw_name}'"
            )
    elif semantic_mode == "nine-slice" and nine_slice_marker:
        prefix = _canonical_nine_slice_marker(nine_slice_marker)
        marker_match = NINE_SLICE_MARKER_PATTERN.search(raw_name)
        if marker_match:
            before = _normalize_semantic_suffix(raw_name[:marker_match.start()])
            after = _normalize_semantic_suffix(raw_name[marker_match.end():])
            parts = [part for part in (before, f"{prefix.rstrip('_')}", after) if part]
            normalized_name = "_".join(parts)
        else:
            normalized_name = raw_name.strip()
        if nine_slice_marker.lower() not in NINE_SLICE_MARKERS or normalized_name != raw_name:
            warnings.append(
                f"nine-slice layer name normalized to '{normalized_name}' from '{raw_name}'"
            )

    return {
        "rawPsdLayerName": raw_name,
        "normalizedLayerName": normalized_name,
        "semanticMode": semantic_mode,
        "normalizationWarnings": warnings,
    }


def _psd_prefix_record(layer: Dict[str, object]) -> Optional[Dict[str, object]]:
    """Extract a reporting-only numeric prefix record from a PSD layer name."""
    raw_name = str(layer.get("rawPsdLayerName") or layer.get("name") or "")
    match = PSD_PREFIX_PATTERN.match(raw_name)
    if not match:
        return None
    number_text = match.group("number")
    label = match.group("label").strip()
    return {
        "number": int(number_text),
        "prefix": number_text,
        "label": label,
        "name": raw_name,
        "sourceIndex": int(layer.get("index") or layer.get("idx") or 0),
        "semanticMode": layer.get("semanticMode") or layer.get("mode") or "image",
        "x": layer.get("x", 0),
        "y": layer.get("y", 0),
        "width": layer.get("width", layer.get("w", 0)),
        "height": layer.get("height", layer.get("h", 0)),
    }


def _prefix_label_family(label: str) -> str:
    """Classify label text for hint segmentation only; it never drives auto-apply."""
    normalized = re.sub(r"[^a-z0-9]+", " ", label.lower()).strip()
    tokens = set(normalized.split())
    if tokens & {"tab", "tabs", "btn", "button", "toggle", "select", "selected"}:
        return "tab-like"
    if tokens & {"bg", "background", "mask", "panel", "base", "di"}:
        return "bg-like"
    if tokens & {"list", "item", "row", "task", "reward", "slot", "mail", "rank"}:
        return "list-like"
    return "unknown"


def _union_prefixed_bounds(records: List[Dict[str, object]]) -> Optional[Dict[str, float]]:
    xs: List[float] = []
    ys: List[float] = []
    rights: List[float] = []
    bottoms: List[float] = []
    for record in records:
        try:
            x = float(record.get("x") or 0)
            y = float(record.get("y") or 0)
            width = float(record.get("width") or 0)
            height = float(record.get("height") or 0)
        except (TypeError, ValueError):
            continue
        xs.append(x)
        ys.append(y)
        rights.append(x + width)
        bottoms.append(y + height)
    if not xs:
        return None
    left = min(xs)
    top = min(ys)
    return {
        "x": left,
        "y": top,
        "width": max(rights) - left,
        "height": max(bottoms) - top,
    }


def _infer_prefix_candidate_name(records: List[Dict[str, object]], canvas: Dict[str, object]) -> str:
    families = [_prefix_label_family(str(record.get("label") or "")) for record in records]
    if families and all(family == "bg-like" for family in families):
        return "[Bg]"
    if families.count("tab-like") >= max(1, len(records) // 2):
        return "[TabBar]"
    if families.count("list-like") >= max(1, len(records) // 2):
        return "[ListRoot]"

    bounds = _union_prefixed_bounds(records)
    if bounds:
        try:
            canvas_width = float(canvas.get("width") or 0)
            canvas_height = float(canvas.get("height") or 0)
        except (TypeError, ValueError):
            canvas_width = 0.0
            canvas_height = 0.0
        if canvas_width > 0 and canvas_height > 0:
            width_ratio = float(bounds["width"]) / canvas_width
            height_ratio = float(bounds["height"]) / canvas_height
            if width_ratio >= 0.85 and height_ratio >= 0.35:
                return "[Bg]"
            if height_ratio >= 0.35 and len(records) >= 4:
                return "[ListRoot]"
            if width_ratio >= 0.45 and height_ratio <= 0.25 and len(records) >= 3:
                return "[TabBar]"
    return "[Content]"


def _build_psd_prefix_hints(layers: List[Dict[str, object]], canvas: Dict[str, object]) -> Dict[str, object]:
    """Build reporting-only hints for PSD numeric prefix runs."""
    records = [record for layer in layers if (record := _psd_prefix_record(layer))]
    records.sort(key=lambda item: (int(item["number"]), int(item["sourceIndex"])))
    warnings: List[Dict[str, object]] = []
    if not records:
        return {
            "schemaVersion": 1,
            "kind": "psd-prefix-hints",
            "hintOnly": True,
            "source": "psd-layer-to-figma manifest",
            "segments": [],
            "coverage": {
                "prefixedLayerCount": 0,
                "layerCount": len(layers),
                "coverageRatio": 0.0,
            },
            "warnings": warnings,
        }

    duplicate_numbers = sorted({
        int(record["number"])
        for record in records
        if sum(1 for other in records if int(other["number"]) == int(record["number"])) > 1
    })
    if duplicate_numbers:
        warnings.append({"code": "duplicatePsdPrefixes", "numbers": duplicate_numbers})

    segments: List[List[Dict[str, object]]] = []
    current: List[Dict[str, object]] = []
    current_family = ""
    for record in records:
        family = _prefix_label_family(str(record.get("label") or ""))
        number = int(record["number"])
        previous_number = int(current[-1]["number"]) if current else None
        family_break = bool(
            current
            and family != "unknown"
            and current_family != "unknown"
            and family != current_family
        )
        continuity_break = previous_number is not None and number != previous_number + 1
        if current and (continuity_break or family_break):
            segments.append(current)
            current = []
            current_family = ""
        current.append(record)
        if family != "unknown" or not current_family:
            current_family = family
    if current:
        segments.append(current)

    segment_payloads: List[Dict[str, object]] = []
    for segment in segments:
        numbers = [int(record["number"]) for record in segment]
        segment_payloads.append({
            "hintOnly": True,
            "candidateName": _infer_prefix_candidate_name(segment, canvas),
            "startPrefix": numbers[0],
            "endPrefix": numbers[-1],
            "count": len(segment),
            "sourceIndices": [int(record["sourceIndex"]) for record in segment],
            "sampleNames": [str(record["name"]) for record in segment[:8]],
            "bounds": _union_prefixed_bounds(segment),
            "usedSignals": ["numericPrefixContinuity", "labelFamilyForSegmentation", "bounds", "sourceIndex"],
            "ignoredForScoring": ["name", "path", "characters"],
        })

    prefixed_count = len(records)
    if len(segment_payloads) == 1 and prefixed_count >= 8:
        warnings.append({"code": "singleLargePrefixRun", "count": prefixed_count})

    return {
        "schemaVersion": 1,
        "kind": "psd-prefix-hints",
        "hintOnly": True,
        "source": "psd-layer-to-figma manifest",
        "segments": segment_payloads,
        "coverage": {
            "prefixedLayerCount": prefixed_count,
            "layerCount": len(layers),
            "coverageRatio": round(prefixed_count / len(layers), 4) if layers else 0.0,
        },
        "warnings": warnings,
    }


def _infer_constraints(
    layer_x: float,
    layer_y: float,
    layer_width: float,
    layer_height: float,
    canvas_width: float,
    canvas_height: float,
) -> Dict[str, str]:
    """按现有 Figma 导入模板规则预计算图层 constraints，减少 use_figma 临时代码。"""
    center_x = layer_x + layer_width / 2.0
    center_y = layer_y + layer_height / 2.0
    left_margin = layer_x
    right_margin = canvas_width - (layer_x + layer_width)
    top_margin = layer_y
    bottom_margin = canvas_height - (layer_y + layer_height)

    horizontal = "MIN"
    if layer_width > canvas_width * 0.8:
        horizontal = "STRETCH"
    elif canvas_width * 0.25 <= center_x <= canvas_width * 0.75:
        horizontal = "CENTER"
    elif right_margin < canvas_width * 0.2 and left_margin > canvas_width * 0.2:
        horizontal = "MAX"

    vertical = "MIN"
    if layer_height > canvas_height * 0.8:
        vertical = "STRETCH"
    elif bottom_margin < canvas_height * 0.2 and top_margin > canvas_height * 0.2:
        vertical = "MAX"
    elif canvas_height * 0.25 <= center_y <= canvas_height * 0.75:
        vertical = "CENTER"

    return {"horizontal": horizontal, "vertical": vertical}


def _build_common_component_candidates(query: str) -> List[str]:
    """根据通用组件查询名生成匹配候选名。"""
    cleaned = query.strip()
    if not cleaned:
        return []

    candidates: List[str] = []
    if not cleaned.lower().endswith("__importbounds"):
        candidates.append(f"{cleaned}__ImportBounds")
    candidates.append(cleaned)

    return _dedupe_strings(candidates)


def _dedupe_strings(values: List[str]) -> List[str]:
    """按原顺序去重字符串列表，避免候选名重复导致无效匹配。"""
    deduped: List[str] = []
    seen = set()
    for value in values:
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def _strip_import_bounds_suffix(name: str) -> str:
    """移除导入定位组件后缀，方便为 auto 模式扩展基础候选名。"""
    return re.sub(r"__importbounds$", "", name.strip(), flags=re.IGNORECASE)


def _strip_common_layer_noise(name: str) -> str:
    """清理常见 PSD 图层噪声，但保留可用于组件匹配的主体名称。"""
    cleaned = name.strip()
    cleaned = re.sub(r"^\d+[\s_.-]+", "", cleaned)
    cleaned = re.sub(r"[\s_-]*(?:copy|副本|拷贝)\s*\d*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[\s_-]+\d+$", "", cleaned)
    return cleaned.strip()


def _build_auto_component_candidates(layer_name: str) -> List[str]:
    """为普通图片层生成 auto 模糊匹配候选名。"""
    raw = layer_name.strip()
    if not raw:
        return []

    bases = [raw, _strip_common_layer_noise(raw), _strip_import_bounds_suffix(_strip_common_layer_noise(raw))]
    if "/" in raw:
        bases.append(raw.rsplit("/", 1)[-1])

    candidates: List[str] = []
    for base in _dedupe_strings(bases):
        candidates.extend(_build_common_component_candidates(base))
    return _dedupe_strings(candidates)


def _build_component_search_info(
    layer_name: str,
    strategy: str,
    marker: Optional[str] = None,
) -> Dict[str, Any]:
    """生成通用组件搜索信息，供 Figma 导入阶段做强制或 auto 匹配。"""
    query = layer_name[len(marker):].strip() if marker else layer_name.strip()
    if strategy == COMPONENT_SEARCH_STRATEGY_REQUIRED:
        candidates = _build_common_component_candidates(query)
        auto_replace_threshold = COMMON_COMPONENT_AUTO_REPLACE_THRESHOLD
    else:
        candidates = _build_auto_component_candidates(query)
        auto_replace_threshold = AUTO_COMPONENT_AUTO_REPLACE_THRESHOLD

    warnings: List[str] = []
    if strategy == COMPONENT_SEARCH_STRATEGY_REQUIRED and not candidates:
        warnings.append("common-component marker found but component name is missing after marker")

    return {
        "strategy": strategy,
        "marker": marker,
        "query": query,
        "candidateNames": candidates,
        "library": DEFAULT_COMMON_LIBRARY,
        "threshold": {
            "autoReplace": auto_replace_threshold,
            "suggest": AUTO_COMPONENT_SUGGEST_THRESHOLD,
            "minGap": COMPONENT_SEARCH_MIN_SCORE_GAP,
        },
        "warnings": warnings,
    }


def _build_common_component_info(layer_name: str) -> Optional[Dict[str, Any]]:
    """根据图层名创建通用组件匹配信息；未命中 common 标记时返回空。"""
    marker = _detect_common_component_marker(layer_name)
    if marker is None:
        return None

    return _build_component_search_info(layer_name, COMPONENT_SEARCH_STRATEGY_REQUIRED, marker)


def _parse_descriptor_float(token: str) -> float:
    """解析 Photoshop EngineData 数字，支持 .01 这类省略整数位的写法。"""
    normalized = token.strip()
    if normalized.startswith("."):
        normalized = "0" + normalized
    if normalized.startswith("-."):
        normalized = normalized.replace("-.", "-0.", 1)
    if normalized.startswith("+."):
        normalized = normalized.replace("+.", "+0.", 1)
    return float(normalized)


def _decode_ps_string(raw: bytes) -> str:
    """解码 Photoshop EngineData 中的括号字符串，优先按 UTF-16 处理。"""
    unescaped = bytearray()
    escaped = False
    escape_map = {
        ord("n"): b"\n",
        ord("r"): b"\r",
        ord("t"): b"\t",
        ord("b"): b"\b",
        ord("f"): b"\f",
        ord("("): b"(",
        ord(")"): b")",
        ord("\\"): b"\\",
    }
    for value in raw:
        if escaped:
            unescaped.extend(escape_map.get(value, bytes([value])))
            escaped = False
            continue
        if value == ord("\\"):
            escaped = True
            continue
        unescaped.append(value)

    data = bytes(unescaped)
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", errors="replace")
    if data.startswith(b"\xff\xfe"):
        return data[2:].decode("utf-16-le", errors="replace")
    if data.count(0) > len(data) // 4:
        return data.decode("utf-16-be", errors="replace")
    return data.decode("utf-8", errors="replace")


def _extract_parenthesized_after(data: bytes, marker: bytes, start: int = 0) -> Optional[Tuple[bytes, int]]:
    """提取 marker 之后第一个 Photoshop 括号字符串的原始内容。"""
    marker_index = data.find(marker, start)
    if marker_index < 0:
        return None
    open_index = data.find(b"(", marker_index + len(marker))
    if open_index < 0:
        return None

    depth = 1
    escaped = False
    index = open_index + 1
    while index < len(data):
        value = data[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if value == ord("\\"):
            escaped = True
            index += 1
            continue
        if value == ord("(") and (index == 0 or data[index - 1] != 0):
            depth += 1
        elif value == ord(")") and (index == 0 or data[index - 1] != 0):
            depth -= 1
            if depth == 0:
                return data[open_index + 1:index], index + 1
        index += 1
    return None


def _extract_engine_number(engine_text: str, name: str) -> Optional[float]:
    """从 EngineData 文本中读取单个数值属性。"""
    match = re.search(rf"/{re.escape(name)}\s+({DESCRIPTOR_NUMBER_PATTERN})", engine_text)
    if not match:
        return None
    return _parse_descriptor_float(match.group(1))


def _extract_text_transform_from_tysh(payload: bytes) -> Optional[Dict[str, Any]]:
    """读取 TySh 开头的文本变换矩阵，用于还原 Photoshop 中被缩放后的视觉字号。"""
    if len(payload) < 50:
        return None
    version = _u16(payload, 0)
    if version not in (1, 50):
        return None
    try:
        xx, xy, yx, yy, tx, ty = struct.unpack(">6d", payload[2:50])
    except struct.error:
        return None
    values = (xx, xy, yx, yy, tx, ty)
    if not all(math.isfinite(value) for value in values):
        return None
    scale_x = math.hypot(xx, yx)
    scale_y = math.hypot(xy, yy)
    if scale_x <= 0.0 or scale_y <= 0.0:
        return None
    return {
        "version": version,
        "matrix": [xx, xy, yx, yy, tx, ty],
        "scaleX": scale_x,
        "scaleY": scale_y,
    }


def _build_effective_text_size(font_size: Optional[float], transform: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """根据 PSD 文本矩阵计算 Figma 应使用的有效字号，避免忽略 Photoshop 文本缩放。"""
    if font_size is None or font_size <= 0.0 or not transform:
        return None
    scale_y = float(transform.get("scaleY") or 0.0)
    if scale_y <= 0.0 or not math.isfinite(scale_y):
        return None
    effective_font_size = font_size * scale_y
    if effective_font_size <= 0.0 or not math.isfinite(effective_font_size):
        return None
    return {
        "fontSize": effective_font_size,
        "scaleX": transform.get("scaleX"),
        "scaleY": scale_y,
        "source": "TySh transform matrix",
    }


def _extract_engine_int(engine_text: str, name: str) -> Optional[int]:
    """从 EngineData 文本中读取单个整数属性。"""
    value = _extract_engine_number(engine_text, name)
    return int(value) if value is not None else None


def _extract_engine_color(engine_text: str, name: str) -> Optional[Dict[str, Any]]:
    """读取 EngineData 颜色，Values 顺序为 A、R、G、B。"""
    match = re.search(
        rf"/{re.escape(name)}\s*<<.*?/Values\s*\[\s*([^\]]+)\]",
        engine_text,
        re.DOTALL,
    )
    if not match:
        return None
    values = [
        _parse_descriptor_float(token)
        for token in re.findall(DESCRIPTOR_NUMBER_PATTERN, match.group(1))
    ]
    if len(values) < 4:
        return None
    alpha, red, green, blue = values[:4]
    return {
        "a": alpha,
        "r": red,
        "g": green,
        "b": blue,
        "hex": _rgb_to_hex(red, green, blue),
    }


def _rgb_to_hex(red: float, green: float, blue: float) -> str:
    """把 0 到 1 的 RGB 颜色转换为十六进制字符串。"""
    return "#{:02X}{:02X}{:02X}".format(
        max(0, min(255, round(red * 255))),
        max(0, min(255, round(green * 255))),
        max(0, min(255, round(blue * 255))),
    )


def _extract_font_names_from_tysh(payload: bytes) -> List[str]:
    """从 TySh EngineData 的 FontSet 中读取字体名称列表。"""
    font_set_start = payload.find(b"/FontSet")
    if font_set_start < 0:
        return []
    font_set_end = payload.find(b"/SuperscriptSize", font_set_start)
    if font_set_end < 0:
        font_set_end = len(payload)

    names: List[str] = []
    cursor = font_set_start
    while cursor < font_set_end:
        extracted = _extract_parenthesized_after(payload, b"/Name", cursor)
        if not extracted:
            break
        raw_name, end = extracted
        if end > font_set_end:
            break
        names.append(_decode_ps_string(raw_name))
        cursor = end
    return names


def _extract_text_characters_from_tysh(payload: bytes) -> Optional[str]:
    """从 TySh EngineData 中读取文本内容，并把 Photoshop 回车换成 Figma 换行。"""
    extracted = _extract_parenthesized_after(payload, b"/Text")
    if not extracted:
        return None
    raw_text, _ = extracted
    text = _decode_ps_string(raw_text)
    return text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")


def _descriptor_double_after(data: bytes, marker: bytes) -> Optional[float]:
    """从 Photoshop 描述符片段中读取 marker 后紧跟的 64 位浮点数。"""
    index = data.find(marker)
    if index < 0:
        return None
    offset = index + len(marker)
    if offset + 8 > len(data):
        return None
    return struct.unpack(">d", data[offset:offset + 8])[0]


def _descriptor_bool(data: bytes, key: bytes) -> Optional[bool]:
    """读取 Photoshop 描述符 bool 项，例如 enabbool。"""
    marker = key + b"bool"
    index = data.find(marker)
    if index < 0:
        return None
    value_offset = index + len(marker)
    if value_offset >= len(data):
        return None
    return data[value_offset] != 0


def _extract_effect_section(payload: bytes, marker: bytes) -> Optional[bytes]:
    """按效果标识截取 lfx2 中的单个效果描述符片段。"""
    start = payload.find(marker)
    if start < 0:
        return None
    effect_markers = (
        b"DrSh",
        b"FrFX",
        b"IrGl",
        b"OrGl",
        b"TrnS",
        b"ChFX",
        b"ebbl",
        b"SoFi",
        b"GrFl",
        b"patternFill",
    )
    search_start = start + 32
    ends = [
        payload.find(candidate, search_start)
        for candidate in effect_markers
        if payload.find(candidate, search_start) >= 0
    ]
    end = min(ends) if ends else len(payload)
    return payload[start:end]


def _extract_descriptor_color(section: bytes) -> Optional[Dict[str, Any]]:
    """从 lfx2 描述符片段中读取 RGBC 颜色并换算到 Figma 0 到 1。"""
    color_start = section.find(b"Clr Objc")
    if color_start < 0:
        return None
    color_section = section[color_start:]
    red = _descriptor_double_after(color_section, b"Rd  doub")
    green = _descriptor_double_after(color_section, b"Grn doub")
    blue = _descriptor_double_after(color_section, b"Bl  doub")
    if red is None or green is None or blue is None:
        return None
    return {
        "r": red / 255.0,
        "g": green / 255.0,
        "b": blue / 255.0,
        "rgb255": [round(red, 3), round(green, 3), round(blue, 3)],
        "hex": _rgb_to_hex(red / 255.0, green / 255.0, blue / 255.0),
    }


def _parse_stroke_effect(payload: Optional[bytes]) -> Optional[Dict[str, Any]]:
    """从 lfx2 的 FrFX 中解析文字描边效果。"""
    if not payload:
        return None
    section = _extract_effect_section(payload, b"FrFX")
    if not section:
        return None
    opacity = _descriptor_double_after(section, b"OpctUntF#Prc")
    size = _descriptor_double_after(section, b"Sz  UntF#Pxl")
    enabled = _descriptor_bool(section, b"enab")
    present = _descriptor_bool(section, b"present")
    if enabled is not True or present is False:
        return None
    return {
        "enabled": True,
        "present": present,
        "position": "OUTSIDE" if b"OutF" in section else "CENTER",
        "opacity": (opacity / 100.0) if opacity is not None else None,
        "size": size,
        "color": _extract_descriptor_color(section),
    }


def _parse_drop_shadow_effect(payload: Optional[bytes]) -> Optional[Dict[str, Any]]:
    """从 lfx2 的 DrSh 中解析文字投影效果。"""
    if not payload:
        return None
    section = _extract_effect_section(payload, b"DrSh")
    if not section:
        return None
    opacity = _descriptor_double_after(section, b"OpctUntF#Prc")
    enabled = _descriptor_bool(section, b"enab")
    present = _descriptor_bool(section, b"present")
    if enabled is not True or present is False:
        return None
    return {
        "enabled": True,
        "present": present,
        "opacity": (opacity / 100.0) if opacity is not None else None,
        "angle": _descriptor_double_after(section, b"laglUntF#Ang"),
        "distance": _descriptor_double_after(section, b"DstnUntF#Pxl"),
        "spread": _descriptor_double_after(section, b"CkmtUntF#Pxl"),
        "blur": _descriptor_double_after(section, b"blurUntF#Pxl"),
        "color": _extract_descriptor_color(section),
    }


def _build_text_info(tag_payloads: Dict[str, bytes]) -> Optional[Dict[str, Any]]:
    """根据 TySh/lfx2 附加信息创建可编辑文字导入元数据。"""
    tysh_payload = tag_payloads.get("TySh")
    if not tysh_payload:
        return None

    characters = _extract_text_characters_from_tysh(tysh_payload)
    engine_text = tysh_payload.decode("latin1", errors="replace")
    font_names = _extract_font_names_from_tysh(tysh_payload)
    font_index = _extract_engine_int(engine_text, "Font") or 0
    font_family = font_names[font_index] if 0 <= font_index < len(font_names) else (font_names[0] if font_names else None)
    font_size = _extract_engine_number(engine_text, "FontSize")
    transform = _extract_text_transform_from_tysh(tysh_payload)
    effective_size = _build_effective_text_size(font_size, transform)
    leading = _extract_engine_number(engine_text, "Leading")
    justification = _extract_engine_int(engine_text, "Justification")
    alignment = {0: "LEFT", 1: "RIGHT", 2: "CENTER"}.get(justification, "LEFT")
    warnings: List[str] = []
    if not characters:
        warnings.append("text layer has TySh but text content was not parsed")
    if font_size is None:
        warnings.append("text layer font size was not parsed")

    effects_payload = tag_payloads.get("lfx2") or tag_payloads.get("lfx ")
    has_multiline = "\n" in characters if characters else False
    line_height_mode = "PIXELS" if has_multiline and leading is not None and leading > 0.01 else "AUTO"
    return {
        "characters": characters or "",
        "fontFamily": font_family,
        "fontSet": font_names,
        "fontIndex": font_index,
        "fontSize": font_size,
        "effectiveFontSize": (effective_size or {}).get("fontSize"),
        "textTransform": transform,
        "effectiveSizeSource": (effective_size or {}).get("source"),
        "leading": leading,
        "lineHeightMode": line_height_mode,
        "fillColor": _extract_engine_color(engine_text, "FillColor"),
        "textAlignHorizontal": alignment,
        "source": "TySh/EngineData",
        "effects": {
            "stroke": _parse_stroke_effect(effects_payload),
            "dropShadow": _parse_drop_shadow_effect(effects_payload),
        },
        "figma": {
            "fontFallbackCandidates": ([{"family": font_family, "style": "Regular"}] if font_family else []) + TEXT_FONT_FALLBACK_CANDIDATES,
            "notes": [
                "PSD 字号默认按 1:1 写入 Figma；缺失原字体时先测量候选字体宽度，再按 bounds 做最小比例微调。",
                "PSD FillColor Values 顺序为 A,R,G,B；Figma 颜色使用 R,G,B 的 0 到 1 通道。",
                "lfx2 FrFX/Sz 映射为 Figma strokeWeight；DrSh 仅在 enabled=true 时映射为 DROP_SHADOW。",
            ],
        },
        "warnings": warnings,
    }


def _parse_nine_slice_border(name: str) -> Dict[str, float]:
    """从图层名中解析九宫边框，支持 l/r/t/b 和 left/right/top/bottom 写法。"""
    border = {"left": 0.0, "bottom": 0.0, "right": 0.0, "top": 0.0}
    aliases = {
        "l": "left",
        "left": "left",
        "b": "bottom",
        "bottom": "bottom",
        "r": "right",
        "right": "right",
        "t": "top",
        "top": "top",
    }
    pattern = re.compile(
        r"(?<![a-zA-Z0-9])(?P<key>left|right|top|bottom|l|r|t|b)\s*[-_=:]?\s*(?P<value>\d+(?:\.\d+)?)",
        re.IGNORECASE,
    )
    for match in pattern.finditer(name):
        key = aliases[match.group("key").lower()]
        border[key] = float(match.group("value"))
    return border


def _missing_nine_slice_border_fields(border: Dict[str, float]) -> List[str]:
    """列出缺少或为非正数的九宫边框字段。"""
    return [name for name in ("left", "bottom", "right", "top") if float(border.get(name, 0.0)) <= 0.0]


def _find_repeat_border(pixels: list, size: int, from_start: bool) -> int:
    """扫描像素行/列序列，找到连续重复开始的位置作为 border。

    pixels: 每行/列的像素数据（bytes）
    size: 总行/列数
    from_start: True 从头扫描（left/top），False 从尾扫描（right/bottom）
    """
    if size < 3:
        return 1
    max_border = int(size * NINE_SLICE_VISUAL_MAX_RATIO)
    indices = range(0, max_border) if from_start else range(size - 1, size - 1 - max_border, -1)
    prev = None
    repeat_count = 0
    border_pos = 0
    for i in indices:
        if i < 0 or i >= size:
            break
        current = pixels[i]
        if prev is not None and current == prev:
            repeat_count += 1
            if repeat_count >= 2:
                border_pos = abs(i - (0 if from_start else size - 1)) - repeat_count
                break
        else:
            repeat_count = 0
        prev = current
    return max(border_pos, NINE_SLICE_VISUAL_MIN_BORDER)


def _average_rgba(values: List[Tuple[int, int, int, int]]) -> Tuple[float, float, float, float]:
    """计算一组 RGBA 像素的平均值，用于识别视觉边缘和中心可拉伸区域。"""
    if not values:
        return (0.0, 0.0, 0.0, 0.0)
    count = float(len(values))
    return (
        sum(v[0] for v in values) / count,
        sum(v[1] for v in values) / count,
        sum(v[2] for v in values) / count,
        sum(v[3] for v in values) / count,
    )


def _rgba_diff(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    """返回两个平均颜色的差异；RGB 为主，alpha 只在透明边缘时参与。"""
    rgb_diff = sum(abs(a[i] - b[i]) for i in range(3)) / 3.0
    alpha_diff = abs(a[3] - b[3])
    return max(rgb_diff, alpha_diff)


def _sample_row_average(img: "Image.Image", y: int, x0: int, x1: int) -> Tuple[float, float, float, float]:
    """采样一行中心区域的平均颜色，避免边角透明或描边干扰判断。"""
    pixels = [img.getpixel((x, y)) for x in range(x0, max(x0 + 1, x1))]
    return _average_rgba(pixels)


def _sample_col_average(img: "Image.Image", x: int, y0: int, y1: int) -> Tuple[float, float, float, float]:
    """采样一列中心区域的平均颜色，避免边角透明或描边干扰判断。"""
    pixels = [img.getpixel((x, y)) for y in range(y0, max(y0 + 1, y1))]
    return _average_rgba(pixels)


def _find_visual_edge_border(
    samples: List[Tuple[float, float, float, float]],
    baseline: Tuple[float, float, float, float],
    from_start: bool,
) -> int:
    """从边缘向中心扫描，找到连续接近中心色的位置作为可拉伸区域起点。"""
    if len(samples) < 3:
        return NINE_SLICE_VISUAL_MIN_BORDER
    max_border = max(1, int(len(samples) * NINE_SLICE_VISUAL_MAX_RATIO))
    stable_run = 0
    indices = range(0, max_border) if from_start else range(len(samples) - 1, len(samples) - 1 - max_border, -1)
    for i in indices:
        diff = _rgba_diff(samples[i], baseline)
        if diff <= NINE_SLICE_EDGE_DIFF_THRESHOLD:
            stable_run += 1
            if stable_run >= NINE_SLICE_EDGE_STABLE_RUN:
                if from_start:
                    return max(i - stable_run + 1, NINE_SLICE_VISUAL_MIN_BORDER)
                return max(len(samples) - i - stable_run, NINE_SLICE_VISUAL_MIN_BORDER)
        else:
            stable_run = 0
    return NINE_SLICE_VISUAL_MIN_BORDER


def _infer_visual_edge_borders(image: "Image.Image", width: int, height: int) -> Optional[Dict[str, float]]:
    """根据边缘与中心可拉伸区域的颜色差异推断四边保护区。"""
    if width < 8 or height < 8:
        return None
    img = image.convert("RGBA") if image.mode != "RGBA" else image

    x_margin = int(width * (1.0 - NINE_SLICE_EDGE_SAMPLE_RATIO) * 0.5)
    y_margin = int(height * (1.0 - NINE_SLICE_EDGE_SAMPLE_RATIO) * 0.5)
    x0, x1 = max(0, x_margin), min(width, width - x_margin)
    y0, y1 = max(0, y_margin), min(height, height - y_margin)
    if x1 <= x0 or y1 <= y0:
        return None

    row_samples = [_sample_row_average(img, y, x0, x1) for y in range(height)]
    col_samples = [_sample_col_average(img, x, y0, y1) for x in range(width)]
    center_rows = row_samples[y0:y1]
    center_cols = col_samples[x0:x1]
    row_baseline = _average_rgba(center_rows)
    col_baseline = _average_rgba(center_cols)

    top = _find_visual_edge_border(row_samples, row_baseline, from_start=True)
    bottom = _find_visual_edge_border(row_samples, row_baseline, from_start=False)
    left = _find_visual_edge_border(col_samples, col_baseline, from_start=True)
    right = _find_visual_edge_border(col_samples, col_baseline, from_start=False)

    if left + right >= width or top + bottom >= height:
        return None
    return {"left": float(left), "bottom": float(bottom), "right": float(right), "top": float(top)}


def _merge_border_value(visual: float, repeat: float, axis_size: float) -> float:
    """宽松合并视觉边缘和重复检测结果，避免 9-slice 自动边界过大。"""
    visual = max(float(visual), 0.0)
    repeat = max(float(repeat), 0.0)
    if repeat <= 0.0:
        base = visual
    elif repeat <= NINE_SLICE_VISUAL_MIN_BORDER and visual > repeat * NINE_SLICE_MERGE_REPEAT_MULTIPLIER:
        base = visual
    elif visual <= repeat * NINE_SLICE_MERGE_REPEAT_MULTIPLIER:
        base = visual
    else:
        base = max(repeat, min(visual, repeat * NINE_SLICE_MERGE_REPEAT_MULTIPLIER))
    max_auto = min(float(axis_size) * NINE_SLICE_MERGE_MAX_RATIO, NINE_SLICE_MERGE_MAX_PIXELS)
    return max(NINE_SLICE_VISUAL_MIN_BORDER, min(base, max_auto))


def _merge_visual_and_repeat_borders(
    visual: Dict[str, float],
    repeat: Optional[Dict[str, float]],
    width: int,
    height: int,
    image: Optional["Image.Image"] = None,
) -> Dict[str, float]:
    """为 9-slice 使用宽松合并结果；视觉检测负责补边，重复检测负责限制过大边界。"""
    if repeat is None:
        repeat = visual
    if image is not None and _corners_empty_with_border(image, visual) and not _corners_empty_with_border(image, repeat):
        return dict(repeat)
    merged = {
        "left": _merge_border_value(visual.get("left", 0.0), repeat.get("left", 0.0), width),
        "right": _merge_border_value(visual.get("right", 0.0), repeat.get("right", 0.0), width),
        "top": _merge_border_value(visual.get("top", 0.0), repeat.get("top", 0.0), height),
        "bottom": _merge_border_value(visual.get("bottom", 0.0), repeat.get("bottom", 0.0), height),
    }
    return merged


def _infer_round_rect_nine_slice_borders(
    image: "Image.Image",
    width: int,
    height: int,
) -> Optional[Dict[str, float]]:
    """从源图外轮廓推断大圆角九宫保护区，避免角区被视觉/重复检测切得过窄。"""
    if width < 8 or height < 8:
        return None
    img = image.convert("RGBA") if image.mode != "RGBA" else image
    threshold = NINE_SLICE_ROUND_RECT_EDGE_ALPHA_THRESHOLD
    edge_insets = [
        _row_alpha_inset(img, 0, width, threshold, from_start=True),
        _row_alpha_inset(img, 0, width, threshold, from_start=False),
        _row_alpha_inset(img, height - 1, width, threshold, from_start=True),
        _row_alpha_inset(img, height - 1, width, threshold, from_start=False),
        _col_alpha_inset(img, 0, height, threshold, from_start=True),
        _col_alpha_inset(img, 0, height, threshold, from_start=False),
        _col_alpha_inset(img, width - 1, height, threshold, from_start=True),
        _col_alpha_inset(img, width - 1, height, threshold, from_start=False),
    ]
    valid_insets = [value for value in edge_insets if value is not None]
    if not valid_insets:
        return None
    max_inset = max(valid_insets)
    min_axis = float(min(width, height))
    if max_inset < min_axis * NINE_SLICE_ROUND_RECT_MIN_INSET_RATIO:
        return None
    raw_border = math.ceil(float(max_inset) * NINE_SLICE_ROUND_RECT_SAFETY_MULTIPLIER)
    max_border = max(NINE_SLICE_VISUAL_MIN_BORDER, math.floor(min_axis * NINE_SLICE_VISUAL_MAX_RATIO))
    max_center_safe = math.floor((min_axis - NINE_SLICE_ROUND_RECT_MIN_CENTER) * 0.5)
    if max_center_safe >= NINE_SLICE_VISUAL_MIN_BORDER:
        max_border = min(max_border, max_center_safe)
    border = float(max(NINE_SLICE_VISUAL_MIN_BORDER, min(raw_border, max_border)))
    if border * 2 >= width or border * 2 >= height:
        return None
    return {"left": border, "right": border, "top": border, "bottom": border}


def _apply_round_rect_nine_slice_borders(
    border: Dict[str, float],
    image: Optional["Image.Image"],
    width: int,
    height: int,
    inferred: bool,
) -> Dict[str, float]:
    """仅对标准九宫应用大圆角保护，避免强制 h3/v3 三切片被误放宽。"""
    if image is None or not inferred:
        return border
    round_rect_border = _infer_round_rect_nine_slice_borders(image, width, height)
    if not round_rect_border:
        return border
    adjusted = dict(border)
    adjusted["left"] = max(float(adjusted.get("left", 0.0)), round_rect_border["left"])
    adjusted["right"] = max(float(adjusted.get("right", 0.0)), round_rect_border["right"])
    adjusted["top"] = max(float(adjusted.get("top", 0.0)), round_rect_border["top"])
    adjusted["bottom"] = max(float(adjusted.get("bottom", 0.0)), round_rect_border["bottom"])
    return adjusted


def _apply_large_round_safe_nine_slice_borders(
    border: Dict[str, float],
    width: int,
    height: int,
    inferred: bool,
) -> Tuple[Dict[str, float], List[str]]:
    """为大尺寸自动九宫拦截异常小边框；不处理显式命名边框或三切片。"""
    if not inferred:
        return border, []
    short_axis = min(float(width), float(height))
    if width < 256 or height < 256 or short_axis <= 0.0:
        return border, []

    current = {
        "left": round(max(float(border.get("left", 0.0)), 0.0)),
        "bottom": round(max(float(border.get("bottom", 0.0)), 0.0)),
        "right": round(max(float(border.get("right", 0.0)), 0.0)),
        "top": round(max(float(border.get("top", 0.0)), 0.0)),
    }
    tiny_limit = max(12, round(short_axis * 0.02))
    has_tiny_horizontal = current["left"] <= tiny_limit or current["right"] <= tiny_limit
    has_tiny_top = current["top"] <= tiny_limit and current["top"] >= current["bottom"]
    has_tiny_bottom = current["bottom"] <= tiny_limit
    if not has_tiny_horizontal and not has_tiny_top and not has_tiny_bottom:
        return border, []

    safe = max(24, min(96, round(short_axis * 0.08)))
    adjusted = {
        "left": max(current["left"], safe) if has_tiny_horizontal else current["left"],
        "bottom": max(current["bottom"], safe) if has_tiny_bottom else current["bottom"],
        "right": max(current["right"], safe) if has_tiny_horizontal else current["right"],
        "top": max(current["top"], safe) if has_tiny_top else current["top"],
    }
    if adjusted["left"] + adjusted["right"] >= width:
        adjusted["left"] = current["left"]
        adjusted["right"] = current["right"]
    if adjusted["top"] + adjusted["bottom"] >= height:
        adjusted["top"] = current["top"]
        adjusted["bottom"] = current["bottom"]

    changed = any(adjusted[name] != current[name] for name in ("left", "bottom", "right", "top"))
    if not changed:
        return border, []
    return adjusted, [
        "large inferred 9-slice border was too small and was expanded; verify manually"
    ]


def _row_alpha_inset(
    img: "Image.Image",
    y: int,
    width: int,
    threshold: int,
    from_start: bool,
) -> Optional[int]:
    """获取指定行从一侧到首个有效 alpha 像素的距离。"""
    indices = range(width) if from_start else range(width - 1, -1, -1)
    for x in indices:
        if img.getpixel((x, y))[3] >= threshold:
            return x if from_start else width - 1 - x
    return None


def _col_alpha_inset(
    img: "Image.Image",
    x: int,
    height: int,
    threshold: int,
    from_start: bool,
) -> Optional[int]:
    """获取指定列从一侧到首个有效 alpha 像素的距离。"""
    indices = range(height) if from_start else range(height - 1, -1, -1)
    for y in indices:
        if img.getpixel((x, y))[3] >= threshold:
            return y if from_start else height - 1 - y
    return None


def _corners_empty_with_border(image: "Image.Image", border: Dict[str, float]) -> bool:
    """检查九宫四角保护区是否全部透明，避免圆角图被误切成十字形。"""
    img = image.convert("RGBA") if image.mode != "RGBA" else image
    width, height = img.size
    left = int(max(float(border.get("left", 0.0)), 0.0))
    right = int(max(float(border.get("right", 0.0)), 0.0))
    top = int(max(float(border.get("top", 0.0)), 0.0))
    bottom = int(max(float(border.get("bottom", 0.0)), 0.0))
    boxes = [
        (0, 0, left, top),
        (max(width - right, 0), 0, width, top),
        (0, max(height - bottom, 0), left, height),
        (max(width - right, 0), max(height - bottom, 0), width, height),
    ]
    checked = 0
    for box in boxes:
        x0, y0, x1, y1 = box
        if x1 <= x0 or y1 <= y0:
            continue
        checked += 1
        alpha = img.crop(box).getchannel("A")
        if any(value > 0 for value in alpha.getdata()):
            return False
    return checked > 0


def _apply_axis_edge_borders_for_slice_type(
    border: Dict[str, float],
    slice_type: str,
    image: Optional["Image.Image"],
    width: int,
    height: int,
    inferred: bool,
) -> Dict[str, float]:
    """三切片只在主轴采用视觉边缘，非主轴保持宽松，避免无关方向被放大。"""
    if image is None or not inferred or slice_type not in ("h3-slice", "v3-slice"):
        return border
    visual = _infer_visual_edge_borders(image, width, height)
    if visual is None:
        return border
    capsule_border = _infer_full_cross_section_axis_borders(image, slice_type, width, height)
    repeat_border = _infer_border_from_pixels(image, width, height) or {}
    adjusted = dict(border)
    if slice_type == "v3-slice":
        adjusted["top"] = _relax_v3_axis_border_value(
            capsule_border.get("top", visual.get("top", adjusted.get("top", NINE_SLICE_VISUAL_MIN_BORDER))),
            visual.get("top", 0.0),
            repeat_border.get("top", adjusted.get("top", 0.0)),
            width,
            height,
            NINE_SLICE_V3_CAP_MIN_RATIO,
        )
        adjusted["bottom"] = _relax_v3_axis_border_value(
            capsule_border.get("bottom", visual.get("bottom", adjusted.get("bottom", NINE_SLICE_VISUAL_MIN_BORDER))),
            visual.get("bottom", 0.0),
            repeat_border.get("bottom", adjusted.get("bottom", 0.0)),
            width,
            height,
            NINE_SLICE_V3_CAP_MIN_RATIO,
        )
        adjusted["left"] = NINE_SLICE_VISUAL_MIN_BORDER
        adjusted["right"] = NINE_SLICE_VISUAL_MIN_BORDER
    elif slice_type == "h3-slice":
        adjusted["left"] = _relax_h3_axis_border_value(
            capsule_border.get("left", visual.get("left", adjusted.get("left", NINE_SLICE_VISUAL_MIN_BORDER))),
            visual.get("left", 0.0),
            repeat_border.get("left", adjusted.get("left", 0.0)),
            height,
            NINE_SLICE_H3_CAP_MIN_RATIO,
        )
        adjusted["right"] = _relax_h3_axis_border_value(
            capsule_border.get("right", visual.get("right", adjusted.get("right", NINE_SLICE_VISUAL_MIN_BORDER))),
            visual.get("right", 0.0),
            repeat_border.get("right", adjusted.get("right", 0.0)),
            height,
            NINE_SLICE_H3_CAP_MIN_RATIO,
        )
        adjusted["top"] = NINE_SLICE_VISUAL_MIN_BORDER
        adjusted["bottom"] = NINE_SLICE_VISUAL_MIN_BORDER
    return adjusted


def _relax_h3_axis_border_value(
    current: float,
    visual: float,
    repeat: float,
    cross_size: int,
    min_ratio: float,
) -> float:
    """按 h3 垂直截面给主轴端帽补安全量，避免横向进度条端帽过窄。"""
    current = max(float(current), 0.0)
    candidate = max(float(visual), float(repeat), current)
    if candidate <= current:
        return current
    min_border = float(max(NINE_SLICE_VISUAL_MIN_BORDER, math.floor(float(cross_size) * min_ratio)))
    if current >= min_border:
        return current
    return min(candidate, min_border)


def _relax_v3_axis_border_value(
    current: float,
    visual: float,
    repeat: float,
    cross_size: int,
    axis_size: int,
    min_ratio: float,
) -> float:
    """按 v3 横截面给主轴端区补安全量，保留明显的顶部/底部视觉保护区。"""
    current = max(float(current), 0.0)
    candidate = max(float(visual), float(repeat), current)
    if candidate <= current:
        return current
    min_border = float(max(NINE_SLICE_VISUAL_MIN_BORDER, math.floor(float(cross_size) * min_ratio)))
    if current >= min_border:
        return current
    max_border = float(max(NINE_SLICE_VISUAL_MIN_BORDER, math.floor(float(axis_size) * NINE_SLICE_VISUAL_MAX_RATIO)))
    return min(candidate, max_border)


def _infer_full_cross_section_axis_borders(
    image: "Image.Image",
    slice_type: str,
    width: int,
    height: int,
) -> Dict[str, float]:
    """按完整横截面推断三切片主轴边界，避免胶囊进度条端帽被切得过窄。"""
    if width < 8 or height < 8:
        return {}
    img = image.convert("RGBA") if image.mode != "RGBA" else image
    if slice_type == "h3-slice":
        alpha_left = _find_full_alpha_section_border(
            img,
            axis_size=width,
            cross_size=height,
            from_start=True,
            horizontal=True,
        )
        alpha_right = _find_full_alpha_section_border(
            img,
            axis_size=width,
            cross_size=height,
            from_start=False,
            horizontal=True,
        )
        center_x = max(0, min(width - 1, width // 2))
        baseline = _sample_full_column_average(img, center_x, height)
        return {
            "left": float(alpha_left or _find_full_color_section_border(
                img,
                baseline,
                axis_size=width,
                cross_size=height,
                from_start=True,
                horizontal=True,
            )),
            "right": float(alpha_right or _find_full_color_section_border(
                img,
                baseline,
                axis_size=width,
                cross_size=height,
                from_start=False,
                horizontal=True,
            )),
        }
    if slice_type == "v3-slice":
        alpha_top = _find_full_alpha_section_border(
            img,
            axis_size=height,
            cross_size=width,
            from_start=True,
            horizontal=False,
        )
        alpha_bottom = _find_full_alpha_section_border(
            img,
            axis_size=height,
            cross_size=width,
            from_start=False,
            horizontal=False,
        )
        center_y = max(0, min(height - 1, height // 2))
        baseline = _sample_full_row_average(img, center_y, width)
        return {
            "top": float(alpha_top or _find_full_color_section_border(
                img,
                baseline,
                axis_size=height,
                cross_size=width,
                from_start=True,
                horizontal=False,
            )),
            "bottom": float(alpha_bottom or _find_full_color_section_border(
                img,
                baseline,
                axis_size=height,
                cross_size=width,
                from_start=False,
                horizontal=False,
            )),
        }
    return {}


def _sample_full_column_average(img: "Image.Image", x: int, height: int) -> Tuple[float, float, float, float]:
    """采样整列平均值，用于三切片端帽的完整截面判断。"""
    return _average_rgba([img.getpixel((x, y)) for y in range(height)])


def _sample_full_row_average(img: "Image.Image", y: int, width: int) -> Tuple[float, float, float, float]:
    """采样整行平均值，用于三切片端帽的完整截面判断。"""
    return _average_rgba([img.getpixel((x, y)) for x in range(width)])


def _find_full_alpha_section_border(
    img: "Image.Image",
    axis_size: int,
    cross_size: int,
    from_start: bool,
    horizontal: bool,
) -> Optional[int]:
    """查找整截面 alpha 全部稳定的位置，优先保护圆角、斜边和抗锯齿端帽。"""
    max_border = max(1, int(axis_size * NINE_SLICE_VISUAL_MAX_RATIO))
    indices = range(0, max_border) if from_start else range(axis_size - 1, axis_size - 1 - max_border, -1)
    for i in indices:
        values = (
            [img.getpixel((i, y))[3] for y in range(cross_size)]
            if horizontal
            else [img.getpixel((x, i))[3] for x in range(cross_size)]
        )
        if values and min(values) >= NINE_SLICE_FULL_SECTION_ALPHA_THRESHOLD:
            return max(i if from_start else axis_size - 1 - i, NINE_SLICE_VISUAL_MIN_BORDER)
    return None


def _find_full_color_section_border(
    img: "Image.Image",
    baseline: Tuple[float, float, float, float],
    axis_size: int,
    cross_size: int,
    from_start: bool,
    horizontal: bool,
) -> int:
    """查找整截面与中心截面颜色稳定一致的位置，作为 alpha 检测失败时的 fallback。"""
    max_border = max(1, int(axis_size * NINE_SLICE_VISUAL_MAX_RATIO))
    stable_run = 0
    indices = range(0, max_border) if from_start else range(axis_size - 1, axis_size - 1 - max_border, -1)
    for i in indices:
        sample = (
            _sample_full_column_average(img, i, cross_size)
            if horizontal
            else _sample_full_row_average(img, i, cross_size)
        )
        if _rgba_diff(sample, baseline) <= NINE_SLICE_EDGE_DIFF_THRESHOLD:
            stable_run += 1
            if stable_run >= NINE_SLICE_EDGE_STABLE_RUN:
                if from_start:
                    return max(i - stable_run + 1, NINE_SLICE_VISUAL_MIN_BORDER)
                return max(axis_size - i - stable_run, NINE_SLICE_VISUAL_MIN_BORDER)
        else:
            stable_run = 0
    return NINE_SLICE_VISUAL_MIN_BORDER


def _infer_border_from_pixels(image: "Image.Image", width: int, height: int) -> Optional[Dict[str, float]]:
    """通过分析图片像素的行/列重复性来推算九宫 border。

    返回 None 表示无法推算（图片太小或全透明等）。
    """
    if width < 8 or height < 8:
        return None

    img = image.convert("RGBA") if image.mode != "RGBA" else image
    raw = img.tobytes()
    stride = width * 4

    rows = [raw[y * stride:(y + 1) * stride] for y in range(height)]
    cols = [b"".join(raw[y * stride + x * 4:y * stride + x * 4 + 4] for y in range(height)) for x in range(width)]

    non_transparent_rows = sum(1 for r in rows if any(r[i + 3] > 0 for i in range(0, len(r), 4)))
    if non_transparent_rows < 4:
        return None

    top = _find_repeat_border(rows, height, from_start=True)
    bottom = _find_repeat_border(rows, height, from_start=False)
    left = _find_repeat_border(cols, width, from_start=True)
    right = _find_repeat_border(cols, width, from_start=False)

    if left + right >= width or top + bottom >= height:
        return None

    # 容错：当某方向 border 异常小而其他方向明显更大时，自动修正
    # 典型场景：圆角图的左右边缘有大片透明像素被误判为"重复"
    min_ratio_threshold = 0.02  # 低于轴向 2% 视为异常小
    max_border = max(left, right, top, bottom)

    if max_border > 0:
        # 如果 left 异常小，参考垂直方向（top/bottom）修正
        if left < width * min_ratio_threshold and max(top, bottom) > left * 5:
            left = min(top, bottom)
            left = min(left, int(width * NINE_SLICE_VISUAL_MAX_RATIO))
        # 如果 right 异常小，参考垂直方向修正
        if right < width * min_ratio_threshold and max(top, bottom) > right * 5:
            right = min(top, bottom)
            right = min(right, int(width * NINE_SLICE_VISUAL_MAX_RATIO))
        # 如果 top 异常小，参考水平方向（left/right）修正
        if top < height * min_ratio_threshold and max(left, right) > top * 5:
            top = min(left, right)
            top = min(top, int(height * NINE_SLICE_VISUAL_MAX_RATIO))
        # 如果 bottom 异常小，参考水平方向修正
        if bottom < height * min_ratio_threshold and max(left, right) > bottom * 5:
            bottom = min(left, right)
            bottom = min(bottom, int(height * NINE_SLICE_VISUAL_MAX_RATIO))

    if left + right >= width or top + bottom >= height:
        return None

    return {"left": float(left), "bottom": float(bottom), "right": float(right), "top": float(top)}


def _default_nine_slice_border(axis_size: float) -> float:
    """按图层尺寸推测单侧九宫边框，仅作为视觉推算失败时的 fallback。"""
    return max(float(axis_size) * NINE_SLICE_INFER_RATIO, 0.0)


def _clamp_nine_slice_border_value(value: float, axis_size: float) -> float:
    """限制推测边框不超过对应轴向的一半，避免切片重叠。"""
    return min(max(float(value), 0.0), max(float(axis_size) * 0.5, 0.0))


def _infer_nine_slice_border(
    parsed_border: Dict[str, float],
    width: int,
    height: int,
    image: Optional["Image.Image"] = None,
) -> Tuple[Dict[str, float], Dict[str, Any], List[str]]:
    """在 PSD 图层名缺少九宫边框时自动推测边框并返回说明。优先使用视觉像素分析。"""
    border = {name: max(float(parsed_border.get(name, 0.0)), 0.0) for name in ("left", "bottom", "right", "top")}
    missing_before = _missing_nine_slice_border_fields(border)
    warnings: List[str] = []
    if not missing_before:
        return border, {
            "inferredBorder": False,
            "confidence": "explicit",
            "inferMethod": "explicit-name-values",
            "inferredFields": [],
            "clampedFields": [],
        }, warnings

    # 优先尝试视觉边缘推算，并与重复行/列结果宽松合并，避免自动 9-slice 边界过大
    visual_border = None
    if image is not None and len(missing_before) == 4:
        visual_border = _infer_visual_edge_borders(image, width, height)
    repeat_border = None
    if image is not None and len(missing_before) == 4:
        repeat_border = _infer_border_from_pixels(image, width, height)

    if visual_border is not None:
        border = _merge_visual_and_repeat_borders(visual_border, repeat_border, width, height, image)
        warnings.append(
            "nine-slice border inferred from merged visual edge and repeat analysis; verify manually"
        )
        return border, {
            "inferredBorder": True,
            "confidence": "medium",
            "inferMethod": "visual-repeat-merged",
            "inferredFields": list(missing_before),
            "clampedFields": [],
        }, warnings

    # 兼容旧逻辑：视觉边缘推算失败时再尝试重复行/列推算
    if repeat_border is not None:
        border = repeat_border
        warnings.append(
            "nine-slice border inferred from pixel repeat analysis; verify manually"
        )
        return border, {
            "inferredBorder": True,
            "confidence": "medium",
            "inferMethod": "pixel-repeat-analysis",
            "inferredFields": list(missing_before),
            "clampedFields": [],
        }, warnings

    # Fallback: 对边镜像
    inferred_fields: List[str] = []
    if border["left"] <= 0.0 and border["right"] > 0.0:
        border["left"] = border["right"]
        inferred_fields.append("left")
    if border["right"] <= 0.0 and border["left"] > 0.0:
        border["right"] = border["left"]
        inferred_fields.append("right")
    if border["top"] <= 0.0 and border["bottom"] > 0.0:
        border["top"] = border["bottom"]
        inferred_fields.append("top")
    if border["bottom"] <= 0.0 and border["top"] > 0.0:
        border["bottom"] = border["top"]
        inferred_fields.append("bottom")

    # Fallback: 固定比例（仅在视觉推算和镜像都无法覆盖时）
    defaults = {
        "left": _default_nine_slice_border(width),
        "right": _default_nine_slice_border(width),
        "top": _default_nine_slice_border(height),
        "bottom": _default_nine_slice_border(height),
    }
    for name, default_value in defaults.items():
        if border[name] <= 0.0:
            border[name] = default_value
            if name not in inferred_fields:
                inferred_fields.append(name)

    clamped_fields: List[str] = []
    axis_sizes = {"left": width, "right": width, "top": height, "bottom": height}
    for name, axis_size in axis_sizes.items():
        clamped_value = _clamp_nine_slice_border_value(border[name], axis_size)
        if abs(clamped_value - border[name]) > 0.0001:
            clamped_fields.append(name)
            border[name] = clamped_value

    method = (
        "all-missing-size-ratio-fallback"
        if len(missing_before) == 4
        else "partial-missing-mirror-or-ratio-fallback"
    )
    warnings.append(
        "nine-slice border values were missing and inferred from opposite side or layer size; "
        "verify manually"
    )
    if clamped_fields:
        warnings.append(f"nine-slice inferred border clamped for fields: {','.join(clamped_fields)}")

    return border, {
        "inferredBorder": True,
        "confidence": "low",
        "inferMethod": method,
        "inferredFields": inferred_fields,
        "clampedFields": clamped_fields,
    }, warnings


def _compressed_pair(first: float, second: float, limit: float, warning: str) -> Tuple[float, float, List[str]]:
    """按可用长度等比压缩两侧边框，并返回压缩 warning。"""
    total = first + second
    if total <= limit:
        return first, second, []
    if total <= 0.0:
        return 0.0, 0.0, []
    scale = max(limit, 0.0) / total
    return first * scale, second * scale, [warning]


def _slice_name(row_name: str, column_name: str) -> str:
    """按 prefab-to-figma 的固定命名规则生成 Figma 九宫子层名称。"""
    parts = [part for part in (row_name, column_name) if part]
    return "__slice_" + "_".join(parts or ["center"])


def _build_nine_slice(
    width: float,
    height: float,
    image_width: float,
    image_height: float,
    border: Dict[str, float],
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """根据目标尺寸、源图尺寸和边框生成动态 1 到 9 个九宫切片。"""
    left = max(float(border.get("left", 0.0)), 0.0)
    right = max(float(border.get("right", 0.0)), 0.0)
    top = max(float(border.get("top", 0.0)), 0.0)
    bottom = max(float(border.get("bottom", 0.0)), 0.0)

    target_left, target_right, horizontal_warnings = _compressed_pair(
        left,
        right,
        float(width),
        "nine-slice target horizontal border compressed",
    )
    target_top, target_bottom, vertical_warnings = _compressed_pair(
        top,
        bottom,
        float(height),
        "nine-slice target vertical border compressed",
    )
    source_left, source_right, source_horizontal_warnings = _compressed_pair(
        left,
        right,
        float(image_width),
        "nine-slice source horizontal border compressed",
    )
    source_top, source_bottom, source_vertical_warnings = _compressed_pair(
        top,
        bottom,
        float(image_height),
        "nine-slice source vertical border compressed",
    )

    warnings = horizontal_warnings + vertical_warnings + source_horizontal_warnings + source_vertical_warnings
    target_center_width = float(width) - target_left - target_right
    target_center_height = float(height) - target_top - target_bottom
    source_center_width = float(image_width) - source_left - source_right
    source_center_height = float(image_height) - source_top - source_bottom

    columns = (
        ("left", target_left, 0.0, source_left, 0.0),
        ("", target_center_width, target_left, source_center_width, source_left),
        ("right", target_right, float(width) - target_right, source_right, float(image_width) - source_right),
    )
    rows = (
        ("top", target_top, 0.0, source_top, 0.0),
        ("", target_center_height, target_top, source_center_height, source_top),
        ("bottom", target_bottom, float(height) - target_bottom, source_bottom, float(image_height) - source_bottom),
    )

    slices: List[Dict[str, Any]] = []
    for row_name, target_row_height, target_y, source_row_height, source_y in rows:
        for column_name, target_column_width, target_x, source_column_width, source_x in columns:
            if target_column_width <= 0.0 or target_row_height <= 0.0:
                continue
            if source_column_width <= 0.0 or source_row_height <= 0.0:
                continue
            slices.append(
                {
                    "name": _slice_name(row_name, column_name),
                    "target": [target_x, target_y, target_column_width, target_row_height],
                    "source": [source_x, source_y, source_column_width, source_row_height],
                }
            )
    return slices, warnings


def _determine_slice_type(width: float, height: float) -> Optional[str]:
    """根据图层宽高判断适合的切片类型。

    返回 "9-slice" / "h3-slice" / "v3-slice"，空间不适合切片时返回 None。
    """
    ratio = width / height if height > 0 else 999.0

    # 小尺寸且接近正方形 → 降级为普通图片
    if width < 100 and height < 100 and 0.5 <= ratio <= 2.0:
        return None

    # 宽高比 > 3:1 或扁平条状（高 < 80 且宽 > 高×3）→ 横向三切片
    if ratio > 3.5 or (height < 80 and width > height * 3):
        return "h3-slice"

    # 宽高比 < 1:3 或窄条状（宽 < 80 且高 > 宽×3）→ 纵向三切片
    if ratio < 1.0 / 3.5 or (width < 80 and height > width * 3.5):
        return "v3-slice"

    # 宽高都 > 100 且比例合理 → 标准九宫
    if width >= 100 and height >= 100:
        return "9-slice"

    # 其余情况退化为普通图片
    return None


def _build_nine_slice_family_stats(layers: List[Dict[str, object]]) -> Dict[str, Dict[str, Any]]:
    """按九宫图层同族名称汇总尺寸，辅助自动判断横向或纵向三切片。"""
    stats: Dict[str, Dict[str, Any]] = {}
    for layer in layers:
        name = str(layer.get("name", ""))
        if _detect_common_component_marker(name):
            continue
        family_key = _nine_slice_family_key(name)
        if not family_key:
            continue
        width = float(layer.get("width", 0.0))
        height = float(layer.get("height", 0.0))
        if width <= 0.0 or height <= 0.0:
            continue
        entry = stats.setdefault(family_key, {"items": [], "widths": [], "heights": []})
        entry["items"].append({"name": name, "width": width, "height": height})
        entry["widths"].append(width)
        entry["heights"].append(height)
    return stats


def _detect_family_slice_type(layer_name: str, family_stats: Optional[Dict[str, Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """根据同族图层尺寸关系判断是否应使用 h3 或 v3 三切片。"""
    if not family_stats:
        return None
    family_key = _nine_slice_family_key(layer_name)
    if not family_key:
        return None
    entry = family_stats.get(family_key)
    if not entry or len(entry.get("items", [])) < 2:
        return None

    widths = [float(value) for value in entry.get("widths", [])]
    heights = [float(value) for value in entry.get("heights", [])]
    if not widths or not heights:
        return None

    width_delta = max(widths) - min(widths)
    height_delta = max(heights) - min(heights)
    same_width = width_delta <= NINE_SLICE_FAMILY_SAME_AXIS_TOLERANCE
    same_height = height_delta <= NINE_SLICE_FAMILY_SAME_AXIS_TOLERANCE
    height_changed = height_delta >= NINE_SLICE_FAMILY_CHANGED_AXIS_MIN_DELTA
    width_changed = width_delta >= NINE_SLICE_FAMILY_CHANGED_AXIS_MIN_DELTA

    if same_width and height_changed:
        return {
            "sliceType": "v3-slice",
            "source": "auto-family-size",
            "confidence": "high",
            "reason": f"同族 {family_key} 宽度一致且高度变化，判断为纵向三切片。",
        }
    if same_height and width_changed:
        return {
            "sliceType": "h3-slice",
            "source": "auto-family-size",
            "confidence": "high",
            "reason": f"同族 {family_key} 高度一致且宽度变化，判断为横向三切片。",
        }
    return None


def _build_h3_slice(
    width: float, height: float,
    image_width: float, image_height: float,
    border: Dict[str, float],
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """只切 X 方向，保留完整高度。"""
    left = max(float(border.get("left", 0.0)), 0.0)
    right = max(float(border.get("right", 0.0)), 0.0)

    target_left, target_right, h_warnings = _compressed_pair(left, right, float(width),
                                                              "h3-slice target border compressed")
    source_left, source_right, s_warnings = _compressed_pair(left, right, float(image_width),
                                                              "h3-slice source border compressed")
    warnings = h_warnings + s_warnings

    target_center = float(width) - target_left - target_right
    source_center = float(image_width) - source_left - source_right

    slices = []
    for name, tw, tx, sw, sx in [
        ("__slice_left", target_left, 0.0, source_left, 0.0),
        ("__slice_center", target_center, target_left, source_center, source_left),
        ("__slice_right", target_right, float(width) - target_right, source_right, float(image_width) - source_right),
    ]:
        if tw <= 0.0 or sw <= 0.0:
            continue
        slices.append({
            "name": name,
            "target": [tx, 0.0, tw, float(height)],
            "source": [sx, 0.0, sw, float(image_height)],
        })
    return slices, warnings


def _build_v3_slice(
    width: float, height: float,
    image_width: float, image_height: float,
    border: Dict[str, float],
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """只切 Y 方向，保留完整宽度。"""
    top = max(float(border.get("top", 0.0)), 0.0)
    bottom = max(float(border.get("bottom", 0.0)), 0.0)

    target_top, target_bottom, h_warnings = _compressed_pair(top, bottom, float(height),
                                                              "v3-slice target border compressed")
    source_top, source_bottom, s_warnings = _compressed_pair(top, bottom, float(image_height),
                                                              "v3-slice source border compressed")
    warnings = h_warnings + s_warnings

    target_center = float(height) - target_top - target_bottom
    source_center = float(image_height) - source_top - source_bottom

    slices = []
    for name, th, ty, sh, sy in [
        ("__slice_top", target_top, 0.0, source_top, 0.0),
        ("__slice_center", target_center, target_top, source_center, source_top),
        ("__slice_bottom", target_bottom, float(height) - target_bottom, source_bottom, float(image_height) - source_bottom),
    ]:
        if th <= 0.0 or sh <= 0.0:
            continue
        slices.append({
            "name": name,
            "target": [0.0, ty, float(width), th],
            "source": [0.0, sy, float(image_width), sh],
        })
    return slices, warnings


def _build_nine_slice_info(
    layer_name: str,
    width: int,
    height: int,
    image: Optional["Image.Image"] = None,
    family_stats: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """根据图层名和形状创建九宫/三切片信息；未命中九宫标记或形状不适合时返回空。"""
    marker = _detect_nine_slice_marker(layer_name)
    if marker is None:
        return None

    forced_slice_type = _detect_forced_slice_type(layer_name)
    family_slice_info = None if forced_slice_type else _detect_family_slice_type(layer_name, family_stats)
    slice_type = forced_slice_type or (family_slice_info or {}).get("sliceType") or _determine_slice_type(float(width), float(height))
    if slice_type is None:
        return None  # 形状不适合切片，降级为普通图片

    declared_border = _parse_nine_slice_border(layer_name)
    border, infer_info, infer_warnings = _infer_nine_slice_border(declared_border, width, height, image)
    if forced_slice_type:
        infer_info = dict(infer_info)
        infer_info["inferMethod"] = f"name-forced-{forced_slice_type}"
        infer_info["confidence"] = "high"
    elif family_slice_info:
        infer_info = dict(infer_info)
        infer_info["inferMethod"] = str(family_slice_info["source"])
        infer_info["confidence"] = str(family_slice_info["confidence"])

    border = _apply_axis_edge_borders_for_slice_type(
        border,
        str(slice_type),
        image,
        width,
        height,
        bool(infer_info["inferredBorder"]),
    )
    if slice_type == "9-slice":
        border = _apply_round_rect_nine_slice_borders(
            border,
            image,
            width,
            height,
            bool(infer_info["inferredBorder"]),
        )
        border, large_safe_warnings = _apply_large_round_safe_nine_slice_borders(
            border,
            width,
            height,
            bool(infer_info["inferredBorder"]),
        )
    else:
        large_safe_warnings = []

    if slice_type == "h3-slice":
        slices, build_warnings = _build_h3_slice(width, height, width, height, border)
    elif slice_type == "v3-slice":
        slices, build_warnings = _build_v3_slice(width, height, width, height, border)
    else:
        slices, build_warnings = _build_nine_slice(width, height, width, height, border)

    warnings: List[str] = infer_warnings + large_safe_warnings + build_warnings
    if family_slice_info:
        warnings.append(str(family_slice_info["reason"]))

    return {
        "marker": marker,
        "namespace": NINE_SLICE_NAMESPACE,
        "sliceType": slice_type,
        "sliceTypeSource": "name-forced" if forced_slice_type else ((family_slice_info or {}).get("source") or "shape-inferred"),
        "sliceReason": (family_slice_info or {}).get("reason", ""),
        "border": border,
        "declaredBorder": declared_border,
        "inferredBorder": infer_info["inferredBorder"],
        "inferMethod": infer_info["inferMethod"],
        "confidence": infer_info["confidence"],
        "inferredFields": infer_info["inferredFields"],
        "clampedFields": infer_info["clampedFields"],
        "originalPixelSize": f"{width}x{height}",
        "sourceImageFillIndex": 0,
        "slices": slices,
        "warnings": warnings,
    }


def _read_pascal_name(data: bytes, offset: int) -> Tuple[str, int]:
    """读取 PSD Pascal 字符串并按 4 字节对齐推进。"""
    length = data[offset]
    raw = data[offset + 1:offset + 1 + length]
    name = raw.decode("macroman", errors="replace")
    consumed = 1 + length
    padded = ((consumed + 3) // 4) * 4
    return name, offset + padded


def _decode_packbits(src: bytes, expected_size: int) -> bytes:
    """解码 PackBits RLE 数据。"""
    out = bytearray()
    index = 0
    src_len = len(src)
    while index < src_len and len(out) < expected_size:
        marker = src[index]
        index += 1
        if marker <= 127:
            count = marker + 1
            out.extend(src[index:index + count])
            index += count
        elif marker >= 129:
            count = 257 - marker
            if index >= src_len:
                break
            out.extend([src[index]] * count)
            index += 1
        else:
            # 128 是 no-op。
            continue
    if len(out) < expected_size:
        out.extend([0] * (expected_size - len(out)))
    return bytes(out[:expected_size])


def _decode_channel(payload: bytes, width: int, height: int) -> bytes:
    """解码单个 PSD 通道，支持 Raw 和 PackBits。"""
    if width <= 0 or height <= 0:
        return bytes()
    compression = struct.unpack(">H", payload[:2])[0]
    expected_size = width * height
    if compression == 0:
        raw = payload[2:2 + expected_size]
        if len(raw) < expected_size:
            raw += bytes(expected_size - len(raw))
        return raw
    if compression == 1:
        pos = 2
        row_lengths: List[int] = []
        for _ in range(height):
            row_lengths.append(struct.unpack(">H", payload[pos:pos + 2])[0])
            pos += 2
        out = bytearray()
        for row_length in row_lengths:
            row_payload = payload[pos:pos + row_length]
            pos += row_length
            out.extend(_decode_packbits(row_payload, width))
        if len(out) < expected_size:
            out.extend([0] * (expected_size - len(out)))
        return bytes(out[:expected_size])
    raise ValueError(f"不支持的 PSD 通道压缩类型: {compression}")


def _parse_layer_records(data: bytes) -> Tuple[Dict[str, int], List[Dict[str, object]]]:
    """解析 PSD Header、Layer/Mask Info 和 Layer Records。"""
    signature = data[:4].decode("ascii", errors="replace")
    version = _u16(data, 4)
    channels = _u16(data, 12)
    height = _u32(data, 14)
    width = _u32(data, 18)
    depth = _u16(data, 22)
    color_mode = _u16(data, 24)
    if signature != "8BPS" or version != 1:
        raise ValueError("仅支持标准 PSD v1 文件。")
    if depth != 8 or color_mode != 3:
        raise ValueError(f"当前脚本仅支持 RGB/8-bit PSD，实际 depth={depth}, colorMode={color_mode}。")

    pos = 26
    pos += 4 + _u32(data, pos)
    pos += 4 + _u32(data, pos)
    layer_mask_len = _u32(data, pos)
    pos += 4
    if layer_mask_len == 0:
        raise ValueError("PSD 没有 Layer/Mask Info Section，无法导出分层。")

    layer_info_len = _u32(data, pos)
    pos += 4
    if layer_info_len == 0:
        raise ValueError("PSD 没有 Layer Info，可能只有合成图。")

    raw_count = _i16(data, pos)
    pos += 2
    layer_count = abs(raw_count)
    layers: List[Dict[str, object]] = []

    for index in range(layer_count):
        top = _i32(data, pos)
        left = _i32(data, pos + 4)
        bottom = _i32(data, pos + 8)
        right = _i32(data, pos + 12)
        pos += 16
        channel_count = _u16(data, pos)
        pos += 2
        channel_records: List[Dict[str, int]] = []
        for _ in range(channel_count):
            channel_id = _i16(data, pos)
            channel_len = _u32(data, pos + 2)
            pos += 6
            channel_records.append({"id": channel_id, "length": channel_len})

        blend_key = data[pos + 4:pos + 8].decode("ascii", errors="replace")
        opacity = data[pos + 8]
        flags = data[pos + 10]
        pos += 12

        extra_len = _u32(data, pos)
        pos += 4
        extra_end = pos + extra_len
        mask_len = _u32(data, pos)
        pos += 4 + mask_len
        blending_len = _u32(data, pos)
        pos += 4 + blending_len
        pascal_name, pos = _read_pascal_name(data, pos)

        unicode_name: Optional[str] = None
        section_type: Optional[int] = None
        tags: List[str] = []
        tag_payloads: Dict[str, bytes] = {}
        while pos + 12 <= extra_end:
            key = data[pos + 4:pos + 8].decode("ascii", errors="replace")
            tag_len = _u32(data, pos + 8)
            pos += 12
            payload = data[pos:pos + tag_len]
            tags.append(key)
            if key in ("TySh", "lfx2", "lfx ", "lyid"):
                tag_payloads[key] = payload
            if key == "luni" and len(payload) >= 4:
                char_count = struct.unpack(">I", payload[:4])[0]
                unicode_name = payload[4:4 + char_count * 2].decode("utf-16-be", errors="replace")
            if key in ("lsct", "lsdk") and len(payload) >= 4:
                section_type = struct.unpack(">I", payload[:4])[0]
            pos += tag_len + (tag_len & 1)
        pos = extra_end

        layer_type = "raster"
        if "TySh" in tags:
            layer_type = "text-rasterized"
        elif any(tag in tags for tag in ("vscg", "vsms", "vmsk")):
            layer_type = "shape-rasterized"

        layers.append({
            "index": index,
            "layerId": _read_psd_layer_id(tag_payloads),
            "name": unicode_name or pascal_name,
            "type": layer_type,
            "x": left,
            "y": top,
            "width": right - left,
            "height": bottom - top,
            "opacity": opacity,
            "visible": (flags & 2) == 0,
            "blend": blend_key,
            "flags": flags,
            "sectionType": section_type,
            "tags": tags,
            "_tagPayloads": tag_payloads,
            "channels": channel_records,
        })

    channel_pos = pos
    for layer in layers:
        for channel in layer["channels"]:  # type: ignore[index]
            channel["offset"] = channel_pos
            channel_pos += channel["length"]

    canvas = {
        "width": width,
        "height": height,
        "channels": channels,
        "depth": depth,
        "colorMode": color_mode,
        "layerCountRaw": raw_count,
    }
    return canvas, layers


def _render_layer(data: bytes, layer: Dict[str, object]) -> Image.Image:
    """把单个 PSD 图层通道合成为 RGBA 图像。"""
    width = int(layer["width"])
    height = int(layer["height"])
    pixel_count = width * height
    decoded: Dict[int, bytes] = {}
    for channel in layer["channels"]:  # type: ignore[index]
        channel_id = int(channel["id"])
        offset = int(channel["offset"])
        length = int(channel["length"])
        decoded[channel_id] = _decode_channel(data[offset:offset + length], width, height)

    red = decoded.get(0, bytes([0]) * pixel_count)
    green = decoded.get(1, red)
    blue = decoded.get(2, red)
    alpha = decoded.get(-1, bytes([255]) * pixel_count)

    rgba = bytearray(pixel_count * 4)
    for pixel_index in range(pixel_count):
        base = pixel_index * 4
        rgba[base] = red[pixel_index]
        rgba[base + 1] = green[pixel_index]
        rgba[base + 2] = blue[pixel_index]
        rgba[base + 3] = alpha[pixel_index]
    return Image.frombytes("RGBA", (width, height), bytes(rgba))


def _write_layers(psd_path: Path, out_dir: Path, composite_check: bool) -> Dict[str, object]:
    """导出 PSD 全部图层并写入 manifest。"""
    data = psd_path.read_bytes()
    canvas, layers = _parse_layer_records(data)
    out_dir.mkdir(parents=True, exist_ok=True)
    nine_slice_family_stats = _build_nine_slice_family_stats(layers)

    manifest_layers: List[Dict[str, object]] = []
    manifest_warnings: List[str] = []
    for layer in layers:
        width = int(layer["width"])
        height = int(layer["height"])
        if width <= 0 or height <= 0:
            continue
        image = _render_layer(data, layer)
        safe_name = _safe_name(str(layer["name"]), f"layer_{layer['index']}")
        png_path = out_dir / f"{int(layer['index']):02d}_{safe_name}.png"
        image.save(png_path, optimize=True)
        content_hash = hashlib.sha256(png_path.read_bytes()).hexdigest()
        common_component_info = _build_common_component_info(str(layer["name"]))
        nine_slice_info = None if common_component_info else _build_nine_slice_info(
            str(layer["name"]),
            width,
            height,
            image,
            nine_slice_family_stats,
        )
        text_info = None if common_component_info or nine_slice_info else _build_text_info(layer.get("_tagPayloads", {}))  # type: ignore[arg-type]
        component_search_info = common_component_info
        if component_search_info is None and nine_slice_info is None and text_info is None:
            component_search_info = _build_component_search_info(
                str(layer["name"]),
                COMPONENT_SEARCH_STRATEGY_AUTO,
            )
        layer_warnings: List[str] = []
        if common_component_info:
            layer_warnings.extend(str(warning) for warning in common_component_info.get("warnings", []))
        if nine_slice_info:
            layer_warnings.extend(str(warning) for warning in nine_slice_info.get("warnings", []))
        if text_info:
            layer_warnings.extend(str(warning) for warning in text_info.get("warnings", []))
        for warning in layer_warnings:
            manifest_warnings.append(f"{layer['index']}:{layer['name']}: {warning}")

        mode = "image"
        if common_component_info:
            mode = "common-component"
        elif nine_slice_info:
            mode = "nine-slice"
        elif text_info:
            mode = "text"

        semantic_info = _normalize_layer_semantics(str(layer["name"]), mode)
        layer_warnings.extend(str(warning) for warning in semantic_info["normalizationWarnings"])
        for warning in semantic_info["normalizationWarnings"]:
            manifest_warnings.append(f"{layer['index']}:{layer['name']}: {warning}")

        layer_entry = {
            "index": layer["index"],
            "layerId": layer.get("layerId"),
            "name": layer["name"],
            "rawPsdLayerName": semantic_info["rawPsdLayerName"],
            "normalizedLayerName": semantic_info["normalizedLayerName"],
            "semanticMode": semantic_info["semanticMode"],
            "normalizationWarnings": semantic_info["normalizationWarnings"],
            "type": layer["type"],
            "mode": mode,
            "x": layer["x"],
            "y": layer["y"],
            "width": width,
            "height": height,
            "opacity": layer["opacity"],
            "visible": layer["visible"],
            "blend": layer["blend"],
            "flags": layer["flags"],
            "sectionType": layer["sectionType"],
            "tags": layer["tags"],
            "path": png_path.as_posix(),
            "bytes": png_path.stat().st_size,
            "contentHash": content_hash,
            "constraints": _infer_constraints(
                float(layer["x"]),
                float(layer["y"]),
                float(width),
                float(height),
                float(canvas["width"]),
                float(canvas["height"]),
            ),
            "warnings": layer_warnings,
        }
        if common_component_info:
            layer_entry["common"] = common_component_info
        if component_search_info:
            layer_entry["componentSearch"] = component_search_info
        if nine_slice_info:
            layer_entry["nineSlice"] = nine_slice_info
        if text_info:
            layer_entry["text"] = text_info
        psd_prefix = _psd_prefix_record(layer_entry)
        if psd_prefix:
            layer_entry["psdPrefix"] = {
                "number": psd_prefix["number"],
                "prefix": psd_prefix["prefix"],
                "label": psd_prefix["label"],
                "hintOnly": True,
            }
        manifest_layers.append(layer_entry)

    duplicate_layer_ids = _find_duplicate_layer_ids(manifest_layers)
    if duplicate_layer_ids:
        raise ValueError(
            "PSD contains duplicate Layer IDs: "
            + ", ".join(str(layer_id) for layer_id in duplicate_layer_ids)
        )

    semantic_hints = {
        "psdPrefix": _build_psd_prefix_hints(manifest_layers, canvas),
    }
    manifest: Dict[str, object] = {
        "source": psd_path.as_posix(),
        "canvas": canvas,
        "layerCount": len(manifest_layers),
        "hasGroups": any(layer.get("sectionType") in (1, 2, 3) for layer in manifest_layers),
        "commonComponentCount": sum(1 for layer in manifest_layers if layer.get("mode") == "common-component"),
        "componentSearchCount": sum(1 for layer in manifest_layers if layer.get("componentSearch")),
        "autoComponentSearchCount": sum(
            1
            for layer in manifest_layers
            if isinstance(layer.get("componentSearch"), dict)
            and layer["componentSearch"].get("strategy") == COMPONENT_SEARCH_STRATEGY_AUTO  # type: ignore[index]
        ),
        "nineSliceCount": sum(1 for layer in manifest_layers if layer.get("mode") == "nine-slice"),
        "textLayerCount": sum(1 for layer in manifest_layers if layer.get("mode") == "text"),
        "semanticHints": semantic_hints,
        "warnings": manifest_warnings,
        "layers": manifest_layers,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    if composite_check:
        _write_composite_check(psd_path, out_dir, manifest)

    return manifest


def _write_composite_check(psd_path: Path, out_dir: Path, manifest: Dict[str, object]) -> None:
    """用导出的图层重建合成图，并输出与 PSD 合成图的差异摘要。"""
    canvas = manifest["canvas"]  # type: ignore[index]
    width = int(canvas["width"])
    height = int(canvas["height"])
    composite = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for layer in manifest["layers"]:  # type: ignore[index]
        if not layer["visible"]:
            continue
        image = Image.open(layer["path"]).convert("RGBA")
        opacity = int(layer["opacity"])
        if opacity < 255:
            red, green, blue, alpha = image.split()
            alpha = alpha.point(lambda value, op=opacity: int(value * op / 255))
            image = Image.merge("RGBA", (red, green, blue, alpha))
        temp = Image.new("RGBA", composite.size, (0, 0, 0, 0))
        temp.paste(image, (int(layer["x"]), int(layer["y"])), image)
        composite = Image.alpha_composite(composite, temp)

    composite_path = out_dir / "composite_from_layers.png"
    composite.save(composite_path, optimize=True)

    try:
        psd_composite = Image.open(psd_path).convert("RGBA")
        diff = ImageChops.difference(composite, psd_composite)
        alpha_mask = Image.eval(
            ImageChops.lighter(composite.getchannel("A"), psd_composite.getchannel("A")),
            lambda alpha: 255 if alpha > 0 else 0,
        )
        stat = ImageStat.Stat(diff.convert("RGB"), mask=alpha_mask)
        visible_rgb_rms = math.sqrt(sum(value * value for value in stat.rms) / len(stat.rms)) if stat.rms else 0
        check = {
            "composite": composite_path.as_posix(),
            "visibleRgbRms": visible_rgb_rms,
            "note": "RMS 受 PSD blend/effects 与透明像素 RGB 影响，仅作为快速校验，不等同于像素级完全一致。",
        }
    except Exception as exc:  # pragma: no cover
        check = {"composite": composite_path.as_posix(), "error": str(exc)}
    (out_dir / "composite_check.json").write_text(json.dumps(check, ensure_ascii=False, indent=2), encoding="utf-8")


def _normalize_for_match(name: str) -> str:
    """规范化名称用于组件匹配：去前缀、转小写、移除分隔符。"""
    n = name
    for prefix in ("Common_", "Common-", "common_", "common-", "image_", "img_"):
        if n.startswith(prefix):
            n = n[len(prefix):]
            break
    return n.lower().replace(" ", "").replace("-", "").replace("_", "").replace(
        "[", "").replace("]", "").replace("(", "").replace(")", "").replace(".", "")


def _fuzzy_score(query_norm: str, comp_norm: str) -> float:
    """计算两个规范化名称的模糊相似度分数（0~1）。"""
    if query_norm == comp_norm:
        return 1.0
    if not query_norm or not comp_norm:
        return 0.0
    # 包含关系
    if query_norm in comp_norm or comp_norm in query_norm:
        shorter = min(len(query_norm), len(comp_norm))
        longer = max(len(query_norm), len(comp_norm))
        return shorter / longer * 0.95
    # 公共前缀比例
    common_len = 0
    for a, b in zip(query_norm, comp_norm):
        if a == b:
            common_len += 1
        else:
            break
    max_len = max(len(query_norm), len(comp_norm))
    return common_len / max_len * 0.85 if max_len > 0 else 0.0


def _try_match_component(
    query: str,
    candidates: List[str],
    comp_normalized: Dict[str, object],
    img_normalized: Dict[str, object],
    comp_list: List[Dict[str, object]],
    threshold: float,
    layer_w: int = 0,
    layer_h: int = 0,
) -> Dict[str, object]:
    """尝试匹配单个图层到组件库，返回匹配结果。"""
    query_norm = _normalize_for_match(query)

    # 1. 精确匹配 - 先查通用图片库
    if query_norm in img_normalized:
        comp = img_normalized[query_norm]
        if isinstance(comp, list):
            return {"matched": False, "needsAgentReview": True,
                    "reason": "multiple-image-candidates",
                    "candidates": [{"name": c["name"], "id": c["id"]} for c in comp]}
        return {"matched": True, "matchedComponentId": comp["id"],
                "matchedComponentName": comp["name"],
                "matchMethod": "exact-normalized-image-library",
                "matchConfidence": 1.0, "needsAgentReview": False}

    # 再查通用组件库
    if query_norm in comp_normalized:
        comp = comp_normalized[query_norm]
        if isinstance(comp, list):
            return {"matched": False, "needsAgentReview": True,
                    "reason": "multiple-component-candidates",
                    "candidates": [{"name": c["name"], "id": c["id"]} for c in comp]}
        return {"matched": True, "matchedComponentId": comp["id"],
                "matchedComponentName": comp["name"],
                "matchMethod": "exact-normalized-component-library",
                "matchConfidence": 1.0, "needsAgentReview": False}

    # 2. 候选名精确匹配
    for candidate in candidates:
        candidate_norm = _normalize_for_match(candidate)
        for lib in (comp_normalized, img_normalized):
            if candidate_norm in lib:
                comp = lib[candidate_norm]
                if isinstance(comp, list):
                    continue
                return {"matched": True, "matchedComponentId": comp["id"],
                        "matchedComponentName": comp["name"],
                        "matchMethod": "candidate-exact-normalized",
                        "matchConfidence": 1.0, "needsAgentReview": False}

    # 3. 模糊匹配（含尺寸加权打破平局）
    scored_comps: List[tuple] = []
    for comp in comp_list:
        comp_norm = _normalize_for_match(comp["name"])
        score = _fuzzy_score(query_norm, comp_norm)
        if score >= 0.3:
            scored_comps.append((score, comp))
    scored_comps.sort(key=lambda x: x[0], reverse=True)

    best_score = scored_comps[0][0] if scored_comps else 0.0
    second_score = scored_comps[1][0] if len(scored_comps) > 1 else 0.0
    best_comp = scored_comps[0][1] if scored_comps else None

    # 多个同分候选时用尺寸相似度打破平局
    if best_score > 0 and best_score == second_score and layer_w > 0 and layer_h > 0:
        tied = [c for s, c in scored_comps if abs(s - best_score) < 0.001]
        best_size_diff = float("inf")
        for comp in tied:
            cw = comp.get("width", 0)
            ch = comp.get("height", 0)
            if cw > 0 and ch > 0:
                diff = abs(cw - layer_w) / max(cw, layer_w) + abs(ch - layer_h) / max(ch, layer_h)
                if diff < best_size_diff:
                    best_size_diff = diff
                    best_comp = comp
        if best_size_diff < 0.5:
            second_score = best_score * 0.9

    if best_score >= threshold and (best_score - second_score) >= 0.08 and best_comp:
        return {"matched": True, "matchedComponentId": best_comp["id"],
                "matchedComponentName": best_comp["name"],
                "matchMethod": "fuzzy-score",
                "matchConfidence": round(best_score, 3),
                "needsAgentReview": best_score < 0.95}

    # 4. 无匹配 - 收集候选供 Agent 审核
    top_candidates = [{"name": c["name"], "id": c["id"], "score": round(s, 3)}
                      for s, c in scored_comps[:5]]
    return {"matched": False, "needsAgentReview": True,
            "reason": "no-high-confidence-match",
            "bestScore": round(best_score, 3),
            "topCandidates": top_candidates}


def _match_components_offline(
    manifest: Dict[str, object],
    cache_dir: Path,
) -> Dict[str, object]:
    """离线组件匹配：读取缓存索引，对 common 和 auto 层做匹配。

    高置信写入 matchedComponentId，低置信标记 needsAgentReview。
    """
    comp_cache_path = cache_dir / "component_library_cache.json"
    img_cache_path = cache_dir / "image_library_cache.json"
    comp_cache: Dict[str, object] = {}
    img_cache: Dict[str, object] = {}

    if comp_cache_path.exists():
        with open(comp_cache_path, "r", encoding="utf-8") as f:
            comp_cache = json.load(f)
    if img_cache_path.exists():
        with open(img_cache_path, "r", encoding="utf-8") as f:
            img_cache = json.load(f)

    comp_normalized: Dict[str, object] = comp_cache.get("normalized", {})
    img_normalized: Dict[str, object] = img_cache.get("normalized", {})
    comp_list: List[Dict[str, object]] = comp_cache.get("components", [])
    results: Dict[str, object] = {}

    for layer in manifest.get("layers", []):
        idx = str(layer["index"])
        mode = layer.get("mode", "image")

        if mode == "common-component":
            common_info = layer.get("common", layer.get("componentSearch", {}))
            query = common_info.get("query", "")
            candidates = common_info.get("candidateNames", [])
            results[idx] = _try_match_component(
                query, candidates, comp_normalized, img_normalized, comp_list, 0.88,
                int(layer.get("width", 0)), int(layer.get("height", 0)))

        elif mode == "image" and isinstance(layer.get("componentSearch"), dict):
            cs = layer["componentSearch"]
            if cs.get("strategy") == "auto":
                layer_name = str(layer.get("name", ""))
                if re.match(r"^图层\s*\d+", layer_name) or re.match(
                        r"^图层\s*\d+\s*拷贝", layer_name):
                    results[idx] = {"matched": False,
                                    "skipReason": "generic-layer-name",
                                    "needsAgentReview": False}
                    continue
                query = cs.get("query", "")
                candidates = cs.get("candidateNames", [])
                results[idx] = _try_match_component(
                    query, candidates, comp_normalized, img_normalized,
                    comp_list, 0.92,
                    int(layer.get("width", 0)), int(layer.get("height", 0)))

    return results


def _generate_summary(
    manifest: Dict[str, object],
    match_results: Optional[Dict[str, object]] = None,
) -> Dict[str, object]:
    """生成精简 manifest_summary.json，只包含 Figma 导入所需字段。"""
    canvas = manifest["canvas"]
    layers = manifest["layers"]
    summary_layers: List[Dict[str, object]] = []
    common_layers: List[Dict[str, object]] = []
    nine_slice_layers: List[Dict[str, object]] = []
    text_layers: List[Dict[str, object]] = []
    image_layers: List[Dict[str, object]] = []

    for layer in layers:
        idx = layer["index"]
        mode = layer["mode"]
        entry: Dict[str, object] = {
            "idx": idx, "name": layer["name"], "mode": mode,
            "layerId": layer.get("layerId"),
            "contentHash": layer.get("contentHash", ""),
            "rawPsdLayerName": layer.get("rawPsdLayerName", layer["name"]),
            "normalizedLayerName": layer.get("normalizedLayerName", layer["name"]),
            "semanticMode": layer.get("semanticMode", mode),
            "x": layer["x"], "y": layer["y"],
            "w": layer["width"], "h": layer["height"],
            "opacity": layer["opacity"], "visible": layer["visible"],
            "constraints": layer.get("constraints", {}),
            "path": layer["path"],
        }
        if layer.get("psdPrefix"):
            entry["psdPrefix"] = layer["psdPrefix"]
        if match_results and str(idx) in match_results:
            entry["match"] = match_results[str(idx)]

        if mode == "text" and "text" in layer:
            t = layer["text"]
            entry["chars"] = t.get("characters", "")
            entry["fontSize"] = t.get("fontSize", 0)
            entry["effectiveFontSize"] = t.get("effectiveFontSize") or t.get("fontSize", 0)
            entry["originalFontSize"] = t.get("fontSize", 0)
            entry["textTransform"] = t.get("textTransform")
            entry["effectiveSizeSource"] = t.get("effectiveSizeSource")
            entry["leading"] = t.get("leading")
            entry["lineHeightMode"] = t.get("lineHeightMode")
            entry["textAlign"] = t.get("textAlignHorizontal")
            entry["fillColor"] = t.get("fillColor", {})
            stroke = t.get("effects", {}).get("stroke")
            entry["stroke"] = {
                "enabled": stroke.get("enabled", False),
                "r": stroke.get("color", {}).get("r", 0),
                "g": stroke.get("color", {}).get("g", 0),
                "b": stroke.get("color", {}).get("b", 0),
                "size": stroke.get("size", 0),
            } if stroke else None
            drop_shadow = t.get("effects", {}).get("dropShadow")
            entry["dropShadow"] = {
                "enabled": drop_shadow.get("enabled", False),
            } if drop_shadow else None
            entry["fontFallback"] = t.get("figma", {}).get("fontFallbackCandidates", [])[:3]
            text_layers.append(entry)
        elif mode == "common-component":
            common_info = layer.get("common", {})
            entry["query"] = common_info.get("query", "")
            entry["candidateNames"] = common_info.get("candidateNames", [])
            common_layers.append(entry)
        elif mode == "nine-slice":
            ns = layer.get("nineSlice", {})
            entry["sliceType"] = ns.get("sliceType", "9-slice")
            entry["sliceTypeSource"] = ns.get("sliceTypeSource", "")
            entry["sliceReason"] = ns.get("sliceReason", "")
            entry["border"] = ns.get("border", {})
            entry["inferredBorder"] = ns.get("inferredBorder", False)
            entry["inferMethod"] = ns.get("inferMethod", "")
            entry["confidence"] = ns.get("confidence", "")
            entry["slices"] = ns.get("slices", [])
            entry["originalPixelSize"] = ns.get("originalPixelSize", "")
            nine_slice_layers.append(entry)
        else:
            image_layers.append(entry)

        summary_layers.append(entry)

    return {
        "canvas": {"width": canvas["width"], "height": canvas["height"]},
        "layerCount": len(summary_layers),
        "commonCount": len(common_layers),
        "nineSliceCount": len(nine_slice_layers),
        "textCount": len(text_layers),
        "imageCount": len(image_layers),
        "layers": summary_layers,
        "commonLayers": common_layers,
        "nineSliceLayers": nine_slice_layers,
        "textLayers": text_layers,
        "imageLayers": image_layers,
        "semanticHints": manifest.get("semanticHints", {}),
    }


def main() -> int:
    """解析命令行参数并执行 PSD 图层导出。"""
    parser = argparse.ArgumentParser(description="导出 PSD 图层为 PNG，并生成 Figma 导入 manifest。")
    parser.add_argument("psd", type=Path, help="输入 PSD 文件路径。")
    parser.add_argument("--out", type=Path, required=True, help="输出目录。")
    parser.add_argument("--composite-check", action="store_true", help="额外输出合成校验图和差异摘要。")
    parser.add_argument("--summary", action="store_true", help="同时生成 manifest_summary.json 精简摘要。")
    parser.add_argument("--match-cache", type=Path, default=None,
                        help="组件缓存目录路径，启用离线组件匹配写入 summary。")
    args = parser.parse_args()

    manifest = _write_layers(args.psd, args.out, args.composite_check)
    layers = manifest["layers"]  # type: ignore[index]

    # 离线组件匹配
    match_results: Optional[Dict[str, object]] = None
    if args.match_cache and args.match_cache.exists():
        match_results = _match_components_offline(manifest, args.match_cache)

    # 生成精简摘要
    if args.summary:
        summary_data = _generate_summary(manifest, match_results)
        summary_path = args.out / "manifest_summary.json"
        summary_path.write_text(
            json.dumps(summary_data, ensure_ascii=False, indent=2), encoding="utf-8")

    # 输出统计
    stats: Dict[str, object] = {
        "outDir": args.out.as_posix(),
        "manifest": (args.out / "manifest.json").as_posix(),
        "canvas": manifest["canvas"],
        "layerCount": manifest["layerCount"],
        "hasGroups": manifest["hasGroups"],
        "commonComponentCount": manifest["commonComponentCount"],
        "componentSearchCount": manifest["componentSearchCount"],
        "autoComponentSearchCount": manifest["autoComponentSearchCount"],
        "nineSliceCount": manifest["nineSliceCount"],
        "textLayerCount": manifest["textLayerCount"],
        "warningCount": len(manifest["warnings"]),  # type: ignore[arg-type]
        "maxPngBytes": max((int(layer["bytes"]) for layer in layers), default=0),
        "totalPngBytes": sum(int(layer["bytes"]) for layer in layers),
    }
    if args.summary:
        stats["summaryPath"] = (args.out / "manifest_summary.json").as_posix()
    if match_results:
        matched_count = sum(1 for r in match_results.values()
                           if isinstance(r, dict) and r.get("matched"))
        review_count = sum(1 for r in match_results.values()
                          if isinstance(r, dict) and r.get("needsAgentReview"))
        stats["matchResults"] = {
            "totalMatched": matched_count,
            "needsReview": review_count,
            "skipped": sum(1 for r in match_results.values()
                          if isinstance(r, dict) and r.get("skipReason")),
        }
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
