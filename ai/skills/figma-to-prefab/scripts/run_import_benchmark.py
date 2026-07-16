#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Run repeatable Figma -> Unity import benchmarks.

The harness wraps run_full_import.py and records one isolated result folder per
iteration. It is intentionally data-driven: timing comes from run_full_import
SUMMARY_JSON, while accuracy comes from the existing audit/image/verify reports.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent


def find_relay_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "client" / "figma_mcp_client.py").is_file():
            return parent
    raise RuntimeError("Unable to locate the Figma MCP Relay root containing client/figma_mcp_client.py.")


RELAY_ROOT = find_relay_root()
UNITY_PROJECT: Path | None = None
UNITY_TMP: Path | None = None

RUN_FULL_IMPORT = SCRIPT_DIR / "run_full_import.py"
VERIFY_PREFAB = SCRIPT_DIR / "verify_prefab.py"

DEFAULT_OUTPUT_ROOT = "Assets/FigmaImportBenchmark"
DEFAULT_PREFAB_TEMPLATE = (
    "Assets/FigmaImportBenchmark/{run_id}/{mode}/Prefabs/"
    "Import_{iteration:03}.prefab"
)
DEFAULT_IMAGE_DIR_TEMPLATE = (
    "Assets/FigmaImportBenchmark/{run_id}/{mode}/Images/iter_{iteration:03}"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run 50x Unity import benchmark and record timing/accuracy."
    )
    parser.add_argument("--figma-url", required=True, help="Figma node URL with node-id.")
    parser.add_argument("--unity-project", default="", help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--iterations", type=int, default=50, help="Iterations per mode.")
    parser.add_argument(
        "--modes",
        default="reuse-manifest",
        help="Comma-separated modes: full,reuse-manifest,check-only.",
    )
    parser.add_argument("--run-id", default="", help="Stable run id. Default: timestamp.")
    parser.add_argument(
        "--output-root",
        default=DEFAULT_OUTPUT_ROOT,
        help="Unity Assets path used for benchmark folders.",
    )
    parser.add_argument(
        "--target-prefab-template",
        default=DEFAULT_PREFAB_TEMPLATE,
        help="Prefab path template. Supports {run_id}, {mode}, {iteration}.",
    )
    parser.add_argument(
        "--target-image-dir-template",
        default=DEFAULT_IMAGE_DIR_TEMPLATE,
        help="Image dir template. Supports {run_id}, {mode}, {iteration}.",
    )
    parser.add_argument("--workers", type=int, default=6, help="process_images workers.")
    parser.add_argument("--mcp-timeout", type=int, default=300, help="MCP export timeout.")
    parser.add_argument("--relay-url", default="http://localhost:32130")
    parser.add_argument("--file-key", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--overwrite", default="overwrite", choices=["create-new-only", "overwrite"])
    parser.add_argument("--include-hidden", action="store_true")
    parser.add_argument("--no-screenshot", action="store_true")
    parser.add_argument(
        "--stop-on-failure",
        action="store_true",
        help="Stop at the first failed iteration.",
    )
    parser.add_argument(
        "--keep-going-after-export-failure",
        action="store_true",
        help="Continue reuse-manifest mode after the shared export iteration fails.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Create the benchmark plan without running imports.",
    )
    return parser.parse_args()


def normalize_unity_asset_path(path: str) -> str:
    normalized = str(path or "").replace("\\", "/").strip("/")
    if not normalized.startswith("Assets/"):
        raise ValueError(f"Expected Unity Assets path, got: {path}")
    return normalized


def unity_disk_path(asset_path: str) -> Path:
    if UNITY_PROJECT is None:
        raise RuntimeError("Unity project context has not been initialized.")
    return UNITY_PROJECT / normalize_unity_asset_path(asset_path)


def ensure_parent_dirs(prefab_path: str, image_dir: str) -> None:
    unity_disk_path(prefab_path).parent.mkdir(parents=True, exist_ok=True)
    unity_disk_path(image_dir).mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def run_python(argv: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable] + argv,
        cwd=str(RELAY_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def extract_summary_json(stdout: str) -> dict:
    marker = "[SUMMARY_JSON]"
    index = stdout.rfind(marker)
    if index < 0:
        return {}
    tail = stdout[index + len(marker) :].strip().splitlines()
    if not tail:
        return {}
    try:
        return json.loads(tail[0])
    except json.JSONDecodeError:
        return {}


def read_json_if_exists(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}


def copy_if_exists(src: Path, dst_dir: Path) -> str:
    if not src.exists():
        return ""
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    if src.is_dir():
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)
    return dst.as_posix()


def run_verify(prefab_path: str, spec_path: Path) -> dict:
    argv = [str(VERIFY_PREFAB), "--prefab", prefab_path, "--json"]
    if spec_path.is_file():
        argv += ["--spec", str(spec_path)]
    result = run_python(argv, timeout=45)
    if result.returncode != 0 and not result.stdout:
        return {
            "allPass": False,
            "blockingErrors": [{
                "code": "verifyCommandFailed",
                "message": result.stderr[:1000],
            }],
        }
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "allPass": False,
            "blockingErrors": [{
                "code": "verifyJsonParseFailed",
                "message": result.stdout[:1000],
            }],
        }


def check_pass(report: dict, path: list[str], expected=True) -> bool:
    value = report
    for key in path:
        if not isinstance(value, dict) or key not in value:
            return False
        value = value[key]
    return value == expected


def compute_accuracy(summary: dict, audit: dict, image: dict, verify: dict) -> dict:
    checks = {
        "workflowCompleted": summary.get("status") in ("completed", "check-only-completed"),
        "specAuditAllPass": audit.get("allPass") is True,
        "imageProcessAllPass": image.get("allPass") is True,
        "verifyAllPass": verify.get("allPass") is True,
        "spriteNullZero": check_pass(verify, ["checks", "spriteNull", "pass"]),
        "raycastTargetZero": check_pass(verify, ["checks", "raycastTargetOn", "pass"]),
        "defaultFontZero": check_pass(verify, ["checks", "defaultFont", "pass"]),
        "matNullZero": check_pass(verify, ["checks", "matNull", "pass"]),
        "commonFontExact": check_pass(verify, ["checks", "commonFontExact", "pass"]),
        "allowedMaterial": check_pass(verify, ["checks", "allowedMaterial", "pass"]),
        "textRectSize": check_pass(verify, ["checks", "textRectSize", "pass"]),
    }
    passed = sum(1 for value in checks.values() if value)
    total = len(checks)
    blocking_count = (
        len(audit.get("blockingErrors", []) or [])
        + len(image.get("blockingErrors", []) or [])
        + len(verify.get("blockingErrors", []) or [])
    )
    warning_count = (
        len(audit.get("warnings", []) or [])
        + len(image.get("warnings", []) or [])
        + len(verify.get("warnings", []) or [])
    )
    return {
        "score": round(passed / total, 4),
        "passedGateCount": passed,
        "totalGateCount": total,
        "blockingErrorCount": blocking_count,
        "warningCount": warning_count,
        "checks": checks,
    }


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = (len(ordered) - 1) * pct
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[int(rank)]
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def summarize_mode(mode: str, records: list[dict]) -> dict:
    durations = [r["durationSeconds"] for r in records if r.get("durationSeconds") is not None]
    successes = [r for r in records if r.get("success")]
    scores = [r.get("accuracy", {}).get("score", 0.0) for r in records]
    return {
        "mode": mode,
        "iterations": len(records),
        "successCount": len(successes),
        "failureCount": len(records) - len(successes),
        "successRate": round(len(successes) / len(records), 4) if records else 0.0,
        "accuracyAverage": round(statistics.fmean(scores), 4) if scores else 0.0,
        "durationSeconds": {
            "min": round(min(durations), 3) if durations else 0.0,
            "max": round(max(durations), 3) if durations else 0.0,
            "mean": round(statistics.fmean(durations), 3) if durations else 0.0,
            "median": round(statistics.median(durations), 3) if durations else 0.0,
            "p95": round(percentile(durations, 0.95), 3) if durations else 0.0,
            "stdev": round(statistics.pstdev(durations), 3) if len(durations) > 1 else 0.0,
        },
        "blockingErrorCount": sum(r.get("accuracy", {}).get("blockingErrorCount", 0) for r in records),
        "warningCount": sum(r.get("accuracy", {}).get("warningCount", 0) for r in records),
    }


def pick_recommendations(summaries: list[dict]) -> dict:
    if not summaries:
        return {}
    fastest = min(summaries, key=lambda s: (s["durationSeconds"]["median"], s["durationSeconds"]["p95"]))
    stablest = max(
        summaries,
        key=lambda s: (
            s["successRate"],
            s["accuracyAverage"],
            -s["durationSeconds"]["stdev"],
            -s["durationSeconds"]["p95"],
        ),
    )
    best_overall = max(
        summaries,
        key=lambda s: (
            s["successRate"],
            s["accuracyAverage"],
            -s["durationSeconds"]["median"],
            -s["durationSeconds"]["p95"],
        ),
    )
    return {
        "fastestMode": fastest["mode"],
        "stablestMode": stablest["mode"],
        "bestOverallMode": best_overall["mode"],
    }


def render_markdown(summary: dict) -> str:
    lines = [
        "# Figma To Unity Import Benchmark",
        "",
        f"- Run ID: `{summary['runId']}`",
        f"- Started: `{summary['startedAt']}`",
        f"- Finished: `{summary['finishedAt']}`",
        f"- Iterations per mode: `{summary['iterationsPerMode']}`",
        f"- Output root: `{summary['outputRoot']}`",
        "",
        "## Mode Summary",
        "",
        "| Mode | Success | Accuracy | Median(s) | P95(s) | Stdev(s) | Blocking |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for item in summary["modeSummaries"]:
        duration = item["durationSeconds"]
        lines.append(
            "| {mode} | {successCount}/{iterations} ({successRate:.2%}) | "
            "{accuracyAverage:.2%} | {median:.3f} | {p95:.3f} | {stdev:.3f} | {blockingErrorCount} |".format(
                mode=item["mode"],
                successCount=item["successCount"],
                iterations=item["iterations"],
                successRate=item["successRate"],
                accuracyAverage=item["accuracyAverage"],
                median=duration["median"],
                p95=duration["p95"],
                stdev=duration["stdev"],
                blockingErrorCount=item["blockingErrorCount"],
            )
        )
    rec = summary.get("recommendations", {})
    if rec:
        lines += [
            "",
            "## Recommendation",
            "",
            f"- Fastest mode: `{rec.get('fastestMode', '')}`",
            f"- Stablest mode: `{rec.get('stablestMode', '')}`",
            f"- Best overall mode: `{rec.get('bestOverallMode', '')}`",
        ]
    lines += [
        "",
        "## Accuracy Gates",
        "",
        "A run is considered successful only when workflow, spec audit, image processing, "
        "and prefab static verification all pass. The accuracy score is the fraction of "
        "the recorded gates that passed for that iteration.",
        "",
    ]
    return "\n".join(lines)


def build_iteration_paths(args: argparse.Namespace, run_id: str, mode: str, iteration: int) -> tuple[str, str]:
    values = {"run_id": run_id, "mode": mode, "iteration": iteration}
    prefab = args.target_prefab_template.format(**values)
    images = args.target_image_dir_template.format(**values)
    return normalize_unity_asset_path(prefab), normalize_unity_asset_path(images)


def run_iteration(
    args: argparse.Namespace,
    run_id: str,
    mode: str,
    iteration: int,
    benchmark_root: Path,
    shared_manifest_dir: Path,
) -> dict:
    prefab_path, image_dir = build_iteration_paths(args, run_id, mode, iteration)
    ensure_parent_dirs(prefab_path, image_dir)

    iter_dir = benchmark_root / mode / "Runs" / f"iter_{iteration:03}"
    iter_dir.mkdir(parents=True, exist_ok=True)
    manifest_dir = (
        shared_manifest_dir
        if mode == "reuse-manifest"
        else benchmark_root / mode / "Manifests" / f"iter_{iteration:03}"
    )

    cmd = [
        str(RUN_FULL_IMPORT),
        "--figma-url", args.figma_url,
        "--target-prefab", prefab_path,
        "--target-image-dir", image_dir,
        "--overwrite", args.overwrite,
        "--manifest-dir", str(manifest_dir),
        "--relay-url", args.relay_url,
        "--mcp-timeout", str(args.mcp_timeout),
        "--workers", str(args.workers),
        "-y",
    ]
    if args.file_key:
        cmd += ["--file-key", args.file_key]
    if args.session_id:
        cmd += ["--session-id", args.session_id]
    if args.include_hidden:
        cmd.append("--include-hidden")
    if args.no_screenshot:
        cmd.append("--no-screenshot")
    if mode == "check-only":
        cmd.append("--check-only")
    if mode == "reuse-manifest" and iteration > 1:
        cmd.append("--skip-mcp-export")

    started_at = now_iso()
    started = time.perf_counter()
    if args.dry_run:
        result = subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    else:
        result = run_python(cmd, timeout=args.mcp_timeout + 300)
    duration = time.perf_counter() - started
    finished_at = now_iso()

    (iter_dir / "stdout.log").write_text(result.stdout or "", encoding="utf-8")
    (iter_dir / "stderr.log").write_text(result.stderr or "", encoding="utf-8")
    (iter_dir / "command.json").write_text(
        json.dumps({"argv": [sys.executable] + cmd}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    workflow_summary = extract_summary_json(result.stdout or {})
    audit = read_json_if_exists(UNITY_TMP / "spec_audit_report.json")
    image = read_json_if_exists(UNITY_TMP / "image_process_report.json")
    spec_path = UNITY_TMP / "prefab_spec.json"
    verify = {} if mode == "check-only" or args.dry_run else run_verify(prefab_path, spec_path)
    accuracy = compute_accuracy(workflow_summary, audit, image, verify)

    artifacts = {
        "prefabPath": prefab_path,
        "imageDir": image_dir,
        "iterationDir": iter_dir.as_posix(),
        "manifestDir": manifest_dir.as_posix(),
        "copied": [],
    }
    artifact_sources = [
        UNITY_TMP / "prefab_spec.json",
        UNITY_TMP / "image_download_plan.json",
        UNITY_TMP / "spec_audit_report.json",
        UNITY_TMP / "image_process_report.json",
        UNITY_TMP / "verify_prefab_result.json",
        UNITY_TMP / "roslyn_import_plan.txt",
        UNITY_TMP / "componentset_report.json",
        manifest_dir / "figma_to_prefab_mcp_result.json",
        manifest_dir / "figma_node_manifest.json",
        manifest_dir / "image_export_manifest.json",
        manifest_dir / "manifest_summary.json",
        manifest_dir / "manifest_summary.md",
    ]
    for source in artifact_sources:
        copied = copy_if_exists(source, iter_dir / "artifacts")
        if copied:
            artifacts["copied"].append(copied)
    screenshot_dir = copy_if_exists(manifest_dir / "mcp_screenshots", iter_dir / "artifacts")
    if screenshot_dir:
        artifacts["copied"].append(screenshot_dir)

    record = {
        "runId": run_id,
        "mode": mode,
        "iteration": iteration,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "durationSeconds": round(duration, 3),
        "exitCode": result.returncode,
        "success": (
            result.returncode == 0
            and accuracy["checks"]["workflowCompleted"]
            and (mode == "check-only" or accuracy["checks"]["verifyAllPass"])
        ),
        "workflowSummary": workflow_summary,
        "accuracy": accuracy,
        "verifySummary": {
            "allPass": verify.get("allPass"),
            "checks": verify.get("checks", {}),
            "blockingErrors": verify.get("blockingErrors", []),
            "warnings": verify.get("warnings", []),
        },
        "artifacts": artifacts,
    }
    (iter_dir / "iteration_result.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return record


def main() -> int:
    global UNITY_PROJECT, UNITY_TMP
    args = parse_args()
    raw_unity_project = args.unity_project.strip() or os.environ.get("FIGMA_UNITY_PROJECT", "").strip()
    if not raw_unity_project:
        raise SystemExit("Unity project is required. Pass --unity-project <path> or set FIGMA_UNITY_PROJECT.")
    UNITY_PROJECT = Path(raw_unity_project).expanduser().resolve()
    missing = [name for name in ("Assets", "ProjectSettings") if not (UNITY_PROJECT / name).is_dir()]
    if missing:
        raise SystemExit(f"Invalid Unity project {UNITY_PROJECT}: missing {', '.join(missing)}")
    UNITY_TMP = UNITY_PROJECT / ".tmp"
    if args.iterations <= 0:
        raise SystemExit("--iterations must be > 0")
    if not RUN_FULL_IMPORT.is_file():
        raise SystemExit(f"run_full_import.py not found: {RUN_FULL_IMPORT}")

    run_id = args.run_id or datetime.now().strftime("%Y%m%d_%H%M%S")
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    allowed_modes = {"full", "reuse-manifest", "check-only"}
    unknown = [m for m in modes if m not in allowed_modes]
    if unknown:
        raise SystemExit(f"Unknown mode(s): {', '.join(unknown)}")

    output_root_asset = normalize_unity_asset_path(args.output_root)
    benchmark_root = unity_disk_path(output_root_asset) / run_id
    benchmark_root.mkdir(parents=True, exist_ok=True)
    shared_manifest_dir = benchmark_root / "reuse-manifest" / "SharedManifest"

    started_at = now_iso()
    plan = {
        "runId": run_id,
        "figmaUrl": args.figma_url,
        "iterationsPerMode": args.iterations,
        "modes": modes,
        "outputRoot": (output_root_asset + "/" + run_id).replace("\\", "/"),
        "targetPrefabTemplate": args.target_prefab_template,
        "targetImageDirTemplate": args.target_image_dir_template,
        "createdAt": started_at,
        "dryRun": args.dry_run,
    }
    (benchmark_root / "benchmark_plan.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if args.dry_run:
        summary = {
            "runId": run_id,
            "startedAt": started_at,
            "finishedAt": now_iso(),
            "iterationsPerMode": args.iterations,
            "outputRoot": (output_root_asset + "/" + run_id).replace("\\", "/"),
            "recordCount": 0,
            "modeSummaries": [],
            "recommendations": {},
            "recordsPath": (benchmark_root / "benchmark_records.jsonl").as_posix(),
            "dryRun": True,
        }
        (benchmark_root / "benchmark_records.jsonl").write_text("", encoding="utf-8")
        (benchmark_root / "benchmark_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (benchmark_root / "benchmark_summary.md").write_text(
            render_markdown(summary),
            encoding="utf-8",
        )
        print("[BENCHMARK_SUMMARY_JSON]")
        print(json.dumps(summary, ensure_ascii=True, separators=(",", ":")))
        return 0

    all_records: list[dict] = []
    print(json.dumps({"event": "benchmark-start", **plan}, ensure_ascii=False))

    for mode in modes:
        for iteration in range(1, args.iterations + 1):
            print(json.dumps({
                "event": "iteration-start",
                "mode": mode,
                "iteration": iteration,
                "total": args.iterations,
            }, ensure_ascii=False))
            record = run_iteration(args, run_id, mode, iteration, benchmark_root, shared_manifest_dir)
            all_records.append(record)
            print(json.dumps({
                "event": "iteration-finished",
                "mode": mode,
                "iteration": iteration,
                "success": record["success"],
                "durationSeconds": record["durationSeconds"],
                "accuracyScore": record["accuracy"]["score"],
                "exitCode": record["exitCode"],
            }, ensure_ascii=False))
            if (
                mode == "reuse-manifest"
                and iteration == 1
                and not record["success"]
                and not args.keep_going_after_export_failure
            ):
                print(json.dumps({
                    "event": "stopped",
                    "reason": "reuse-manifest first export failed",
                }, ensure_ascii=False))
                break
            if args.stop_on_failure and not record["success"]:
                print(json.dumps({
                    "event": "stopped",
                    "reason": "stop-on-failure",
                }, ensure_ascii=False))
                break

    mode_summaries = [
        summarize_mode(mode, [r for r in all_records if r["mode"] == mode])
        for mode in modes
    ]
    finished_at = now_iso()
    summary = {
        "runId": run_id,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "iterationsPerMode": args.iterations,
        "outputRoot": (output_root_asset + "/" + run_id).replace("\\", "/"),
        "recordCount": len(all_records),
        "modeSummaries": mode_summaries,
        "recommendations": pick_recommendations(mode_summaries),
        "recordsPath": (benchmark_root / "benchmark_records.jsonl").as_posix(),
    }

    with (benchmark_root / "benchmark_records.jsonl").open("w", encoding="utf-8") as fh:
        for record in all_records:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    (benchmark_root / "benchmark_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (benchmark_root / "benchmark_summary.md").write_text(
        render_markdown(summary),
        encoding="utf-8",
    )

    print("[BENCHMARK_SUMMARY_JSON]")
    print(json.dumps(summary, ensure_ascii=True, separators=(",", ":")))
    return 0 if all(item["failureCount"] == 0 for item in mode_summaries) else 2


if __name__ == "__main__":
    raise SystemExit(main())
