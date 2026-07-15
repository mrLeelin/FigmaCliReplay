#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Mapping, Tuple


Rect = Tuple[float, float, float, float]


@dataclass(frozen=True)
class SliceRect:
    """表示一个九宫切片的目标矩形和源图矩形。"""

    name: str
    target: Rect
    source: Rect


def _border_value(border: Any, name: str) -> float:
    """读取 border 中指定方向的数值，缺失时按 0 处理。"""
    if border is None:
        return 0.0
    if isinstance(border, Mapping):
        value = border.get(name, 0.0)
    else:
        value = getattr(border, name, 0.0)
    try:
        return max(float(value), 0.0)
    except (TypeError, ValueError):
        return 0.0


def has_border(border: Any) -> bool:
    """判断 left/right/top/bottom 是否存在任一正数边框。"""
    return any(_border_value(border, name) > 0.0 for name in ("left", "right", "top", "bottom"))


def _compressed_pair(first: float, second: float, limit: float, warning: str) -> Tuple[float, float, List[str]]:
    """按可用长度等比压缩两侧目标边框，并返回对应 warning。"""
    total = first + second
    if total <= limit:
        return first, second, []
    if total <= 0.0:
        return 0.0, 0.0, []
    scale = max(limit, 0.0) / total
    return first * scale, second * scale, [warning]


def build_nine_slice(
    width: float,
    height: float,
    image_width: float,
    image_height: float,
    border: Any,
) -> Tuple[List[SliceRect], List[str]]:
    """根据目标尺寸、源图尺寸和边框生成九宫切片矩形。"""
    left = _border_value(border, "left")
    right = _border_value(border, "right")
    top = _border_value(border, "top")
    bottom = _border_value(border, "bottom")

    target_left, target_right, horizontal_warnings = _compressed_pair(
        left,
        right,
        float(width),
        "nine-slice horizontal border compressed",
    )
    target_top, target_bottom, vertical_warnings = _compressed_pair(
        top,
        bottom,
        float(height),
        "nine-slice vertical border compressed",
    )

    warnings = horizontal_warnings + vertical_warnings
    target_center_width = float(width) - target_left - target_right
    target_center_height = float(height) - target_top - target_bottom
    source_center_width = float(image_width) - left - right
    source_center_height = float(image_height) - top - bottom

    columns = (
        ("left", target_left, 0.0, left, 0.0),
        ("", target_center_width, target_left, source_center_width, left),
        ("right", target_right, float(width) - target_right, right, float(image_width) - right),
    )
    rows = (
        ("top", target_top, 0.0, top, 0.0),
        ("", target_center_height, target_top, source_center_height, top),
        ("bottom", target_bottom, float(height) - target_bottom, bottom, float(image_height) - bottom),
    )

    slices: List[SliceRect] = []
    for row_name, target_row_height, target_y, source_row_height, source_y in rows:
        for column_name, target_column_width, target_x, source_column_width, source_x in columns:
            if target_column_width <= 0.0 or target_row_height <= 0.0:
                continue
            name = _slice_name(row_name, column_name)
            slices.append(
                SliceRect(
                    name=name,
                    target=(target_x, target_y, target_column_width, target_row_height),
                    source=(source_x, source_y, source_column_width, source_row_height),
                )
            )
    return slices, warnings


def _slice_name(row_name: str, column_name: str) -> str:
    """按固定命名规则生成 Figma 子切片名称。"""
    parts = [part for part in (row_name, column_name) if part]
    return "__slice_" + "_".join(parts or ["center"])


def _self_test() -> None:
    """执行基础场景和压缩场景自测。"""
    slices, warnings = build_nine_slice(
        100,
        50,
        100,
        50,
        {"left": 10, "right": 20, "top": 5, "bottom": 15},
    )
    assert len(slices) == 9
    assert warnings == []
    assert [slice_rect.name for slice_rect in slices] == [
        "__slice_top_left",
        "__slice_top",
        "__slice_top_right",
        "__slice_left",
        "__slice_center",
        "__slice_right",
        "__slice_bottom_left",
        "__slice_bottom",
        "__slice_bottom_right",
    ]
    first_row_width = sum(slice_rect.target[2] for slice_rect in slices[:3])
    assert first_row_width == 100

    compressed_slices, compressed_warnings = build_nine_slice(
        10,
        8,
        100,
        80,
        {"left": 8, "right": 8, "top": 6, "bottom": 6},
    )
    assert compressed_slices
    assert compressed_warnings == [
        "nine-slice horizontal border compressed",
        "nine-slice vertical border compressed",
    ]


if __name__ == "__main__":
    _self_test()
    print("nine_slice self-test passed")
