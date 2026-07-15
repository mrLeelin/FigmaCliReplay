#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""静态解析 Unity Prefab YAML 中的常用 UGUI 字段。"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path
import re
from typing import Any, Iterable


NUMBER_PATTERN = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
LINE_SPACE = r"[^\S\r\n]*"
HEADER_RE = re.compile(r"^--- !u!(?P<class_id>\d+) &(?P<file_id>-?\d+)", re.MULTILINE)
TYPE_NAME_RE = re.compile(r"^(?P<name>[A-Za-z0-9_]+):\s*$", re.MULTILINE)
REF_RE = re.compile(r"\{fileID:\s*(?P<file_id>-?\d+)(?:,\s*guid:\s*(?P<guid>[0-9a-fA-F]+),\s*type:\s*(?P<type>\d+))?\}")


@dataclass
class UnityDocument:
    """表示 Unity YAML 中的一个文档块。"""

    class_id: int
    file_id: int
    type_name: str
    raw: str
    fields: dict[str, Any] = field(default_factory=dict)


@dataclass
class UnityNode:
    """表示一个由 GameObject 和 RectTransform 组合出的 UGUI 节点。"""

    file_id: int
    name: str
    game_object_id: int | None = None
    rect_transform_id: int | None = None
    parent_rect_id: int | None = None
    child_rect_ids: list[int] = field(default_factory=list)
    components: list[int] = field(default_factory=list)
    active: bool = True
    rect: dict[str, Any] = field(default_factory=dict)
    component_docs: list[UnityDocument] = field(default_factory=list)


def load_unity_documents(path: str | Path) -> list[UnityDocument]:
    """从 Prefab 文件读取 Unity YAML 文档块。"""

    text = Path(path).read_text(encoding="utf-8-sig", errors="ignore")
    return parse_unity_documents(text)


def parse_unity_documents(text: str) -> list[UnityDocument]:
    """把 Unity YAML 文本切分为多个文档块。"""

    matches = list(HEADER_RE.finditer(text))
    documents: list[UnityDocument] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        raw = text[start:end].strip()
        body_start = match.end() - start
        body = raw[body_start:].lstrip()
        type_match = TYPE_NAME_RE.search(body)
        type_name = type_match.group("name") if type_match else f"Class{match.group('class_id')}"
        documents.append(
            UnityDocument(
                class_id=int(match.group("class_id")),
                file_id=int(match.group("file_id")),
                type_name=type_name,
                raw=raw,
                fields=extract_common_fields(raw),
            )
        )
    return documents


def extract_common_fields(raw: str) -> dict[str, Any]:
    """提取后续流程需要的 Unity 常用字段。"""

    fields: dict[str, Any] = {}
    fields["m_Name"] = extract_scalar(raw, "m_Name", "")
    fields["m_IsActive"] = int(extract_scalar(raw, "m_IsActive", "1") or "1")
    fields["m_GameObject"] = extract_file_id(raw, "m_GameObject")
    fields["m_Father"] = extract_file_id(raw, "m_Father")
    fields["m_Children"] = extract_file_id_list(raw, "m_Children")
    fields["m_Component"] = extract_component_list(raw)
    fields["m_AnchorMin"] = extract_vector2(raw, "m_AnchorMin")
    fields["m_AnchorMax"] = extract_vector2(raw, "m_AnchorMax")
    fields["m_AnchoredPosition"] = extract_vector2(raw, "m_AnchoredPosition")
    fields["m_SizeDelta"] = extract_vector2(raw, "m_SizeDelta")
    fields["m_Pivot"] = extract_vector2(raw, "m_Pivot")
    fields["m_LocalScale"] = extract_vector3(raw, "m_LocalScale", {"x": 1.0, "y": 1.0, "z": 1.0})
    fields["m_LocalRotation"] = extract_vector4(raw, "m_LocalRotation")
    fields["m_LocalEulerAnglesHint"] = extract_vector3(raw, "m_LocalEulerAnglesHint")
    fields["m_Sprite"] = extract_ref(raw, "m_Sprite")
    fields["m_Texture"] = extract_ref(raw, "m_Texture")
    fields["m_Type"] = extract_int(raw, "m_Type")
    fields["m_PreserveAspect"] = extract_bool(raw, "m_PreserveAspect")
    fields["m_FillAmount"] = extract_float(raw, "m_FillAmount")
    fields["m_FillCenter"] = extract_bool(raw, "m_FillCenter")
    fields["m_UVRect"] = extract_rect(raw, "m_UVRect")
    fields["m_FillRect"] = extract_ref(raw, "m_FillRect")
    fields["m_Direction"] = extract_int(raw, "m_Direction")
    fields["m_MinValue"] = extract_float(raw, "m_MinValue")
    fields["m_MaxValue"] = extract_float(raw, "m_MaxValue")
    fields["m_Value"] = extract_float(raw, "m_Value")
    fields["m_Text"] = extract_multiline_or_scalar(raw, "m_text", extract_scalar(raw, "m_Text", ""))
    fields["m_fontSize"] = extract_float(raw, "m_fontSize")
    fields["m_enableAutoSizing"] = extract_bool(raw, "m_enableAutoSizing")
    fields["m_fontSizeMin"] = extract_float(raw, "m_fontSizeMin")
    fields["m_fontSizeMax"] = extract_float(raw, "m_fontSizeMax")
    fields["m_fontStyle"] = extract_int(raw, "m_fontStyle")
    fields["m_HorizontalAlignment"] = extract_int(raw, "m_HorizontalAlignment")
    fields["m_VerticalAlignment"] = extract_int(raw, "m_VerticalAlignment")
    fields["m_textAlignment"] = extract_int(raw, "m_textAlignment")
    fields["m_enableWordWrapping"] = extract_bool(raw, "m_enableWordWrapping")
    fields["m_overflowMode"] = extract_int(raw, "m_overflowMode")
    fields["m_isRichText"] = extract_bool(raw, "m_isRichText")
    fields["m_Color"] = extract_color(raw, "m_Color")
    fields["m_fontColor"] = extract_color(raw, "m_fontColor")
    fields["m_outlineColor"] = extract_color(raw, "m_outlineColor")
    fields["m_sharedMaterial"] = extract_ref(raw, "m_sharedMaterial")
    fields["m_EditorClassIdentifier"] = extract_scalar(raw, "m_EditorClassIdentifier", "")
    fields["resourcePath"] = extract_scalar(raw, "resourcePath", "")
    # Canvas 组件字段 (class_id=223)
    fields["m_RenderMode"] = extract_int(raw, "m_RenderMode")
    # CanvasScaler 组件字段 (MonoBehaviour with m_EditorClassIdentifier)
    fields["m_UiScaleMode"] = extract_int(raw, "m_UiScaleMode")
    fields["m_ReferenceResolution"] = extract_vector2(raw, "m_ReferenceResolution")
    fields["m_ScreenMatchMode"] = extract_int(raw, "m_ScreenMatchMode")
    fields["m_MatchWidthOrHeight"] = extract_float(raw, "m_MatchWidthOrHeight")
    fields["m_PhysicalUnit"] = extract_int(raw, "m_PhysicalUnit")
    fields["m_FallbackScreenDPI"] = extract_float(raw, "m_FallbackScreenDPI")
    fields["m_DefaultSpriteDPI"] = extract_float(raw, "m_DefaultSpriteDPI")
    fields["m_DynamicPixelsPerUnit"] = extract_float(raw, "m_DynamicPixelsPerUnit")
    fields["m_PresetInfoIsWorld"] = extract_bool(raw, "m_PresetInfoIsWorld")
    # CanvasGroup fields. These affect visual opacity and input behavior.
    fields["m_Alpha"] = extract_float(raw, "m_Alpha")
    fields["m_Interactable"] = extract_bool(raw, "m_Interactable")
    fields["m_BlocksRaycasts"] = extract_bool(raw, "m_BlocksRaycasts")
    fields["m_IgnoreParentGroups"] = extract_bool(raw, "m_IgnoreParentGroups")
    return fields


def extract_scalar(raw: str, key: str, default: str = "") -> str:
    """读取单行标量字段。"""

    pattern = re.compile(rf"^{LINE_SPACE}{re.escape(key)}:{LINE_SPACE}(?P<value>.*)$", re.MULTILINE)
    match = pattern.search(raw)
    if not match:
        return default
    value = match.group("value").strip()
    if value in {"", "[]", "{}"}:
        return "" if value == "" else value
    return _unquote(value)


def extract_int(raw: str, key: str) -> int | None:
    """读取整数字段。"""

    value = extract_scalar(raw, key, "")
    if value == "":
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def extract_float(raw: str, key: str) -> float | None:
    """读取浮点字段。"""

    value = extract_scalar(raw, key, "")
    if value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def extract_bool(raw: str, key: str) -> bool | None:
    """读取 Unity 布尔字段，兼容 0/1 和 true/false。"""

    value = extract_scalar(raw, key, "")
    if value == "":
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes"}:
        return True
    if normalized in {"0", "false", "no"}:
        return False
    return None


def extract_file_id(raw: str, key: str) -> int | None:
    """读取 `{fileID: ...}` 引用中的 fileID。"""

    ref = extract_ref(raw, key)
    file_id = ref.get("fileID")
    return int(file_id) if isinstance(file_id, int) else None


def extract_ref(raw: str, key: str) -> dict[str, Any]:
    """读取 Unity 引用字段。支持跨行引用（type: N} 换行的情况）。"""

    line_match = re.search(rf"^{LINE_SPACE}{re.escape(key)}:{LINE_SPACE}(?P<value>.*)$", raw, re.MULTILINE)
    if not line_match:
        return {}
    value = line_match.group("value")
    # 当引用跨行时（行内有 '{' 但没有 '}'），拼接后续内容直到找到 '}'
    if "{" in value and "}" not in value:
        start = line_match.end()
        remaining = raw[start:]
        close_idx = remaining.find("}")
        if close_idx != -1:
            value = value + remaining[: close_idx + 1]
    ref_match = REF_RE.search(value)
    if not ref_match:
        return {}
    result: dict[str, Any] = {"fileID": int(ref_match.group("file_id"))}
    if ref_match.group("guid"):
        result["guid"] = ref_match.group("guid").lower()
    if ref_match.group("type"):
        result["type"] = int(ref_match.group("type"))
    return result


def extract_file_id_list(raw: str, key: str) -> list[int]:
    """读取 Unity 列表块中的 fileID 列表。"""

    block = _extract_block(raw, key)
    if not block:
        return []
    return [int(match.group("file_id")) for match in REF_RE.finditer("\n".join(block))]


def extract_component_list(raw: str) -> list[int]:
    """读取 GameObject.m_Component 中的组件 fileID 列表。"""

    return extract_file_id_list(raw, "m_Component")


def extract_vector2(raw: str, key: str, default: dict[str, float] | None = None) -> dict[str, float]:
    """读取 Unity Vector2 字段。"""

    base = {"x": 0.0, "y": 0.0}
    if default:
        base.update(default)
    base.update(_extract_inline_vector(raw, key, ("x", "y")))
    return base


def extract_vector3(raw: str, key: str, default: dict[str, float] | None = None) -> dict[str, float]:
    """读取 Unity Vector3 字段。"""

    base = {"x": 0.0, "y": 0.0, "z": 0.0}
    if default:
        base.update(default)
    base.update(_extract_inline_vector(raw, key, ("x", "y", "z")))
    return base


def extract_vector4(raw: str, key: str, default: dict[str, float] | None = None) -> dict[str, float]:
    """读取 Unity Vector4 或 Quaternion 字段。"""

    base = {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    if default:
        base.update(default)
    base.update(_extract_inline_vector(raw, key, ("x", "y", "z", "w")))
    return base


def extract_rect(raw: str, key: str) -> dict[str, float]:
    """Read a Unity Rect-like field with x/y/width/height."""

    rect = _extract_inline_vector(raw, key, ("x", "y", "width", "height"))
    if rect:
        return {
            "x": rect.get("x", 0.0),
            "y": rect.get("y", 0.0),
            "width": rect.get("width", 0.0),
            "height": rect.get("height", 0.0),
        }
    block = _extract_block(raw, key)
    result: dict[str, float] = {}
    for line in block:
        for name in ("x", "y", "width", "height"):
            match = re.match(rf"^\s*{name}:\s*(?P<number>{NUMBER_PATTERN})\s*$", line)
            if match:
                result[name] = float(match.group("number"))
    if not result:
        return {}
    return {
        "x": result.get("x", 0.0),
        "y": result.get("y", 0.0),
        "width": result.get("width", 0.0),
        "height": result.get("height", 0.0),
    }


def extract_color(raw: str, key: str) -> dict[str, float]:
    """读取 Unity Color 字段。"""

    color = {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}
    color.update(_extract_inline_vector(raw, key, ("r", "g", "b", "a")))
    return color


def extract_multiline_or_scalar(raw: str, key: str, default: str = "") -> str:
    """读取 TMP 常见的单行或块状文本字段。"""

    line_match = re.search(rf"^(?P<indent>{LINE_SPACE}){re.escape(key)}:{LINE_SPACE}(?P<value>.*)$", raw, re.MULTILINE)
    if not line_match:
        return default

    value = line_match.group("value")
    if value.strip() not in {"", "|", ">"}:
        return _unquote(value.strip())

    block = _extract_block(raw, key)
    if not block:
        return default
    stripped_lines = [line.strip() for line in block]
    return "\n".join(stripped_lines).rstrip("\n")


def build_node_tree(documents: Iterable[UnityDocument]) -> tuple[UnityNode | None, dict[int, UnityNode], list[str]]:
    """把 GameObject、RectTransform 和组件文档组合为 UGUI 节点树数据。"""

    docs = list(documents)
    docs_by_id = {doc.file_id: doc for doc in docs}
    game_docs = {doc.file_id: doc for doc in docs if doc.type_name == "GameObject"}
    rect_docs = {doc.file_id: doc for doc in docs if doc.type_name == "RectTransform"}
    warnings: list[str] = []
    nodes_by_rect_id: dict[int, UnityNode] = {}

    for rect_id, rect_doc in rect_docs.items():
        game_object_id = rect_doc.fields.get("m_GameObject")
        game_doc = game_docs.get(game_object_id)
        if game_doc is None:
            warnings.append(f"RectTransform {rect_id} missing GameObject {game_object_id}")
            continue

        components = list(game_doc.fields.get("m_Component") or [])
        component_docs = [
            docs_by_id[component_id]
            for component_id in components
            if component_id in docs_by_id and docs_by_id[component_id].type_name not in {"RectTransform", "GameObject"}
        ]
        nodes_by_rect_id[rect_id] = UnityNode(
            file_id=rect_id,
            name=game_doc.fields.get("m_Name") or "",
            game_object_id=game_object_id,
            rect_transform_id=rect_id,
            parent_rect_id=rect_doc.fields.get("m_Father"),
            child_rect_ids=list(rect_doc.fields.get("m_Children") or []),
            components=components,
            active=bool(game_doc.fields.get("m_IsActive", 1)),
            rect=rect_doc.fields,
            component_docs=component_docs,
        )

    root_candidates = [
        node
        for node in nodes_by_rect_id.values()
        if node.parent_rect_id in (None, 0) or node.parent_rect_id not in nodes_by_rect_id
    ]
    if not root_candidates:
        warnings.append("No root RectTransform found")
        return None, nodes_by_rect_id, warnings

    # 区分真根（parent=0）和伪根（parent 被 PrefabInstance 剥离）
    true_roots = [n for n in root_candidates if n.parent_rect_id in (None, 0)]
    pseudo_roots = [n for n in root_candidates if n not in true_roots]

    # 警告信息保持原有逻辑
    if len(root_candidates) > 1:
        all_ids = [node.file_id for node in root_candidates]
        if pseudo_roots:
            warnings.append(
                f"Multiple root RectTransforms found: {all_ids}. "
                f"True root selected; {len(pseudo_roots)} stripped root(s) skipped."
            )
        else:
            warnings.append(f"Multiple root RectTransforms found: {all_ids}")

    # 优先选真根；无真根时才回退到伪根排序
    if true_roots:
        true_roots.sort(key=lambda node: node.file_id)
        return true_roots[0], nodes_by_rect_id, warnings
    else:
        root_candidates.sort(key=lambda node: node.file_id)
        return root_candidates[0], nodes_by_rect_id, warnings


def _extract_inline_vector(raw: str, key: str, names: tuple[str, ...]) -> dict[str, float]:
    """读取 Unity 内联向量，例如 `{x: 1, y: 2}`。"""

    line_match = re.search(rf"^{LINE_SPACE}{re.escape(key)}:{LINE_SPACE}(?P<value>.*)$", raw, re.MULTILINE)
    if not line_match:
        return {}

    value = line_match.group("value")
    result: dict[str, float] = {}
    for name in names:
        match = re.search(rf"\b{name}:\s*(?P<number>{NUMBER_PATTERN})", value)
        if match:
            result[name] = float(match.group("number"))

    if result:
        return result

    block = _extract_block(raw, key)
    for line in block:
        for name in names:
            match = re.match(rf"^\s*{name}:\s*(?P<number>{NUMBER_PATTERN})\s*$", line)
            if match:
                result[name] = float(match.group("number"))
    return result


def _extract_block(raw: str, key: str) -> list[str]:
    """读取指定 key 下缩进更深的 YAML 子块。"""

    lines = raw.splitlines()
    for index, line in enumerate(lines):
        match = re.match(rf"^(?P<indent>\s*){re.escape(key)}:\s*(?P<tail>.*)$", line)
        if not match:
            continue
        base_indent = len(match.group("indent"))
        block: list[str] = []
        for child_line in lines[index + 1 :]:
            if not child_line.strip():
                block.append(child_line)
                continue
            child_indent = len(child_line) - len(child_line.lstrip())
            if child_indent < base_indent:
                break
            if child_indent == base_indent and not child_line.lstrip().startswith("- "):
                break
            block.append(child_line)
        return block
    return []


def _unquote(value: str) -> str:
    """去掉简单 YAML 字符串外层引号。"""

    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        try:
            decoded = ast.literal_eval(value)
        except (SyntaxError, ValueError):
            return value[1:-1]
        return decoded if isinstance(decoded, str) else str(decoded)
    return value


def _self_test() -> None:
    """运行 unity_yaml 的最小自测。"""

    sample = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  m_Name: Root
  m_IsActive: 1
--- !u!224 &20
RectTransform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
  m_Children:
  - {fileID: 30}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 100, y: 50}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 30}
  m_Name: Child
  m_IsActive: 1
--- !u!224 &30
RectTransform:
  m_GameObject: {fileID: 11}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 10, y: 5}
  m_Pivot: {x: 0.5, y: 0.5}
"""
    docs = parse_unity_documents(sample)
    root, nodes, warnings = build_node_tree(docs)
    assert root is not None
    assert root.name == "Root"
    assert nodes[20].rect["m_SizeDelta"] == {"x": 100.0, "y": 50.0}
    assert root.components == [20]
    assert root.child_rect_ids == [30]
    assert nodes[30].name == "Child"
    assert not warnings

    tmp = """--- !u!114 &40
MonoBehaviour:
  m_Name:
  m_EditorClassIdentifier:
  m_Material: {fileID: 0}
  m_text: "\\u7FA4\\u7EC4"
  m_fontSize: 65
  m_enableAutoSizing: 1
  m_fontSizeMin: 18
  m_fontSizeMax: 72
  m_fontStyle: 0
  m_HorizontalAlignment: 2
  m_VerticalAlignment: 512
  m_textAlignment: 65535
  m_enableWordWrapping: 0
  m_overflowMode: 0
  m_isRichText: 1
"""
    tmp_doc = parse_unity_documents(tmp)[0]
    assert tmp_doc.fields["m_EditorClassIdentifier"] == ""
    assert tmp_doc.fields["m_Text"] == "群组"
    assert tmp_doc.fields["m_fontSize"] == 65.0
    assert tmp_doc.fields["m_enableAutoSizing"] is True
    assert tmp_doc.fields["m_fontSizeMin"] == 18.0
    assert tmp_doc.fields["m_fontSizeMax"] == 72.0
    assert tmp_doc.fields["m_HorizontalAlignment"] == 2
    assert tmp_doc.fields["m_enableWordWrapping"] is False
    assert tmp_doc.fields["m_isRichText"] is True

    raw_image = """--- !u!114 &50
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.RawImage
  m_UVRect:
    serializedVersion: 2
    x: 0.25
    y: 0.5
    width: 0.75
    height: 0.5
  m_Color: {r: 1, g: 0.5, b: 0.25, a: 0.8}
"""
    raw_image_doc = parse_unity_documents(raw_image)[0]
    assert raw_image_doc.fields["m_UVRect"] == {"x": 0.25, "y": 0.5, "width": 0.75, "height": 0.5}
    assert raw_image_doc.fields["m_Color"] == {"r": 1.0, "g": 0.5, "b": 0.25, "a": 0.8}

    canvas_group = """--- !u!225 &60
CanvasGroup:
  m_GameObject: {fileID: 10}
  m_Alpha: 0.42
  m_Interactable: 0
  m_BlocksRaycasts: 1
  m_IgnoreParentGroups: 0
"""
    canvas_group_doc = parse_unity_documents(canvas_group)[0]
    assert canvas_group_doc.fields["m_Alpha"] == 0.42
    assert canvas_group_doc.fields["m_Interactable"] is False
    assert canvas_group_doc.fields["m_BlocksRaycasts"] is True
    assert canvas_group_doc.fields["m_IgnoreParentGroups"] is False


if __name__ == "__main__":
    _self_test()
    print("unity_yaml self-test passed")
