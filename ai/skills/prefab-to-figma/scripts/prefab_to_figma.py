#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""将 UGUI Prefab 静态解析为 Figma 导入中间数据。"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, is_dataclass
import copy
import json
from pathlib import Path
import re
import sys
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
FIGMA_TO_PREFAB_SCRIPTS = SCRIPT_DIR.parents[1] / "figma-to-prefab" / "scripts"
if str(FIGMA_TO_PREFAB_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(FIGMA_TO_PREFAB_SCRIPTS))

from asset_resolver import SpriteAsset, build_guid_index, resolve_sprite  # noqa: E402
from nine_slice import build_nine_slice, has_border  # noqa: E402
from rect_transform import Rect, resolve_rect  # noqa: E402
from unity_yaml import NUMBER_PATTERN, UnityDocument, UnityNode, build_node_tree, extract_common_fields, extract_ref, load_unity_documents, parse_unity_documents  # noqa: E402
from unity_project_paths import normalize_asset_path, resolve_unity_project  # noqa: E402


AUDIT_REPORT_FILE_NAME = "prefab_export_audit_report.json"

IMAGE_TYPES = {
    0: "Simple",
    1: "Sliced",
    2: "Tiled",
    3: "Filled",
}

IMAGE_CLASS_MARKERS = (
    "UnityEngine.UI.Image",
    "CustomImage",
    "SlicedFilledImage",
)

TEXT_CLASS_MARKERS = (
    "TextMeshProUGUI",
    "UnityEngine.UI.Text",
)

TMP_MATERIAL_COMMON_FONT_PREFIX = "CommonFont_"
UNITY_HORIZONTAL_LAYOUT_GROUP_GUID = "30649d3a9faa99c48a7b1166b86bf2a0"
UNITY_VERTICAL_LAYOUT_GROUP_GUID = "59f8146938fff824cb5fd77236b75775"
UNITY_GRID_LAYOUT_GROUP_GUID = "8a8695521f0d02e499659fee002a26c2"
UNITY_CONTENT_SIZE_FITTER_GUID = "3245ec927659c4140ac4f8d17403cc18"

LAYOUT_GROUP_MARKERS = (
    "HorizontalLayoutGroup",
    "VerticalLayoutGroup",
    "GridLayoutGroup",
)

CLIP_CLASS_MARKERS = (
    "UnityEngine.UI.Mask",
    "UnityEngine.UI.RectMask2D",
    "RectMask2D",
)

CANVAS_GROUP_CLASS_MARKERS = (
    "CanvasGroup",
)

STRICT_WARNING_MARKERS = (
    "Image component has no sprite guid",
    "Sprite guid not found in index",
    "Sprite asset does not exist",
    "Sprite asset is not PNG",
    "Sprite meta does not exist",
    "Unable to parse sprite meta",
    "Unable to read PNG size",
)

UNSUPPORTED_CLASS_MARKERS = (
    "Animator",
    "MMF_Player",
    "UIParticle",
    "Particle",
    "ContentSizeFitter",
)


def parse_canvas(value: str) -> tuple[float, float] | None:
    """解析 `宽x高` Canvas 尺寸，`auto` 表示稍后从根 RectTransform 推导。"""

    normalized = value.lower().replace("*", "x").replace("×", "x")
    if normalized in {"auto", "root", "root-size"}:
        return None
    parts = [part.strip() for part in normalized.split("x") if part.strip()]
    if len(parts) != 2:
        raise ValueError(f"Canvas size must be WIDTHxHEIGHT, got: {value}")
    width = float(parts[0])
    height = float(parts[1])
    if width <= 0 or height <= 0:
        raise ValueError(f"Canvas size must be positive, got: {value}")
    return width, height


def export_prefab(project_root: Path, prefab_path: Path, canvas: tuple[float, float] | None, out_dir: Path) -> dict[str, Any]:
    """解析 Prefab 文件并写出 JSON 与报告。"""

    documents = load_unity_documents(prefab_path)
    # 检测 Prefab Variant 并展开
    guid_index_root = _select_guid_index_root(project_root, prefab_path)
    guid_index = build_guid_index(guid_index_root)
    documents = _expand_variant_if_needed(documents, project_root, guid_index)
    resolved_canvas = _resolve_export_canvas(documents, canvas)
    prefab_relative = _relative_path(prefab_path, project_root)
    meta_path_to_guid = _build_meta_path_to_guid_index(guid_index)
    package = build_package(
        project_root=project_root,
        prefab_path=prefab_relative,
        documents=documents,
        canvas=resolved_canvas,
        guid_index=guid_index,
        meta_path_to_guid=meta_path_to_guid,
    )
    attach_nested_prefab_packages(
        package=package,
        project_root=project_root,
        canvas=resolved_canvas,
        guid_index=guid_index,
        meta_path_to_guid=meta_path_to_guid,
    )
    write_outputs(package, out_dir)
    return package


def attach_nested_prefab_packages(
    package: dict[str, Any],
    project_root: Path,
    canvas: tuple[float, float],
    guid_index: dict[str, Path],
    meta_path_to_guid: dict[str, str] | None = None,
    max_depth: int = 4,
) -> None:
    """递归解析嵌套 Prefab，供 Figma 写入阶段自动创建缺失组件。"""

    package["nestedPrefabPackages"] = _collect_nested_prefab_packages(
        package=package,
        project_root=project_root,
        canvas=canvas,
        guid_index=guid_index,
        meta_path_to_guid=meta_path_to_guid if meta_path_to_guid is not None else _build_meta_path_to_guid_index(guid_index),
        material_cache={},
        visited={str(package.get("prefabGuid") or "").lower()},
        depth=0,
        max_depth=max_depth,
    )


def _collect_nested_prefab_packages(
    package: dict[str, Any],
    project_root: Path,
    canvas: tuple[float, float],
    guid_index: dict[str, Path],
    meta_path_to_guid: dict[str, str],
    material_cache: dict[str, dict[str, Any] | None],
    visited: set[str],
    depth: int,
    max_depth: int,
) -> dict[str, Any]:
    """收集当前包直接和间接引用的子 Prefab 包，按 GUID 去重。"""

    if depth >= max_depth:
        return {}

    nested: dict[str, Any] = {}
    for item in package.get("prefabInstances") or []:
        source_prefab = item.get("sourcePrefab") or {}
        source_guid = str(source_prefab.get("guid") or "").lower()
        source_path = str(source_prefab.get("assetPath") or "")
        if source_prefab.get("isUguiPrefab") is False:
            continue
        if not source_guid or source_guid in visited or not source_path:
            continue
        prefab_file = (project_root / source_path).resolve()
        if not prefab_file.exists():
            continue

        child_documents = load_unity_documents(prefab_file)
        child_documents = _expand_variant_if_needed(child_documents, project_root, guid_index)
        if not _documents_have_root_rect_transform(child_documents):
            continue
        child_documents = _apply_prefab_instance_document_overrides(child_documents, item)
        try:
            child_canvas = _resolve_export_canvas(child_documents, None)
        except ValueError:
            continue
        child_relative = _relative_path(prefab_file, project_root)
        child_package = build_package(
            project_root=project_root,
            prefab_path=child_relative,
            documents=child_documents,
            canvas=child_canvas,
            guid_index=guid_index,
            meta_path_to_guid=meta_path_to_guid,
            material_cache=material_cache,
        )
        variant_key = _prefab_instance_variant_key(item)
        if variant_key:
            child_package["prefabVariantKey"] = variant_key
            child_package["prefabVariantOfGuid"] = source_guid
            child_package["prefabVariantOfPath"] = source_path
        next_visited = set(visited)
        next_visited.add(variant_key or source_guid)
        child_package["nestedPrefabPackages"] = _collect_nested_prefab_packages(
            package=child_package,
            project_root=project_root,
            canvas=child_canvas or canvas,
            guid_index=guid_index,
            meta_path_to_guid=meta_path_to_guid,
            material_cache=material_cache,
            visited=next_visited,
            depth=depth + 1,
            max_depth=max_depth,
        )
        nested[variant_key or source_guid] = child_package
    return nested


def _apply_prefab_instance_document_overrides(
    documents: list[UnityDocument],
    prefab_instance: dict[str, Any],
) -> list[UnityDocument]:
    """把 PrefabInstance 的非根覆盖应用到子 Prefab 文档，生成可截图比对的实例状态。"""

    override = prefab_instance.get("instanceOverride") or {}
    modifications = override.get("modifications") or []
    if not modifications:
        return documents
    root_rect_id = _safe_int(override.get("sourceRectFileId"), 0)
    instance_name = str(override.get("name") or "")
    filtered: list[dict[str, Any]] = []
    for mod in modifications:
        property_path = str(mod.get("propertyPath") or "")
        file_id = _safe_int(mod.get("fileID"), 0)
        if property_path == "m_Name" and instance_name:
            continue
        if root_rect_id and file_id == root_rect_id and _is_rect_transform_property_path(property_path):
            continue
        filtered.append(mod)
    if not filtered:
        return documents
    updated_documents = _apply_modifications(documents, filtered)
    return _apply_known_prefab_runtime_overrides(updated_documents)


def _is_rect_transform_property_path(property_path: str) -> bool:
    """判断 PrefabInstance override 是否只是根 RectTransform 几何字段。"""

    return property_path.startswith((
        "m_AnchoredPosition.",
        "m_SizeDelta.",
        "m_AnchorMin.",
        "m_AnchorMax.",
        "m_Pivot.",
        "m_LocalPosition.",
        "m_LocalRotation.",
        "m_LocalScale.",
        "m_LocalEulerAnglesHint.",
    ))


def _prefab_instance_variant_key(prefab_instance: dict[str, Any]) -> str:
    """为带复杂覆盖的 PrefabInstance 生成稳定 key，避免复用默认子组件状态。"""

    override = prefab_instance.get("instanceOverride") or {}
    modifications = override.get("modifications") or []
    source_guid = str((prefab_instance.get("sourcePrefab") or {}).get("guid") or "").lower()
    file_id = str(prefab_instance.get("fileId") or "")
    if not source_guid or not _prefab_instance_has_complex_override(prefab_instance):
        return ""
    return f"{source_guid}__override_{file_id}"


def _prefab_instance_has_complex_override(prefab_instance: dict[str, Any]) -> bool:
    """判断实例是否包含会改变子 Prefab 内部视觉状态的覆盖。"""

    override = prefab_instance.get("instanceOverride") or {}
    root_rect_id = _safe_int(override.get("sourceRectFileId"), 0)
    for mod in override.get("modifications") or []:
        property_path = str(mod.get("propertyPath") or "")
        file_id = _safe_int(mod.get("fileID"), 0)
        if property_path == "m_Name":
            continue
        if root_rect_id and file_id == root_rect_id and _is_rect_transform_property_path(property_path):
            continue
        return True
    return False


def _expand_variant_if_needed(
    documents: list[UnityDocument],
    project_root: Path,
    guid_index: dict[str, Path],
) -> list[UnityDocument]:
    """检测 Prefab Variant 并展开为完整文档列表。如果不是 Variant 则原样返回。"""

    # Variant 特征：只有一个 PrefabInstance 文档（class_id=1001），没有 RectTransform
    prefab_instance = None
    has_rect = False
    for doc in documents:
        if doc.class_id == 1001:
            prefab_instance = doc
        if doc.type_name == "RectTransform":
            has_rect = True
    if prefab_instance is None or has_rect:
        return documents  # 不是 Variant 或已有节点数据

    # 从 PrefabInstance 中提取 m_SourcePrefab GUID
    source_ref = extract_ref(prefab_instance.raw, "m_SourcePrefab")
    source_guid = (source_ref.get("guid") or "").lower()
    if not source_guid:
        return documents

    # 通过 GUID 索引找到 Base Prefab 路径
    base_meta_path = guid_index.get(source_guid)
    if not base_meta_path:
        return documents
    base_path = Path(str(base_meta_path)[:-5]) if str(base_meta_path).endswith(".meta") else base_meta_path
    if not base_path.exists():
        return documents

    # 加载 Base Prefab 文档
    base_documents = load_unity_documents(base_path)

    # 解析 m_Modifications 并应用到 Base 文档
    modifications = _parse_variant_modifications(prefab_instance.raw)
    if modifications:
        base_documents = _apply_modifications(base_documents, modifications)

    return base_documents


def _parse_variant_modifications(raw: str) -> list[dict[str, Any]]:
    """从 PrefabInstance raw YAML 中解析 m_Modifications 列表。"""

    mods: list[dict[str, Any]] = []
    # 匹配每个 modification 块（objectReference 可能跨行）
    mod_pattern = re.compile(
        r"-\s+target:\s*\{fileID:\s*(-?\d+),\s*guid:\s*([0-9a-fA-F]+).*?\}\s*\n"
        r"\s+propertyPath:\s*(.+?)\s*\n"
        r"\s+value:\s*(.*?)\s*\n"
        r"\s+objectReference:\s*(\{[^}]*\})",
        re.MULTILINE | re.DOTALL,
    )
    for m in mod_pattern.finditer(raw):
        file_id = int(m.group(1))
        prop_path = m.group(3).strip()
        value = m.group(4).strip()
        # 清理 objectReference 中的换行和多余空格
        obj_ref_str = re.sub(r"\s+", " ", m.group(5).strip())
        mods.append({
            "fileID": file_id,
            "propertyPath": prop_path,
            "value": value,
            "objectReference": obj_ref_str,
        })
    return mods


def _apply_modifications(
    documents: list[UnityDocument],
    modifications: list[dict[str, Any]],
) -> list[UnityDocument]:
    """将 Variant 的 property overrides 应用到 Base 文档列表中。"""

    mods_by_id: dict[int, list[dict[str, Any]]] = {}
    for mod in modifications:
        fid = mod["fileID"]
        if fid not in mods_by_id:
            mods_by_id[fid] = []
        mods_by_id[fid].append(mod)

    result: list[UnityDocument] = []
    for doc in documents:
        if doc.file_id not in mods_by_id:
            result.append(doc)
            continue
        raw = doc.raw
        for mod in mods_by_id[doc.file_id]:
            raw = _apply_single_modification(raw, mod)
        new_doc = UnityDocument(
            class_id=doc.class_id,
            file_id=doc.file_id,
            type_name=doc.type_name,
            raw=raw,
            fields=extract_common_fields(raw),
        )
        result.append(new_doc)
    return result


def _apply_known_prefab_runtime_overrides(documents: list[UnityDocument]) -> list[UnityDocument]:
    """同步已知子窗口脚本在打开时会立即写入的静态可还原 UI 字段。"""

    modifications: list[dict[str, Any]] = []
    for doc in documents:
        day = _extract_layout_int(doc.raw, "day", 0)
        if day <= 0:
            continue
        select_day_text = extract_ref(doc.raw, "selectDayText")
        select_day_text_id = _safe_int(select_day_text.get("fileID"), 0)
        if select_day_text_id:
            modifications.append({
                "fileID": select_day_text_id,
                "propertyPath": "m_text",
                "value": str(day),
                "objectReference": "{fileID: 0}",
            })
        lock_go = extract_ref(doc.raw, "lockGo")
        lock_go_id = _safe_int(lock_go.get("fileID"), 0)
        if lock_go_id:
            modifications.append({
                "fileID": lock_go_id,
                "propertyPath": "m_IsActive",
                "value": "1" if day > 1 else "0",
                "objectReference": "{fileID: 0}",
            })
    if not modifications:
        return documents
    return _apply_modifications(documents, modifications)


def _apply_single_modification(raw: str, mod: dict[str, Any]) -> str:
    """将单个 property override 应用到文档 raw YAML 中。"""

    prop_path = mod["propertyPath"]
    value = mod["value"]
    obj_ref = mod["objectReference"]

    parts = prop_path.split(".")
    if len(parts) == 2:
        field_name, sub_key = parts
        pattern = re.compile(
            rf"(\s+{re.escape(field_name)}:\s*\{{[^}}]*\b{re.escape(sub_key)}:\s*)([^\s,}}]+)",
            re.MULTILINE,
        )
        match = pattern.search(raw)
        if match:
            raw = raw[:match.start(2)] + value + raw[match.end(2):]
    elif len(parts) == 1:
        field_name = parts[0]
        if obj_ref and obj_ref != "{fileID: 0}":
            # objectReference 覆盖：替换整个 {fileID: ..., guid: ..., type: ...} 引用
            pattern = re.compile(
                rf"(\s+{re.escape(field_name)}:\s*)\{{[^}}]*\}}",
                re.MULTILINE,
            )
            match = pattern.search(raw)
            if match:
                raw = raw[:match.end(1)] + obj_ref + raw[match.end()]
        elif value:
            # 简单标量值覆盖
            pattern = re.compile(
                rf"(\s+{re.escape(field_name)}:\s*)(.+)",
                re.MULTILINE,
            )
            match = pattern.search(raw)
            if match:
                raw = raw[:match.start(2)] + value + raw[match.end(2):]
    return raw


def _read_prefab_meta_guid(project_root: Path, prefab_path: str) -> str:
    """读取 Prefab .meta 文件的 GUID，供组件化匹配使用。"""
    meta_path = (project_root / prefab_path).with_suffix(".prefab.meta")
    try:
        for line in meta_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("guid:"):
                return line.split(":", 1)[1].strip()
    except (OSError, UnicodeDecodeError):
        pass
    return ""


def build_package(
    project_root: Path,
    prefab_path: str,
    documents: list[UnityDocument],
    canvas: tuple[float, float],
    guid_index: dict[str, Path] | None = None,
    material_cache: dict[str, dict[str, Any] | None] | None = None,
    meta_path_to_guid: dict[str, str] | None = None,
) -> dict[str, Any]:
    """从 Unity YAML 文档构建 Figma 导入中间包。"""

    documents = _apply_known_prefab_runtime_overrides(documents)
    root_node, nodes_by_rect_id, tree_warnings = build_node_tree(documents)
    _apply_slider_fill_rect_runtime_layout(nodes_by_rect_id)
    _apply_static_layout_groups(nodes_by_rect_id)
    warnings = list(tree_warnings)
    fatal_errors: list[str] = []
    canvas_width, canvas_height = canvas
    assets: dict[str, Any] = {}
    flat_nodes: list[dict[str, Any]] = []
    material_cache = material_cache if material_cache is not None else {}
    meta_path_to_guid = meta_path_to_guid if meta_path_to_guid is not None else _build_meta_path_to_guid_index(guid_index or {})
    prefab_instances = _collect_prefab_instances(
        documents,
        project_root,
        guid_index or {},
        canvas_width,
        canvas_height,
        nodes_by_rect_id,
        warnings,
    )
    stats = {
        "nodeCount": 0,
        "imageCount": 0,
        "textCount": 0,
        "nineSliceCount": 0,
        "clipCount": 0,
        "canvasGroupCount": 0,
        "prefabInstanceCount": len(prefab_instances),
        "unsupportedCount": 0,
    }
    if prefab_instances:
        warnings.append(_build_prefab_instance_warning(prefab_instances))

    if root_node is None:
        fatal_errors.append("No root node parsed from Prefab")
        root_export: dict[str, Any] = {}
        visual_bounds: dict[str, int | float] = {}
    else:
        root_export = _export_node(
            node=root_node,
            nodes_by_rect_id=nodes_by_rect_id,
            parent_path="",
            parent_width=canvas_width,
            parent_height=canvas_height,
            project_root=project_root,
            guid_index=guid_index or {},
            meta_path_to_guid=meta_path_to_guid,
            material_cache=material_cache,
            assets=assets,
            warnings=warnings,
            flat_nodes=flat_nodes,
            stats=stats,
        )
        visual_bounds = _calculate_visual_bounds(root_export)

    # 确定 Canvas 尺寸来源
    canvas_source = "rootRectTransform.sizeDelta"
    for doc in documents:
        if doc.type_name == "MonoBehaviour":
            class_id = doc.fields.get("m_EditorClassIdentifier", "")
            if "CanvasScaler" in class_id:
                ref_res = doc.fields.get("m_ReferenceResolution")
                if ref_res:
                    w = abs(float(ref_res.get("x", 0.0)))
                    h = abs(float(ref_res.get("y", 0.0)))
                    if w > 0.0 and h > 0.0:
                        canvas_source = "canvasScaler.referenceResolution"
                        break
    if canvas_source == "rootRectTransform.sizeDelta" and root_node is not None:
        root_size = _node_rect_size(root_node)
        if root_size["width"] <= 0.0 or root_size["height"] <= 0.0:
            canvas_source = "firstPositiveChildRectTransform.sizeDelta"

    return {
        "version": 1,
        "prefabPath": prefab_path,
        "prefabGuid": _read_prefab_meta_guid(project_root, prefab_path),
        "canvas": {"width": _number(canvas_width), "height": _number(canvas_height), "source": canvas_source},
        "root": root_export,
        "nodes": flat_nodes,
        "assets": assets,
        "prefabInstances": prefab_instances,
        "visualBounds": visual_bounds,
        "warnings": warnings,
        "fatalErrors": fatal_errors,
        "stats": stats,
    }


def write_outputs(package: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    """写出 JSON、Markdown 与统一审核报告。"""

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "prefab-to-figma.json").write_text(
        json.dumps(package, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out_dir / "report.md").write_text(build_report(package), encoding="utf-8")
    audit_report = build_export_audit_report(package, out_dir)
    (out_dir / AUDIT_REPORT_FILE_NAME).write_text(
        json.dumps(audit_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return audit_report


def build_report(package: dict[str, Any]) -> str:
    """生成导入报告。"""

    stats = package.get("stats", {})
    warnings = package.get("warnings", [])
    fatal_errors = package.get("fatalErrors", [])
    canvas = package.get("canvas", {})
    lines = [
        "# Prefab To Figma Report",
        "",
        f"- Prefab: `{package.get('prefabPath', '')}`",
        f"- Canvas: `{canvas.get('width')}x{canvas.get('height')}`",
        f"- Visual bounds: `{_format_bounds(package.get('visualBounds', {}))}`",
        f"- Nodes: `{stats.get('nodeCount', 0)}`",
        f"- Images: `{stats.get('imageCount', 0)}`",
        f"- Texts: `{stats.get('textCount', 0)}`",
        f"- Nine-slice: `{stats.get('nineSliceCount', 0)}`",
        f"- Clip nodes: `{stats.get('clipCount', 0)}`",
        f"- Prefab instances: `{stats.get('prefabInstanceCount', 0)}`",
        f"- Unsupported: `{stats.get('unsupportedCount', 0)}`",
        "",
        "## Warnings",
        "",
    ]
    if warnings:
        lines.extend(f"- {warning}" for warning in warnings)
    else:
        lines.append("- None")
    lines.extend(["", "## Fatal Errors", ""])
    if fatal_errors:
        lines.extend(f"- {fatal_error}" for fatal_error in fatal_errors)
    else:
        lines.append("- None")
    return "\n".join(lines) + "\n"


def make_check(pass_state: bool, summary: dict[str, Any] | None = None, details: Any = None) -> dict[str, Any]:
    """创建统一审核检查项，供 LLM 直接读取判断。"""

    return {
        "pass": bool(pass_state),
        "summary": summary or {},
        "details": details or [],
    }


def build_export_audit_report(package: dict[str, Any], out_dir: Path | str | None = None) -> dict[str, Any]:
    """生成 Prefab 解析阶段的结构化审核报告。"""

    out_path = Path(out_dir) if out_dir else None
    stats = package.get("stats") or {}
    warnings = list(package.get("warnings") or [])
    fatal_errors = list(package.get("fatalErrors") or [])
    prefab_instances = list(package.get("prefabInstances") or [])
    nodes = list(package.get("nodes") or [])
    assets = package.get("assets") or {}
    visual_bounds = package.get("visualBounds") or {}
    root_node = package.get("root") or {}
    blocking_reasons = _audit_blocking_reasons(package)

    checks = {
        "requiredPackageKeys": make_check(
            all(key in package for key in ("root", "nodes", "warnings", "stats", "visualBounds")),
            {
                "hasRoot": "root" in package,
                "hasNodes": "nodes" in package,
                "hasWarnings": "warnings" in package,
                "hasStats": "stats" in package,
                "hasVisualBounds": "visualBounds" in package,
            },
        ),
        "rootParsed": make_check(
            bool(root_node) and not fatal_errors,
            {"rootName": root_node.get("name", ""), "fatalErrorCount": len(fatal_errors)},
            fatal_errors,
        ),
        "statsConsistent": _build_stats_consistency_check(package),
        "strictBlockingWarnings": make_check(
            len(blocking_reasons) == 0,
            {"blockingReasonCount": len(blocking_reasons)},
            blocking_reasons,
        ),
        "prefabInstancesResolvedByWriter": make_check(
            all((item.get("sourcePrefab") or {}).get("guid") for item in prefab_instances),
            {"prefabInstanceCount": len(prefab_instances)},
            [
                item for item in prefab_instances
                if not (item.get("sourcePrefab") or {}).get("guid")
            ],
        ),
        "spriteAssetsResolved": _build_sprite_asset_check(nodes, assets),
        "visualBoundsValid": make_check(
            _is_valid_visual_bounds(visual_bounds),
            {"visualBounds": visual_bounds},
            [] if _is_valid_visual_bounds(visual_bounds) else [{"reason": "invalid_visual_bounds", "value": visual_bounds}],
        ),
    }

    blocking_errors = []
    for check_name, check_result in checks.items():
        if check_result.get("pass"):
            continue
        blocking_errors.append({
            "code": check_name,
            "message": f"{check_name} 检查失败",
            "details": check_result.get("details", []),
        })

    warning_items = _build_audit_warnings(warnings, prefab_instances)
    artifacts = {
        "packagePath": str(out_path / "prefab-to-figma.json") if out_path else "",
        "markdownReportPath": str(out_path / "report.md") if out_path else "",
        "auditReportPath": str(out_path / AUDIT_REPORT_FILE_NAME) if out_path else "",
    }

    return {
        "allPass": len(blocking_errors) == 0,
        "blockingErrors": blocking_errors,
        "warnings": warning_items,
        "summary": {
            "prefabPath": package.get("prefabPath", ""),
            "canvas": package.get("canvas", {}),
            "visualBounds": visual_bounds,
            "nodeCount": stats.get("nodeCount", 0),
            "imageCount": stats.get("imageCount", 0),
            "textCount": stats.get("textCount", 0),
            "nineSliceCount": stats.get("nineSliceCount", 0),
            "clipCount": stats.get("clipCount", 0),
            "prefabInstanceCount": stats.get("prefabInstanceCount", 0),
            "unsupportedCount": stats.get("unsupportedCount", 0),
            "assetCount": len(assets),
            "warningCount": len(warnings),
            "fatalErrorCount": len(fatal_errors),
        },
        "checks": checks,
        "artifacts": artifacts,
    }


def _build_stats_consistency_check(package: dict[str, Any]) -> dict[str, Any]:
    """校验统计字段和实际节点列表是否一致。"""

    stats = package.get("stats") or {}
    nodes = package.get("nodes") or []
    actual = {
        "nodeCount": len(nodes),
        "imageCount": sum(1 for node in nodes if node.get("image")),
        "textCount": sum(1 for node in nodes if node.get("text")),
        "nineSliceCount": sum(1 for node in nodes if (node.get("image") or {}).get("mode") == "nine-slice"),
        "clipCount": sum(1 for node in nodes if node.get("clip")),
        "prefabInstanceCount": len(package.get("prefabInstances") or []),
        "unsupportedCount": sum(len(node.get("unsupported") or []) for node in nodes),
    }
    mismatches = []
    for key, actual_value in actual.items():
        expected_value = stats.get(key, 0)
        if expected_value != actual_value:
            mismatches.append({
                "field": key,
                "statsValue": expected_value,
                "actualValue": actual_value,
            })
    return make_check(len(mismatches) == 0, actual, mismatches)


def _audit_blocking_reasons(package: dict[str, Any]) -> list[str]:
    """收集解析阶段真正阻塞后续计划生成的问题，不把可计划处理的 PrefabInstance 当阻塞。"""

    reasons = list(package.get("fatalErrors") or [])
    stripped_rect_ids = _collect_stripped_prefab_rect_ids(package)
    for warning in package.get("warnings") or []:
        if "PrefabInstance documents detected" in warning:
            continue
        if _is_stripped_prefab_missing_child_warning(warning, stripped_rect_ids):
            continue
        if _is_inactive_image_sprite_warning(warning, package):
            continue
        if _is_missing_sprite_placeholder_warning(warning, package):
            continue
        if any(marker in warning for marker in STRICT_WARNING_MARKERS):
            reasons.append(warning)
    return reasons


def _is_inactive_image_sprite_warning(warning: str, package: dict[str, Any]) -> bool:
    """判断 Sprite 缺失警告是否只来自 inactive 图片节点。"""

    if warning.startswith("Inactive image sprite guid not found in index on "):
        return True
    match = re.search(r"Sprite guid not found in index:\s*([0-9a-fA-F]+)", warning)
    if not match:
        return False
    guid = match.group(1).lower()
    active_has_guid = False
    inactive_has_guid = False
    for node in package.get("nodes") or []:
        image = node.get("image") or {}
        if str(image.get("guid", "")).lower() != guid:
            continue
        if node.get("active") is False:
            inactive_has_guid = True
        else:
            active_has_guid = True
    return inactive_has_guid and not active_has_guid


def _is_missing_sprite_placeholder_warning(warning: str, package: dict[str, Any]) -> bool:
    """Return True when a missing sprite warning is represented by an explicit placeholder node."""

    for node in package.get("nodes") or []:
        image = node.get("image") or {}
        if image.get("missingSprite") and warning == image.get("missingReason"):
            return True

    match = re.search(r"Sprite guid not found in index:\s*([0-9a-fA-F]+)", warning)
    if not match:
        return False
    guid = match.group(1).lower()
    for node in package.get("nodes") or []:
        image = node.get("image") or {}
        if str(image.get("guid", "")).lower() == guid and image.get("missingSprite"):
            return True
    return False


def _collect_stripped_prefab_rect_ids(package: dict[str, Any]) -> set[str]:
    """收集嵌套 PrefabInstance stripped RectTransform 的 fileID，用于审计阶段区分真实缺失。"""

    stripped_rect_ids: set[str] = set()
    for item in package.get("prefabInstances") or []:
        stripped_rect_ids.update(str(rect_id) for rect_id in item.get("strippedRectTransformIds") or [])
    return stripped_rect_ids


def _is_stripped_prefab_missing_child_warning(warning: str, stripped_rect_ids: set[str]) -> bool:
    """判断 Missing child RectTransform 是否来自嵌套 Prefab 的 stripped 节点。"""

    if "Missing child RectTransform" not in warning:
        return False
    match = re.search(r"Missing child RectTransform\s+(-?\d+)", warning)
    return bool(match and match.group(1) in stripped_rect_ids)


def _build_sprite_asset_check(nodes: list[dict[str, Any]], assets: dict[str, Any]) -> dict[str, Any]:
    """校验图片节点引用的 Sprite 资源是否已解析。"""

    missing_assets = []
    image_nodes = [node for node in nodes if node.get("image")]
    active_image_nodes = [node for node in image_nodes if node.get("active") is not False]
    for node in active_image_nodes:
        image = node.get("image") or {}
        if image.get("missingSprite"):
            continue
        asset_key = image.get("asset")
        if not asset_key:
            missing_assets.append({
                "nodePath": node.get("path", ""),
                "nodeName": node.get("name", ""),
                "reason": "missing_asset_key",
                "guid": image.get("guid", ""),
            })
            continue
        if asset_key not in assets:
            missing_assets.append({
                "nodePath": node.get("path", ""),
                "nodeName": node.get("name", ""),
                "reason": "asset_not_in_package",
                "asset": asset_key,
            })
    return make_check(
        len(missing_assets) == 0,
        {
            "imageNodeCount": len(image_nodes),
            "activeImageNodeCount": len(active_image_nodes),
            "inactiveImageNodeCount": len(image_nodes) - len(active_image_nodes),
            "assetCount": len(assets),
        },
        missing_assets,
    )


def _apply_slider_fill_rect_runtime_layout(nodes_by_rect_id: dict[int, UnityNode]) -> None:
    """模拟 Unity Slider.UpdateVisuals 对 FillRect 锚点的运行态修正。"""

    if not nodes_by_rect_id:
        return
    for node in nodes_by_rect_id.values():
        slider = _find_slider_component(node)
        if not slider:
            continue
        fill_rect_id = _safe_int((slider.fields.get("m_FillRect") or {}).get("fileID"), 0)
        fill_node = nodes_by_rect_id.get(fill_rect_id)
        if fill_node is None:
            continue
        anchor_min, anchor_max = _resolve_slider_fill_anchors(slider, fill_node)
        fill_node.rect["m_AnchorMin"] = anchor_min
        fill_node.rect["m_AnchorMax"] = anchor_max


def _apply_static_layout_groups(nodes_by_rect_id: dict[int, UnityNode]) -> None:
    """Resolve static Horizontal/Vertical LayoutGroup children before export."""

    if not nodes_by_rect_id:
        return
    depths = {rect_id: _node_depth(node, nodes_by_rect_id) for rect_id, node in nodes_by_rect_id.items()}
    for _, node in sorted(nodes_by_rect_id.items(), key=lambda item: depths.get(item[0], 0), reverse=True):
        layout = _find_layout_group(node)
        if not layout:
            continue
        fitter = _find_content_size_fitter(node)
        if fitter:
            _apply_content_size_fitter(node, layout, fitter, nodes_by_rect_id)
        parent_size = _node_rect_size(node)
        if parent_size["width"] <= 0.0 and parent_size["height"] <= 0.0:
            continue
        _resolve_layout_group_children(node, layout, nodes_by_rect_id, parent_size)


def _node_depth(node: UnityNode, nodes_by_rect_id: dict[int, UnityNode]) -> int:
    depth = 0
    parent_id = node.parent_rect_id
    seen: set[int] = set()
    while parent_id and parent_id in nodes_by_rect_id and parent_id not in seen:
        seen.add(parent_id)
        depth += 1
        parent_id = nodes_by_rect_id[parent_id].parent_rect_id
    return depth


def _node_rect_size(node: UnityNode) -> dict[str, float]:
    size_delta = node.rect.get("m_SizeDelta") if isinstance(node.rect, dict) else {}
    return {
        "width": max(_safe_float((size_delta or {}).get("x"), 0.0), 0.0),
        "height": max(_safe_float((size_delta or {}).get("y"), 0.0), 0.0),
    }


def _find_layout_group(node: UnityNode) -> UnityDocument | None:
    for component in node.component_docs:
        class_id = _component_class(component)
        if any(marker in class_id for marker in LAYOUT_GROUP_MARKERS):
            return component
        if _is_horizontal_layout_group(component) or _is_vertical_layout_group(component) or _is_grid_layout_group(component):
            return component
    return None


def _find_content_size_fitter(node: UnityNode) -> UnityDocument | None:
    for component in node.component_docs:
        if "ContentSizeFitter" in _component_class(component) or _is_content_size_fitter(component):
            return component
    return None


def _resolve_layout_group_children(
    parent_node: UnityNode,
    layout: UnityDocument,
    nodes_by_rect_id: dict[int, UnityNode],
    parent_size: dict[str, float],
) -> None:
    class_id = _component_class(layout)
    if "GridLayoutGroup" in class_id or _is_grid_layout_group(layout):
        _resolve_grid_layout_group_children(parent_node, layout, nodes_by_rect_id, parent_size)
        return
    axis = "horizontal" if "HorizontalLayoutGroup" in class_id else "vertical"
    entries = _build_node_layout_entries(parent_node, nodes_by_rect_id)
    if not entries:
        return
    reverse = _extract_layout_bool(layout.raw, "m_ReverseArrangement", False)
    if reverse:
        entries = list(reversed(entries))
    padding = _extract_layout_padding(layout.raw)
    spacing = _extract_layout_float(layout.raw, "m_Spacing", 0.0)
    child_alignment = _extract_layout_int(layout.raw, "m_ChildAlignment", 0)
    control_width = _extract_layout_bool(layout.raw, "m_ChildControlWidth", False)
    control_height = _extract_layout_bool(layout.raw, "m_ChildControlHeight", False)
    force_expand_width = _extract_layout_bool(layout.raw, "m_ChildForceExpandWidth", False)
    force_expand_height = _extract_layout_bool(layout.raw, "m_ChildForceExpandHeight", False)

    parent_width = max(float(parent_size.get("width", 0.0)), 0.0)
    parent_height = max(float(parent_size.get("height", 0.0)), 0.0)
    inner_width = max(parent_width - padding["left"] - padding["right"], 0.0)
    inner_height = max(parent_height - padding["top"] - padding["bottom"], 0.0)
    horizontal_group = _layout_horizontal_group(child_alignment)
    vertical_group = _layout_vertical_group(child_alignment)

    if axis == "horizontal":
        total_preferred = sum(entry["width"] for entry in entries)
        total_spacing = spacing * max(len(entries) - 1, 0)
        total_with_spacing = total_preferred + total_spacing
        flexible_count = len(entries) if force_expand_width else 0
        expand = max(inner_width - total_with_spacing, 0.0) / flexible_count if flexible_count else 0.0
        x = padding["left"] if flexible_count else padding["left"] + _layout_alignment_offset(inner_width, total_with_spacing, horizontal_group)
        for entry in entries:
            cell_width = entry["width"] + expand
            width = cell_width if control_width else entry["width"]
            height = inner_height if control_height else entry["height"]
            item_x = x if control_width else x + _layout_alignment_offset(cell_width, width, horizontal_group)
            item_y = padding["top"] + _layout_alignment_offset(inner_height, height, vertical_group)
            _assign_node_layout_rect(entry["node"], item_x, item_y, width, height, parent_width, parent_height)
            x += cell_width + spacing
    else:
        total_preferred = sum(entry["height"] for entry in entries)
        total_spacing = spacing * max(len(entries) - 1, 0)
        total_with_spacing = total_preferred + total_spacing
        flexible_count = len(entries) if force_expand_height else 0
        expand = max(inner_height - total_with_spacing, 0.0) / flexible_count if flexible_count else 0.0
        y = padding["top"] if flexible_count else padding["top"] + _layout_alignment_offset(inner_height, total_with_spacing, vertical_group)
        for entry in entries:
            cell_height = entry["height"] + expand
            width = inner_width if control_width else entry["width"]
            height = cell_height if control_height else entry["height"]
            item_x = padding["left"] + _layout_alignment_offset(inner_width, width, horizontal_group)
            item_y = y if control_height else y + _layout_alignment_offset(cell_height, height, vertical_group)
            _assign_node_layout_rect(entry["node"], item_x, item_y, width, height, parent_width, parent_height)
            y += cell_height + spacing


def _build_node_layout_entries(parent_node: UnityNode, nodes_by_rect_id: dict[int, UnityNode]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for child_id in parent_node.child_rect_ids:
        child = nodes_by_rect_id.get(child_id)
        if child is None or not child.active or _node_ignores_layout(child):
            continue
        entries.append(_build_node_layout_entry(child))
    return entries


def _build_node_layout_entry(node: UnityNode) -> dict[str, Any]:
    size = _node_rect_size(node)
    preferred_width = size["width"]
    preferred_height = size["height"]
    min_width = preferred_width
    min_height = preferred_height
    flexible_width = 0.0
    flexible_height = 0.0
    for component in node.component_docs:
        if "LayoutElement" not in _component_class(component):
            continue
        if not _extract_layout_bool(component.raw, "m_Enabled", True):
            continue
        min_width = _layout_element_dimension(component, "m_MinWidth", min_width)
        min_height = _layout_element_dimension(component, "m_MinHeight", min_height)
        preferred_width = _layout_element_dimension(component, "m_PreferredWidth", preferred_width)
        preferred_height = _layout_element_dimension(component, "m_PreferredHeight", preferred_height)
        flexible_width = max(_layout_element_dimension(component, "m_FlexibleWidth", flexible_width), 0.0)
        flexible_height = max(_layout_element_dimension(component, "m_FlexibleHeight", flexible_height), 0.0)
    return {
        "node": node,
        "width": max(preferred_width, min_width, 0.0),
        "height": max(preferred_height, min_height, 0.0),
        "flexibleWidth": flexible_width,
        "flexibleHeight": flexible_height,
    }


def _layout_element_dimension(component: UnityDocument, key: str, fallback: float) -> float:
    value = _extract_layout_float(component.raw, key, -1.0)
    return fallback if value < 0.0 else value


def _node_ignores_layout(node: UnityNode) -> bool:
    for component in node.component_docs:
        if "LayoutElement" in _component_class(component):
            return _extract_layout_bool(component.raw, "m_IgnoreLayout", False)
    return False


def _assign_node_layout_rect(
    node: UnityNode,
    x: float,
    y: float,
    width: float,
    height: float,
    parent_width: float,
    parent_height: float,
) -> None:
    _set_rect_size(node.rect, width=width, height=height)
    _set_rect_anchored_position(node.rect, x=x + width * 0.5 - parent_width * 0.5, y=parent_height * 0.5 - y - height * 0.5)


def _apply_content_size_fitter(
    node: UnityNode,
    layout: UnityDocument,
    fitter: UnityDocument,
    nodes_by_rect_id: dict[int, UnityNode],
) -> None:
    horizontal_fit = _extract_layout_int(fitter.raw, "m_HorizontalFit", 0)
    vertical_fit = _extract_layout_int(fitter.raw, "m_VerticalFit", 0)
    if horizontal_fit == 0 and vertical_fit == 0:
        return
    preferred = _layout_group_preferred_size(node, layout, nodes_by_rect_id)
    _set_rect_size(
        node.rect,
        width=preferred["width"] if horizontal_fit else None,
        height=preferred["height"] if vertical_fit else None,
    )


def _resolve_grid_layout_group_children(
    parent_node: UnityNode,
    layout: UnityDocument,
    nodes_by_rect_id: dict[int, UnityNode],
    parent_size: dict[str, float],
) -> None:
    entries = _build_node_layout_entries(parent_node, nodes_by_rect_id)
    if not entries:
        return
    parent_width = max(float(parent_size.get("width", 0.0)), 0.0)
    parent_height = max(float(parent_size.get("height", 0.0)), 0.0)
    positions = _calculate_grid_layout_positions(
        count=len(entries),
        layout=layout,
        parent_width=parent_width,
        parent_height=parent_height,
    )
    cell_size = _extract_grid_cell_size(layout)
    for entry, position in zip(entries, positions):
        _assign_node_layout_rect(
            entry["node"],
            position["x"],
            position["y"],
            cell_size["width"],
            cell_size["height"],
            parent_width,
            parent_height,
        )


def _layout_group_preferred_size(
    node: UnityNode,
    layout: UnityDocument,
    nodes_by_rect_id: dict[int, UnityNode],
) -> dict[str, float]:
    entries = _build_node_layout_entries(node, nodes_by_rect_id)
    padding = _extract_layout_padding(layout.raw)
    spacing = _extract_layout_float(layout.raw, "m_Spacing", 0.0)
    class_id = _component_class(layout)
    if "GridLayoutGroup" in class_id or _is_grid_layout_group(layout):
        cell_size = _extract_grid_cell_size(layout)
        grid_spacing = _extract_grid_spacing(layout)
        columns, rows = _grid_constraint_counts(layout, len(entries))
        return {
            "width": padding["left"] + padding["right"] + columns * cell_size["width"] + max(columns - 1, 0) * grid_spacing["x"],
            "height": padding["top"] + padding["bottom"] + rows * cell_size["height"] + max(rows - 1, 0) * grid_spacing["y"],
        }
    total_spacing = spacing * max(len(entries) - 1, 0)
    if "HorizontalLayoutGroup" in class_id:
        return {
            "width": padding["left"] + padding["right"] + sum(entry["width"] for entry in entries) + total_spacing,
            "height": padding["top"] + padding["bottom"] + max([entry["height"] for entry in entries] or [0.0]),
        }
    return {
        "width": padding["left"] + padding["right"] + max([entry["width"] for entry in entries] or [0.0]),
        "height": padding["top"] + padding["bottom"] + sum(entry["height"] for entry in entries) + total_spacing,
    }


def _find_slider_component(node: UnityNode) -> UnityDocument | None:
    """查找节点上的 Unity Slider 组件。"""

    for component in node.component_docs:
        class_id = _component_class(component)
        if "UnityEngine.UI.Slider" in class_id:
            return component
        if component.fields.get("m_FillRect") and component.fields.get("m_Value") is not None:
            return component
    return None


def _resolve_slider_fill_anchors(
    slider: UnityDocument,
    fill_node: UnityNode,
) -> tuple[dict[str, float], dict[str, float]]:
    """根据 Slider 当前值计算 FillRect 应呈现的锚点范围。"""

    value = _safe_float(slider.fields.get("m_Value"), 0.0)
    min_value = _safe_float(slider.fields.get("m_MinValue"), 0.0)
    max_value = _safe_float(slider.fields.get("m_MaxValue"), 1.0)
    direction = _safe_int(slider.fields.get("m_Direction"), 0)
    normalized = _normalize_slider_value(value, min_value, max_value)
    anchor_min = dict(fill_node.rect.get("m_AnchorMin") or {"x": 0.0, "y": 0.0})
    anchor_max = dict(fill_node.rect.get("m_AnchorMax") or {"x": 1.0, "y": 1.0})
    # Unity Slider.Direction: 0 LTR, 1 RTL, 2 BottomTop, 3 TopBottom。
    if direction == 1:
        anchor_min["y"] = 0.0
        anchor_max["y"] = 1.0
        anchor_min["x"] = 1.0 - normalized
        anchor_max["x"] = 1.0
    elif direction == 2:
        anchor_min["x"] = 0.0
        anchor_max["x"] = 1.0
        anchor_min["y"] = 0.0
        anchor_max["y"] = normalized
    elif direction == 3:
        anchor_min["x"] = 0.0
        anchor_max["x"] = 1.0
        anchor_min["y"] = 1.0 - normalized
        anchor_max["y"] = 1.0
    else:
        anchor_min["y"] = 0.0
        anchor_max["y"] = 1.0
        anchor_min["x"] = 0.0
        anchor_max["x"] = normalized
    return anchor_min, anchor_max


def _normalize_slider_value(value: float, min_value: float, max_value: float) -> float:
    """把 Slider value 转成 0 到 1 的归一化值。"""

    if abs(max_value - min_value) <= 1e-6:
        return 0.0
    normalized = (value - min_value) / (max_value - min_value)
    return max(0.0, min(1.0, normalized))


def _is_valid_visual_bounds(visual_bounds: dict[str, Any]) -> bool:
    """判断 visualBounds 是否包含可用尺寸。"""

    if not visual_bounds:
        return False
    width = visual_bounds.get("width", 0)
    height = visual_bounds.get("height", 0)
    return isinstance(width, (int, float)) and isinstance(height, (int, float)) and width >= 0 and height >= 0


def _build_audit_warnings(warnings: list[str], prefab_instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """将文本 warning 转换为统一审核 warning 项。"""

    audit_warnings = []
    for warning in warnings:
        audit_warnings.append({
            "code": _classify_warning_code(warning),
            "message": warning,
            "details": {},
        })
    if prefab_instances:
        audit_warnings.append({
            "code": "prefabInstancesRequireWriteStage",
            "message": "检测到嵌套 PrefabInstance，Figma 写入阶段必须创建或复用 Component Instance，禁止占位 Frame。",
            "details": {"prefabInstanceCount": len(prefab_instances), "prefabInstances": prefab_instances},
        })
    return audit_warnings


def _classify_warning_code(warning: str) -> str:
    """把历史文本 warning 粗分类成稳定 code。"""

    if "PrefabInstance documents detected" in warning:
        return "prefabInstancesDetected"
    if "Unsupported components" in warning:
        return "unsupportedComponents"
    if "Missing child RectTransform" in warning:
        return "missingChildRectTransform"
    if "Sliced image has no usable sprite border" in warning:
        return "slicedImageMissingBorder"
    if "Filled image downgraded" in warning:
        return "filledImageDowngraded"
    if "Tiled image is unsupported" in warning:
        return "tiledImageUnsupported"
    if "Sprite" in warning or "PNG" in warning:
        return "spriteAssetIssue"
    return "parserWarning"


def _export_node(
    node: UnityNode,
    nodes_by_rect_id: dict[int, UnityNode],
    parent_path: str,
    parent_width: float,
    parent_height: float,
    project_root: Path,
    guid_index: dict[str, Path],
    meta_path_to_guid: dict[str, str],
    material_cache: dict[str, dict[str, Any] | None],
    assets: dict[str, Any],
    warnings: list[str],
    flat_nodes: list[dict[str, Any]],
    stats: dict[str, int],
) -> dict[str, Any]:
    """递归导出单个 Unity 节点。"""

    rect = resolve_rect(node.rect, parent_width, parent_height).rounded()
    node_path = f"{parent_path}/{node.name}" if parent_path else node.name

    # 读取原始 scale 值，用于在 Figma 中应用翻转/缩放
    raw_fields = node.rect.get("RectTransform", node.rect) if isinstance(node.rect, dict) else node.rect
    raw_scale = raw_fields.get("m_LocalScale") if isinstance(raw_fields, dict) else None
    scale_x = float(raw_scale.get("x", 1.0)) if isinstance(raw_scale, dict) else 1.0
    scale_y = float(raw_scale.get("y", 1.0)) if isinstance(raw_scale, dict) else 1.0
    rect_transform = _rect_transform_to_dict(raw_fields if isinstance(raw_fields, dict) else {})

    rect_dict = _rect_to_dict(rect)
    if scale_x != 1.0:
        rect_dict["scaleX"] = _number(scale_x)
    if scale_y != 1.0:
        rect_dict["scaleY"] = _number(scale_y)

    export_node: dict[str, Any] = {
        "id": str(node.file_id),
        "name": node.name,
        "path": node_path,
        "active": node.active,
        "rect": rect_dict,
        "rectTransform": rect_transform,
        "constraints": rect_transform["constraints"],
        "unity": {
            "gameObjectId": node.game_object_id,
            "rectTransformId": node.rect_transform_id,
            "parentRectId": node.parent_rect_id,
            "children": [str(child_id) for child_id in node.child_rect_ids],
        },
        "children": [],
    }

    _attach_component_data(
        export_node,
        node,
        rect,
        project_root,
        guid_index,
        meta_path_to_guid,
        material_cache,
        assets,
        warnings,
        stats,
    )

    # 把 TMP 材质标记提升到节点名称上，方便 Figma 侧直接读取
    _promote_material_tag_to_node_name(export_node)

    stats["nodeCount"] += 1
    flat_node_index = len(flat_nodes)
    flat_nodes.append({})

    child_parent_rect = _rect_transform_unscaled_size(node.rect, rect)
    for child_id in node.child_rect_ids:
        child_node = nodes_by_rect_id.get(child_id)
        if child_node is None:
            warnings.append(f"Missing child RectTransform {child_id} under {node_path}")
            continue
        child_export = _export_node(
            node=child_node,
            nodes_by_rect_id=nodes_by_rect_id,
            parent_path=node_path,
            parent_width=max(child_parent_rect.width, 0.0),
            parent_height=max(child_parent_rect.height, 0.0),
            project_root=project_root,
            guid_index=guid_index,
            meta_path_to_guid=meta_path_to_guid,
            material_cache=material_cache,
            assets=assets,
            warnings=warnings,
            flat_nodes=flat_nodes,
            stats=stats,
        )
        export_node["children"].append(child_export)

    flat_nodes[flat_node_index] = _without_children(export_node)
    return export_node


def _rect_transform_unscaled_size(rect_fields: dict[str, Any], resolved_rect: Rect) -> Rect:
    """Return the layout size children use before local scale is applied."""

    fields = rect_fields.get("RectTransform", rect_fields) if isinstance(rect_fields, dict) else {}
    if not isinstance(fields, dict):
        return resolved_rect
    raw_scale = fields.get("m_LocalScale") or {}
    scale_x = abs(float(raw_scale.get("x", 1.0))) if isinstance(raw_scale, dict) else 1.0
    scale_y = abs(float(raw_scale.get("y", 1.0))) if isinstance(raw_scale, dict) else 1.0
    return Rect(
        x=resolved_rect.x,
        y=resolved_rect.y,
        width=resolved_rect.width / scale_x if scale_x > 0.000001 else resolved_rect.width,
        height=resolved_rect.height / scale_y if scale_y > 0.000001 else resolved_rect.height,
        rotation_z=resolved_rect.rotation_z,
    )


def _attach_component_data(
    export_node: dict[str, Any],
    node: UnityNode,
    rect: Rect,
    project_root: Path,
    guid_index: dict[str, Path],
    meta_path_to_guid: dict[str, str],
    material_cache: dict[str, dict[str, Any] | None],
    assets: dict[str, Any],
    warnings: list[str],
    stats: dict[str, int],
) -> None:
    """将图片、文本和不支持组件数据附加到导出节点。"""

    unsupported: list[str] = []
    localized_sprite_paths = _collect_localized_sprite_paths(node.component_docs)
    for component in node.component_docs:
        class_id = _component_class(component)
        sprite_ref = component.fields.get("m_Sprite") or {}
        texture_ref = component.fields.get("m_Texture") or {}
        has_sprite_guid = bool(sprite_ref.get("guid"))
        has_texture_guid = bool(texture_ref.get("guid"))

        if has_sprite_guid or _is_image_component(class_id):
            image = _build_image_data(
                component,
                rect,
                project_root,
                guid_index,
                meta_path_to_guid,
                assets,
                warnings,
                export_node["path"],
                node.active,
                localized_sprite_paths,
            )
            if image:
                export_node["image"] = image
                stats["imageCount"] += 1
                if image.get("mode") == "nine-slice":
                    stats["nineSliceCount"] += 1
            continue

        if has_texture_guid:
            image = _build_texture_data(component, project_root, guid_index, assets, warnings)
            if image:
                export_node["image"] = image
                stats["imageCount"] += 1
            continue

        if _is_text_component(class_id, component):
            export_node["text"] = _build_text_data(component, project_root, guid_index, material_cache)
            _resolve_text_effects(export_node["text"], project_root, guid_index, material_cache)
            stats["textCount"] += 1
            continue

        if class_id and _is_clip_component(class_id):
            export_node["clip"] = {
                "enabled": True,
                "componentType": class_id,
            }
            stats["clipCount"] += 1
            continue

        if class_id and _is_canvas_group_component(class_id):
            export_node["canvasGroup"] = _build_canvas_group_data(component)
            stats["canvasGroupCount"] = stats.get("canvasGroupCount", 0) + 1
            continue

        if _is_handled_static_layout(component):
            export_node.setdefault("layout", _build_static_layout_data(node))
            continue

        if class_id and _is_unsupported_component(class_id):
            unsupported.append(class_id)
        elif _has_script_reference(component):
            unsupported.append(class_id or component.type_name)

    if unsupported:
        export_node["unsupported"] = unsupported
        stats["unsupportedCount"] += len(unsupported)
        warnings.append(f"Unsupported components on {export_node['path']}: {', '.join(unsupported)}")


def _collect_localized_sprite_paths(components: list[UnityDocument]) -> list[str]:
    """收集同一 GameObject 上本地化组件提供的图片资源路径。"""

    paths: list[str] = []
    for component in components:
        resource_path = str(component.fields.get("resourcePath") or "").strip()
        if resource_path and resource_path.lower().endswith(".png"):
            paths.append(resource_path)
    return paths


def _build_image_data(
    component: UnityDocument,
    rect: Rect,
    project_root: Path,
    guid_index: dict[str, Path],
    meta_path_to_guid: dict[str, str],
    assets: dict[str, Any],
    warnings: list[str],
    node_path: str,
    node_active: bool,
    localized_sprite_paths: list[str] | None = None,
) -> dict[str, Any] | None:
    """构建 Image/CustomImage 图片数据。"""

    sprite_ref = component.fields.get("m_Sprite") or {}
    guid = sprite_ref.get("guid")
    fallback_resource_path = ""
    if not guid:
        fallback_resource_path = _select_localized_sprite_path(localized_sprite_paths or [])
        guid = _resolve_guid_from_resource_path(
            fallback_resource_path,
            project_root,
            guid_index,
            meta_path_to_guid,
        ) if fallback_resource_path else ""
        if not guid:
            warning = f"Image component has no sprite guid on {node_path}"
            warnings.append(warning)
            return {
                "componentType": _component_class(component) or component.type_name,
                "guid": "",
                "imageType": IMAGE_TYPES.get(component.fields.get("m_Type") or 0, "Simple"),
                "mode": "placeholder",
                "missingSprite": True,
                "missingReason": warning,
            }
        warnings.append(
            f"{node_path}: Image sprite guid resolved from localized resourcePath {fallback_resource_path}"
        )

    asset_key = guid.lower()
    sprite_asset, warning = resolve_sprite(guid, guid_index, project_root)
    if warning:
        if node_active:
            warnings.append(warning)
        else:
            warnings.append(f"Inactive image sprite guid not found in index on {node_path}: {asset_key}")

    image_type_value = component.fields.get("m_Type")
    image_type = IMAGE_TYPES.get(image_type_value if image_type_value is not None else 0, "Simple")
    # SlicedFilledImage：fillAmount=1.0 时行为和 Sliced 相同，生成九宫数据
    component_cls = _component_class(component) or component.type_name
    if "SlicedFilledImage" in component_cls and image_type != "Sliced":
        fill_amount_val = component.fields.get("m_FillAmount")
        if fill_amount_val in (None, 1, 1.0):
            image_type = "Sliced"
    fill_amount = component.fields.get("m_FillAmount")
    fill_center = component.fields.get("m_FillCenter")
    preserve_aspect = component.fields.get("m_PreserveAspect")
    color = component.fields.get("m_Color")
    image_data: dict[str, Any] = {
        "componentType": _component_class(component) or component.type_name,
        "guid": asset_key,
        "imageType": image_type,
        "mode": "simple",
        "fillAmount": fill_amount,
        "fillCenter": True if fill_center is None else fill_center,
    }
    if preserve_aspect is not None:
        image_data["preserveAspect"] = preserve_aspect
    if color:
        image_data["color"] = color
    if fallback_resource_path:
        image_data["localizedFallback"] = {
            "resourcePath": fallback_resource_path,
            "source": "LanguageEffectFont.resourcePath",
        }

    if sprite_asset:
        assets[asset_key] = _sprite_asset_to_dict(sprite_asset, project_root)
        image_data["asset"] = asset_key
        image_data["pixelSize"] = {"width": sprite_asset.width, "height": sprite_asset.height}
        image_data["border"] = sprite_asset.border
    else:
        # Sprite 资源缺失（可能被删除或运行时动态赋值），不创建图片节点
        image_data["missingSprite"] = True
        image_data["missingReason"] = warning or "sprite_asset_unresolved"
        image_data["mode"] = "placeholder"
        return image_data

    if image_type == "Sliced":
        border = sprite_asset.border if sprite_asset else {}
        if sprite_asset and has_border(border):
            slices, slice_warnings = build_nine_slice(rect.width, rect.height, sprite_asset.width, sprite_asset.height, border)
            image_data["mode"] = "nine-slice"
            image_data["slices"] = [_slice_to_dict(slice_item) for slice_item in slices]
            # 追加完整源图片元数据，供 Importer 写入九宫格父节点隐藏源图 fill
            image_data["sourceImage"] = {
                "width": sprite_asset.width,
                "height": sprite_asset.height,
                "spriteGuid": asset_key,
                "assetPath": _relative_path(Path(sprite_asset.asset_path), project_root),
            }
            warnings.extend(f"{node_path}: {slice_warning}" for slice_warning in slice_warnings)
        else:
            warnings.append(f"{node_path}: Sliced image has no usable sprite border")
    elif image_type == "Filled":
        if fill_amount not in (None, 1, 1.0):
            warnings.append(f"{node_path}: Filled image downgraded to simple because fillAmount={fill_amount}")
    elif image_type == "Tiled":
        image_data["mode"] = "unsupported"
        warnings.append(f"{node_path}: Tiled image is unsupported in first version")

    return image_data


def _build_texture_data(
    component: UnityDocument,
    project_root: Path,
    guid_index: dict[str, Path],
    assets: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any] | None:
    """构建 RawImage Texture 数据。"""

    texture_ref = component.fields.get("m_Texture") or {}
    guid = texture_ref.get("guid")
    if not guid:
        return None
    sprite_asset, warning = resolve_sprite(guid, guid_index, project_root)
    if warning:
        warnings.append(warning)
        image_data: dict[str, Any] = {
            "componentType": "RawImage",
            "guid": guid.lower(),
            "missingSprite": True,
            "missingReason": warning,
            "mode": "placeholder",
        }
        color = component.fields.get("m_Color")
        if color:
            image_data["color"] = color
        uv_rect = component.fields.get("m_UVRect")
        if uv_rect:
            image_data["uvRect"] = uv_rect
        return image_data
    assets[guid.lower()] = _sprite_asset_to_dict(sprite_asset, project_root)
    image_data = {
        "componentType": "RawImage",
        "guid": guid.lower(),
        "asset": guid.lower(),
        "mode": "simple",
        "pixelSize": {"width": sprite_asset.width, "height": sprite_asset.height},
    }
    color = component.fields.get("m_Color")
    if color:
        image_data["color"] = color
    uv_rect = component.fields.get("m_UVRect")
    if uv_rect:
        image_data["uvRect"] = uv_rect
    return image_data


def _build_canvas_group_data(component: UnityDocument) -> dict[str, Any]:
    """Build CanvasGroup metadata from static serialized fields."""

    alpha = component.fields.get("m_Alpha")
    return {
        "componentType": _component_class(component) or component.type_name,
        "alpha": 1.0 if alpha is None else alpha,
        "interactable": component.fields.get("m_Interactable"),
        "blocksRaycasts": component.fields.get("m_BlocksRaycasts"),
        "ignoreParentGroups": component.fields.get("m_IgnoreParentGroups"),
    }


def _select_localized_sprite_path(paths: list[str]) -> str:
    """选择第一个可用的本地化 PNG 路径。"""

    return paths[0] if paths else ""


def _resolve_guid_from_resource_path(
    resource_path: str,
    project_root: Path,
    guid_index: dict[str, Path],
    meta_path_to_guid: dict[str, str] | None = None,
) -> str:
    """从 Unity 资源路径对应的 .meta 文件解析 guid。"""

    if not resource_path:
        return ""
    asset_path = _resolve_unity_asset_path(resource_path, project_root)
    meta_path = asset_path.with_name(asset_path.name + ".meta")
    if not meta_path.exists():
        return ""
    if meta_path_to_guid is None:
        meta_path_to_guid = _build_meta_path_to_guid_index(guid_index)
    guid = meta_path_to_guid.get(_normalized_path_key(meta_path))
    if guid:
        return guid
    match = re.search(r"\bguid:\s*([0-9a-fA-F]{32})\b", meta_path.read_text(encoding="utf-8", errors="ignore"))
    return match.group(1).lower() if match else ""


def _build_meta_path_to_guid_index(guid_index: dict[str, Path]) -> dict[str, str]:
    """构建 meta 绝对路径到 guid 的反向索引，避免按资源路径反查时反复遍历 guid_index。"""

    meta_path_to_guid: dict[str, str] = {}
    for guid, indexed_meta in guid_index.items():
        meta_path_to_guid[_normalized_path_key(Path(indexed_meta))] = guid.lower()
    return meta_path_to_guid


def _normalized_path_key(path: Path) -> str:
    """生成跨平台稳定的路径索引 key。"""

    return str(path).replace("\\", "/").lower()


def _resolve_unity_asset_path(resource_path: str, project_root: Path) -> Path:
    """把 Unity Assets/... 路径解析成本地文件路径。"""

    raw_path = Path(resource_path)
    if raw_path.is_absolute():
        return raw_path
    normalized = normalize_asset_path(resource_path)
    root = project_root.resolve()
    return root / normalized


def _build_text_data(
    component: UnityDocument,
    project_root: Path,
    guid_index: dict[str, Path],
    material_cache: dict[str, dict[str, Any] | None],
) -> dict[str, Any]:
    """构建 TMP 文本数据。"""

    fields = component.fields
    component_type = _infer_text_component_type(component)
    text_data: dict[str, Any] = {
        "componentType": component_type,
        "content": fields.get("m_Text") or "",
        "fontSize": fields.get("m_fontSize"),
        "color": fields.get("m_Color"),
    }
    # m_fontColor 是 TMP 实际渲染颜色，优先于 m_Color（Graphic 基类颜色）
    font_color = fields.get("m_fontColor")
    if font_color:
        text_data["fontColor"] = font_color
    # 描边颜色（TMP 组件级别，部分 Prefab 会序列化）
    outline_color = fields.get("m_outlineColor")
    if outline_color:
        text_data["outlineColor"] = outline_color
    # Material 引用，用于后续解析 shader 属性中的描边/阴影参数
    shared_mat = fields.get("m_sharedMaterial")
    if shared_mat and (shared_mat.get("guid") or shared_mat.get("fileID")):
        shared_material = {
            "guid": (shared_mat.get("guid") or "").lower(),
            "fileID": shared_mat.get("fileID", 0),
        }
        if _is_tmp_text_component_type(component_type):
            material_info = _resolve_tmp_material_info(shared_material, project_root, guid_index, material_cache)
            shared_material.update(material_info)
            material_tag = _build_tmp_material_tag(material_info.get("name", ""))
            if material_tag:
                text_data["materialTag"] = material_tag
                text_data["figmaTextLayerName"] = _build_figma_text_layer_name(material_tag)
        text_data["sharedMaterial"] = shared_material
    auto_size = _compact_dict(
        {
            "enabled": fields.get("m_enableAutoSizing"),
            "min": fields.get("m_fontSizeMin"),
            "max": fields.get("m_fontSizeMax"),
        }
    )
    alignment = _compact_dict(
        {
            "horizontal": fields.get("m_HorizontalAlignment"),
            "vertical": fields.get("m_VerticalAlignment"),
            "legacy": fields.get("m_textAlignment"),
        }
    )
    text_options = _compact_dict(
        {
            "fontStyle": fields.get("m_fontStyle"),
            "wordWrapping": _extract_tmp_word_wrapping(component.raw, fields),
            "textWrappingMode": _extract_tmp_text_wrapping_mode(component.raw),
            "overflowMode": fields.get("m_overflowMode"),
            "richText": fields.get("m_isRichText"),
        }
    )
    if auto_size:
        text_data["autoSize"] = auto_size
    if alignment:
        text_data["alignment"] = alignment
    if text_options:
        text_data["options"] = text_options
    return text_data


def _extract_tmp_text_wrapping_mode(raw: str) -> int | None:
    """读取 TMP 4.x 的 TextWrappingMode 枚举值，兼容 Unity 6000 序列化字段。"""

    match = re.search(r"^\s*m_TextWrappingMode:\s*(-?\d+)\s*$", raw, re.MULTILINE)
    if not match:
        return None
    return _safe_int(match.group(1), 0)


def _extract_tmp_word_wrapping(raw: str, fields: dict[str, Any]) -> bool | None:
    """把 TMP 新旧换行字段统一转换为是否允许自动换行。"""

    legacy = fields.get("m_enableWordWrapping")
    if legacy is not None:
        return legacy
    wrapping_mode = _extract_tmp_text_wrapping_mode(raw)
    if wrapping_mode is None:
        return None
    # TMP TextWrappingModes: 0=NoWrap, 1=Normal, 2=PreserveWhitespace, 3=PreserveWhitespaceNoWrap。
    return wrapping_mode in (1, 2)


def _resolve_tmp_material_info(
    mat_ref: dict[str, Any],
    project_root: Path,
    guid_index: dict[str, Path],
    material_cache: dict[str, dict[str, Any] | None],
) -> dict[str, Any]:
    """解析 TMP 材质的可回写标识信息，供 Figma 文本层命名使用。"""

    material_entry = _load_tmp_material_document(mat_ref, guid_index, material_cache)
    if not material_entry:
        return {}

    material_doc = material_entry["document"]
    asset_path = material_entry["assetPath"]
    material_name = (material_doc.fields.get("m_Name") or "").strip()
    material_info: dict[str, Any] = {
        "assetPath": _relative_path(asset_path, project_root),
    }
    if material_name:
        material_info["name"] = material_name

    font_candidates: list[str] = []
    if material_name:
        font_candidates.extend(_guess_figma_font_candidates(material_name))

    # 从同目录 .asset 文件中读取 sourceFontFileGUID，解析源字体文件名作为 Figma 字体候选
    try:
        asset_path_obj = Path(asset_path)
        asset_candidate = asset_path_obj.with_suffix(".asset")
        if not asset_candidate.exists():
            asset_candidate = asset_path_obj.parent / (asset_path_obj.stem + ".asset")
        if asset_candidate.exists():
            raw_text = asset_candidate.read_text(encoding="utf-8")
            m = re.search(r"sourceFontFileGUID:\s*(\S+)", raw_text)
            if m:
                source_guid = m.group(1).strip().lower()
                font_path = guid_index.get(source_guid)
                if font_path:
                    font_path = Path(str(font_path))
                    if font_path.suffix == ".meta":
                        font_path = font_path.with_suffix("")
                    source_family = re.sub(r"\d+$", "", font_path.stem)
                    if source_family:
                        material_info["sourceFontFamily"] = source_family
                        font_candidates.append(source_family)
    except Exception:
        pass

    if font_candidates:
        material_info["figmaFontCandidates"] = _dedupe_keep_order(font_candidates)
    return material_info


def _guess_figma_font_candidates(material_name: str) -> list[str]:
    """根据 TMP 材质名生成 Figma 可尝试加载的字体家族候选。"""

    normalized = re.sub(r"[_-]+", " ", material_name or "").strip()
    normalized = re.sub(r"\s*SDF\s*Material\s*$", "", normalized, flags=re.IGNORECASE).strip()
    candidates: list[str] = []
    if normalized:
        candidates.append(normalized)
    compact = re.sub(r"\s+", "", normalized)
    if "NotoSansSC" in compact or "Noto Sans SC" in normalized:
        candidates.extend(["Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei"])
    return candidates


def _dedupe_keep_order(values: list[str]) -> list[str]:
    """按原始优先级去重，避免重复字体候选增加 Figma 加载开销。"""

    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = (value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _build_tmp_material_tag(material_name: str) -> str | None:
    """把 TMP 材质名转换为 Figma 节点名中的标识，保留完整材质名便于回写时直接匹配。"""

    tag = (material_name or "").strip()
    tag = tag.replace("(", "_").replace(")", "_")
    tag = re.sub(r"\s+", "_", tag).strip(" _")
    return tag or None


def _build_figma_text_layer_name(material_tag: str | None) -> str:
    """生成文本子图层名称，材质标记已提升到父节点名称上，子图层统一为 __text。"""

    return "__text"


def _promote_material_tag_to_node_name(export_node: dict[str, Any]) -> None:
    """把 TMP 材质标记从子文本图层提升到节点自身名称上。

    格式：原名(材质标记)，例如 [DescText](CommonFont_o_833411_u_833411)
    """

    return None


def _is_tmp_text_component_type(component_type: str) -> bool:
    """判断文本组件类型是否属于 TextMeshPro 系列。"""

    return "TextMeshPro" in component_type


def _load_tmp_material_document(
    mat_ref: dict[str, Any],
    guid_index: dict[str, Path],
    material_cache: dict[str, dict[str, Any] | None],
) -> dict[str, Any] | None:
    """按 GUID/fileID 读取 TMP 材质文档，并缓存同材质解析结果。"""

    guid = (mat_ref.get("guid") or "").lower()
    if not guid:
        return None

    file_id = _safe_int(mat_ref.get("fileID"), 0)
    cache_key = f"{guid}:{file_id}"
    if cache_key in material_cache:
        return material_cache[cache_key]

    asset_path = guid_index.get(guid)
    if not asset_path:
        material_cache[cache_key] = None
        return None
    if str(asset_path).endswith(".meta"):
        asset_path = Path(str(asset_path)[:-5])
    if not asset_path.exists():
        material_cache[cache_key] = None
        return None

    try:
        docs = load_unity_documents(asset_path)
    except Exception:
        material_cache[cache_key] = None
        return None

    material_doc = _find_material_document(docs, file_id)
    if material_doc is None:
        material_cache[cache_key] = None
        return None

    material_entry: dict[str, Any] = {
        "document": material_doc,
        "assetPath": asset_path,
        "allDocs": docs,
    }
    material_cache[cache_key] = material_entry
    return material_entry


def _find_material_document(docs: list[UnityDocument], file_id: int) -> UnityDocument | None:
    """从 Unity YAML 文档列表中查找匹配的 Material 文档。"""

    if file_id:
        for doc in docs:
            if doc.file_id == file_id:
                return doc
    for doc in docs:
        if doc.class_id == 21:
            return doc
    return None


def _safe_int(value: Any, default: int = 0) -> int:
    """安全转换整数，避免异常打断 Prefab 解析流程。"""

    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    """安全转换浮点数，避免异常打断 PrefabInstance override 解析。"""

    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _component_class(component: UnityDocument) -> str:
    """读取组件类型标识。"""

    return component.fields.get("m_EditorClassIdentifier") or component.type_name


def _set_rect_size(rect_fields: dict[str, Any], width: float | None = None, height: float | None = None) -> None:
    """Update RectTransform sizeDelta for fixed-anchor UI nodes."""

    if width is None and height is None:
        return
    size_delta = rect_fields.setdefault("m_SizeDelta", {"x": 0.0, "y": 0.0})
    if not isinstance(size_delta, dict):
        size_delta = {"x": 0.0, "y": 0.0}
        rect_fields["m_SizeDelta"] = size_delta
    if width is not None:
        size_delta["x"] = float(width)
    if height is not None:
        size_delta["y"] = float(height)


def _set_rect_anchored_position(rect_fields: dict[str, Any], x: float | None = None, y: float | None = None) -> None:
    """Update RectTransform anchoredPosition while preserving untouched axes."""

    position = rect_fields.setdefault("m_AnchoredPosition", {"x": 0.0, "y": 0.0})
    if not isinstance(position, dict):
        position = {"x": 0.0, "y": 0.0}
        rect_fields["m_AnchoredPosition"] = position
    if x is not None:
        position["x"] = float(x)
    if y is not None:
        position["y"] = float(y)


def _resolve_text_effects(
    text_data: dict[str, Any],
    project_root: Path,
    guid_index: dict[str, Path],
    material_cache: dict[str, dict[str, Any] | None],
) -> None:
    """从 TMP 关联的 Material 中解析描边/阴影 shader 属性，写入 text_data["effects"]。"""

    mat_ref = text_data.get("sharedMaterial")
    if not mat_ref:
        return
    material_entry = _load_tmp_material_document(mat_ref, guid_index, material_cache)
    if not material_entry:
        return
    # 从 Material 的 raw YAML 中直接提取 shader 属性（m_SavedProperties 结构复杂，用正则提取）
    raw = material_entry["document"].raw
    # 提取 float 属性：格式为 "- _PropName: 0.123"
    float_pattern = re.compile(r"-\s+(_\w+):\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)")
    float_props: dict[str, float] = {}
    for m in float_pattern.finditer(raw):
        float_props[m.group(1)] = float(m.group(2))
    # 提取 color 属性：格式为 "- _PropName: {r: 0, g: 0, b: 0, a: 1}"
    color_pattern = re.compile(
        r"-\s+(_\w+):\s*\{r:\s*([0-9.eE+-]+),\s*g:\s*([0-9.eE+-]+),\s*b:\s*([0-9.eE+-]+),\s*a:\s*([0-9.eE+-]+)\}"
    )
    color_props: dict[str, dict[str, float]] = {}
    for m in color_pattern.finditer(raw):
        color_props[m.group(1)] = {
            "r": float(m.group(2)), "g": float(m.group(3)),
            "b": float(m.group(4)), "a": float(m.group(5)),
        }
    # 检查材质 shader 关键字是否启用描边/下阴影
    has_outline_kw = "OUTLINE_ON" in (re.search(r"m_ValidKeywords:\s*\n((?:\s*-\s*\w+\s*\n)*)", raw) or ("",))[0]
    has_underlay_kw = "UNDERLAY_ON" in (re.search(r"m_ValidKeywords:\s*\n((?:\s*-\s*\w+\s*\n)*)", raw) or ("",))[0]

    # 提取描边参数（仅在 OUTLINE_ON 关键字启用时）
    effects: dict[str, Any] = {}
    if has_outline_kw:
        outline_width = float_props.get("_OutlineWidth", 0)
        if outline_width > 0:
            outline: dict[str, Any] = {"width": outline_width}
            outline_color = color_props.get("_OutlineColor")
            if outline_color:
                outline["color"] = outline_color
            effects["outline"] = outline
    # 提取阴影/Underlay 参数（仅在 UNDERLAY_ON 关键字启用时）
    if has_underlay_kw:
        underlay_offset_x = float_props.get("_UnderlayOffsetX", 0)
        underlay_offset_y = float_props.get("_UnderlayOffsetY", 0)
        underlay_softness = float_props.get("_UnderlaySoftness", 0)
        underlay_dilate = float_props.get("_UnderlayDilate", 0)
        has_underlay = abs(underlay_offset_x) > 0.001 or abs(underlay_offset_y) > 0.001 or underlay_softness > 0.001 or underlay_dilate > 0.001
        if has_underlay:
            underlay: dict[str, Any] = {
                "offsetX": underlay_offset_x,
                "offsetY": underlay_offset_y,
                "softness": underlay_softness,
                "dilate": underlay_dilate,
            }
            underlay_color = color_props.get("_UnderlayColor")
            if underlay_color:
                underlay["color"] = underlay_color
            effects["underlay"] = underlay
    if effects:
        text_data["effects"] = effects


def _is_image_component(class_id: str) -> bool:
    """判断组件是否按图片处理。"""

    return any(marker in class_id for marker in IMAGE_CLASS_MARKERS)


def _is_text_component(class_id: str, component: UnityDocument) -> bool:
    """判断组件是否按文本处理。"""

    if any(marker in class_id for marker in TEXT_CLASS_MARKERS):
        return True
    has_text = bool(component.fields.get("m_Text"))
    has_text_shape = component.fields.get("m_fontSize") is not None
    return has_text and (has_text_shape or "Text" in class_id)


def _infer_text_component_type(component: UnityDocument) -> str:
    """推断文本组件类型，兼容 TMP 脚本标识为空的 Prefab。"""

    class_id = _component_class(component)
    if class_id and class_id != "MonoBehaviour":
        return class_id
    if component.fields.get("m_Text"):
        return "TextMeshProUGUI"
    return class_id or component.type_name


def _is_unsupported_component(class_id: str) -> bool:
    """判断组件是否需要显式标记为不支持。"""

    return any(marker in class_id for marker in UNSUPPORTED_CLASS_MARKERS)


def _is_handled_static_layout_component(class_id: str) -> bool:
    """Return True for layout components resolved by the static exporter."""

    return any(marker in class_id for marker in LAYOUT_GROUP_MARKERS) or "ContentSizeFitter" in class_id


def _is_handled_static_layout(component: UnityDocument) -> bool:
    class_id = _component_class(component)
    return bool(
        (class_id and _is_handled_static_layout_component(class_id))
        or _is_horizontal_layout_group(component)
        or _is_vertical_layout_group(component)
        or _is_grid_layout_group(component)
        or _is_content_size_fitter(component)
    )


def _is_horizontal_layout_group(component: UnityDocument) -> bool:
    script_ref = _unity_ref_to_dict(extract_ref(component.raw, "m_Script"))
    script_guid = str(script_ref.get("guid") or "").lower()
    return script_guid == UNITY_HORIZONTAL_LAYOUT_GROUP_GUID


def _is_vertical_layout_group(component: UnityDocument) -> bool:
    script_ref = _unity_ref_to_dict(extract_ref(component.raw, "m_Script"))
    script_guid = str(script_ref.get("guid") or "").lower()
    return script_guid == UNITY_VERTICAL_LAYOUT_GROUP_GUID


def _is_grid_layout_group(component: UnityDocument) -> bool:
    script_ref = _unity_ref_to_dict(extract_ref(component.raw, "m_Script"))
    script_guid = str(script_ref.get("guid") or "").lower()
    return script_guid == UNITY_GRID_LAYOUT_GROUP_GUID


def _is_content_size_fitter(component: UnityDocument) -> bool:
    script_ref = _unity_ref_to_dict(extract_ref(component.raw, "m_Script"))
    script_guid = str(script_ref.get("guid") or "").lower()
    return script_guid == UNITY_CONTENT_SIZE_FITTER_GUID


def _build_static_layout_data(node: UnityNode) -> dict[str, Any]:
    components: list[str] = []
    for component in node.component_docs:
        class_id = _component_class(component)
        if class_id and _is_handled_static_layout_component(class_id):
            components.append(class_id)
            continue
        if _is_grid_layout_group(component):
            components.append("UnityEngine.UI.GridLayoutGroup")
            continue
        if _is_content_size_fitter(component):
            components.append("UnityEngine.UI.ContentSizeFitter")
            continue
        if _is_horizontal_layout_group(component):
            components.append("UnityEngine.UI.HorizontalLayoutGroup")
            continue
        if _is_vertical_layout_group(component):
            components.append("UnityEngine.UI.VerticalLayoutGroup")
    return {
        "resolved": True,
        "components": components,
    }


def _is_clip_component(class_id: str) -> bool:
    """判断组件是否可映射为 Figma 裁剪元数据。"""

    return any(marker in class_id for marker in CLIP_CLASS_MARKERS)


def _is_canvas_group_component(class_id: str) -> bool:
    """Return True for Unity CanvasGroup components."""

    return any(marker in class_id for marker in CANVAS_GROUP_CLASS_MARKERS)


def _has_script_reference(component: UnityDocument) -> bool:
    """判断 MonoBehaviour 是否带脚本引用。"""

    return "m_Script:" in component.raw


def _compact_dict(value: dict[str, Any]) -> dict[str, Any]:
    """移除值为 None 的字段，保持 JSON 简洁稳定。"""

    return {key: item for key, item in value.items() if item is not None}


def _collect_prefab_instances(
    documents: list[UnityDocument],
    project_root: Path | None = None,
    guid_index: dict[str, Path] | None = None,
    canvas_width: float = 1080,
    canvas_height: float = 2160,
    nodes_by_rect_id: dict[int, UnityNode] | None = None,
    warnings: list[str] | None = None,
) -> list[dict[str, Any]]:
    """收集嵌套 PrefabInstance 信息，并尽量解析源 Prefab 路径。"""

    prefab_instances: list[dict[str, Any]] = []
    context = _build_prefab_instance_context(documents)
    for document in documents:
        if document.class_id != 1001 and document.type_name != "PrefabInstance":
            continue

        source_prefab = _unity_ref_to_dict(extract_ref(document.raw, "m_SourcePrefab"))
        _attach_prefab_asset_path(source_prefab, project_root, guid_index or {})
        if not _source_prefab_is_ugui_prefab(source_prefab, project_root, guid_index or {}):
            if warnings is not None:
                warnings.append(_build_skipped_non_ugui_prefab_instance_warning(document.file_id, source_prefab))
            continue
        prefab_instance = {
            "fileId": str(document.file_id),
            "sourcePrefab": source_prefab,
            "hasModification": "m_Modification:" in document.raw,
        }
        instance_override = _build_prefab_instance_override(
            document.raw, project_root, guid_index or {},
            context=context, canvas_width=canvas_width, canvas_height=canvas_height,
        )
        if instance_override:
            prefab_instance["instanceOverride"] = instance_override
        stripped_rect_ids = context.stripped_rect_ids_by_prefab_instance.get(document.file_id, [])
        if stripped_rect_ids:
            prefab_instance["strippedRectTransformIds"] = stripped_rect_ids
            _remember_stripped_prefab_instance_size(context, stripped_rect_ids, instance_override)
        prefab_instances.append(prefab_instance)
    _apply_layout_to_prefab_instances(prefab_instances, context, nodes_by_rect_id or {}, canvas_width, canvas_height)
    _sort_prefab_instances_by_hierarchy(prefab_instances, context)
    return prefab_instances


def _remember_stripped_prefab_instance_size(
    context: PrefabInstanceContext,
    stripped_rect_ids: list[str],
    instance_override: dict[str, Any],
) -> None:
    rect = instance_override.get("rect") if isinstance(instance_override, dict) else {}
    if not isinstance(rect, dict):
        return
    width = _safe_float(rect.get("width"), 0.0)
    height = _safe_float(rect.get("height"), 0.0)
    if width <= 0.0 or height <= 0.0:
        return
    size = {"width": width, "height": height}
    for stripped_rect_id in stripped_rect_ids:
        rect_id = _safe_int(stripped_rect_id, 0)
        if rect_id:
            context.stripped_rect_size_by_id[rect_id] = size


def _sort_prefab_instances_by_hierarchy(
    prefab_instances: list[dict[str, Any]],
    context: PrefabInstanceContext,
) -> None:
    if not prefab_instances or not context.rect_documents_by_id:
        return
    original_index_by_id = {id(item): index for index, item in enumerate(prefab_instances)}
    prefab_instances.sort(
        key=lambda item: (
            _prefab_instance_hierarchy_order(item, context),
            original_index_by_id.get(id(item), 0),
        )
    )


def _prefab_instance_hierarchy_order(
    item: dict[str, Any],
    context: PrefabInstanceContext,
) -> tuple[int, ...]:
    orders: list[tuple[int, ...]] = []
    for rect_id_value in item.get("strippedRectTransformIds") or []:
        rect_id = _safe_int(rect_id_value, 0)
        if not rect_id:
            continue
        order = _rect_transform_hierarchy_order(rect_id, context.rect_documents_by_id, set())
        if order and order != (0,):
            orders.append(order)
    override = item.get("instanceOverride") or {}
    parent_rect_id = _safe_int(override.get("parentRectId"), 0)
    if parent_rect_id:
        parent_order = _rect_transform_hierarchy_order(parent_rect_id, context.rect_documents_by_id, set())
        if parent_order:
            orders.append(parent_order + (1_000_000,))
    if not orders:
        return (1_000_000,)
    return min(orders)


def _rect_transform_hierarchy_order(
    rect_id: int,
    rect_documents_by_id: dict[int, UnityDocument],
    seen: set[int],
) -> tuple[int, ...]:
    if rect_id in seen:
        return (1_000_000,)
    seen.add(rect_id)
    document = rect_documents_by_id.get(rect_id)
    if document is None:
        return (1_000_000,)
    parent_rect_id = _safe_int(document.fields.get("m_Father"), 0)
    parent = rect_documents_by_id.get(parent_rect_id)
    sibling_index: int | None = None
    if parent is None:
        for candidate_id, candidate in rect_documents_by_id.items():
            candidate_child_ids = list(candidate.fields.get("m_Children") or [])
            if rect_id not in candidate_child_ids:
                continue
            parent_rect_id = candidate_id
            parent = candidate
            sibling_index = candidate_child_ids.index(rect_id)
            break
    if parent is None:
        return (0,)
    parent_child_ids = list(parent.fields.get("m_Children") or [])
    if sibling_index is None:
        try:
            sibling_index = parent_child_ids.index(rect_id)
        except ValueError:
            sibling_index = 1_000_000
    return _rect_transform_hierarchy_order(parent_rect_id, rect_documents_by_id, seen) + (sibling_index,)


def _build_skipped_non_ugui_prefab_instance_warning(file_id: int, source_prefab: dict[str, Any]) -> str:
    """生成跳过非 UGUI PrefabInstance 的 warning 文本。"""

    source_path = str(source_prefab.get("assetPath") or "")
    source_guid = str(source_prefab.get("guid") or "")
    skip_reason = str(source_prefab.get("skipReason") or "unsupported_prefab_instance_source")
    return (
        f"Skipped non-UGUI PrefabInstance {file_id}: {source_path or source_guid}; "
        f"reason={skip_reason}"
    )


def _source_prefab_is_ugui_prefab(
    source_prefab: dict[str, Any],
    project_root: Path | None,
    guid_index: dict[str, Path],
) -> bool:
    """判断 PrefabInstance 源资源是否为可静态导入的 UGUI Prefab。"""

    asset_type = str(source_prefab.get("assetType") or "").lower()
    asset_path = str(source_prefab.get("assetPath") or "")
    if asset_type and asset_type != ".prefab":
        source_prefab["isUguiPrefab"] = False
        source_prefab["skipReason"] = "source_asset_is_not_prefab"
        return False
    if not asset_type and not asset_path:
        return True
    if not asset_path:
        return True
    prefab_file = Path(asset_path)
    if project_root and not prefab_file.is_absolute():
        prefab_file = project_root / prefab_file
    if not prefab_file.exists():
        source_prefab["isUguiPrefab"] = False
        source_prefab["skipReason"] = "source_prefab_asset_missing"
        return False
    try:
        documents = load_unity_documents(prefab_file)
        documents = _expand_variant_if_needed(documents, project_root or Path.cwd(), guid_index)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        source_prefab["isUguiPrefab"] = False
        source_prefab["skipReason"] = f"source_prefab_parse_failed:{exc}"
        return False
    if not _documents_have_root_rect_transform(documents):
        source_prefab["isUguiPrefab"] = False
        source_prefab["skipReason"] = "source_prefab_has_no_root_rect_transform"
        return False
    try:
        _resolve_export_canvas(documents, None)
    except ValueError:
        source_prefab["isUguiPrefab"] = False
        source_prefab["skipReason"] = "source_prefab_has_invalid_root_rect_transform_size"
        return False
    source_prefab["isUguiPrefab"] = True
    return True


def _documents_have_root_rect_transform(documents: list[UnityDocument]) -> bool:
    """检查 Unity 文档是否能组成一个带根 RectTransform 的 UGUI 树。"""

    root_node, _, _ = build_node_tree(documents)
    return root_node is not None


@dataclass
class PrefabInstanceContext:
    """缓存 PrefabInstance 解析所需索引，避免每个实例重复扫描 YAML 文档。"""

    rect_documents_by_id: dict[int, UnityDocument]
    stripped_rect_ids_by_prefab_instance: dict[int, list[str]]
    stripped_source_rect_ids_by_prefab_instance: dict[int, list[int]]
    prefab_instance_id_by_stripped_rect_id: dict[int, int]
    stripped_rect_size_by_id: dict[int, dict[str, float]]


def _build_prefab_instance_context(documents: list[UnityDocument]) -> PrefabInstanceContext:
    """预构建 RectTransform 和 stripped PrefabInstance 索引。"""

    rect_documents_by_id: dict[int, UnityDocument] = {}
    stripped_rect_ids_by_prefab_instance: dict[int, list[str]] = {}
    stripped_source_rect_ids_by_prefab_instance: dict[int, list[int]] = {}
    prefab_instance_id_by_stripped_rect_id: dict[int, int] = {}
    for document in documents:
        if document.type_name != "RectTransform":
            continue
        rect_documents_by_id[document.file_id] = document
        if "stripped" not in document.raw:
            continue
        prefab_ref = _unity_ref_to_dict(extract_ref(document.raw, "m_PrefabInstance"))
        prefab_instance_id = _safe_int(prefab_ref.get("fileID"), 0)
        if prefab_instance_id:
            stripped_rect_ids_by_prefab_instance.setdefault(prefab_instance_id, []).append(str(document.file_id))
            prefab_instance_id_by_stripped_rect_id[document.file_id] = prefab_instance_id
            source_ref = _unity_ref_to_dict(extract_ref(document.raw, "m_CorrespondingSourceObject"))
            source_rect_id = _safe_int(source_ref.get("fileID"), 0)
            if source_rect_id:
                stripped_source_rect_ids_by_prefab_instance.setdefault(prefab_instance_id, []).append(source_rect_id)
    return PrefabInstanceContext(
        rect_documents_by_id=rect_documents_by_id,
        stripped_rect_ids_by_prefab_instance=stripped_rect_ids_by_prefab_instance,
        stripped_source_rect_ids_by_prefab_instance=stripped_source_rect_ids_by_prefab_instance,
        prefab_instance_id_by_stripped_rect_id=prefab_instance_id_by_stripped_rect_id,
        stripped_rect_size_by_id={},
    )


def _apply_layout_to_prefab_instances(
    prefab_instances: list[dict[str, Any]],
    context: PrefabInstanceContext,
    nodes_by_rect_id: dict[int, UnityNode],
    canvas_width: float,
    canvas_height: float,
) -> None:
    """按父级 HorizontalLayoutGroup 静态字段修正嵌套 PrefabInstance 的导出坐标。"""

    if not prefab_instances or not nodes_by_rect_id:
        return
    prefab_instance_by_id = {
        _safe_int(item.get("fileId"), 0): item
        for item in prefab_instances
        if _safe_int(item.get("fileId"), 0)
    }
    for parent_rect_id, parent_node in nodes_by_rect_id.items():
        layout = _find_layout_group(parent_node)
        if not layout:
            continue
        ordered_items = _ordered_layout_prefab_instances(parent_node, context, prefab_instance_by_id)
        if not ordered_items:
            continue
        parent_size = _find_parent_rect_size(context, parent_rect_id, canvas_width, canvas_height)
        if not parent_size:
            continue
        _rewrite_layout_instance_rects(ordered_items, layout, parent_size)


def _apply_horizontal_layout_to_prefab_instances(
    prefab_instances: list[dict[str, Any]],
    context: PrefabInstanceContext,
    nodes_by_rect_id: dict[int, UnityNode],
    canvas_width: float,
    canvas_height: float,
) -> None:
    _apply_layout_to_prefab_instances(prefab_instances, context, nodes_by_rect_id, canvas_width, canvas_height)


def _find_horizontal_layout_group(node: UnityNode) -> UnityDocument | None:
    """查找节点上的 Unity HorizontalLayoutGroup 组件。"""

    layout = _find_layout_group(node)
    if layout and ("HorizontalLayoutGroup" in _component_class(layout) or _is_horizontal_layout_group(layout)):
        return layout
    return None


def _ordered_layout_prefab_instances(
    parent_node: UnityNode,
    context: PrefabInstanceContext,
    prefab_instance_by_id: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    """按父 RectTransform 的 m_Children 顺序取出布局组管理的 PrefabInstance。"""

    ordered_items: list[dict[str, Any]] = []
    for child_rect_id in parent_node.child_rect_ids:
        prefab_instance_id = context.prefab_instance_id_by_stripped_rect_id.get(child_rect_id)
        if not prefab_instance_id:
            continue
        item = prefab_instance_by_id.get(prefab_instance_id)
        if item:
            ordered_items.append(item)
    return ordered_items


def _rewrite_layout_instance_rects(
    items: list[dict[str, Any]],
    layout: UnityDocument,
    parent_size: dict[str, float],
) -> None:
    """Apply LayoutGroup-calculated child rects to PrefabInstance overrides."""

    if not items:
        return
    class_id = _component_class(layout)
    if "GridLayoutGroup" in class_id or _is_grid_layout_group(layout):
        parent_width = max(float(parent_size.get("width", 0.0)), 0.0)
        parent_height = max(float(parent_size.get("height", 0.0)), 0.0)
        positions = _calculate_grid_layout_positions(
            count=len(items),
            layout=layout,
            parent_width=parent_width,
            parent_height=parent_height,
        )
        cell_size = _extract_grid_cell_size(layout)
        for item, position in zip(items, positions):
            _assign_layout_rect(item, position["x"], position["y"], cell_size["width"], cell_size["height"], "GridLayoutGroup")
        return
    axis = "vertical" if "VerticalLayoutGroup" in class_id or _is_vertical_layout_group(layout) else "horizontal"
    _rewrite_linear_layout_instance_rects(items, layout, parent_size, axis=axis)


def _rewrite_horizontal_layout_instance_rects(
    items: list[dict[str, Any]],
    layout: UnityDocument,
    parent_size: dict[str, float],
) -> None:
    _rewrite_linear_layout_instance_rects(items, layout, parent_size, axis="horizontal")


def _rewrite_linear_layout_instance_rects(
    items: list[dict[str, Any]],
    layout: UnityDocument,
    parent_size: dict[str, float],
    axis: str,
) -> None:
    if not items:
        return
    padding = _extract_layout_padding(layout.raw)
    spacing = _extract_layout_float(layout.raw, "m_Spacing", 0.0)
    child_alignment = _extract_layout_int(layout.raw, "m_ChildAlignment", 0)
    control_width = _extract_layout_bool(layout.raw, "m_ChildControlWidth", False)
    control_height = _extract_layout_bool(layout.raw, "m_ChildControlHeight", False)
    force_expand_width = _extract_layout_bool(layout.raw, "m_ChildForceExpandWidth", False)
    force_expand_height = _extract_layout_bool(layout.raw, "m_ChildForceExpandHeight", False)
    reverse = _extract_layout_bool(layout.raw, "m_ReverseArrangement", False)

    entries = [_build_layout_child_entry(item) for item in items]
    if reverse:
        entries = list(reversed(entries))

    parent_width = max(float(parent_size.get("width", 0.0)), 0.0)
    parent_height = max(float(parent_size.get("height", 0.0)), 0.0)
    inner_width = max(parent_width - padding["left"] - padding["right"], 0.0)
    inner_height = max(parent_height - padding["top"] - padding["bottom"], 0.0)
    total_spacing = spacing * max(len(entries) - 1, 0)
    horizontal_group = _layout_horizontal_group(child_alignment)
    vertical_group = _layout_vertical_group(child_alignment)
    layout_type = "HorizontalLayoutGroup" if axis == "horizontal" else "VerticalLayoutGroup"
    if axis == "horizontal":
        total_preferred = sum(entry["width"] for entry in entries)
        total_preferred_with_spacing = total_preferred + total_spacing
        flexible_width_count = len(entries) if force_expand_width else 0
        expand_width = (
            max(inner_width - total_preferred_with_spacing, 0.0) / flexible_width_count
            if flexible_width_count
            else 0.0
        )
        x = padding["left"] if flexible_width_count else padding["left"] + _layout_alignment_offset(inner_width, total_preferred_with_spacing, horizontal_group)
        for entry in entries:
            cell_width = entry["width"] + expand_width
            width = cell_width if control_width else entry["width"]
            item_x = x if control_width else x + _layout_alignment_offset(cell_width, width, horizontal_group)
            height = inner_height if control_height else entry["height"]
            y = padding["top"] + _layout_alignment_offset(inner_height, height, vertical_group)
            _assign_layout_rect(entry["item"], item_x, y, width, height, layout_type)
            x += cell_width + spacing
    else:
        total_preferred = sum(entry["height"] for entry in entries)
        total_preferred_with_spacing = total_preferred + total_spacing
        flexible_height_count = len(entries) if force_expand_height else 0
        expand_height = (
            max(inner_height - total_preferred_with_spacing, 0.0) / flexible_height_count
            if flexible_height_count
            else 0.0
        )
        y = padding["top"] if flexible_height_count else padding["top"] + _layout_alignment_offset(inner_height, total_preferred_with_spacing, vertical_group)
        for entry in entries:
            cell_height = entry["height"] + expand_height
            width = inner_width if control_width else entry["width"]
            x = padding["left"] + _layout_alignment_offset(inner_width, width, horizontal_group)
            height = cell_height if control_height else entry["height"]
            item_y = y if control_height else y + _layout_alignment_offset(cell_height, height, vertical_group)
            _assign_layout_rect(entry["item"], x, item_y, width, height, layout_type)
            y += cell_height + spacing


def _build_layout_child_entry(item: dict[str, Any]) -> dict[str, Any]:
    """读取 PrefabInstance 当前尺寸，作为 HorizontalLayoutGroup 的 preferred size。"""

    override = item.get("instanceOverride") or {}
    rect = override.get("rect") or {}
    rect_transform = override.get("rectTransform") or {}
    size_delta = rect_transform.get("m_SizeDelta") if isinstance(rect_transform, dict) else {}
    width = _safe_float(rect.get("width"), _safe_float((size_delta or {}).get("x"), 0.0))
    height = _safe_float(rect.get("height"), _safe_float((size_delta or {}).get("y"), 0.0))
    return {"item": item, "width": max(width, 0.0), "height": max(height, 0.0)}


def _assign_layout_rect(
    item: dict[str, Any],
    x: float,
    y: float,
    width: float,
    height: float,
    layout_type: str = "HorizontalLayoutGroup",
) -> None:
    """把布局组计算出的矩形写回 PrefabInstance override。"""

    override = item.setdefault("instanceOverride", {})
    rect = {"x": _number(x), "y": _number(y), "width": _number(width), "height": _number(height)}
    override["rect"] = rect
    override["layoutResolved"] = {
        "type": layout_type,
        "rect": rect,
    }


def _extract_layout_padding(raw: str) -> dict[str, float]:
    """解析 LayoutGroup 的 RectOffset padding。"""

    return {
        "left": _extract_layout_float(raw, "m_Left", 0.0),
        "right": _extract_layout_float(raw, "m_Right", 0.0),
        "top": _extract_layout_float(raw, "m_Top", 0.0),
        "bottom": _extract_layout_float(raw, "m_Bottom", 0.0),
    }


def _extract_layout_float(raw: str, key: str, default: float) -> float:
    """从组件 YAML 中读取布局浮点字段。"""

    match = re.search(rf"^\s*{re.escape(key)}:\s*({NUMBER_PATTERN})\s*$", raw, re.MULTILINE)
    return float(match.group(1)) if match else default


def _extract_layout_int(raw: str, key: str, default: int) -> int:
    """从组件 YAML 中读取布局整数字段。"""

    return int(_extract_layout_float(raw, key, float(default)))


def _extract_layout_bool(raw: str, key: str, default: bool) -> bool:
    """从组件 YAML 中读取 Unity 布尔字段。"""

    match = re.search(rf"^\s*{re.escape(key)}:\s*(-?\d+)\s*$", raw, re.MULTILINE)
    return bool(int(match.group(1))) if match else default


def _extract_layout_vec2(raw: str, key: str, default_x: float = 0.0, default_y: float = 0.0) -> dict[str, float]:
    pattern = rf"^\s*{re.escape(key)}:\s*\{{\s*x:\s*({NUMBER_PATTERN}),\s*y:\s*({NUMBER_PATTERN})\s*\}}\s*$"
    match = re.search(pattern, raw, re.MULTILINE)
    if not match:
        return {"x": float(default_x), "y": float(default_y)}
    return {"x": float(match.group(1)), "y": float(match.group(2))}


def _extract_grid_cell_size(layout: UnityDocument) -> dict[str, float]:
    value = _extract_layout_vec2(layout.raw, "m_CellSize", 100.0, 100.0)
    return {"width": max(value["x"], 0.0), "height": max(value["y"], 0.0)}


def _extract_grid_spacing(layout: UnityDocument) -> dict[str, float]:
    return _extract_layout_vec2(layout.raw, "m_Spacing", 0.0, 0.0)


def _grid_constraint_counts(layout: UnityDocument, count: int) -> tuple[int, int]:
    count = max(count, 0)
    if count == 0:
        return 0, 0
    constraint = _extract_layout_int(layout.raw, "m_Constraint", 0)
    constraint_count = max(_extract_layout_int(layout.raw, "m_ConstraintCount", 2), 1)
    start_axis = _extract_layout_int(layout.raw, "m_StartAxis", 0)
    if constraint == 1:
        columns = constraint_count
        rows = (count + columns - 1) // columns
    elif constraint == 2:
        rows = constraint_count
        columns = (count + rows - 1) // rows
    elif start_axis == 1:
        rows = count
        columns = 1
    else:
        columns = count
        rows = 1
    return max(columns, 1), max(rows, 1)


def _calculate_grid_layout_positions(
    count: int,
    layout: UnityDocument,
    parent_width: float,
    parent_height: float,
) -> list[dict[str, float]]:
    if count <= 0:
        return []
    padding = _extract_layout_padding(layout.raw)
    cell_size = _extract_grid_cell_size(layout)
    spacing = _extract_grid_spacing(layout)
    child_alignment = _extract_layout_int(layout.raw, "m_ChildAlignment", 0)
    start_corner = _extract_layout_int(layout.raw, "m_StartCorner", 0)
    start_axis = _extract_layout_int(layout.raw, "m_StartAxis", 0)
    columns, rows = _grid_constraint_counts(layout, count)
    used_width = columns * cell_size["width"] + max(columns - 1, 0) * spacing["x"]
    used_height = rows * cell_size["height"] + max(rows - 1, 0) * spacing["y"]
    inner_width = max(parent_width - padding["left"] - padding["right"], 0.0)
    inner_height = max(parent_height - padding["top"] - padding["bottom"], 0.0)
    start_x = padding["left"] + _layout_alignment_offset(inner_width, used_width, _layout_horizontal_group(child_alignment))
    start_y = padding["top"] + _layout_alignment_offset(inner_height, used_height, _layout_vertical_group(child_alignment))
    reverse_x = start_corner in (1, 3)
    reverse_y = start_corner in (2, 3)
    positions: list[dict[str, float]] = []
    for index in range(count):
        if start_axis == 1:
            row = index % rows
            column = index // rows
        else:
            column = index % columns
            row = index // columns
        if reverse_x:
            column = columns - 1 - column
        if reverse_y:
            row = rows - 1 - row
        positions.append({
            "x": start_x + column * (cell_size["width"] + spacing["x"]),
            "y": start_y + row * (cell_size["height"] + spacing["y"]),
        })
    return positions


def _layout_horizontal_group(child_alignment: int) -> int:
    """Unity TextAnchor 的水平分组：0 左，1 中，2 右。"""

    return child_alignment % 3


def _layout_vertical_group(child_alignment: int) -> int:
    """Unity TextAnchor 的垂直分组：0 上，1 中，2 下。"""

    return child_alignment // 3


def _layout_alignment_offset(available: float, used: float, group: int) -> float:
    """根据 Unity TextAnchor 分组计算布局起点偏移。"""

    extra = available - used
    if group == 1:
        return extra * 0.5
    if group == 2:
        return extra
    return 0.0


def _build_prefab_instance_override(
    raw: str,
    project_root: Path | None,
    guid_index: dict[str, Path],
    context: PrefabInstanceContext | None = None,
    canvas_width: float = 1080,
    canvas_height: float = 2160,
) -> dict[str, Any]:
    """解析嵌套 PrefabInstance 的根节点名称、父节点和 RectTransform override。"""

    modifications = _parse_variant_modifications(raw)
    if not modifications:
        return {}

    transform_parent = _unity_ref_to_dict(extract_ref(raw, "m_TransformParent"))
    header_match = re.search(r"^--- !u!1001 &(-?\d+)", raw, re.MULTILINE)
    prefab_instance_id = _safe_int(header_match.group(1), 0) if header_match else 0
    rect_target_id = _find_prefab_instance_rect_target_id(modifications, context, prefab_instance_id)
    name = _find_prefab_instance_name_override(modifications)
    rect_fields = _build_prefab_instance_rect_fields(modifications, rect_target_id)

    result: dict[str, Any] = {}
    if transform_parent:
        result["parentRectId"] = transform_parent.get("fileID", "")
    if rect_target_id is not None:
        result["sourceRectFileId"] = str(rect_target_id)
    if name:
        result["name"] = name
    result["modifications"] = [_compact_prefab_modification(mod) for mod in modifications]
    result["hasComplexOverride"] = any(
        _is_complex_prefab_instance_modification(mod, rect_target_id)
        for mod in modifications
    )
    if rect_fields:
        result["rectTransform"] = rect_fields
        result["constraints"] = _rect_transform_to_dict(rect_fields)["constraints"]
    if transform_parent and rect_fields:
        parent_size = _find_parent_rect_size(context, transform_parent.get("fileID", ""), canvas_width, canvas_height)
        if parent_size:
            resolved = resolve_rect(rect_fields, parent_size["width"], parent_size["height"]).rounded()
            result["rect"] = _rect_to_dict(resolved)
    return result


def _compact_prefab_modification(mod: dict[str, Any]) -> dict[str, Any]:
    """输出 PrefabInstance modification 的稳定 JSON 子集。"""

    return {
        "fileID": int(mod.get("fileID", 0)),
        "propertyPath": str(mod.get("propertyPath") or ""),
        "value": str(mod.get("value") or ""),
        "objectReference": str(mod.get("objectReference") or "{fileID: 0}"),
    }


def _is_complex_prefab_instance_modification(
    mod: dict[str, Any],
    rect_target_id: int | None,
) -> bool:
    """判断单条 modification 是否会改变子 Prefab 内部视觉或脚本状态。"""

    property_path = str(mod.get("propertyPath") or "")
    if property_path == "m_Name":
        return False
    if rect_target_id is not None and int(mod.get("fileID", 0)) == rect_target_id and _is_rect_transform_property_path(property_path):
        return False
    return True


def _find_prefab_instance_rect_target_id(
    modifications: list[dict[str, Any]],
    context: PrefabInstanceContext | None = None,
    prefab_instance_id: int = 0,
) -> int | None:
    """从 m_Modifications 中找出被覆盖的根 RectTransform target fileID。"""

    preferred_ids: list[int] = []
    if context and prefab_instance_id:
        preferred_ids = context.stripped_source_rect_ids_by_prefab_instance.get(prefab_instance_id, [])
    for source_id in preferred_ids:
        for mod in modifications:
            if int(mod["fileID"]) != source_id:
                continue
            if str(mod.get("propertyPath", "")).startswith(("m_AnchoredPosition.", "m_SizeDelta.", "m_AnchorMin.", "m_AnchorMax.")):
                return source_id
    for mod in modifications:
        if str(mod.get("propertyPath", "")).startswith(("m_AnchoredPosition.", "m_SizeDelta.", "m_AnchorMin.", "m_AnchorMax.")):
            return int(mod["fileID"])
    return None


def _find_prefab_instance_name_override(modifications: list[dict[str, Any]]) -> str:
    """读取嵌套 PrefabInstance 的 m_Name override。"""

    for mod in modifications:
        if mod.get("propertyPath") == "m_Name":
            return str(mod.get("value") or "")
    return ""


def _build_prefab_instance_rect_fields(
    modifications: list[dict[str, Any]],
    rect_target_id: int | None,
) -> dict[str, Any]:
    """把 RectTransform override 聚合为 resolve_rect 可消费的字段字典。"""

    if rect_target_id is None:
        return {}
    fields = {
        "m_AnchorMin": {"x": 0.5, "y": 0.5},
        "m_AnchorMax": {"x": 0.5, "y": 0.5},
        "m_SizeDelta": {"x": 0.0, "y": 0.0},
        "m_Pivot": {"x": 0.5, "y": 0.5},
        "m_AnchoredPosition": {"x": 0.0, "y": 0.0},
        "m_LocalScale": {"x": 1.0, "y": 1.0, "z": 1.0},
        "m_LocalRotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
    }
    mapping = {
        "m_AnchorMin": ("m_AnchorMin", ("x", "y")),
        "m_AnchorMax": ("m_AnchorMax", ("x", "y")),
        "m_SizeDelta": ("m_SizeDelta", ("x", "y")),
        "m_Pivot": ("m_Pivot", ("x", "y")),
        "m_AnchoredPosition": ("m_AnchoredPosition", ("x", "y")),
        "m_LocalScale": ("m_LocalScale", ("x", "y", "z")),
        "m_LocalRotation": ("m_LocalRotation", ("x", "y", "z", "w")),
    }
    for mod in modifications:
        if int(mod["fileID"]) != rect_target_id:
            continue
        prop_path = str(mod.get("propertyPath") or "")
        if "." not in prop_path:
            continue
        field_name, sub_key = prop_path.rsplit(".", 1)
        if field_name not in mapping:
            continue
        target_field, allowed_keys = mapping[field_name]
        if sub_key not in allowed_keys:
            continue
        fields[target_field][sub_key] = _safe_float(mod.get("value"), fields[target_field][sub_key])
    return fields


def _find_parent_rect_size(
    context: PrefabInstanceContext | None,
    parent_rect_id: str | int,
    canvas_width: float = 1080,
    canvas_height: float = 2160,
) -> dict[str, float]:
    """从同一 Prefab YAML 的 RectTransform documents 中查找父节点尺寸。"""

    if not context:
        return {}
    parent_id = parent_rect_id if isinstance(parent_rect_id, int) else _safe_int(parent_rect_id, 0)
    stripped_size = context.stripped_rect_size_by_id.get(parent_id)
    if stripped_size:
        return stripped_size
    doc = context.rect_documents_by_id.get(parent_id)
    if doc:
        parent_size = _resolve_parent_rect_size_from_doc(doc, canvas_width, canvas_height)
        if parent_size:
            return parent_size
    # Fallback: parent not found in same prefab → use canvas
    return {"width": canvas_width, "height": canvas_height}


def _resolve_parent_rect_size_from_doc(
    doc: UnityDocument,
    canvas_width: float,
    canvas_height: float,
) -> dict[str, float]:
    """从 RectTransform 文档解析父节点尺寸。"""

    anchor_min = _parse_vec2_field(doc.raw, "m_AnchorMin")
    anchor_max = _parse_vec2_field(doc.raw, "m_AnchorMax")
    size_delta = _parse_vec2_field(doc.raw, "m_SizeDelta")
    if not anchor_min or not anchor_max or not size_delta:
        return {}
    span_w = anchor_max["x"] - anchor_min["x"]
    span_h = anchor_max["y"] - anchor_min["y"]
    # 固定锚点：父尺寸直接来自 sizeDelta。
    if span_w < 0.01 and span_h < 0.01:
        return {"width": abs(size_delta["x"]), "height": abs(size_delta["y"])}
    w = span_w * canvas_width + size_delta["x"]
    h = span_h * canvas_height + size_delta["y"]
    return {"width": max(w, 1.0), "height": max(h, 1.0)}


def _parse_vec2_field(raw: str, field_name: str) -> dict[str, float] | None:
    """从 YAML raw 中解析 {x: val, y: val} 类型的向量字段。"""
    m = re.search(
        rf'{re.escape(field_name)}:\s*{{x:\s*([\d.-]+),\s*y:\s*([\d.-]+)}}',
        raw,
    )
    if not m:
        return None
    return {"x": float(m.group(1)), "y": float(m.group(2))}


def _attach_prefab_asset_path(
    source_prefab: dict[str, Any],
    project_root: Path | None,
    guid_index: dict[str, Path],
) -> None:
    """把 PrefabInstance 的 source guid 解析为项目内 Prefab 路径。"""

    guid = (source_prefab.get("guid") or "").lower()
    if not guid:
        return
    meta_path = guid_index.get(guid)
    if not meta_path:
        return
    asset_path = Path(meta_path).with_suffix("")
    source_prefab["assetExists"] = asset_path.exists()
    source_prefab["assetType"] = asset_path.suffix.lower()
    if project_root:
        source_prefab["assetPath"] = _relative_path(asset_path, project_root)
    else:
        source_prefab["assetPath"] = str(asset_path)


def _build_prefab_instance_warning(prefab_instances: list[dict[str, Any]]) -> str:
    """生成嵌套 PrefabInstance 的报告 warning。"""

    source_guids = [
        item.get("sourcePrefab", {}).get("guid")
        for item in prefab_instances
        if item.get("sourcePrefab", {}).get("guid")
    ]
    source_summary = ", ".join(source_guids[:5])
    if len(source_guids) > 5:
        source_summary += f", ... (+{len(source_guids) - 5})"
    if source_summary:
        return (
            f"PrefabInstance documents detected: {len(prefab_instances)}; "
            f"nested Prefab contents are not merged by the static parser. Source GUIDs: {source_summary}"
        )
    return (
        f"PrefabInstance documents detected: {len(prefab_instances)}; "
        "nested Prefab contents are not merged by the static parser."
    )


def _unity_ref_to_dict(value: dict[str, Any]) -> dict[str, Any]:
    """将 Unity 引用字段转换为字符串稳定的 JSON 字典。"""

    result: dict[str, Any] = {}
    if "fileID" in value:
        result["fileID"] = str(value["fileID"])
    if "guid" in value:
        result["guid"] = value["guid"]
    if "type" in value:
        result["type"] = value["type"]
    return result


def _sprite_asset_to_dict(sprite_asset: SpriteAsset, project_root: Path) -> dict[str, Any]:
    """将 SpriteAsset 转换为可 JSON 序列化的数据。"""

    return {
        "guid": sprite_asset.guid,
        "assetPath": _relative_path(Path(sprite_asset.asset_path), project_root),
        "metaPath": _relative_path(Path(sprite_asset.meta_path), project_root),
        "width": sprite_asset.width,
        "height": sprite_asset.height,
        "border": sprite_asset.border,
        "pixelsToUnits": sprite_asset.pixels_to_units,
    }


def _slice_to_dict(slice_item: Any) -> dict[str, Any]:
    """将九宫切片对象转换为 JSON 字典。"""

    if is_dataclass(slice_item):
        data = asdict(slice_item)
    else:
        data = dict(slice_item)
    return {
        "name": data["name"],
        "target": _rect_tuple_to_dict(data["target"]),
        "source": _rect_tuple_to_dict(data["source"]),
    }


def _rect_tuple_to_dict(value: Any) -> dict[str, float]:
    """将 `(x, y, width, height)` 转换为矩形字典。"""

    if isinstance(value, dict):
        return value
    x, y, width, height = value
    return {"x": _number(x), "y": _number(y), "width": _number(width), "height": _number(height)}


def _rect_to_dict(rect: Rect) -> dict[str, float]:
    """将 Rect dataclass 转换为 JSON 字典。"""

    return {
        "x": _number(rect.x),
        "y": _number(rect.y),
        "width": _number(rect.width),
        "height": _number(rect.height),
        "rotationZ": _number(rect.rotation_z),
    }


def _rect_transform_to_dict(fields: dict[str, Any]) -> dict[str, Any]:
    """Serialize Unity RectTransform anchors and their Figma Constraints mapping."""

    anchor_min = _vec2_to_dict(fields.get("m_AnchorMin"), {"x": 0.5, "y": 0.5})
    anchor_max = _vec2_to_dict(fields.get("m_AnchorMax"), anchor_min)
    pivot = _vec2_to_dict(fields.get("m_Pivot"), {"x": 0.5, "y": 0.5})
    anchored_position = _vec2_to_dict(fields.get("m_AnchoredPosition"), {"x": 0.0, "y": 0.0})
    size_delta = _vec2_to_dict(fields.get("m_SizeDelta"), {"x": 0.0, "y": 0.0})
    constraints = _unity_anchors_to_figma_constraints(anchor_min, anchor_max)
    return {
        "anchorMin": anchor_min,
        "anchorMax": anchor_max,
        "pivot": pivot,
        "anchoredPosition": anchored_position,
        "sizeDelta": size_delta,
        "constraints": constraints,
    }


def _vec2_to_dict(value: Any, fallback: dict[str, float]) -> dict[str, float]:
    """Convert a Unity vector-like mapping to a stable JSON vec2."""

    if not isinstance(value, dict):
        value = fallback
    return {
        "x": _number(_safe_float(value.get("x"), fallback["x"])),
        "y": _number(_safe_float(value.get("y"), fallback["y"])),
    }


def _unity_anchors_to_figma_constraints(anchor_min: dict[str, float], anchor_max: dict[str, float]) -> dict[str, str]:
    """Map Unity RectTransform anchors to nearest Figma Constraints."""

    return {
        "horizontal": _unity_anchor_axis_to_constraint(anchor_min["x"], anchor_max["x"], "x"),
        "vertical": _unity_anchor_axis_to_constraint(anchor_min["y"], anchor_max["y"], "y"),
    }


def _unity_anchor_axis_to_constraint(min_value: float, max_value: float, axis: str) -> str:
    """Convert one Unity anchor axis to a Figma constraint token."""

    if _approximately(min_value, 0.0) and _approximately(max_value, 1.0):
        return "STRETCH"
    center = (float(min_value) + float(max_value)) * 0.5
    if axis == "y":
        if _approximately(center, 1.0):
            return "MIN"
        if _approximately(center, 0.0):
            return "MAX"
    else:
        if _approximately(center, 0.0):
            return "MIN"
        if _approximately(center, 1.0):
            return "MAX"
    return "CENTER"


def _approximately(a: float, b: float, epsilon: float = 0.001) -> bool:
    return abs(float(a) - float(b)) <= epsilon


def _without_children(node: dict[str, Any]) -> dict[str, Any]:
    """生成扁平节点列表项，避免重复嵌套完整子树。"""

    item = dict(node)
    item["children"] = [child.get("id") for child in node.get("children", [])]
    return item


def _calculate_visual_bounds(root_node: dict[str, Any]) -> dict[str, int | float]:
    """计算根节点局部坐标下的完整视觉包围盒，供 Figma 外层包裹使用。"""

    if not root_node:
        return {}

    bounds = {
        "minX": 0.0,
        "minY": 0.0,
        "maxX": float(root_node.get("rect", {}).get("width", 0.0)),
        "maxY": float(root_node.get("rect", {}).get("height", 0.0)),
    }

    def visit(node: dict[str, Any], offset_x: float, offset_y: float, include_self: bool) -> None:
        rect = node.get("rect", {})
        node_x = offset_x + float(rect.get("x", 0.0))
        node_y = offset_y + float(rect.get("y", 0.0))
        node_width = float(rect.get("width", 0.0))
        node_height = float(rect.get("height", 0.0))
        if include_self and _node_contributes_visual_bounds(node):
            bounds["minX"] = min(bounds["minX"], node_x)
            bounds["minY"] = min(bounds["minY"], node_y)
            bounds["maxX"] = max(bounds["maxX"], node_x + node_width)
            bounds["maxY"] = max(bounds["maxY"], node_y + node_height)
        for child in node.get("children", []):
            visit(child, node_x, node_y, True)

    for child_node in root_node.get("children", []):
        visit(child_node, 0.0, 0.0, True)

    return {
        "x": _number(bounds["minX"]),
        "y": _number(bounds["minY"]),
        "width": _number(bounds["maxX"] - bounds["minX"]),
        "height": _number(bounds["maxY"] - bounds["minY"]),
    }


def _node_contributes_visual_bounds(node: dict[str, Any]) -> bool:
    image = node.get("image")
    if isinstance(image, dict) and (image.get("missingSprite") or image.get("mode") == "placeholder"):
        return False
    return True


def _format_bounds(bounds: dict[str, Any]) -> str:
    """格式化包围盒数据，便于 Markdown 报告阅读。"""

    if not bounds:
        return "None"
    return f"{bounds.get('x', 0)},{bounds.get('y', 0)} {bounds.get('width', 0)}x{bounds.get('height', 0)}"


def _relative_path(path: Path, root: Path) -> str:
    """尽量输出相对仓库根目录的路径。"""

    path = path.resolve()
    root = root.resolve()
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _resolve_export_canvas(documents: list[UnityDocument], canvas: tuple[float, float] | None) -> tuple[float, float]:
    """解析最终导出 Canvas 尺寸，支持从根 RectTransform 自动推导。"""

    if canvas is not None:
        return canvas
    return _derive_canvas_from_root_rect(documents)


def _derive_canvas_from_root_rect(documents: list[UnityDocument]) -> tuple[float, float]:
    """从根节点推导 Canvas 尺寸。优先使用 CanvasScaler.referenceResolution，回退到 SizeDelta。"""

    root_node, _, _ = build_node_tree(documents)
    if root_node is None:
        raise ValueError("Canvas auto requires a root RectTransform.")

    # 尝试从 CanvasScaler 获取 referenceResolution
    # CanvasScaler 是 MonoBehaviour，通过 m_EditorClassIdentifier 识别
    for doc in documents:
        if doc.type_name == "MonoBehaviour":
            class_id = doc.fields.get("m_EditorClassIdentifier", "")
            if "CanvasScaler" in class_id:
                ref_res = doc.fields.get("m_ReferenceResolution")
                if ref_res:
                    w = abs(float(ref_res.get("x", 0.0)))
                    h = abs(float(ref_res.get("y", 0.0)))
                    if w > 0.0 and h > 0.0:
                        return w, h

    # 回退到 SizeDelta * LocalScale
    size_delta = root_node.rect.get("m_SizeDelta") or {}
    local_scale = root_node.rect.get("m_LocalScale") or {}
    width = abs(float(size_delta.get("x", 0.0)) * float(local_scale.get("x", 1.0)))
    height = abs(float(size_delta.get("y", 0.0)) * float(local_scale.get("y", 1.0)))
    if width <= 0.0 or height <= 0.0:
        _, nodes_by_rect_id, _ = build_node_tree(documents)
        fallback_width, fallback_height = _derive_canvas_from_child_rects(root_node, nodes_by_rect_id)
        if fallback_width > 0.0 and fallback_height > 0.0:
            return fallback_width, fallback_height
        raise ValueError("Canvas auto requires root RectTransform m_SizeDelta, CanvasScaler referenceResolution, or a positive child RectTransform.")
    return width, height


def _derive_canvas_from_child_rects(root_node: UnityNode, nodes_by_rect_id: dict[int, UnityNode]) -> tuple[float, float]:
    """根节点缺少父尺寸时，从后代节点的正尺寸中兜底推导。"""

    pending = list(root_node.child_rect_ids)
    while pending:
        node = nodes_by_rect_id.get(pending.pop(0))
        if node is None:
            continue
        size_delta = node.rect.get("m_SizeDelta") or {}
        local_scale = node.rect.get("m_LocalScale") or {}
        width = abs(float(size_delta.get("x", 0.0)) * float(local_scale.get("x", 1.0)))
        height = abs(float(size_delta.get("y", 0.0)) * float(local_scale.get("y", 1.0)))
        if width > 0.0 and height > 0.0:
            return width, height
        pending.extend(node.child_rect_ids)
    return 0.0, 0.0


def _select_guid_index_root(project_root: Path, prefab_path: Path) -> Path:
    """选择 GUID 索引扫描根目录，优先限制在 Unity Assets 目录内。"""

    project_root = Path(project_root).resolve()
    prefab_path = Path(prefab_path).resolve()
    for ancestor in (prefab_path, *prefab_path.parents):
        if ancestor.name != "Assets" or not ancestor.exists():
            continue
        for candidate in (project_root / "Assets",):
            candidate = candidate.resolve()
            if candidate.exists() and _is_path_within(prefab_path, candidate):
                return candidate
        return ancestor

    for candidate in (project_root / "Assets",):
        if candidate.exists():
            return candidate

    return project_root


def _is_path_within(path: Path, root: Path) -> bool:
    """Return True when path is under root, after resolving both paths."""

    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _number(value: float) -> int | float:
    """将整数浮点压缩为 int，保持 JSON 稳定可读。精度为 6 位小数。"""

    rounded = round(float(value), 6)
    if rounded.is_integer():
        return int(rounded)
    return rounded


def _strict_failure_reasons(package: dict[str, Any]) -> list[str]:
    """按严格模式规则收集不可自动继续的导出问题。"""

    reasons = list(package.get("fatalErrors") or [])
    prefab_instances = package.get("prefabInstances") or []
    if prefab_instances:
        reasons.append(f"PrefabInstance documents detected: {len(prefab_instances)}")
    for warning in package.get("warnings") or []:
        if _is_inactive_image_sprite_warning(warning, package):
            continue
        if _is_missing_sprite_placeholder_warning(warning, package):
            continue
        if any(marker in warning for marker in STRICT_WARNING_MARKERS):
            reasons.append(warning)
    return reasons


def _run_self_test() -> None:
    """运行 CLI 的内存自测。"""

    sample = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 40}
  - component: {fileID: 50}
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
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 10}
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
--- !u!114 &50
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.RectMask2D
--- !u!1001 &70
PrefabInstance:
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
"""
    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Memory.prefab",
        documents=parse_unity_documents(sample),
        canvas=(1080.0, 1920.0),
        guid_index={},
    )
    assert package["root"]["name"] == "Root"
    assert package["stats"]["nodeCount"] == 2
    assert package["stats"]["textCount"] == 1
    assert package["stats"]["clipCount"] == 1
    assert package["stats"]["prefabInstanceCount"] == 1
    assert package["root"]["text"]["content"] == "群组"
    assert package["root"]["text"]["autoSize"] == {"enabled": True, "min": 18, "max": 72}
    assert package["root"]["text"]["alignment"] == {"horizontal": 2, "vertical": 512, "legacy": 65535}
    assert package["root"]["text"]["options"] == {
        "fontStyle": 0,
        "wordWrapping": False,
        "overflowMode": 0,
        "richText": True,
    }
    assert package["root"]["clip"]["componentType"] == "UnityEngine.UI::UnityEngine.UI.RectMask2D"
    assert package["root"]["children"][0]["name"] == "Child"
    assert package["nodes"][0]["children"] == ["30"]
    assert package["prefabInstances"][0]["sourcePrefab"]["guid"] == "0123456789abcdef0123456789abcdef"
    assert package["root"]["rect"]["x"] == 490
    assert package["root"]["rect"]["y"] == 935
    assert package["visualBounds"] == {"x": 0, "y": 0, "width": 100, "height": 50}
    assert parse_canvas("auto") is None
    assert _derive_canvas_from_root_rect(parse_unity_documents(sample)) == (100.0, 50.0)
    stretch_sample = sample.replace("m_AnchorMin: {x: 0.5, y: 0.5}", "m_AnchorMin: {x: 0, y: 0}", 1)
    stretch_sample = stretch_sample.replace("m_AnchorMax: {x: 0.5, y: 0.5}", "m_AnchorMax: {x: 1, y: 1}", 1)
    stretch_sample = stretch_sample.replace("m_SizeDelta: {x: 100, y: 50}", "m_SizeDelta: {x: 0, y: 0}", 1)
    assert _derive_canvas_from_root_rect(parse_unity_documents(stretch_sample)) == (10.0, 5.0)
    assert _strict_failure_reasons(package) == ["PrefabInstance documents detected: 1"]
    print("prefab_to_figma self-test passed")


def main() -> int:
    """CLI 入口。"""

    parser = argparse.ArgumentParser(description="Static Unity UGUI Prefab to Figma intermediate exporter")
    parser.add_argument("--project-root", "--unity-project", dest="project_root", default=".",
                        help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--prefab")
    parser.add_argument("--canvas")
    parser.add_argument("--out")
    parser.add_argument("--batch-dir", help="递归扫描目录下所有 .prefab 并批量导出")
    parser.add_argument("--prefab-list", help="读取文本文件中的 .prefab 路径并批量导出，每行一个路径")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        _run_self_test()
        return 0

    try:
        args.project_root = str(resolve_unity_project(args.project_root, env={}))
    except RuntimeError as error:
        parser.error(str(error))

    if args.batch_dir:
        return _run_batch(args)

    if args.prefab_list:
        return _run_prefab_list(args)

    if not args.prefab or not args.canvas or not args.out:
        parser.error("--prefab, --canvas and --out are required unless --self-test, --batch-dir, or --prefab-list is used")

    project_root = Path(args.project_root).resolve()
    prefab_path = Path(args.prefab)
    if not prefab_path.is_absolute():
        prefab_path = project_root / prefab_path
    canvas = parse_canvas(args.canvas)
    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = project_root / out_dir

    package = export_prefab(project_root, prefab_path.resolve(), canvas, out_dir)
    print(f"wrote {out_dir / 'prefab-to-figma.json'}")
    print(f"wrote {out_dir / 'report.md'}")
    print(f"nodeCount={package['stats']['nodeCount']}")
    if args.strict:
        strict_reasons = _strict_failure_reasons(package)
        if strict_reasons:
            print("strict mode failed:", file=sys.stderr)
            for reason in strict_reasons:
                print(f"- {reason}", file=sys.stderr)
            return 2
    return 0


def _run_batch(args: argparse.Namespace) -> int:
    """批量模式：递归扫描目录下所有 .prefab，共享 GUID 索引，逐个导出。"""

    import time

    project_root = Path(args.project_root).resolve()
    batch_dir = Path(args.batch_dir)
    if not batch_dir.is_absolute():
        batch_dir = project_root / batch_dir
    if not batch_dir.exists():
        print(f"batch-dir does not exist: {batch_dir}", file=sys.stderr)
        return 1

    canvas = parse_canvas(args.canvas) if args.canvas else None
    out_base = Path(args.out) if args.out else Path(".tmp/prefab-to-figma")
    if not out_base.is_absolute():
        out_base = project_root / out_base

    # 递归收集所有 .prefab 文件。
    prefab_files = sorted(batch_dir.rglob("*.prefab"))
    if not prefab_files:
        print(f"No .prefab files found in {batch_dir}", file=sys.stderr)
        return 1
    print(f"Found {len(prefab_files)} prefabs in {batch_dir}")

    return _run_batch_files(project_root, prefab_files, canvas, out_base)


def _run_prefab_list(args: argparse.Namespace) -> int:
    """批量模式：读取文本列表中的多个 .prefab 路径，共享 GUID 索引，逐个导出。"""

    project_root = Path(args.project_root).resolve()
    list_path = Path(args.prefab_list)
    if not list_path.is_absolute():
        list_path = project_root / list_path
    if not list_path.exists():
        print(f"prefab-list does not exist: {list_path}", file=sys.stderr)
        return 1

    canvas = parse_canvas(args.canvas) if args.canvas else None
    out_base = Path(args.out) if args.out else Path(".tmp/prefab-to-figma")
    if not out_base.is_absolute():
        out_base = project_root / out_base

    prefab_files = _read_prefab_list(project_root, list_path)
    if not prefab_files:
        print(f"No .prefab paths found in {list_path}", file=sys.stderr)
        return 1
    print(f"Found {len(prefab_files)} prefabs in {list_path}")

    return _run_batch_files(project_root, prefab_files, canvas, out_base)


def _read_prefab_list(project_root: Path, list_path: Path) -> list[Path]:
    """读取 Prefab 路径列表，忽略空行和以 # 开头的注释行。"""

    prefab_files: list[Path] = []
    for line_number, raw_line in enumerate(list_path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        prefab_path = Path(line)
        if not prefab_path.is_absolute():
            prefab_path = project_root / prefab_path
        if prefab_path.suffix.lower() != ".prefab":
            raise ValueError(f"Line {line_number} is not a .prefab path: {raw_line}")
        if not prefab_path.exists():
            raise FileNotFoundError(f"Line {line_number} prefab does not exist: {prefab_path}")
        prefab_files.append(prefab_path)
    return prefab_files


def _run_batch_files(project_root: Path, prefab_files: list[Path], canvas: tuple[float, float] | None, out_base: Path) -> int:
    """批量导出给定 Prefab 文件列表，共享 GUID 索引和材质缓存以减少重复扫描。"""

    import time

    # 构建一次 GUID 索引（最耗时的步骤）
    t0 = time.time()
    guid_index_root = _select_guid_index_root(project_root, prefab_files[0])
    guid_index = build_guid_index(guid_index_root)
    t_index = time.time() - t0
    print(f"GUID index built in {t_index:.2f}s ({len(guid_index)} entries)")

    # 逐个解析
    success_count = 0
    fail_count = 0
    material_cache: dict[str, dict[str, Any] | None] = {}
    used_out_names: set[str] = set()
    for prefab_path in prefab_files:
        out_dir = _get_batch_output_dir(project_root, out_base, prefab_path, used_out_names)
        try:
            documents = load_unity_documents(prefab_path)
            resolved_canvas = _resolve_export_canvas(documents, canvas)
            prefab_relative = _relative_path(prefab_path, project_root)
            package = build_package(
                project_root=project_root,
                prefab_path=prefab_relative,
                documents=documents,
                canvas=resolved_canvas,
                guid_index=guid_index,
                material_cache=material_cache,
            )
            write_outputs(package, out_dir)
            node_count = package["stats"]["nodeCount"]
            print(f"  {prefab_path.stem}: {node_count} nodes -> {_relative_path(out_dir, project_root)}")
            success_count += 1
        except Exception as e:
            print(f"  {prefab_path.stem}: FAILED - {e}", file=sys.stderr)
            fail_count += 1

    total = time.time() - t0
    print(f"Batch complete: {success_count} ok, {fail_count} failed, {total:.2f}s total")
    return 0 if fail_count == 0 else 1


def _get_batch_output_dir(project_root: Path, out_base: Path, prefab_path: Path, used_names: set[str]) -> Path:
    """生成批量导出的输出目录名，同名 Prefab 自动附加相对路径摘要避免覆盖。"""

    name = prefab_path.stem
    if name not in used_names:
        used_names.add(name)
        return out_base / name

    relative = Path(_relative_path(prefab_path, project_root))
    safe_suffix = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(relative.with_suffix("")))
    unique_name = f"{name}_{safe_suffix}"
    index = 2
    while unique_name in used_names:
        unique_name = f"{name}_{safe_suffix}_{index}"
        index += 1
    used_names.add(unique_name)
    return out_base / unique_name


if __name__ == "__main__":
    raise SystemExit(main())
