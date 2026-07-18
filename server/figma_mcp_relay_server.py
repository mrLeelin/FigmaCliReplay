"""
Figma MCP Relay local runtime service.

职责：
- 作为本地 MCP Relay 常驻在 localhost；
- 接收 MCP companion 或调试 wrapper 提交的 job；
- 供 Figma 插件 worker 轮询并执行 job；
- 接收 Figma 插件执行结果，并让提交方等待结果。

本服务不依赖第三方库，方便一键启动。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import socket
import threading
import time
import uuid
import re
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

from crop_jiugong import crop_jiugong_images
from python_logger import PythonLogger


DEFAULT_BIND_HOST = "127.0.0.1"
DEFAULT_BIND_HOST_IPV6 = "::1"
DEFAULT_PUBLIC_HOST = "localhost"
DEFAULT_PORT = 32130
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PREFAB_TO_FIGMA_SCRIPT_DIR = PLUGIN_ROOT / "ai" / "skills" / "prefab-to-figma" / "scripts"
PREFAB_TO_FIGMA_TMP_DIR = PLUGIN_ROOT / ".tmp" / "prefab-to-figma" / "plugin-import"
CODEX_MCP_SERVER_NAME = "figmaMcpRelay"
INTERNAL_RELAY_HEADER = "X-Figma-Mcp-Relay-Internal"
INTERNAL_RELAY_VALUE = "plugin-runtime"
LARGE_INLINE_PAYLOAD_KEYS = {"base64", "pngBase64", "imageBase64", "bytes"}
LARGE_INLINE_PAYLOAD_MIN_LENGTH = 4096
BASE64_LIKE_RE = re.compile(r"^[A-Za-z0-9+/=_-]+$")
MCP_CLIENT_LABELS = {
    "codex": "Codex App",
    "claude": "Claude Code",
}
LOGGER = PythonLogger("legacy-relay-server")


@dataclass
class RelayJob:
    """MCP Relay 中等待或执行中的单个任务。"""

    request_id: str
    job: Dict[str, Any]
    asset_paths: Dict[str, Path]
    created_at: float = field(default_factory=time.time)
    delivered: bool = False
    result: Optional[Dict[str, Any]] = None
    target_session_id: str = ""
    target_file_key: str = ""
    result_event: threading.Event = field(default_factory=threading.Event)


@dataclass
class PrefabImportTask:
    """Figma 插件一键导入 Prefab 的后台任务状态。"""

    task_id: str
    payload: Dict[str, Any]
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    status: str = "queued"
    stage: str = "queued"
    current_index: int = 0
    total: int = 0
    percent: int = 0
    logs: List[str] = field(default_factory=list)
    result: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)


class RelayState:
    """线程安全保存任务队列和执行结果。"""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.jobs: Dict[str, RelayJob] = {}
        self.queue: List[str] = []
        self.prefab_import_tasks: Dict[str, PrefabImportTask] = {}
        self.mcp_clients: Dict[str, Dict[str, Any]] = {}
        self.started_at = time.time()

    def add_job(self, job: RelayJob) -> None:
        """加入一个等待 Figma worker 执行的任务。"""
        with self.lock:
            self.jobs[job.request_id] = job
            self.queue.append(job.request_id)

    def get_next_job(self, target: Optional[Dict[str, str]] = None) -> Optional[RelayJob]:
        """取下一个未派发任务，取到后标记 delivered。"""
        with self.lock:
            scan_count = len(self.queue)
            for _ in range(scan_count):
                request_id = self.queue.pop(0)
                job = self.jobs.get(request_id)
                if job and job.result is None and not job.delivered and job_matches_target(job, target or {}):
                    job.delivered = True
                    return job
                if job and job.result is None and not job.delivered:
                    self.queue.append(request_id)
            return None

    def get_job(self, request_id: str) -> Optional[RelayJob]:
        """按 requestId 查找任务。"""
        with self.lock:
            return self.jobs.get(request_id)

    def set_result(self, request_id: str, result: Dict[str, Any]) -> bool:
        """写入 Figma worker 执行结果。"""
        with self.lock:
            job = self.jobs.get(request_id)
            if not job:
                return False
            job.result = result
            job.result_event.set()
            return True

    def status(self) -> Dict[str, Any]:
        """返回 MCP Relay 当前状态。"""
        with self.lock:
            pending = sum(1 for item in self.jobs.values() if item.result is None)
            done = sum(1 for item in self.jobs.values() if item.result is not None)
            prefab_import_running = sum(
                1 for item in self.prefab_import_tasks.values()
                if item.status in ("queued", "running")
            )
            return {
                "status": "ok",
                "pending": pending,
                "done": done,
                "total": len(self.jobs),
                "prefabImportRunning": prefab_import_running,
                "mcpClientCount": len(self.mcp_clients),
                "uptimeSeconds": round(time.time() - self.started_at, 2),
            }

    def add_prefab_import_task(self, task: PrefabImportTask) -> None:
        """登记一个 Prefab 导入后台任务。"""
        with self.lock:
            self.prefab_import_tasks[task.task_id] = task

    def get_prefab_import_task(self, task_id: str) -> Optional[PrefabImportTask]:
        """读取 Prefab 导入任务。"""
        with self.lock:
            return self.prefab_import_tasks.get(task_id)

    def update_prefab_import_task(
        self,
        task_id: str,
        *,
        status: Optional[str] = None,
        stage: Optional[str] = None,
        current_index: Optional[int] = None,
        total: Optional[int] = None,
        percent: Optional[int] = None,
        log: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        """线程安全更新 Prefab 导入任务状态。"""
        with self.lock:
            task = self.prefab_import_tasks.get(task_id)
            if not task:
                return
            if status is not None:
                task.status = status
            if stage is not None:
                task.stage = stage
            if current_index is not None:
                task.current_index = current_index
            if total is not None:
                task.total = total
            if percent is not None:
                task.percent = max(0, min(100, int(percent)))
            if log:
                task.logs.append(log)
                task.logs = task.logs[-80:]
            if result is not None:
                task.result = result
            if error:
                task.errors.append(error)
            task.updated_at = time.time()

    def record_mcp_request(self, payload: Any, remote: Any, user_agent: str = "") -> None:
        """Track recent HTTP MCP clients. Streamable HTTP is stateless, so this is last-seen telemetry."""
        messages = payload if isinstance(payload, list) else [payload]
        remote_host = ""
        remote_port = ""
        if isinstance(remote, tuple) and remote:
            remote_host = str(remote[0])
            remote_port = str(remote[1]) if len(remote) > 1 else ""
        now = time.time()
        with self.lock:
            for message in messages:
                if not isinstance(message, dict):
                    continue
                method = str(message.get("method") or "")
                params = message.get("params") if isinstance(message.get("params"), dict) else {}
                client_info = params.get("clientInfo") if isinstance(params.get("clientInfo"), dict) else {}
                client_name = str(client_info.get("name") or "").strip()
                client_version = str(client_info.get("version") or "").strip()
                key = client_name or f"{remote_host}:{remote_port}" or "unknown-mcp-client"
                previous = self.mcp_clients.get(key, {})
                self.mcp_clients[key] = {
                    "name": client_name or previous.get("name") or key,
                    "version": client_version or previous.get("version") or "",
                    "remote": remote_host,
                    "remotePort": remote_port,
                    "userAgent": user_agent or previous.get("userAgent") or "",
                    "lastMethod": method or previous.get("lastMethod") or "",
                    "firstSeen": previous.get("firstSeen") or now,
                    "lastSeen": now,
                    "requestCount": int(previous.get("requestCount") or 0) + 1,
                }

    def mcp_client_status(self) -> Dict[str, Any]:
        """Return recent MCP client telemetry for the plugin panel."""
        with self.lock:
            clients = sorted(
                self.mcp_clients.values(),
                key=lambda item: float(item.get("lastSeen") or 0),
                reverse=True,
            )
        return {
            "ok": True,
            "clients": clients,
            "count": len(clients),
        }


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    """写入 JSON 响应和 CORS 头。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", f"Content-Type, {INTERNAL_RELAY_HEADER}")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def should_return_summary(parsed: Any) -> bool:
    """Return true when caller asks for a compact job result."""
    value = query_param(parsed, "summary", "").lower()
    return value in ("1", "true", "yes", "compact")


def is_runtime_relay_request(handler: BaseHTTPRequestHandler) -> bool:
    """Allow private plugin relay endpoints only for Figma runtime or trusted local bridge calls."""
    internal = str(handler.headers.get(INTERNAL_RELAY_HEADER) or "").strip()
    if internal == INTERNAL_RELAY_VALUE:
        return True
    origin = str(handler.headers.get("Origin") or "").strip().lower()
    if not origin:
        return False
    return (
        origin == "https://www.figma.com"
        or origin == "https://figma.com"
        or origin.startswith("https://www.figma.com/")
        or origin.startswith("https://figma.com/")
    )


def private_relay_forbidden(handler: BaseHTTPRequestHandler) -> None:
    json_response(handler, 403, {
        "error": "Private Figma runtime relay endpoint. Use the figmaMcpRelay MCP tools instead.",
    })


def redact_large_relay_payload(value: Any, key: str = "") -> Any:
    """Strip inline image/base64 payloads before data is returned to an AI-facing caller."""
    if isinstance(value, str):
        if is_large_payload_key(key) or looks_like_large_base64(value):
            return {
                "redacted": True,
                "reason": "large inline payload",
                "originalLength": len(value),
            }
        return value
    if isinstance(value, list):
        return [redact_large_relay_payload(item) for item in value]
    if isinstance(value, dict):
        return {
            str(child_key): redact_large_relay_payload(child_value, str(child_key))
            for child_key, child_value in value.items()
        }
    return value


def is_large_payload_key(key: str) -> bool:
    return key in LARGE_INLINE_PAYLOAD_KEYS


def looks_like_large_base64(value: str) -> bool:
    if len(value) < LARGE_INLINE_PAYLOAD_MIN_LENGTH:
        return False
    sample = value[:256]
    return bool(BASE64_LIKE_RE.match(sample))


def parse_target(payload: Dict[str, Any], job_payload: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Read relay target routing fields from payload/job."""
    job_payload = job_payload if isinstance(job_payload, dict) else {}
    raw_target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    job_target = job_payload.get("target") if isinstance(job_payload.get("target"), dict) else {}
    session_id = str(payload.get("sessionId") or raw_target.get("sessionId") or job_payload.get("sessionId") or job_target.get("sessionId") or "").strip()
    file_key = str(payload.get("fileKey") or raw_target.get("fileKey") or job_payload.get("fileKey") or job_target.get("fileKey") or "").strip()
    return {"sessionId": session_id, "fileKey": file_key}


def query_target(parsed: Any) -> Dict[str, str]:
    """Read plugin identity from /figma/pending query parameters."""
    return {
        "sessionId": query_param(parsed, "sessionId", "").strip(),
        "fileKey": query_param(parsed, "fileKey", "").strip(),
    }


def job_matches_target(job: RelayJob, target: Dict[str, str]) -> bool:
    """Return whether a queued job can be delivered to this plugin session."""
    session_id = str(target.get("sessionId") or "").strip()
    file_key = str(target.get("fileKey") or "").strip()
    if job.target_session_id and session_id and job.target_session_id != session_id:
        return False
    if job.target_session_id and not session_id:
        return False
    if job.target_file_key and file_key and job.target_file_key != file_key:
        return False
    if job.target_file_key and not file_key:
        return False
    return True


def compact_job_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """Summarize large plugin results without dropping the stored full result."""
    if not isinstance(result, dict):
        return {}
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    validation = summary.get("validation") if isinstance(summary.get("validation"), dict) else {}
    warnings = result.get("warnings") if isinstance(result.get("warnings"), list) else []
    blocking_errors = result.get("blockingErrors") if isinstance(result.get("blockingErrors"), list) else []
    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    screenshot = result.get("screenshot") if isinstance(result.get("screenshot"), dict) else {}
    checks = result.get("checks") if isinstance(result.get("checks"), dict) else {}
    artifacts = result.get("artifacts") if isinstance(result.get("artifacts"), dict) else {}
    screenshot_meta = {
        "fileName": screenshot.get("fileName", ""),
        "mimeType": screenshot.get("mimeType", ""),
        "path": screenshot.get("path", ""),
        "width": screenshot.get("width"),
        "height": screenshot.get("height"),
        "byteLength": screenshot.get("byteLength") or len(str(screenshot.get("base64") or "")),
        "hasBase64": bool(screenshot.get("base64")),
        "fileValid": screenshot.get("fileValid") is True,
    } if screenshot else {}
    gate_fields = [
        "missingNodeCount", "emptyImageFillCount", "badTransformCount",
        "textClipRiskCount", "emptyTextCount", "textColorMismatchCount",
        "textStrokeMismatchCount", "sliceProblemCount", "emptySliceLayerCount",
        "missingSliceSourceFillCount", "indexOrderBad",
    ]
    return {
        "status": result.get("status", "unknown"),
        "allPass": result.get("allPass") is True,
        "rootNodeId": result.get("rootNodeId", ""),
        "rootName": result.get("rootName", ""),
        "createdCount": result.get("createdCount", 0),
        "durationMs": summary.get("durationMs"),
        "layerCount": summary.get("layerCount"),
        "stats": summary.get("stats", {}),
        "summary": summary,
        "checks": compact_hierarchy_checks(checks),
        "artifacts": compact_hierarchy_artifacts(artifacts),
        "validation": {field: validation.get(field) for field in gate_fields if field in validation},
        "screenshot": screenshot_meta,
        "warningCount": len(warnings),
        "blockingErrorCount": len(blocking_errors),
        "errorCount": len(errors),
        "warningSamples": warnings[:5],
        "blockingErrorSamples": blocking_errors[:5],
        "errorSamples": errors[:5],
    }


def compact_hierarchy_checks(checks: Dict[str, Any]) -> Dict[str, Any]:
    compact: Dict[str, Any] = {}
    if not isinstance(checks, dict):
        return compact
    for key, value in checks.items():
        if isinstance(value, dict):
            compact[str(key)] = {
                "pass": value.get("pass") is True,
                "driftCount": value.get("driftCount"),
                "movedCount": value.get("movedCount"),
                "expected": value.get("expected"),
            }
    return compact


def compact_hierarchy_artifacts(artifacts: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(artifacts, dict):
        return {}
    before = artifacts.get("before") if isinstance(artifacts.get("before"), dict) else {}
    after = artifacts.get("after") if isinstance(artifacts.get("after"), dict) else {}
    steps = artifacts.get("steps") if isinstance(artifacts.get("steps"), list) else []
    return {
        "createdGroups": artifacts.get("createdGroups") if isinstance(artifacts.get("createdGroups"), list) else [],
        "deepestGroupId": artifacts.get("deepestGroupId", ""),
        "deepestGroupName": artifacts.get("deepestGroupName", ""),
        "wrapperChain": artifacts.get("wrapperChain") if isinstance(artifacts.get("wrapperChain"), list) else [],
        "beforeDirectChildCount": len(before.get("directChildIds") or []) if before else None,
        "afterDirectChildCount": len(after.get("directChildIds") or []) if after else None,
        "mutatedNodeCount": len(artifacts.get("mutatedNodeIds") or []) if isinstance(artifacts.get("mutatedNodeIds"), list) else None,
        "refs": artifacts.get("refs") if isinstance(artifacts.get("refs"), dict) else {},
        "stepCount": len(steps),
        "steps": steps,
    }


def empty_response(handler: BaseHTTPRequestHandler, status: int) -> None:
    """写入无正文响应。"""
    handler.send_response(status)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", f"Content-Type, {INTERNAL_RELAY_HEADER}")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def file_response(handler: BaseHTTPRequestHandler, path: Path) -> None:
    """返回任务资源文件内容。"""
    if not path.exists() or not path.is_file():
        json_response(handler, 404, {"error": f"file not found: {path}"})
        return

    data = path.read_bytes()
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def open_plugin_folder() -> Dict[str, Any]:
    """打开 Figma MCP Relay 插件所在文件夹，方便用户手动启动或检查本地脚本。"""
    plugin_dir = PLUGIN_ROOT.resolve()
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(plugin_dir))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(plugin_dir)])
        else:
            subprocess.Popen(["xdg-open", str(plugin_dir)])
        return {"ok": True, "path": str(plugin_dir)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "path": str(plugin_dir), "error": str(exc)}


def normalize_mcp_config_client(value: Any) -> str:
    client = str(value or "codex").strip().lower()
    aliases = {
        "codex-app": "codex",
        "codex_app": "codex",
        "claude-code": "claude",
        "claude_code": "claude",
    }
    client = aliases.get(client, client)
    if client not in MCP_CLIENT_LABELS:
        raise ValueError(f"unsupported MCP config client: {client}")
    return client


def query_param(parsed: Any, name: str, default: str = "") -> str:
    values = parse_qs(parsed.query or "").get(name)
    if not values:
        return default
    return str(values[0] or default)


def mcp_config_client_from_query(parsed: Any) -> str:
    return normalize_mcp_config_client(query_param(parsed, "client", "codex"))


def mcp_config_client_from_payload(payload: Dict[str, Any]) -> str:
    return normalize_mcp_config_client(payload.get("client") or "codex")


def add_client_fields(status: Dict[str, Any], client: str) -> Dict[str, Any]:
    status["client"] = client
    status["clientLabel"] = MCP_CLIENT_LABELS.get(client, client)
    return status


def get_claude_config_path() -> Path:
    """Locate the Claude Code user-level JSON config."""
    claude_config_file = os.environ.get("CLAUDE_CONFIG_FILE")
    if claude_config_file:
        return Path(claude_config_file).expanduser()
    return Path.home() / ".claude.json"


def get_codex_config_path() -> Path:
    """Locate the user-level Codex config used by Codex App's MCP server list."""
    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        return Path(codex_home).expanduser() / "config.toml"
    return Path.home() / ".codex" / "config.toml"


def toml_quote(value: str) -> str:
    """Quote a small TOML basic string without pulling in a TOML writer dependency."""
    text = str(value)
    text = text.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n")
    return f'"{text}"'


def mcp_config_block_pattern(name: str) -> re.Pattern[str]:
    escaped = re.escape(name)
    return re.compile(
        rf'(?ms)^(\[mcp_servers\.(?:"{escaped}"|{escaped})\]\s*\r?\n)(.*?)(?=^\[|\Z)'
    )


def read_toml_scalar(block: str, key: str) -> Optional[Any]:
    """Read the simple scalar forms used in Codex MCP config blocks."""
    match = re.search(rf'(?m)^\s*{re.escape(key)}\s*=\s*(.+?)\s*$', block)
    if not match:
        return None
    raw = match.group(1).split("#", 1)[0].strip()
    if raw.lower() in ("true", "false"):
        return raw.lower() == "true"
    if raw.startswith('"') and raw.endswith('"'):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw[1:-1]
    return raw


def desired_mcp_url(public_url: str, mcp_path: str) -> str:
    """Use IPv4 loopback for Codex config so it avoids localhost IPv6 ambiguity."""
    parsed = urlparse(public_url)
    scheme = parsed.scheme or "http"
    host = parsed.hostname or "127.0.0.1"
    if host in ("localhost", "::1"):
        host = "127.0.0.1"
    port = parsed.port or DEFAULT_PORT
    path = mcp_path if mcp_path.startswith("/") else f"/{mcp_path}"
    return f"{scheme}://{host}:{port}{path}"


def describe_mcp_config_entry(text: str, name: str) -> Dict[str, Any]:
    match = mcp_config_block_pattern(name).search(text)
    if not match:
        return {"exists": False, "name": name}
    block = match.group(2)
    return {
        "exists": True,
        "name": name,
        "url": read_toml_scalar(block, "url") or "",
        "enabled": read_toml_scalar(block, "enabled"),
        "blockStart": match.start(),
        "blockEnd": match.end(),
    }


def codex_mcp_config_status(mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    path = get_codex_config_path()
    exists = path.exists()
    text = path.read_text(encoding="utf-8-sig") if exists else ""
    entry = describe_mcp_config_entry(text, CODEX_MCP_SERVER_NAME)
    legacy_figma = describe_mcp_config_entry(text, "figma")
    entry_url = str(entry.get("url") or "")
    entry_enabled = entry.get("enabled")
    enabled_ok = entry_enabled is not False
    configured = bool(entry.get("exists")) and entry_url == mcp_url and enabled_ok
    return add_client_fields({
        "ok": True,
        "serverName": CODEX_MCP_SERVER_NAME,
        "configPath": str(path),
        "configExists": exists,
        "desiredUrl": mcp_url,
        "mcpMounted": mcp_mounted,
        "entryExists": bool(entry.get("exists")),
        "entryUrl": entry_url,
        "entryEnabled": entry_enabled,
        "configured": configured,
        "legacyFigma": {
            "exists": bool(legacy_figma.get("exists")),
            "url": legacy_figma.get("url") or "",
            "enabled": legacy_figma.get("enabled"),
        },
        "managedBy": "Codex user config TOML",
    }, "codex")


def build_codex_mcp_config_block(mcp_url: str) -> str:
    return "\n".join([
        f"[mcp_servers.{CODEX_MCP_SERVER_NAME}]",
        f"url = {toml_quote(mcp_url)}",
        "enabled = true",
        "",
    ])


def backup_codex_config(path: Path) -> str:
    if not path.exists():
        return ""
    stamp = time.strftime("%Y%m%d%H%M%S")
    backup = path.with_name(f"{path.name}.bak-figma-mcp-relay-{stamp}")
    backup.write_bytes(path.read_bytes())
    return str(backup)


def validate_local_mcp_url(mcp_url: str) -> str:
    value = str(mcp_url or "").strip()
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("MCP URL must be http/https")
    if parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("MCP URL must point to local loopback")
    if parsed.path.rstrip("/") != "/mcp":
        raise ValueError("MCP URL path must be /mcp")
    return value


def write_codex_mcp_config(mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    mcp_url = validate_local_mcp_url(mcp_url)
    path = get_codex_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    old_text = path.read_text(encoding="utf-8-sig") if path.exists() else ""
    backup_path = backup_codex_config(path)
    block = build_codex_mcp_config_block(mcp_url)
    pattern = mcp_config_block_pattern(CODEX_MCP_SERVER_NAME)
    if pattern.search(old_text):
        new_text = pattern.sub(block, old_text, count=1)
    else:
        prefix = old_text.rstrip() + "\n\n" if old_text.strip() else ""
        new_text = prefix + block
    path.write_text(new_text, encoding="utf-8")
    status = codex_mcp_config_status(mcp_url, mcp_mounted)
    status.update({"changed": old_text != new_text, "backupPath": backup_path})
    return status


def delete_codex_mcp_config(mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    path = get_codex_config_path()
    if not path.exists():
        status = codex_mcp_config_status(mcp_url, mcp_mounted)
        status.update({"changed": False, "backupPath": ""})
        return status
    old_text = path.read_text(encoding="utf-8-sig")
    pattern = mcp_config_block_pattern(CODEX_MCP_SERVER_NAME)
    if not pattern.search(old_text):
        status = codex_mcp_config_status(mcp_url, mcp_mounted)
        status.update({"changed": False, "backupPath": ""})
        return status
    backup_path = backup_codex_config(path)
    new_text = pattern.sub("", old_text, count=1)
    new_text = re.sub(r"\n{3,}", "\n\n", new_text).strip() + ("\n" if new_text.strip() else "")
    path.write_text(new_text, encoding="utf-8")
    status = codex_mcp_config_status(mcp_url, mcp_mounted)
    status.update({"changed": True, "backupPath": backup_path})
    return status


def read_claude_config(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8-sig")
    if not text.strip():
        return {}
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"Claude config root must be object: {path}")
    return data


def write_claude_config(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def backup_claude_config(path: Path) -> str:
    if not path.exists():
        return ""
    stamp = time.strftime("%Y%m%d%H%M%S")
    backup = path.with_name(f"{path.name}.bak-figma-mcp-relay-{stamp}")
    backup.write_bytes(path.read_bytes())
    return str(backup)


def claude_mcp_config_status(mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    path = get_claude_config_path()
    warnings: List[str] = []
    entry_exists = False
    entry_url = ""
    entry_enabled: Optional[bool] = None
    transport = ""

    try:
        data = read_claude_config(path)
        mcp_servers = data.get("mcpServers")
        if isinstance(mcp_servers, dict):
            entry = mcp_servers.get(CODEX_MCP_SERVER_NAME)
            if isinstance(entry, dict):
                entry_exists = True
                entry_url = str(entry.get("url") or "")
                transport = str(entry.get("type") or entry.get("transport") or "")
                disabled = entry.get("disabled")
                entry_enabled = False if disabled is True else True
        elif mcp_servers is not None:
            warnings.append("Claude config mcpServers is not an object")
    except Exception as exc:  # noqa: BLE001
        warnings.append(str(exc))

    configured = bool(entry_exists and entry_url == mcp_url and entry_enabled is not False)
    return add_client_fields({
        "ok": True,
        "serverName": CODEX_MCP_SERVER_NAME,
        "configPath": str(path),
        "configExists": path.exists(),
        "desiredUrl": mcp_url,
        "mcpMounted": mcp_mounted,
        "entryExists": entry_exists,
        "entryUrl": entry_url,
        "entryEnabled": entry_enabled,
        "configured": configured,
        "scope": "user",
        "transport": transport,
        "cliStatus": "",
        "warnings": warnings,
        "managedBy": "Claude user config JSON",
    }, "claude")


def write_claude_mcp_config(mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    mcp_url = validate_local_mcp_url(mcp_url)
    path = get_claude_config_path()
    old_text = path.read_text(encoding="utf-8-sig") if path.exists() else ""
    data = read_claude_config(path)
    mcp_servers = data.get("mcpServers")
    if not isinstance(mcp_servers, dict):
        mcp_servers = {}
        data["mcpServers"] = mcp_servers
    existing = mcp_servers.get(CODEX_MCP_SERVER_NAME)
    if (
        isinstance(existing, dict)
        and str(existing.get("url") or "") == mcp_url
        and str(existing.get("type") or existing.get("transport") or "") == "http"
        and existing.get("disabled") is not True
    ):
        status = claude_mcp_config_status(mcp_url, mcp_mounted)
        status.update({"changed": False, "backupPath": ""})
        return status
    mcp_servers[CODEX_MCP_SERVER_NAME] = {
        "type": "http",
        "url": mcp_url,
    }
    backup_path = backup_claude_config(path)
    write_claude_config(path, data)
    new_text = path.read_text(encoding="utf-8")
    status = claude_mcp_config_status(mcp_url, mcp_mounted)
    status.update({
        "changed": old_text != new_text,
        "backupPath": backup_path,
    })
    return status


def delete_claude_mcp_config(mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    path = get_claude_config_path()
    if not path.exists():
        status = claude_mcp_config_status(mcp_url, mcp_mounted)
        status.update({"changed": False, "backupPath": ""})
        return status
    old_text = path.read_text(encoding="utf-8-sig")
    data = read_claude_config(path)
    mcp_servers = data.get("mcpServers")
    if not isinstance(mcp_servers, dict) or CODEX_MCP_SERVER_NAME not in mcp_servers:
        status = claude_mcp_config_status(mcp_url, mcp_mounted)
        status.update({"changed": False, "backupPath": ""})
        return status
    backup_path = backup_claude_config(path)
    del mcp_servers[CODEX_MCP_SERVER_NAME]
    write_claude_config(path, data)
    new_text = path.read_text(encoding="utf-8")
    status = claude_mcp_config_status(mcp_url, mcp_mounted)
    status.update({
        "changed": old_text != new_text,
        "backupPath": backup_path,
    })
    return status


def mcp_config_status_for_client(client: str, mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    if client == "claude":
        return claude_mcp_config_status(mcp_url, mcp_mounted)
    return codex_mcp_config_status(mcp_url, mcp_mounted)


def write_mcp_config_for_client(client: str, mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    if client == "claude":
        return write_claude_mcp_config(mcp_url, mcp_mounted)
    return write_codex_mcp_config(mcp_url, mcp_mounted)


def delete_mcp_config_for_client(client: str, mcp_url: str, mcp_mounted: bool) -> Dict[str, Any]:
    if client == "claude":
        return delete_claude_mcp_config(mcp_url, mcp_mounted)
    return delete_codex_mcp_config(mcp_url, mcp_mounted)


def open_codex_config_file() -> Dict[str, Any]:
    path = get_codex_config_path()
    try:
        if path.exists():
            target = path
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            target = path.parent
        if sys.platform.startswith("win"):
            os.startfile(str(target))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
        return {"ok": True, "path": str(path), "opened": str(target), "exists": path.exists()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "path": str(path), "error": str(exc)}


def open_claude_config_location() -> Dict[str, Any]:
    path = get_claude_config_path()
    try:
        if not path.exists():
            write_claude_config(path, {})
        if sys.platform.startswith("win"):
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return {
            "ok": True,
            "path": str(path),
            "opened": str(path),
            "exists": path.exists(),
            "managedBy": "Claude user config JSON",
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "path": str(path), "error": str(exc)}


def open_mcp_config_for_client(client: str) -> Dict[str, Any]:
    if client == "claude":
        return open_claude_config_location()
    return open_codex_config_file()


class FigmaMcpRelayHandler(BaseHTTPRequestHandler):
    """HTTP API：client 提交任务，Figma worker 拉取并回传结果。"""

    server: "FigmaMcpRelayServer"

    def _run_logged_request(self, action: Any) -> None:
        operation_id = str(self.headers.get("X-Operation-Id") or "").strip() or f"py-http-{uuid.uuid4().hex}"
        operation = LOGGER.start_operation(
            "python.http-request",
            operation_id=operation_id,
            data={"method": self.command, "path": urlparse(self.path).path},
        )
        try:
            operation.step("route", "Dispatch Python HTTP route")
            action()
            operation.succeed("Python HTTP request completed")
        except BaseException as exc:
            operation.fail(exc, "Python HTTP request failed")
            raise

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        """默认减少访问日志噪声。"""
        if self.server.verbose:
            LOGGER.debug(
                format % args,
                data={"client": self.client_address[0] if self.client_address else ""},
                operation_name="python.http-access",
            )

    def do_OPTIONS(self) -> None:  # noqa: N802
        """处理浏览器预检请求。"""
        self._run_logged_request(lambda: empty_response(self, 204))

    def do_GET(self) -> None:  # noqa: N802
        self._run_logged_request(self._do_GET)

    def _do_GET(self) -> None:
        """处理 health、worker pending、资源下载和结果查询。"""
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/health", "/ping", "/status"):
            payload = self.server.state.status()
            payload["publicUrl"] = self.server.public_url
            if self.server.mcp_server is not None:
                payload["mcp"] = {
                    "enabled": True,
                    "transport": "streamable_http",
                    "endpoint": f"{self.server.public_url}{self.server.mcp_path}",
                }
            json_response(self, 200, payload)
            return

        if path == "/mcp/config/status":
            try:
                client = mcp_config_client_from_query(parsed)
                payload = mcp_config_status_for_client(
                    client,
                    desired_mcp_url(self.server.public_url, self.server.mcp_path),
                    self.server.mcp_server is not None,
                )
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"ok": False, "error": str(exc)})
                return
            json_response(self, 200, payload)
            return

        if path == "/mcp/clients":
            payload = self.server.state.mcp_client_status()
            payload["mcpEndpoint"] = desired_mcp_url(self.server.public_url, self.server.mcp_path)
            payload["mcpMounted"] = self.server.mcp_server is not None
            json_response(self, 200, payload)
            return

        if path == self.server.mcp_path:
            json_response(self, 405, {"error": "MCP endpoint accepts POST requests"})
            return

        if path == "/figma/pending":
            if not is_runtime_relay_request(self):
                private_relay_forbidden(self)
                return
            job = self.server.state.get_next_job(query_target(parsed))
            if not job:
                empty_response(self, 204)
                return
            json_response(self, 200, {
                "requestId": job.request_id,
                "job": job.job,
            })
            return

        if path.startswith("/assets/"):
            if not is_runtime_relay_request(self):
                private_relay_forbidden(self)
                return
            parts = path.split("/")
            if len(parts) < 4:
                json_response(self, 404, {"error": "asset path must be /assets/{requestId}/{assetId}"})
                return
            request_id = unquote(parts[2])
            asset_id = unquote("/".join(parts[3:]))
            job = self.server.state.get_job(request_id)
            if not job:
                json_response(self, 404, {"error": f"unknown job: {request_id}"})
                return
            asset_path = job.asset_paths.get(asset_id)
            if not asset_path:
                json_response(self, 404, {"error": f"unknown asset: {asset_id}"})
                return
            file_response(self, asset_path)
            return

        if path.startswith("/jobs/") and path.endswith("/result"):
            if not is_runtime_relay_request(self):
                private_relay_forbidden(self)
                return
            request_id = unquote(path.split("/")[2])
            job = self.server.state.get_job(request_id)
            if not job:
                json_response(self, 404, {"error": f"unknown job: {request_id}"})
                return
            if job.result is None:
                empty_response(self, 204)
                return
            if should_return_summary(parsed):
                json_response(self, 200, {"requestId": request_id, "result": compact_job_result(job.result), "summaryOnly": True})
                return
            json_response(self, 200, {"requestId": request_id, "result": redact_large_relay_payload(job.result)})
            return

        if path.startswith("/prefab-to-figma/import/") and path.endswith("/status"):
            parts = path.split("/")
            if len(parts) < 4:
                json_response(self, 404, {"error": "status path must be /prefab-to-figma/import/{taskId}/status"})
                return
            task_id = unquote(parts[3])
            task = self.server.state.get_prefab_import_task(task_id)
            if not task:
                json_response(self, 404, {"error": f"unknown prefab import task: {task_id}"})
                return
            json_response(self, 200, serialize_prefab_import_task(task))
            return

        json_response(self, 404, {"error": f"unknown endpoint: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        self._run_logged_request(self._do_POST)

    def _do_POST(self) -> None:
        """处理 client 提交任务和 Figma worker 回传结果。"""
        parsed = urlparse(self.path)
        path = parsed.path

        if path == self.server.mcp_path:
            payload = self.read_any_json_body()
            if payload is None:
                return
            self.handle_mcp_post(payload)
            return

        if path in ("/jobs", "/figma/result") and not is_runtime_relay_request(self):
            private_relay_forbidden(self)
            return

        if path == "/jobs":
            payload = self.read_json_body()
            if payload is None:
                return
            request_id = str(payload.get("requestId") or uuid.uuid4())
            job_payload = payload.get("job")
            if not isinstance(job_payload, dict):
                json_response(self, 400, {"error": "missing job object"})
                return
            asset_paths = parse_asset_paths(payload.get("assetPaths", {}))
            rewrite_asset_urls(job_payload, request_id, self.server.public_url)
            target = parse_target(payload, job_payload)
            job = RelayJob(
                request_id=request_id,
                job=job_payload,
                asset_paths=asset_paths,
                target_session_id=target["sessionId"],
                target_file_key=target["fileKey"],
            )
            self.server.state.add_job(job)
            json_response(self, 200, {
                "ok": True,
                "requestId": request_id,
                "statusUrl": f"{self.server.public_url}/jobs/{request_id}/result",
            })
            return

        if path == "/figma/result":
            payload = self.read_json_body()
            if payload is None:
                return
            request_id = str(payload.get("requestId") or "")
            result = payload.get("result")
            if not request_id or not isinstance(result, dict):
                json_response(self, 400, {"error": "missing requestId or result"})
                return
            if not self.server.state.set_result(request_id, result):
                json_response(self, 404, {"error": f"unknown job: {request_id}"})
                return
            json_response(self, 200, {"ok": True})
            return

        payload = self.read_json_body()
        if payload is None:
            return

        if path == "/mcp/config/write":
            try:
                client = mcp_config_client_from_payload(payload)
                mcp_url = str(payload.get("url") or "") or desired_mcp_url(self.server.public_url, self.server.mcp_path)
                result = write_mcp_config_for_client(client, mcp_url, self.server.mcp_server is not None)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"ok": False, "error": str(exc)})
                return
            json_response(self, 200, result)
            return

        if path == "/mcp/config/delete":
            try:
                client = mcp_config_client_from_payload(payload)
                result = delete_mcp_config_for_client(
                    client,
                    desired_mcp_url(self.server.public_url, self.server.mcp_path),
                    self.server.mcp_server is not None,
                )
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"ok": False, "error": str(exc)})
                return
            json_response(self, 200, result)
            return

        if path == "/mcp/config/open":
            try:
                client = mcp_config_client_from_payload(payload)
                result = open_mcp_config_for_client(client)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"ok": False, "error": str(exc)})
                return
            status = 200 if result.get("ok") else 500
            json_response(self, status, result)
            return

        if path == "/figma/query-selection":
            request_id = str(uuid.uuid4())
            job_payload = {"type": "QUERY_SELECTION", "requestId": request_id}
            target = parse_target(payload, job_payload)
            job = RelayJob(
                request_id=request_id,
                job=job_payload,
                asset_paths={},
                target_session_id=target["sessionId"],
                target_file_key=target["fileKey"],
            )
            self.server.state.add_job(job)
            json_response(self, 200, {
                "ok": True,
                "requestId": request_id,
                "statusUrl": f"{self.server.public_url}/jobs/{request_id}/result",
            })
            return

        if path == "/figma/query-plugin-status":
            request_id = str(uuid.uuid4())
            job_payload = {"type": "QUERY_PLUGIN_STATUS", "requestId": request_id}
            target = parse_target(payload, job_payload)
            job = RelayJob(
                request_id=request_id,
                job=job_payload,
                asset_paths={},
                target_session_id=target["sessionId"],
                target_file_key=target["fileKey"],
            )
            self.server.state.add_job(job)
            json_response(self, 200, {
                "ok": True,
                "requestId": request_id,
                "statusUrl": f"{self.server.public_url}/jobs/{request_id}/result",
            })
            return

        if path == "/figma/query-node-children":
            request_id = str(uuid.uuid4())
            node_id = str(payload.get("nodeId") or "")
            if not node_id:
                json_response(self, 400, {"error": "missing nodeId"})
                return
            job_payload = {"type": "QUERY_NODE_CHILDREN", "requestId": request_id, "nodeId": node_id}
            target = parse_target(payload, job_payload)
            job = RelayJob(
                request_id=request_id,
                job=job_payload,
                asset_paths={},
                target_session_id=target["sessionId"],
                target_file_key=target["fileKey"],
            )
            self.server.state.add_job(job)
            json_response(self, 200, {
                "ok": True,
                "requestId": request_id,
                "statusUrl": f"{self.server.public_url}/jobs/{request_id}/result",
            })
            return

        if path == "/figma/query-components":
            request_id = str(uuid.uuid4())
            library_node_ids = payload.get("libraryNodeIds") or ["62:115", "2896:32"]
            job_payload = {"type": "COLLECT_COMPONENTS", "requestId": request_id, "libraryNodeIds": library_node_ids}
            target = parse_target(payload, job_payload)
            job = RelayJob(
                request_id=request_id,
                job=job_payload,
                asset_paths={},
                target_session_id=target["sessionId"],
                target_file_key=target["fileKey"],
            )
            self.server.state.add_job(job)
            json_response(self, 200, {
                "ok": True,
                "requestId": request_id,
                "statusUrl": f"{self.server.public_url}/jobs/{request_id}/result",
            })
            return

        if path == "/figma/resize-node":
            request_id = str(uuid.uuid4())
            node_id = str(payload.get("nodeId") or "")
            width = payload.get("width")
            height = payload.get("height")
            if not node_id:
                json_response(self, 400, {"error": "missing nodeId"})
                return
            if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
                json_response(self, 400, {"error": "width and height must be numbers"})
                return
            if width <= 0 or height <= 0:
                json_response(self, 400, {"error": "width and height must be positive"})
                return
            job_payload = {
                "type": "RESIZE_NODE",
                "requestId": request_id,
                "nodeId": node_id,
                "width": float(width),
                "height": float(height),
            }
            job = RelayJob(request_id=request_id, job=job_payload, asset_paths={})
            self.server.state.add_job(job)
            json_response(self, 200, {
                "ok": True,
                "requestId": request_id,
                "statusUrl": f"{self.server.public_url}/jobs/{request_id}/result",
            })
            return

        if path == "/figma/delete-node":
            request_id = str(uuid.uuid4())
            node_id = str(payload.get("nodeId") or "")
            if not node_id:
                json_response(self, 400, {"error": "missing nodeId"})
                return
            job_payload = {
                "type": "DELETE_NODE_BY_ID",
                "requestId": request_id,
                "nodeId": node_id,
            }
            job = RelayJob(request_id=request_id, job=job_payload, asset_paths={})
            self.server.state.add_job(job)
            json_response(self, 200, {
                "ok": True,
                "requestId": request_id,
                "statusUrl": f"{self.server.public_url}/jobs/{request_id}/result",
            })
            return

        if path == "/open-plugin-folder":
            result = open_plugin_folder()
            status = 200 if result.get("ok") else 500
            json_response(self, status, result)
            return

        if path == "/crop-jiugong":
            result = handle_crop_jiugong(payload)
            status = 200 if result.get("ok") else 400
            json_response(self, status, result)
            return

        if path == "/prefab-to-figma/import":
            result = self.start_prefab_to_figma_import(payload)
            status = 200 if result.get("ok") else 400
            json_response(self, status, result)
            return

        json_response(self, 404, {"error": f"unknown endpoint: {path}"})

    def handle_mcp_post(self, payload: Any) -> None:
        """Dispatch a Streamable HTTP JSON-RPC message to the mounted MCP server."""
        if self.server.mcp_server is None:
            json_response(self, 404, {"error": "MCP server is not mounted on this relay"})
            return
        if not self.is_allowed_mcp_origin():
            json_response(self, 403, {"error": "forbidden MCP Origin"})
            return
        self.server.state.record_mcp_request(
            payload,
            self.client_address,
            self.headers.get("User-Agent", ""),
        )
        if isinstance(payload, list):
            responses = [
                response
                for item in payload
                if isinstance(item, dict)
                for response in [self.server.mcp_server.handle(item)]
                if response is not None
            ]
            if not responses:
                empty_response(self, 202)
                return
            json_response(self, 200, responses)
            return
        if not isinstance(payload, dict):
            json_response(self, 400, {"error": "MCP JSON-RPC body must be object or array"})
            return
        response = self.server.mcp_server.handle(payload)
        if response is None:
            empty_response(self, 202)
            return
        json_response(self, 200, response)

    def is_allowed_mcp_origin(self) -> bool:
        """Allow local/no-origin MCP clients and reject browser DNS-rebinding origins."""
        origin = self.headers.get("Origin", "").strip()
        if not origin or origin == "null":
            return True
        parsed = urlparse(origin)
        return parsed.hostname in ("localhost", "127.0.0.1", "::1")

    def read_json_body(self) -> Optional[Dict[str, Any]]:
        """读取并解析 JSON body。"""
        payload = self.read_any_json_body()
        if payload is None:
            return None
        if not isinstance(payload, dict):
            json_response(self, 400, {"error": "json body must be object"})
            return None
        return payload

    def read_any_json_body(self) -> Optional[Any]:
        """读取并解析任意 JSON body。"""
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8-sig"))
        except json.JSONDecodeError as exc:
            json_response(self, 400, {"error": f"invalid json: {exc}"})
            return None
        return payload

    def start_prefab_to_figma_import(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """启动从 Unity Prefab 到 Figma 的无大模型后台导入流程。"""
        try:
            unity_project_root = resolve_legacy_unity_project(payload)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        payload["unityProjectPath"] = str(unity_project_root)
        prefab_paths = normalize_prefab_import_paths(payload.get("prefabPaths"))
        if not prefab_paths:
            return {"ok": False, "error": "missing prefabPaths"}
        invalid_paths = [
            path for path in prefab_paths if not is_valid_project_prefab_path(path, unity_project_root)
        ]
        if invalid_paths:
            return {"ok": False, "error": "invalid prefab path", "invalidPaths": invalid_paths}
        if not (payload.get("figmaUrl") or payload.get("fileKey")):
            return {"ok": False, "error": "missing figmaUrl or fileKey"}

        task_id = uuid.uuid4().hex
        task = PrefabImportTask(
            task_id=task_id,
            payload=payload,
            status="queued",
            stage="queued",
            total=len(prefab_paths),
            logs=["已创建 Prefab 导入任务。"],
        )
        self.server.state.add_prefab_import_task(task)
        thread = threading.Thread(
            target=run_prefab_to_figma_import_task,
            args=(self.server.state, task_id, self.server.public_url),
            name=f"prefab-to-figma-{task_id[:8]}",
            daemon=True,
        )
        thread.start()
        return {
            "ok": True,
            "taskId": task_id,
            "statusUrl": f"{self.server.public_url}/prefab-to-figma/import/{task_id}/status",
            "prefabCount": len(prefab_paths),
        }


class FigmaMcpRelayServer(ThreadingHTTPServer):
    """带共享状态的 HTTPServer。"""

    def __init__(
        self,
        address: tuple[str, int],
        state: RelayState,
        public_url: str,
        verbose: bool,
        mcp_server: Optional[Any] = None,
        mcp_path: str = "/mcp",
    ) -> None:
        super().__init__(address, FigmaMcpRelayHandler)
        self.state = state
        self.public_url = public_url
        self.verbose = verbose
        self.mcp_server = mcp_server
        self.mcp_path = mcp_path


class FigmaMcpRelayServerV6(FigmaMcpRelayServer):
    """IPv6 loopback HTTPServer，用于兼容 localhost 解析到 ::1 的环境。"""

    address_family = socket.AF_INET6


def parse_asset_paths(raw: Any) -> Dict[str, Path]:
    """解析 client 传入的 assetId 到本地路径映射。"""
    result: Dict[str, Path] = {}
    if not isinstance(raw, dict):
        return result
    for key, value in raw.items():
        if value:
            result[str(key)] = Path(str(value)).resolve()
    return result


def rewrite_asset_urls(job_payload: Dict[str, Any], request_id: str, public_url: str) -> None:
    """把 job 中的 asset URL 改写为 MCP Relay 的本地资源地址。"""
    assets = job_payload.get("assets")
    if not isinstance(assets, list):
        return
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        asset_id = str(asset.get("id") or "")
        if asset_id:
            asset["url"] = f"{public_url}/assets/{request_id}/{asset_id}"


def create_server(
    host: str,
    port: int,
    state: RelayState,
    public_url: str,
    verbose: bool,
    mcp_server: Optional[Any] = None,
    mcp_path: str = "/mcp",
) -> FigmaMcpRelayServer:
    """按 host 类型创建 IPv4 或 IPv6 MCP Relay 服务。"""
    server_type = FigmaMcpRelayServerV6 if ":" in host else FigmaMcpRelayServer
    return server_type((host, port), state, public_url, verbose, mcp_server=mcp_server, mcp_path=mcp_path)


def create_servers(args: argparse.Namespace) -> List[FigmaMcpRelayServer]:
    """创建 MCP Relay 服务；默认同时监听 IPv4 与 IPv6 loopback。"""
    state = RelayState()
    public_url = str(getattr(args, "public_url", "") or "").rstrip("/") or f"http://{args.public_host}:{args.port}"
    hosts = [args.bind_host]
    if args.bind_ipv6 and args.bind_host != DEFAULT_BIND_HOST_IPV6:
        hosts.append(DEFAULT_BIND_HOST_IPV6)

    servers: List[FigmaMcpRelayServer] = []
    errors: List[str] = []
    for host in hosts:
        try:
            servers.append(create_server(host, args.port, state, public_url, args.verbose))
        except OSError as exc:
            errors.append(f"{host}:{args.port} {exc}")
    if not servers:
        raise RuntimeError("无法启动任何 MCP Relay 监听地址：" + "; ".join(errors))
    if errors:
        print(json.dumps({"status": "partial-listen", "warnings": errors}, ensure_ascii=False))
    return servers


def handle_crop_jiugong(payload: Dict[str, Any]) -> Dict[str, Any]:
    """转发九宫切图请求，具体图片处理由独立模块负责。"""
    return crop_jiugong_images(payload)


def normalize_prefab_import_paths(raw: Any) -> List[str]:
    """把 UI 或 Unity 网关返回的 Prefab 路径去重并规范为列表。"""
    items = raw if isinstance(raw, list) else ([raw] if raw else [])
    result: List[str] = []
    seen: set[str] = set()
    for item in items:
        path = str(item or "").strip().replace("\\", "/")
        if not path or path.startswith("/") or re.match(r"^[A-Za-z]:/", path):
            continue
        segments = path.split("/")
        if any(segment in {"", ".", ".."} for segment in segments):
            continue
        if path.startswith("Assets/"):
            pass
        elif len(segments) >= 3 and segments[1].lower() == "assets":
            path = "Assets/" + "/".join(segments[2:])
        else:
            continue
        if not path or path in seen:
            continue
        seen.add(path)
        result.append(path)
    return result


def resolve_legacy_unity_project(payload: Dict[str, Any]) -> Path:
    """Resolve the Unity project from request context or the shared environment contract."""
    raw = str(
        payload.get("unityProjectPath")
        or payload.get("unityProjectRoot")
        or os.environ.get("FIGMA_UNITY_PROJECT")
        or ""
    ).strip()
    if not raw:
        raise ValueError(
            "Unity project is required: pass unityProjectPath/unityProjectRoot or set FIGMA_UNITY_PROJECT"
        )
    root = Path(raw).expanduser().resolve()
    missing = [name for name in ("Assets", "ProjectSettings") if not (root / name).is_dir()]
    if missing:
        raise ValueError(f"Invalid Unity project {root}: missing {', '.join(missing)}")
    return root


def is_valid_project_prefab_path(path: str, unity_project_root: Path) -> bool:
    """确认 Prefab 路径在仓库内且文件存在。"""
    if not path.lower().endswith(".prefab"):
        return False
    candidate = (unity_project_root / path).resolve()
    try:
        candidate.relative_to((unity_project_root / "Assets").resolve())
    except ValueError:
        return False
    return candidate.exists() and candidate.is_file()


def normalize_canvas_by_prefab_path(raw: Any) -> Dict[str, str]:
    """Normalize prefab path to canvas-size mapping from the plugin UI."""
    if not isinstance(raw, dict):
        return {}
    result: Dict[str, str] = {}
    for key, value in raw.items():
        paths = normalize_prefab_import_paths(key)
        canvas = str(value or "").strip()
        if paths and canvas:
            result[paths[0]] = canvas
    return result


def normalize_nested_prefab_component_mode(raw: Any) -> str:
    """Normalize nested Prefab component creation mode from the plugin UI."""
    value = str(raw or "").strip()
    if value in ("commonOnly", "none"):
        return value
    return "all"


def serialize_prefab_import_task(task: PrefabImportTask) -> Dict[str, Any]:
    """把后台任务转换成 UI 可轮询的 JSON。"""
    return {
        "ok": task.status not in ("error",),
        "taskId": task.task_id,
        "status": task.status,
        "stage": task.stage,
        "currentIndex": task.current_index,
        "total": task.total,
        "percent": task.percent,
        "logs": task.logs,
        "errors": task.errors,
        "result": task.result,
        "createdAt": task.created_at,
        "updatedAt": task.updated_at,
    }


def run_prefab_to_figma_import_task(state: RelayState, task_id: str, relay_url: str) -> None:
    """后台执行无大模型 Prefab 导入流水线。"""
    task = state.get_prefab_import_task(task_id)
    if not task:
        return
    payload = task.payload
    unity_project_root = resolve_legacy_unity_project(payload)
    prefab_paths = normalize_prefab_import_paths(payload.get("prefabPaths"))
    canvas = str(payload.get("canvas") or "auto").strip() or "auto"
    canvas_by_prefab_path = normalize_canvas_by_prefab_path(payload.get("canvasByPrefabPath"))
    component_mode = "component" if payload.get("componentMode") != "frame" else "frame"
    nested_prefab_component_mode = normalize_nested_prefab_component_mode(payload.get("nestedPrefabComponentMode"))
    figma_url = str(payload.get("figmaUrl") or "").strip()
    file_key = str(payload.get("fileKey") or "").strip()
    target_node_id = str(payload.get("targetNodeId") or "").strip()
    output_root = PREFAB_TO_FIGMA_TMP_DIR / time.strftime("%Y%m%d-%H%M%S") / task_id[:8]
    results: List[Dict[str, Any]] = []
    failed_results: List[Dict[str, Any]] = []

    try:
        state.update_prefab_import_task(
            task_id,
            status="running",
            stage="prepare",
            total=len(prefab_paths),
            percent=1,
            log=f"输出目录：{output_root}",
        )
        output_root.mkdir(parents=True, exist_ok=True)
        for index, prefab_path in enumerate(prefab_paths, start=1):
            prefab_name = Path(prefab_path).stem
            prefab_canvas = canvas_by_prefab_path.get(prefab_path) or canvas
            out_dir = output_root / f"{index:02d}_{sanitize_path_name(prefab_name)}"
            state.update_prefab_import_task(
                task_id,
                log=f"[{index}/{len(prefab_paths)}] Canvas：{prefab_canvas}（Prefab={prefab_path}）",
            )
            try:
                result_item = run_single_prefab_to_figma_import(
                    state=state,
                    task_id=task_id,
                    relay_url=relay_url,
                    unity_project_root=unity_project_root,
                    prefab_path=prefab_path,
                    prefab_canvas=prefab_canvas,
                    out_dir=out_dir,
                    index=index,
                    total=len(prefab_paths),
                    component_mode=component_mode,
                    nested_prefab_component_mode=nested_prefab_component_mode,
                    figma_url=figma_url,
                    file_key=file_key,
                    target_node_id=target_node_id,
                )
                results.append(result_item)
            except Exception as item_exc:  # noqa: BLE001
                failed_item = {
                    "prefabPath": prefab_path,
                    "outDir": str(out_dir),
                    "canvas": prefab_canvas,
                    "error": str(item_exc),
                }
                failed_results.append(failed_item)
                state.update_prefab_import_task(
                    task_id,
                    status="running",
                    stage=f"failed:{prefab_name}",
                    current_index=index,
                    percent=calc_prefab_import_percent(index, len(prefab_paths), 0),
                    error=f"{prefab_path}: {item_exc}",
                    log=f"[{index}/{len(prefab_paths)}] Prefab import failed: {prefab_name}: {item_exc}",
                )
                continue
        final_ok = not failed_results
        state.update_prefab_import_task(
            task_id,
            status="completed" if final_ok else "error",
            stage="completed" if final_ok else "completed_with_errors",
            percent=100,
            result={
                "ok": final_ok,
                "outputRoot": str(output_root),
                "prefabCount": len(prefab_paths),
                "succeededCount": len(results),
                "failedCount": len(failed_results),
                "items": results,
                "failedItems": failed_results,
            },
            log="全部 Prefab 导入完成。" if final_ok else f"Prefab 导入完成，失败 {len(failed_results)} / {len(prefab_paths)}。",
        )
    except Exception as exc:  # noqa: BLE001
        state.update_prefab_import_task(
            task_id,
            status="error",
            stage="error",
            error=str(exc),
            result={
                "ok": False,
                "outputRoot": str(output_root),
                "prefabCount": len(prefab_paths),
                "succeededCount": len(results),
                "failedCount": len(failed_results),
                "items": results,
                "failedItems": failed_results,
            },
            log=f"导入失败：{exc}",
        )


def run_single_prefab_to_figma_import(
    *,
    state: RelayState,
    task_id: str,
    relay_url: str,
    unity_project_root: Path,
    prefab_path: str,
    prefab_canvas: str,
    out_dir: Path,
    index: int,
    total: int,
    component_mode: str,
    nested_prefab_component_mode: str,
    figma_url: str,
    file_key: str,
    target_node_id: str,
) -> Dict[str, Any]:
    """Run export, plan, write, and readback verification for one Prefab."""
    prefab_name = Path(prefab_path).stem
    out_dir.mkdir(parents=True, exist_ok=True)
    state.update_prefab_import_task(
        task_id,
        stage=f"export:{prefab_name}",
        current_index=index,
        percent=calc_prefab_import_percent(index - 1, total, 5),
        log=f"[{index}/{total}] 解析 Prefab：{prefab_path}",
    )

    run_checked_command(state, task_id, [
        sys.executable,
        str(PREFAB_TO_FIGMA_SCRIPT_DIR / "prefab_to_figma.py"),
        "--project-root",
        str(unity_project_root),
        "--prefab",
        prefab_path,
        "--canvas",
        prefab_canvas,
        "--out",
        str(out_dir),
    ], unity_project_root)

    package_path = out_dir / "prefab-to-figma.json"
    export_audit_path = out_dir / "prefab_export_audit_report.json"
    run_checked_command(state, task_id, [
        sys.executable,
        str(PREFAB_TO_FIGMA_SCRIPT_DIR / "verify_export_package.py"),
        "--package",
        str(package_path),
        "--output-report",
        str(export_audit_path),
    ], PLUGIN_ROOT)
    export_audit = read_json_file(export_audit_path)
    ensure_audit_pass(export_audit, "Prefab 导出审核")

    unity_truth_path = out_dir / "unity_runtime_truth.json"
    unity_truth_compare_path = out_dir / "unity_truth_compare_report.json"
    state.update_prefab_import_task(
        task_id,
        stage=f"unity-truth:{prefab_name}",
        percent=calc_prefab_import_percent(index - 1, total, 20),
        log=f"[{index}/{total}] Dump Unity runtime layout truth.",
    )
    # Unity 运行时布局真值比对是“非阻塞质检”，不是导入门禁。
    # 它依赖 Unity 网关在线，并把静态导出与运行时 layout pass 对齐，
    # 因此网关未就绪、超时或合理的布局差异都不应让导入失败。
    # 这里任何失败都降级为告警并继续；导入是否成功由 Figma 写入读回验证决定。
    unity_truth_compare: Dict[str, Any]
    try:
        run_checked_command(state, task_id, [
            sys.executable,
            str(PREFAB_TO_FIGMA_SCRIPT_DIR / "dump_unity_prefab_truth.py"),
            "--project-root",
            str(unity_project_root),
            "--prefab",
            prefab_path,
            "--canvas",
            prefab_canvas,
            "--out",
            str(out_dir),
            "--timeout",
            "180",
        ], unity_project_root)
        state.update_prefab_import_task(
            task_id,
            stage=f"unity-compare:{prefab_name}",
            percent=calc_prefab_import_percent(index - 1, total, 28),
            log=f"[{index}/{total}] Compare prefab JSON with Unity runtime layout truth.",
        )
        run_checked_command(state, task_id, [
            sys.executable,
            str(PREFAB_TO_FIGMA_SCRIPT_DIR / "compare_unity_truth.py"),
            "--package",
            str(package_path),
            "--truth",
            str(unity_truth_path),
            "--output-report",
            str(unity_truth_compare_path),
        ], PLUGIN_ROOT)
        unity_truth_compare = read_json_file(unity_truth_compare_path)
    except Exception as truth_exc:  # noqa: BLE001 - 真值比对降级为非阻塞告警
        # compare_unity_truth 在 allPass=false 时返回码非零，但已写好报告文件，
        # 优先回读以保留真实 blocking 概要；读不到再用兜底告警。
        unity_truth_compare = _read_optional_json(unity_truth_compare_path) or {
            "allPass": False,
            "blockingErrors": [],
            "warnings": [{"code": "unityTruthCompareSkipped", "message": str(truth_exc)}],
            "summary": {},
            "artifacts": {},
        }
        state.update_prefab_import_task(
            task_id,
            log=f"[{index}/{total}] Unity 真值比对未通过或步骤失败，已降级为告警并继续：{trim_command_output(str(truth_exc))}",
        )
    if unity_truth_compare.get("allPass") is not True:
        state.update_prefab_import_task(
            task_id,
            log=f"[{index}/{total}] Unity 真值比对告警（非阻塞）：blocking={len(unity_truth_compare.get('blockingErrors') or [])}, warnings={len(unity_truth_compare.get('warnings') or [])}",
        )

    state.update_prefab_import_task(
        task_id,
        stage=f"plan:{prefab_name}",
        percent=calc_prefab_import_percent(index - 1, total, 35),
        log=f"[{index}/{total}] 生成 Figma 写入计划。",
    )
    build_plan_cmd = [
        sys.executable,
        str(PREFAB_TO_FIGMA_SCRIPT_DIR / "build_figma_write_plan.py"),
        "--package",
        str(package_path),
        "--out",
        str(out_dir),
        "--component-mode",
        component_mode,
        "--nested-prefab-component-mode",
        nested_prefab_component_mode,
    ]
    if figma_url:
        build_plan_cmd.extend(["--figma-url", figma_url])
    if file_key:
        build_plan_cmd.extend(["--file-key", file_key])
    if target_node_id:
        build_plan_cmd.extend(["--target-node-id", target_node_id])
    run_checked_command(state, task_id, build_plan_cmd, PLUGIN_ROOT)
    plan_audit_path = out_dir / "figma_write_plan_audit_report.json"
    plan_audit = read_json_file(plan_audit_path)
    ensure_audit_pass(plan_audit, "Figma 写入计划审核")

    state.update_prefab_import_task(
        task_id,
        stage=f"write:{prefab_name}",
        percent=calc_prefab_import_percent(index - 1, total, 60),
        log=f"[{index}/{total}] 提交 Figma 写入任务，等待插件执行。",
    )
    relay_result_path = out_dir / "prefab_to_figma_mcp_result.json"
    run_checked_command(state, task_id, [
        sys.executable,
        str(PREFAB_TO_FIGMA_SCRIPT_DIR / "prefab_to_figma_mcp_client.py"),
        "--package",
        str(package_path),
        "--write-plan",
        str(out_dir / "figma_write_plan.json"),
        "--result",
        str(relay_result_path),
        "--relay-url",
        relay_url,
        "--component-mode",
        component_mode,
        "--timeout",
        "300",
    ], PLUGIN_ROOT)

    verify_report = read_json_file(out_dir / "figma_write_verify_report.json")
    ensure_audit_pass(verify_report, "Figma 写入读回验证")
    result_item = {
        "prefabPath": prefab_path,
        "outDir": str(out_dir),
        "exportAudit": summarize_audit(export_audit),
        "unityTruthCompare": summarize_audit(unity_truth_compare),
        "planAudit": summarize_audit(plan_audit),
        "verifyReport": summarize_audit(verify_report),
        "relayResultPath": str(relay_result_path),
    }
    state.update_prefab_import_task(
        task_id,
        stage=f"done:{prefab_name}",
        percent=calc_prefab_import_percent(index, total, 0),
        log=f"[{index}/{total}] 导入完成：{prefab_name}",
    )
    return result_item


def sanitize_path_name(value: str) -> str:
    """生成适合临时目录的名称。"""
    text = re.sub(r"[^0-9A-Za-z_.-]+", "_", value.strip())
    return text or "Prefab"


def calc_prefab_import_percent(index: int, total: int, step: int) -> int:
    """计算多 Prefab 导入进度。"""
    if total <= 0:
        return 0
    base = int((index / total) * 100)
    span = max(1, int(100 / total))
    return min(99, base + int(span * step / 100))


def run_checked_command(state: RelayState, task_id: str, command: List[str], cwd: Path) -> None:
    """执行流水线命令，失败时抛出包含输出的错误。"""
    process = subprocess.run(
        command,
        cwd=str(cwd),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    output = (process.stdout or "").strip()
    if output:
        state.update_prefab_import_task(task_id, log=trim_command_output(output))
    if process.returncode != 0:
        raise RuntimeError(f"命令失败({process.returncode})：{' '.join(command)}\n{trim_command_output(output)}")


def trim_command_output(output: str) -> str:
    """限制写入 UI 状态的命令输出长度。"""
    if len(output) <= 3000:
        return output
    return output[-3000:]


def read_json_file(path: Path) -> Dict[str, Any]:
    """读取 JSON 文件，兼容 UTF-8 BOM。"""
    if not path.exists():
        raise FileNotFoundError(str(path))
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"JSON root must be object: {path}")
    return data


def _read_optional_json(path: Path) -> Optional[Dict[str, Any]]:
    """尽力读取 JSON 报告，读不到或格式异常时返回 None（用于非阻塞降级）。"""
    try:
        return read_json_file(path)
    except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError):
        return None


def ensure_audit_pass(report: Dict[str, Any], label: str) -> None:
    """统一审核结构门禁。"""
    blocking = report.get("blockingErrors") or []
    if report.get("allPass") is not True or blocking:
        raise RuntimeError(f"{label}未通过：{json.dumps(blocking, ensure_ascii=False)}")


def summarize_audit(report: Dict[str, Any]) -> Dict[str, Any]:
    """压缩审核报告，避免状态接口返回过大。"""
    return {
        "allPass": report.get("allPass") is True,
        "blockingErrorCount": len(report.get("blockingErrors") or []),
        "warningCount": len(report.get("warnings") or []),
        "summary": report.get("summary") or {},
        "artifacts": report.get("artifacts") or {},
    }


def parse_args() -> argparse.Namespace:
    """解析启动参数。"""
    parser = argparse.ArgumentParser(description="Figma MCP Relay server")
    parser.add_argument("--bind-host", default=DEFAULT_BIND_HOST, help="实际监听地址")
    parser.add_argument("--no-ipv6", dest="bind_ipv6", action="store_false", help="不额外监听 IPv6 ::1")
    parser.add_argument("--public-host", default=DEFAULT_PUBLIC_HOST, help="暴露给插件和 client 的主机名")
    parser.add_argument("--public-url", default="", help="Override public relay URL used in generated job/status URLs")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口")
    parser.add_argument("--verbose", action="store_true", help="输出访问日志")
    parser.set_defaults(bind_ipv6=True)
    return parser.parse_args()


def main() -> int:
    """启动 MCP Relay 并阻塞等待请求。"""
    args = parse_args()
    operation = LOGGER.start_operation("python.legacy-relay.main", data={"port": args.port})
    servers: List[FigmaMcpRelayServer] = []
    try:
        servers = create_servers(args)
        primary = servers[0]
        operation.step("listen", "Legacy Relay listening", {"bindCount": len(servers)})
        print(json.dumps({
            "status": "listening",
            "url": primary.public_url,
            "bind": [str(server.server_address) for server in servers],
            "message": "Figma MCP Relay 已启动，请保持窗口打开。",
        }, ensure_ascii=False, indent=2))
        threads: List[threading.Thread] = []
        for index, server in enumerate(servers[1:], start=1):
            thread = threading.Thread(target=server.serve_forever, name=f"figma-mcp-relay-{index}", daemon=True)
            thread.start()
            threads.append(thread)
        try:
            primary.serve_forever()
        except KeyboardInterrupt:
            print(json.dumps({"status": "stopped"}, ensure_ascii=False))
            operation.cancel("Legacy Relay interrupted")
            return 130
        operation.succeed("Legacy Relay stopped")
        return 0
    except BaseException as exc:
        operation.fail(exc, "Legacy Relay failed")
        raise
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
