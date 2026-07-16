#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read Figma -> Unity Prefab artifacts and report phase-level evidence.

This script is intentionally read-only. It does not call Figma, write PNGs,
create Prefabs, refresh Unity, or run verification. It only summarizes existing
artifacts so the next safe action is explicit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any
from unity_project_paths import resolve_unity_project

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


PHASE_ORDER = [
    "inputLock",
    "hierarchyGate",
    "figmaExport",
    "specDraft",
    "imageWrite",
    "prefabVerify",
]


def relay_root() -> Path:
    script_path = Path(__file__).resolve()
    for parent in script_path.parents:
        if (parent / "client" / "figma_mcp_client.py").is_file():
            return parent
    raise RuntimeError(
        f"Unable to locate the Figma MCP Relay root containing client/figma_mcp_client.py from {script_path}."
    )


RELAY_ROOT = relay_root()


def requested_unity_tmp(unity_project: str, unity_tmp: str) -> Path:
    if unity_tmp.strip():
        return resolve_path(unity_tmp)
    raw_project = unity_project.strip() or os.environ.get("FIGMA_UNITY_PROJECT", "").strip()
    project_root = resolve_unity_project(unity_project) if raw_project else None
    if project_root:
        return project_root / ".tmp"
    return RELAY_ROOT / ".tmp"


def resolve_path(raw: str | Path, base: Path | None = None) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    candidates = []
    if base:
        candidates.append(base / path)
    candidates.append(Path.cwd() / path)
    candidates.append(RELAY_ROOT / path)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return (base or RELAY_ROOT) / path


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"__readError": str(exc)}


def first_existing(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.is_file():
            return path
    return None


def sha256_file(path: Path | None) -> str:
    if not path or not path.is_file():
        return ""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def phase(status: str, evidence: dict[str, Any], next_action: str = "") -> dict[str, Any]:
    payload = {"status": status, "evidence": evidence}
    if next_action:
        payload["nextAction"] = next_action
    return payload


def unwrap_result(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    return result if isinstance(result, dict) else payload


def compact_errors(items: Any, max_samples: int) -> list[Any]:
    if not isinstance(items, list):
        return []
    return items[: max(0, max_samples)]


def root_node_from_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    root_id = manifest.get("rootNodeId") or (manifest.get("root") or {}).get("id", "")
    nodes = manifest.get("nodes")
    if isinstance(nodes, list):
        for node in nodes:
            if isinstance(node, dict) and node.get("id") == root_id:
                return node
        if nodes and isinstance(nodes[0], dict):
            return nodes[0]
    root = manifest.get("root")
    return root if isinstance(root, dict) else {}


def direct_child_count(manifest: dict[str, Any], root_node: dict[str, Any]) -> int | None:
    child_ids = root_node.get("childIds")
    if isinstance(child_ids, list):
        return len(child_ids)
    children = root_node.get("children")
    if isinstance(children, list):
        return len(children)
    root = manifest.get("root")
    if isinstance(root, dict):
        child_ids = root.get("childIds")
        if isinstance(child_ids, list):
            return len(child_ids)
    return None


def build_input_phase(request_path: Path | None, node_manifest: dict[str, Any]) -> dict[str, Any]:
    request = read_json(request_path) if request_path else {}
    if request.get("__readError"):
        return phase(
            "stop",
            {"requestPath": request_path.as_posix() if request_path else "", "error": request["__readError"]},
            "Regenerate figma_to_prefab_request.json before writing Unity assets.",
        )
    figma = request.get("figma") if isinstance(request.get("figma"), dict) else {}
    unity = request.get("unity") if isinstance(request.get("unity"), dict) else {}
    evidence = {
        "requestPath": request_path.as_posix() if request_path else "",
        "fileKey": figma.get("fileKey") or node_manifest.get("fileKey", ""),
        "nodeId": figma.get("nodeId") or node_manifest.get("rootNodeId", ""),
        "rootName": node_manifest.get("rootName", ""),
        "targetPrefab": unity.get("targetPrefabPath", ""),
        "targetImageDir": unity.get("targetImageDirectory", ""),
        "overwritePolicy": unity.get("overwritePolicy", ""),
    }
    if not evidence["fileKey"] or not evidence["nodeId"]:
        return phase("unknown", evidence, "Lock fileKey/nodeId before export or Unity writes.")
    if not evidence["targetPrefab"] or not evidence["targetImageDir"]:
        return phase("unknown", evidence, "Lock target Prefab and image directory before Unity writes.")
    return phase("go", evidence)


def build_hierarchy_phase(node_manifest_path: Path | None, max_direct_children: int) -> tuple[dict[str, Any], dict[str, Any]]:
    if not node_manifest_path:
        return phase(
            "unknown",
            {"nodeManifestPath": ""},
            "Run MCP export or provide --node-manifest.",
        ), {}
    manifest = read_json(node_manifest_path)
    if manifest.get("__readError"):
        return phase(
            "stop",
            {"nodeManifestPath": node_manifest_path.as_posix(), "error": manifest["__readError"]},
            "Regenerate the Figma node manifest.",
        ), {}
    root = root_node_from_manifest(manifest)
    count = direct_child_count(manifest, root)
    evidence = {
        "nodeManifestPath": node_manifest_path.as_posix(),
        "fileKey": manifest.get("fileKey", ""),
        "rootNodeId": manifest.get("rootNodeId") or root.get("id", ""),
        "rootName": manifest.get("rootName") or root.get("name", ""),
        "rootType": root.get("type", ""),
        "nodeCount": len(manifest.get("nodes", []) if isinstance(manifest.get("nodes"), list) else []),
        "directChildCount": count,
        "maxDirectChildren": max_direct_children,
    }
    if count is None:
        return phase("unknown", evidence, "Read direct children before export/spec decisions."), manifest
    if count > max_direct_children:
        return phase(
            "stop",
            evidence,
            "Run figma-hierarchy-cleanup-mcp and verify before generating export/spec/images.",
        ), manifest
    return phase("go", evidence), manifest


def build_figma_export_phase(result_path: Path | None, image_manifest_path: Path | None, max_samples: int) -> dict[str, Any]:
    if not result_path:
        return phase(
            "unknown",
            {"mcpResultPath": ""},
            "Run figma_to_prefab_mcp_client.py or run_full_import.py MCP export.",
        )
    payload = read_json(result_path)
    if payload.get("__readError"):
        return phase(
            "stop",
            {"mcpResultPath": result_path.as_posix(), "error": payload["__readError"]},
            "Regenerate the MCP export result.",
        )
    result = unwrap_result(payload)
    warnings = result.get("warnings") if isinstance(result.get("warnings"), list) else []
    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    blocking = result.get("blockingErrors") if isinstance(result.get("blockingErrors"), list) else []
    screenshot = result.get("screenshot") if isinstance(result.get("screenshot"), dict) else {}
    evidence = {
        "mcpResultPath": result_path.as_posix(),
        "imageManifestPath": image_manifest_path.as_posix() if image_manifest_path else "",
        "imageManifestExists": bool(image_manifest_path and image_manifest_path.is_file()),
        "status": result.get("status", "unknown"),
        "rootNodeId": result.get("rootNodeId", ""),
        "rootName": result.get("rootName", ""),
        "createdCount": result.get("createdCount", 0),
        "warningCount": len(warnings),
        "blockingErrorCount": len(blocking),
        "errorCount": len(errors),
        "blockingErrorSamples": compact_errors(blocking, max_samples),
        "errorSamples": compact_errors(errors, max_samples),
        "screenshot": {
            "path": screenshot.get("path", ""),
            "fileValid": screenshot.get("fileValid"),
            "width": screenshot.get("width"),
            "height": screenshot.get("height"),
        },
    }
    if result.get("status") != "completed" or blocking or errors or not evidence["imageManifestExists"]:
        return phase("stop", evidence, "Fix MCP export before gen_spec or image processing.")
    return phase("go", evidence)


def build_spec_phase(
    audit_path: Path | None,
    plan_path: Path | None,
    componentset_path: Path | None,
    spec_path: Path | None,
    max_samples: int,
) -> dict[str, Any]:
    if not audit_path:
        return phase(
            "unknown",
            {"specAuditPath": ""},
            "Run gen_spec.py --output-audit-report.",
        )
    audit = read_json(audit_path)
    if audit.get("__readError"):
        return phase("stop", {"specAuditPath": audit_path.as_posix(), "error": audit["__readError"]})
    blocking = audit.get("blockingErrors") if isinstance(audit.get("blockingErrors"), list) else []
    warnings = audit.get("warnings") if isinstance(audit.get("warnings"), list) else []
    plan = read_json(plan_path) if plan_path and plan_path.is_file() else {}
    componentset = read_json(componentset_path) if componentset_path and componentset_path.is_file() else {}
    spec = read_json(spec_path) if spec_path and spec_path.is_file() else {}
    provenance = plan.get("manifestProvenance") if isinstance(plan.get("manifestProvenance"), dict) else {}
    provenance_root_id = provenance.get("rootNodeId") or provenance.get("rootId", "")
    evidence = {
        "specAuditPath": audit_path.as_posix(),
        "prefabSpecPath": spec_path.as_posix() if spec_path else "",
        "prefabPath": spec.get("prefabPath", "") if isinstance(spec, dict) else "",
        "imageDownloadPlanPath": plan_path.as_posix() if plan_path else "",
        "componentsetReportPath": componentset_path.as_posix() if componentset_path else "",
        "allPass": audit.get("allPass"),
        "blockingErrorCount": len(blocking),
        "warningCount": len(warnings),
        "blockingErrorSamples": compact_errors(blocking, max_samples),
        "summary": audit.get("summary", {}),
        "manifestProvenance": {
            "present": bool(provenance),
            "rootNodeId": provenance_root_id,
            "figmaNodeManifestSha256": provenance.get("figmaNodeManifestSha256", ""),
            "imageExportManifestSha256": provenance.get("imageExportManifestSha256", ""),
        },
        "componentsetBlockingErrorCount": len(componentset.get("blockingErrors", []) if isinstance(componentset.get("blockingErrors"), list) else []),
    }
    if audit.get("allPass") is not True or blocking or evidence["componentsetBlockingErrorCount"]:
        return phase("stop", evidence, "Fix spec audit/provenance before image writes.")
    if not provenance:
        return phase("unknown", evidence, "Regenerate gen_spec output so image_download_plan.json has manifestProvenance.")
    return phase("go", evidence)


def build_image_phase(image_report_path: Path | None, max_samples: int) -> dict[str, Any]:
    if not image_report_path:
        return phase(
            "unknown",
            {"imageProcessReportPath": ""},
            "Run process_images.py after the Unity write plan is confirmed.",
        )
    report = read_json(image_report_path)
    if report.get("__readError"):
        return phase("stop", {"imageProcessReportPath": image_report_path.as_posix(), "error": report["__readError"]})
    blocking = report.get("blockingErrors") if isinstance(report.get("blockingErrors"), list) else []
    warnings = report.get("warnings") if isinstance(report.get("warnings"), list) else []
    summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
    download_count = summary.get("downloadPlanImageCount") if isinstance(summary.get("downloadPlanImageCount"), int) else 0
    output_count = sum(
        int(summary.get(key) or 0)
        for key in ("normalImageWritten", "existingImageReused", "commonTextureCopied")
    )
    evidence = {
        "imageProcessReportPath": image_report_path.as_posix(),
        "allPass": report.get("allPass"),
        "blockingErrorCount": len(blocking),
        "warningCount": len(warnings),
        "blockingErrorSamples": compact_errors(blocking, max_samples),
        "summary": summary,
    }
    if report.get("allPass") is not True or blocking:
        return phase("stop", evidence, "Fix image processing before Prefab generation.")
    if download_count > 0 and output_count <= 0:
        return phase("stop", evidence, "Image phase produced/reused zero files for a non-empty download plan.")
    return phase("go", evidence)


def build_verify_phase(verify_path: Path | None, max_samples: int) -> dict[str, Any]:
    if not verify_path:
        return phase(
            "unknown",
            {"verifyPrefabReportPath": ""},
            "Run verify_prefab.py after Prefab generation.",
        )
    report = read_json(verify_path)
    if report.get("__readError"):
        return phase("stop", {"verifyPrefabReportPath": verify_path.as_posix(), "error": report["__readError"]})
    blocking = report.get("blockingErrors") if isinstance(report.get("blockingErrors"), list) else []
    warnings = report.get("warnings") if isinstance(report.get("warnings"), list) else []
    evidence = {
        "verifyPrefabReportPath": verify_path.as_posix(),
        "prefabPath": report.get("prefabPath", ""),
        "resolvedPrefabPath": report.get("resolvedPrefabPath", ""),
        "allPass": report.get("allPass"),
        "blockingErrorCount": len(blocking),
        "warningCount": len(warnings),
        "blockingErrorSamples": compact_errors(blocking, max_samples),
        "summary": report.get("summary", {}),
    }
    if report.get("allPass") is not True or blocking:
        return phase("stop", evidence, "Fix only the failing verify_prefab checks.")
    return phase("go", evidence)


def normalize_asset_path(path: str) -> str:
    value = str(path or "").replace("\\", "/").strip()
    marker = "/Assets/"
    if marker in value:
        value = "Assets/" + value.split(marker, 1)[1]
    return value.strip("/")


def apply_consistency_checks(phases: dict[str, dict[str, Any]]) -> None:
    input_ev = phases["inputLock"].get("evidence", {})
    hierarchy_ev = phases["hierarchyGate"].get("evidence", {})
    export_ev = phases["figmaExport"].get("evidence", {})
    spec_ev = phases["specDraft"].get("evidence", {})
    verify_ev = phases["prefabVerify"].get("evidence", {})

    requested_file_key = input_ev.get("fileKey", "")
    requested_node_id = input_ev.get("nodeId", "")
    hierarchy_file_key = hierarchy_ev.get("fileKey", "")
    hierarchy_root_id = hierarchy_ev.get("rootNodeId", "")
    export_root_id = export_ev.get("rootNodeId", "")
    provenance = spec_ev.get("manifestProvenance") if isinstance(spec_ev.get("manifestProvenance"), dict) else {}
    provenance_root_id = provenance.get("rootNodeId", "")
    target_prefab = normalize_asset_path(str(input_ev.get("targetPrefab", "")))
    spec_prefab = normalize_asset_path(str(spec_ev.get("prefabPath", "")))
    verified_prefab = normalize_asset_path(str(verify_ev.get("prefabPath", "")))
    node_manifest_path = Path(str(hierarchy_ev.get("nodeManifestPath", ""))) if hierarchy_ev.get("nodeManifestPath") else None
    image_manifest_path = Path(str(export_ev.get("imageManifestPath", ""))) if export_ev.get("imageManifestPath") else None
    node_manifest_sha = sha256_file(node_manifest_path)
    image_manifest_sha = sha256_file(image_manifest_path)

    checks = []
    if requested_file_key and hierarchy_file_key:
        checks.append({
            "name": "requestFileKeyMatchesManifest",
            "pass": requested_file_key == hierarchy_file_key,
            "expected": requested_file_key,
            "actual": hierarchy_file_key,
        })
    if requested_node_id and hierarchy_root_id:
        checks.append({
            "name": "requestNodeMatchesManifest",
            "pass": requested_node_id == hierarchy_root_id,
            "expected": requested_node_id,
            "actual": hierarchy_root_id,
        })
    if export_root_id and hierarchy_root_id:
        checks.append({
            "name": "mcpResultMatchesManifest",
            "pass": export_root_id == hierarchy_root_id,
            "expected": hierarchy_root_id,
            "actual": export_root_id,
        })
    if provenance_root_id and hierarchy_root_id:
        checks.append({
            "name": "specProvenanceMatchesManifest",
            "pass": provenance_root_id == hierarchy_root_id,
            "expected": hierarchy_root_id,
            "actual": provenance_root_id,
        })
    if provenance.get("figmaNodeManifestSha256") and node_manifest_sha:
        checks.append({
            "name": "specNodeManifestHashMatchesFile",
            "pass": provenance.get("figmaNodeManifestSha256") == node_manifest_sha,
            "expected": node_manifest_sha,
            "actual": provenance.get("figmaNodeManifestSha256"),
        })
    if provenance.get("imageExportManifestSha256") and image_manifest_sha:
        checks.append({
            "name": "specImageManifestHashMatchesFile",
            "pass": provenance.get("imageExportManifestSha256") == image_manifest_sha,
            "expected": image_manifest_sha,
            "actual": provenance.get("imageExportManifestSha256"),
        })
    if target_prefab and spec_prefab:
        checks.append({
            "name": "specPrefabMatchesTarget",
            "pass": target_prefab == spec_prefab,
            "expected": target_prefab,
            "actual": spec_prefab,
        })
    if target_prefab and verified_prefab:
        checks.append({
            "name": "verifyPrefabMatchesTarget",
            "pass": target_prefab == verified_prefab,
            "expected": target_prefab,
            "actual": verified_prefab,
        })

    failed = [item for item in checks if not item.get("pass")]
    phases["consistency"] = phase(
        "stop" if failed else "go",
        {
            "checks": checks,
            "failed": failed,
        },
        "Artifact phases are from different runs; regenerate or pass matching artifact paths." if failed else "",
    )


def build_timing_phase(wall_clock_path: Path | None) -> dict[str, Any]:
    if not wall_clock_path:
        return phase("unknown", {"wallClockReportPath": ""}, "Timing evidence is optional for partial runs.")
    report = read_json(wall_clock_path)
    if report.get("__readError"):
        return phase("unknown", {"wallClockReportPath": wall_clock_path.as_posix(), "error": report["__readError"]})
    return phase("go", {
        "wallClockReportPath": wall_clock_path.as_posix(),
        "status": report.get("status", ""),
        "elapsedSeconds": report.get("elapsedSeconds"),
        "timings": report.get("timings", []),
    })


def decide(phases: dict[str, dict[str, Any]]) -> tuple[str, str]:
    for name in [*PHASE_ORDER, "consistency"]:
        if name not in phases:
            continue
        item = phases[name]
        if item.get("status") == "stop":
            return "stop", item.get("nextAction", "Fix the stopped phase before continuing.")

    first_unknown = None
    first_unknown_name = ""
    for name in PHASE_ORDER:
        item = phases[name]
        if item.get("status") == "unknown":
            first_unknown = item
            first_unknown_name = name
            break
    if first_unknown:
        if first_unknown_name in {"inputLock", "hierarchyGate"}:
            return "unknown", first_unknown.get("nextAction", "Lock the input and hierarchy evidence before continuing.")
        previous_go = any(phases[name].get("status") == "go" for name in PHASE_ORDER)
        if previous_go:
            return "go", first_unknown.get("nextAction", "Collect the next missing phase evidence.")
        return "unknown", first_unknown.get("nextAction", "Collect the first phase evidence.")
    return "go", "All available Figma -> Unity artifact phases pass; screenshot/compile evidence is still separate if not present here."


def main() -> int:
    parser = argparse.ArgumentParser(description="Read Figma -> Unity Prefab phase evidence without side effects.")
    parser.add_argument("--manifest-dir", default=".tmp/figma-to-prefab")
    parser.add_argument("--unity-project", default="", help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--unity-tmp", default="", help="Explicit Unity temporary artifact directory")
    parser.add_argument("--request", default="")
    parser.add_argument("--mcp-result", default="")
    parser.add_argument("--node-manifest", default="")
    parser.add_argument("--image-manifest", default="")
    parser.add_argument("--spec-audit", default="")
    parser.add_argument("--prefab-spec", default="")
    parser.add_argument("--image-plan", default="")
    parser.add_argument("--componentset-report", default="")
    parser.add_argument("--image-process", default="")
    parser.add_argument("--verify-prefab", default="")
    parser.add_argument("--wall-clock", default="")
    parser.add_argument("--max-direct-children", type=int, default=15)
    parser.add_argument("--max-samples", type=int, default=5)
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    manifest_dir = resolve_path(args.manifest_dir)
    unity_tmp = requested_unity_tmp(args.unity_project, args.unity_tmp)

    request_path = resolve_path(args.request, manifest_dir) if args.request else first_existing([manifest_dir / "figma_to_prefab_request.json"])
    result_path = resolve_path(args.mcp_result, manifest_dir) if args.mcp_result else first_existing([manifest_dir / "figma_to_prefab_mcp_result.json"])
    node_manifest_path = resolve_path(args.node_manifest, manifest_dir) if args.node_manifest else first_existing([manifest_dir / "figma_node_manifest.json"])
    image_manifest_path = resolve_path(args.image_manifest, manifest_dir) if args.image_manifest else first_existing([manifest_dir / "image_export_manifest.json"])
    audit_path = resolve_path(args.spec_audit, unity_tmp) if args.spec_audit else first_existing([unity_tmp / "spec_audit_report.json"])
    spec_path = resolve_path(args.prefab_spec, unity_tmp) if args.prefab_spec else first_existing([unity_tmp / "prefab_spec.json"])
    image_plan_path = resolve_path(args.image_plan, unity_tmp) if args.image_plan else first_existing([unity_tmp / "image_download_plan.json"])
    componentset_path = resolve_path(args.componentset_report, unity_tmp) if args.componentset_report else first_existing([unity_tmp / "componentset_report.json"])
    image_report_path = resolve_path(args.image_process, unity_tmp) if args.image_process else first_existing([unity_tmp / "image_process_report.json"])
    verify_path = resolve_path(args.verify_prefab, unity_tmp) if args.verify_prefab else first_existing([unity_tmp / "verify_prefab_result.json"])
    wall_clock_path = resolve_path(args.wall_clock, unity_tmp) if args.wall_clock else first_existing([unity_tmp / "figma_to_prefab_wall_clock.json"])

    hierarchy_phase, node_manifest = build_hierarchy_phase(node_manifest_path, args.max_direct_children)
    phases = {
        "inputLock": build_input_phase(request_path, node_manifest),
        "hierarchyGate": hierarchy_phase,
        "figmaExport": build_figma_export_phase(result_path, image_manifest_path, args.max_samples),
        "specDraft": build_spec_phase(audit_path, image_plan_path, componentset_path, spec_path, args.max_samples),
        "imageWrite": build_image_phase(image_report_path, args.max_samples),
        "prefabVerify": build_verify_phase(verify_path, args.max_samples),
        "timing": build_timing_phase(wall_clock_path),
    }
    apply_consistency_checks(phases)
    decision, next_action = decide(phases)
    payload = {
        "schemaVersion": 1,
        "skill": "figma-to-prefab",
        "decision": decision,
        "nextAction": next_action,
        "phases": phases,
    }

    if args.output:
        output_path = resolve_path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("[PHASE_EVIDENCE_JSON]")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if decision != "stop" else 2


if __name__ == "__main__":
    raise SystemExit(main())
