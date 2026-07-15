from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any, Mapping


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float
    rotation_z: float = 0.0

    def rounded(self) -> "Rect":
        """返回四舍五入后的矩形，避免浮点误差污染导出结果。精度为 6 位小数。"""
        return Rect(
            round(self.x, 6),
            round(self.y, 6),
            round(self.width, 6),
            round(self.height, 6),
            round(self.rotation_z, 6),
        )


def resolve_rect(rect_fields: Mapping[str, Any], parent_width: float, parent_height: float, _debug: bool = False) -> Rect:
    """根据 Unity RectTransform 字段解析为 Figma 左上角坐标矩形。"""
    fields = _unwrap_rect_fields(rect_fields)
    anchor_min = _read_vector2(fields, ("m_AnchorMin", "anchorMin"), (0.5, 0.5))
    anchor_max = _read_vector2(fields, ("m_AnchorMax", "anchorMax"), anchor_min)
    size_delta = _read_vector2(fields, ("m_SizeDelta", "sizeDelta"), (0.0, 0.0))
    pivot = _read_vector2(fields, ("m_Pivot", "pivot"), (0.5, 0.5))
    anchored_position = _read_vector2(
        fields,
        ("m_AnchoredPosition", "anchoredPosition", "m_AnchoredPosition3D"),
        (0.0, 0.0),
    )
    local_scale = _read_vector3(fields, ("m_LocalScale", "localScale"), (1.0, 1.0, 1.0))

    span_width = (anchor_max[0] - anchor_min[0]) * parent_width
    span_height = (anchor_max[1] - anchor_min[1]) * parent_height
    base_width = span_width + size_delta[0]
    base_height = span_height + size_delta[1]

    pivot_x = anchor_min[0] * parent_width + span_width * pivot[0] + anchored_position[0]
    pivot_y = anchor_min[1] * parent_height + span_height * pivot[1] + anchored_position[1]

    scale_x = local_scale[0]
    scale_y = local_scale[1]
    left = pivot_x - pivot[0] * base_width * scale_x
    right = pivot_x + (1.0 - pivot[0]) * base_width * scale_x
    bottom = pivot_y - pivot[1] * base_height * scale_y
    top = pivot_y + (1.0 - pivot[1]) * base_height * scale_y

    figma_left = min(left, right)
    figma_top = parent_height - max(bottom, top)
    width = abs(right - left)
    height = abs(top - bottom)

    result = Rect(figma_left, figma_top, width, height, extract_rotation_z(fields))

    if _debug:
        import json
        import sys
        debug_info = {
            "parent_size": [parent_width, parent_height],
            "anchor_min": list(anchor_min),
            "anchor_max": list(anchor_max),
            "size_delta": list(size_delta),
            "pivot": list(pivot),
            "anchored_position": list(anchored_position),
            "local_scale": list(local_scale[:2]),
            "figma_rect": [result.x, result.y, result.width, result.height],
        }
        print(f"[resolve_rect] {json.dumps(debug_info)}", file=sys.stderr)

    return result


def extract_rotation_z(rect_fields: Mapping[str, Any]) -> float:
    """从 Unity 四元数中提取绕 Z 轴的角度，单位为度。"""
    fields = _unwrap_rect_fields(rect_fields)
    euler_hint = _read_mapping(fields, ("m_LocalEulerAnglesHint", "localEulerAnglesHint"))
    if euler_hint is not None:
        return _read_number(euler_hint, "z", 0.0)

    rotation = _read_mapping(fields, ("m_LocalRotation", "localRotation", "rotation"))
    if rotation is None:
        return 0.0

    x = _read_number(rotation, "x", 0.0)
    y = _read_number(rotation, "y", 0.0)
    z = _read_number(rotation, "z", 0.0)
    w = _read_number(rotation, "w", 1.0)

    length = math.sqrt(x * x + y * y + z * z + w * w)
    if length <= 0.0:
        return 0.0

    x /= length
    y /= length
    z /= length
    w /= length

    sin_z = 2.0 * (w * z + x * y)
    cos_z = 1.0 - 2.0 * (y * y + z * z)
    return math.degrees(math.atan2(sin_z, cos_z))


def _unwrap_rect_fields(rect_fields: Mapping[str, Any]) -> Mapping[str, Any]:
    """兼容直接字段字典和带 RectTransform 包裹的解析结果。"""
    wrapped = rect_fields.get("RectTransform")
    if isinstance(wrapped, Mapping):
        return wrapped
    return rect_fields


def _read_vector2(
    fields: Mapping[str, Any],
    keys: tuple[str, ...],
    default: tuple[float, float],
) -> tuple[float, float]:
    """读取 Unity Vector2 字段。"""
    value = _read_any(fields, keys)
    if value is None:
        return default
    if isinstance(value, Mapping):
        return (_read_number(value, "x", default[0]), _read_number(value, "y", default[1]))
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return (_to_float(value[0], default[0]), _to_float(value[1], default[1]))
    return default


def _read_vector3(
    fields: Mapping[str, Any],
    keys: tuple[str, ...],
    default: tuple[float, float, float],
) -> tuple[float, float, float]:
    """读取 Unity Vector3 字段。"""
    value = _read_any(fields, keys)
    if value is None:
        return default
    if isinstance(value, Mapping):
        return (
            _read_number(value, "x", default[0]),
            _read_number(value, "y", default[1]),
            _read_number(value, "z", default[2]),
        )
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return (
            _to_float(value[0], default[0]),
            _to_float(value[1], default[1]),
            _to_float(value[2], default[2]),
        )
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return (_to_float(value[0], default[0]), _to_float(value[1], default[1]), default[2])
    return default


def _read_mapping(fields: Mapping[str, Any], keys: tuple[str, ...]) -> Mapping[str, Any] | None:
    """读取字典类型字段。"""
    value = _read_any(fields, keys)
    if isinstance(value, Mapping):
        return value
    return None


def _read_any(fields: Mapping[str, Any], keys: tuple[str, ...]) -> Any:
    """按多个候选字段名读取第一个存在的值。"""
    for key in keys:
        if key in fields:
            return fields[key]
    return None


def _read_number(fields: Mapping[str, Any], key: str, default: float) -> float:
    """读取数值字段。"""
    return _to_float(fields.get(key), default)


def _to_float(value: Any, default: float) -> float:
    """将 Unity YAML 解析出的数值安全转换为 float。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _self_test() -> None:
    """运行最小布局解析自测。"""
    centered = {
        "m_AnchorMin": {"x": 0.5, "y": 0.5},
        "m_AnchorMax": {"x": 0.5, "y": 0.5},
        "m_SizeDelta": {"x": 100, "y": 50},
        "m_Pivot": {"x": 0.5, "y": 0.5},
        "m_AnchoredPosition": {"x": 0, "y": 0},
        "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        "m_LocalRotation": {"x": 0, "y": 0, "z": 0, "w": 1},
    }
    centered_rect = resolve_rect(centered, 200, 200).rounded()
    assert centered_rect == Rect(50, 75, 100, 50, 0), centered_rect

    stretched = {
        "m_AnchorMin": {"x": 0, "y": 0},
        "m_AnchorMax": {"x": 1, "y": 1},
        "m_SizeDelta": {"x": 0, "y": 0},
        "m_Pivot": {"x": 0.5, "y": 0.5},
        "m_AnchoredPosition": {"x": 0, "y": 0},
        "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        "m_LocalRotation": {"x": 0, "y": 0, "z": 0, "w": 1},
    }
    stretched_rect = resolve_rect(stretched, 1080, 1920).rounded()
    assert stretched_rect == Rect(0, 0, 1080, 1920, 0), stretched_rect


if __name__ == "__main__":
    _self_test()
    print("rect_transform self-test passed")
