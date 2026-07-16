#!/usr/bin/env python3
"""自动识别本节点内 ComponentSet，并生成旁边 Prefab 的 JSON Spec。"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import os

# ── 本地白像素 Sprite ─────────────────────────
# SOLID fill 无效果节点复用此 1×1 白像素 + Image.color
WHITE_PIXEL_FILENAME = "white_1x1.png"
WHITE_PIXEL_IMAGE_ID = "builtin_white_1x1"


def is_solid_only_no_effects(node):
    fills = node.get("fills", [])
    if len(fills) != 1 or fills[0].get("type") != "SOLID":
        return False
    if node.get("cornerRadius", 0) > 0:
        return False
    for s in node.get("strokes", []):
        if s.get("visible", True) and s.get("type") == "SOLID":
            return False
    effects = node.get("effects", [])
    if effects and len(effects) > 0:
        return False
    return True


def get_solid_fill_color(node):
    for f in node.get("fills", []):
        if f.get("type") == "SOLID" and f.get("visible", True):
            c = f.get("color", {})
            fa = f.get("opacity", 1)
            no = node.get("opacity", 1)
            return {
                "r": round(c.get("r", 1), 4),
                "g": round(c.get("g", 1), 4),
                "b": round(c.get("b", 1), 4),
                "a": round(fa * no, 4),
            }
    return {"r": 1, "g": 1, "b": 1, "a": 1}
import sys
from collections import defaultdict
from pathlib import Path

from nine_slice_common import detect_type_and_border
from name_utils import sanitize_name, normalize_unity_display_name, strip_outer_brackets, clamp, unity_node_name
from constraints_utils import convert_figma_bounds_to_unity_rect, figma_constraints_to_rect_transform_spec
from unity_project_paths import resolve_unity_project


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def load_json(path: Path) -> dict:
    """读取 UTF-8 或 UTF-8-BOM JSON 文件。"""
    with path.open("r", encoding="utf-8-sig") as file:
        return json.load(file)


def write_json(path: Path, data: dict) -> None:
    """按统一格式写出 JSON 文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def strip_outer_brackets(name: str) -> str:
    """委托到共享模块。"""
    from name_utils import strip_outer_brackets as _so
    return _so(name)


def sanitize_name(name: str) -> str:
    """委托到共享模块。"""
    from name_utils import sanitize_name as _sn
    return _sn(name)


def normalize_unity_display_name(name: str) -> str:
    """委托到共享模块。"""
    from name_utils import normalize_unity_display_name as _nu
    return _nu(name)


def normalize_asset_dir(value: str) -> str:
    """规范化 Unity Assets 目录，确保以斜杠结尾。"""
    result = str(value or "").replace("\\", "/").rstrip("/")
    return f"{result}/" if result else ""


def normalize_asset_path(value: str) -> str:
    """规范化 Unity Assets 路径分隔符。"""
    return str(value or "").replace("\\", "/")


def md5_of_base64(value: str) -> str:
    """计算 base64 图片内容 MD5，失败时返回空字符串。"""
    if not value:
        return ""
    try:
        return hashlib.md5(base64.b64decode(value)).hexdigest()
    except (TypeError, ValueError):
        return ""


def unity_node_name(raw_name: str, is_root: bool, prefab_name: str) -> str:
    """委托到共享模块。"""
    from name_utils import unity_node_name as _un
    return _un(raw_name, is_root, prefab_name)


def bounds_rect(child_bounds: dict, parent_bounds: dict, rect_transform: dict | None = None) -> dict:
    """把 Figma bounds 转换为 Unity anchoredPosition + sizeDelta。"""
    return convert_figma_bounds_to_unity_rect(child_bounds, parent_bounds, rect_transform)


def centered_rect_transform() -> dict:
    return {
        "anchorMin": {"x": 0.5, "y": 0.5},
        "anchorMax": {"x": 0.5, "y": 0.5},
        "pivot": {"x": 0.5, "y": 0.5},
        "constraints": {
            "horizontal": "CENTER",
            "vertical": "CENTER",
        },
    }


def build_text_auto_size(font_size: int) -> dict:
    """生成 TMP AutoSize 区间；锁定字号避免 Unity 文本比 Figma 更小。"""
    safe_font_size = max(1, int(round(float(font_size or 24))))
    return {"min": safe_font_size, "max": safe_font_size}


def color_from_paints(paints: list, fallback_alpha: float = 1.0) -> dict | None:
    """从 Figma paint 列表取第一个可见纯色。"""
    for paint in paints or []:
        if paint.get("type") != "SOLID" or not paint.get("visible", True):
            continue
        color = paint.get("color", {})
        return {
            "r": float(color.get("r", 1) or 0),
            "g": float(color.get("g", 1) or 0),
            "b": float(color.get("b", 1) or 0),
            "a": float(paint.get("opacity", fallback_alpha) or fallback_alpha),
        }
    return None


def clamp(value: float, minimum: float, maximum: float) -> float:
    """委托到共享模块。"""
    from name_utils import clamp as _cl
    return _cl(value, minimum, maximum)


def color_hex(color: dict | None) -> str:
    """把 0-1 RGBA 颜色转成材质签名用十六进制。"""
    if not color:
        return "none"
    parts = []
    for key in ("r", "g", "b", "a"):
        default = 1 if key == "a" else 0
        value = clamp(float(color.get(key, default) or default), 0, 1)
        parts.append(int(round(value * 255)))
    return "".join(f"{value:02x}" for value in parts)


def build_text_material_spec(node: dict, font_size: int) -> dict | None:
    """根据 Figma 文本描边生成 TMP 材质需求。"""
    stroke_color = color_from_paints(node.get("strokes", []), 1)
    stroke_weight = float(node.get("strokeWeight", 0) or 0)
    if not stroke_color or stroke_weight <= 0 or font_size <= 0:
        return None
    outline_width = round(clamp(7.0 / 3.0 * stroke_weight / max(font_size, 1), 0, 1), 2)
    if outline_width <= 0.01:
        return None
    signature = f"o_{color_hex(stroke_color)}_w_{int(round(outline_width * 100)):03d}_u_none_x_100_y_100_s_000_d_000"
    return {
        "enabled": True,
        "signature": signature,
        "materialName": f"CommonFont_figma_{signature}",
        "outlineColor": stroke_color,
        "outlineWidth": outline_width,
        "underlayColor": {"r": 0, "g": 0, "b": 0, "a": 1},
        "underlayOffsetX": 0,
        "underlayOffsetY": 0,
        "underlaySoftness": 0,
        "underlayDilate": 0,
        "hasOutline": True,
        "hasUnderlay": False,
        "sourceStrokeWeight": stroke_weight,
    }


def text_alignment(node: dict) -> str:
    """把 Figma 文本对齐转换为生成器支持的 TMP 对齐名称。"""
    horizontal = str(node.get("textAlignHorizontal") or "CENTER").upper()
    vertical = str(node.get("textAlignVertical") or "CENTER").upper()
    prefix = "Top" if vertical == "TOP" else ("Bottom" if vertical == "BOTTOM" else "")
    suffix = "Left" if horizontal == "LEFT" else ("Right" if horizontal == "RIGHT" else "")
    if not prefix and not suffix:
        return "Center"
    return f"{prefix}{suffix}" or "Center"


def is_common_instance_name(name: str) -> bool:
    """判断实例名是否属于公共资源或公共 Prefab，不参与 feature-local 拆分。"""
    plain = strip_outer_brackets(name)
    return plain.startswith(("Common_Texture_", "Common_Prefab_", "Common_", "UI_Common_"))


def infer_group_name_from_instance(name: str) -> str:
    """从业务实例名兜底推断 ComponentSet 名称。"""
    plain = strip_outer_brackets(name)
    if is_common_instance_name(plain):
        return ""

    if re.match(r"^Day\d+_", plain):
        return "TabItem"

    if re.match(r"^TaskItem_\d+_", plain):
        return "Item"

    match = re.match(r"^(Milestone)_\d+_", plain)
    if match:
        return match.group(1)

    match = re.match(r"^([A-Za-z][A-Za-z0-9]*)_\d+_", plain)
    if match:
        return match.group(1)

    match = re.match(r"^([A-Za-z]+)\d+_", plain)
    if match:
        return match.group(1)

    return ""


def infer_group_name_from_component(node: dict) -> tuple[str, str]:
    """优先使用 MCP Relay 组件元数据推断 ComponentSet 名称，缺失时回退到命名规则。"""
    component = node.get("component") if isinstance(node.get("component"), dict) else {}
    raw_name = str(node.get("name") or "")

    for key in ("componentSetName", "mainComponentSetName"):
        value = strip_outer_brackets(str(component.get(key) or ""))
        if value and not is_common_instance_name(value):
            return sanitize_name(value), "mcp-relay-component-metadata"

    fallback = infer_group_name_from_instance(raw_name)
    return fallback, "name-pattern" if fallback else ""


def infer_variant_state_key(variant_name: str) -> str:
    """从业务实例名提取状态后缀，用于合并同状态变体。"""
    plain = strip_outer_brackets(variant_name)
    if "_" not in plain:
        return plain
    return plain.rsplit("_", 1)[-1] or plain


def variant_sort_key(nodes: list[dict]) -> dict[str, tuple[float, float, str]]:
    """根据变体分布自动选择横向或纵向排序键。"""
    if not nodes:
        return {}
    xs = [float(node.get("bounds", {}).get("x", 0) or 0) for node in nodes]
    ys = [float(node.get("bounds", {}).get("y", 0) or 0) for node in nodes]
    horizontal = (max(xs) - min(xs)) >= (max(ys) - min(ys))
    result = {}
    for node in nodes:
        bounds = node.get("bounds", {})
        x = float(bounds.get("x", 0) or 0)
        y = float(bounds.get("y", 0) or 0)
        name = strip_outer_brackets(node.get("name", ""))
        result[node["id"]] = (x, y, name) if horizontal else (y, x, name)
    return result


class ComponentSetSpecBuilder:
    """把 manifest 子树转换为 feature-local ComponentSet Prefab Spec。"""

    def __init__(self, nodes: list[dict], exports: list[dict], target_image_dir: str) -> None:
        """初始化索引、导出记录和九宫数据。"""
        self.nodes = nodes
        self.node_map = {node["id"]: node for node in nodes}
        self.children_map = {node["id"]: list(node.get("childIds", [])) for node in nodes}
        self.parent_map = {child_id: node["id"] for node in nodes for child_id in node.get("childIds", [])}
        self.export_by_node: dict[str, list[dict]] = defaultdict(list)
        self.export_by_hash: dict[str, list[dict]] = defaultdict(list)
        for item in exports:
            self.export_by_node[str(item.get("nodeId") or "")].append(item)
            if item.get("imageHash"):
                self.export_by_hash[str(item.get("imageHash"))].append(item)
        self.target_image_dir = normalize_asset_dir(target_image_dir)
        self.sliced_data: dict[str, dict] = {}
        self.simple_image_source_node: dict[str, str] = {}
        self.skip_ids: set[str] = set()
        self._detect_sliced_nodes()

    def _collect_descendants(self, node_id: str, output: set[str]) -> None:
        """递归收集某节点全部后代。"""
        for child_id in self.children_map.get(node_id, []):
            if child_id in output:
                continue
            output.add(child_id)
            self._collect_descendants(child_id, output)

    def _detect_sliced_nodes(self) -> None:
        """识别九宫容器，并标记运行时不应生成的切片叶子。"""
        for node in self.nodes:
            if node.get("type") != "FRAME":
                continue
            slices = {}
            for child_id in self.children_map.get(node["id"], []):
                child = self.node_map.get(child_id)
                if child and str(child.get("name", "")).startswith("__slice_"):
                    slices[child["name"]] = child
                    self.skip_ids.add(child_id)
                    self._collect_descendants(child_id, self.skip_ids)
            if not slices:
                continue
            bounds = node.get("bounds", {})
            slice_type, border = detect_type_and_border(
                slices,
                float(bounds.get("width", 0) or 0),
                float(bounds.get("height", 0) or 0),
            )
            if slice_type and border:
                if self._should_keep_slice_frame_as_simple_image(node, slice_type, border):
                    self.simple_image_source_node[node["id"]] = node["id"]
                    continue
                self.sliced_data[node["id"]] = {"type": slice_type, "border": border}

    def has_instance_ancestor(self, node_id: str) -> bool:
        """判断节点是否嵌在另一个 INSTANCE 内，避免误拆公共内部实例。"""
        current = self.parent_map.get(node_id)
        while current:
            parent = self.node_map.get(current)
            if parent and parent.get("type") == "INSTANCE":
                return True
            current = self.parent_map.get(current)
        return False

    def _best_export_for_node(self, node_id: str) -> dict:
        """为图片节点选择最可靠的导出记录（只查节点自身，不递归子节点）。
        递归子节点会把无图的 FRAME 容器（如 ComponentSet 变体）误判为 Image。"""
        for item in self.export_by_node.get(node_id, []):
            if item.get("base64") or item.get("imageHash"):
                return item
        return {}

    def _fallback_export_by_hash(self, export_item: dict) -> dict:
        """在同 hash 导出里寻找带 base64 的代表记录。"""
        if export_item.get("base64"):
            return export_item
        image_hash = export_item.get("imageHash")
        if not image_hash:
            return export_item
        for candidate in self.export_by_hash.get(str(image_hash), []):
            if candidate.get("base64"):
                return candidate
        return export_item

    def _node_has_visual_export(self, node_id: str) -> bool:
        """判断节点或子节点是否有可复用的图片导出。"""
        export_item = self._best_export_for_node(node_id)
        return bool(export_item.get("imageHash") or export_item.get("base64"))

    def _should_keep_slice_frame_as_simple_image(self, node: dict, slice_type: str, border: dict | None) -> bool:
        """Keep already-composited h3/v3 frames as Simple images."""
        if slice_type != "h3slice":
            return False
        node_id = str(node.get("id") or "")
        export_item = self._fallback_export_by_hash(self._best_export_for_node(node_id))
        bounds = node.get("bounds", {})
        display_width = int(round(float(bounds.get("width", 0) or 0)))
        display_height = int(round(float(bounds.get("height", 0) or 0)))
        fixed_width = int((border or {}).get("left", 0) or 0) + int((border or {}).get("right", 0) or 0)

        if not export_item:
            return False

        width = int(float(export_item.get("width") or 0))
        height = int(float(export_item.get("height") or 0))

        # 计算期望的九宫源图尺寸
        # h3slice: left + 2 + right, height
        expected_src_width = int((border or {}).get("left", 0) or 0) + 2 + int((border or {}).get("right", 0) or 0)
        expected_src_height = display_height

        # 如果导出图尺寸等于九宫源图尺寸，说明是源图，应该作为九宫处理
        if width == expected_src_width and height == expected_src_height:
            return False

        # 如果导出图尺寸等于显示尺寸，说明是已合成图，作为 Simple 处理
        if width >= display_width and height >= display_height:
            return True

        return False

    def _image_file_name(self, node: dict, is_sliced: bool) -> str:
        """按 process_images.py 规则生成图片文件名。"""
        raw_name = str(node.get("name") or "Node")
        if is_sliced:
            file_base = sanitize_name(raw_name.replace("__slice", ""))
            if not file_base.endswith("_jiugong"):
                file_base = f"{file_base}_jiugong"
            return f"{file_base}.png"
        return f"{sanitize_name(raw_name)}.png"

    def _append_node(self, state: dict, node: dict) -> int:
        """追加 spec 节点并返回索引。"""
        index = len(state["nodes"])
        state["nodes"].append(node)
        return index

    def _rect_transform_for_node(self, node: dict) -> dict:
        """读取 Figma constraints 并转换为 Unity RectTransform metadata。"""
        return figma_constraints_to_rect_transform_spec(node.get("constraints") or {})

    def _register_image(self, state: dict, node: dict, is_sliced: bool, border: dict | None) -> str:
        """注册 ImageSpec，并返回当前 spec 内的 imageId。"""
        unity_border = {
            "l": int((border or {}).get("left", 0) or 0),
            "b": int((border or {}).get("bottom", 0) or 0),
            "r": int((border or {}).get("right", 0) or 0),
            "t": int((border or {}).get("top", 0) or 0),
        }
        image_node = self.node_map.get(self.simple_image_source_node.get(str(node.get("id") or "")), node)
        source_file_name = self._image_file_name(node, is_sliced)
        export_item = self._fallback_export_by_hash(self._best_export_for_node(str(image_node.get("id") or "")))
        content_key = ""
        is_common_texture = strip_outer_brackets(str(node.get("name") or "")).startswith("Common_Texture_")
        if not is_sliced and not is_common_texture:
            content_key = str(export_item.get("imageHash") or md5_of_base64(str(export_item.get("base64") or "")) or image_node.get("id") or "")
        border_key = json.dumps(unity_border, sort_keys=True)
        dedupe_key = border_key if is_sliced else content_key
        key = (source_file_name, is_sliced, dedupe_key)
        if key in state["image_key_to_id"]:
            return state["image_key_to_id"][key]

        file_name = source_file_name
        variant_key = (source_file_name, is_sliced)
        variant_index = state["image_file_variant_counts"][variant_key]
        state["image_file_variant_counts"][variant_key] += 1
        force_variant_suffix = (not is_sliced) and str(node.get("id") or "") in self.simple_image_source_node
        if variant_index > 0 or force_variant_suffix:
            stem = Path(source_file_name).stem
            suffix = hashlib.md5(dedupe_key.encode("utf-8")).hexdigest()[:8]
            file_name = f"{stem}_{suffix}.png"

        image_id = f"img_{state['image_counter']}"
        state["image_counter"] += 1
        state["image_key_to_id"][key] = image_id

        state["images"].append({
            "id": image_id,
            "fileName": file_name,
            "targetDir": self.target_image_dir,
            "spriteSettingJson": json.dumps({
                "pivot": {"x": 0.5, "y": 0.5},
                "border": unity_border,
            }, ensure_ascii=False),
        })

        export_item = export_item if export_item else {}
        if is_sliced:
            expected_width = 0
            expected_height = 0
        elif str(node.get("id") or "") in self.simple_image_source_node:
            expected_width = int(export_item.get("width", 0) or 0)
            expected_height = int(export_item.get("height", 0) or 0)
        else:
            expected_width = int(export_item.get("width", 0) or 0)
            expected_height = int(export_item.get("height", 0) or 0)
        expected_md5 = "" if is_sliced else md5_of_base64(str(export_item.get("base64") or ""))
        state["plan_images"].append({
            "imageId": image_id,
            "fileName": file_name,
            "figmaNodeId": image_node.get("id", ""),
            "figmaNodePath": image_node.get("path", ""),
            "imageHash": export_item.get("imageHash", ""),
            "downloadUrl": export_item.get("downloadUrl", ""),
            "targetAssetPath": f"{self.target_image_dir}{file_name}",
            "expectedSize": {"x": expected_width, "y": expected_height},
            "expectedMD5": expected_md5,
            "imageType": "Sliced" if is_sliced else "Simple",
            "border": unity_border,
            "needsContentVerification": not bool(expected_md5),
        })
        return image_id

    def build_component_spec(
        self,
        group_name: str,
        variants: list[dict],
        prefab_path: str,
        bounds_variants: list[dict] | None = None,
    ) -> tuple[dict, list[dict]]:
        """生成一个 ComponentSet Prefab 的 spec。"""
        size_nodes = bounds_variants or variants
        max_width = max(float(node.get("bounds", {}).get("width", 0) or 0) for node in size_nodes)
        max_height = max(float(node.get("bounds", {}).get("height", 0) or 0) for node in size_nodes)
        state = {
            "nodes": [],
            "images": [],
            "plan_images": [],
            "image_key_to_id": {},
            "image_file_variant_counts": defaultdict(int),
            "image_counter": 0,
        }

        root_index = self._append_node(state, {
            "name": unity_node_name(group_name, True, group_name),
            "type": "Root",
            "rect": {"x": 0, "y": 0, "w": max_width, "h": max_height},
            "childIndices": [],
        })

        variant_indices = []
        for variant_node in variants:
            variant_name = strip_outer_brackets(variant_node.get("name", "Variant"))
            variant_bounds = variant_node.get("bounds", {})
            variant_index = self._append_node(state, {
                "name": f"[Variant_{variant_name}]",
                "type": "Panel",
                "rect": {
                    "x": 0,
                    "y": 0,
                    "w": float(variant_bounds.get("width", 0) or 0),
                    "h": float(variant_bounds.get("height", 0) or 0),
                },
                "rectTransform": centered_rect_transform(),
                "childIndices": [],
            })
            children = []
            for child_id in self.children_map.get(variant_node["id"], []):
                child_index = self._process_visual_node(state, child_id, variant_bounds)
                if child_index is not None:
                    children.append(child_index)
            state["nodes"][variant_index]["childIndices"] = children
            variant_indices.append(variant_index)

        state["nodes"][root_index]["childIndices"] = variant_indices

        # 如果有节点引用白像素，在 images 中加入白像素 ImageSpec
        has_white = any(n.get("imageId") == WHITE_PIXEL_IMAGE_ID for n in state["nodes"])
        if has_white and not any(i.get("id") == WHITE_PIXEL_IMAGE_ID for i in state["images"]):
            state["images"].insert(0, {
                "id": WHITE_PIXEL_IMAGE_ID,
                "fileName": WHITE_PIXEL_FILENAME,
                "targetDir": self.target_image_dir,
                "spriteSettingJson": json.dumps({"pivot": {"x": 0.5, "y": 0.5}, "border": {"l": 0, "b": 0, "r": 0, "t": 0}}),
            })

        return {
            "prefabName": group_name,
            "prefabPath": prefab_path,
            "rootSize": {"x": max_width, "y": max_height},
            "images": state["images"],
            "prefabInstances": [],
            "nodes": state["nodes"],
        }, state["plan_images"]

    def _process_visual_node(self, state: dict, node_id: str, parent_bounds: dict) -> int | None:
        """递归转换变体内部的可视节点。"""
        if node_id in self.skip_ids:
            return None
        node = self.node_map.get(node_id)
        if not node:
            return None

        raw_name = str(node.get("name") or "Node")
        plain_name = strip_outer_brackets(raw_name)
        node_type = node.get("type")
        bounds = node.get("bounds", {})
        children = [child_id for child_id in self.children_map.get(node_id, []) if child_id not in self.skip_ids]
        fields: dict = {}

        if node_type == "TEXT":
            spec_type = "Text"
            font_size = int(round(float(node.get("fontSize") or 24)))
            fields = {
                "text": node.get("characters", ""),
                "fontSize": font_size,
                "alignment": text_alignment(node),
                "color": color_from_paints(node.get("fills", []), float(node.get("opacity", 1) or 1)) or {"r": 1, "g": 1, "b": 1, "a": 1},
                "autoSize": build_text_auto_size(font_size),
            }
            material = build_text_material_spec(node, font_size)
            if material:
                fields["textMaterial"] = material
            children = []
        elif node_id in self.sliced_data:
            spec_type = "Image"
            border = self.sliced_data[node_id]["border"]
            fields = {
                "imageId": self._register_image(state, node, True, border),
                "imageType": "Sliced",
                "color": {"r": 1, "g": 1, "b": 1, "a": float(node.get("opacity", 1) or 1)},
            }
            children = []
        elif plain_name.startswith("Common_Texture_"):
            spec_type = "Image"
            fields = {
                "imageId": self._register_image(state, node, False, None),
                "imageType": "Simple",
                "color": {"r": 1, "g": 1, "b": 1, "a": float(node.get("opacity", 1) or 1)},
            }
            children = []
        elif node_type in ("RECTANGLE", "FRAME", "VECTOR", "INSTANCE", "BOOLEAN_OPERATION", "ELLIPSE") and self._node_has_visual_export(node_id):
            spec_type = "Image"
            # 纯色无效果节点 → 共享白像素 + color，不导出 PNG
            if node_type != "INSTANCE" and is_solid_only_no_effects(node):
                fields = {
                    "imageId": WHITE_PIXEL_IMAGE_ID,
                    "imageType": "Simple",
                    "color": get_solid_fill_color(node),
                }
            else:
                fields = {
                    "imageId": self._register_image(state, node, False, None),
                    "imageType": "Simple",
                    "color": {"r": 1, "g": 1, "b": 1, "a": float(node.get("opacity", 1) or 1)},
                }
            if node_type == "INSTANCE":
                children = []
        else:
            spec_type = "Panel"

        rect_transform = self._rect_transform_for_node(node)
        index = self._append_node(state, {
            "name": unity_node_name(raw_name, False, ""),
            "type": spec_type,
            "rect": bounds_rect(bounds, parent_bounds, rect_transform),
            "rectTransform": rect_transform,
            "childIndices": [],
            **fields,
        })

        child_indices = []
        for child_id in children:
            child_index = self._process_visual_node(state, child_id, bounds)
            if child_index is not None:
                child_indices.append(child_index)
        state["nodes"][index]["childIndices"] = child_indices
        return index


def find_component_groups(builder: ComponentSetSpecBuilder) -> tuple[list[dict], list[dict]]:
    """发现本节点内可拆分的 feature-local ComponentSet 候选。"""
    grouped: dict[str, list[dict]] = defaultdict(list)
    sources: dict[str, set[str]] = defaultdict(set)
    ignored: list[dict] = []

    for node in builder.nodes:
        if node.get("type") != "INSTANCE":
            continue
        plain_name = strip_outer_brackets(node.get("name", ""))
        if is_common_instance_name(plain_name):
            ignored.append({"nodeId": node["id"], "name": plain_name, "reason": "common-prefix"})
            continue
        if builder.has_instance_ancestor(node["id"]):
            ignored.append({"nodeId": node["id"], "name": plain_name, "reason": "nested-instance"})
            continue

        group_name, source = infer_group_name_from_component(node)
        if not group_name:
            ignored.append({"nodeId": node["id"], "name": plain_name, "reason": "no-componentset-signal"})
            continue
        grouped[group_name].append(node)
        sources[group_name].add(source)

    component_groups = []
    for group_name, nodes in sorted(grouped.items()):
        if len(nodes) < 2:
            for node in nodes:
                ignored.append({
                    "nodeId": node["id"],
                    "name": strip_outer_brackets(node.get("name", "")),
                    "reason": "single-instance-group",
                    "groupName": group_name,
                })
            continue

        parent_ids = {node.get("parentId", "") for node in nodes}
        source_set = sources.get(group_name, set())
        metadata_driven = any(source == "mcp-relay-component-metadata" for source in source_set)
        if len(parent_ids) > 1 and not metadata_driven:
            ignored.extend({
                "nodeId": node["id"],
                "name": strip_outer_brackets(node.get("name", "")),
                "reason": "multi-parent-name-pattern",
                "groupName": group_name,
            } for node in nodes)
            continue

        sort_keys = variant_sort_key(nodes)
        ordered_nodes = sorted(nodes, key=lambda item: sort_keys[item["id"]])
        representative_by_variant: dict[str, str] = {}
        state_key_by_variant: dict[str, str] = {}
        duplicate_mappings = []
        representative_nodes = list(ordered_nodes)
        for node in ordered_nodes:
            variant_name = strip_outer_brackets(node.get("name", ""))
            state_key = infer_variant_state_key(variant_name)
            state_key_by_variant[variant_name] = state_key
            representative_by_variant[variant_name] = variant_name

        component_groups.append({
            "name": group_name,
            "source": "mcp-relay-component-metadata" if metadata_driven else "name-pattern",
            "nodes": ordered_nodes,
            "representativeNodes": representative_nodes,
            "variantNames": [strip_outer_brackets(node.get("name", "")) for node in ordered_nodes],
            "representativeVariantNames": [
                strip_outer_brackets(node.get("name", "")) for node in representative_nodes
            ],
            "variantRepresentativeByName": representative_by_variant,
            "variantStateKeyByName": state_key_by_variant,
            "deduplicatedVariants": duplicate_mappings,
            "nodeIds": [node["id"] for node in ordered_nodes],
            "representativeNodeIds": [node["id"] for node in representative_nodes],
            "parentIds": sorted(parent_ids),
        })

    return component_groups, ignored


def merge_download_plans(main_plan: dict, component_plan_items: list[dict]) -> dict:
    """合并主 spec 和 ComponentSet spec 的图片计划，按目标文件去重。"""
    merged = []
    by_key: dict[tuple[str, str, str], int] = {}
    all_items = list(main_plan.get("images") or []) + list(component_plan_items)
    for item in all_items:
        border_key = json.dumps(item.get("border") or {}, sort_keys=True)
        key = (str(item.get("targetAssetPath") or ""), str(item.get("imageType") or ""), border_key)
        if key in by_key:
            old_index = by_key[key]
            old_item = merged[old_index]
            if not old_item.get("expectedMD5") and item.get("expectedMD5"):
                merged[old_index] = item
            continue
        by_key[key] = len(merged)
        merged.append(item)
    return {"images": merged}


def prune_unused_main_images(spec: dict, plan: dict) -> tuple[dict, dict]:
    """删除主 spec 中被 ComponentSet 替换后不再引用的图片。"""
    used_image_ids = {
        str(node.get("imageId"))
        for node in spec.get("nodes", [])
        if node.get("type") == "Image" and node.get("imageId")
    }
    spec["images"] = [
        image for image in spec.get("images", [])
        if str(image.get("id")) in used_image_ids
    ]
    plan["images"] = [
        item for item in plan.get("images", [])
        if str(item.get("imageId")) in used_image_ids
    ]
    return spec, plan


def rewrite_main_spec_with_component_sets(
    spec: dict,
    groups: list[dict],
    target_dir: str,
) -> tuple[dict, list[dict], list[dict]]:
    """把主 spec 中的业务实例改写为 PrefabInstance。"""
    target_dir = normalize_asset_path(target_dir).rstrip("/")
    nodes_by_plain: dict[str, list[dict]] = defaultdict(list)
    for index, node in enumerate(spec.get("nodes", [])):
        nodes_by_plain[strip_outer_brackets(node.get("name", ""))].append({"index": index, "node": node})

    prefab_refs = list(spec.get("prefabInstances") or [])
    prefab_ref_by_id = {str(item.get("id") or ""): item for item in prefab_refs}
    blocking_errors = []
    expected_instances = []

    for group in groups:
        group_name = group["name"]
        prefab_id = f"prefab_{sanitize_name(group_name)}"
        source_prefab_path = f"{target_dir}/{sanitize_name(group_name)}.prefab"
        if prefab_id not in prefab_ref_by_id:
            prefab_ref_by_id[prefab_id] = {
                "id": prefab_id,
                "figmaName": group_name,
                "sourcePrefabPath": source_prefab_path,
            }
            prefab_refs.append(prefab_ref_by_id[prefab_id])

        for variant_name in group["variantNames"]:
            matches = nodes_by_plain.get(variant_name, [])
            if not matches:
                blocking_errors.append({
                    "code": "mainSpecVariantMissing",
                    "message": "主 spec 中缺少预期 ComponentSet 变体节点。",
                    "details": {"componentSet": group_name, "variantName": variant_name},
                })
                continue
            representative_variant_name = group.get("variantRepresentativeByName", {}).get(variant_name, variant_name)
            for match in matches:
                node = match["node"]
                rect = node.get("rect")
                rect_transform = node.get("rectTransform")
                node.clear()
                node.update({
                    "name": f"[{variant_name}]",
                    "type": "PrefabInstance",
                    "rect": rect,
                    "rectTransform": rect_transform,
                    "prefabId": prefab_id,
                    "activeVariant": f"Variant_{representative_variant_name}",
                    "childIndices": [],
                })
                expected_instances.append({
                    "name": variant_name,
                    "prefabId": prefab_id,
                    "sourcePrefabPath": source_prefab_path,
                    "activeVariant": f"Variant_{representative_variant_name}",
                    "variantRepresentative": representative_variant_name,
                })

    spec["prefabInstances"] = prefab_refs
    return spec, expected_instances, blocking_errors


def apply_auto_componentsets_to_data(
    *,
    manifest_dir: str | Path,
    spec: dict,
    download_plan: dict,
    component_spec_dir: str | Path,
    target_dir: str,
    target_image_dir: str,
    output_report: str | Path | None = None,
) -> tuple[dict, dict, dict]:
    """在内存中应用自动 ComponentSet 拆分，并写出 component specs/report。"""
    manifest_dir = Path(manifest_dir)
    component_spec_dir = Path(component_spec_dir)
    target_dir = normalize_asset_path(target_dir).rstrip("/")
    target_image_dir = normalize_asset_dir(target_image_dir)
    manifest = load_json(manifest_dir / "figma_node_manifest.json")
    export_manifest = load_json(manifest_dir / "image_export_manifest.json")

    builder = ComponentSetSpecBuilder(
        manifest.get("nodes", []),
        export_manifest.get("exports", []),
        target_image_dir,
    )
    groups, ignored = find_component_groups(builder)
    all_plan_images: list[dict] = []
    component_reports: list[dict] = []
    blocking_errors: list[dict] = []
    warnings: list[dict] = []

    component_spec_dir.mkdir(parents=True, exist_ok=True)
    for group in groups:
        group_name = sanitize_name(group["name"])
        prefab_path = f"{target_dir}/{group_name}.prefab"
        component_spec, plan_images = builder.build_component_spec(
            group_name,
            group.get("representativeNodes") or group["nodes"],
            prefab_path,
            bounds_variants=group["nodes"],
        )
        for item in plan_images:
            item["imageId"] = f"component_{group_name}_{item.get('imageId', '')}"
        spec_path = component_spec_dir / f"{group_name}.json"
        write_json(spec_path, component_spec)
        all_plan_images.extend(plan_images)
        component_reports.append({
            "componentSet": group_name,
            "source": group["source"],
            "specPath": str(spec_path).replace("\\", "/"),
            "unitySpecPath": unity_tmp_relative_path(spec_path),
            "prefabPath": prefab_path,
            "variants": group["variantNames"],
            "representativeVariants": group.get("representativeVariantNames", group["variantNames"]),
            "deduplicatedVariants": group.get("deduplicatedVariants", []),
            "nodeIds": group["nodeIds"],
            "representativeNodeIds": group.get("representativeNodeIds", group["nodeIds"]),
            "summary": summarize_spec(component_spec),
        })

    spec, expected_instances, rewrite_errors = rewrite_main_spec_with_component_sets(spec, groups, target_dir)
    blocking_errors.extend(rewrite_errors)
    spec, download_plan = prune_unused_main_images(spec, download_plan)
    download_plan = merge_download_plans(download_plan, all_plan_images)

    if ignored:
        warnings.append({
            "code": "componentSetCandidatesIgnored",
            "message": "部分 INSTANCE 未作为 feature-local ComponentSet 拆分。",
            "details": ignored,
        })

    report = {
        "allPass": not blocking_errors,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "summary": {
            "componentSetCount": len(component_reports),
            "expectedPrefabInstanceCount": len(expected_instances),
            "ignoredInstanceCount": len(ignored),
            "deduplicatedVariantCount": sum(
                len(group.get("deduplicatedVariants", [])) for group in groups
            ),
            "mcpRelayComponentMetadataCount": sum(
                1 for node in manifest.get("nodes", [])
                if isinstance(node.get("component"), dict) and node["component"].get("source")
            ),
        },
        "componentSets": component_reports,
        "expectedPrefabInstances": expected_instances,
        "artifacts": {
            "componentSpecDir": str(component_spec_dir).replace("\\", "/"),
        },
    }
    if output_report:
        write_json(Path(output_report), report)
    return spec, download_plan, report


def unity_tmp_relative_path(path: Path) -> str:
    """把 Unity 工程 .tmp 下的 spec 路径转为工程内相对路径。"""
    normalized = str(path).replace("\\", "/")
    marker = "/.tmp/"
    if marker in "/" + normalized:
        return ".tmp/" + ("/" + normalized).split(marker, 1)[1]
    return normalized


def summarize_spec(spec: dict) -> dict:
    """统计 spec 节点类型和关键数量。"""
    counts: dict[str, int] = defaultdict(int)
    for node in spec.get("nodes", []):
        counts[str(node.get("type") or "Unknown")] += 1
    return {
        "nodes": len(spec.get("nodes", [])),
        "images": len(spec.get("images", [])),
        "prefabInstances": len(spec.get("prefabInstances", [])),
        "typeCounts": dict(sorted(counts.items())),
    }


def infer_target_dir(spec: dict) -> str:
    """从主 Prefab 路径推断旁边 Prefab 的目标目录。"""
    prefab_path = normalize_asset_path(spec.get("prefabPath", ""))
    if "/" not in prefab_path:
        return "Assets"
    return prefab_path.rsplit("/", 1)[0]


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="自动识别 ComponentSet 并生成旁边 Prefab specs")
    parser.add_argument("--unity-project", default="", help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--manifest-dir", default=".tmp/figma-to-prefab", help="MCP Relay manifest 目录")
    parser.add_argument("--main-spec", default="", help="主 spec 路径")
    parser.add_argument("--download-plan", default="", help="图片计划路径")
    parser.add_argument("--component-spec-dir", default="", help="ComponentSet spec 输出目录")
    parser.add_argument("--target-dir", default="", help="旁边 Prefab 输出目录，默认从主 spec prefabPath 推断")
    parser.add_argument("--target-image-dir", required=True, help="本次图片输出目录")
    parser.add_argument("--output-main-spec", default="", help="改写后的主 spec 输出路径，默认覆盖 --main-spec")
    parser.add_argument("--output-plan", default="", help="合并后的图片计划输出路径，默认覆盖 --download-plan")
    parser.add_argument("--output-report", default="", help="结构化报告输出路径")
    args = parser.parse_args()

    try:
        unity_project = resolve_unity_project(args.unity_project)
    except RuntimeError as error:
        parser.error(str(error))
    os.environ["FIGMA_UNITY_PROJECT"] = str(unity_project)
    unity_tmp = unity_project / ".tmp"
    args.main_spec = args.main_spec or str(unity_tmp / "prefab_spec.json")
    args.download_plan = args.download_plan or str(unity_tmp / "image_download_plan.json")
    args.component_spec_dir = args.component_spec_dir or str(unity_tmp / "figma_component_specs")
    args.output_report = args.output_report or str(unity_tmp / "componentset_report.json")

    main_spec_path = Path(args.main_spec)
    plan_path = Path(args.download_plan)
    spec = load_json(main_spec_path)
    download_plan = load_json(plan_path)
    target_dir = args.target_dir or infer_target_dir(spec)
    output_main_spec = Path(args.output_main_spec or args.main_spec)
    output_plan = Path(args.output_plan or args.download_plan)

    spec, download_plan, report = apply_auto_componentsets_to_data(
        manifest_dir=args.manifest_dir,
        spec=spec,
        download_plan=download_plan,
        component_spec_dir=args.component_spec_dir,
        target_dir=target_dir,
        target_image_dir=args.target_image_dir,
        output_report=args.output_report,
    )
    write_json(output_main_spec, spec)
    write_json(output_plan, download_plan)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("allPass") else 2


if __name__ == "__main__":
    raise SystemExit(main())
