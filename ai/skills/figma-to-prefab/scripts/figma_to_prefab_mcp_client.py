#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CLI fallback for the Figma-to-Prefab MCP export workflow.

Agent-facing workflows should prefer the figmaMcpRelay MCP tools directly. This
script is a file-oriented fallback that still routes through the MCP companion,
preflights the target plugin session, writes full evidence to disk, and prints
only a compact summary by default.
"""

from __future__ import annotations

import argparse
import base64
import shutil
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


DEFAULT_RELAY_URL = "http://localhost:32130"
PLUGIN_ROOT = Path(__file__).resolve().parents[4]
MCP_CLIENT_DIR = PLUGIN_ROOT / "client"
DEFAULT_REQUEST_PATH = Path(".tmp/figma-to-prefab/figma_to_prefab_request.json")
DEFAULT_RESULT_PATH = Path(".tmp/figma-to-prefab/figma_to_prefab_mcp_result.json")
DEFAULT_NODE_MANIFEST_PATH = Path(".tmp/figma-to-prefab/figma_node_manifest.json")
DEFAULT_IMAGE_MANIFEST_PATH = Path(".tmp/figma-to-prefab/image_export_manifest.json")

if str(MCP_CLIENT_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_CLIENT_DIR))

from figma_mcp_client import health as mcp_health, submit_job as mcp_submit_job  # noqa: E402


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def ensure_mcp_companion(
    relay_url: str,
    startup_timeout: float = 10.0,
    mcp_url: str = "",
    stdio: bool = False,
) -> Dict[str, Any]:
    del startup_timeout
    return mcp_health(relay_url=relay_url.rstrip("/"), mcp_url=mcp_url.rstrip("/"), stdio=stdio)


def result_of_payload(result_payload: Dict[str, Any]) -> Dict[str, Any]:
    result = result_payload.get("result")
    return result if isinstance(result, dict) else {}


def plugin_sessions(health_payload: Dict[str, Any]) -> list[Dict[str, Any]]:
    plugin = health_payload.get("plugin") if isinstance(health_payload.get("plugin"), dict) else {}
    sessions = plugin.get("sessions") if isinstance(plugin.get("sessions"), list) else []
    return [item for item in sessions if isinstance(item, dict)]


def preflight_target(
    relay_url: str,
    file_key: str,
    session_id: str,
    startup_timeout: float,
    mcp_url: str,
    stdio: bool,
) -> Dict[str, Any]:
    health_payload = ensure_mcp_companion(
        relay_url,
        startup_timeout=startup_timeout,
        mcp_url=mcp_url,
        stdio=stdio,
    )
    plugin = health_payload.get("plugin") if isinstance(health_payload.get("plugin"), dict) else {}
    sessions = plugin_sessions(health_payload)
    if not plugin.get("connected") or not sessions:
        raise RuntimeError("preflight failed: no online Figma plugin session")
    if not plugin.get("authenticated"):
        raise RuntimeError("preflight failed: Figma plugin session is not authenticated")
    if session_id:
        matches = [item for item in sessions if str(item.get("sessionId") or "") == session_id]
        if not matches:
            raise RuntimeError(f"preflight failed: sessionId not online: {session_id}")
    if file_key:
        matches = [item for item in sessions if str(item.get("fileKey") or "") == file_key]
        if not matches:
            online = ", ".join(str(item.get("fileKey") or "?") for item in sessions)
            raise RuntimeError(f"preflight failed: fileKey not online: {file_key}; online={online}")
    if not session_id and not file_key and len(sessions) > 1:
        raise RuntimeError("preflight failed: multiple plugin sessions online; pass --file-key or --session-id")
    return health_payload


def build_target(figma_payload: Dict[str, Any], file_key: str, session_id: str) -> Dict[str, str]:
    node_id = str(figma_payload.get("nodeId") or "")
    if not node_id:
        raise ValueError("request JSON missing figma.nodeId")
    request_file_key = str(figma_payload.get("fileKey") or "")
    request_url = str(figma_payload.get("url") or figma_payload.get("figmaUrl") or "")
    target: Dict[str, str] = {"nodeId": node_id}
    if file_key or request_file_key:
        target["fileKey"] = file_key or request_file_key
    if session_id:
        target["sessionId"] = session_id
    if request_url:
        target["url"] = request_url
    return target


def build_job(request_path: Path, job_name: str, file_key: str = "", session_id: str = "") -> Dict[str, Any]:
    request_payload = load_json(request_path)
    figma_payload = request_payload.get("figma")
    if not isinstance(figma_payload, dict):
        raise ValueError("request JSON missing figma object")

    task = str(request_payload.get("task") or "figma-to-prefab-export")
    if task != "figma-to-prefab-export":
        raise ValueError(f"unsupported task: {task}")

    target = build_target(figma_payload, file_key, session_id)
    job: Dict[str, Any] = {
        "schemaVersion": 1,
        "task": task,
        "type": "FIGMA_TO_PREFAB_EXPORT",
        "name": job_name,
        "source": request_path.as_posix(),
        "target": target,
        "request": request_payload,
        "manifest": request_payload,
        "assets": [],
    }
    if target.get("fileKey"):
        job["fileKey"] = target["fileKey"]
    if target.get("sessionId"):
        job["sessionId"] = target["sessionId"]
    return job


def save_screenshot_if_present(result_payload: Dict[str, Any], result_path: Path) -> None:
    result = result_of_payload(result_payload)
    screenshot = result.get("screenshot")
    if not isinstance(screenshot, dict):
        return
    raw_base64 = screenshot.get("base64")
    if not raw_base64:
        return

    screenshot_dir = result_path.parent / "mcp_screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    file_name = str(screenshot.get("fileName") or f"{result.get('rootNodeId', 'screenshot')}.png")
    safe_file_name = file_name.replace(":", "_").replace("\\", "_").replace("/", "_")
    screenshot_path = screenshot_dir / safe_file_name
    screenshot_path.write_bytes(base64.b64decode(str(raw_base64)))
    screenshot["path"] = screenshot_path.as_posix()
    screenshot["byteLength"] = screenshot_path.stat().st_size
    screenshot.pop("base64", None)


def save_manifest_if_present(result_payload: Dict[str, Any], result_keys: Tuple[str, ...], output_path: Path) -> bool:
    result = result_of_payload(result_payload)
    for result_key in result_keys:
        path_key = f"{result_key}Path"
        manifest_path = result.get(path_key)
        if isinstance(manifest_path, str) and manifest_path.strip():
            source_path = Path(manifest_path)
            if source_path.is_file():
                output_path.parent.mkdir(parents=True, exist_ok=True)
                if source_path.resolve() != output_path.resolve():
                    shutil.copy2(source_path, output_path)
                result[path_key] = output_path.as_posix()
                return True

    manifest = None
    matched_key = ""
    for result_key in result_keys:
        candidate = result.get(result_key)
        if isinstance(candidate, dict):
            manifest = candidate
            matched_key = result_key
            break

    if not isinstance(manifest, dict):
        return False

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    result[f"{matched_key}Path"] = output_path.as_posix()
    return True


def count_container(value: Any, *keys: str) -> Optional[int]:
    if isinstance(value, int):
        return value
    if not isinstance(value, dict):
        return None
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, int):
            return candidate
        if isinstance(candidate, (list, dict)):
            return len(candidate)
    return None


def compact_result_summary(
    result_payload: Dict[str, Any],
    result_path: Path,
    node_manifest_path: Path,
    image_manifest_path: Path,
    elapsed_seconds: float,
    request_id: str,
    max_samples: int,
) -> Dict[str, Any]:
    result = result_of_payload(result_payload)
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    validation = result.get("validation") if isinstance(result.get("validation"), dict) else {}
    if not validation and isinstance(summary.get("validation"), dict):
        validation = summary["validation"]

    warnings = result.get("warnings") if isinstance(result.get("warnings"), list) else []
    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    blocking = result.get("blockingErrors") if isinstance(result.get("blockingErrors"), list) else []
    screenshot = result.get("screenshot") if isinstance(result.get("screenshot"), dict) else {}

    node_manifest = result.get("figmaNodeManifest") or result.get("figma_node_manifest") or result.get("nodeManifest")
    image_manifest = result.get("imageExportManifest") or result.get("image_export_manifest") or result.get("imageManifest")
    limit = max(0, max_samples)
    return {
        "status": result.get("status", result_payload.get("status", "unknown")),
        "requestId": result_payload.get("requestId", request_id),
        "elapsedSeconds": round(elapsed_seconds, 3),
        "resultPath": result_path.as_posix(),
        "nodeManifestPath": node_manifest_path.as_posix() if node_manifest_path.exists() else "",
        "imageManifestPath": image_manifest_path.as_posix() if image_manifest_path.exists() else "",
        "rootNodeId": result.get("rootNodeId") or result.get("nodeId"),
        "rootName": result.get("rootName") or result.get("name"),
        "exportedNodeCount": (
            result.get("exportedNodeCount")
            or summary.get("exportedNodeCount")
            or count_container(node_manifest, "nodes", "items")
        ),
        "expectedNodeCount": summary.get("expectedNodeCount") or validation.get("expectedNodeCount"),
        "imageCount": summary.get("imageCount") or count_container(image_manifest, "images", "items", "assets"),
        "missingImageCount": validation.get("missingImageCount") or validation.get("missingImageFillCount"),
        "textCount": summary.get("textCount"),
        "textMetadataMissingCount": validation.get("textMetadataMissingCount"),
        "slicedImageCount": summary.get("slicedImageCount"),
        "invalidSliceMetadataCount": validation.get("invalidSliceMetadataCount") or validation.get("sliceProblemCount"),
        "warningCount": len(warnings),
        "blockingErrorCount": len(blocking),
        "errorCount": len(errors),
        "warningSamples": warnings[:limit],
        "blockingErrorSamples": blocking[:limit],
        "errorSamples": errors[:limit],
        "screenshot": {
            "present": bool(screenshot),
            "path": screenshot.get("path"),
            "byteLength": screenshot.get("byteLength"),
        },
    }


def run_health(args: argparse.Namespace) -> int:
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    mcp_url = args.mcp_url.rstrip("/")
    payload = ensure_mcp_companion(
        relay_url,
        startup_timeout=args.startup_timeout,
        mcp_url=mcp_url,
        stdio=args.stdio,
    )
    print("[SUMMARY_JSON]")
    print(json.dumps({
        "status": "ok",
        "relayUrl": relay_url,
        "mcpUrl": mcp_url,
        "stdio": args.stdio,
        "elapsedSeconds": round(time.perf_counter() - started_at, 3),
        "health": payload,
    }, ensure_ascii=False, indent=2))
    return 0


def run_export(args: argparse.Namespace) -> int:
    relay_url = args.relay_url.rstrip("/")
    mcp_url = args.mcp_url.rstrip("/")
    request_path = args.request.resolve()
    result_path = args.result.resolve()
    if not request_path.exists():
        raise FileNotFoundError(f"request file does not exist: {request_path}")

    started_at = time.perf_counter()
    if args.no_preflight:
        ensure_mcp_companion(
            relay_url,
            startup_timeout=args.startup_timeout,
            mcp_url=mcp_url,
            stdio=args.stdio,
        )
    else:
        preflight_target(
            relay_url,
            args.file_key.strip(),
            args.session_id.strip(),
            args.startup_timeout,
            mcp_url,
            args.stdio,
        )

    request_id = str(uuid.uuid4())
    job = build_job(request_path, args.job_name, args.file_key.strip(), args.session_id.strip())
    result_payload = mcp_submit_job(
        job,
        {},
        relay_url=relay_url,
        request_id=request_id,
        wait=True,
        timeout=args.timeout,
        full_result=True,
        debug_full_result=True,
        mcp_url=mcp_url,
        stdio=args.stdio,
    )

    save_screenshot_if_present(result_payload, result_path)
    node_manifest_saved = save_manifest_if_present(
        result_payload,
        ("figmaNodeManifest", "figma_node_manifest", "nodeManifest"),
        args.node_manifest.resolve(),
    )
    image_manifest_saved = save_manifest_if_present(
        result_payload,
        ("imageExportManifest", "image_export_manifest", "imageManifest"),
        args.image_manifest.resolve(),
    )
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = compact_result_summary(
        result_payload,
        result_path,
        args.node_manifest.resolve(),
        args.image_manifest.resolve(),
        time.perf_counter() - started_at,
        request_id,
        args.max_samples,
    )
    summary["requestPath"] = request_path.as_posix()
    summary["nodeManifestSaved"] = node_manifest_saved
    summary["imageManifestSaved"] = image_manifest_saved
    if args.verbose_result:
        summary["result"] = result_payload.get("result", {})
    print("[SUMMARY_JSON]")
    print(json.dumps(summary, ensure_ascii=True, indent=2))
    return 0 if summary.get("status") in ("completed", "ok", None) else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Figma To Prefab MCP wrapper")
    parser.add_argument("--request", type=Path, default=DEFAULT_REQUEST_PATH)
    parser.add_argument("--result", type=Path, default=DEFAULT_RESULT_PATH)
    parser.add_argument("--node-manifest", type=Path, default=DEFAULT_NODE_MANIFEST_PATH)
    parser.add_argument("--image-manifest", type=Path, default=DEFAULT_IMAGE_MANIFEST_PATH)
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL)
    parser.add_argument("--bridge-url", dest="relay_url", default=DEFAULT_RELAY_URL, help=argparse.SUPPRESS)
    parser.add_argument("--mcp-url", default="", help="Persistent MCP companion URL; default is {relay-url}/mcp")
    parser.add_argument("--stdio", action="store_true", help="Use stdio MCP server instead of HTTP companion")
    parser.add_argument("--file-key", default="", help="Target Figma fileKey for stable plugin-session routing")
    parser.add_argument("--session-id", default="", help="Target Figma plugin sessionId")
    parser.add_argument("--no-preflight", action="store_true", help="Skip live plugin target preflight")
    parser.add_argument("--job-name", default="Figma_To_Prefab_Export")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--interval", type=float, default=0.5, help="Deprecated; kept for CLI compatibility")
    parser.add_argument("--startup-timeout", type=float, default=10.0)
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--max-samples", type=int, default=5)
    parser.add_argument("--verbose-result", action="store_true", help="Print full result in stdout")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.health:
        return run_health(args)
    return run_export(args)


if __name__ == "__main__":
    raise SystemExit(main())
