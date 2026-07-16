#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read PSD -> Figma artifacts and report phase-level evidence.

This script is intentionally read-only. It does not contact Figma, submit jobs,
write Unity assets, or infer hierarchy plans. Its only job is to turn existing
manifest/result/timeline artifacts into a small go/stop/unknown decision.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


REQUIRED_ZERO_GATES = [
    "missingNodeCount",
    "emptyImageFillCount",
    "badTransformCount",
    "textClipRiskCount",
    "textColorMismatchCount",
    "textStrokeMismatchCount",
    "sliceProblemCount",
    "indexOrderBad",
    "positionMismatchCount",
    "sizeMismatchCount",
]


def find_relay_root() -> Path:
    script_path = Path(__file__).resolve()
    for parent in script_path.parents:
        if (parent / "client" / "figma_mcp_client.py").is_file():
            return parent
    raise RuntimeError(
        f"Unable to locate the Figma MCP Relay root containing client/figma_mcp_client.py from {script_path}."
    )


RELAY_ROOT = find_relay_root()


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


def layer_count_from_manifest(manifest: dict[str, Any]) -> int:
    summary = manifest.get("summary")
    if isinstance(summary, dict):
        value = summary.get("total")
        if isinstance(value, int):
            return value
    layers = manifest.get("layers")
    if isinstance(layers, list):
        return len(layers)
    total = 0
    for key in ("imageLayers", "textLayers", "commonLayers", "nineSliceLayers"):
        value = manifest.get(key)
        if isinstance(value, list):
            total += len(value)
    return total


def semantic_prefix_summary(manifest: dict[str, Any]) -> dict[str, Any]:
    hints = manifest.get("semanticHints")
    if not isinstance(hints, dict):
        hints = {}
    prefix = hints.get("psdPrefix")
    if not isinstance(prefix, dict):
        prefix = {}
    segments = prefix.get("segments")
    if not isinstance(segments, list):
        segments = []
    warnings = prefix.get("warnings")
    if not isinstance(warnings, list):
        warnings = []
    return {
        "hintOnly": bool(prefix.get("hintOnly", True)),
        "segmentCount": len(segments),
        "coverage": prefix.get("coverage", {}),
        "warningCount": len(warnings),
        "segments": [
            {
                "candidateName": item.get("candidateName"),
                "startPrefix": item.get("startPrefix"),
                "endPrefix": item.get("endPrefix"),
                "count": item.get("count"),
            }
            for item in segments[:8]
            if isinstance(item, dict)
        ],
    }


def unwrap_result(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    return result if isinstance(result, dict) else payload


def screenshot_ok(result: dict[str, Any]) -> tuple[bool, str]:
    screenshot = result.get("screenshot")
    if isinstance(screenshot, dict):
        if screenshot.get("fileValid") is False:
            return False, "screenshot.fileValid=false"
        path = str(screenshot.get("path") or "")
        if path:
            return True, path
    path = str(result.get("screenshotPath") or "")
    if path:
        return True, path
    return False, "missing screenshot"


def compact_samples(items: Any, max_samples: int) -> list[Any]:
    if not isinstance(items, list):
        return []
    return items[: max(0, max_samples)]


def phase(status: str, evidence: dict[str, Any], next_action: str = "") -> dict[str, Any]:
    payload = {"status": status, "evidence": evidence}
    if next_action:
        payload["nextAction"] = next_action
    return payload


def build_manifest_phase(path: Path | None) -> tuple[dict[str, Any], dict[str, Any]]:
    if not path:
        return phase(
            "unknown",
            {"manifestSummaryPath": ""},
            "Run export_psd_layers.py --summary to create manifest_summary.json.",
        ), {}
    manifest = read_json(path)
    if "__readError" in manifest:
        return phase(
            "stop",
            {"manifestSummaryPath": path.as_posix(), "error": manifest["__readError"]},
            "Regenerate the PSD export summary before importing.",
        ), {}
    layer_count = layer_count_from_manifest(manifest)
    summary = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
    warnings = manifest.get("warnings") if isinstance(manifest.get("warnings"), list) else []
    prefix = semantic_prefix_summary(manifest)
    evidence = {
        "manifestSummaryPath": path.as_posix(),
        "canvas": manifest.get("canvas", {}),
        "layerCount": layer_count,
        "summary": summary,
        "warningCount": len(warnings),
        "semanticHints": {"psdPrefix": prefix},
    }
    if layer_count <= 0:
        return phase("stop", evidence, "Fix PSD export: layerCount is zero."), manifest
    return phase("go", evidence), manifest


def build_result_phase(path: Path | None, max_samples: int) -> dict[str, Any]:
    if not path:
        return phase(
            "unknown",
            {"resultPath": ""},
            "Run submit_psd_import_job.py --wait or provide --result.",
        )
    payload = read_json(path)
    if "__readError" in payload:
        return phase(
            "stop",
            {"resultPath": path.as_posix(), "error": payload["__readError"]},
            "Regenerate or repair the Figma import result JSON.",
        )
    result = unwrap_result(payload)
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    validation = summary.get("validation") if isinstance(summary.get("validation"), dict) else {}
    warnings = result.get("warnings") if isinstance(result.get("warnings"), list) else []
    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    screenshot_pass, screenshot_evidence = screenshot_ok(result)
    gate_values = {key: validation.get(key) for key in REQUIRED_ZERO_GATES if key in validation}
    missing_gates = [key for key in REQUIRED_ZERO_GATES if key not in validation]
    failing_gates = {
        key: value
        for key, value in gate_values.items()
        if isinstance(value, (int, float)) and value != 0
    }
    evidence = {
        "resultPath": path.as_posix(),
        "status": result.get("status", "unknown"),
        "rootNodeId": result.get("rootNodeId", ""),
        "rootName": result.get("rootName", ""),
        "createdCount": result.get("createdCount", 0),
        "layerCount": summary.get("layerCount"),
        "stats": summary.get("stats", {}),
        "warningCount": len(warnings),
        "errorCount": len(errors),
        "warningSamples": compact_samples(warnings, max_samples),
        "errorSamples": compact_samples(errors, max_samples),
        "gates": gate_values,
        "missingGateNames": missing_gates,
        "screenshot": screenshot_evidence,
    }
    if result.get("status") != "completed":
        return phase("stop", evidence, "Fix the Figma import failure before cleanup or Unity import.")
    if errors or failing_gates or not screenshot_pass:
        return phase("stop", evidence, "Diagnose only the failing PSD import gates.")
    if warnings or missing_gates:
        return phase("unknown", evidence, "Review warnings or missing gates before claiming import success.")
    return phase("go", evidence)


def build_timeline_phase(path: Path | None) -> dict[str, Any]:
    if not path:
        return phase("unknown", {"timelinePath": ""}, "Timeline evidence is optional; provide --timeline if timing matters.")
    payload = read_json(path)
    if "__readError" in payload:
        return phase("unknown", {"timelinePath": path.as_posix(), "error": payload["__readError"]})
    events = payload.get("events") if isinstance(payload.get("events"), list) else []
    elapsed = 0.0
    compact = []
    for event in events:
        if not isinstance(event, dict):
            continue
        duration = event.get("durationMs")
        if isinstance(duration, (int, float)):
            elapsed += float(duration)
        compact.append({
            "name": event.get("name", ""),
            "status": event.get("status", ""),
            "durationMs": duration,
        })
    return phase("go", {
        "timelinePath": path.as_posix(),
        "eventCount": len(compact),
        "machineTimeMs": round(elapsed, 3),
        "events": compact[:20],
    })


def decide(phases: dict[str, dict[str, Any]], manifest: dict[str, Any]) -> tuple[str, str]:
    blocking_phase_names = ["psdExport", "figmaWrite"]
    statuses = [phases[name].get("status") for name in blocking_phase_names if name in phases]
    if "stop" in statuses:
        return "stop", "A blocking phase failed; do not continue to cleanup or Unity import."
    if "unknown" in statuses:
        return "unknown", "Evidence is incomplete; run the nextAction for unknown phases."
    prefix = semantic_prefix_summary(manifest)
    if prefix.get("segmentCount", 0) > 0:
        return "go", "PSD import evidence passes; if UGUI structure is needed, run cleanup dry-run with prefix hints as hint-only input."
    return "go", "PSD import evidence passes; no numeric-prefix segmentation was proven for this PSD."


def main() -> int:
    parser = argparse.ArgumentParser(description="Read PSD -> Figma phase evidence without side effects.")
    parser.add_argument("--artifact-dir", default="", help="Directory containing manifest_summary.json / figma_mcp_result.json / timeline.json")
    parser.add_argument("--manifest-summary", default="", help="Path to manifest_summary.json")
    parser.add_argument("--result", default="", help="Path to figma_mcp_result.json")
    parser.add_argument("--timeline", default="", help="Path to timeline.json")
    parser.add_argument("--output", default="", help="Optional JSON output path")
    parser.add_argument("--max-samples", type=int, default=5)
    args = parser.parse_args()

    base = resolve_path(args.artifact_dir) if args.artifact_dir else None
    manifest_path = resolve_path(args.manifest_summary, base) if args.manifest_summary else first_existing([
        *( [base / "manifest_summary.json"] if base else [] ),
    ])
    result_path = resolve_path(args.result, base) if args.result else first_existing([
        *( [base / "figma_mcp_result.json", base / "figma_result.json"] if base else [] ),
    ])
    timeline_path = resolve_path(args.timeline, base) if args.timeline else first_existing([
        *( [base / "timeline.json"] if base else [] ),
    ])

    manifest_phase, manifest = build_manifest_phase(manifest_path)
    phases = {
        "psdExport": manifest_phase,
        "figmaWrite": build_result_phase(result_path, args.max_samples),
        "timeline": build_timeline_phase(timeline_path),
    }
    decision, next_action = decide(phases, manifest)
    payload = {
        "schemaVersion": 1,
        "skill": "psd-layer-to-figma",
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
