#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Figma → Unity Prefab 一键导入入口

用法:
    python run_full_import.py \\
        --unity-project "E:/Project/Game" \\
        --figma-url "https://www.figma.com/design/FILE/NAME?node-id=1-2" \\
        --target-prefab "Assets/_Resources/Prefabs/UGUI/模块名/UI_Foo.prefab" \\
        --target-image-dir "Assets/_Resources/Foo_Images/" \\
        -y

步骤:
    1. gen_spec.py   → 生成 Spec + 审核报告
    2. 确认报告（-y 跳过）
    3. process_images.py → 写入 PNG
    4. Roslyn: AssetDatabase.Refresh → 设置 Sprite → FigmaPrefabGenerator.Generate()
    5. verify_prefab.py → 静态验证
    6. Console 日志检查
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from name_utils import infer_prefab_name_from_figma_root, is_placeholder_prefab_name
from process_images import validate_export_health_contract
from unity_project_paths import normalize_asset_path, resolve_unity_project

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PLUGIN_ROOT = SCRIPT_DIR.parents[3]


def configure_project_paths(unity_project: str | Path) -> None:
    global UNITY_PROJECT, TMP_DIR, VERIFY_PREFAB_REPORT
    resolved = resolve_unity_project(unity_project)
    UNITY_PROJECT = resolved
    TMP_DIR = UNITY_PROJECT / ".tmp"
    VERIFY_PREFAB_REPORT = TMP_DIR / "verify_prefab_result.json"
    os.environ["FIGMA_UNITY_PROJECT"] = str(UNITY_PROJECT)


REPO_ROOT = PLUGIN_ROOT
UNITY_PROJECT = PLUGIN_ROOT
TMP_DIR = UNITY_PROJECT / ".tmp"
MCP_MANIFEST_DIR = PLUGIN_ROOT / ".tmp" / "figma-to-prefab"

ULOOP_IMPORT_TEMPLATE = SKILL_DIR / "uloop-templates" / "import_sprites_and_generate_prefabs.cs"

GEN_SPEC = SCRIPT_DIR / "gen_spec.py"
PROCESS_IMAGES = SCRIPT_DIR / "process_images.py"
VERIFY_PREFAB = SCRIPT_DIR / "verify_prefab.py"
MCP_EXPORT = SCRIPT_DIR / "figma_to_prefab_mcp_client.py"
MANIFEST_READER = SCRIPT_DIR / "figma_manifest_reader.py"
VERIFY_PREFAB_REPORT = TMP_DIR / "verify_prefab_result.json"

WALL_CLOCK_CONTEXT: dict = {}


def parse_figma_url(url: str) -> tuple[str, str]:
    import re

    file_key = ""
    node_id = ""
    file_match = re.search(r"figma\.com/(?:design|file)/([^/?#]+)", url or "")
    if file_match:
        file_key = file_match.group(1)
    node_match = re.search(r"[?&]node-id=([^&]+)", url or "")
    if node_match:
        node_id = node_match.group(1).replace("-", ":")
    return file_key, node_id


def write_export_request(path: Path, figma_url: str, file_key: str, node_id: str, args: argparse.Namespace) -> None:
    payload = {
        "task": "figma-to-prefab-export",
        "figma": {
            "url": figma_url,
            "fileKey": file_key,
            "nodeId": node_id,
        },
        "unity": {
            "targetPrefabPath": args.target_prefab,
            "targetImageDirectory": args.target_image_dir,
            "overwritePolicy": args.overwrite,
        },
        "export": {
            "includeHidden": args.include_hidden,
            "includeScreenshot": not args.no_screenshot,
            "includeImages": True,
            "flattenUnsupportedVectors": True,
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def run(args: list[str], *, timeout: int = 120, cwd: Path | None = None) -> subprocess.CompletedProcess:
    """执行命令，超时则 throw。"""
    return subprocess.run(
        [sys.executable] + args,
        cwd=str(cwd or REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def run_timed(label: str, argv: list[str], *, timeout: int, cwd: Path | None = None) -> tuple[subprocess.CompletedProcess, dict]:
    started = time.perf_counter()
    result = run(argv, timeout=timeout, cwd=cwd)
    elapsed = time.perf_counter() - started
    return result, {
        "label": label,
        "elapsedSeconds": round(elapsed, 3),
        "exitCode": result.returncode,
    }


def run_uloop_import(image_dir: str, spec_paths: list[str], *, timeout: int = 120) -> dict:
    """使用 uLoop 执行无文件 I/O 的 Prefab 导入代码。"""
    if not ULOOP_IMPORT_TEMPLATE.exists():
        return {"success": False, "stderr": f"uLoop template missing: {ULOOP_IMPORT_TEMPLATE}"}
    code = ULOOP_IMPORT_TEMPLATE.read_text(encoding="utf-8")
    code = code.replace("{{IMAGE_DIR_JSON}}", json.dumps(image_dir, ensure_ascii=False))
    code = code.replace("{{SPEC_PATHS_CSHARP}}", ", ".join(json.dumps(path, ensure_ascii=False) for path in spec_paths))
    generated = TMP_DIR / "figma-to-prefab" / "uloop_import_sprites_and_generate_prefabs.cs"
    generated.parent.mkdir(parents=True, exist_ok=True)
    generated.write_text(code, encoding="utf-8")
    uloop_command = resolve_uloop_command()
    result = subprocess.run(
        [uloop_command, "execute-dynamic-code", "--project-path", str(UNITY_PROJECT), "--code-file", str(generated)],
        cwd=str(REPO_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )
    return {"success": result.returncode == 0, "stdout": result.stdout, "stderr": result.stderr}


def resolve_uloop_command() -> str:
    """Resolve uLoop independently from the gateway process PATH."""
    configured = os.environ.get("ULOOP_COMMAND", "").strip()
    if configured:
        return configured
    app_data = os.environ.get("APPDATA", "")
    candidate = Path(app_data) / "npm" / "uloop.cmd" if app_data else Path()
    if candidate.is_file():
        return str(candidate)
    return "uloop"


def read_json(path: Path) -> dict:
    path = Path(path)
    if path.is_absolute():
        return json.loads(path.read_text(encoding="utf-8-sig"))
    return json.loads((REPO_ROOT / path).read_text(encoding="utf-8-sig"))


def validate_image_manifest_health(image_manifest: dict) -> list[dict]:
    return validate_export_health_contract(image_manifest.get("exports", []))


def resolve_repo_path(path: str | Path) -> Path:
    resolved = Path(path)
    if resolved.is_absolute():
        return resolved
    normalized = str(path).replace("\\", "/")
    if normalized.startswith("Assets/"):
        return UNITY_PROJECT / normalized
    return REPO_ROOT / resolved


def to_posix(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def normalize_unity_asset_path(path: str) -> str:
    return normalize_asset_path(path).strip("/")


def normalize_unity_asset_dir(path: str) -> str:
    normalized = normalize_unity_asset_path(path)
    return normalized.rstrip("/") + "/" if normalized else ""


def derive_formal_paths(base_asset_dir: str, root_name: str) -> tuple[str, str, str]:
    base_dir = normalize_unity_asset_dir(base_asset_dir)
    if not base_dir.startswith("Assets/"):
        fail(f"--formal-output-dir must be a Unity Assets path: {base_asset_dir}")
    prefab_name = infer_prefab_name_from_figma_root(root_name)
    return prefab_name, f"{base_dir}{prefab_name}.prefab", f"{base_dir}Images/"


def validate_formal_import_paths(target_prefab: str, target_image_dir: str, prefab_name: str) -> None:
    prefab_path = normalize_unity_asset_path(target_prefab)
    image_dir = normalize_unity_asset_dir(target_image_dir)
    if not prefab_path.startswith("Assets/") or not prefab_path.endswith(".prefab"):
        fail(f"target Prefab must be an Assets/*.prefab path: {target_prefab}")
    if not image_dir.startswith("Assets/"):
        fail(f"target image dir must be an Assets path: {target_image_dir}")
    if is_placeholder_prefab_name(Path(prefab_path).stem) or is_placeholder_prefab_name(prefab_name):
        fail(f"formal import cannot use placeholder Prefab name: {Path(prefab_path).stem}")
    parts = prefab_path.split("/")
    if "FigmaImportBenchmark" in parts and "Prefabs" in parts:
        fail(f"formal import must not create a benchmark run-id/Prefabs folder: {prefab_path}")


def is_under_unity_assets(path: Path) -> bool:
    try:
        path.resolve().relative_to((UNITY_PROJECT / "Assets").resolve())
        return True
    except ValueError:
        return False


def guard_report_path(path: Path, label: str) -> None:
    if is_under_unity_assets(path):
        fail(f"{label} must not be written under Unity Assets: {path}")


def write_wall_clock_report(status: str, exit_code: int, error: str = "", **extra: object) -> None:
    if not WALL_CLOCK_CONTEXT:
        return
    finished_at = datetime.now().astimezone()
    payload = {
        "startedAt": WALL_CLOCK_CONTEXT["startedAt"],
        "finishedAt": finished_at.isoformat(),
        "elapsedSeconds": round(time.perf_counter() - WALL_CLOCK_CONTEXT["perfStarted"], 3),
        "status": status,
        "exitCode": exit_code,
        "error": error,
        "figmaUrl": WALL_CLOCK_CONTEXT.get("figmaUrl", ""),
        "fileKey": WALL_CLOCK_CONTEXT.get("fileKey", ""),
        "nodeId": WALL_CLOCK_CONTEXT.get("nodeId", ""),
        "targetPrefab": WALL_CLOCK_CONTEXT.get("targetPrefab", ""),
        "targetImageDir": WALL_CLOCK_CONTEXT.get("targetImageDir", ""),
        "manifestDir": WALL_CLOCK_CONTEXT.get("manifestDir", ""),
        "manifestMode": WALL_CLOCK_CONTEXT.get("manifestMode", ""),
        "targetSnapshot": WALL_CLOCK_CONTEXT.get("targetSnapshot", {}),
        "timings": WALL_CLOCK_CONTEXT.get("timings", []),
    }
    payload.update(extra)
    report_path = Path(WALL_CLOCK_CONTEXT["reportPath"])
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_manifest_target_snapshot(manifest_dir: Path) -> dict:
    node_manifest = read_json(manifest_dir / "figma_node_manifest.json")
    result_path = manifest_dir / "figma_to_prefab_mcp_result.json"
    result_payload = read_json(result_path) if result_path.exists() else {}
    result = result_payload.get("result", result_payload)

    root_node_id = node_manifest.get("rootNodeId") or (node_manifest.get("root") or {}).get("id", "")
    root_node = None
    for node in node_manifest.get("nodes", []):
        if node.get("id") == root_node_id:
            root_node = node
            break
    if root_node is None and node_manifest.get("nodes"):
        root_node = node_manifest["nodes"][0]
    root_node = root_node or {}

    bounds = (
        node_manifest.get("rootBounds")
        or (node_manifest.get("root") or {}).get("bounds")
        or root_node.get("bounds")
        or root_node.get("relativeBounds")
        or {}
    )
    child_ids = root_node.get("childIds") or (node_manifest.get("root") or {}).get("childIds") or []
    return {
        "fileKey": node_manifest.get("fileKey", ""),
        "rootNodeId": root_node_id or root_node.get("id", ""),
        "rootName": node_manifest.get("rootName") or (node_manifest.get("root") or {}).get("name") or root_node.get("name", ""),
        "rootType": root_node.get("type") or (node_manifest.get("root") or {}).get("type", ""),
        "rootWidth": bounds.get("width", 0),
        "rootHeight": bounds.get("height", 0),
        "directChildCount": len(child_ids),
        "nodeCount": len(node_manifest.get("nodes", [])),
        "resultStatus": result.get("status", ""),
        "blockingErrorCount": len(result.get("blockingErrors", []) or []),
        "warningCount": len(result.get("warnings", []) or []),
    }


def validate_manifest_target(snapshot: dict, file_key: str, node_id: str, args: argparse.Namespace) -> list[str]:
    errors = []
    if snapshot.get("resultStatus") and snapshot.get("resultStatus") != "completed":
        errors.append(f"manifest MCP result status is {snapshot.get('resultStatus')}, expected completed")
    if snapshot.get("blockingErrorCount", 0) != 0:
        errors.append(f"manifest MCP result has blockingErrorCount={snapshot.get('blockingErrorCount')}")
    if snapshot.get("fileKey") and snapshot.get("fileKey") != file_key:
        errors.append(f"manifest fileKey {snapshot.get('fileKey')} != requested {file_key}")
    if snapshot.get("rootNodeId") != node_id:
        errors.append(f"manifest rootNodeId {snapshot.get('rootNodeId')} != requested {node_id}")
    if args.expect_root_name and snapshot.get("rootName") != args.expect_root_name:
        errors.append(f"manifest rootName {snapshot.get('rootName')} != expected {args.expect_root_name}")
    if args.expect_root_width and int(round(float(snapshot.get("rootWidth") or 0))) != args.expect_root_width:
        errors.append(f"manifest rootWidth {snapshot.get('rootWidth')} != expected {args.expect_root_width}")
    if args.expect_root_height and int(round(float(snapshot.get("rootHeight") or 0))) != args.expect_root_height:
        errors.append(f"manifest rootHeight {snapshot.get('rootHeight')} != expected {args.expect_root_height}")
    if args.expect_direct_child_count >= 0 and snapshot.get("directChildCount") != args.expect_direct_child_count:
        errors.append(f"manifest directChildCount {snapshot.get('directChildCount')} != expected {args.expect_direct_child_count}")
    return errors


def extract_plan_field(key: str) -> str | None:
    plan_path = UNITY_PROJECT / ".tmp" / "roslyn_import_plan.txt"
    if not plan_path.exists():
        return None
    for line in plan_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(key + "="):
            return line[len(key) + 1 :].strip()
    return None


def read_import_plan() -> tuple[str, list[str]]:
    plan_path = UNITY_PROJECT / ".tmp" / "roslyn_import_plan.txt"
    image_dir = ""
    spec_paths: list[str] = []
    for raw_line in plan_path.read_text(encoding="utf-8").splitlines():
        key, separator, value = raw_line.partition("=")
        if not separator:
            continue
        if key.strip() == "imageDir":
            image_dir = value.strip()
        elif key.strip() == "specPath":
            spec_paths.append(value.strip())
    if not image_dir or not spec_paths:
        fail(f"invalid import plan: {plan_path}")
    return image_dir, spec_paths


def step(name: str) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {name}")
    print(f"{'=' * 60}")


def fail(msg: str, code: int = 1) -> None:
    print(f"\n[FAIL] {msg}")
    write_wall_clock_report("failed", code, msg)
    sys.exit(code)


def main():
    parser = argparse.ArgumentParser(description="Figma → Unity Prefab 一键导入")
    parser.add_argument("--unity-project", default="",
                        help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--figma-url", required=True, help="Figma 节点 URL（含 node-id）")
    parser.add_argument("--target-prefab", required=True, help="目标 Prefab 资产路径，如 Assets/.../UI_Foo.prefab")
    parser.add_argument("--target-image-dir", required=True, help="目标图片目录，如 Assets/.../Images/")
    parser.add_argument("--infer-formal-names", action="store_true",
                        help="Infer formal Prefab/image paths from Figma root name and --formal-output-dir")
    parser.add_argument("--formal-output-dir", default="",
                        help="Unity Assets directory for --infer-formal-names, e.g. Assets/FigmaImportBenchmark")
    parser.add_argument("--overwrite", default="create-new-only",
                        choices=["create-new-only", "overwrite"], help="覆盖策略（默认: create-new-only）")
    parser.add_argument("--prefab-name", default="", help="Prefab 根节点名称（默认从路径推断）")
    parser.add_argument("--manifest-dir", default=".tmp/figma-to-prefab", help="MCP Relay 产物目录")
    parser.add_argument("--file-key", default="", help="Target Figma fileKey for stable MCP plugin-session routing")
    parser.add_argument("--session-id", default="", help="Target Figma plugin sessionId for stable routing")
    parser.add_argument("--relay-url", default="http://localhost:32130", help="figmaMcpRelay companion URL")
    parser.add_argument("--mcp-timeout", type=int, default=300, help="MCP export timeout seconds")
    parser.add_argument("--skip-mcp-export", action="store_true", help="Reuse existing manifest-dir instead of exporting from Figma")
    parser.add_argument("--expect-root-name", default="", help="Optional target guard: expected Figma root node name")
    parser.add_argument("--expect-root-width", type=int, default=0, help="Optional target guard: expected Figma root width")
    parser.add_argument("--expect-root-height", type=int, default=0, help="Optional target guard: expected Figma root height")
    parser.add_argument("--expect-direct-child-count", type=int, default=-1, help="Optional target guard: expected direct child count")
    parser.add_argument("--wall-clock-report", default="", help="Write real wall-clock timing JSON to this path")
    parser.add_argument("--include-hidden", action="store_true", help="Request hidden Figma nodes in MCP export")
    parser.add_argument("--no-screenshot", action="store_true", help="Skip screenshot export in MCP export")
    parser.add_argument("-y", "--yes", action="store_true", help="跳过 gen_spec 确认，直接执行阶段二")
    parser.add_argument("--check-only", action="store_true", help="只运行 gen_spec 和审核报告，不写入")
    parser.add_argument("--workers", type=int, default=6, help="process_images 并行线程数（默认 6）")

    args = parser.parse_args()
    try:
        configure_project_paths(args.unity_project)
    except RuntimeError as error:
        parser.error(str(error))
    workflow_started = time.perf_counter()
    timings: list[dict] = []

    # ─── 步骤 1: gen_spec.py ───

    manifest_dir = Path(args.manifest_dir)
    if not manifest_dir.is_absolute():
        manifest_dir = REPO_ROOT / manifest_dir
    request_path = manifest_dir / "figma_to_prefab_request.json"
    result_path = manifest_dir / "figma_to_prefab_mcp_result.json"
    node_manifest_path = manifest_dir / "figma_node_manifest.json"
    image_manifest_path = manifest_dir / "image_export_manifest.json"
    image_health_summary: dict = {}

    def emit_summary(status: str, **extra: object) -> None:
        payload = {
            "status": status,
            "prefab": args.target_prefab,
            "targetImageDir": args.target_image_dir,
            "manifestDir": str(manifest_dir).replace("\\", "/"),
            "requestPath": str(request_path).replace("\\", "/"),
            "nodeManifestPath": str(node_manifest_path).replace("\\", "/"),
            "imageManifestPath": str(image_manifest_path).replace("\\", "/"),
            "manifestSummary": str(manifest_dir / "manifest_summary.md").replace("\\", "/"),
            "totalElapsedSeconds": round(time.perf_counter() - workflow_started, 3),
            "timings": timings,
            "imageHealthSummary": image_health_summary,
        }
        payload.update(extra)
        print("\n[SUMMARY_JSON]")
        print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))

    file_key, node_id = parse_figma_url(args.figma_url)
    if args.file_key:
        file_key = args.file_key.strip()
    if not file_key or not node_id:
        fail("figma-url must include file key and node-id, or pass --file-key with a URL that includes node-id")

    target_prefab_path = resolve_repo_path(args.target_prefab)
    target_image_path = resolve_repo_path(UNITY_PROJECT / args.target_image_dir if args.target_image_dir.startswith("Assets/") else args.target_image_dir)
    wall_clock_report = resolve_repo_path(args.wall_clock_report) if args.wall_clock_report else TMP_DIR / "figma_to_prefab_wall_clock.json"
    guard_report_path(VERIFY_PREFAB_REPORT, "verify_prefab report")
    guard_report_path(wall_clock_report, "wall-clock report")
    WALL_CLOCK_CONTEXT.update({
        "startedAt": datetime.now().astimezone().isoformat(),
        "perfStarted": workflow_started,
        "figmaUrl": args.figma_url,
        "fileKey": file_key,
        "nodeId": node_id,
        "targetPrefab": args.target_prefab,
        "targetImageDir": args.target_image_dir,
        "targetPrefabResolved": str(target_prefab_path),
        "targetImageDirResolved": str(target_image_path),
        "manifestDir": str(manifest_dir),
        "manifestMode": "reuse-existing-manifest" if args.skip_mcp_export else "fresh-mcp-export",
        "reportPath": str(wall_clock_report),
        "timings": timings,
    })
    write_export_request(request_path, args.figma_url, file_key, node_id, args)

    step("1/6 MCP export - Figma node manifest")
    if args.skip_mcp_export:
        print("  [skip] Reusing existing manifest-dir.")
    else:
        export_argv = [
            str(MCP_EXPORT),
            "--request", str(request_path),
            "--result", str(result_path),
            "--node-manifest", str(node_manifest_path),
            "--image-manifest", str(image_manifest_path),
            "--relay-url", args.relay_url,
            "--file-key", file_key,
            "--timeout", str(args.mcp_timeout),
        ]
        if args.session_id:
            export_argv += ["--session-id", args.session_id.strip()]
        export_result, timing = run_timed("mcpExport", export_argv, timeout=args.mcp_timeout + 45, cwd=REPO_ROOT)
        timings.append(timing)
        if export_result.stdout:
            print(export_result.stdout)
        if export_result.returncode != 0:
            print(export_result.stderr)
            fail("MCP export failed")

    if not node_manifest_path.exists() or not image_manifest_path.exists():
        fail(f"MCP manifests missing: {node_manifest_path} / {image_manifest_path}")

    image_manifest = read_json(image_manifest_path)
    image_health_summary = image_manifest.get("healthSummary", {})
    image_health_errors = validate_image_manifest_health(image_manifest)
    if image_health_errors:
        fail("image export health gate failed:\n    - " + "\n    - ".join(
            f"{item.get('code', '?')}: {item.get('message', '?')}" for item in image_health_errors
        ))

    snapshot = load_manifest_target_snapshot(manifest_dir)
    WALL_CLOCK_CONTEXT["targetSnapshot"] = snapshot
    target_errors = validate_manifest_target(snapshot, file_key, node_id, args)
    if target_errors:
        fail("Figma manifest target guard failed:\n    - " + "\n    - ".join(target_errors))
    if args.infer_formal_names:
        base_output_dir = args.formal_output_dir or args.target_image_dir
        args.prefab_name, args.target_prefab, args.target_image_dir = derive_formal_paths(
            base_output_dir,
            str(snapshot.get("rootName") or ""),
        )
    elif not args.prefab_name:
        args.prefab_name = Path(args.target_prefab).stem
    validate_formal_import_paths(args.target_prefab, args.target_image_dir, args.prefab_name)
    target_prefab_path = resolve_repo_path(args.target_prefab)
    target_image_path = resolve_repo_path(UNITY_PROJECT / args.target_image_dir if args.target_image_dir.startswith("Assets/") else args.target_image_dir)
    WALL_CLOCK_CONTEXT["targetPrefab"] = args.target_prefab
    WALL_CLOCK_CONTEXT["targetImageDir"] = args.target_image_dir
    WALL_CLOCK_CONTEXT["targetPrefabResolved"] = str(target_prefab_path)
    WALL_CLOCK_CONTEXT["targetImageDirResolved"] = str(target_image_path)
    write_export_request(request_path, args.figma_url, file_key, node_id, args)
    print(
        "  target: "
        f"fileKey={snapshot.get('fileKey') or file_key} "
        f"nodeId={snapshot.get('rootNodeId')} "
        f"name={snapshot.get('rootName')} "
        f"size={snapshot.get('rootWidth')}x{snapshot.get('rootHeight')} "
        f"directChildren={snapshot.get('directChildCount')}"
    )

    reader_result, timing = run_timed(
        "manifestReader",
        [
            str(MANIFEST_READER),
            "--manifest-dir", str(manifest_dir),
            "--output", str(manifest_dir / "manifest_summary.md"),
            "--json-output", str(manifest_dir / "manifest_summary.json"),
        ],
        timeout=30,
        cwd=REPO_ROOT,
    )
    timings.append(timing)
    if reader_result.stdout:
        print(reader_result.stdout)
    if reader_result.returncode != 0:
        print(reader_result.stderr)
        fail("Manifest reader failed")

    step("2/6 gen_spec - Spec and audit report")

    spec_path = TMP_DIR / "prefab_spec.json"
    download_plan = TMP_DIR / "image_download_plan.json"
    audit_path = TMP_DIR / "spec_audit_report.json"
    plan_path = TMP_DIR / "roslyn_import_plan.txt"

    gen_argv = [
        str(GEN_SPEC),
        "--unity-project", str(UNITY_PROJECT),
        "--figma-url", args.figma_url,
        "--target-prefab", args.target_prefab,
        "--target-image-dir", args.target_image_dir,
        "--prefab-name", args.prefab_name,
        "--output-spec", str(spec_path),
        "--output-plan", str(download_plan),
        "--output-audit-report", str(audit_path),
        "--manifest-dir", str(manifest_dir),
        "--output-roslyn-import-plan", str(plan_path),
        "--component-spec-dir", str(TMP_DIR / "figma_component_specs"),
        "--componentset-report", str(TMP_DIR / "componentset_report.json"),
    ]
    # check-only: 不检查磁盘（图片尚未写入）
    # 正常模式: 标记为写前检查（文件缺失 = 预期，不阻塞）
    if not args.check_only:
        gen_argv += ["--check-disk-dir", "/dev/null", "--check-disk-prewrite"]

    gen_result, timing = run_timed("genSpec", gen_argv, timeout=60, cwd=REPO_ROOT)
    timings.append(timing)

    if gen_result.stdout:
        # 只打印非标题行（避免 Markdown 报告中的 # 被当成标题）
        for line in gen_result.stdout.splitlines():
            if line.startswith("=== ") or line.startswith("## "):
                print(line)
            elif "allPass" in line or "节点:" in line or "图片:" in line:
                print(f"  {line.strip()}")
            elif line.startswith("[BLOCKING]") or line.startswith("⚠") or line.startswith("❌"):
                print(line)

    if gen_result.returncode != 0:
        print(gen_result.stderr)

    # 读取审核报告
    audit = read_json(audit_path)
    blocking = audit.get("blockingErrors", [])

    if blocking:
        print(f"\n  [BLOCKING] gen_spec 审核报告包含 {len(blocking)} 个阻塞错误:")
        for be in blocking:
            print(f"    - {be.get('code', '?')}: {be.get('message', '?')}")
            for d in be.get("details", [])[:5]:
                print(f"       {d.get('expected', '?')} → 磁盘: {d.get('disk', '?')} (fix: {d.get('fix', '?')})")
        fail("gen_spec 审核未通过，停止。")

    print(f"\n  allPass: {audit.get('allPass')}")
    print(f"  warnings: {len(audit.get('warnings', []))}")

    if args.check_only:
        print("\n  [check-only] 跳过阶段二。")
        write_wall_clock_report(
            "check-only-completed",
            0,
            "",
            auditReport=to_posix(audit_path),
            auditAllPass=bool(audit.get("allPass")),
            warningCount=len(audit.get("warnings", [])),
            blockingErrorCount=len(blocking),
        )
        emit_summary(
            "check-only-completed",
            auditReport=str(audit_path).replace("\\", "/"),
            auditAllPass=bool(audit.get("allPass")),
            warningCount=len(audit.get("warnings", [])),
            blockingErrorCount=len(blocking),
        )
        return 0

    # ─── 步骤 2: 确认 ───
    project_root = extract_plan_field("projectRoot")
    print(f"\n  projectRoot: {project_root}")
    print(f"  Prefab: {args.target_prefab}")
    print(f"  图片目录: {args.target_image_dir}")

    if not args.yes:
        step("3/6 等待确认")
        try:
            answer = input("  确认执行阶段二（写入图片 + 生成 Prefab）? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n  已取消。")
            write_wall_clock_report("cancelled", 0, "cancelled before Unity write")
            return 0
        if answer not in ("y", "yes"):
            print("  已取消。")
            write_wall_clock_report("cancelled", 0, "cancelled before Unity write")
            return 0

    # ─── 步骤 3: process_images.py ───
    step("4/6 process_images - write PNG")

    image_report = TMP_DIR / "image_process_report.json"

    pi_result, timing = run_timed("processImages", [
        str(PROCESS_IMAGES),
        "--unity-project", str(UNITY_PROJECT),
        "--manifest-dir", str(manifest_dir),
        "--output-dir", str(UNITY_PROJECT / args.target_image_dir),
        "--download-plan", str(download_plan),
        "--workers", str(args.workers),
        "--output-report", str(image_report),
    ], timeout=120)
    timings.append(timing)

    img_report = read_json(image_report) if image_report.exists() else {}
    if not img_report.get("allPass", False):
        fail(f"process_images 未通过: blockingErrors={img_report.get('blockingErrors', [])}")

    print(f"  allPass: {img_report['allPass']}")
    print(f"  summary: {json.dumps(img_report.get('summary', {}), ensure_ascii=False)}")

    # ─── 步骤 4: uLoop — 导入 Sprite 并生成 Prefab ───
    step("5/6 uLoop - Sprite import + Prefab generation")
    image_dir, spec_paths = read_import_plan()
    print("  → uLoop import_sprites_and_generate_prefabs...")
    gen_result = run_uloop_import(image_dir, spec_paths, timeout=120)
    if not gen_result.get("success"):
        fail(f"uLoop 导入失败: {json.dumps(gen_result, ensure_ascii=False)[:500]}")
    print(f"  结果: {gen_result.get('stdout', '').strip()}")

    # ─── 步骤 5: 验证 ───
    step("6/6 verify - Prefab static checks + Console logs")

    # 5a: verify_prefab
    print("  → verify_prefab.py...")
    vp_result, timing = run_timed("verifyPrefab", [
        str(VERIFY_PREFAB),
        "--unity-project", str(UNITY_PROJECT),
        "--prefab", args.target_prefab,
        "--json",
    ], timeout=30)
    timings.append(timing)

    try:
        vp = json.loads(vp_result.stdout)
    except json.JSONDecodeError:
        print(f"  [WARN] verify_prefab 输出无法解析: {vp_result.stdout[:200]}")
        vp = {"allPass": False}
    VERIFY_PREFAB_REPORT.write_text(json.dumps(vp, ensure_ascii=False, indent=2), encoding="utf-8")

    if not vp.get("allPass"):
        msg = "verify_prefab 未通过"
        for be in vp.get("blockingErrors", []):
            msg += f"\n    - {be}"
        print(f"  {msg}")
    else:
        print(f"  ✅ allPass=True")

    # ─── 最终报告 ───
    print(f"\n{'=' * 60}")
    print(f"  导入完成")
    print(f"{'=' * 60}")
    print(f"  Prefab: {args.target_prefab}")
    print(f"  图片: {args.target_image_dir}")
    print(f"  verify_prefab allPass: {vp.get('allPass', False)}")
    print(f"  spriteNull: {vp.get('checks', {}).get('spriteNull', {}).get('count', '?')}")
    print(f"  raycastTargetOn: {vp.get('checks', {}).get('raycastTargetOn', {}).get('count', '?')}")
    print(f"  autoSizeOff: {vp.get('checks', {}).get('autoSizeOff', {}).get('count', '?')}")
    print(f"  commonFont: {vp.get('checks', {}).get('commonFontExact', {}).get('count', '?')}/{vp.get('checks', {}).get('commonFontExact', {}).get('mismatch', '?')}")
    print(f"  TMP材质: {vp.get('checks', {}).get('allowedMaterial', {}).get('count', '?')}/{vp.get('checks', {}).get('allowedMaterial', {}).get('mismatch', '?')}")

    emit_summary(
        "completed" if vp.get("allPass") else "failed",
        auditReport=str(audit_path).replace("\\", "/"),
        imageReport=str(image_report).replace("\\", "/"),
        verifyReport=str(VERIFY_PREFAB_REPORT).replace("\\", "/"),
        wallClockReport=str(wall_clock_report).replace("\\", "/"),
        verifyAllPass=bool(vp.get("allPass")),
    )
    write_wall_clock_report(
        "completed" if vp.get("allPass") else "failed",
        0 if vp.get("allPass") else 2,
        "",
        auditReport=to_posix(audit_path),
        imageReport=to_posix(image_report),
        verifyReport=to_posix(VERIFY_PREFAB_REPORT),
        targetPrefabResolved=str(target_prefab_path),
        targetImageDirResolved=str(target_image_path),
        verifyAllPass=bool(vp.get("allPass")),
    )

    sys.exit(0 if vp.get("allPass") else 2)


if __name__ == "__main__":
    main()
