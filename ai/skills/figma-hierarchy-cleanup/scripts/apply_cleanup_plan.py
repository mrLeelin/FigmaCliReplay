"""Apply one already-approved CleanupPlanV2/V3 without discovering extra writes."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict

import figma_hierarchy_cleanup_cli as relay_client


DEFAULT_RELAY_URL = "http://localhost:32130"
ALLOWED_TERMINAL_STATES = {"succeeded", "rolled_back", "recovery_required", "failed"}
EXPECTED_STATUS_BY_STATE = {
    "succeeded": "completed",
    "rolled_back": "rolled_back",
    "recovery_required": "recovery_required",
    "failed": "failed",
}
FORBIDDEN_FIELD_PARTS = ("component", "variant")


def load_json(path: Path) -> Dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("cleanup transaction plan must be a JSON object")
    return value


def validate_transaction_plan(plan: Dict[str, Any]) -> Dict[str, Any]:
    if plan.get("schemaVersion") not in {2, 3}:
        raise ValueError("cleanup transaction plan schemaVersion must be 2 or 3")
    if plan.get("operation") != "figma-hierarchy-cleanup-transaction":
        raise ValueError("cleanup transaction plan operation is invalid")
    target = plan.get("target")
    if not isinstance(target, dict) or not str(target.get("nodeId") or "").strip():
        raise ValueError("cleanup transaction plan target.nodeId is required")
    snapshot_hash = str(target.get("snapshotHash") or "")
    if not re.fullmatch(r"[a-f0-9]{64}", snapshot_hash):
        raise ValueError("cleanup transaction plan target.snapshotHash must be a SHA-256 hex string")
    if not isinstance(plan.get("operations"), list):
        raise ValueError("cleanup transaction plan operations must be an array")
    if not isinstance(plan.get("verification"), dict):
        raise ValueError("cleanup transaction plan verification must be an object")
    if plan.get("createBackup") is not False:
        raise ValueError("cleanup transaction plan createBackup must be false")
    reject_forbidden_fields(plan)
    return plan


def reject_forbidden_fields(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            reject_forbidden_fields(item)
        return
    if not isinstance(value, dict):
        return
    for key, child in value.items():
        lowered = str(key).lower()
        if any(part in lowered for part in FORBIDDEN_FIELD_PARTS):
            raise ValueError(f"cleanup transaction plan contains forbidden component field: {key}")
        reject_forbidden_fields(child)


def build_transaction_job(plan: Dict[str, Any], session_id: str, job_name: str = "Approved cleanup transaction") -> Dict[str, Any]:
    validate_transaction_plan(plan)
    target = dict(plan["target"])
    target["sessionId"] = session_id
    return {
        "schemaVersion": plan["schemaVersion"],
        "type": "FIGMA_HIERARCHY_CLEANUP_TRANSACTION",
        "name": job_name,
        "sessionId": session_id,
        "target": target,
        "plan": plan,
        "options": {},
        "assets": [],
    }


def normalize_transaction_report(result_payload: Dict[str, Any]) -> Dict[str, Any]:
    result = relay_client.result_of_payload(result_payload)
    if not isinstance(result, dict):
        raise RuntimeError("cleanup transaction result is missing")
    state = str(result.get("state") or "")
    if state not in ALLOWED_TERMINAL_STATES:
        raise RuntimeError(f"invalid cleanup transaction state: {state or 'missing'}")
    status = str(result.get("status") or "")
    if status != EXPECTED_STATUS_BY_STATE[state]:
        raise RuntimeError(f"cleanup transaction status is {status or 'missing'}")
    return {
        "status": status,
        "state": state,
        "checks": result.get("checks") if isinstance(result.get("checks"), dict) else {},
        "rollback": result.get("rollback") if isinstance(result.get("rollback"), dict) else {},
        "errors": result.get("errors") if isinstance(result.get("errors"), list) else [],
        "result": result,
    }


def emit_progress(state: str, message: str, **extra: Any) -> None:
    print(json.dumps({"state": state, "message": message, **extra}, ensure_ascii=False), flush=True)


def write_report(path: Path, report: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--interval", type=float, default=0.2)
    parser.add_argument("--job-name", default="Approved cleanup transaction")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started = time.perf_counter()
    try:
        plan = validate_transaction_plan(load_json(args.plan.resolve()))
        relay_client.configure_target(session_id=args.session_id)
        job = build_transaction_job(plan, args.session_id, args.job_name)
        emit_progress("applying", "正在提交已验证的整理事务。", completed=0, total=len(plan["operations"]))
        result_payload = relay_client.submit_job(args.relay_url, job, args.timeout, args.interval)
        report = normalize_transaction_report(result_payload)
        report["elapsedSeconds"] = round(time.perf_counter() - started, 3)
        write_report(args.output.resolve(), report)
        state_text = {"succeeded": "成功", "rolled_back": "已回滚", "recovery_required": "需要恢复"}.get(report["state"], str(report["state"]))
        emit_progress(report["state"], f"整理事务执行结束：{state_text}。")
        return 0 if report["state"] in {"succeeded", "rolled_back"} else 1
    except Exception as error:
        report = {
            "status": "failed",
            "state": "failed",
            "checks": {},
            "rollback": {},
            "errors": [str(error)],
            "elapsedSeconds": round(time.perf_counter() - started, 3),
        }
        write_report(args.output.resolve(), report)
        emit_progress("failed", str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
