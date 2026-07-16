#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""运行 prefab-to-figma 的轻量 golden fixture 回归检查。"""

from __future__ import annotations

from pathlib import Path
import os
import sys
import tempfile
from typing import Any
import struct
import zlib


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from prefab_to_figma import (  # noqa: E402
    _derive_canvas_from_root_rect,
    _select_guid_index_root,
    _strict_failure_reasons,
    build_export_audit_report,
    build_package,
    build_report,
    parse_canvas,
)
from build_figma_write_plan import build_figma_write_plan, build_write_plan_audit_report  # noqa: E402
from compare_unity_truth import compare_package  # noqa: E402
from rect_transform import extract_rotation_z  # noqa: E402
from prefab_to_figma_mcp_client import build_asset_entries, build_verify_report  # noqa: E402
from unity_yaml import parse_unity_documents  # noqa: E402


def configured_unity_project() -> Path | None:
    raw = os.environ.get("FIGMA_UNITY_PROJECT", "").strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser().resolve()
    if (candidate / "Assets").is_dir() and (candidate / "ProjectSettings").is_dir():
        return candidate
    return None


def main() -> int:
    """执行所有 golden fixture 检查。"""

    _check_guid_index_root_uses_full_unity_assets_fixture()
    _check_active_missing_sprite_placeholder_fixture()
    _check_image_without_sprite_placeholder_fixture()
    _check_missing_sprite_child_does_not_expand_visual_bounds_fixture()
    _check_raw_image_missing_texture_placeholder_fixture()
    _check_inactive_missing_sprite_does_not_block_fixture()
    _check_text_clip_prefab_instance_fixture()
    _check_image_visual_fields_fixture()
    _check_text_animator_does_not_replace_tmp_fixture()
    _check_scaled_parent_uses_unscaled_layout_size_fixture()
    _check_horizontal_layout_prefab_instance_fixture()
    _check_vertical_layout_prefab_instance_fixture()
    _check_grid_layout_children_fixture()
    _check_grid_layout_prefab_instance_fixture()
    _check_vertical_layout_content_size_fitter_fixture()
    _check_auto_canvas_falls_back_to_child_rect_fixture()
    _check_nested_prefab_instance_uses_stripped_parent_override_size_fixture()
    _check_rotation_prefers_euler_hint_fixture()
    _check_rect_transform_constraints_export_fixture()
    _check_tmp_material_layer_name_fixture()
    _check_mcp_client_fixture()
    _check_unity_truth_duplicate_names_are_matched_by_structure_fixture()
    _check_unity_truth_skipped_subtree_downgraded_to_warning_fixture()
    _check_unity_truth_unexpected_missing_node_blocks_fixture()
    _check_fatal_fixture()
    print("prefab-to-figma golden tests passed")
    return 0


def _check_guid_index_root_uses_full_unity_assets_fixture() -> None:
    """验证 prefab 在 Assets 子目录时，GUID 索引仍覆盖完整 Unity Assets。"""

    project_root = configured_unity_project()
    if project_root is None:
        return
    prefab_path = project_root / "Assets" / "MagicWarrior" / "Assets" / "Resources" / "GUi" / "RuntimeOneBtnTips.prefab"
    if not prefab_path.exists():
        return
    root = _select_guid_index_root(project_root, prefab_path)
    assert root == (project_root / "Assets").resolve(), root


def _check_active_missing_sprite_placeholder_fixture() -> None:
    """验证 active Image 的 Sprite 解析失败会阻塞导出审计。"""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/MissingSprite.prefab",
        documents=parse_unity_documents(_MISSING_SPRITE_IMAGE_PREFAB_YAML),
        canvas=(100, 100),
        guid_index={},
    )
    assert package["stats"]["imageCount"] == 1
    assert package["root"]["image"]["missingSprite"] is True
    assert package["root"]["image"]["mode"] == "placeholder"
    assert any("Sprite guid not found in index" in warning for warning in package["warnings"])
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True
    assert audit_report["checks"]["strictBlockingWarnings"]["pass"] is True
    assert audit_report["checks"]["spriteAssetsResolved"]["pass"] is True


def _check_raw_image_missing_texture_placeholder_fixture() -> None:
    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/MissingRawImageTexture.prefab",
        documents=parse_unity_documents(_MISSING_RAW_IMAGE_TEXTURE_PREFAB_YAML),
        canvas=(100, 100),
        guid_index={},
    )
    assert package["stats"]["imageCount"] == 1
    assert package["root"]["image"]["componentType"] == "RawImage"
    assert package["root"]["image"]["missingSprite"] is True
    assert package["root"]["image"]["mode"] == "placeholder"
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True
    assert audit_report["checks"]["strictBlockingWarnings"]["pass"] is True
    assert audit_report["checks"]["spriteAssetsResolved"]["pass"] is True


def _check_image_without_sprite_placeholder_fixture() -> None:
    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/ImageWithoutSprite.prefab",
        documents=parse_unity_documents(_IMAGE_WITHOUT_SPRITE_PREFAB_YAML),
        canvas=(100, 100),
        guid_index={},
    )
    assert package["stats"]["imageCount"] == 1
    assert package["root"]["image"]["guid"] == ""
    assert package["root"]["image"]["missingSprite"] is True
    assert package["root"]["image"]["mode"] == "placeholder"
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True
    assert audit_report["checks"]["strictBlockingWarnings"]["pass"] is True
    assert audit_report["checks"]["spriteAssetsResolved"]["pass"] is True


def _check_missing_sprite_child_does_not_expand_visual_bounds_fixture() -> None:
    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/MissingSpriteChildOverflow.prefab",
        documents=parse_unity_documents(_MISSING_SPRITE_CHILD_OVERFLOW_PREFAB_YAML),
        canvas=(100, 100),
        guid_index={},
    )
    child = package["root"]["children"][0]
    assert child["image"]["missingSprite"] is True
    assert child["image"]["mode"] == "placeholder"
    assert child["rect"]["width"] == 1000
    assert child["rect"]["height"] == 1000
    assert package["visualBounds"] == {"x": 0, "y": 0, "width": 100, "height": 100}
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True


def _check_inactive_missing_sprite_does_not_block_fixture() -> None:
    """验证 inactive Image 的缺失 Sprite 只产生 warning，不阻塞导出审计。"""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/InactiveMissingSprite.prefab",
        documents=parse_unity_documents(_INACTIVE_MISSING_SPRITE_IMAGE_PREFAB_YAML),
        canvas=(100, 100),
        guid_index={},
    )
    assert package["stats"]["imageCount"] == 1
    assert package["root"]["image"]["missingSprite"] is True
    assert package["root"]["image"]["mode"] == "placeholder"
    assert any("Inactive image sprite guid not found in index on Root" in warning for warning in package["warnings"])
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True
    assert audit_report["checks"]["strictBlockingWarnings"]["pass"] is True
    assert audit_report["checks"]["spriteAssetsResolved"]["pass"] is True


def _check_text_clip_prefab_instance_fixture() -> None:
    """验证文本扩展字段、裁剪元数据、PrefabInstance 和自动 Canvas。"""

    documents = parse_unity_documents(_TEXT_CLIP_PREFAB_INSTANCE_YAML)
    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/TextClipPrefabInstance.prefab",
        documents=documents,
        canvas=_derive_canvas_from_root_rect(documents),
        guid_index={},
    )
    snapshot = _package_snapshot(package)
    expected = {
        "canvas": {"width": 320, "height": 180, "source": "rootRectTransform.sizeDelta"},
        "stats": {
            "nodeCount": 2,
            "imageCount": 0,
            "textCount": 1,
            "nineSliceCount": 0,
            "clipCount": 1,
            "canvasGroupCount": 0,
            "prefabInstanceCount": 1,
            "unsupportedCount": 0,
        },
        "rootChildren": ["30"],
        "rootText": {
            "componentType": "TextMeshProUGUI",
            "content": "Golden",
            "fontSize": 24.0,
            "color": {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0},
            "fontColor": {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0},
            "outlineColor": {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0},
            "autoSize": {"enabled": True, "min": 12.0, "max": 36.0},
            "alignment": {"horizontal": 2, "vertical": 512, "legacy": 65535},
            "options": {
                "fontStyle": 1,
                "wordWrapping": False,
                "overflowMode": 0,
                "richText": True,
            },
        },
        "rootClip": {"enabled": True, "componentType": "UnityEngine.UI::UnityEngine.UI.RectMask2D"},
        "prefabInstances": [
            {
                "fileId": "70",
                "sourcePrefab": {
                    "fileID": "100100000",
                    "guid": "0123456789abcdef0123456789abcdef",
                    "type": 3,
                },
                "hasModification": False,
            }
        ],
        "fatalErrors": [],
        "strictReasons": ["PrefabInstance documents detected: 1"],
    }
    assert snapshot == expected, snapshot
    assert parse_canvas("auto") is None
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True
    assert audit_report["summary"]["prefabInstanceCount"] == 1
    assert any(warning["code"] == "prefabInstancesRequireWriteStage" for warning in audit_report["warnings"])
    write_plan = build_figma_write_plan(
        package=package,
        package_path=Path("Golden/TextClipPrefabInstance/prefab-to-figma.json"),
        figma_url="https://www.figma.com/design/FILE/Example?node-id=1-2",
        file_key="",
        target_node_id="1:2",
        component_mode="component",
    )
    assert write_plan["summary"]["prefabInstanceCount"] == 1
    prefab_instance_write = write_plan["operations"]["prefabInstanceWrites"][0]
    assert prefab_instance_write["renderMode"] == "missing"
    assert prefab_instance_write["missingNestedPrefab"] is True
    assert prefab_instance_write["missingReason"] == "source_prefab_asset_not_found"
    assert prefab_instance_write["requiredAction"] == "create_missing_nested_prefab_placeholder"
    assert prefab_instance_write["framePlaceholderForbidden"] is False
    write_audit = build_write_plan_audit_report(package, write_plan, Path(".tmp/prefab-to-figma/figma_write_plan.json"))
    assert write_audit["allPass"] is True
    assert write_audit["summary"]["missingNestedPrefabPlaceholderCount"] == 1
    assert any(warning["code"] == "missingNestedPrefabPlaceholders" for warning in write_audit["warnings"])


def _check_image_visual_fields_fixture() -> None:
    """Verify static visual fields that affect deterministic Figma image rendering."""

    with tempfile.TemporaryDirectory(prefix="prefab-to-figma-golden-image-fields-") as temp_dir:
        temp_path = Path(temp_dir)
        sprite_guid = "ffffffffffffffffffffffffffffffff"
        raw_guid = "4270e566551cac542bff79ac2aa96636"
        sprite_meta = _write_png_asset(temp_path / "sprite.png", sprite_guid, 64, 32)
        raw_meta = _write_png_asset(temp_path / "raw.png", raw_guid, 128, 64)
        package = build_package(
            project_root=temp_path,
            prefab_path="Golden/ImageVisualFields.prefab",
            documents=parse_unity_documents(_IMAGE_VISUAL_FIELDS_PREFAB_YAML),
            canvas=(200, 100),
            guid_index={sprite_guid: sprite_meta, raw_guid: raw_meta},
        )
        root_image = package["root"]["image"]
        raw_image = package["root"]["children"][0]["image"]
        canvas_group = package["root"]["children"][0]["canvasGroup"]
        assert root_image["preserveAspect"] is True
        assert root_image["color"] == {"r": 1.0, "g": 0.5, "b": 0.25, "a": 0.75}
        assert raw_image["uvRect"] == {"x": 0.25, "y": 0.5, "width": 0.5, "height": 0.25}
        assert raw_image["color"] == {"r": 1.0, "g": 1.0, "b": 1.0, "a": 0.5}
        assert canvas_group["alpha"] == 0.42
        assert canvas_group["interactable"] is False
        assert canvas_group["blocksRaycasts"] is True
        assert package["stats"]["canvasGroupCount"] == 1
        write_plan = build_figma_write_plan(
            package=package,
            package_path=Path("Golden/ImageVisualFields/prefab-to-figma.json"),
            figma_url="https://www.figma.com/design/FILE/Example?node-id=1-2",
            file_key="",
            target_node_id="1:2",
            component_mode="component",
        )
        upload_items = write_plan["operations"]["imageUploads"]
        root_upload = upload_items[0]
        raw_upload = upload_items[1]
        assert root_upload["preserveAspect"] is True
        assert root_upload["alpha"] == 0.75
        assert root_upload["tintUnsupported"] is True
        assert raw_upload["uvRect"] == {"x": 0.25, "y": 0.5, "width": 0.5, "height": 0.25}
        assert raw_upload["alpha"] == 0.5
        assert "imageLayerVisual" in write_plan["validation"]["requiredReadBackChecks"]
        assert "unityNodeState" in write_plan["validation"]["requiredReadBackChecks"]
        write_audit = build_write_plan_audit_report(package, write_plan, Path(".tmp/prefab-to-figma/figma_write_plan.json"))
        assert write_audit["allPass"] is True


def _write_png_asset(path: Path, guid: str, width: int, height: int) -> Path:
    """Create a minimal PNG and Unity meta file for golden tests."""

    path.write_bytes(_minimal_png(width, height))
    meta_path = path.with_name(path.name + ".meta")
    meta_path.write_text(f"fileFormatVersion: 2\nguid: {guid}\nspritePixelsToUnits: 100\nspriteBorder: {{x: 0, y: 0, z: 0, w: 0}}\n", encoding="utf-8")
    return meta_path


def _minimal_png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x00\x00\x00\x00" * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def _check_fatal_fixture() -> None:
    """验证空 Prefab 文档会进入 fatalErrors 和报告。"""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/Empty.prefab",
        documents=[],
        canvas=(100, 100),
        guid_index={},
    )
    assert package["fatalErrors"] == ["No root node parsed from Prefab"]
    report = build_report(package)
    assert "- No root node parsed from Prefab" in report
    assert _strict_failure_reasons(package) == ["No root node parsed from Prefab"]
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is False
    assert any(error["code"] == "rootParsed" for error in audit_report["blockingErrors"])


def _check_unity_truth_duplicate_names_are_matched_by_structure_fixture() -> None:
    """Duplicate sibling names must not hide geometry mismatches during Unity truth compare."""

    def node(name: str, x: float, children: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return {
            "name": name,
            "path": f"Root/{name}" if name != "Root" else "Root",
            "active": True,
            "activeSelf": True,
            "rect": {"x": x, "y": 0, "width": 10, "height": 10, "rotationZ": 0},
            "children": children or [],
        }

    package = {
        "root": node("Root", 0, [
            node("Bg", 99),
            node("Bg", 10),
        ])
    }
    truth = {
        "root": node("Root", 0, [
            node("Bg", 0),
            node("Bg", 10),
        ])
    }

    report = compare_package(package, truth, tolerance=0.1)
    assert report["allPass"] is False
    assert any(
        error.get("code") == "rectMismatch"
        and error.get("structuralPath") == "0/0"
        and error.get("path") == "Root/Bg [0/0]"
        for error in report["blockingErrors"]
    ), report


def _check_unity_truth_skipped_subtree_downgraded_to_warning_fixture() -> None:
    """Exporter-declared skipped subtrees must downgrade to warnings, not block import.

    Reproduces the TitleRewardView case: the exporter intentionally skips nested
    particle / non-UGUI PrefabInstance children (recorded as package warnings), so the
    corresponding Unity runtime nodes must not be reported as missingExportNode, and the
    surviving sibling must still align to its real position instead of drifting to 0/0.
    """

    def node(name: str, x: float, children: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return {
            "name": name,
            "path": f"Root/{name}" if name != "Root" else "Root",
            "active": True,
            "activeSelf": True,
            "rect": {"x": x, "y": 0, "width": 10, "height": 10, "rotationZ": 0},
            "children": children or [],
        }

    # Exporter dropped FireWorks (and its child) plus AssetsRoot, keeping only TitleRoot.
    package = {
        "root": node("Root", 0, [node("TitleRoot", 0)]),
        "warnings": [
            "Skipped non-UGUI PrefabInstance 111: Assets/.../FireWorks.prefab; reason=source_prefab_has_invalid_root_rect_transform_size under Root",
            "Skipped non-UGUI PrefabInstance 222: Assets/.../AssetsRoot.prefab; reason=source_prefab_has_invalid_root_rect_transform_size under Root",
        ],
    }
    truth = {
        "root": node("Root", 0, [
            node("FireWorks", 0, [node("Fx", 0)]),
            node("AssetsRoot", 0),
            node("TitleRoot", 0),
        ])
    }

    report = compare_package(package, truth, tolerance=0.1)
    assert report["allPass"] is True, report
    assert report["summary"]["skippedSubtreeCount"] == 2, report
    assert report["summary"]["unityNodeCount"] == 5, report
    # TitleRoot must match at its real index 0/2, not drift to 0/0.
    assert not any(error.get("code") == "nodeNameMismatch" for error in report["blockingErrors"]), report
    skipped = sorted(
        warning["path"] for warning in report["warnings"] if warning.get("code") == "skippedExportSubtree"
    )
    assert skipped == ["Root/AssetsRoot [0/1]", "Root/FireWorks [0/0]"], skipped


def _check_unity_truth_unexpected_missing_node_blocks_fixture() -> None:
    """A missing node WITHOUT a matching skip warning must still block (no over-tolerance)."""

    def node(name: str, children: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return {
            "name": name,
            "path": f"Root/{name}" if name != "Root" else "Root",
            "active": True,
            "activeSelf": True,
            "rect": {"x": 0, "y": 0, "width": 10, "height": 10, "rotationZ": 0},
            "children": children or [],
        }

    package = {"root": node("Root", [node("Kept")]), "warnings": []}
    truth = {"root": node("Root", [node("Dropped"), node("Kept")])}

    report = compare_package(package, truth, tolerance=0.1)
    assert report["allPass"] is False, report
    assert any(
        error.get("code") == "missingExportNode" and error.get("path") == "Root/Dropped [0/0]"
        for error in report["blockingErrors"]
    ), report


def _check_horizontal_layout_prefab_instance_fixture() -> None:
    """验证 HorizontalLayoutGroup 下的嵌套 PrefabInstance 会按布局顺序分散坐标。"""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/HorizontalLayoutPrefabInstance.prefab",
        documents=parse_unity_documents(_HORIZONTAL_LAYOUT_PREFAB_INSTANCE_YAML),
        canvas=(320, 120),
        guid_index={},
    )
    instances = {
        item["instanceOverride"]["name"]: item["instanceOverride"]
        for item in package["prefabInstances"]
    }
    assert instances["Item"]["rect"] == {"x": 10, "y": 10, "width": 50, "height": 50}
    assert instances["Item (1)"]["rect"] == {"x": 70, "y": 10, "width": 50, "height": 50}
    assert instances["Item"]["layoutResolved"]["type"] == "HorizontalLayoutGroup"
    assert instances["Item (1)"]["layoutResolved"]["type"] == "HorizontalLayoutGroup"


def _check_vertical_layout_prefab_instance_fixture() -> None:
    """Nested PrefabInstance children must also follow VerticalLayoutGroup."""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/VerticalLayoutPrefabInstance.prefab",
        documents=parse_unity_documents(_VERTICAL_LAYOUT_PREFAB_INSTANCE_YAML),
        canvas=(320, 160),
        guid_index={},
    )
    instances = {
        item["instanceOverride"]["name"]: item["instanceOverride"]
        for item in package["prefabInstances"]
    }
    assert instances["Item"]["rect"] == {"x": 50, "y": 10, "width": 50, "height": 30}
    assert instances["Item (1)"]["rect"] == {"x": 45, "y": 50, "width": 60, "height": 40}
    assert instances["Item"]["layoutResolved"]["type"] == "VerticalLayoutGroup"
    assert instances["Item (1)"]["layoutResolved"]["type"] == "VerticalLayoutGroup"


def _check_grid_layout_children_fixture() -> None:
    """Normal child nodes under GridLayoutGroup must use cell size, spacing, and alignment."""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/GridLayoutChildren.prefab",
        documents=parse_unity_documents(_GRID_LAYOUT_CHILDREN_YAML),
        canvas=(320, 200),
        guid_index={},
    )
    first, second, third = package["root"]["children"]
    assert first["rect"] == {"x": 20, "y": 10, "width": 40, "height": 30, "rotationZ": 0}
    assert second["rect"] == {"x": 65, "y": 10, "width": 40, "height": 30, "rotationZ": 0}
    assert third["rect"] == {"x": 20, "y": 45, "width": 40, "height": 30, "rotationZ": 0}
    assert package["root"]["layout"]["resolved"] is True
    assert package["root"].get("unsupported") is None
    assert package["stats"]["unsupportedCount"] == 0


def _check_grid_layout_prefab_instance_fixture() -> None:
    """Nested PrefabInstance children must follow GridLayoutGroup cell positions."""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/GridLayoutPrefabInstance.prefab",
        documents=parse_unity_documents(_GRID_LAYOUT_PREFAB_INSTANCE_YAML),
        canvas=(320, 200),
        guid_index={},
    )
    instances = {
        item["instanceOverride"]["name"]: item["instanceOverride"]
        for item in package["prefabInstances"]
    }
    assert instances["Item"]["rect"] == {"x": 20, "y": 10, "width": 40, "height": 30}
    assert instances["Item (1)"]["rect"] == {"x": 65, "y": 10, "width": 40, "height": 30}
    assert instances["Item (2)"]["rect"] == {"x": 20, "y": 45, "width": 40, "height": 30}
    assert instances["Item"]["layoutResolved"]["type"] == "GridLayoutGroup"
    assert instances["Item (1)"]["layoutResolved"]["type"] == "GridLayoutGroup"
    assert instances["Item (2)"]["layoutResolved"]["type"] == "GridLayoutGroup"


def _check_vertical_layout_content_size_fitter_fixture() -> None:
    """Normal child nodes under VerticalLayoutGroup must be positioned and size-fitted."""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/VerticalLayoutContentSizeFitter.prefab",
        documents=parse_unity_documents(_VERTICAL_LAYOUT_CONTENT_SIZE_FITTER_YAML),
        canvas=(320, 220),
        guid_index={},
    )
    content = package["root"]
    first, second = content["children"]
    assert content["rect"] == {"x": 60, "y": 50, "width": 200, "height": 100, "rotationZ": 0}
    assert first["rect"] == {"x": 75, "y": 0, "width": 50, "height": 30, "rotationZ": 0}
    assert second["rect"] == {"x": 70, "y": 40, "width": 60, "height": 40, "rotationZ": 0}
    assert package["visualBounds"] == {"x": 0, "y": 0, "width": 200, "height": 100}
    assert content["layout"]["resolved"] is True
    assert content.get("unsupported") is None
    assert package["stats"]["unsupportedCount"] == 0


def _check_auto_canvas_falls_back_to_child_rect_fixture() -> None:
    """A component prefab with zero root size can still derive auto canvas from its child."""

    documents = parse_unity_documents(_ZERO_ROOT_CHILD_CANVAS_YAML)
    canvas = _derive_canvas_from_root_rect(documents)
    assert canvas == (240, 80)
    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/ZeroRootChildCanvas.prefab",
        documents=documents,
        canvas=canvas,
        guid_index={},
    )
    assert package["canvas"] == {
        "width": 240,
        "height": 80,
        "source": "firstPositiveChildRectTransform.sizeDelta",
    }
    assert package["root"]["rect"] == {"x": 0, "y": 0, "width": 240, "height": 80, "rotationZ": 0}
    assert package["root"]["children"][0]["rect"] == {"x": 0, "y": 0, "width": 240, "height": 80, "rotationZ": 0}


def _check_nested_prefab_instance_uses_stripped_parent_override_size_fixture() -> None:
    project_root = configured_unity_project()
    if project_root is None:
        return
    prefab_path = (
        project_root
        / "Assets"
        / "MagicWarrior"
        / "_Resources"
        / "Prefabs"
        / "UGUI"
        / "Monopoly"
        / "SettingView"
        / "ManageAccountView.prefab"
    )
    if not prefab_path.exists():
        return

    package = build_package(
        project_root=Path.cwd(),
        prefab_path=prefab_path.as_posix(),
        documents=parse_unity_documents(prefab_path.read_text(encoding="utf-8-sig")),
        canvas=(1080, 2340),
        guid_index={},
    )
    item_tips = next(
        item for item in package["prefabInstances"]
        if (item.get("instanceOverride") or {}).get("name") == "Common_Prefab_ItemTips_2"
    )
    rect = item_tips["instanceOverride"]["rect"]
    assert rect == {"x": 306, "y": 14, "width": 843.5381, "height": 134, "rotationZ": 0}


def _check_text_animator_does_not_replace_tmp_fixture() -> None:
    """验证 TextAnimator_TMP 是动画脚本，不会覆盖同节点的 TMP 文本导出。"""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/TextAnimatorWithTmp.prefab",
        documents=parse_unity_documents(_TEXT_ANIMATOR_WITH_TMP_YAML),
        canvas=(320, 120),
        guid_index={},
    )
    assert package["stats"]["textCount"] == 1
    assert package["stats"]["unsupportedCount"] == 1
    assert package["root"]["text"]["componentType"] == "Unity.TextMeshPro::TMPro.TextMeshProUGUI"
    assert package["root"]["text"]["content"] == "Golden"
    assert any("TextAnimator_TMP" in warning for warning in package["warnings"])
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True
    assert audit_report["checks"]["statsConsistent"]["pass"] is True
    write_plan = build_figma_write_plan(
        package=package,
        package_path=Path("Golden/TextAnimatorWithTmp/prefab-to-figma.json"),
        figma_url="https://www.figma.com/design/FILE/Example?node-id=1-2",
        file_key="",
        target_node_id="1:2",
        component_mode="component",
    )
    unsupported_markers = write_plan["operations"]["unsupportedMarkers"]
    assert len(unsupported_markers) == 1
    assert unsupported_markers[0]["requiredAction"] == "report_only_downgrade_without_visual_marker"
    write_audit = build_write_plan_audit_report(package, write_plan, Path(".tmp/prefab-to-figma/figma_write_plan.json"))
    assert write_audit["allPass"] is True
    assert any(warning["code"] == "unsupportedComponentsDowngraded" for warning in write_audit["warnings"])


def _check_scaled_parent_uses_unscaled_layout_size_fixture() -> None:
    """Children must resolve anchors against the parent's unscaled RectTransform size."""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/ScaledParentLayout.prefab",
        documents=parse_unity_documents(_SCALED_PARENT_LAYOUT_YAML),
        canvas=(400, 400),
        guid_index={},
    )
    parent = package["root"]["children"][0]
    child = parent["children"][0]
    assert parent["rect"] == {
        "x": 150,
        "y": 175,
        "width": 100,
        "height": 50,
        "rotationZ": 0,
        "scaleX": 0.5,
        "scaleY": 0.5,
    }
    assert child["rect"] == {
        "x": 0,
        "y": 0,
        "width": 200,
        "height": 100,
        "rotationZ": 0,
    }


def _check_tmp_material_layer_name_fixture() -> None:
    """验证 TMP 材质名会转换为 Figma 文本层材质标识。"""

    guid = "b2a0ae70d31a9c3478cceda516fb8752"
    with tempfile.TemporaryDirectory(prefix="prefab-to-figma-golden-material-") as temp_dir:
        material_dir = Path(temp_dir)
        mat_path = material_dir / "CommonFont_Btn_GreenBtn.mat"
        meta_path = material_dir / "CommonFont_Btn_GreenBtn.mat.meta"
        mat_path.write_text(_TMP_MATERIAL_YAML, encoding="utf-8")
        meta_path.write_text(f"fileFormatVersion: 2\nguid: {guid}\n", encoding="utf-8")

        package = build_package(
            project_root=Path.cwd(),
            prefab_path="Golden/TmpMaterialText.prefab",
            documents=parse_unity_documents(_TMP_MATERIAL_PREFAB_YAML),
            canvas=(320, 120),
            guid_index={guid: meta_path},
        )

    text = package["root"]["text"]
    assert package["root"]["name"] == "Root"
    assert text["materialTag"] == "CommonFont_Btn_GreenBtn"
    assert text["figmaTextLayerName"] == "__text"
    assert text["sharedMaterial"]["guid"] == guid
    assert text["sharedMaterial"]["fileID"] == 2100000
    assert text["sharedMaterial"]["name"] == "CommonFont_Btn_GreenBtn"
    assert text["sharedMaterial"]["assetPath"].endswith("/CommonFont_Btn_GreenBtn.mat")
    audit_report = build_export_audit_report(package)
    assert audit_report["allPass"] is True
    write_plan = build_figma_write_plan(
        package=package,
        package_path=Path("Golden/TmpMaterialText/prefab-to-figma.json"),
        figma_url="https://www.figma.com/design/FILE/Example?node-id=1-2",
        file_key="",
        target_node_id="1:2",
        component_mode="component",
    )
    text_writes = write_plan["operations"]["textWrites"]
    assert text_writes[0]["mustWritePluginData"] is True
    write_audit = build_write_plan_audit_report(package, write_plan, Path(".tmp/prefab-to-figma/figma_write_plan.json"))
    assert write_audit["allPass"] is True


def _check_rotation_prefers_euler_hint_fixture() -> None:
    rect_fields = {
        "m_LocalRotation": {"x": -0.18930793, "y": -0.2392983, "z": 0.03813461, "w": 0.9515486},
        "m_LocalEulerAnglesHint": {"x": -20, "y": -30, "z": 10},
    }
    assert extract_rotation_z(rect_fields) == 10


def _check_rect_transform_constraints_export_fixture() -> None:
    """Unity anchors must be exported as Figma Constraints for round-trip layout."""

    package = build_package(
        project_root=Path.cwd(),
        prefab_path="Golden/RectTransformConstraints.prefab",
        documents=parse_unity_documents(_RECT_TRANSFORM_CONSTRAINTS_YAML),
        canvas=(200, 100),
        guid_index={},
    )
    by_name = {node["name"]: node for node in package["nodes"]}
    assert by_name["TopLeft"]["constraints"] == {"horizontal": "MIN", "vertical": "MIN"}
    assert by_name["TopLeft"]["rectTransform"]["anchorMin"] == {"x": 0, "y": 1}
    assert by_name["BottomRight"]["constraints"] == {"horizontal": "MAX", "vertical": "MAX"}
    assert by_name["Stretch"]["constraints"] == {"horizontal": "STRETCH", "vertical": "STRETCH"}
    assert by_name["Stretch"]["rectTransform"]["sizeDelta"] == {"x": -20, "y": -10}


def _check_mcp_client_fixture() -> None:
    """验证 MCP wrapper 的资源映射和统一审核报告归一化。"""

    with tempfile.TemporaryDirectory(prefix="prefab-to-figma-mcp-relay-") as temp_dir:
        temp_path = Path(temp_dir)
        asset_path = temp_path / "sprite.png"
        asset_path.write_bytes(b"\x89PNG\r\n\x1a\n")
        package = {
            "assets": {
                "asset_a": {"assetPath": asset_path.as_posix(), "width": 8, "height": 8},
            },
            "nestedPrefabPackages": {
                "nested_guid": {
                    "assets": {
                        "asset_b": {"assetPath": asset_path.as_posix(), "width": 8, "height": 8},
                    },
                },
            },
        }
        write_plan = {
            "operations": {
                "imageUploads": [
                    {"asset": "asset_a", "assetPath": asset_path.as_posix()},
                ],
            },
        }
        assets, asset_paths = build_asset_entries(package, write_plan, temp_path / "prefab-to-figma.json", Path.cwd())
        assert assets == [
            {"id": "asset_a", "path": asset_path.resolve().as_posix()},
            {"id": "asset_b", "path": asset_path.resolve().as_posix()},
        ]
        assert asset_paths["asset_a"] == asset_path.resolve()
        assert asset_paths["asset_b"] == asset_path.resolve()

    result_payload = {
        "requestId": "req-1",
        "result": {
            "allPass": True,
            "blockingErrors": [],
            "warnings": [{"code": "fontFallback"}],
            "summary": {"createdCount": 3},
            "checks": {
                "nodeCount": {"pass": True},
                "imageFillHashLength": {"pass": True},
                "imageLayerVisual": {"pass": True},
                "unityNodeGeometry": {"pass": True},
                "unityNodeOrder": {"pass": True},
                "unityNodeState": {"pass": True},
                "tmpMaterialPluginData": {"pass": True},
                "textOutlineStroke": {"pass": True},
                "prefabInstanceNodeType": {"pass": True},
                "prefabInstanceGeometry": {"pass": True},
                "nineSliceSourceImageMetadata": {"pass": True},
                "componentModeResult": {"pass": True},
                "screenshotAcceptance": {"pass": True},
                "fontConsistency": {"pass": True},
            },
            "artifacts": {"rootNodeId": "1:2"},
        },
    }
    report = build_verify_report(result_payload, "req-1", {"verifyReportPath": "out.json"})
    assert report["allPass"] is True
    assert report["warnings"][0]["code"] == "fontFallback"
    assert report["summary"]["createdCount"] == 3
    assert report["checks"]["nodeCount"]["pass"] is True
    assert report["artifacts"]["requestId"] == "req-1"
    assert report["artifacts"]["verifyReportPath"] == "out.json"

    legacy_payload = {
        "requestId": "req-legacy",
        "result": {
            "allPass": True,
            "blockingErrors": [],
            "warnings": [],
            "summary": {},
            "checks": {"nodeCount": {"pass": True}},
            "artifacts": {},
        },
    }
    legacy_report = build_verify_report(legacy_payload, "req-legacy", {})
    assert legacy_report["allPass"] is False
    assert legacy_report["blockingErrors"][0]["code"] == "requiredReadbackChecks"
    assert "unityNodeGeometry" in legacy_report["blockingErrors"][0]["details"][0]["checks"]


def _package_snapshot(package: dict[str, Any]) -> dict[str, Any]:
    """提取稳定快照字段，避免比较完整 JSON 中的无关细节。"""

    root = package["root"]
    return {
        "canvas": package["canvas"],
        "stats": package["stats"],
        "rootChildren": [child["id"] for child in root["children"]],
        "rootText": root["text"],
        "rootClip": root["clip"],
        "prefabInstances": package["prefabInstances"],
        "fatalErrors": package["fatalErrors"],
        "strictReasons": _strict_failure_reasons(package),
    }


_TEXT_CLIP_PREFAB_INSTANCE_YAML = """--- !u!1 &10
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
  m_SizeDelta: {x: 320, y: 180}
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
  m_text: Golden
  m_fontSize: 24
  m_enableAutoSizing: 1
  m_fontSizeMin: 12
  m_fontSizeMax: 36
  m_fontStyle: 1
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


_MISSING_SPRITE_IMAGE_PREFAB_YAML = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 40}
  m_Name: Root
  m_IsActive: 1
--- !u!224 &20
RectTransform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 100, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.Image
  m_Sprite: {fileID: 21300000, guid: ffffffffffffffffffffffffffffffff, type: 3}
  m_Type: 0
"""


_INACTIVE_MISSING_SPRITE_IMAGE_PREFAB_YAML = _MISSING_SPRITE_IMAGE_PREFAB_YAML.replace(
    "  m_IsActive: 1",
    "  m_IsActive: 0",
    1,
)


_MISSING_RAW_IMAGE_TEXTURE_PREFAB_YAML = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 40}
  m_Name: Root
  m_IsActive: 1
--- !u!224 &20
RectTransform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 100, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.RawImage
  m_Texture: {fileID: 8400000, guid: 4270e566551cac542bff79ac2aa96636, type: 2}
  m_UVRect:
    serializedVersion: 2
    x: 0
    y: 0
    width: 1
    height: 1
"""


_IMAGE_WITHOUT_SPRITE_PREFAB_YAML = _MISSING_SPRITE_IMAGE_PREFAB_YAML.replace(
    "  m_Sprite: {fileID: 21300000, guid: ffffffffffffffffffffffffffffffff, type: 3}",
    "  m_Sprite: {fileID: 0}",
)


_MISSING_SPRITE_CHILD_OVERFLOW_PREFAB_YAML = """--- !u!1 &10
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
  - {fileID: 21}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 100, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 21}
  - component: {fileID: 41}
  m_Name: OverflowMissingSprite
  m_IsActive: 1
--- !u!224 &21
RectTransform:
  m_GameObject: {fileID: 11}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 1000, y: 1000}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &41
MonoBehaviour:
  m_GameObject: {fileID: 11}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.Image
  m_Sprite: {fileID: 0}
  m_Type: 0
"""


_IMAGE_VISUAL_FIELDS_PREFAB_YAML = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 40}
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
  m_SizeDelta: {x: 200, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.Image
  m_Sprite: {fileID: 21300000, guid: ffffffffffffffffffffffffffffffff, type: 3}
  m_Type: 0
  m_PreserveAspect: 1
  m_Color: {r: 1, g: 0.5, b: 0.25, a: 0.75}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 30}
  - component: {fileID: 50}
  - component: {fileID: 60}
  m_Name: Raw
  m_IsActive: 1
--- !u!224 &30
RectTransform:
  m_GameObject: {fileID: 11}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 100, y: 50}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &50
MonoBehaviour:
  m_GameObject: {fileID: 11}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.RawImage
  m_Texture: {fileID: 8400000, guid: 4270e566551cac542bff79ac2aa96636, type: 2}
  m_UVRect:
    serializedVersion: 2
    x: 0.25
    y: 0.5
    width: 0.5
    height: 0.25
  m_Color: {r: 1, g: 1, b: 1, a: 0.5}
--- !u!225 &60
CanvasGroup:
  m_GameObject: {fileID: 11}
  m_Alpha: 0.42
  m_Interactable: 0
  m_BlocksRaycasts: 1
  m_IgnoreParentGroups: 0
"""


_TEXT_ANIMATOR_WITH_TMP_YAML = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 30}
  - component: {fileID: 40}
  m_Name: Root
  m_IsActive: 1
--- !u!224 &20
RectTransform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 320, y: 120}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &30
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: Unity.TextMeshPro::TMPro.TextMeshProUGUI
  m_text: Golden
  m_fontSize: 24
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: Febucci.TextAnimator.TMP.Runtime::Febucci.UI.TextAnimator_TMP
  _text: <sprite=10><sprite=0>
"""


_SCALED_PARENT_LAYOUT_YAML = """--- !u!1 &10
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
  m_SizeDelta: {x: 400, y: 400}
  m_Pivot: {x: 0.5, y: 0.5}
  m_LocalScale: {x: 1, y: 1, z: 1}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 30}
  m_Name: ScaledParent
  m_IsActive: 1
--- !u!224 &30
RectTransform:
  m_GameObject: {fileID: 11}
  m_Father: {fileID: 20}
  m_Children:
  - {fileID: 50}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 200, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
  m_LocalScale: {x: 0.5, y: 0.5, z: 1}
--- !u!1 &12
GameObject:
  m_Component:
  - component: {fileID: 50}
  m_Name: StretchChild
  m_IsActive: 1
--- !u!224 &50
RectTransform:
  m_GameObject: {fileID: 12}
  m_Father: {fileID: 30}
  m_Children: []
  m_AnchorMin: {x: 0, y: 0}
  m_AnchorMax: {x: 1, y: 1}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 0, y: 0}
  m_Pivot: {x: 0.5, y: 0.5}
  m_LocalScale: {x: 1, y: 1, z: 1}
"""


_HORIZONTAL_LAYOUT_PREFAB_INSTANCE_YAML = """--- !u!1 &10
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
  m_SizeDelta: {x: 320, y: 120}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 30}
  - component: {fileID: 40}
  m_Name: Row
  m_IsActive: 1
--- !u!224 &30
RectTransform:
  m_GameObject: {fileID: 11}
  m_Father: {fileID: 20}
  m_Children:
  - {fileID: 1001}
  - {fileID: 1002}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 140, y: 70}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 11}
  m_Script: {fileID: 11500000, guid: 30649d3a9faa99c48a7b1166b86bf2a0, type: 3}
  m_EditorClassIdentifier:
  m_Padding:
    m_Left: 10
    m_Right: 0
    m_Top: 10
    m_Bottom: 0
  m_ChildAlignment: 0
  m_Spacing: 10
  m_ChildForceExpandWidth: 0
  m_ChildForceExpandHeight: 0
  m_ChildControlWidth: 0
  m_ChildControlHeight: 0
  m_ChildScaleWidth: 0
  m_ChildScaleHeight: 0
  m_ReverseArrangement: 0
--- !u!224 &1001 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 2001}
  m_PrefabAsset: {fileID: 0}
--- !u!224 &1002 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 2002}
  m_PrefabAsset: {fileID: 0}
--- !u!1001 &2001
PrefabInstance:
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 30}
    m_Modifications:
    - target: {fileID: 9000, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Item
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.x
      value: 50
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.y
      value: 50
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
--- !u!1001 &2002
PrefabInstance:
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 30}
    m_Modifications:
    - target: {fileID: 9000, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Item (1)
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.x
      value: 50
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.y
      value: 50
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
"""


_VERTICAL_LAYOUT_PREFAB_INSTANCE_YAML = """--- !u!1 &10
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
  m_SizeDelta: {x: 320, y: 160}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 30}
  - component: {fileID: 40}
  m_Name: Column
  m_IsActive: 1
--- !u!224 &30
RectTransform:
  m_GameObject: {fileID: 11}
  m_Father: {fileID: 20}
  m_Children:
  - {fileID: 1001}
  - {fileID: 1002}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 140, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 11}
  m_Script: {fileID: 11500000, guid: 59f8146938fff824cb5fd77236b75775, type: 3}
  m_EditorClassIdentifier:
  m_Padding:
    m_Left: 10
    m_Right: 0
    m_Top: 10
    m_Bottom: 0
  m_ChildAlignment: 1
  m_Spacing: 10
  m_ChildForceExpandWidth: 0
  m_ChildForceExpandHeight: 0
  m_ChildControlWidth: 0
  m_ChildControlHeight: 0
  m_ReverseArrangement: 0
--- !u!224 &1001 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 2001}
--- !u!224 &1002 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 2002}
--- !u!1001 &2001
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 30}
    m_Modifications:
    - target: {fileID: 9000, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Item
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.x
      value: 50
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.y
      value: 30
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
--- !u!1001 &2002
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 30}
    m_Modifications:
    - target: {fileID: 9000, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Item (1)
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.x
      value: 60
      objectReference: {fileID: 0}
    - target: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_SizeDelta.y
      value: 40
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
"""


_GRID_LAYOUT_CHILDREN_YAML = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 30}
  m_Name: Grid
  m_IsActive: 1
--- !u!224 &20
RectTransform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
  m_Children:
  - {fileID: 101}
  - {fileID: 102}
  - {fileID: 103}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 140, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &30
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_Script: {fileID: 11500000, guid: 8a8695521f0d02e499659fee002a26c2, type: 3}
  m_EditorClassIdentifier:
  m_Padding:
    m_Left: 20
    m_Right: 0
    m_Top: 10
    m_Bottom: 0
  m_ChildAlignment: 0
  m_StartCorner: 0
  m_StartAxis: 0
  m_CellSize: {x: 40, y: 30}
  m_Spacing: {x: 5, y: 5}
  m_Constraint: 1
  m_ConstraintCount: 2
--- !u!1 &201
GameObject:
  m_Component:
  - component: {fileID: 101}
  m_Name: First
  m_IsActive: 1
--- !u!224 &101
RectTransform:
  m_GameObject: {fileID: 201}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 1, y: 1}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &202
GameObject:
  m_Component:
  - component: {fileID: 102}
  m_Name: Second
  m_IsActive: 1
--- !u!224 &102
RectTransform:
  m_GameObject: {fileID: 202}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 1, y: 1}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &203
GameObject:
  m_Component:
  - component: {fileID: 103}
  m_Name: Third
  m_IsActive: 1
--- !u!224 &103
RectTransform:
  m_GameObject: {fileID: 203}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 1, y: 1}
  m_Pivot: {x: 0.5, y: 0.5}
"""


_GRID_LAYOUT_PREFAB_INSTANCE_YAML = _GRID_LAYOUT_CHILDREN_YAML.replace(
    "  - {fileID: 101}\n  - {fileID: 102}\n  - {fileID: 103}",
    "  - {fileID: 1001}\n  - {fileID: 1002}\n  - {fileID: 1003}",
).replace(
    "--- !u!1 &201\nGameObject:\n  m_Component:\n  - component: {fileID: 101}\n  m_Name: First\n  m_IsActive: 1\n--- !u!224 &101\nRectTransform:\n  m_GameObject: {fileID: 201}\n  m_Father: {fileID: 20}\n  m_Children: []\n  m_AnchorMin: {x: 0.5, y: 0.5}\n  m_AnchorMax: {x: 0.5, y: 0.5}\n  m_AnchoredPosition: {x: 0, y: 0}\n  m_SizeDelta: {x: 1, y: 1}\n  m_Pivot: {x: 0.5, y: 0.5}\n--- !u!1 &202\nGameObject:\n  m_Component:\n  - component: {fileID: 102}\n  m_Name: Second\n  m_IsActive: 1\n--- !u!224 &102\nRectTransform:\n  m_GameObject: {fileID: 202}\n  m_Father: {fileID: 20}\n  m_Children: []\n  m_AnchorMin: {x: 0.5, y: 0.5}\n  m_AnchorMax: {x: 0.5, y: 0.5}\n  m_AnchoredPosition: {x: 0, y: 0}\n  m_SizeDelta: {x: 1, y: 1}\n  m_Pivot: {x: 0.5, y: 0.5}\n--- !u!1 &203\nGameObject:\n  m_Component:\n  - component: {fileID: 103}\n  m_Name: Third\n  m_IsActive: 1\n--- !u!224 &103\nRectTransform:\n  m_GameObject: {fileID: 203}\n  m_Father: {fileID: 20}\n  m_Children: []\n  m_AnchorMin: {x: 0.5, y: 0.5}\n  m_AnchorMax: {x: 0.5, y: 0.5}\n  m_AnchoredPosition: {x: 0, y: 0}\n  m_SizeDelta: {x: 1, y: 1}\n  m_Pivot: {x: 0.5, y: 0.5}\n",
    """--- !u!224 &1001 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 2001}
--- !u!224 &1002 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 2002}
--- !u!224 &1003 stripped
RectTransform:
  m_CorrespondingSourceObject: {fileID: 9001, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 2003}
--- !u!1001 &2001
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 20}
    m_Modifications:
    - target: {fileID: 9000, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Item
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
--- !u!1001 &2002
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 20}
    m_Modifications:
    - target: {fileID: 9000, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Item (1)
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
--- !u!1001 &2003
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 20}
    m_Modifications:
    - target: {fileID: 9000, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Item (2)
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
""",
)


_VERTICAL_LAYOUT_CONTENT_SIZE_FITTER_YAML = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 30}
  - component: {fileID: 40}
  m_Name: Content
  m_IsActive: 1
--- !u!224 &20
RectTransform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
  m_Children:
  - {fileID: 60}
  - {fileID: 80}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 60}
  m_SizeDelta: {x: 200, y: 0}
  m_Pivot: {x: 0.5, y: 1}
--- !u!114 &30
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.VerticalLayoutGroup
  m_Padding:
    m_Left: 0
    m_Right: 0
    m_Top: 0
    m_Bottom: 20
  m_ChildAlignment: 1
  m_Spacing: 10
  m_ChildForceExpandWidth: 0
  m_ChildForceExpandHeight: 0
  m_ChildControlWidth: 0
  m_ChildControlHeight: 0
  m_ChildScaleWidth: 0
  m_ChildScaleHeight: 0
  m_ReverseArrangement: 0
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.ContentSizeFitter
  m_HorizontalFit: 0
  m_VerticalFit: 2
--- !u!1 &50
GameObject:
  m_Component:
  - component: {fileID: 60}
  m_Name: First
  m_IsActive: 1
--- !u!224 &60
RectTransform:
  m_GameObject: {fileID: 50}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 50, y: 30}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &70
GameObject:
  m_Component:
  - component: {fileID: 80}
  m_Name: Second
  m_IsActive: 1
--- !u!224 &80
RectTransform:
  m_GameObject: {fileID: 70}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 60, y: 40}
  m_Pivot: {x: 0.5, y: 0.5}
"""


_ZERO_ROOT_CHILD_CANVAS_YAML = """--- !u!1 &10
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
  - {fileID: 40}
  m_AnchorMin: {x: 0, y: 0}
  m_AnchorMax: {x: 1, y: 1}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 0, y: 0}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &30
GameObject:
  m_Component:
  - component: {fileID: 40}
  m_Name: Child
  m_IsActive: 1
--- !u!224 &40
RectTransform:
  m_GameObject: {fileID: 30}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 240, y: 80}
  m_Pivot: {x: 0.5, y: 0.5}
"""


_RECT_TRANSFORM_CONSTRAINTS_YAML = """--- !u!1 &10
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
  - {fileID: 40}
  - {fileID: 60}
  - {fileID: 80}
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 200, y: 100}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &30
GameObject:
  m_Component:
  - component: {fileID: 40}
  m_Name: TopLeft
  m_IsActive: 1
--- !u!224 &40
RectTransform:
  m_GameObject: {fileID: 30}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0, y: 1}
  m_AnchorMax: {x: 0, y: 1}
  m_AnchoredPosition: {x: 10, y: -10}
  m_SizeDelta: {x: 20, y: 20}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &50
GameObject:
  m_Component:
  - component: {fileID: 60}
  m_Name: BottomRight
  m_IsActive: 1
--- !u!224 &60
RectTransform:
  m_GameObject: {fileID: 50}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 1, y: 0}
  m_AnchorMax: {x: 1, y: 0}
  m_AnchoredPosition: {x: -10, y: 10}
  m_SizeDelta: {x: 20, y: 20}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!1 &70
GameObject:
  m_Component:
  - component: {fileID: 80}
  m_Name: Stretch
  m_IsActive: 1
--- !u!224 &80
RectTransform:
  m_GameObject: {fileID: 70}
  m_Father: {fileID: 20}
  m_Children: []
  m_AnchorMin: {x: 0, y: 0}
  m_AnchorMax: {x: 1, y: 1}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: -20, y: -10}
  m_Pivot: {x: 0.5, y: 0.5}
"""


_TMP_MATERIAL_PREFAB_YAML = """--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 20}
  - component: {fileID: 40}
  m_Name: Root
  m_IsActive: 1
--- !u!224 &20
RectTransform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
  m_Children: []
  m_AnchorMin: {x: 0.5, y: 0.5}
  m_AnchorMax: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 0}
  m_SizeDelta: {x: 320, y: 120}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &40
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_EditorClassIdentifier:
  m_text: Golden
  m_fontSize: 24
  m_sharedMaterial: {fileID: 2100000, guid: b2a0ae70d31a9c3478cceda516fb8752, type: 2}
"""


_TMP_MATERIAL_YAML = """%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_ObjectHideFlags: 0
  m_Name: CommonFont_Btn_GreenBtn
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs: []
    m_Ints: []
    m_Floats:
    - _OutlineWidth: 0.25
    m_Colors:
    - _OutlineColor: {r: 0, g: 0, b: 0, a: 1}
"""


if __name__ == "__main__":
    raise SystemExit(main())
