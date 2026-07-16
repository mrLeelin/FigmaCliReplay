"""
Figma 层级整理 MCP 命令行 wrapper。

职责：
- 通过 figmaMcpRelay 连接已启动的本地 companion。
- 提交只读分析任务和确认后的层级整理任务。
- 保存 Figma 插件返回的 JSON 与截图，供后续计划和验证脚本消费。
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
import uuid
import warnings
from pathlib import Path
from typing import Any, Dict, Optional


DEFAULT_RELAY_URL = "http://localhost:32130"
def find_relay_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "client" / "figma_mcp_client.py").is_file():
            return parent
    raise RuntimeError("Unable to locate the Figma MCP Relay root containing client/figma_mcp_client.py.")


RELAY_ROOT = find_relay_root()
MCP_CLIENT_DIR = RELAY_ROOT / "client"
DEFAULT_OUTPUT_DIR = Path(".tmp/figma-hierarchy-cleanup")
DEFAULT_ANALYSIS_PATH = DEFAULT_OUTPUT_DIR / "analysis_result.json"
DEFAULT_PLAN_PATH = DEFAULT_OUTPUT_DIR / "cleanup_plan.json"
DEFAULT_APPLY_PATH = DEFAULT_OUTPUT_DIR / "apply_result.json"
DEFAULT_REORDER_PLAN_PATH = DEFAULT_OUTPUT_DIR / "reorder_plan.json"
DEFAULT_REORDER_PATH = DEFAULT_OUTPUT_DIR / "reorder_result.json"
DEFAULT_COMPONENT_SET_PLAN_PATH = DEFAULT_OUTPUT_DIR / "component_set_plan.json"
DEFAULT_COMPONENT_SET_PATH = DEFAULT_OUTPUT_DIR / "component_set_result.json"
DEFAULT_SELECTION_PATH = DEFAULT_OUTPUT_DIR / "selection_result.json"
DEFAULT_COMPONENT_SET_ADD_PATH = DEFAULT_OUTPUT_DIR / "component_set_add_variants_result.json"
DEFAULT_COMPONENT_FROM_SELECTION_PATH = DEFAULT_OUTPUT_DIR / "component_from_selection_result.json"
DEFAULT_REBUILD_SIBLINGS_PATH = DEFAULT_OUTPUT_DIR / "rebuild_component_set_from_siblings_result.json"
DEFAULT_COMPONENT_SET_NODE_GROUPS_PATH = DEFAULT_OUTPUT_DIR / "component_set_from_node_groups_result.json"
DEFAULT_MOVE_NODES_PLAN_PATH = DEFAULT_OUTPUT_DIR / "move_nodes_plan.json"
DEFAULT_MOVE_NODES_PATH = DEFAULT_OUTPUT_DIR / "move_nodes_result.json"
DEFAULT_SET_POSITIONS_PLAN_PATH = DEFAULT_OUTPUT_DIR / "set_positions_plan.json"
DEFAULT_SET_POSITIONS_PATH = DEFAULT_OUTPUT_DIR / "set_positions_result.json"
DEFAULT_SCREENSHOT_PATH = DEFAULT_OUTPUT_DIR / "screenshot_result.json"
DEFAULT_WRAP_CHAIN_PATH = DEFAULT_OUTPUT_DIR / "wrap_chain_result.json"
ACTIVE_FILE_KEY = ""
ACTIVE_SESSION_ID = ""
ACTIVE_PREFLIGHT = True
ACTIVE_SESSION_REFRESH: Dict[str, Any] = {}
ACTIVE_PREFLIGHT_PROBE: Dict[str, Any] = {}

if str(MCP_CLIENT_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_CLIENT_DIR))

from figma_mcp_client import (  # noqa: E402
    health as mcp_health,
    query_node_children as mcp_query_node_children,
    query_selection as mcp_query_selection,
    submit_job as mcp_submit_job,
)


class McpRelayError(RuntimeError):
    """表示 MCP Relay 调用失败或返回了错误状态。"""


def plugin_sessions(health_payload: Dict[str, Any]) -> list[Dict[str, Any]]:
    plugin = health_payload.get("plugin") if isinstance(health_payload.get("plugin"), dict) else {}
    sessions = plugin.get("sessions") if isinstance(plugin.get("sessions"), list) else []
    return [item for item in sessions if isinstance(item, dict)]


def configure_target(file_key: str = "", session_id: str = "", preflight: bool = True) -> None:
    global ACTIVE_FILE_KEY, ACTIVE_SESSION_ID, ACTIVE_PREFLIGHT, ACTIVE_SESSION_REFRESH, ACTIVE_PREFLIGHT_PROBE
    ACTIVE_FILE_KEY = file_key.strip()
    ACTIVE_SESSION_ID = session_id.strip()
    ACTIVE_PREFLIGHT = bool(preflight)
    ACTIVE_SESSION_REFRESH = {}
    ACTIVE_PREFLIGHT_PROBE = {}


def target_session_fields() -> Dict[str, str]:
    fields: Dict[str, str] = {}
    if ACTIVE_FILE_KEY:
        fields["fileKey"] = ACTIVE_FILE_KEY
    if ACTIVE_SESSION_ID:
        fields["sessionId"] = ACTIVE_SESSION_ID
    return fields


def merge_target_fields(target: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(target) if isinstance(target, dict) else {}
    for key, value in target_session_fields().items():
        merged.setdefault(key, value)
    return merged


def attach_target_fields(job: Dict[str, Any]) -> Dict[str, Any]:
    fields = target_session_fields()
    if not fields:
        return job
    job["target"] = merge_target_fields(job.get("target") if isinstance(job.get("target"), dict) else {})
    for key, value in fields.items():
        job.setdefault(key, value)
    plan = job.get("plan")
    if isinstance(plan, dict):
        plan_target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
        if plan_target or job["target"].get("nodeId"):
            plan["target"] = merge_target_fields(plan_target)
    return job


def load_json(path: Path) -> Dict[str, Any]:
    """读取 UTF-8 或 UTF-8-BOM JSON 文件。"""
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    """把 JSON 结果写入磁盘，确保目录存在。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    clean_payload = sanitize_json_payload(payload)
    path.write_text(json.dumps(clean_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    json.loads(path.read_text(encoding="utf-8-sig"))


def sanitize_json_payload(value: Any) -> Any:
    """Return JSON-safe data and neutralize malformed plugin strings."""
    if isinstance(value, dict):
        return {sanitize_json_key(key): sanitize_json_payload(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_json_payload(item) for item in value]
    if isinstance(value, str):
        return sanitize_json_string(value)
    return value


def sanitize_json_key(value: Any) -> str:
    return sanitize_json_string(str(value))


def sanitize_json_string(value: str) -> str:
    text = value.replace("\ufffd", "?")
    return "".join("?" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in text)


def preflight_target_probe(relay_url: str, node_id: str = "") -> Optional[Dict[str, Any]]:
    """Probe the live MCP path when health session metadata is stale or empty."""
    global ACTIVE_PREFLIGHT_PROBE
    if not ACTIVE_FILE_KEY and not ACTIVE_SESSION_ID and not node_id:
        return None
    try:
        if node_id:
            payload = mcp_query_node_children(
                node_id,
                relay_url=relay_url.rstrip("/"),
                timeout=8.0,
                file_key=ACTIVE_FILE_KEY,
                session_id=ACTIVE_SESSION_ID,
            )
            result = result_of_payload(payload)
            if result.get("status") == "completed" and result.get("nodeId"):
                ACTIVE_PREFLIGHT_PROBE = {
                    "reason": "health-session-metadata-stale-but-node-probe-passed",
                    "nodeId": str(result.get("nodeId") or node_id),
                    "fileKey": ACTIVE_FILE_KEY,
                    "sessionId": ACTIVE_SESSION_ID,
                }
                return dict(ACTIVE_PREFLIGHT_PROBE)
        payload = mcp_query_selection(
            relay_url=relay_url.rstrip("/"),
            timeout=8.0,
            file_key=ACTIVE_FILE_KEY,
            session_id=ACTIVE_SESSION_ID,
        )
        result = result_of_payload(payload)
        if result.get("status") == "completed":
            ACTIVE_PREFLIGHT_PROBE = {
                "reason": "health-session-metadata-stale-but-selection-probe-passed",
                "fileKey": ACTIVE_FILE_KEY,
                "sessionId": ACTIVE_SESSION_ID,
                "pageName": str(result.get("pageName") or ""),
                "selectionCount": result.get("count"),
            }
            return dict(ACTIVE_PREFLIGHT_PROBE)
    except Exception as exc:  # noqa: BLE001
        ACTIVE_PREFLIGHT_PROBE = {
            "reason": "health-session-metadata-stale-and-probe-failed",
            "error": str(exc),
            "fileKey": ACTIVE_FILE_KEY,
            "sessionId": ACTIVE_SESSION_ID,
            "nodeId": node_id,
        }
        return None
    return None


def ensure_mcp_companion(relay_url: str, startup_timeout: float = 10.0, node_id: str = "") -> Dict[str, Any]:
    """确保 figmaMcpRelay 本地 companion 可用，并返回 health 信息。"""
    global ACTIVE_SESSION_ID, ACTIVE_SESSION_REFRESH
    del startup_timeout
    health_payload = mcp_health(relay_url=relay_url.rstrip("/"))
    if not ACTIVE_PREFLIGHT:
        return health_payload
    plugin = health_payload.get("plugin") if isinstance(health_payload.get("plugin"), dict) else {}
    sessions = plugin_sessions(health_payload)
    if not plugin.get("connected") or not sessions:
        probe = preflight_target_probe(relay_url, node_id=node_id)
        if probe:
            health_payload["preflightProbe"] = probe
            return health_payload
        raise RuntimeError(
            "preflight failed: no online Figma plugin session: "
            + json.dumps(
                {
                    "pluginConnected": bool(plugin.get("connected")),
                    "requestedFileKey": ACTIVE_FILE_KEY,
                    "requestedSessionId": ACTIVE_SESSION_ID,
                    "requestedNodeId": node_id,
                    "probe": ACTIVE_PREFLIGHT_PROBE,
                },
                ensure_ascii=False,
            )
        )
    if not plugin.get("authenticated"):
        raise RuntimeError("preflight failed: Figma plugin session is not authenticated")
    if ACTIVE_SESSION_ID:
        matches = [item for item in sessions if str(item.get("sessionId") or "") == ACTIVE_SESSION_ID]
        if not matches:
            file_matches = [
                item for item in sessions
                if ACTIVE_FILE_KEY and str(item.get("fileKey") or "") == ACTIVE_FILE_KEY
            ]
            if len(file_matches) == 1:
                old_session_id = ACTIVE_SESSION_ID
                ACTIVE_SESSION_ID = str(file_matches[0].get("sessionId") or "")
                ACTIVE_SESSION_REFRESH = {
                    "reason": "stale-session-id-refreshed-by-file-key",
                    "oldSessionId": old_session_id,
                    "newSessionId": ACTIVE_SESSION_ID,
                    "fileKey": ACTIVE_FILE_KEY,
                }
                health_payload["preflightSessionRefresh"] = dict(ACTIVE_SESSION_REFRESH)
            else:
                diagnostics = {
                    "requestedSessionId": ACTIVE_SESSION_ID,
                    "requestedFileKey": ACTIVE_FILE_KEY,
                    "activeSessionId": plugin.get("activeSessionId"),
                    "onlineSessions": [
                        {
                            "sessionId": str(item.get("sessionId") or ""),
                            "fileKey": str(item.get("fileKey") or ""),
                            "pageName": str(item.get("currentPageName") or ""),
                        }
                        for item in sessions
                    ],
                }
                raise RuntimeError(
                    "preflight failed: sessionId not online and fileKey did not resolve to exactly one session: "
                    + json.dumps(diagnostics, ensure_ascii=False)
                )
    if ACTIVE_FILE_KEY:
        matches = [item for item in sessions if str(item.get("fileKey") or "") == ACTIVE_FILE_KEY]
        if not matches:
            online = ", ".join(str(item.get("fileKey") or "?") for item in sessions)
            raise RuntimeError(f"preflight failed: fileKey not online: {ACTIVE_FILE_KEY}; online={online}")
    if not ACTIVE_SESSION_ID and not ACTIVE_FILE_KEY and len(sessions) > 1:
        raise RuntimeError("preflight failed: multiple plugin sessions online; pass --file-key or --session-id")
    return health_payload


def extract_figma_target(figma_url: str, node_id: str = "", file_key: str = "", session_id: str = "") -> Dict[str, str]:
    """从 Figma URL 或显式参数中提取 fileKey 与 nodeId。"""
    target_node_id = node_id.strip()
    target_file_key = file_key.strip()
    url = figma_url.strip()

    if url:
        file_match = re.search(r"figma\.com/(?:design|file)/([^/?#]+)", url)
        if file_match and not target_file_key:
            target_file_key = file_match.group(1)
        node_match = re.search(r"[?&]node-id=([^&]+)", url)
        if node_match and not target_node_id:
            target_node_id = node_match.group(1).replace("-", ":")

    if not target_node_id:
        raise ValueError("缺少 Figma nodeId，请提供 --figma-url 或 --node-id")

    target = {
        "url": url,
        "fileKey": target_file_key or ACTIVE_FILE_KEY,
        "nodeId": target_node_id,
    }
    if session_id.strip() or ACTIVE_SESSION_ID:
        target["sessionId"] = session_id.strip() or ACTIVE_SESSION_ID
    return target


def save_screenshot_if_present(result_payload: Dict[str, Any], result_path: Path, suffix: str) -> None:
    """保存 MCP Relay 插件回传的截图，并从 JSON 中移除大体积 base64。"""
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
    file_name = str(screenshot.get("fileName") or f"figma_hierarchy_{suffix}.png")
    safe_file_name = file_name.replace(":", "_").replace("\\", "_").replace("/", "_")
    screenshot_path = screenshot_dir / safe_file_name
    screenshot_path.write_bytes(base64.b64decode(str(raw_base64)))
    screenshot["path"] = screenshot_path.as_posix()
    screenshot.pop("base64", None)


def submit_job(relay_url: str, job: Dict[str, Any], timeout: float, interval: float) -> Dict[str, Any]:
    """提交 MCP Relay job 并等待 Figma 插件执行完成。"""
    del interval
    request_id = str(uuid.uuid4())
    job = attach_target_fields(job)
    return mcp_submit_job(
        job,
        {},
        relay_url=relay_url.rstrip("/"),
        request_id=request_id,
        wait=True,
        timeout=timeout,
        full_result=True,
        debug_full_result=True,
    )


def submit_query_selection(relay_url: str, timeout: float, interval: float) -> Dict[str, Any]:
    """提交当前 Figma 选择查询任务并等待结果。"""
    del interval
    return mcp_query_selection(
        relay_url=relay_url.rstrip("/"),
        timeout=timeout,
        file_key=ACTIVE_FILE_KEY,
        session_id=ACTIVE_SESSION_ID,
    )


def assert_completed(result_payload: Dict[str, Any]) -> None:
    """检查 MCP Relay result 是否完成且没有阻塞错误。"""
    result = result_of_payload(result_payload)
    if not isinstance(result, dict):
        raise McpRelayError("MCP Relay 返回缺少 result 对象")
    if result.get("status") != "completed":
        errors = result.get("blockingErrors") or result.get("errors") or []
        raise McpRelayError(f"Figma 层级整理任务未完成：{result.get('status')} {errors}")


def result_of_payload(result_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return the innermost Figma plugin result from MCP wrapper payloads."""
    current: Any = result_payload
    for _ in range(8):
        if not isinstance(current, dict):
            return {}
        if isinstance(current.get("directChildren"), list) or isinstance(current.get("nodes"), list):
            return current
        if current.get("status") == "completed" and (
            "summary" in current or "checks" in current or "artifacts" in current or "selection" in current
        ):
            return current
        nested = current.get("result")
        if not isinstance(nested, dict):
            return current
        current = nested
    return current if isinstance(current, dict) else {}


def analysis_output_payload(result_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return a stable analyze artifact while preserving MCP metadata."""
    result = result_of_payload(result_payload)
    if not result:
        return result_payload
    output = dict(result)
    request_id = result_payload.get("requestId")
    if request_id and "requestId" not in output:
        output["requestId"] = request_id
    return output


def query_node_children(relay_url: str, node_id: str, timeout: float = 15.0, interval: float = 0.3) -> Dict[str, Any]:
    """通过 MCP Relay 查询节点直接子节点。"""
    del interval
    return mcp_query_node_children(
        node_id,
        relay_url=relay_url.rstrip("/"),
        timeout=timeout,
        file_key=ACTIVE_FILE_KEY,
        session_id=ACTIVE_SESSION_ID,
    )


def collect_child_relative_positions(
    relay_url: str,
    child_to_target: Dict[str, str],
) -> Dict[str, Dict[str, float]]:
    """按目标父级查询移动后子节点局部坐标，用于 rebase 修正。"""
    relatives: Dict[str, Dict[str, float]] = {}
    target_ids = sorted(set(child_to_target.values()))
    for target_id in target_ids:
        try:
            payload = query_node_children(relay_url, target_id)
            result = result_of_payload(payload)
            if result.get("status") != "completed":
                warnings.warn(f"查询目标父级 {target_id} 子节点失败：{result.get('errors')}")
                continue
            for child in result.get("children", []) or []:
                child_id = str(child.get("id") or "")
                if child_id in child_to_target:
                    relatives[child_id] = {
                        "x": float(child.get("x", 0) or 0),
                        "y": float(child.get("y", 0) or 0),
                    }
        except Exception as exc:
            warnings.warn(f"查询目标父级 {target_id} 子节点位置失败：{exc}")
    return relatives


def apply_move_rebase_correction(
    relay_url: str,
    result_payload: Dict[str, Any],
    child_to_target: Dict[str, str],
    timeout: float,
    interval: float,
) -> Dict[str, Any]:
    """根据 move 结果中的绝对 bounds 漂移，补偿设置移动后子节点局部坐标。"""
    result = result_of_payload(result_payload)
    checks = result.get("checks") if isinstance(result.get("checks"), dict) else {}
    bounds_check = checks.get("boundsPreserved") if isinstance(checks.get("boundsPreserved"), dict) else {}
    drift_nodes = bounds_check.get("driftNodes") if isinstance(bounds_check.get("driftNodes"), list) else []
    if not drift_nodes:
        return {"attempted": False, "reason": "no-bounds-drift"}

    artifacts = result.get("artifacts") if isinstance(result.get("artifacts"), dict) else {}
    before_bounds = artifacts.get("beforeBounds") if isinstance(artifacts.get("beforeBounds"), dict) else {}
    final_records = artifacts.get("finalRecords") if isinstance(artifacts.get("finalRecords"), list) else []
    final_by_id = {str(record.get("id") or ""): record for record in final_records if isinstance(record, dict)}
    relative_by_id = collect_child_relative_positions(relay_url, child_to_target)

    positions = []
    skipped = []
    for child_id, target_id in child_to_target.items():
        before = before_bounds.get(child_id)
        final_record = final_by_id.get(child_id) or {}
        after = final_record.get("bounds") if isinstance(final_record.get("bounds"), dict) else None
        relative = relative_by_id.get(child_id)
        if not isinstance(before, dict) or not isinstance(after, dict) or not relative:
            skipped.append({"nodeId": child_id, "targetParentId": target_id, "reason": "missing-bounds-or-relative-position"})
            continue

        drift_x = float(after.get("x", 0) or 0) - float(before.get("x", 0) or 0)
        drift_y = float(after.get("y", 0) or 0) - float(before.get("y", 0) or 0)
        if abs(drift_x) <= 0.01 and abs(drift_y) <= 0.01:
            continue
        positions.append({
            "nodeId": child_id,
            "x": round(relative["x"] - drift_x),
            "y": round(relative["y"] - drift_y),
        })

    summary: Dict[str, Any] = {
        "attempted": bool(positions),
        "plannedCount": len(child_to_target),
        "positionCount": len(positions),
        "skipped": skipped,
    }
    if not positions:
        summary["reason"] = "no-correctable-position"
        return summary

    fix_job = {
        "type": "FIGMA_HIERARCHY_SET_NODE_POSITIONS",
        "plan": {"positions": positions},
        "options": {"includeScreenshot": False},
    }
    fix_payload = submit_job(relay_url, fix_job, timeout, interval)
    assert_completed(fix_payload)
    fix_result = result_of_payload(fix_payload)
    summary["setPositions"] = {
        "status": fix_result.get("status"),
        "updatedCount": fix_result.get("updatedCount"),
        "summary": fix_result.get("summary"),
    }
    result["rebaseCorrection"] = summary

    if not skipped:
        checks["boundsPreserved"] = {
            "pass": True,
            "correctedByRebase": True,
            "correctedCount": len(positions),
            "previous": bounds_check,
        }
        result["blockingErrors"] = [
            error for error in (result.get("blockingErrors") or [])
            if not (isinstance(error, dict) and error.get("code") == "boundsPreserved")
        ]
        if not result.get("blockingErrors"):
            result["status"] = "completed"
            result["allPass"] = all(
                not isinstance(check, dict) or check.get("pass") is not False
                for check in checks.values()
            )
    return summary


def build_light_result_summary(result_payload: Dict[str, Any]) -> Dict[str, Any]:
    """生成轻量摘要，避免命令行输出完整节点树拖慢流程。"""
    result = result_of_payload(result_payload)
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    checks = result.get("checks") if isinstance(result.get("checks"), dict) else {}
    screenshot = result.get("screenshot") if isinstance(result.get("screenshot"), dict) else {}
    artifacts = result.get("artifacts") if isinstance(result.get("artifacts"), dict) else {}
    created_groups = artifacts.get("createdGroups") if isinstance(artifacts.get("createdGroups"), list) else []

    check_passes = {}
    for name, check in checks.items():
        if isinstance(check, dict) and "pass" in check:
            check_passes[name] = bool(check.get("pass"))

    return {
        "status": result.get("status"),
        "allPass": result.get("allPass"),
        "rootNodeId": result.get("rootNodeId"),
        "rootName": result.get("rootName"),
        "nodeType": result.get("nodeType"),
        "summary": summary,
        "checkPasses": check_passes,
        "warningCount": len(result.get("warnings") or []),
        "blockingErrorCount": len(result.get("blockingErrors") or []),
        "warnings": result.get("warnings") or [],
        "blockingErrors": result.get("blockingErrors") or [],
        "createdGroups": [
            {
                "id": group.get("id"),
                "name": group.get("name"),
                "childCount": group.get("childCount"),
            }
            for group in created_groups
            if isinstance(group, dict)
        ],
        "screenshot": {
            "present": bool(screenshot),
            "path": screenshot.get("path"),
            "byteLength": screenshot.get("byteLength"),
        },
    }


def print_result_summary(
    command: str,
    output_path: Path,
    elapsed_seconds: float,
    result_payload: Dict[str, Any],
    verbose_result: bool,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """打印稳定的小体积执行摘要，必要时可附带完整 result。"""
    payload: Dict[str, Any] = {
        "status": "completed",
        "command": command,
        "output": output_path.as_posix(),
        "elapsedSeconds": round(elapsed_seconds, 3),
        "resultSummary": build_light_result_summary(result_payload),
    }
    if extra:
        payload.update(extra)
    if verbose_result:
        payload["result"] = result_payload.get("result", {})
    print("[SUMMARY_JSON]")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def run_health(args: argparse.Namespace) -> int:
    """只检查 figmaMcpRelay 本地 companion。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    payload = ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    print("[SUMMARY_JSON]")
    print(json.dumps({
        "status": "ok",
        "relayUrl": relay_url,
        "elapsedSeconds": round(time.perf_counter() - started_at, 3),
        "health": payload,
    }, ensure_ascii=False, indent=2))
    return 0


def run_analyze(args: argparse.Namespace) -> int:
    """提交只读分析任务并保存结果。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    target = extract_figma_target(args.figma_url, args.node_id, args.file_key)
    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout, node_id=target.get("nodeId", ""))

    job = {
        "schemaVersion": 1,
        "type": "FIGMA_HIERARCHY_CLEANUP_ANALYZE",
        "name": args.job_name,
        "target": target,
        "options": {
            "includeHidden": bool(args.include_hidden),
            "includeScreenshot": not args.no_screenshot,
            "maxDepth": args.max_depth,
        },
        "assets": [],
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "analysis")
    write_json(output_path, analysis_output_payload(result_payload))
    print_result_summary(
        "analyze",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
    )
    return 0


def run_apply(args: argparse.Namespace) -> int:
    """提交用户确认后的层级整理任务并保存结果。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    plan_path = args.plan.resolve()
    if not plan_path.is_file():
        raise FileNotFoundError(f"找不到整理计划：{plan_path}")
    plan = load_json(plan_path)
    target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    node_id = str(target.get("nodeId") or "")
    if not node_id:
        raise ValueError("整理计划缺少 target.nodeId")

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout, node_id=target.get("nodeId", ""))
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_HIERARCHY_CLEANUP_APPLY",
        "name": args.job_name,
        "target": {"nodeId": node_id},
        "plan": plan,
        "options": {"includeScreenshot": not args.no_screenshot},
        "assets": [],
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "apply")
    write_json(output_path, result_payload)
    print_result_summary(
        "apply",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"plan": plan_path.as_posix()},
    )
    return 0


def run_wrap_chain(args: argparse.Namespace) -> int:
    """Submit a confirmed wrapper-chain job."""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    target = extract_figma_target(args.figma_url, args.node_id, args.file_key)
    if not target.get("nodeId"):
        raise ValueError("wrap-chain missing target.nodeId")
    wrapper_chain = [part.strip() for part in args.wrapper_chain.replace("/", ">").split(">") if part.strip()]
    if len(wrapper_chain) < 2:
        raise ValueError("wrap-chain requires at least two node names")

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout, node_id=target.get("nodeId", ""))
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_HIERARCHY_WRAP_CHAIN",
        "name": args.job_name,
        "target": target,
        "wrapperChain": wrapper_chain,
        "options": {"includeScreenshot": not args.no_screenshot},
        "assets": [],
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "wrap_chain")
    write_json(output_path, result_payload)
    print_result_summary(
        "wrap-chain",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"wrapperChain": wrapper_chain},
    )
    return 0


def run_screenshot(args: argparse.Namespace) -> int:
    """Export a target node screenshot without full hierarchy analysis."""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    target = extract_figma_target(args.figma_url, args.node_id, args.file_key)
    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout, node_id=target.get("nodeId", ""))
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_EXPORT_NODE_SCREENSHOT",
        "name": args.job_name,
        "target": target,
        "options": {},
        "assets": [],
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "screenshot")
    write_json(output_path, result_payload)
    print_result_summary(
        "screenshot",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
    )
    return 0


def run_reorder(args: argparse.Namespace) -> int:
    """提交用户确认后的直接子节点重排任务并保存结果。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    plan_path = args.plan.resolve()
    if not plan_path.is_file():
        raise FileNotFoundError(f"找不到重排计划：{plan_path}")
    plan = load_json(plan_path)
    target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    node_id = str(target.get("nodeId") or args.node_id or "")
    if not node_id:
        raise ValueError("重排计划缺少 target.nodeId")
    child_node_ids = plan.get("childNodeIds")
    if not isinstance(child_node_ids, list) or not child_node_ids:
        raise ValueError("重排计划缺少 childNodeIds")

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout, node_id=target.get("nodeId", ""))
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_HIERARCHY_REORDER_CHILDREN",
        "name": args.job_name,
        "target": {"nodeId": node_id},
        "plan": plan,
        "options": {"includeScreenshot": not args.no_screenshot},
        "assets": [],
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "reorder")
    write_json(output_path, result_payload)
    print_result_summary(
        "reorder",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"plan": plan_path.as_posix()},
    )
    return 0


def run_move_nodes(args: argparse.Namespace) -> int:
    """提交跨父级节点移动任务并保存结果。

    支持 --rebase：移动后根据子节点移动前的绝对坐标和父节点的实际绝对坐标，
    重算子节点相对位置，避免因父节点位置变化导致的坐标偏移。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    plan_path = args.plan.resolve()
    plan = load_json(plan_path) if plan_path.is_file() else {}
    moves = json.loads(args.moves) if args.moves else plan.get("moves", [])
    source_node_id = args.source_node_id or plan.get("sourceNodeId", "")
    if not source_node_id:
        raise ValueError("move-nodes 需要 --source-node-id 或 plan 中的 sourceNodeId")
    if not moves:
        raise ValueError("move-nodes 需要 --moves JSON 或 plan 中的 moves")

    rebase = args.rebase
    child_to_target: Dict[str, str] = {}
    if rebase:
        for move in moves:
            target_parent_id = str(move.get("targetParentId") or "")
            for child_id in move.get("childIds", []) or []:
                child_to_target[str(child_id)] = target_parent_id

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout, node_id=source_node_id)
    job = {
        "type": "FIGMA_HIERARCHY_MOVE_NODES",
        "plan": {
            "sourceNodeId": source_node_id,
            "removeEmptySource": False,
            "moves": moves,
        },
        "options": {"includeScreenshot": not args.no_screenshot},
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    try:
        assert_completed(result_payload)
    except McpRelayError:
        if not rebase:
            raise
        rebase_summary = apply_move_rebase_correction(
            relay_url,
            result_payload,
            child_to_target,
            args.timeout,
            args.interval,
        )
        if rebase_summary.get("attempted"):
            assert_completed(result_payload)
        else:
            raise

    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "move-nodes")
    write_json(output_path, result_payload)
    print_result_summary(
        "move-nodes",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"moves": len(moves), "rebase": rebase},
    )
    return 0


def run_set_positions(args: argparse.Namespace) -> int:
    """提交节点位置设定任务并保存结果。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    plan_path = args.plan.resolve()
    plan = load_json(plan_path) if plan_path.is_file() else {}
    positions = json.loads(args.positions) if args.positions else plan.get("positions", [])
    if not positions:
        raise ValueError("set-positions 需要 --positions JSON 或 plan 中的 positions")

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    job = {
        "type": "FIGMA_HIERARCHY_SET_NODE_POSITIONS",
        "plan": {"positions": positions},
        "options": {"includeScreenshot": not args.no_screenshot},
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "set-positions")
    write_json(output_path, result_payload)
    print_result_summary(
        "set-positions",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"positions": len(positions)},
    )
    return 0


def run_calculate_union(args: argparse.Namespace) -> int:
    """从 analyze JSON 计算子节点 UNION 包围盒的绝对坐标。

    用于确定创建 ComponentSet 前 FRAME 应放置的正确位置。
    Figma 中 node.x/y 是相对父节点的坐标，此命令同时输出相对坐标。
    """
    src_path = args.plan.resolve() if args.plan and args.plan.is_file() else args.output
    if not src_path or not src_path.is_file():
        raise FileNotFoundError(f"需要 --plan 或 --output 指向 analyze 结果 JSON")
    data = load_json(src_path)
    children = data.get("result", {}).get("directChildren", [])
    if not children:
        children = data.get("directChildren", [])
    if not children:
        raise ValueError(f"未找到 directChildren：{src_path}")

    parent_x = args.parent_x if args.parent_x is not None else 0
    parent_y = args.parent_y if args.parent_y is not None else 0
    selected = [int(i) for i in args.indices.split(",") if i.strip()] if args.indices else list(range(len(children)))

    results = []
    for idx in selected:
        if idx < 0 or idx >= len(children):
            print(f"  [警告] 索引 {idx} 超出范围 (0-{len(children)-1})", file=sys.stderr)
            continue
        c = children[idx]
        b = c.get("bounds", {})
        if not b:
            print(f"  [警告] 索引 {idx} 缺少 bounds", file=sys.stderr)
            continue
        rx = round(b.get("x", 0) - parent_x)
        ry = round(b.get("y", 0) - parent_y)
        rw = round(b.get("width", 0))
        rh = round(b.get("height", 0))
        results.append({
            "idx": idx,
            "nodeId": str(c.get("id") or ""),
            "name": c.get("name", "?"),
            "type": c.get("type", "?"),
            "absolute": {"x": round(b.get("x", 0)), "y": round(b.get("y", 0))},
            "relative": {"x": rx, "y": ry},
            "size": {"width": rw, "height": rh},
        })

    if not results:
        print("无有效数据", file=sys.stderr)
        return 1

    # UNION
    all_rx = [r["relative"]["x"] for r in results]
    all_ry = [r["relative"]["y"] for r in results]
    all_right = [r["relative"]["x"] + r["size"]["width"] for r in results]
    all_bottom = [r["relative"]["y"] + r["size"]["height"] for r in results]
    ux = min(all_rx)
    uy = min(all_ry)
    uw = max(all_right) - ux
    uh = max(all_bottom) - uy

    output = {
        "childCount": len(results),
        "parentAbsolute": {"x": parent_x, "y": parent_y},
        "union": {
            "relative": {"x": ux, "y": uy, "width": uw, "height": uh},
            "absolute": {"x": round(ux + parent_x), "y": round(uy + parent_y), "width": uw, "height": uh},
        },
        "setPositionsPayload": [
            {
                "nodeId": r["nodeId"],
                "x": r["relative"]["x"],
                "y": r["relative"]["y"],
            }
            for r in results
            if r.get("nodeId")
        ],
        "children": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


def run_query_selection(args: argparse.Namespace) -> int:
    """查询当前 Figma 选择并保存结果，供用户确认手动 ComponentSet 来源。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    result_payload = submit_query_selection(relay_url, args.timeout, args.interval)
    result = result_payload.get("result")
    if not isinstance(result, dict) or result.get("status") != "completed":
        raise McpRelayError(f"查询 Figma 当前选择失败：{result}")
    output_path = args.output.resolve()
    write_json(output_path, result_payload)
    print_result_summary(
        "query-selection",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
    )
    return 0


def parse_variant_values(raw_values: str) -> list[str]:
    """解析逗号分隔的变体值，用于手动选择模式。"""
    return [item.strip() for item in raw_values.split(",") if item.strip()]


def build_selection_variants(values: list[str], property_name: str) -> list[Dict[str, Any]]:
    """根据用户给定的变体值生成选择顺序对应的 variants 计划。"""
    variants: list[Dict[str, Any]] = []
    for index, value in enumerate(values):
        variants.append({
            "value": value,
            "properties": {property_name: value},
        })
    return variants


def build_component_set_job(plan_or_job: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    """根据纯计划或完整 job 构建 ComponentSet 变体创建任务。"""
    if not isinstance(plan_or_job, dict):
        raise ValueError("ComponentSet 计划必须是 JSON 对象")

    is_full_job = plan_or_job.get("type") == "FIGMA_CREATE_COMPONENT_SET_VARIANTS"
    if is_full_job:
        job = dict(plan_or_job)
        plan = job.get("plan") if isinstance(job.get("plan"), dict) else {}
        target = job.get("target") if isinstance(job.get("target"), dict) else {}
    else:
        plan = plan_or_job
        target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
        job = {
            "schemaVersion": 1,
            "type": "FIGMA_CREATE_COMPONENT_SET_VARIANTS",
            "name": args.job_name,
            "target": {},
            "plan": plan,
            "options": {},
            "assets": [],
        }

    if args.from_selection:
        property_name = args.variant_property.strip() or str(plan.get("variantProperty") or "State")
        values = parse_variant_values(args.variant_values)
        if values:
            plan["variants"] = build_selection_variants(values, property_name)
        plan["source"] = "selection"
        plan["variantProperty"] = property_name
        plan["componentSetName"] = args.component_set_name.strip() or str(plan.get("componentSetName") or "ManualSelectionSet")
        job["source"] = "selection"
        job["target"] = {"source": "selection"}
        job["plan"] = plan
        options = job.get("options") if isinstance(job.get("options"), dict) else {}
        options["includeScreenshot"] = not args.no_screenshot
        job["options"] = options
        job["schemaVersion"] = job.get("schemaVersion") or 1
        job["type"] = "FIGMA_CREATE_COMPONENT_SET_VARIANTS"
        job["name"] = job.get("name") or args.job_name
        job["assets"] = job.get("assets") if isinstance(job.get("assets"), list) else []
        return job

    plan_target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    node_id = str(target.get("nodeId") or plan_target.get("nodeId") or "")
    if not node_id and (args.figma_url or args.node_id):
        node_id = extract_figma_target(args.figma_url, args.node_id, args.file_key)["nodeId"]
    if not node_id:
        raise ValueError("ComponentSet 计划缺少 target.nodeId，请在计划中填写或通过 --node-id/--figma-url 提供")

    variants = plan.get("variants") if isinstance(plan, dict) else None
    if not isinstance(variants, list) or not variants:
        raise ValueError("ComponentSet 计划缺少非空 variants")

    options = job.get("options") if isinstance(job.get("options"), dict) else {}
    options["includeScreenshot"] = not args.no_screenshot
    job["schemaVersion"] = job.get("schemaVersion") or 1
    job["type"] = "FIGMA_CREATE_COMPONENT_SET_VARIANTS"
    job["name"] = job.get("name") or args.job_name
    job["target"] = {**target, "nodeId": node_id}
    plan["target"] = {**plan_target, "nodeId": node_id}
    job["plan"] = plan
    job["options"] = options
    job["assets"] = job.get("assets") if isinstance(job.get("assets"), list) else []
    return job


def run_component_set(args: argparse.Namespace) -> int:
    """提交用户确认后的 ComponentSet 变体创建任务并保存结果。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    plan_path: Optional[Path] = None
    if args.from_selection:
        plan_or_job: Dict[str, Any] = {
            "source": "selection",
            "componentSetName": args.component_set_name.strip() or "ManualSelectionSet",
            "variantProperty": args.variant_property.strip() or "State",
            "replaceOriginalsWithInstances": False,
            "createBackup": False,
        }
    else:
        plan_path = args.plan.resolve()
        if not plan_path.is_file():
            raise FileNotFoundError(f"找不到 ComponentSet 计划：{plan_path}")
        plan_or_job = load_json(plan_path)
    job = build_component_set_job(plan_or_job, args)

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "component_set")
    write_json(output_path, result_payload)
    print_result_summary(
        "component-set",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"plan": plan_path.as_posix() if plan_path else "selection"},
    )
    return 0


def build_component_set_add_variants_job(args: argparse.Namespace) -> Dict[str, Any]:
    """根据当前选择和已有 ComponentSet id 构建追加变体任务。"""
    component_set_id = args.component_set_id.strip()
    if not component_set_id:
        raise ValueError("追加变体必须提供 --component-set-id")
    property_name = args.variant_property.strip() or "State"
    values = parse_variant_values(args.variant_values)
    plan: Dict[str, Any] = {
        "source": "selection",
        "target": {"componentSetId": component_set_id},
        "variantProperty": property_name,
    }
    if values:
        plan["variants"] = build_selection_variants(values, property_name)
    return {
        "schemaVersion": 1,
        "type": "FIGMA_ADD_COMPONENT_SET_VARIANTS",
        "name": args.job_name,
        "source": "selection",
        "target": {"componentSetId": component_set_id},
        "plan": plan,
        "options": {"includeScreenshot": not args.no_screenshot},
        "assets": [],
    }


def run_component_set_add_variants(args: argparse.Namespace) -> int:
    """把当前选择节点追加到已有 ComponentSet 中作为新变体。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    job = build_component_set_add_variants_job(args)
    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "component_set_add_variants")
    write_json(output_path, result_payload)
    print_result_summary(
        "component-set-add-variants",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"componentSetId": args.component_set_id.strip()},
    )
    return 0


def build_component_from_selection_job(args: argparse.Namespace) -> Dict[str, Any]:
    """构建从当前选择克隆生成普通 Component 的任务。"""
    component_name = args.component_name.strip() or "ManualSelectionComponent"
    return {
        "schemaVersion": 1,
        "type": "FIGMA_CREATE_COMPONENT_FROM_SELECTION",
        "name": args.job_name,
        "source": "selection",
        "plan": {
            "source": "selection",
            "componentName": component_name,
            "cloneSource": True,
        },
        "options": {"includeScreenshot": not args.no_screenshot},
        "assets": [],
    }


def run_component_from_selection(args: argparse.Namespace) -> int:
    """把当前选择克隆合成为一个普通 Component，源节点保持不动。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    job = build_component_from_selection_job(args)
    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "component_from_selection")
    write_json(output_path, result_payload)
    print_result_summary(
        "component-from-selection",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"componentName": args.component_name.strip() or "ManualSelectionComponent"},
    )
    return 0


def build_rebuild_component_set_from_siblings_job(args: argparse.Namespace) -> Dict[str, Any]:
    """构建基于当前选中节点同级重建 ComponentSet 并替换实例的任务。"""
    component_set_name = args.component_set_name.strip() or "Item"
    property_name = args.variant_property.strip() or "State"
    plan: Dict[str, Any] = {
        "source": "selected-siblings",
        "componentSetName": component_set_name,
        "variantProperty": property_name,
        "replaceOriginalsWithInstances": True,
        "createBackup": True,
    }
    return {
        "schemaVersion": 1,
        "type": "FIGMA_REBUILD_COMPONENT_SET_FROM_SIBLINGS",
        "name": args.job_name,
        "source": "selection",
        "target": {"source": "selected-siblings"},
        "plan": plan,
        "options": {"includeScreenshot": not args.no_screenshot},
        "assets": [],
    }


def run_rebuild_component_set_from_siblings(args: argparse.Namespace) -> int:
    """以当前选中节点为锚点，把同父级同类节点重建为 ComponentSet 变体实例。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    job = build_rebuild_component_set_from_siblings_job(args)
    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "rebuild_component_set_from_siblings")
    write_json(output_path, result_payload)
    print_result_summary(
        "rebuild-component-set-from-siblings",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {
            "componentSetName": args.component_set_name.strip() or "Item",
            "variantProperty": args.variant_property.strip() or "State",
        },
    )
    return 0


def build_component_set_from_node_groups_job(plan_or_job: Dict[str, Any], args: argparse.Namespace) -> Dict[str, Any]:
    """根据节点组计划构建跨父级节点组 ComponentSet 任务。"""
    if not isinstance(plan_or_job, dict):
        raise ValueError("节点组 ComponentSet 计划必须是 JSON 对象")

    if plan_or_job.get("type") == "FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS":
        job = dict(plan_or_job)
        plan = job.get("plan") if isinstance(job.get("plan"), dict) else {}
        target = job.get("target") if isinstance(job.get("target"), dict) else {}
    else:
        plan = plan_or_job
        target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
        job = {
            "schemaVersion": 1,
            "type": "FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS",
            "name": args.job_name,
            "target": {},
            "plan": plan,
            "options": {},
            "assets": [],
        }

    node_id = str(target.get("nodeId") or (plan.get("target") or {}).get("nodeId") or "")
    if not node_id and (args.figma_url or args.node_id):
        node_id = extract_figma_target(args.figma_url, args.node_id, args.file_key)["nodeId"]
    if not node_id:
        raise ValueError("节点组 ComponentSet 计划缺少 target.nodeId")

    groups = plan.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("节点组 ComponentSet 计划缺少非空 groups")

    options = job.get("options") if isinstance(job.get("options"), dict) else {}
    options["includeScreenshot"] = not args.no_screenshot
    job["schemaVersion"] = job.get("schemaVersion") or 1
    job["type"] = "FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS"
    job["name"] = job.get("name") or args.job_name
    job["target"] = {**target, "nodeId": node_id}
    plan_target = plan.get("target") if isinstance(plan.get("target"), dict) else {}
    plan["target"] = {**plan_target, "nodeId": node_id}
    job["plan"] = plan
    job["options"] = options
    job["assets"] = job.get("assets") if isinstance(job.get("assets"), list) else []
    return job


def run_component_set_from_node_groups(args: argparse.Namespace) -> int:
    """执行显式节点组 ComponentSet 创建，并把散节点替换成变体实例。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    plan_path = args.plan.resolve()
    if not plan_path.is_file():
        raise FileNotFoundError(f"找不到节点组 ComponentSet 计划：{plan_path}")
    plan_or_job = load_json(plan_path)
    job = build_component_set_from_node_groups_job(plan_or_job, args)

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    save_screenshot_if_present(result_payload, output_path, "component_set_from_node_groups")
    write_json(output_path, result_payload)
    print_result_summary(
        "component-set-from-node-groups",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"plan": plan_path.as_posix()},
    )
    return 0


def run_clone_node(args: argparse.Namespace) -> int:
    """提交 FIGMA_CLONE_NODE 任务，复制整个节点为隐藏备份。"""
    started_at = time.perf_counter()
    relay_url = args.relay_url.rstrip("/")
    node_id = args.node_id or ""
    if not node_id:
        raise ValueError("clone-node 需要 --node-id")
    offset_x = args.offset_x
    offset_y = args.offset_y
    plan = {"nodeId": node_id, "hideClone": args.hide_clone, "backupPrefix": args.backup_prefix}
    if offset_x is not None:
        plan["offsetX"] = offset_x
    if offset_y is not None:
        plan["offsetY"] = offset_y
    target = {"nodeId": node_id}
    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    job = {
        "schemaVersion": 1,
        "type": "FIGMA_CLONE_NODE",
        "name": args.job_name,
        "target": target,
        "plan": plan,
        "assets": [],
    }
    result_payload = submit_job(relay_url, job, args.timeout, args.interval)
    assert_completed(result_payload)
    output_path = args.output.resolve()
    write_json(output_path, result_payload)
    print_result_summary(
        "clone-node",
        output_path,
        time.perf_counter() - started_at,
        result_payload,
        args.verbose_result,
        {"nodeId": node_id},
    )
    return 0


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="Figma 层级整理 MCP Relay 客户端")
    parser.add_argument("command", choices=["health", "analyze", "apply", "wrap-chain", "screenshot", "reorder", "query-selection", "component-from-selection", "component-set", "component-set-add-variants", "rebuild-component-set-from-siblings", "component-set-from-node-groups", "move-nodes", "set-positions", "calculate-union", "clone-node"], help="执行动作")
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL, help="内部 runtime relay 地址")
    parser.add_argument("--bridge-url", dest="relay_url", default=DEFAULT_RELAY_URL, help=argparse.SUPPRESS)
    parser.add_argument("--startup-timeout", type=float, default=10.0, help="等待 MCP Relay 启动秒数")
    parser.add_argument("--timeout", type=float, default=300.0, help="等待 Figma 结果秒数")
    parser.add_argument("--interval", type=float, default=0.5, help="轮询间隔秒数")
    parser.add_argument("--job-name", default="Figma_Hierarchy_Cleanup", help="MCP Relay job 名称")

    parser.add_argument("--figma-url", default="", help="Figma URL，可包含 node-id")
    parser.add_argument("--file-key", default="", help="Figma file key，可选")
    parser.add_argument("--node-id", default="", help="Figma node id，可选")
    parser.add_argument("--include-hidden", action="store_true", help="分析时包含隐藏节点")
    parser.add_argument("--max-depth", type=int, default=8, help="分析节点树最大深度")
    parser.add_argument("--no-screenshot", action="store_true", help="不导出截图")
    parser.add_argument("--verbose-result", action="store_true", help="在标准输出中附带完整 result，默认只打印摘要")
    parser.add_argument("--from-selection", action="store_true", help="使用当前 Figma 选择作为 ComponentSet 源节点")
    parser.add_argument("--component-set-name", default="", help="手动选择模式下的新 ComponentSet 名称")
    parser.add_argument("--component-set-id", default="", help="追加变体时的目标 ComponentSet id")
    parser.add_argument("--component-name", default="", help="当前选择克隆生成普通 Component 的名称")
    parser.add_argument("--source-node-id", default="", help="move-nodes 的源节点（所有 move 节点的共同祖先，如 Page ID）")
    parser.add_argument("--moves", default="", help="move-nodes 的移动计划 JSON 字符串")
    parser.add_argument("--rebase", action="store_true", help="move-nodes 移动后根据子节点原绝对坐标重算相对位置，避免父节点偏移导致坐标错误")
    parser.add_argument("--positions", default="", help="set-positions 的位置计划 JSON 字符串")
    parser.add_argument("--parent-x", type=float, default=None, help="calculate-union 的父节点绝对 X")
    parser.add_argument("--parent-y", type=float, default=None, help="calculate-union 的父节点绝对 Y")
    parser.add_argument("--indices", default="", help="calculate-union 的子节点索引列表（逗号分隔），默认全部")
    parser.add_argument("--variant-property", default="State", help="变体属性名，默认 State")
    parser.add_argument("--variant-values", default="", help="按当前选择顺序匹配的逗号分隔变体值")
    parser.add_argument("--wrapper-chain", default="", help="wrap-chain nested wrapper path, for example [ListRoot]>[ScrollView]>[Viewport]>[Content]")

    parser.add_argument("--hide-clone", default=True, action=argparse.BooleanOptionalAction, help="clone-node 是否隐藏克隆副本，默认 True")
    parser.add_argument("--backup-prefix", default=True, action=argparse.BooleanOptionalAction, help="clone-node 是否添加 [Backup] 前缀，默认 True")
    parser.add_argument("--offset-x", type=float, default=None, help="clone-node 横向偏移（px），默认原节点宽度+100")
    parser.add_argument("--offset-y", type=float, default=None, help="clone-node 纵向偏移（px），默认 0")

    parser.add_argument("--plan", type=Path, default=None, help="cleanup_plan.json、reorder_plan.json 或 component_set_plan.json 路径")
    parser.add_argument("--output", type=Path, default=None, help="结果输出路径")
    parser.add_argument("--session-id", default="", help="Target Figma plugin sessionId")
    parser.add_argument("--no-preflight", action="store_true", help="Skip live plugin target preflight")
    return parser.parse_args()


def main() -> int:
    """命令行入口。"""
    args = parse_args()
    configure_target(args.file_key, args.session_id, not args.no_preflight)
    if args.plan is None:
        if args.command == "reorder":
            args.plan = DEFAULT_REORDER_PLAN_PATH
        elif args.command in ("component-set", "component-set-from-node-groups"):
            args.plan = DEFAULT_COMPONENT_SET_PLAN_PATH
        elif args.command == "move-nodes":
            args.plan = DEFAULT_MOVE_NODES_PLAN_PATH
        elif args.command == "set-positions":
            args.plan = DEFAULT_SET_POSITIONS_PLAN_PATH
        else:
            args.plan = DEFAULT_PLAN_PATH
    if args.output is None:
        if args.command == "analyze":
            args.output = DEFAULT_ANALYSIS_PATH
        elif args.command == "screenshot":
            args.output = DEFAULT_SCREENSHOT_PATH
        elif args.command == "wrap-chain":
            args.output = DEFAULT_WRAP_CHAIN_PATH
        elif args.command == "query-selection":
            args.output = DEFAULT_SELECTION_PATH
        elif args.command == "component-from-selection":
            args.output = DEFAULT_COMPONENT_FROM_SELECTION_PATH
        elif args.command == "reorder":
            args.output = DEFAULT_REORDER_PATH
        elif args.command == "component-set":
            args.output = DEFAULT_COMPONENT_SET_PATH
        elif args.command == "component-set-add-variants":
            args.output = DEFAULT_COMPONENT_SET_ADD_PATH
        elif args.command == "rebuild-component-set-from-siblings":
            args.output = DEFAULT_REBUILD_SIBLINGS_PATH
        elif args.command == "component-set-from-node-groups":
            args.output = DEFAULT_COMPONENT_SET_NODE_GROUPS_PATH
        elif args.command == "move-nodes":
            args.output = DEFAULT_MOVE_NODES_PATH
        elif args.command == "set-positions":
            args.output = DEFAULT_SET_POSITIONS_PATH
        elif args.command == "clone-node":
            args.output = Path(".tmp/figma-hierarchy-cleanup/clone_node_result.json")
        else:
            args.output = DEFAULT_APPLY_PATH
    if args.command == "health":
        return run_health(args)
    if args.command == "analyze":
        return run_analyze(args)
    if args.command == "apply":
        return run_apply(args)
    if args.command == "wrap-chain":
        return run_wrap_chain(args)
    if args.command == "screenshot":
        return run_screenshot(args)
    if args.command == "reorder":
        return run_reorder(args)
    if args.command == "query-selection":
        return run_query_selection(args)
    if args.command == "component-from-selection":
        return run_component_from_selection(args)
    if args.command == "component-set":
        return run_component_set(args)
    if args.command == "component-set-add-variants":
        return run_component_set_add_variants(args)
    if args.command == "rebuild-component-set-from-siblings":
        return run_rebuild_component_set_from_siblings(args)
    if args.command == "component-set-from-node-groups":
        return run_component_set_from_node_groups(args)
    if args.command == "move-nodes":
        return run_move_nodes(args)
    if args.command == "set-positions":
        return run_set_positions(args)
    if args.command == "calculate-union":
        return run_calculate_union(args)
    if args.command == "clone-node":
        return run_clone_node(args)
    raise ValueError(f"不支持的 command：{args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
