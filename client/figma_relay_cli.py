#!/usr/bin/env python3
"""Python bridge for the project Figma CLI.

Business requests are sent by ``dist/cli.js`` over the Relay WebSocket. This
module only adapts the existing skill function shapes; it does not implement
MCP or business HTTP transport.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
import tempfile
import sys
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse


RELAY_ROOT = Path(__file__).resolve().parent.parent
CLI_PATH = RELAY_ROOT / "dist" / "cli.js"


class RelayCliError(RuntimeError):
    def __init__(self, message: str, code: str = "CLI_ERROR"):
        super().__init__(message)
        self.code = code


def _cli_url(relay_url: str) -> str:
    value = (relay_url or "http://127.0.0.1:32130").rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "ws"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/", "/relay"}:
        raise RelayCliError("Relay CLI requires a local Relay URL")
    scheme = "wss" if parsed.scheme in {"https", "wss"} else "ws"
    return f"{scheme}://{parsed.hostname if parsed.hostname != '::1' else '[::1]'}:{parsed.port or 32130}/relay"


def _run(command: str, *, relay_url: str = "", timeout: float = 300.0, session_id: str = "", file_key: str = "", payload: Optional[Dict[str, Any]] = None, job_type: str = "", request_id: str = "", task_id: str = "", detach: bool = False, asset_paths: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    args = ["node", str(CLI_PATH), command, "--url", _cli_url(relay_url), "--timeout", str(max(0.1, min(timeout, 120.0)))]
    if session_id:
        args += ["--session-id", session_id]
    if file_key:
        args += ["--file-key", file_key]
    if job_type:
        args += ["--job-type", job_type]
    if request_id:
        args += ["--request-id", request_id]
    if task_id:
        args += ["--task-id", task_id]
    if detach:
        args += ["--detach"]
    env = os.environ.copy()
    env.setdefault("FIGMA_RELAY_TOKEN_FILE", str(RELAY_ROOT / ".local" / "admin-token.txt"))
    with tempfile.TemporaryDirectory(prefix="figma-relay-cli-") as directory:
        if asset_paths:
            assets_path = Path(directory) / "assets.json"
            assets_path.write_text(json.dumps(asset_paths, ensure_ascii=False), encoding="utf-8")
            args += ["--assets-file", str(assets_path)]
        if payload is not None:
            payload_path = Path(directory) / "payload.json"
            payload_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            args += ["--payload-file", str(payload_path)]
        try:
            completed = subprocess.run(args, cwd=str(RELAY_ROOT), capture_output=True, text=True, encoding="utf-8", timeout=max(10.0, min(timeout, 120.0) + 10.0), env=env, check=False)
        except subprocess.TimeoutExpired:
            raise RelayCliError(f"CLI process timed out; query task {request_id or task_id} before retrying", "PROCESS_TIMEOUT") from None
        except OSError as error:
            raise RelayCliError(f"Unable to execute project CLI: {error.strerror}", "PROCESS_FAILED") from None
    # Forward the CLI's already structured/redacted diagnostics, never its command arguments.
    if completed.stderr:
        sys.stderr.write(completed.stderr)
    try:
        result = json.loads(completed.stdout.strip() or "{}")
    except json.JSONDecodeError as exc:
        raise RelayCliError("Relay CLI returned invalid JSON") from exc
    if completed.returncode != 0 or not isinstance(result, dict) or result.get("ok") is not True:
        error = result.get("error") if isinstance(result, dict) else None
        raise RelayCliError(str(error or "Relay CLI request failed"), str(error.get("code", "CLI_ERROR")) if isinstance(error, dict) else "CLI_ERROR")
    return result.get("result") if isinstance(result.get("result"), dict) else {}


def health(relay_url: str = "", **_: Any) -> Dict[str, Any]:
    result = _run("sessions", relay_url=relay_url, timeout=15)
    sessions = result.get("sessions") if isinstance(result.get("sessions"), list) else []
    return {"ok": True, "status": "ok", "plugin": {"connected": bool(sessions), "authenticated": bool(sessions), "sessions": sessions}}


def unity_command(project_path: str, action: str, body: Dict[str, Any], *, project_id: str = "", relay_url: str = "", request_id: str = "", timeout: float = 120) -> Dict[str, Any]:
    """Resolve an explicit registered project, then submit once; never replay a write."""
    if not project_path:
        raise RelayCliError("An explicit Unity project path is required")
    target = os.path.normcase(os.path.realpath(project_path))
    registry = _run("control", relay_url=relay_url, job_type="unity.projects.list", payload={}, timeout=15)
    projects = registry.get("projects", [])
    matches = [item for item in projects if isinstance(item, dict) and item.get("valid") is True
               and item.get("path") and os.path.normcase(os.path.realpath(item["path"])) == target
               and (not project_id or item.get("id") == project_id)]
    if len(matches) != 1 or not matches[0].get("id"):
        raise RelayCliError("Explicit Unity project must uniquely match a valid registered project")
    selected_id = matches[0]["id"]
    stable_id = request_id or str(uuid.uuid4())
    wait_seconds = max(0.1, min(timeout, 115.0))
    try:
        result = _run("control", relay_url=relay_url, job_type="unity.command", request_id=stable_id,
                      payload={"id": selected_id, "requestId": stable_id, "action": action, "body": body,
                               "timeoutMs": int(wait_seconds * 1000)}, timeout=wait_seconds + 5)
        if not isinstance(result.get("result"), dict):
            raise RelayCliError("Unity command returned no object result")
        return result["result"]
    except RelayCliError as error:
        raise RelayCliError(f"{error}; projectId={selected_id}; requestId={stable_id}; query the original request before retrying", error.code) from error


def query_selection(relay_url: str = "", session_id: str = "", file_key: str = "", timeout: float = 15, **_: Any) -> Dict[str, Any]:
    return submit_job({"type": "QUERY_SELECTION", "sessionId": session_id, "fileKey": file_key}, relay_url=relay_url, timeout=timeout)


def query_node_children(node_id: str, relay_url: str = "", session_id: str = "", file_key: str = "", timeout: float = 15, **_: Any) -> Dict[str, Any]:
    return submit_job({"type": "QUERY_NODE_CHILDREN", "nodeId": node_id, "sessionId": session_id, "fileKey": file_key}, relay_url=relay_url, timeout=timeout)


def query_components(library_node_ids: Optional[list[str]] = None, *, relay_url: str = "", timeout: float = 20, session_id: str = "", file_key: str = "") -> Dict[str, Any]:
    payload = _run("figma-components", relay_url=relay_url, timeout=timeout, session_id=session_id, file_key=file_key, payload={"libraryNodeIds": library_node_ids or ["62:115", "2896:32"]})
    return payload["result"] if isinstance(payload.get("result"), dict) else payload


def submit_grid_component_job(relay_url: str, root_node_id: str, component_name: str, slots: list[Any], property_defs: dict[str, Any], boolean_node_ids: Optional[list[Any]] = None, text_node_ids: Optional[list[Any]] = None, variant_node_id: Optional[str] = None, reference_slot_index: int = 0, timeout: float = 120) -> Dict[str, Any]:
    job: Dict[str, Any] = {"type": "CREATE_GRID_COMPONENT", "rootNodeId": root_node_id, "componentName": component_name, "slots": slots, "propertyDefs": property_defs, "referenceSlotIndex": reference_slot_index}
    for key, value in (("booleanNodeIds", boolean_node_ids), ("textNodeIds", text_node_ids), ("variantNodeId", variant_node_id)):
        if value:
            job[key] = value
    payload = submit_job(job, relay_url=relay_url, timeout=timeout)
    result = payload["result"] if isinstance(payload.get("result"), dict) else payload
    if payload.get("status") == "error" or result.get("status") == "error":
        raise RelayCliError(json.dumps(result.get("errors", payload.get("errors", ["unknown error"])), ensure_ascii=False))
    return result


def submit_job(job: Dict[str, Any], asset_paths: Optional[Dict[str, str]] = None, *, relay_url: str = "", request_id: str = "", wait: bool = True, timeout: float = 300, full_result: bool = False, debug_full_result: bool = False) -> Dict[str, Any]:
    body = dict(job)
    job_type = str(body.pop("type", "")).strip()
    if not job_type:
        raise RelayCliError("job.type is required")
    target = body.get("target") if isinstance(body.get("target"), dict) else {}
    session_id = str(body.get("sessionId") or target.get("sessionId") or "")
    file_key = str(body.get("fileKey") or target.get("fileKey") or "")
    task_id = request_id or str(uuid.uuid4())
    deadline = time.monotonic() + timeout
    status = _run("figma-command", relay_url=relay_url, session_id=session_id, file_key=file_key, timeout=min(timeout, 120), payload=body, job_type=job_type, request_id=task_id, detach=True, asset_paths=asset_paths)
    if not wait:
        return status
    while status.get("status") not in {"succeeded", "failed", "cancelled", "result_unknown"}:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RelayCliError(f"Task wait timed out; task {task_id} remains queryable")
        try:
            status = _run("task-wait", relay_url=relay_url, timeout=max(0.1, min(remaining, 120)), task_id=task_id)
        except RelayCliError as error:
            if error.code != "TIMEOUT":
                raise
    if status.get("status") == "result_unknown":
        raise RelayCliError(f"Result unknown for task {task_id}; do not resubmit the write")
    result = status.get("result")
    if not isinstance(result, dict):
        raise RelayCliError(f"Task {task_id} returned no result")
    return {"requestId": task_id, "result": result}
