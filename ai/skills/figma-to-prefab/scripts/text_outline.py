#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Figma 文本描边 → TMP SDF 描边参数换算，gen_spec.py 与 auto_componentset_specs.py 共用。

TMP_SDF-Mobile 把描边画在「膨胀后的字形边缘」两侧各一半，外扩像素为：
    2 × atlasPadding × OutlineWidth × 字号 / 采样字号(pointSize)
因此 OutlineWidth = 描边px × pointSize / (2 × padding × 字号)，三种对齐宽度相同，
由 FaceDilate 决定描边落点：OUTSIDE = W（字身不被侵蚀），CENTER = 0，INSIDE = -W。
manifest 没有 strokeAlign（旧插件导出）时保持旧经验公式：W = 7/3 × 描边/字号，FaceDilate = W/2。
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

# 旧经验系数，仅用于没有 strokeAlign 的旧清单，保证历史产物可复现
LEGACY_OUTLINE_FACTOR = 7.0 / 3.0
# CommonFont（GROBOLD SDF）的采样字号与图集 padding；读不到项目字体资产时使用
DEFAULT_FONT_SDF_METRICS = {"pointSize": 58.0, "padding": 10.0}
# 材质签名中的对齐标记，避免与旧规则（FaceDilate = W/2）生成的同宽材质混用
STROKE_ALIGN_TOKENS = {"OUTSIDE": "out", "CENTER": "ctr", "INSIDE": "in"}
FONT_SETTINGS_RELATIVE = Path("ProjectSettings") / "FigmaBridgeImportSettings.json"


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def normalize_stroke_align(value) -> str:
    """把 Figma strokeAlign 规范为 OUTSIDE/CENTER/INSIDE，未知或缺失返回空串（走旧规则）。"""
    align = str(value or "").strip().upper()
    return align if align in STROKE_ALIGN_TOKENS else ""


def stroke_align_signature_token(stroke_align) -> str:
    """返回材质签名里的对齐片段，如 `_a_out`；旧规则返回空串，保持旧签名不变。"""
    align = normalize_stroke_align(stroke_align)
    return f"_a_{STROKE_ALIGN_TOKENS[align]}" if align else ""


def load_font_sdf_metrics(unity_project) -> dict:
    """从 FigmaBridgeImportSettings.json 指向的 TMP 字体资产读取采样字号和图集 padding。

    返回 pointSize/padding/source/fontAssetPath/reason；source 为 fontAsset 或 default。
    """
    fallback = {**DEFAULT_FONT_SDF_METRICS, "source": "default", "fontAssetPath": "", "reason": ""}
    if not unity_project:
        return {**fallback, "reason": "未指定 Unity 工程"}
    root = Path(unity_project)
    try:
        settings = json.loads((root / FONT_SETTINGS_RELATIVE).read_text(encoding="utf-8-sig"))
        asset_path = str(settings.get("commonFontAsset") or "").strip()
        if not asset_path:
            return {**fallback, "reason": "commonFontAsset 未配置"}
        text = (root / asset_path).read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError, AttributeError) as error:
        return {**fallback, "reason": f"{type(error).__name__}: {error}"[:200]}
    # 采样字号只取 m_FaceInfo 块内的值，避免命中旧 m_fontInfo、fallback 等结构里的同名字段
    face_info = re.search(r"^\s*m_FaceInfo:\s*$", text, re.MULTILINE)
    point = re.search(r"^\s*m_PointSize:\s*([0-9.]+)", text[face_info.end():] if face_info else text, re.MULTILINE)
    padding = re.search(r"^\s*m_AtlasPadding:\s*([0-9.]+)", text, re.MULTILINE)
    if not point or not padding or float(point.group(1)) <= 0 or float(padding.group(1)) <= 0:
        return {**fallback, "fontAssetPath": asset_path, "reason": "字体资产缺少有效的 m_PointSize/m_AtlasPadding"}
    return {
        "pointSize": float(point.group(1)),
        "padding": float(padding.group(1)),
        "source": "fontAsset",
        "fontAssetPath": asset_path,
        "reason": "",
    }


@lru_cache(maxsize=16)
def _cached_font_sdf_metrics(unity_project: str) -> dict:
    return load_font_sdf_metrics(unity_project)


def cached_font_sdf_metrics(unity_project: str) -> dict:
    """按工程路径缓存字体 SDF 参数，同一次导入只读一次字体资产；返回副本防止调用方改写缓存。"""
    return dict(_cached_font_sdf_metrics(unity_project))


cached_font_sdf_metrics.cache_clear = _cached_font_sdf_metrics.cache_clear


def compute_text_outline(stroke_weight, font_size, stroke_align, metrics=None) -> tuple[float, float]:
    """返回 (OutlineWidth, FaceDilate)，均为 TMP 材质归一化值。

    stroke_weight: Figma 描边像素；font_size: Unity 实际使用的字号；
    stroke_align 为空时走旧规则；metrics 缺省时用 CommonFont 默认采样参数。
    """
    stroke_weight = float(stroke_weight or 0)
    font_size = float(font_size or 0)
    if stroke_weight <= 0 or font_size <= 0:
        return 0.0, 0.0
    align = normalize_stroke_align(stroke_align)
    if not align:
        width = round(_clamp(LEGACY_OUTLINE_FACTOR * stroke_weight / font_size, 0, 1), 2)
        return width, round(width * 0.5, 3)
    metrics = metrics or DEFAULT_FONT_SDF_METRICS
    width = round(_clamp(stroke_weight * metrics["pointSize"] / (2.0 * metrics["padding"] * font_size), 0, 1), 2)
    face_dilate = {"OUTSIDE": width, "CENTER": 0.0, "INSIDE": -width}[align]
    return width, face_dilate
