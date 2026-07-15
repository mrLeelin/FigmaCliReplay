#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Build a Figma write plan and audit report from a prefab-to-figma package."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from prefab_to_figma import build_export_audit_report, make_check  # noqa: E402


PLAN_FILE_NAME = "figma_write_plan.json"
AUDIT_FILE_NAME = "figma_write_plan_audit_report.json"


def main() -> int:
    """Command-line entry point."""

    parser = argparse.ArgumentParser(description="Build a prefab-to-figma Figma write plan")
    parser.add_argument("--package", required=True, help="Path to prefab-to-figma.json")
    parser.add_argument("--figma-url", default="", help="Target Figma URL")
    parser.add_argument("--file-key", default="", help="Target Figma file key")
    parser.add_argument("--target-node-id", default="", help="Target page or node id")
    parser.add_argument("--component-mode", choices=["component", "frame"], default="component")
    parser.add_argument("--nested-prefab-component-mode", choices=["all", "commonOnly", "none"], default="all")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--output-audit-report", default="", help="Optional audit report output path")
    args = parser.parse_args()

    package_path = Path(args.package)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not package_path.exists():
        result = _missing_package_result(package_path, out_dir)
        _write_result(out_dir / AUDIT_FILE_NAME, args.output_audit_report, result)
        print(f"Figma write plan allPass={result['allPass']}")
        return 2

    package = json.loads(package_path.read_text(encoding="utf-8-sig"))
    plan = build_figma_write_plan(
        package=package,
        package_path=package_path,
        figma_url=args.figma_url,
        file_key=args.file_key,
        target_node_id=args.target_node_id,
        component_mode=args.component_mode,
        nested_prefab_component_mode=args.nested_prefab_component_mode,
    )
    plan_path = out_dir / PLAN_FILE_NAME
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

    audit_report = build_write_plan_audit_report(package, plan, plan_path)
    _write_result(out_dir / AUDIT_FILE_NAME, args.output_audit_report, audit_report)
    print(f"Figma write plan -> {plan_path} | allPass={audit_report['allPass']}")
    return 0 if audit_report["allPass"] else 2


def build_figma_write_plan(
    package: dict[str, Any],
    package_path: Path,
    figma_url: str,
    file_key: str,
    target_node_id: str,
    component_mode: str,
    nested_prefab_component_mode: str = "all",
) -> dict[str, Any]:
    """Build an auditable Figma write plan without writing to Figma."""

    nested_prefab_component_mode = _normalize_nested_prefab_component_mode(nested_prefab_component_mode)
    nodes = package.get("nodes") or []
    root = package.get("root") or {}
    assets = package.get("assets") or {}
    all_image_nodes = [node for node in nodes if node.get("image")]
    image_nodes = [node for node in all_image_nodes if node.get("active") is not False and not (node.get("image") or {}).get("missingSprite")]
    text_nodes = [node for node in nodes if node.get("text")]
    nine_slice_nodes = [node for node in image_nodes if (node.get("image") or {}).get("mode") == "nine-slice"]
    prefab_instances = package.get("prefabInstances") or []
    prefab_instance_writes = list(prefab_instances)
    unsupported_nodes = [node for node in nodes if node.get("unsupported")]
    rotated_nodes = [node for node in nodes if abs(float((node.get("rect") or {}).get("rotationZ", 0) or 0)) > 0.001]
    flipped_nodes = [
        node for node in nodes
        if float((node.get("rect") or {}).get("scaleX", 1) or 1) < 0
        or float((node.get("rect") or {}).get("scaleY", 1) or 1) < 0
    ]

    operations = {
        "pageResolution": {
            "requiresTargetPageLookup": True,
            "targetNodeId": target_node_id,
            "rule": "Resolve the target page in the same write request before creating nodes.",
        },
        "placeholderCleanup": {
            "requiresSeparateUseFigmaCall": len(image_nodes) > 0,
            "reason": "Upload placeholder cleanup is separate from formal node creation.",
        },
        "imageUploads": [_build_image_upload_item(node, assets) for node in image_nodes],
        "textWrites": [_build_text_write_item(node) for node in text_nodes],
        "nineSliceWrites": [_build_nine_slice_item(node) for node in nine_slice_nodes],
        "prefabInstanceWrites": [
            _build_prefab_instance_item(item, nested_prefab_component_mode) for item in prefab_instance_writes
        ],
        "unsupportedMarkers": [_build_unsupported_item(node) for node in unsupported_nodes],
        "rotationTransforms": [_build_transform_item(node, "rotation") for node in rotated_nodes],
        "flipTransforms": [_build_transform_item(node, "flip") for node in flipped_nodes],
        "componentMode": {
            "enabled": component_mode == "component",
            "topLevelName": _resolve_top_level_name(package),
            "rule": "Component conversion runs after child layers, images, text, nine-slice data, and metadata are written.",
        },
    }

    validation = {
        "requiredReadBackChecks": [
            "nodeCount",
            "imageFillHashLength",
            "imageLayerVisual",
            "unityNodeGeometry",
            "unityNodeOrder",
            "unityNodeState",
            "tmpMaterialPluginData",
            "textOutlineStroke",
            "prefabInstanceNodeType",
            "prefabInstanceGeometry",
            "nineSliceSourceImageMetadata",
            "componentModeResult",
            "screenshotAcceptance",
            "fontConsistency",
        ],
        "tmpMaterialNodePaths": [
            node.get("path", "") for node in text_nodes if (node.get("text") or {}).get("materialTag")
        ],
        "outlineNodePaths": [
            node.get("path", "") for node in text_nodes if (((node.get("text") or {}).get("effects") or {}).get("outline") or {}).get("width", 0)
        ],
        "prefabInstanceCount": len(prefab_instance_writes),
        "totalPrefabInstanceCount": len(prefab_instances),
        "framePrefabInstanceCount": sum(
            1 for item in prefab_instance_writes
            if _resolve_prefab_instance_render_mode(item, nested_prefab_component_mode) == "frame"
        ),
    }

    # 鑾峰彇 Canvas 鍏冩暟鎹紙鍖呭惈 source 淇℃伅锛?
    canvas_meta = package.get("canvas") or {}
    canvas_info = {
        "width": canvas_meta.get("width", 0),
        "height": canvas_meta.get("height", 0),
        "source": canvas_meta.get("source", "rootRectTransform.sizeDelta"),
    }

    return {
        "version": 1,
        "sourcePackagePath": str(package_path),
        "figma": {
            "url": figma_url,
            "fileKey": file_key,
            "targetNodeId": target_node_id,
        },
        "componentMode": component_mode,
        "nestedPrefabComponentMode": nested_prefab_component_mode,
        "root": {
            "name": root.get("name", ""),
            "canvas": canvas_info,
            "visualBounds": package.get("visualBounds", {}),
            "needsImportBoundsWrapper": _needs_import_bounds_wrapper(package),
        },
        "summary": {
            "nodeCount": len(nodes),
            "imageCount": len(all_image_nodes),
            "activeImageCount": len(image_nodes),
            "inactiveImageCount": len(all_image_nodes) - len(image_nodes),
            "textCount": len(text_nodes),
            "nineSliceCount": len(nine_slice_nodes),
            "prefabInstanceCount": len(prefab_instance_writes),
            "totalPrefabInstanceCount": len(prefab_instances),
            "framePrefabInstanceCount": sum(
                1 for item in prefab_instance_writes
                if _resolve_prefab_instance_render_mode(item, nested_prefab_component_mode) == "frame"
            ),
            "unsupportedNodeCount": len(unsupported_nodes),
            "rotatedNodeCount": len(rotated_nodes),
            "flippedNodeCount": len(flipped_nodes),
            "assetCount": len(assets),
        },
        "operations": operations,
        "validation": validation,
    }


def build_write_plan_audit_report(package: dict[str, Any], plan: dict[str, Any], plan_path: Path) -> dict[str, Any]:
    """Build the write-plan audit report."""

    export_audit = build_export_audit_report(package, plan_path.parent)
    operations = plan.get("operations") or {}
    summary = plan.get("summary") or {}
    image_uploads = operations.get("imageUploads") or []
    text_writes = operations.get("textWrites") or []
    nine_slice_writes = operations.get("nineSliceWrites") or []
    prefab_instance_writes = operations.get("prefabInstanceWrites") or []
    audit_summary = dict(summary)
    audit_summary["missingNestedPrefabPlaceholderCount"] = sum(
        1 for item in prefab_instance_writes if item.get("missingNestedPrefab")
    )

    checks = {
        "exportPackageAudit": make_check(
            export_audit.get("allPass", False),
            export_audit.get("summary", {}),
            export_audit.get("blockingErrors", []),
        ),
        "figmaTarget": make_check(
            bool((plan.get("figma") or {}).get("url") or (plan.get("figma") or {}).get("fileKey")),
            plan.get("figma") or {},
            [] if bool((plan.get("figma") or {}).get("url") or (plan.get("figma") or {}).get("fileKey"))
            else [{"reason": "missing_figma_url_or_file_key"}],
        ),
        "imageUploadAssets": _check_image_upload_assets(image_uploads),
        "textWriteMetadata": _check_text_write_metadata(text_writes),
        "nineSliceMetadata": _check_nine_slice_metadata(nine_slice_writes),
        "prefabInstancePolicy": _check_prefab_instance_policy(prefab_instance_writes),
        "placeholderCleanupSeparated": make_check(
            not image_uploads or bool((operations.get("placeholderCleanup") or {}).get("requiresSeparateUseFigmaCall")),
            operations.get("placeholderCleanup") or {},
        ),
        "validationPlan": _check_validation_plan(plan.get("validation") or {}),
    }

    blocking_errors = []
    for check_name, check_result in checks.items():
        if check_result.get("pass"):
            continue
        blocking_errors.append({
            "code": check_name,
            "message": f"{check_name} check failed",
            "details": check_result.get("details", []),
        })

    warnings = _build_plan_warnings(plan)
    return {
        "allPass": len(blocking_errors) == 0,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "summary": audit_summary,
        "checks": checks,
        "artifacts": {
            "planPath": str(plan_path),
            "auditReportPath": str(plan_path.parent / AUDIT_FILE_NAME),
            "sourcePackagePath": plan.get("sourcePackagePath", ""),
        },
    }


def _build_image_upload_item(node: dict[str, Any], assets: dict[str, Any]) -> dict[str, Any]:
    """Build one image upload item."""

    image = node.get("image") or {}
    asset_key = image.get("asset", "")
    asset = assets.get(asset_key, {}) if asset_key else {}
    return {
        "nodeId": node.get("id", ""),
        "nodePath": node.get("path", ""),
        "nodeName": node.get("name", ""),
        "mode": image.get("mode", "simple"),
        "imageType": image.get("imageType", ""),
        "asset": asset_key,
        "assetPath": asset.get("assetPath") or image.get("sourceImage", {}).get("assetPath", ""),
        "pixelSize": image.get("pixelSize") or {"width": asset.get("width"), "height": asset.get("height")},
        "border": image.get("border", {}),
        "preserveAspect": image.get("preserveAspect"),
        "uvRect": image.get("uvRect") or {},
        "alpha": (image.get("color") or {}).get("a", 1),
        "tintUnsupported": _image_has_rgb_tint(image),
        "mustVerifyImageHashLength": 40,
        "mustWriteMetadata": ["spriteGuid", "spritePath", "imageType", "originalPixelSize"],
    }


def _build_text_write_item(node: dict[str, Any]) -> dict[str, Any]:
    """Build one text write item."""

    text = node.get("text") or {}
    effects = text.get("effects") or {}
    outline = effects.get("outline") or {}
    shared_material = text.get("sharedMaterial") or {}
    return {
        "nodeId": node.get("id", ""),
        "nodePath": node.get("path", ""),
        "nodeName": node.get("name", ""),
        "textLayerName": text.get("figmaTextLayerName", "__text"),
        "contentLength": len(text.get("content") or ""),
        "colorSource": "fontColor" if text.get("fontColor") else "color",
        "requiresOutlineStroke": bool(outline.get("width", 0)),
        "requiresUnderlayLayer": bool(effects.get("underlay")),
        "materialTag": text.get("materialTag", ""),
        "tmpMaterialName": shared_material.get("name", ""),
        "tmpMaterialGuid": shared_material.get("guid", ""),
        "mustWritePluginData": bool(text.get("materialTag")),
    }


def _build_nine_slice_item(node: dict[str, Any]) -> dict[str, Any]:
    """Build one nine-slice write item."""

    image = node.get("image") or {}
    source_image = image.get("sourceImage") or {}
    return {
        "nodeId": node.get("id", ""),
        "nodePath": node.get("path", ""),
        "sliceCount": len(image.get("slices") or []),
        "hasSourceImage": bool(source_image),
        "sourceImage": source_image,
        "mustUseCropTransformFromSourceRect": True,
        "mustWriteParentHiddenSourceFill": bool(source_image),
        "mustWriteSlicePluginData": True,
    }


def _normalize_nested_prefab_component_mode(value: str) -> str:
    """Normalize nested Prefab component mode."""

    if value == "none":
        return "none"
    return "commonOnly" if value == "commonOnly" else "all"


def _is_common_prefab_instance(item: dict[str, Any]) -> bool:
    """Return True when the nested Prefab looks like a common shared Prefab."""

    source_prefab = item.get("sourcePrefab") or {}
    instance_override = item.get("instanceOverride") or {}
    names = [
        str(source_prefab.get("name") or ""),
        Path(str(source_prefab.get("assetPath") or "")).stem,
        str(instance_override.get("name") or ""),
    ]
    return any(_is_common_prefab_name(name) for name in names)


def _is_common_prefab_name(name: str) -> bool:
    """Detect common shared Prefab naming prefixes."""

    normalized = name.strip().strip("[]")
    return normalized.startswith(("Common_", "Common-", "CommonPrefab_", "Common_Prefab_", "KaTong", "KaTone"))


def _resolve_prefab_instance_render_mode(item: dict[str, Any], nested_prefab_component_mode: str) -> str:
    """Resolve whether a nested Prefab should write as an instance or frame."""

    if nested_prefab_component_mode == "none":
        return "frame"
    if nested_prefab_component_mode == "commonOnly" and not _is_common_prefab_instance(item):
        return "frame"
    return "component"


def _build_prefab_instance_item(item: dict[str, Any], nested_prefab_component_mode: str = "all") -> dict[str, Any]:
    """Build one nested PrefabInstance write item."""

    source_prefab = item.get("sourcePrefab") or {}
    render_mode = _resolve_prefab_instance_render_mode(item, nested_prefab_component_mode)
    source_missing = not source_prefab.get("assetPath")
    if source_missing:
        render_mode = "missing"
    plan_item = {
        "renderMode": render_mode,
        "fileId": item.get("fileId", ""),
        "sourceGuid": source_prefab.get("guid", ""),
        "sourcePrefabAssetPath": source_prefab.get("assetPath", ""),
        "sourcePrefabAssetExists": source_prefab.get("assetExists"),
        "hasModification": item.get("hasModification", False),
        "sourcePrefab": source_prefab,
        "requiredAction": _resolve_prefab_instance_required_action(render_mode),
        "autoCreateWhenMissing": render_mode == "component",
        "nestedPrefabComponentMode": nested_prefab_component_mode,
        "isCommonPrefab": _is_common_prefab_instance(item),
        "mustSearchAllPages": True,
        "framePlaceholderForbidden": render_mode == "component",
    }
    if source_missing:
        plan_item["missingNestedPrefab"] = True
        plan_item["missingReason"] = "source_prefab_asset_not_found"
    if item.get("instanceOverride"):
        plan_item["instanceOverride"] = item.get("instanceOverride")
    if item.get("strippedRectTransformIds"):
        plan_item["strippedRectTransformIds"] = item.get("strippedRectTransformIds")
    return plan_item


def _resolve_prefab_instance_required_action(render_mode: str) -> str:
    """Return the write action for a planned nested Prefab instance."""

    if render_mode == "component":
        return "search_local_component_then_create_instance"
    if render_mode == "missing":
        return "create_missing_nested_prefab_placeholder"
    return "create_nested_prefab_frame"


def _build_unsupported_item(node: dict[str, Any]) -> dict[str, Any]:
    """Build report-only downgrade metadata for unsupported components."""

    return {
        "nodeId": node.get("id", ""),
        "nodePath": node.get("path", ""),
        "components": node.get("unsupported") or [],
        "requiredAction": "report_only_downgrade_without_visual_marker",
    }


def _build_transform_item(node: dict[str, Any], reason: str) -> dict[str, Any]:
    """Build one transform validation item for rotation or flip."""

    rect = node.get("rect") or {}
    return {
        "nodeId": node.get("id", ""),
        "nodePath": node.get("path", ""),
        "reason": reason,
        "rotationZ": rect.get("rotationZ", 0),
        "scaleX": rect.get("scaleX", 1),
        "scaleY": rect.get("scaleY", 1),
        "mustUseRelativeTransform": True,
    }


def _check_image_upload_assets(image_uploads: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate image upload asset paths."""

    missing = [
        item for item in image_uploads
        if not item.get("asset") or not item.get("assetPath")
    ]
    return make_check(
        len(missing) == 0,
        {"imageUploadCount": len(image_uploads), "missingAssetPathCount": len(missing)},
        missing,
    )


def _check_text_write_metadata(text_writes: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate TMP material metadata required for text writes."""

    missing = []
    for item in text_writes:
        if not item.get("mustWritePluginData"):
            continue
        missing_fields = [
            field for field in ("materialTag", "tmpMaterialName", "tmpMaterialGuid")
            if not item.get(field)
        ]
        if missing_fields:
            missing.append({
                "nodePath": item.get("nodePath", ""),
                "missingFields": missing_fields,
            })
    return make_check(
        len(missing) == 0,
        {
            "textWriteCount": len(text_writes),
            "tmpMaterialTextCount": sum(1 for item in text_writes if item.get("mustWritePluginData")),
            "missingMetadataCount": len(missing),
        },
        missing,
    )


def _check_nine_slice_metadata(nine_slice_writes: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate nine-slice write metadata."""

    invalid = []
    for item in nine_slice_writes:
        if item.get("sliceCount", 0) <= 0:
            invalid.append({"nodePath": item.get("nodePath", ""), "reason": "missing_slices"})
        if not item.get("hasSourceImage"):
            invalid.append({"nodePath": item.get("nodePath", ""), "reason": "missing_source_image"})
    return make_check(
        len(invalid) == 0,
        {"nineSliceCount": len(nine_slice_writes), "invalidCount": len(invalid)},
        invalid,
    )


def _check_prefab_instance_policy(prefab_instance_writes: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate nested Prefab writes while allowing explicit missing-source placeholders."""

    invalid = [
        item for item in prefab_instance_writes
        if not item.get("sourcePrefabAssetPath") and not item.get("missingNestedPrefab")
    ]
    return make_check(
        len(invalid) == 0,
        {
            "prefabInstanceCount": len(prefab_instance_writes),
            "resolvedPrefabInstanceCount": sum(1 for item in prefab_instance_writes if item.get("sourcePrefabAssetPath")),
            "missingNestedPrefabPlaceholderCount": sum(1 for item in prefab_instance_writes if item.get("missingNestedPrefab")),
        },
        invalid,
    )


def _check_validation_plan(validation: dict[str, Any]) -> dict[str, Any]:
    """Validate that readback checks cover known failure classes."""

    required = {
        "nodeCount",
        "imageFillHashLength",
        "imageLayerVisual",
        "unityNodeGeometry",
        "unityNodeOrder",
        "unityNodeState",
        "tmpMaterialPluginData",
        "textOutlineStroke",
        "prefabInstanceNodeType",
        "prefabInstanceGeometry",
        "nineSliceSourceImageMetadata",
        "componentModeResult",
        "screenshotAcceptance",
        "fontConsistency",
    }
    actual = set(validation.get("requiredReadBackChecks") or [])
    missing = sorted(required - actual)
    return make_check(
        not missing,
        {"requiredCheckCount": len(required), "actualCheckCount": len(actual)},
        missing,
    )


def _image_has_rgb_tint(image: dict[str, Any]) -> bool:
    """Return True when Unity image RGB tint is not white."""

    color = image.get("color") or {}
    if not isinstance(color, dict):
        return False
    return (
        abs(float(color.get("r", 1) or 1) - 1.0) > 0.001
        or abs(float(color.get("g", 1) or 1) - 1.0) > 0.001
        or abs(float(color.get("b", 1) or 1) - 1.0) > 0.001
    )


def _build_plan_warnings(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Build structured warnings from the write plan."""

    warnings: list[dict[str, Any]] = []
    operations = plan.get("operations") or {}
    summary = plan.get("summary") or {}
    if summary.get("prefabInstanceCount", 0) > 0:
        warnings.append({
            "code": "prefabInstancesRequireFigmaInstances",
            "message": "Nested PrefabInstances require component lookup and INSTANCE creation when renderMode is component.",
            "details": operations.get("prefabInstanceWrites") or [],
        })
    missing_nested = [
        item for item in operations.get("prefabInstanceWrites") or []
        if item.get("missingNestedPrefab")
    ]
    if missing_nested:
        warnings.append({
            "code": "missingNestedPrefabPlaceholders",
            "message": "Nested Prefab source assets are missing; write stage will create visible placeholder frames at the original override geometry.",
            "details": missing_nested,
        })
    if summary.get("unsupportedNodeCount", 0) > 0:
        warnings.append({
            "code": "unsupportedComponentsDowngraded",
            "message": "Unsupported Unity components are report-only downgrades; no visible __unsupported marker layer is created by default.",
            "details": operations.get("unsupportedMarkers") or [],
        })
    if summary.get("rotatedNodeCount", 0) > 0:
        warnings.append({
            "code": "relativeTransformRequired",
            "message": "Rotated nodes must be written with relativeTransform, not node.rotation.",
            "details": operations.get("rotationTransforms") or [],
        })
    if summary.get("flippedNodeCount", 0) > 0:
        warnings.append({
            "code": "flipTransformRequired",
            "message": "Negative-scale nodes must preserve flips with relativeTransform.",
            "details": operations.get("flipTransforms") or [],
        })
    return warnings


def _needs_import_bounds_wrapper(package: dict[str, Any]) -> bool:
    """Return True when visual bounds require an ImportBounds wrapper."""

    root_rect = (package.get("root") or {}).get("rect") or {}
    visual_bounds = package.get("visualBounds") or {}
    if not root_rect or not visual_bounds:
        return False
    return (
        float(visual_bounds.get("x", 0) or 0) < 0
        or float(visual_bounds.get("y", 0) or 0) < 0
        or float(visual_bounds.get("width", 0) or 0) > float(root_rect.get("width", 0) or 0)
        or float(visual_bounds.get("height", 0) or 0) > float(root_rect.get("height", 0) or 0)
    )


def _resolve_top_level_name(package: dict[str, Any]) -> str:
    """Resolve the top-level node name for component mode."""

    root_name = (package.get("root") or {}).get("name", "")
    if _needs_import_bounds_wrapper(package):
        return f"{root_name}__ImportBounds"
    return root_name


def _missing_package_result(package_path: Path, out_dir: Path) -> dict[str, Any]:
    """Build a standard blocking report when the package is missing."""

    error = {
        "code": "packageMissing",
        "message": "prefab-to-figma package is missing; cannot build Figma write plan.",
        "details": [{"path": str(package_path)}],
    }
    return {
        "allPass": False,
        "blockingErrors": [error],
        "warnings": [],
        "summary": {},
        "checks": {
            "packageExists": make_check(False, {"path": str(package_path)}, [{"path": str(package_path)}]),
        },
        "artifacts": {
            "auditReportPath": str(out_dir / AUDIT_FILE_NAME),
            "sourcePackagePath": str(package_path),
        },
    }


def _write_result(default_path: Path, override_path: str, result: dict[str, Any]) -> None:
    """Write the audit report to the default path and optional override path."""

    default_path.parent.mkdir(parents=True, exist_ok=True)
    default_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if override_path and Path(override_path) != default_path:
        output_path = Path(override_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
