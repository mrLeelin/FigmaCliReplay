#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Small MCP client for the local Figma MCP Relay companion.

CLI workflows can keep their file-oriented UX while all Figma control goes
through the local MCP endpoint exposed by the companion process.
"""

from __future__ import annotations

import json
import argparse
import base64
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


DEFAULT_RELAY_URL = "http://localhost:32130"
DEFAULT_MCP_URL = f"{DEFAULT_RELAY_URL}/mcp"
DEFAULT_MCP_HTTP_TIMEOUT = 300.0
PROJECT_ROOT = Path(__file__).resolve().parents[4]
MCP_SERVER_SCRIPT = (
    PROJECT_ROOT
    / ".figma"
    / "plugins"
    / "figma-mcp-relay"
    / "server"
    / "figma_mcp_companion.py"
)


class McpToolError(RuntimeError):
    """Raised when the MCP server returns a tool-level error."""


def _write_message(stream: Any, message: Dict[str, Any]) -> None:
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    stream.write(body)
    stream.flush()


def _read_message(stream: Any) -> Dict[str, Any]:
    headers: Dict[str, str] = {}
    while True:
        line = stream.readline()
        if line == b"":
            raise EOFError("MCP server closed stdout")
        if line in (b"\r\n", b"\n"):
            break
        key, _, value = line.decode("ascii", errors="ignore").partition(":")
        headers[key.strip().lower()] = value.strip()

    length = int(headers.get("content-length", "0"))
    if length <= 0:
        raise ValueError("MCP response missing Content-Length")
    return json.loads(stream.read(length).decode("utf-8"))


def _extract_tool_payload(result: Dict[str, Any]) -> Dict[str, Any]:
    if result.get("isError"):
        text = _extract_text(result)
        raise McpToolError(text)

    text = _extract_text(result)
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}
    if isinstance(payload, dict):
        return payload
    return {"value": payload}


def _extract_text(result: Dict[str, Any]) -> str:
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    parts = [
        str(item.get("text") or "")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text"
    ]
    return "\n".join(part for part in parts if part)


def _mcp_url_from_relay_url(relay_url: str) -> str:
    value = (relay_url or DEFAULT_RELAY_URL).strip().rstrip("/")
    if value.endswith("/mcp"):
        return value
    return f"{value}/mcp"


def _post_http_json(
    url: str,
    payload: Dict[str, Any],
    timeout: float = DEFAULT_MCP_HTTP_TIMEOUT,
    session_id: str = "",
) -> Tuple[Dict[str, Any], str]:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            next_session_id = response.headers.get("Mcp-Session-Id") or session_id
            raw = response.read().decode("utf-8-sig")
            if not raw:
                return {}, next_session_id
            payload = json.loads(raw)
            return payload if isinstance(payload, dict) else {}, next_session_id
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8-sig", errors="replace")
        try:
            error_payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            error_payload = {"error": raw}
        raise McpToolError(json.dumps({
            "httpStatus": exc.code,
            "url": url,
            "response": error_payload,
        }, ensure_ascii=False)) from exc
    except urllib.error.URLError as exc:
        raise McpToolError(
            f"Figma MCP Relay companion is not reachable at {url}. "
            "Start it with: powershell -ExecutionPolicy Bypass -File "
            ".figma/plugins/figma-mcp-relay/scripts/start_mcp_companion.ps1 -Mode mcp"
        ) from exc


class FigmaEditMcpHttpClient:
    """JSON-RPC client for the persistent local `/mcp` HTTP endpoint."""

    def __init__(self, mcp_url: str = DEFAULT_MCP_URL) -> None:
        self.mcp_url = (mcp_url or DEFAULT_MCP_URL).rstrip("/")
        self._next_id = 1
        self._session_id = ""

    def __enter__(self) -> "FigmaEditMcpHttpClient":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def start(self) -> None:
        self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "figma-mcp-relay-cli", "version": "0.1.0"},
            },
        )
        self.notify("notifications/initialized", {})

    def close(self) -> None:
        return

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        message, session_id = _post_http_json(
            self.mcp_url,
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}},
            session_id=self._session_id,
        )
        self._session_id = session_id or self._session_id
        if "error" in message:
            raise McpToolError(json.dumps(message["error"], ensure_ascii=False))
        result = message.get("result")
        return result if isinstance(result, dict) else {}

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        _, session_id = _post_http_json(
            self.mcp_url,
            {"jsonrpc": "2.0", "method": method, "params": params or {}},
            timeout=10.0,
            session_id=self._session_id,
        )
        self._session_id = session_id or self._session_id

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        return _extract_tool_payload(result)


class FigmaEditMcpStdioClient:
    """Short-lived JSON-RPC client for figma-mcp-relay stdio tools."""

    def __init__(self, relay_url: str = DEFAULT_RELAY_URL) -> None:
        self.relay_url = (relay_url or DEFAULT_RELAY_URL).rstrip("/")
        self.process: Optional[subprocess.Popen[bytes]] = None
        self._next_id = 1

    def __enter__(self) -> "FigmaEditMcpStdioClient":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def start(self) -> None:
        if self.process is not None:
            return
        if not MCP_SERVER_SCRIPT.exists():
            raise FileNotFoundError(f"Figma MCP Relay companion not found: {MCP_SERVER_SCRIPT}")

        startupinfo = None
        creationflags = 0
        if sys.platform.startswith("win"):
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

        self.process = subprocess.Popen(
            [sys.executable, str(MCP_SERVER_SCRIPT), "--relay-url", self.relay_url],
            cwd=str(PROJECT_ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            startupinfo=startupinfo,
            creationflags=creationflags,
            close_fds=not sys.platform.startswith("win"),
        )
        self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "figma-mcp-relay-cli", "version": "0.1.0"},
            },
        )
        self.notify("notifications/initialized", {})

    def close(self) -> None:
        process = self.process
        self.process = None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.terminate()
            process.wait(timeout=2)
        except Exception:
            process.kill()

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self.process is None or self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("MCP client is not started")
        request_id = self._next_id
        self._next_id += 1
        _write_message(
            self.process.stdin,
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}},
        )
        while True:
            message = _read_message(self.process.stdout)
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise McpToolError(json.dumps(message["error"], ensure_ascii=False))
            result = message.get("result")
            return result if isinstance(result, dict) else {}

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("MCP client is not started")
        _write_message(self.process.stdin, {"jsonrpc": "2.0", "method": method, "params": params or {}})

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        return _extract_tool_payload(result)


def call_tool(
    name: str,
    arguments: Optional[Dict[str, Any]] = None,
    relay_url: str = DEFAULT_RELAY_URL,
    *,
    mcp_url: str = "",
    stdio: bool = False,
) -> Dict[str, Any]:
    client_type = FigmaEditMcpStdioClient if stdio else FigmaEditMcpHttpClient
    client_arg = {"relay_url": relay_url} if stdio else {"mcp_url": mcp_url or _mcp_url_from_relay_url(relay_url)}
    with client_type(**client_arg) as client:
        return client.call_tool(name, arguments or {})


def health(relay_url: str = DEFAULT_RELAY_URL, *, mcp_url: str = "", stdio: bool = False) -> Dict[str, Any]:
    return call_tool("figma_health", {}, relay_url=relay_url, mcp_url=mcp_url, stdio=stdio)


def _target_args_from_job(job: Dict[str, Any]) -> Dict[str, Any]:
    target = job.get("target") if isinstance(job.get("target"), dict) else {}
    args: Dict[str, Any] = {}
    file_key = str(job.get("fileKey") or target.get("fileKey") or "")
    session_id = str(job.get("sessionId") or target.get("sessionId") or "")
    if file_key:
        args["fileKey"] = file_key
    if session_id:
        args["sessionId"] = session_id
    if target:
        args["target"] = target
    return args


def submit_job(
    job: Dict[str, Any],
    asset_paths: Optional[Dict[str, str]] = None,
    *,
    relay_url: str = DEFAULT_RELAY_URL,
    request_id: str = "",
    wait: bool = True,
    timeout: float = 60.0,
    full_result: bool = False,
    debug_full_result: bool = False,
    mcp_url: str = "",
    stdio: bool = False,
) -> Dict[str, Any]:
    tool_args = {
        "job": job,
        "assetPaths": asset_paths or {},
        "requestId": request_id or str(uuid.uuid4()),
        "wait": wait,
        "fullResult": full_result,
        "debugFullResult": debug_full_result,
        "timeout": timeout,
    }
    tool_args.update(_target_args_from_job(job))
    payload = call_tool(
        "figma_submit_job",
        tool_args,
        relay_url=relay_url,
        mcp_url=mcp_url,
        stdio=stdio,
    )
    if wait and isinstance(payload.get("result"), dict):
        return payload["result"]
    return payload


def query_selection(
    *,
    relay_url: str = DEFAULT_RELAY_URL,
    timeout: float = 15.0,
    file_key: str = "",
    session_id: str = "",
    mcp_url: str = "",
    stdio: bool = False,
) -> Dict[str, Any]:
    args: Dict[str, Any] = {"timeout": timeout}
    if file_key:
        args["fileKey"] = file_key
    if session_id:
        args["sessionId"] = session_id
    return call_tool("figma_query_selection", args, relay_url=relay_url, mcp_url=mcp_url, stdio=stdio)


def query_components(
    library_node_ids: Optional[list[str]] = None,
    *,
    relay_url: str = DEFAULT_RELAY_URL,
    timeout: float = 20.0,
    mcp_url: str = "",
    stdio: bool = False,
) -> Dict[str, Any]:
    args: Dict[str, Any] = {"timeout": timeout}
    args["libraryNodeIds"] = library_node_ids if library_node_ids is not None else ["62:115", "2896:32"]
    payload = call_tool("figma_query_components", args, relay_url=relay_url, mcp_url=mcp_url, stdio=stdio)
    result = payload.get("result")
    return result if isinstance(result, dict) else payload


def query_node_children(
    node_id: str,
    *,
    relay_url: str = DEFAULT_RELAY_URL,
    timeout: float = 15.0,
    file_key: str = "",
    session_id: str = "",
    mcp_url: str = "",
    stdio: bool = False,
) -> Dict[str, Any]:
    args: Dict[str, Any] = {"nodeId": node_id, "timeout": timeout}
    if file_key:
        args["fileKey"] = file_key
    if session_id:
        args["sessionId"] = session_id
    return call_tool(
        "figma_query_node_children",
        args,
        relay_url=relay_url,
        mcp_url=mcp_url,
        stdio=stdio,
    )


def submit_grid_component_job(
    relay_url: str,
    root_node_id: str,
    component_name: str,
    slots: list[Any],
    property_defs: dict[str, Any],
    boolean_node_ids: Optional[list[Any]] = None,
    text_node_ids: Optional[list[Any]] = None,
    variant_node_id: Optional[str] = None,
    reference_slot_index: int = 0,
    timeout: float = 120.0,
    mcp_url: str = "",
    stdio: bool = False,
) -> Dict[str, Any]:
    job: Dict[str, Any] = {
        "type": "CREATE_GRID_COMPONENT",
        "rootNodeId": root_node_id,
        "componentName": component_name,
        "slots": slots,
        "propertyDefs": property_defs,
        "referenceSlotIndex": reference_slot_index,
    }
    if boolean_node_ids:
        job["booleanNodeIds"] = boolean_node_ids
    if text_node_ids:
        job["textNodeIds"] = text_node_ids
    if variant_node_id:
        job["variantNodeId"] = variant_node_id

    result_payload = submit_job(
        job,
        {},
        relay_url=relay_url,
        wait=True,
        timeout=timeout,
        full_result=True,
        debug_full_result=True,
        mcp_url=mcp_url,
        stdio=stdio,
    )
    raw_result = result_payload.get("result", {})
    if isinstance(raw_result, dict) and raw_result.get("status") == "error":
        raise McpToolError(json.dumps(raw_result.get("errors", ["unknown error"]), ensure_ascii=False))
    return raw_result if isinstance(raw_result, dict) else {}


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def build_psd_import_job(
    manifest_path: Path,
    source_root: Path,
    job_name: str,
    target_node_id: str,
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    manifest = load_json(manifest_path)
    asset_paths: Dict[str, str] = {}
    assets = []

    for layer in manifest.get("layers", []):
        raw_asset_id = layer.get("assetId")
        if raw_asset_id is None:
            raw_asset_id = layer.get("idx")
        if raw_asset_id is None:
            raw_asset_id = layer.get("index")
        asset_id = str(raw_asset_id if raw_asset_id is not None else "")
        relative_path = str(layer.get("path") or "")
        if not asset_id or not relative_path:
            continue

        candidate = Path(relative_path)
        candidates = []
        if candidate.is_absolute():
            candidates.append(candidate)
        else:
            candidates.extend([candidate, source_root / relative_path, manifest_path.parent / relative_path])

        asset_path = None
        for item in candidates:
            resolved = item.resolve()
            if resolved.exists():
                asset_path = resolved
                break
        if asset_path is None:
            continue

        asset_paths[asset_id] = str(asset_path)
        assets.append({
            "id": asset_id,
            "path": relative_path.replace("\\", "/"),
            "bytes": asset_path.stat().st_size,
        })

    job = {
        "schemaVersion": 1,
        "name": job_name,
        "source": manifest_path.as_posix(),
        "target": {"nodeId": target_node_id} if target_node_id else {},
        "manifest": manifest,
        "assets": assets,
    }
    return job, asset_paths


def save_screenshot_if_present(result_payload: Dict[str, Any], result_path: Path) -> None:
    result = result_payload.get("result")
    if not isinstance(result, dict):
        return
    screenshot = result.get("screenshot")
    if not isinstance(screenshot, dict):
        return
    raw_base64 = screenshot.get("base64")
    if not raw_base64:
        return

    screenshot_dir = result_path.parent / "mcp_screenshots"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    file_name = str(screenshot.get("fileName") or f"{str(result.get('rootNodeId', 'screenshot')).replace(':', '_')}.png")
    safe_file_name = file_name.replace(":", "_").replace("\\", "_").replace("/", "_")
    screenshot_path = screenshot_dir / safe_file_name
    screenshot_path.write_bytes(base64.b64decode(str(raw_base64)))
    screenshot["path"] = screenshot_path.as_posix()
    screenshot.pop("base64", None)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Figma MCP Relay command-line helper")
    parser.add_argument("manifest", type=Path, nargs="?", help="PSD manifest_summary.json path")
    parser.add_argument("--source-root", type=Path, default=None, help="PNG source root, default is manifest directory")
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL, help="Runtime relay URL used internally by the MCP server")
    parser.add_argument("--bridge-url", dest="relay_url", default=DEFAULT_RELAY_URL, help=argparse.SUPPRESS)
    parser.add_argument("--mcp-url", default="", help="Persistent MCP companion URL, default is {relay-url}/mcp")
    parser.add_argument("--stdio", action="store_true", help="Compatibility mode: spawn the stdio MCP server instead of using HTTP companion")
    parser.add_argument("--target-node-id", default="", help="Target Figma nodeId")
    parser.add_argument("--job-name", default="PSD_Import_Root", help="Imported root frame name")
    parser.add_argument("--result", type=Path, default=Path(".tmp/psd_layer/figma_mcp_result.json"), help="Result JSON path")
    parser.add_argument("--timeout", type=float, default=300.0, help="Seconds to wait for Figma plugin result")
    parser.add_argument("--interval", type=float, default=0.5, help="Deprecated; kept for CLI compatibility")
    parser.add_argument("--get-selection", action="store_true", help="Query current Figma selection instead of importing")
    parser.add_argument("--health", action="store_true", help="Check the persistent figmaMcpRelay companion")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    relay_url = args.relay_url.rstrip("/")
    mcp_url = args.mcp_url.rstrip("/")
    if args.health:
        print(json.dumps({
            "status": "ok",
            "relayUrl": relay_url,
            "mcpUrl": mcp_url or _mcp_url_from_relay_url(relay_url),
            "health": health(relay_url, mcp_url=mcp_url, stdio=args.stdio),
        }, ensure_ascii=False, indent=2))
        return 0
    if args.get_selection:
        result_payload = query_selection(
            relay_url=relay_url,
            timeout=min(args.timeout, 15.0),
            mcp_url=mcp_url,
            stdio=args.stdio,
        )
        print(json.dumps({
            "status": "ok",
            "result": result_payload.get("result", result_payload),
        }, ensure_ascii=False, indent=2))
        return 0
    if args.manifest is None:
        raise ValueError("manifest is required unless --health or --get-selection is used")

    manifest_path = args.manifest.resolve()
    source_root = args.source_root.resolve() if args.source_root else manifest_path.parent
    request_id = str(uuid.uuid4())
    job, asset_paths = build_psd_import_job(manifest_path, source_root, args.job_name, args.target_node_id)
    result_payload = submit_job(
        job,
        asset_paths,
        relay_url=relay_url,
        request_id=request_id,
        wait=True,
        timeout=args.timeout,
        full_result=True,
        debug_full_result=True,
        mcp_url=mcp_url,
        stdio=args.stdio,
    )
    result_path = args.result.resolve()
    save_screenshot_if_present(result_payload, result_path)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": "completed",
        "requestId": result_payload.get("requestId", request_id),
        "resultPath": result_path.as_posix(),
        "result": result_payload.get("result", {}),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

