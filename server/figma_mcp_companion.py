"""
Figma MCP Relay companion.

This is the AI-facing MCP entrypoint for the local Figma MCP Relay plugin.
In HTTP companion mode one local process exposes both `/mcp` for AI MCP hosts
and the private plugin relay endpoints (`/figma/pending`, `/figma/result`,
`/assets/...`) for the Figma plugin. stdio remains available for compatibility.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from figma_mcp_relay_server import (
    DEFAULT_BIND_HOST,
    DEFAULT_BIND_HOST_IPV6,
    DEFAULT_PORT,
    DEFAULT_PUBLIC_HOST,
    INTERNAL_RELAY_HEADER,
    INTERNAL_RELAY_VALUE,
    RelayState,
    create_server,
    redact_large_relay_payload,
)
from python_logger import PythonLogger


SERVER_NAME = "figma-mcp-relay"
SERVER_VERSION = "0.1.0"
DEFAULT_RELAY_URL = f"http://{DEFAULT_PUBLIC_HOST}:{DEFAULT_PORT}"
DEFAULT_MCP_PATH = "/mcp"
LOGGER = PythonLogger("companion")


def log(message: str) -> None:
    LOGGER.info(message, operation_name="python.companion")


def normalize_url(value: str) -> str:
    return str(value or DEFAULT_RELAY_URL).strip().rstrip("/")


def post_json(url: str, payload: Dict[str, Any], timeout: float = 10.0) -> Dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            INTERNAL_RELAY_HEADER: INTERNAL_RELAY_VALUE,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8-sig") or "{}")


def get_json(url: str, timeout: float = 10.0) -> Tuple[int, Dict[str, Any]]:
    try:
        request = urllib.request.Request(
            url,
            headers={INTERNAL_RELAY_HEADER: INTERNAL_RELAY_VALUE},
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status == 204:
                return 204, {}
            return response.status, json.loads(response.read().decode("utf-8-sig") or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code == 204:
            return 204, {}
        raise


def is_relay_healthy(relay_url: str, timeout: float = 1.5) -> bool:
    try:
        status, payload = get_json(f"{normalize_url(relay_url)}/health", timeout=timeout)
    except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError):
        return False
    return status == 200 and payload.get("status") == "ok"


@dataclass
class RuntimeRelay:
    relay_url: str = DEFAULT_RELAY_URL
    bind_ipv6: bool = True
    verbose: bool = False
    state: RelayState = field(default_factory=RelayState)
    servers: List[Any] = field(default_factory=list)
    threads: List[threading.Thread] = field(default_factory=list)
    mode: str = "uninitialized"
    mcp_path: str = DEFAULT_MCP_PATH

    def ensure_running(self) -> Dict[str, Any]:
        self.relay_url = normalize_url(self.relay_url)
        if is_relay_healthy(self.relay_url):
            if self.mode != "companion":
                self.mode = "external" if not self.servers else "embedded"
            status, payload = get_json(f"{self.relay_url}/health", timeout=2.0)
            payload["mcpRelayMode"] = self.mode
            payload["mcpRelayUrl"] = self.relay_url
            if self.mode == "companion":
                payload["mcpUrl"] = f"{self.relay_url}{self.mcp_path}"
            payload["httpStatus"] = status
            return payload

        if not self.servers:
            self._start_embedded()

        deadline = time.time() + 5.0
        while time.time() < deadline:
            if is_relay_healthy(self.relay_url):
                status, payload = get_json(f"{self.relay_url}/health", timeout=2.0)
                payload["mcpRelayMode"] = self.mode
                payload["mcpRelayUrl"] = self.relay_url
                if self.mode == "companion":
                    payload["mcpUrl"] = f"{self.relay_url}{self.mcp_path}"
                payload["httpStatus"] = status
                return payload
            time.sleep(0.1)
        raise TimeoutError(f"Figma MCP Relay runtime did not become healthy: {self.relay_url}/health")

    def _start_embedded(self) -> None:
        parsed = urlparse(self.relay_url)
        host = parsed.hostname or DEFAULT_PUBLIC_HOST
        port = parsed.port or DEFAULT_PORT
        if host not in ("localhost", "127.0.0.1", "::1"):
            raise RuntimeError(f"cannot auto-start non-local Figma relay: {self.relay_url}")

        hosts = [DEFAULT_BIND_HOST]
        if self.bind_ipv6:
            hosts.append(DEFAULT_BIND_HOST_IPV6)

        errors: List[str] = []
        for bind_host in hosts:
            try:
                server = create_server(bind_host, port, self.state, self.relay_url, self.verbose)
            except OSError as exc:
                errors.append(f"{bind_host}:{port} {exc}")
                continue
            thread = threading.Thread(
                target=server.serve_forever,
                name=f"figma-mcp-relay-{bind_host}",
                daemon=True,
            )
            thread.start()
            self.servers.append(server)
            self.threads.append(thread)

        if not self.servers:
            raise RuntimeError("failed to start Figma MCP Relay runtime: " + "; ".join(errors))
        if errors:
            log("runtime relay partial listen: " + "; ".join(errors))
        self.mode = "embedded"
        log(f"runtime relay listening at {self.relay_url}")

    def submit_job(self, job: Dict[str, Any], asset_paths: Optional[Dict[str, str]] = None, request_id: str = "") -> Dict[str, Any]:
        self.ensure_running()
        payload = {
            "requestId": request_id or str(uuid.uuid4()),
            "job": job,
            "assetPaths": asset_paths or {},
        }
        return post_json(f"{self.relay_url}/jobs", payload, timeout=10.0)

    def wait_result(
        self,
        request_id: str,
        timeout: float = 60.0,
        interval: float = 0.5,
        full_result: bool = False,
    ) -> Dict[str, Any]:
        self.ensure_running()
        deadline = time.time() + timeout
        summary_suffix = "" if full_result else "?summary=compact"
        result_url = f"{self.relay_url}/jobs/{request_id}/result{summary_suffix}"
        while time.time() < deadline:
            status, payload = get_json(result_url, timeout=5.0)
            if status == 200:
                return redact_large_relay_payload(payload) if full_result else payload
            time.sleep(interval)
        raise TimeoutError(f"timeout waiting for Figma plugin result: {request_id}")

    def submit_endpoint_job(self, path: str, payload: Optional[Dict[str, Any]], timeout: float) -> Dict[str, Any]:
        self.ensure_running()
        submitted = post_json(f"{self.relay_url}{path}", payload or {}, timeout=5.0)
        request_id = str(submitted.get("requestId") or "")
        if not request_id:
            raise RuntimeError(f"{path} did not return requestId: {submitted}")
        return self.wait_result(request_id, timeout=timeout)

    def start_prefab_import(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.ensure_running()
        return post_json(f"{self.relay_url}/prefab-to-figma/import", payload, timeout=10.0)

    def prefab_import_status(self, task_id: str) -> Dict[str, Any]:
        self.ensure_running()
        status, payload = get_json(
            f"{self.relay_url}/prefab-to-figma/import/{task_id}/status",
            timeout=10.0,
        )
        payload["httpStatus"] = status
        return payload


def tool_text(payload: Any, is_error: bool = False) -> Dict[str, Any]:
    if isinstance(payload, str):
        text = payload
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    result: Dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


def target_payload(arguments: Dict[str, Any], extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build endpoint payload with optional Figma plugin target routing fields."""
    payload: Dict[str, Any] = dict(extra or {})
    target = arguments.get("target") if isinstance(arguments.get("target"), dict) else {}
    if target:
        payload["target"] = target
    for key in ("fileKey", "sessionId"):
        value = str(arguments.get(key) or target.get(key) or "").strip()
        if value:
            payload[key] = value
    return payload


def target_properties(extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return MCP schema properties for target-aware Figma plugin tools."""
    properties: Dict[str, Any] = {
        "fileKey": {"type": "string"},
        "sessionId": {"type": "string"},
        "target": {"type": "object"},
    }
    properties.update(extra or {})
    return properties


def wants_debug_full_result(arguments: Dict[str, Any]) -> bool:
    """Only allow AI-facing full results when the caller opts into bounded debug explicitly."""
    return bool(arguments.get("fullResult") is True and arguments.get("debugFullResult") is True)


class FigmaEditMcpServer:
    def __init__(self, relay: RuntimeRelay) -> None:
        self.relay = relay

    def handle(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}

        try:
            if method == "initialize":
                return self.response(request_id, {
                    "protocolVersion": params.get("protocolVersion") or "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                })
            if method == "notifications/initialized":
                return None
            if method == "ping":
                return self.response(request_id, {})
            if method == "tools/list":
                return self.response(request_id, {"tools": self.tools()})
            if method == "tools/call":
                name = str(params.get("name") or "")
                arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
                return self.response(request_id, self.call_tool(name, arguments))
            if method in ("resources/list", "prompts/list"):
                key = "resources" if method == "resources/list" else "prompts"
                return self.response(request_id, {key: []})
            return self.error(request_id, -32601, f"unknown method: {method}")
        except Exception as exc:  # noqa: BLE001 - MCP tools should return structured errors.
            if request_id is None:
                log(f"notification failed: {exc}")
                return None
            return self.response(request_id, tool_text({"error": str(exc), "method": method}, is_error=True))

    @staticmethod
    def response(request_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def error(request_id: Any, code: int, message: str) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    @staticmethod
    def tools() -> List[Dict[str, Any]]:
        return [
            {
                "name": "figma_health",
                "description": "Check the local Figma MCP Relay companion and plugin runtime health.",
                "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            },
            {
                "name": "figma_query_selection",
                "description": "Ask the connected Figma plugin for the current file, page, and selected nodes.",
                "inputSchema": {
                    "type": "object",
                    "properties": target_properties({
                        "timeout": {"type": "number", "description": "Seconds to wait for the plugin result.", "default": 15}
                    }),
                    "additionalProperties": False,
                },
            },
            {
                "name": "figma_query_plugin_status",
                "description": "Ask the connected Figma plugin for build, file key, and current page status.",
                "inputSchema": {
                    "type": "object",
                    "properties": target_properties({
                        "timeout": {"type": "number", "description": "Seconds to wait for the plugin result.", "default": 8}
                    }),
                    "additionalProperties": False,
                },
            },
            {
                "name": "figma_query_node_children",
                "description": "Read direct child metadata for a Figma node through the Figma MCP Relay plugin.",
                "inputSchema": {
                    "type": "object",
                    "properties": target_properties({
                        "nodeId": {"type": "string"},
                        "timeout": {"type": "number", "default": 15},
                    }),
                    "required": ["nodeId"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "figma_query_components",
                "description": "Collect component metadata from library/root nodes inside the current Figma file.",
                "inputSchema": {
                    "type": "object",
                    "properties": target_properties({
                        "libraryNodeIds": {"type": "array", "items": {"type": "string"}},
                        "timeout": {"type": "number", "default": 20},
                    }),
                    "additionalProperties": False,
                },
            },
            {
                "name": "figma_submit_job",
                "description": "Submit a raw MCP Relay job to the connected Figma plugin. Use for advanced relay operations.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "job": {"type": "object"},
                        "assetPaths": {"type": "object", "additionalProperties": {"type": "string"}},
                        "requestId": {"type": "string"},
                        "wait": {"type": "boolean", "default": False},
                        "fullResult": {"type": "boolean", "default": False},
                        "debugFullResult": {"type": "boolean", "default": False},
                        "timeout": {"type": "number", "default": 60},
                    },
                    "required": ["job"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "figma_wait_result",
                "description": "Wait for a previously submitted Figma MCP Relay job result.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "requestId": {"type": "string"},
                        "timeout": {"type": "number", "default": 60},
                        "interval": {"type": "number", "default": 0.5},
                        "fullResult": {"type": "boolean", "default": False},
                        "debugFullResult": {"type": "boolean", "default": False},
                    },
                    "required": ["requestId"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "figma_prefab_import_start",
                "description": "Start the deterministic Unity UGUI Prefab to Figma import pipeline through the local Figma MCP Relay plugin.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "prefabPaths": {"type": "array", "items": {"type": "string"}},
                        "canvas": {"type": "string", "default": "auto"},
                        "canvasByPrefabPath": {"type": "object", "additionalProperties": {"type": "string"}},
                        "componentMode": {"type": "string", "default": "component"},
                        "nestedPrefabComponentMode": {"type": "string", "default": "all"},
                        "figmaUrl": {"type": "string"},
                        "fileKey": {"type": "string"},
                        "targetNodeId": {"type": "string"},
                    },
                    "required": ["prefabPaths"],
                    "additionalProperties": True,
                },
            },
            {
                "name": "figma_prefab_import_status",
                "description": "Read status for a deterministic Unity UGUI Prefab to Figma import task.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "taskId": {"type": "string"},
                    },
                    "required": ["taskId"],
                    "additionalProperties": False,
                },
            },
        ]

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        try:
            if name == "figma_health":
                return tool_text(self.relay.ensure_running())
            if name == "figma_query_selection":
                return tool_text(self.relay.submit_endpoint_job(
                    "/figma/query-selection",
                    target_payload(arguments),
                    timeout=float(arguments.get("timeout", 15)),
                ))
            if name == "figma_query_plugin_status":
                return tool_text(self.relay.submit_endpoint_job(
                    "/figma/query-plugin-status",
                    target_payload(arguments),
                    timeout=float(arguments.get("timeout", 8)),
                ))
            if name == "figma_query_node_children":
                return tool_text(self.relay.submit_endpoint_job(
                    "/figma/query-node-children",
                    target_payload(arguments, {"nodeId": str(arguments.get("nodeId") or "")}),
                    timeout=float(arguments.get("timeout", 15)),
                ))
            if name == "figma_query_components":
                payload = target_payload(arguments)
                if "libraryNodeIds" in arguments:
                    payload["libraryNodeIds"] = arguments.get("libraryNodeIds")
                return tool_text(self.relay.submit_endpoint_job(
                    "/figma/query-components",
                    payload,
                    timeout=float(arguments.get("timeout", 20)),
                ))
            if name == "figma_submit_job":
                job = arguments.get("job")
                if not isinstance(job, dict):
                    raise ValueError("figma_submit_job requires object argument: job")
                submitted = self.relay.submit_job(
                    job=job,
                    asset_paths=arguments.get("assetPaths") if isinstance(arguments.get("assetPaths"), dict) else {},
                    request_id=str(arguments.get("requestId") or ""),
                )
                if arguments.get("wait"):
                    result = self.relay.wait_result(
                        str(submitted.get("requestId")),
                        timeout=float(arguments.get("timeout", 60)),
                        full_result=wants_debug_full_result(arguments),
                    )
                    return tool_text({"submitted": submitted, "result": result})
                return tool_text(submitted)
            if name == "figma_wait_result":
                request_id = str(arguments.get("requestId") or "")
                if not request_id:
                    raise ValueError("figma_wait_result requires requestId")
                return tool_text(self.relay.wait_result(
                    request_id,
                    timeout=float(arguments.get("timeout", 60)),
                    interval=float(arguments.get("interval", 0.5)),
                    full_result=wants_debug_full_result(arguments),
                ))
            if name == "figma_prefab_import_start":
                prefab_paths = arguments.get("prefabPaths")
                if not isinstance(prefab_paths, list) or not prefab_paths:
                    raise ValueError("figma_prefab_import_start requires non-empty prefabPaths")
                return tool_text(self.relay.start_prefab_import(arguments))
            if name == "figma_prefab_import_status":
                task_id = str(arguments.get("taskId") or "")
                if not task_id:
                    raise ValueError("figma_prefab_import_status requires taskId")
                return tool_text(self.relay.prefab_import_status(task_id))
            return tool_text({"error": f"unknown tool: {name}"}, is_error=True)
        except Exception as exc:  # noqa: BLE001 - tool errors are data for the MCP client.
            return tool_text({"error": str(exc), "tool": name}, is_error=True)


def read_message(stream: Any) -> Optional[Dict[str, Any]]:
    while True:
        line = stream.readline()
        if line == b"":
            return None
        if line.strip():
            break

    stripped = line.lstrip()
    if stripped.startswith(b"{"):
        return json.loads(line.decode("utf-8"))

    headers: Dict[str, str] = {}
    while line.strip():
        key, _, value = line.decode("ascii", errors="ignore").partition(":")
        headers[key.strip().lower()] = value.strip()
        line = stream.readline()
        if line == b"":
            return None

    length = int(headers.get("content-length", "0"))
    if length <= 0:
        raise ValueError("missing Content-Length header")
    body = stream.read(length)
    return json.loads(body.decode("utf-8"))


def write_message(stream: Any, message: Dict[str, Any]) -> None:
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    stream.write(body)
    stream.flush()


def serve_stdio(server: FigmaEditMcpServer) -> int:
    in_stream = sys.stdin.buffer
    out_stream = sys.stdout.buffer

    while True:
        try:
            message = read_message(in_stream)
        except Exception as exc:  # noqa: BLE001
            write_message(out_stream, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
            continue
        if message is None:
            break
        response = server.handle(message)
        if response is not None:
            write_message(out_stream, response)
    return 0


def serve_http_companion(args: argparse.Namespace) -> int:
    relay_url = normalize_url(args.relay_url or f"http://{args.public_host}:{args.port}")
    state = RelayState()
    relay = RuntimeRelay(
        relay_url=relay_url,
        bind_ipv6=args.bind_ipv6,
        verbose=args.verbose,
        state=state,
        mode="companion",
        mcp_path=args.mcp_path,
    )
    mcp_server = FigmaEditMcpServer(relay)
    hosts = [args.host]
    if args.bind_ipv6 and args.host != DEFAULT_BIND_HOST_IPV6:
        hosts.append(DEFAULT_BIND_HOST_IPV6)

    errors: List[str] = []
    for host in hosts:
        try:
            http_server = create_server(
                host,
                args.port,
                state,
                relay_url,
                args.verbose,
                mcp_server=mcp_server,
                mcp_path=args.mcp_path,
            )
        except OSError as exc:
            errors.append(f"{host}:{args.port} {exc}")
            continue
        relay.servers.append(http_server)

    if not relay.servers:
        raise RuntimeError("failed to start Figma MCP Relay companion: " + "; ".join(errors))
    if errors:
        log("companion partial listen: " + "; ".join(errors))

    primary = relay.servers[0]
    print(json.dumps({
        "status": "listening",
        "mode": "mcp-companion",
        "relayUrl": relay_url,
        "mcpUrl": f"{relay_url}{args.mcp_path}",
        "bind": [str(item.server_address) for item in relay.servers],
        "message": "Figma MCP Relay companion is running. Keep this process open.",
    }, ensure_ascii=False, indent=2))

    for index, http_server in enumerate(relay.servers[1:], start=1):
        thread = threading.Thread(
            target=http_server.serve_forever,
            name=f"figma-mcp-relay-companion-{index}",
            daemon=True,
        )
        thread.start()
        relay.threads.append(thread)

    try:
        primary.serve_forever()
    except KeyboardInterrupt:
        print(json.dumps({"status": "stopped"}, ensure_ascii=False))
        return 130
    finally:
        for http_server in relay.servers:
            http_server.shutdown()
            http_server.server_close()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Figma MCP Relay companion")
    parser.add_argument("--transport", choices=("stdio", "http"), default="stdio", help="MCP transport mode")
    parser.add_argument("--relay-url", default="", help="Plugin runtime relay URL")
    parser.add_argument("--bridge-url", dest="relay_url", default="", help=argparse.SUPPRESS)
    parser.add_argument("--host", default=DEFAULT_BIND_HOST, help="HTTP companion bind host")
    parser.add_argument("--public-host", default=DEFAULT_PUBLIC_HOST, help="Public host shown to the plugin and MCP clients")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP companion port")
    parser.add_argument("--mcp-path", default=DEFAULT_MCP_PATH, help="HTTP MCP endpoint path")
    parser.add_argument("--log-file", default="", help="Append stdout/stderr to this file")
    parser.add_argument("--no-ipv6", dest="bind_ipv6", action="store_false", help="Do not listen on ::1 for the relay")
    parser.add_argument("--verbose", action="store_true", help="Verbose relay HTTP logging")
    parser.set_defaults(bind_ipv6=True)
    return parser.parse_args()


def main() -> int:
    global LOGGER
    args = parse_args()
    log_handle = None
    if args.log_file:
        log_path = Path(args.log_file).expanduser()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_handle = log_path.open("a", encoding="utf-8", buffering=1)
        sys.stdout = log_handle
        sys.stderr = log_handle
        LOGGER = PythonLogger("companion", stream=log_handle)
    operation = LOGGER.start_operation("python.companion.main", data={"transport": args.transport})
    try:
        if args.transport == "http":
            result = serve_http_companion(args)
        else:
            relay = RuntimeRelay(
                relay_url=normalize_url(args.relay_url),
                bind_ipv6=args.bind_ipv6,
                verbose=args.verbose,
            )
            server = FigmaEditMcpServer(relay)
            result = serve_stdio(server)
        operation.succeed("Companion stopped", {"exitCode": result})
        return result
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            operation.cancel("Companion interrupted")
        else:
            operation.fail(exc, "Companion failed")
        raise
    finally:
        if log_handle:
            log_handle.close()


if __name__ == "__main__":
    raise SystemExit(main())
