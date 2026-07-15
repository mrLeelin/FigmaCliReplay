#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Compare prefab-to-figma JSON against Unity runtime truth."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


REPORT_FILE_NAME = "unity_truth_compare_report.json"
DEFAULT_TOLERANCE = 1.0


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def comparable_child_nodes(node: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        child
        for child in (node.get("children") or [])
        if isinstance(child, dict) and not is_ignored_runtime_node(child)
    ]


def is_ignored_runtime_node(node: dict[str, Any]) -> bool:
    name = str(node.get("name") or "")
    # TextMeshPro creates runtime submesh children for fallback/material atlases.
    # The exporter intentionally represents these through metadata on the parent
    # text node and generated Figma text layers, not as Unity hierarchy nodes.
    return name.startswith("TMP SubMeshUI ") or name == "[generated] UIParticleRenderer"


# The exporter legitimately skips some nested children (particle / non-UGUI
# PrefabInstance whose root RectTransform size is invalid, or RectTransform whose
# GameObject cannot be resolved). It records one warning per skipped child under a
# parent path. These skips are by-design, so the corresponding Unity runtime nodes
# must be reported as warnings, not blocking "missingExportNode" errors.
_SKIP_CHILD_WARNING_RE = re.compile(
    r"(?:Skipped[^\n]*?|Missing child RectTransform[^\n]*?)\bunder\b\s+(?P<parent>.+?)\s*$"
)


def collect_skip_budget(package: dict[str, Any]) -> dict[str, int]:
    """Count exporter-declared skipped children grouped by parent path.

    Returns a mapping of parent path -> number of children the exporter reported
    as intentionally skipped. The compare step spends this budget to downgrade the
    matching Unity runtime nodes from blocking errors to warnings.
    """
    budget: dict[str, int] = {}
    for warning in package.get("warnings") or []:
        match = _SKIP_CHILD_WARNING_RE.search(str(warning))
        if not match:
            continue
        parent = match.group("parent").strip()
        if not parent:
            continue
        budget[parent] = budget.get(parent, 0) + 1
    return budget


def align_children_by_name(
    exported_children: list[dict[str, Any]],
    truth_children: list[dict[str, Any]],
) -> list[tuple[dict[str, Any] | None, dict[str, Any] | None]]:
    """Order-preserving alignment of children by name via longest common subsequence.

    Pairs are returned in truth order. A pair with exported=None means the truth
    child has no exported counterpart (possibly an intentional skip); a pair with
    truth=None means the exported tree has an extra node. This avoids the index
    drift that a positional zip causes when the exporter drops whole subtrees.
    """
    exp_names = [str(c.get("name") or "") for c in exported_children]
    truth_names = [str(c.get("name") or "") for c in truth_children]
    rows, cols = len(exp_names), len(truth_names)

    lcs = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(rows - 1, -1, -1):
        for j in range(cols - 1, -1, -1):
            if exp_names[i] == truth_names[j]:
                lcs[i][j] = lcs[i + 1][j + 1] + 1
            else:
                lcs[i][j] = max(lcs[i + 1][j], lcs[i][j + 1])

    pairs: list[tuple[dict[str, Any] | None, dict[str, Any] | None]] = []
    i = j = 0
    while i < rows and j < cols:
        if exp_names[i] == truth_names[j]:
            pairs.append((exported_children[i], truth_children[j]))
            i += 1
            j += 1
        elif lcs[i + 1][j] >= lcs[i][j + 1]:
            pairs.append((exported_children[i], None))
            i += 1
        else:
            pairs.append((None, truth_children[j]))
            j += 1
    while i < rows:
        pairs.append((exported_children[i], None))
        i += 1
    while j < cols:
        pairs.append((None, truth_children[j]))
        j += 1
    return pairs


def rect_value(node: dict[str, Any], key: str) -> float:
    rect = node.get("rect") or {}
    try:
        return float(rect.get(key, 0.0))
    except (TypeError, ValueError):
        return 0.0


def number_value(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def bool_value(value: Any) -> bool:
    return bool(value)


def compare_rect(path: str, exported: dict[str, Any], truth: dict[str, Any], tolerance: float) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    for key in ("x", "y", "width", "height"):
        expected = rect_value(truth, key)
        actual = rect_value(exported, key)
        delta = actual - expected
        if abs(delta) > tolerance:
            errors.append({
                "code": "rectMismatch",
                "path": path,
                "field": key,
                "expected": round(expected, 6),
                "actual": round(actual, 6),
                "delta": round(delta, 6),
                "tolerance": tolerance,
            })
    rotation_delta = rect_value(exported, "rotationZ") - rect_value(truth, "rotationZ")
    if abs(rotation_delta) > 0.1:
        errors.append({
            "code": "rotationMismatch",
            "path": path,
            "field": "rotationZ",
            "expected": round(rect_value(truth, "rotationZ"), 6),
            "actual": round(rect_value(exported, "rotationZ"), 6),
            "delta": round(rotation_delta, 6),
            "tolerance": 0.1,
        })
    return errors


def is_unsupported_runtime_geometry_downgrade(node: dict[str, Any]) -> bool:
    unsupported = " ".join(str(item) for item in (node.get("unsupported") or []))
    return "UIParticle" in unsupported or "Particle" in unsupported


def downgrade_rect_errors(path: str, errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not errors:
        return []
    return [{
        "code": "unsupportedRuntimeGeometryDowngraded",
        "path": path,
        "message": "Unsupported runtime component geometry differs from Unity runtime truth and is reported as a downgrade.",
        "details": errors,
    }]


def compare_image(path: str, exported: dict[str, Any], truth: dict[str, Any]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    exported_has = bool(exported.get("image"))
    truth_has = bool(truth.get("image") or truth.get("rawImage"))
    if truth_has and not exported_has:
        warnings.append({
            "code": "runtimeImageMissingInExport",
            "path": path,
            "message": "Unity runtime has Image/RawImage but prefab-to-figma JSON has no image payload.",
        })
    return warnings


def compare_text(path: str, exported: dict[str, Any], truth: dict[str, Any]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    exported_text = exported.get("text")
    truth_text = truth.get("text")
    if truth_text and not exported_text:
        warnings.append({
            "code": "runtimeTextMissingInExport",
            "path": path,
            "message": "Unity runtime has Text/TMP_Text but prefab-to-figma JSON has no text payload.",
        })
    elif truth_text and exported_text:
        expected = str(truth_text.get("text", ""))
        actual = str(exported_text.get("text", exported_text.get("content", "")))
        if expected != actual:
            warnings.append({
                "code": "textContentMismatch",
                "path": path,
                "expected": expected,
                "actual": actual,
            })
    return warnings


def compare_canvas_group(path: str, exported: dict[str, Any], truth: dict[str, Any]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    truth_group = truth.get("canvasGroup") or {}
    exported_group = exported.get("canvasGroup") or {}
    if truth_group and not exported_group:
        warnings.append({
            "code": "runtimeCanvasGroupMissingInExport",
            "path": path,
            "message": "Unity runtime has CanvasGroup but prefab-to-figma JSON has no canvasGroup payload.",
        })
        return warnings
    if truth_group and exported_group:
        expected = number_value(truth_group.get("alpha"), 1.0)
        actual = number_value(exported_group.get("alpha"), 1.0)
        if abs(expected - actual) > 0.001:
            warnings.append({
                "code": "canvasGroupAlphaMismatch",
                "path": path,
                "expected": round(expected, 6),
                "actual": round(actual, 6),
            })
        effective = number_value(truth_group.get("effectiveAlpha"), expected)
        if abs(effective - expected) > 0.001 and "effectiveAlpha" not in exported_group:
            warnings.append({
                "code": "canvasGroupEffectiveAlphaNotExported",
                "path": path,
                "expectedEffectiveAlpha": round(effective, 6),
                "exportedLocalAlpha": round(actual, 6),
            })
    return warnings


def compare_package(package: dict[str, Any], truth: dict[str, Any], tolerance: float) -> dict[str, Any]:
    exported_root = package.get("root") or {}
    truth_root = truth.get("root") or {}
    skip_budget = collect_skip_budget(package)

    blocking_errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    order_mismatch_paths: list[str] = []
    stats = {"exported": 0, "truth": 0, "matched": 0}

    def truth_path_of(node: dict[str, Any], parent_path: str) -> str:
        name = str(node.get("name") or "")
        return str(node.get("path") or (f"{parent_path}/{name}" if parent_path else name))

    def count_subtree(node: dict[str, Any]) -> int:
        total = 1
        for child in comparable_child_nodes(node):
            total += count_subtree(child)
        return total

    def walk(exported_node: dict[str, Any], truth_node: dict[str, Any], parent_path: str, index: int) -> None:
        name = str(truth_node.get("name") or "")
        path = truth_path_of(truth_node, parent_path)
        structural_path = f"{parent_path}/{index}" if parent_path else "0"
        display_path = f"{path} [{structural_path}]"
        stats["exported"] += 1
        stats["truth"] += 1
        stats["matched"] += 1

        exported_name = str(exported_node.get("name") or "")
        if exported_name != name:
            blocking_errors.append({
                "code": "nodeNameMismatch",
                "path": display_path,
                "structuralPath": structural_path,
                "expected": name,
                "actual": exported_name,
            })

        rect_errors = compare_rect(display_path, exported_node, truth_node, tolerance)
        for error in rect_errors:
            error["structuralPath"] = structural_path
        if rect_errors and is_unsupported_runtime_geometry_downgrade(exported_node):
            warnings.extend(downgrade_rect_errors(display_path, rect_errors))
        else:
            blocking_errors.extend(rect_errors)

        if bool_value(exported_node.get("active")) != bool_value(truth_node.get("activeSelf")):
            warnings.append({
                "code": "activeStateMismatch",
                "path": display_path,
                "expected": bool_value(truth_node.get("activeSelf")),
                "actual": bool_value(exported_node.get("active")),
            })
        warnings.extend(compare_image(display_path, exported_node, truth_node))
        warnings.extend(compare_text(display_path, exported_node, truth_node))
        warnings.extend(compare_canvas_group(display_path, exported_node, truth_node))

        exp_children = comparable_child_nodes(exported_node)
        truth_children = comparable_child_nodes(truth_node)
        pairs = align_children_by_name(exp_children, truth_children)

        exp_seq = [str(c.get("name") or "") for c in exp_children]
        truth_seq = [str(c.get("name") or "") for c in truth_children]
        remaining_skip = skip_budget.get(path, 0)

        child_index = 0
        for exported_child, truth_child in pairs:
            if exported_child is not None and truth_child is not None:
                walk(exported_child, truth_child, structural_path, child_index)
                child_index += 1
            elif truth_child is not None:
                # Truth has a node the exporter did not emit.
                missing_path = truth_path_of(truth_child, path)
                missing_structural = f"{structural_path}/{child_index}"
                subtree_size = count_subtree(truth_child)
                stats["truth"] += subtree_size
                if remaining_skip > 0:
                    remaining_skip -= 1
                    warnings.append({
                        "code": "skippedExportSubtree",
                        "path": f"{missing_path} [{missing_structural}]",
                        "structuralPath": missing_structural,
                        "subtreeNodeCount": subtree_size,
                        "message": "Unity runtime node was intentionally skipped by the exporter (recorded in package warnings).",
                    })
                else:
                    blocking_errors.append({
                        "code": "missingExportNode",
                        "path": f"{missing_path} [{missing_structural}]",
                        "structuralPath": missing_structural,
                        "message": "Unity runtime node is missing from prefab-to-figma JSON.",
                    })
                child_index += 1
            else:
                # Exporter emitted a node that truth does not have.
                extra_path = truth_path_of(exported_child, path)
                extra_structural = f"{structural_path}/{child_index}"
                stats["exported"] += count_subtree(exported_child)
                blocking_errors.append({
                    "code": "extraExportNode",
                    "path": f"{extra_path} [{extra_structural}]",
                    "structuralPath": extra_structural,
                    "message": "prefab-to-figma JSON contains a node that is not present in Unity runtime hierarchy.",
                })
                child_index += 1

        if exp_seq != truth_seq:
            order_mismatch_paths.append(path)
            warnings.append({
                "code": "childOrderDiff",
                "path": path,
                "structuralPath": structural_path,
                "expected": truth_seq,
                "actual": exp_seq,
            })

    if exported_root and truth_root:
        walk(exported_root, truth_root, "", 0)
    elif truth_root:
        blocking_errors.append({
            "code": "missingExportNode",
            "path": truth_path_of(truth_root, ""),
            "structuralPath": "0",
            "message": "Unity runtime root is missing from prefab-to-figma JSON.",
        })

    return {
        "allPass": len(blocking_errors) == 0,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "summary": {
            "exportedNodeCount": stats["exported"],
            "unityNodeCount": stats["truth"],
            "matchedNodeCount": stats["matched"],
            "rectTolerancePx": tolerance,
            "blockingErrorCount": len(blocking_errors),
            "warningCount": len(warnings),
            "skippedSubtreeCount": len([w for w in warnings if w.get("code") == "skippedExportSubtree"]),
        },
        "checks": {
            "nodePathSet": len([e for e in blocking_errors if e.get("code") in {"missingExportNode", "extraExportNode"}]) == 0,
            "rectsWithinTolerance": len([e for e in blocking_errors if e.get("code") == "rectMismatch"]) == 0,
            "siblingOrder": len(order_mismatch_paths) == 0,
        },
        "artifacts": {},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare prefab-to-figma package with Unity runtime truth")
    parser.add_argument("--package", required=True)
    parser.add_argument("--truth", required=True)
    parser.add_argument("--output-report", required=True)
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    args = parser.parse_args()

    package_path = Path(args.package)
    truth_path = Path(args.truth)
    report_path = Path(args.output_report)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    report = compare_package(load_json(package_path), load_json(truth_path), args.tolerance)
    report["artifacts"] = {
        "packagePath": str(package_path),
        "truthPath": str(truth_path),
        "compareReportPath": str(report_path),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Unity truth compare allPass={report['allPass']}")
    return 0 if report["allPass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
