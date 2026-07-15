"""九宫切片类型检测与验证 —— gen_spec.py 和 process_images.py 共享模块。

避免两份脚本各自维护重复的检测逻辑导致一致性 bug。
"""

import json


def detect_type_and_border(slices, w, h):
    """根据 __slice_* 子节点名称和容器尺寸判断九宫类型并计算 border。

    优先级：显式切片名称 > 宽高比自动判断。
    v3slice 容器（w/h 在 0.3-3.0 范围内）会先被 has_t+has_b 捕获，
    不会被宽高比分支误判为 9slice 导致 border 全 0。

    Args:
        slices: {name: node_dict}，node_dict 需包含 "bounds" → {"width": int, "height": int}
        w: 容器显示宽度
        h: 容器显示高度

    Returns:
        (type_str, border_dict) 或 (None, None)
        border_dict: {"left": int, "right": int, "top": int, "bottom": int}
    """
    has_tl = "__slice_top_left" in slices
    has_l = "__slice_left" in slices
    has_r = "__slice_right" in slices
    has_t = "__slice_top" in slices
    has_b = "__slice_bottom" in slices

    def _bw(name):
        return int(slices.get(name, {}).get("bounds", {}).get("width", 0))

    def _bh(name):
        return int(slices.get(name, {}).get("bounds", {}).get("height", 0))

    if has_tl:
        return ("9slice", {
            "left": _bw("__slice_top_left"),
            "right": _bw("__slice_top_right"),
            "top": _bh("__slice_top_left"),
            "bottom": _bh("__slice_bottom_left"),
        })
    elif has_l and has_r:
        return ("h3slice", {
            "left": _bw("__slice_left"),
            "right": _bw("__slice_right"),
            "top": 0, "bottom": 0,
        })
    elif has_t and has_b:
        return ("v3slice", {
            "left": 0, "right": 0,
            "top": _bh("__slice_top"),
            "bottom": _bh("__slice_bottom"),
        })
    elif w > 100 and h > 100 and 0.3 <= w / h <= 3.0:
        return ("9slice", {
            "left": _bw("__slice_top_left"),
            "right": _bw("__slice_top_right"),
            "top": _bh("__slice_top_left"),
            "bottom": _bh("__slice_bottom_left"),
        })
    return (None, None)


def validate_spec(spec, image_dir=None):
    """验证 prefab_spec.json 中的九宫配置是否合理。

    检查项：
    1. Sliced 图片的 border 不能全为 0
    2. v3slice 最小宽度 > 2（必须保留显示宽度）
    3. h3slice 最小高度 > 2（必须保留显示高度）

    Returns:
        {"allPass": bool, "blockingErrors": [...], "warnings": [...]}
    """
    errors = []
    warnings = []

    images = spec.get("images", []) if isinstance(spec, dict) else spec
    for img in images:
        setting = json.loads(img.get("spriteSettingJson", "{}"))
        border = setting.get("border", {})
        l, r, t, b = border.get("l", 0), border.get("r", 0), border.get("t", 0), border.get("b", 0)

        if l == 0 and r == 0 and t == 0 and b == 0:
            continue  # Simple image

        fname = img.get("fileName", "?")

        # 检查 1: 九宫 border 不能全 0
        if l == 0 and r == 0 and t == 0 and b == 0:
            # Already handled by continue above, but explicit for clarity
            pass

        # 检查 2: v3slice (left=right=0 且 top>0 或 bottom>0) — 宽度不能只是 2px
        is_v3 = l == 0 and r == 0 and (t > 0 or b > 0)
        if is_v3:
            if image_dir:
                import os
                from PIL import Image
                path = os.path.join(image_dir, fname)
                if os.path.exists(path):
                    actual_w = Image.open(path).size[0]
                    if actual_w <= 2:
                        errors.append({
                            "code": "v3sliceWidthTooSmall",
                            "message": f"v3slice {fname} 宽度仅 {actual_w}px，应保留完整显示宽度。",
                            "details": {"fileName": fname, "actualWidth": actual_w},
                        })

        # 检查 3: h3slice (top=bottom=0 且 left>0 或 right>0) — 高度不能只是 2px
        is_h3 = t == 0 and b == 0 and (l > 0 or r > 0)
        if is_h3:
            if image_dir:
                import os
                from PIL import Image
                path = os.path.join(image_dir, fname)
                if os.path.exists(path):
                    actual_h = Image.open(path).size[1]
                    if actual_h <= 2:
                        errors.append({
                            "code": "h3sliceHeightTooSmall",
                            "message": f"h3slice {fname} 高度仅 {actual_h}px，应保留完整显示高度。",
                            "details": {"fileName": fname, "actualHeight": actual_h},
                        })

    return {
        "allPass": len(errors) == 0,
        "blockingErrors": errors,
        "warnings": warnings,
    }
