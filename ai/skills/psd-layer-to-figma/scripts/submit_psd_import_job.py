#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PSD 导入 Figma Job 提交脚本。

读取 export_psd_layers.py 导出的 manifest_summary.json，自动生成
正确的 IMPORT_PSD_JOB 格式 payload，作为无 MCP tool 暴露时的 CLI fallback
提交到本地 MCP Relay gateway。Agent 标准入口优先使用 figmaMcpRelay.figma_submit_job；
本脚本通过共享 MCP client 调用 figmaMcpRelay；本地 HTTP/WebSocket 仅属于 companion 内部 transport。

用法：
  python "<relay-root>/ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py" ^
    .tmp/psd-layer-to-figma/psd_layers_xxx/manifest_summary.json ^
    --root-name "source.psd_xxx" ^
    --wait

参数：
  manifest_path  必需。manifest_summary.json 的路径。
  --root-name    可选。Figma 中根 Frame 的名称。默认 "source.psd_layers"。
  --relay-url    可选。MCP Relay 地址。默认 "http://localhost:32130"。
  --file-key     强烈建议。目标 Figma 文件 key，用于稳定路由到正确插件会话。
  --session-id   可选。目标插件 sessionId；多 Figma 窗口时比 fileKey 更精确。
  --target-node-id 可选。导入根 Frame 的 parent nodeId；不传则当前 Page。
  --wait         可选。提交后轮询等待结果。
  --timeout      可选。等待超时秒数。默认 120。
  --component-common  可选。通用组件库根节点 ID。默认 "62:115"。
  --component-image   可选。通用图片库根节点 ID。默认 "2896:32"。
  --output       可选。将完整 payload 写入 JSON 文件，不提交。

注意事项（血泪教训，参见 psd-import-hard-lessons.md 第五节）：
  - job.type 必须精确为 "IMPORT_PSD_JOB"，不允许用任何变体。
  - manifest 必须内嵌完整 JSON，不能传文件路径。
  - assets 数组的 path 必须是绝对路径。
  - Agent 标准入口优先走 figmaMcpRelay.figma_submit_job。
  - CLI fallback 必须显式传 --file-key 或 --session-id，避免写到错误 Figma 会话。

示例：
  提交并等待结果：
    python "<relay-root>/ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py" ^
      .tmp/psd-layers/manifest_summary.json --root-name "source.psd_mydesign" --wait

  只生成 payload 不提交（调试用）：
    python "<relay-root>/ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py" ^
      .tmp/psd-layers/manifest_summary.json --output debug_payload.json
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable

def find_relay_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "client" / "figma_mcp_client.py").is_file():
            return parent
    raise RuntimeError("Unable to locate the Figma MCP Relay root.")


RELAY_ROOT = find_relay_root()
MCP_CLIENT_DIR = RELAY_ROOT / "client"
if str(MCP_CLIENT_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_CLIENT_DIR))

from figma_mcp_client import (  # noqa: E402
    health as mcp_health,
    query_selection as mcp_query_selection,
    submit_job as mcp_submit_job,
)


class Timeline:
    def __init__(self, output_path: str = "") -> None:
        self.output_path = output_path
        self.events: list[dict[str, Any]] = []

    def step(self, name: str, **metadata: Any) -> "TimelineStep":
        return TimelineStep(self, name, metadata)

    def add_event(
        self,
        name: str,
        status: str,
        start: float,
        end: float,
        metadata: dict[str, Any] | None = None,
        error: str = "",
    ) -> None:
        event = {
            "name": name,
            "status": status,
            "startIso": iso_from_timestamp(start),
            "endIso": iso_from_timestamp(end),
            "durationMs": round((end - start) * 1000, 3),
        }
        if metadata:
            event["metadata"] = metadata
        if error:
            event["error"] = error
        self.events.append(event)

    def write(self, path: str = "") -> str:
        out_path = os.path.abspath(path or self.output_path)
        if not out_path:
            return ""
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"events": self.events}, f, ensure_ascii=False, indent=2)
            f.write("\n")
        return out_path


class TimelineStep:
    def __init__(self, timeline: Timeline, name: str, metadata: dict[str, Any]) -> None:
        self.timeline = timeline
        self.name = name
        self.metadata = metadata
        self.start = 0.0

    def __enter__(self) -> "TimelineStep":
        self.start = time.time()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        end = time.time()
        self.timeline.add_event(
            self.name,
            "error" if exc else "completed",
            self.start,
            end,
            self.metadata,
            str(exc) if exc else "",
        )
        return False


def iso_from_timestamp(value: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(value)) + f".{int((value % 1) * 1000):03d}"


def resolve_manifest_path(raw: str) -> str:
    """解析 manifest 路径，支持绝对路径和相对路径。"""
    if os.path.isabs(raw):
        return raw
    # 尝试从 CWD 解析
    cwd_abs = os.path.abspath(raw)
    if os.path.exists(cwd_abs):
        return cwd_abs
    # 尝试项目根目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, "..", "..", "..", ".."))
    proj_abs = os.path.abspath(os.path.join(project_root, raw))
    if os.path.exists(proj_abs):
        return proj_abs
    raise FileNotFoundError(f"manifest 文件不存在：{raw}")


def manifest_layers(manifest: dict) -> list[dict]:
    """Return layers using the same summary-bucket fallback as the Figma plugin."""
    raw_layers = manifest.get("layers")
    if isinstance(raw_layers, list):
        return [layer for layer in raw_layers if isinstance(layer, dict)]

    buckets: Iterable[str] = (
        "imageLayers",
        "textLayers",
        "commonLayers",
        "nineSliceLayers",
    )
    layers: list[dict] = []
    for key in buckets:
        bucket = manifest.get(key)
        if isinstance(bucket, list):
            layers.extend(layer for layer in bucket if isinstance(layer, dict))
    return layers


def build_assets(manifest_dir: str, layers: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """从 manifest 的 layers 路径构建 assets 数组和 assetPaths 映射。"""
    assets: list[dict] = []
    asset_paths: dict[str, str] = {}
    for layer in layers:
        idx = str(layer.get("idx", 0))
        rel_path = layer.get("path", "")
        png_name = os.path.basename(rel_path) if rel_path else f"{idx}.png"
        abs_path = os.path.abspath(os.path.join(manifest_dir, png_name))
        if os.path.exists(abs_path):
            norm_path = abs_path.replace(os.sep, "/")
            assets.append({"id": idx, "path": norm_path})
            asset_paths[idx] = norm_path
    return assets, asset_paths


def build_payload(
    manifest: dict,
    root_name: str,
    common_root_id: str,
    image_root_id: str,
    file_key: str = "",
    session_id: str = "",
    target_node_id: str = "",
    import_mode: str = "initial",
    baseline_fingerprint: str = "",
    source_file_name: str = "",
) -> dict:
    """构建 IMPORT_PSD_JOB 格式的 payload。

    ⚠️ 强制规则（见 psd-import-hard-lessons.md 第五节）：
    - job.type 必须精确为 "IMPORT_PSD_JOB"
    - manifest 字段必须是内嵌数据，不是文件路径字符串
    """
    manifest_dir = os.path.dirname(
        os.path.abspath(manifest.get("__source_path", ""))
    )
    layers = manifest_layers(manifest)
    assets, asset_paths = build_assets(manifest_dir, layers)

    target: dict[str, str] = {}
    if session_id:
        target["sessionId"] = session_id
    if file_key:
        target["fileKey"] = file_key
    if target_node_id:
        target["nodeId"] = target_node_id

    job = {
        "type": "IMPORT_PSD_JOB",          # ← 必须精确，不能写变体
        "mode": import_mode,
        "name": root_name,
        "sourceFileName": source_file_name or root_name,
        "manifest": manifest,               # ← 内嵌完整 JSON，不是路径
        "assets": assets,
        "componentLibrary": {
            "commonRootId": common_root_id,
            "imageRootId": image_root_id,
        },
    }
    if file_key:
        job["fileKey"] = file_key
    if session_id:
        job["sessionId"] = session_id
    if target:
        job["target"] = target
    if target_node_id:
        job["targetNodeId"] = target_node_id
    if baseline_fingerprint:
        job["baselineFingerprint"] = baseline_fingerprint

    payload = {
        "job": job,
        "assetPaths": asset_paths,
    }
    if file_key:
        payload["fileKey"] = file_key
    if session_id:
        payload["sessionId"] = session_id
    if target:
        payload["target"] = target
    return payload


def fetch_health(relay_url: str) -> dict:
    """Read relay health through the MCP client surface."""
    return mcp_health(relay_url=relay_url.rstrip("/"))


def plugin_sessions(health: dict) -> list[dict]:
    plugin = health.get("plugin") if isinstance(health.get("plugin"), dict) else {}
    sessions = plugin.get("sessions") if isinstance(plugin.get("sessions"), list) else []
    return [s for s in sessions if isinstance(s, dict)]


def unwrap_tool_result(value: dict) -> dict:
    if isinstance(value, dict) and isinstance(value.get("result"), dict):
        return value["result"]
    return value if isinstance(value, dict) else {}


def preflight_target(relay_url: str, file_key: str, session_id: str) -> dict:
    """Fail early when the requested target cannot be resolved to a live plugin session."""
    try:
        health = fetch_health(relay_url)
    except Exception as exc:
        raise RuntimeError(f"preflight /health failed: {exc}") from exc

    plugin = health.get("plugin") if isinstance(health.get("plugin"), dict) else {}
    sessions = plugin_sessions(health)
    if not plugin.get("connected") or not sessions:
        raise RuntimeError("preflight failed: no online Figma plugin session")
    if not plugin.get("authenticated"):
        raise RuntimeError("preflight failed: Figma plugin session is not authenticated")

    if session_id:
        matches = [s for s in sessions if str(s.get("sessionId") or "") == session_id]
        if not matches:
            raise RuntimeError(f"preflight failed: sessionId not online: {session_id}")
    if file_key:
        matches = [s for s in sessions if str(s.get("fileKey") or "") == file_key]
        if not matches:
            fallback_session_id = session_id or str(plugin.get("activeSessionId") or "")
            selection = mcp_query_selection(
                relay_url=relay_url,
                session_id=fallback_session_id,
                timeout=15,
            )
            selection = unwrap_tool_result(selection)
            if str(selection.get("fileKey") or "") != file_key:
                online = ", ".join(str(s.get("fileKey") or "?") for s in sessions)
                raise RuntimeError(f"preflight failed: fileKey not online: {file_key}; online={online}")
            health["resolvedSessionId"] = fallback_session_id
    if not session_id and not file_key and len(sessions) > 1:
        raise RuntimeError("preflight failed: multiple plugin sessions online; pass --file-key or --session-id")
    return health


def apply_resolved_session(payload: dict, health: dict, explicit_session_id: str) -> None:
    """Route by session when health heartbeat omits fileKey but read-only probe confirmed it."""
    resolved_session_id = str(health.get("resolvedSessionId") or "")
    if explicit_session_id or not resolved_session_id:
        return
    payload["sessionId"] = resolved_session_id
    target = payload.setdefault("target", {})
    if isinstance(target, dict):
        target["sessionId"] = resolved_session_id
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    job["sessionId"] = resolved_session_id
    job_target = job.setdefault("target", {})
    if isinstance(job_target, dict):
        job_target["sessionId"] = resolved_session_id


def default_result_output_path(manifest_abs: str) -> str:
    """Return the default full-result path next to manifest_summary.json."""
    return os.path.join(os.path.dirname(manifest_abs), "figma_mcp_result.json")


def submit_psd_job(payload: dict, relay_url: str, request_id: str, wait: bool, timeout: int) -> dict:
    """Submit through figmaMcpRelay MCP tooling; CLI is only a fallback wrapper."""
    result = mcp_submit_job(
        payload["job"],
        payload.get("assetPaths", {}),
        relay_url=relay_url.rstrip("/"),
        request_id=request_id,
        wait=wait,
        timeout=float(timeout),
        full_result=True,
        debug_full_result=True,
    )
    if wait and isinstance(result.get("result"), dict):
        return result
    if wait:
        return {"requestId": request_id, "result": result}
    return result


def save_screenshot_if_present(result: dict, manifest_abs: str) -> str:
    """Write screenshot evidence to disk, or accept a Relay-written screenshot path."""
    res = result.get("result") if isinstance(result.get("result"), dict) else result
    screenshot = res.get("screenshot") if isinstance(res, dict) else None
    if not isinstance(screenshot, dict):
        return ""
    existing_path = str(screenshot.get("path") or "")
    if existing_path:
        existing_abs = os.path.abspath(existing_path)
        if not os.path.exists(existing_abs):
            raise ValueError(f"Relay screenshot path does not exist: {existing_abs}")
        with open(existing_abs, "rb") as f:
            if not is_png_bytes(f.read(8)):
                raise ValueError(f"Relay screenshot path is not a PNG: {existing_abs}")
        screenshot["path"] = existing_abs.replace(os.sep, "/")
        screenshot["byteLength"] = os.path.getsize(existing_abs)
        screenshot.pop("base64", None)
        mark_result_screenshot_valid(result)
        return existing_abs
    if not screenshot.get("base64"):
        return ""
    raw = base64.b64decode(str(screenshot.get("base64") or ""), validate=True)
    if not is_png_bytes(raw):
        raise ValueError(f"Relay screenshot is not a valid PNG payload: {len(raw)} bytes")
    safe_name = str(screenshot.get("fileName") or "screenshot.png")
    safe_name = safe_name.replace(":", "_").replace("\\", "_").replace("/", "_")
    screenshot_path = os.path.join(os.path.dirname(manifest_abs), safe_name)
    with open(screenshot_path, "wb") as f:
        f.write(raw)
    screenshot["path"] = screenshot_path.replace(os.sep, "/")
    screenshot["byteLength"] = len(raw)
    mark_result_screenshot_valid(result)
    screenshot.pop("base64", None)
    return screenshot_path


def is_png_bytes(raw: bytes) -> bool:
    return len(raw) >= 8 and raw[:8] == b"\x89PNG\r\n\x1a\n"


def save_result_file(result: dict, output_path: str, manifest_abs: str) -> tuple[str, str]:
    """Persist the full wait result, with screenshot bytes stored as a separate file."""
    screenshot_path = ""
    try:
        screenshot_path = save_screenshot_if_present(result, manifest_abs)
    except Exception as exc:
        mark_result_screenshot_error(result, exc)
    if not screenshot_path and result_status(result) == "completed":
        mark_result_screenshot_error(
            result,
            ValueError("Relay screenshot base64 missing; no screenshot file was written"),
        )
    out_path = os.path.abspath(output_path or default_result_output_path(manifest_abs))
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return out_path, screenshot_path


def result_status(result: dict) -> str:
    res = result.get("result") if isinstance(result.get("result"), dict) else result
    return str(res.get("status") or "") if isinstance(res, dict) else ""


def mark_result_screenshot_valid(result: dict) -> None:
    res = result.get("result") if isinstance(result.get("result"), dict) else result
    if not isinstance(res, dict):
        return
    summary = res.get("summary") if isinstance(res.get("summary"), dict) else {}
    validation = summary.get("validation") if isinstance(summary.get("validation"), dict) else {}
    validation["screenshotExported"] = True
    validation["screenshotFileValid"] = True
    summary["validation"] = validation
    res["summary"] = summary


def mark_result_screenshot_error(result: dict, exc: Exception) -> None:
    res = result.get("result") if isinstance(result.get("result"), dict) else result
    if not isinstance(res, dict):
        return
    message = f"screenshot validation failed: {exc}"
    errors = res.setdefault("errors", [])
    if isinstance(errors, list):
        errors.append(message)
    res["status"] = "completed_with_errors"
    summary = res.get("summary") if isinstance(res.get("summary"), dict) else {}
    validation = summary.get("validation") if isinstance(summary.get("validation"), dict) else {}
    validation["screenshotExported"] = False
    validation["screenshotFileValid"] = False
    validation["screenshotError"] = message
    summary["validation"] = validation
    res["summary"] = summary


def validation_gate_summary(validation: dict) -> dict:
    """Return compact gate values without expanding the full validation object."""
    fields = [
        "missingNodeCount", "emptyImageFillCount", "badTransformCount",
        "textClipRiskCount", "emptyTextCount", "textColorMismatchCount",
        "textStrokeMismatchCount", "sliceProblemCount", "emptySliceLayerCount",
        "missingSliceSourceFillCount", "indexOrderBad", "positionMismatchCount",
        "sizeMismatchCount",
    ]
    return {field: validation.get(field) for field in fields if field in validation}


def manifest_semantic_hint_summary(manifest: dict) -> dict:
    """Return compact reporting-only semantic hint metadata from the manifest."""
    hints = manifest.get("semanticHints") if isinstance(manifest.get("semanticHints"), dict) else {}
    psd_prefix = hints.get("psdPrefix") if isinstance(hints.get("psdPrefix"), dict) else {}
    segments = psd_prefix.get("segments") if isinstance(psd_prefix.get("segments"), list) else []
    coverage = psd_prefix.get("coverage") if isinstance(psd_prefix.get("coverage"), dict) else {}
    return {
        "psdPrefix": {
            "hintOnly": bool(psd_prefix.get("hintOnly", True)),
            "segmentCount": len(segments),
            "coverage": coverage,
            "segments": [
                {
                    "candidateName": segment.get("candidateName"),
                    "startPrefix": segment.get("startPrefix"),
                    "endPrefix": segment.get("endPrefix"),
                    "count": segment.get("count"),
                }
                for segment in segments[:8]
                if isinstance(segment, dict)
            ],
            "warningCount": len(psd_prefix.get("warnings") if isinstance(psd_prefix.get("warnings"), list) else []),
        }
    }


def compact_timeline_summary(timeline: Timeline) -> dict:
    """Return enough timing evidence for agents to avoid reopening timeline.json."""
    events = []
    machine_time_ms = 0.0
    for event in timeline.events:
        duration = event.get("durationMs")
        if isinstance(duration, (int, float)):
            machine_time_ms += float(duration)
        events.append(
            {
                "name": event.get("name", ""),
                "status": event.get("status", ""),
                "startIso": event.get("startIso", ""),
                "endIso": event.get("endIso", ""),
                "durationMs": duration,
            }
        )
    return {
        "machineTimeMs": round(machine_time_ms, 3),
        "events": events,
    }


def summary_passes_fast_gate(status: str, validation: dict, warning_count: int, error_count: int, screenshot_path: str) -> bool:
    """True when normal delivery can stop without extra Figma child queries."""
    required_zero_fields = [
        "missingNodeCount", "emptyImageFillCount", "badTransformCount",
        "textClipRiskCount", "textColorMismatchCount",
        "textStrokeMismatchCount", "sliceProblemCount", "indexOrderBad",
        "positionMismatchCount", "sizeMismatchCount",
    ]
    if status != "completed" or warning_count or error_count or not screenshot_path:
        return False
    return all(validation.get(field) == 0 for field in required_zero_fields)


def build_wait_summary(
    result: dict,
    result_path: str,
    screenshot_path: str,
    max_samples: int,
    timeline: Timeline | None = None,
    manifest: dict | None = None,
) -> dict:
    """Build a small stdout payload; full evidence stays in result_path."""
    res = result.get("result") if isinstance(result.get("result"), dict) else result
    if not isinstance(res, dict):
        res = {}
    summary = res.get("summary") if isinstance(res.get("summary"), dict) else {}
    validation = summary.get("validation") if isinstance(summary.get("validation"), dict) else {}
    warnings = res.get("warnings") if isinstance(res.get("warnings"), list) else []
    errors = res.get("errors") if isinstance(res.get("errors"), list) else []
    status = res.get("status", "unknown")
    fast_gate_pass = summary_passes_fast_gate(status, validation, len(warnings), len(errors), screenshot_path)
    return {
        "status": status,
        "result": result_path.replace(os.sep, "/") if result_path else "",
        "screenshot": screenshot_path.replace(os.sep, "/") if screenshot_path else "",
        "rootNodeId": res.get("rootNodeId", ""),
        "rootName": res.get("rootName", ""),
        "createdCount": res.get("createdCount", 0),
        "durationMs": summary.get("durationMs"),
        "layerCount": summary.get("layerCount"),
        "stats": summary.get("stats", {}),
        "validation": validation_gate_summary(validation),
        "warningCount": len(warnings),
        "errorCount": len(errors),
        "warningSamples": warnings[:max_samples],
        "errorSamples": errors[:max_samples],
        "semanticHints": manifest_semantic_hint_summary(manifest or {}),
        "stopAfterSummary": fast_gate_pass,
        "stopReason": "completed gates are zero and screenshot exists; do not run full child-tree queries unless user asks or a gate fails" if fast_gate_pass else "",
        "timeline": compact_timeline_summary(timeline) if timeline else {},
    }


def default_timeline_output_path(raw: str, result_output: str, manifest_abs: str) -> str:
    if raw:
        return os.path.abspath(raw)
    if result_output:
        return os.path.join(os.path.dirname(os.path.abspath(result_output)), "timeline.json")
    if manifest_abs:
        return os.path.join(os.path.dirname(os.path.abspath(manifest_abs)), "timeline.json")
    return ""


def add_timeline_instant(timeline: Timeline, name: str, **metadata: Any) -> None:
    now = time.time()
    timeline.add_event(name, "completed", now, now, metadata)


def validate_fast_repeat_args(args: argparse.Namespace) -> None:
    """Allow fast repeat only after the caller has already pinned routing context."""
    if not args.fast_repeat:
        return
    if not args.file_key.strip() and not args.session_id.strip():
        raise RuntimeError("--fast-repeat requires --file-key or --session-id")
    if args.output:
        raise RuntimeError("--fast-repeat cannot be combined with --output")


def is_successful_import_status(status: str, import_mode: str) -> bool:
    """Treat each import mode's valid terminal response as a successful submission."""
    if import_mode == "incremental-preview":
        return status in {"preview-ready", "preview-blocked"}
    if import_mode == "incremental-apply":
        return status == "applied"
    return status == "completed"


def format_gate_checks(validation: dict) -> list[str]:
    """格式化交付门禁检查结果。"""
    fields = [
        "missingNodeCount", "emptyImageFillCount", "badTransformCount",
        "textClipRiskCount", "emptyTextCount", "textColorMismatchCount",
        "textStrokeMismatchCount", "sliceProblemCount", "emptySliceLayerCount",
        "missingSliceSourceFillCount", "indexOrderBad", "positionMismatchCount",
        "sizeMismatchCount",
    ]
    lines = []
    for f in fields:
        val = validation.get(f, "N/A")
        if isinstance(val, (int, float)):
            status = "PASS" if val == 0 else "FAIL" if val > 0 else "WARN"
        else:
            status = "WARN"
        lines.append(f"    {status} {f}: {val}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(
        description="PSD 导入 Figma Job 提交脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("manifest_path", help="manifest_summary.json 路径")
    parser.add_argument("--root-name", default="source.psd_layers", help="Figma 根 Frame 名称")
    parser.add_argument("--relay-url", default="http://localhost:32130", help="MCP Relay 地址")
    parser.add_argument("--file-key", default="", help="目标 Figma fileKey；建议始终传入以稳定路由")
    parser.add_argument("--session-id", default="", help="目标 Figma 插件 sessionId；多窗口时优先级最高")
    parser.add_argument("--target-node-id", default="", help="导入根 Frame 的目标 parent nodeId；不传则当前 Page")
    parser.add_argument(
        "--import-mode",
        choices=("initial", "incremental-preview", "incremental-apply"),
        default="initial",
        help="首次导入、增量预览或确认后的增量应用",
    )
    parser.add_argument("--baseline-fingerprint", default="", help="增量应用必须携带的预览指纹")
    parser.add_argument("--source-file-name", default="", help="仅保存文件名，用于隐藏的 PSD 来源校验")
    parser.add_argument("--x", type=float, default=None, help="Imported root Frame x position")
    parser.add_argument("--y", type=float, default=None, help="Imported root Frame y position")
    parser.add_argument("--no-preflight", action="store_true", help="跳过 /health target 预检")
    parser.add_argument(
        "--fast-repeat",
        action="store_true",
        help="Skip duplicate script preflight after this run already verified Figma context with MCP tools; result gates and screenshot validation still run.",
    )
    parser.add_argument("--wait", action="store_true", help="提交后轮询等待结果")
    parser.add_argument("--timeout", type=int, default=120, help="等待超时秒数")
    parser.add_argument("--component-common", default="62:115", help="通用组件库根节点 ID")
    parser.add_argument("--component-image", default="2896:32", help="通用图片库根节点 ID")
    parser.add_argument("--output", default="", help="将 payload 写入此文件（不提交）")
    parser.add_argument("--result-output", default="", help="Full result JSON output path; defaults to figma_mcp_result.json next to manifest")
    parser.add_argument("--timeline-output", default="", help="Timeline JSON output path; defaults to timeline.json next to result")
    parser.add_argument("--max-samples", type=int, default=5, help="Max warning/error samples in compact stdout")
    parser.add_argument("--verbose-result", action="store_true", help="Print full wait result to stdout; default prints compact summary")
    args = parser.parse_args()
    timeline = Timeline()
    try:
        validate_fast_repeat_args(args)
    except RuntimeError as e:
        print(f"[FAIL] Fast repeat guard failed: {e}")
        return 1
    if args.import_mode != "initial" and not args.target_node_id.strip():
        print("[FAIL] Incremental import requires --target-node-id")
        return 1
    if args.import_mode == "incremental-apply" and not args.baseline_fingerprint.strip():
        print("[FAIL] Incremental apply requires --baseline-fingerprint")
        return 1

    # 读取 manifest
    with timeline.step("resolve_manifest_path", manifestPath=args.manifest_path):
        manifest_abs = resolve_manifest_path(args.manifest_path)
    print(f"[READ] manifest: {manifest_abs}")
    with timeline.step("read_manifest", manifestPath=manifest_abs):
        with open(manifest_abs, "r", encoding="utf-8-sig") as f:
            manifest = json.load(f)

    # 标记源路径（构建 assets 时需要）
    manifest["__source_path"] = manifest_abs

    # 构建 payload
    print(f"[BUILD] payload...")
    with timeline.step("build_payload", rootName=args.root_name, x=args.x, y=args.y):
        payload = build_payload(
            manifest,
            root_name=args.root_name,
            common_root_id=args.component_common,
            image_root_id=args.component_image,
            file_key=args.file_key.strip(),
            session_id=args.session_id.strip(),
            target_node_id=args.target_node_id.strip(),
            import_mode=args.import_mode,
            baseline_fingerprint=args.baseline_fingerprint.strip(),
            source_file_name=args.source_file_name.strip(),
        )
        if args.x is not None:
            payload["job"]["x"] = args.x
        if args.y is not None:
            payload["job"]["y"] = args.y

    # 验证 payload 格式
    with timeline.step("validate_payload"):
        assert payload["job"]["type"] == "IMPORT_PSD_JOB", "job.type 必须是 IMPORT_PSD_JOB"
        assert isinstance(payload["job"]["manifest"], dict), "manifest 必须是内嵌对象，不能是路径字符串"
    layer_count = len(manifest_layers(manifest))
    asset_count = len(payload["job"]["assets"])
    print(f"  layers: {layer_count}, assets: {asset_count}")
    print(f"  payloadSizeKb: ~{len(json.dumps(payload, ensure_ascii=False, separators=(',',':'))) / 1024:.0f}")
    if args.x is not None or args.y is not None:
        print(f"  Position: x={payload['job'].get('x', '-')}, y={payload['job'].get('y', '-')}")
    if args.file_key or args.session_id:
        print(f"  Target: fileKey={args.file_key or '-'}, sessionId={args.session_id or '-'}, nodeId={args.target_node_id or '-'}")

    # 输出模式
    if args.output:
        out_path = os.path.abspath(args.output)
        with timeline.step("write_payload_output", outputPath=out_path):
            os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"[SAVE] Payload written: {out_path}")
        timeline_path = default_timeline_output_path(args.timeline_output, args.result_output, manifest_abs)
        if timeline_path:
            print(f"[SAVE] Timeline written: {timeline.write(timeline_path)}")
        return 0

    # 提交
    if args.fast_repeat:
        print("[FAST] Skipping duplicate script preflight; caller must have verified file/page/selection with MCP tools in this run.")
        add_timeline_instant(
            timeline,
            "preflight_target_skipped",
            mode="fast-repeat",
            fileKey=args.file_key.strip(),
            sessionId=args.session_id.strip(),
        )
    elif not args.no_preflight:
        print(f"[PREFLIGHT] relay health + target...")
        try:
            with timeline.step("preflight_target", relayUrl=args.relay_url, fileKey=args.file_key.strip(), sessionId=args.session_id.strip()):
                health = preflight_target(args.relay_url, args.file_key.strip(), args.session_id.strip())
                apply_resolved_session(payload, health, args.session_id.strip())
            sessions = plugin_sessions(health)
            print(f"  plugin sessions: {len(sessions)}")
            if health.get("resolvedSessionId"):
                print(f"  resolvedSessionId: {health.get('resolvedSessionId')}")
        except RuntimeError as e:
            print(f"[FAIL] Preflight failed: {e}")
            timeline_path = default_timeline_output_path(args.timeline_output, args.result_output, manifest_abs)
            if timeline_path:
                print(f"  Timeline JSON: {timeline.write(timeline_path)}")
            return 1

    request_id = f"psd-import-{int(time.time() * 1000)}"
    print(f"[SUBMIT] job via figmaMcpRelay MCP ...")
    try:
        with timeline.step("submit_import_job", requestId=request_id, wait=args.wait, timeout=args.timeout):
            result = submit_psd_job(payload, args.relay_url, request_id, wait=args.wait, timeout=args.timeout)
    except RuntimeError as e:
        print(f"[FAIL] Submit failed: {e}")
        timeline_path = default_timeline_output_path(args.timeline_output, args.result_output, manifest_abs)
        if timeline_path:
            print(f"  Timeline JSON: {timeline.write(timeline_path)}")
        return 1

    print(f"  requestId: {request_id}")

    if not args.wait:
        print(f"[OK] Job submitted (async). Check result at:")
        print(f"   Use figmaMcpRelay.figma_wait_result requestId={request_id}")
        return 0

    # 轮询等待
    with timeline.step("save_result_and_screenshot", resultOutput=args.result_output):
        result_path, screenshot_path = save_result_file(result, args.result_output, manifest_abs)
    timeline_path = default_timeline_output_path(args.timeline_output, result_path, manifest_abs)
    if timeline_path:
        timeline.write(timeline_path)

    res = result.get("result", {})
    status = res.get("status", "unknown")
    status_symbol = "[OK]" if status == "completed" else "[WARN]"
    print(f"\n{'='*50}")
    print(f"  Import status: {status_symbol} {status}")

    summary = res.get("summary", {})
    validation = summary.get("validation", {})

    print(f"\n  Created: {res.get('createdCount', 0)} nodes")
    print(f"  Duration: {summary.get('durationMs', '?')}ms")
    print(f"  Root NodeId: {res.get('rootNodeId', '?')}")
    print(f"  Warnings: {len(res.get('warnings', []))}")
    print(f"  Errors: {len(res.get('errors', []))}")
    print(f"  Result JSON: {result_path}")

    if validation:
        print(f"\n  Validation gates:")
        for line in format_gate_checks(validation):
            print(line)

    stats = summary.get("stats", {})
    if stats:
        print(f"\n  Layer stats:")
        for k, v in stats.items():
            print(f"    {k}: {v}")

    if screenshot_path:
        print(f"\n  Screenshot: {screenshot_path}")
    if timeline_path:
        print(f"  Timeline JSON: {timeline_path}")
    print("\n[SUMMARY_JSON]")
    if args.verbose_result:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        compact_summary = build_wait_summary(
            result,
            result_path,
            screenshot_path,
            max(0, args.max_samples),
            timeline,
            manifest,
        )
        compact_summary["fastRepeat"] = bool(args.fast_repeat)
        compact_summary["preflightSkipped"] = bool(args.fast_repeat or args.no_preflight)
        print(json.dumps(compact_summary, ensure_ascii=True, indent=2))

    return 0 if is_successful_import_status(status, args.import_mode) else 1


if __name__ == "__main__":
    sys.exit(main())
