"""Prefab import algorithms, independent of the retired HTTP server."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PREFAB_TO_FIGMA_SCRIPT_DIR = PLUGIN_ROOT / "ai" / "skills" / "prefab-to-figma" / "scripts"
PREFAB_TO_FIGMA_TMP_DIR = PLUGIN_ROOT / ".tmp" / "prefab-to-figma" / "plugin-import"


@dataclass
class PrefabImportTask:
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


class ImportState:
    def __init__(self, task: PrefabImportTask, progress) -> None:
        self.task = task
        self.progress = progress

    def get_prefab_import_task(self, task_id: str) -> Optional[PrefabImportTask]:
        return self.task if self.task.task_id == task_id else None

    def update_prefab_import_task(self, task_id: str, **changes) -> None:
        task = self.get_prefab_import_task(task_id)
        if task is None:
            raise ValueError("Unknown import task")
        log = changes.pop("log", None)
        error = changes.pop("error", None)
        if log:
            task.logs = (task.logs + [log])[-80:]
        if error:
            task.errors.append(error)
        for key, value in changes.items():
            if value is not None:
                setattr(task, key, value)
        task.percent = max(0, min(100, int(task.percent)))
        task.updated_at = time.time()
        self.progress(serialize_prefab_import_task(task))


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


def run_prefab_to_figma_import_task(state: ImportState, task_id: str, relay_url: str) -> None:
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
                    session_id=str(payload.get("sessionId") or ""),
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
    state: ImportState,
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
    session_id: str,
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
    relay_result_path = out_dir / "prefab_to_figma_relay_result.json"
    run_checked_command(state, task_id, [
        sys.executable,
        str(PREFAB_TO_FIGMA_SCRIPT_DIR / "prefab_to_figma_cli.py"),
        "--package",
        str(package_path),
        "--write-plan",
        str(out_dir / "figma_write_plan.json"),
        "--result",
        str(relay_result_path),
        "--project-root",
        str(unity_project_root),
        "--relay-url",
        relay_url,
        "--session-id",
        session_id,
        "--file-key",
        file_key,
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


def run_checked_command(state: ImportState, task_id: str, command: List[str], cwd: Path) -> None:
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
