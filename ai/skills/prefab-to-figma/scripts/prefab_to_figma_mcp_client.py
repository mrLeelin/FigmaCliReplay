#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Prefab To Figma 专用 MCP 命令行 wrapper。

职责：
- 通过 figmaMcpRelay 连接已启动的本地 companion。
- 读取 prefab-to-figma 导出包和 figma_write_plan。
- 把图片资源路径通过 MCP 提交给 Figma 插件，由插件下载字节并写入 Figma。
- 保存插件返回的结构化写入结果、统一审核报告和截图。

注意：
- 本脚本只负责请求编排、资源路径映射和结果落盘。
- Figma Desktop 必须打开目标文件，并运行 figma-mcp-relay 插件。
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any


DEFAULT_RELAY_URL = "http://localhost:32130"
def find_project_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".figma" / "plugins" / "figma-mcp-relay").is_dir() and (parent / "JellybeanUnity").is_dir():
            return parent
    raise RuntimeError("Unable to locate the JellybeanUnity repository root.")


PROJECT_ROOT = find_project_root()
MCP_CLIENT_DIR = PROJECT_ROOT / ".figma" / "plugins" / "figma-mcp-relay" / "client"
DEFAULT_PACKAGE_PATH = Path(".tmp/prefab-to-figma/Panel/prefab-to-figma.json")
DEFAULT_WRITE_PLAN_PATH = Path(".tmp/prefab-to-figma/Panel/figma_write_plan.json")
DEFAULT_RESULT_PATH = Path(".tmp/prefab-to-figma/Panel/prefab_to_figma_mcp_result.json")
DEFAULT_WRITE_RESULT_NAME = "figma_write_result.json"
DEFAULT_VERIFY_REPORT_NAME = "figma_write_verify_report.json"
REQUIRED_WRITE_READBACK_CHECKS = {
    "nodeCount",
    "imageFillHashLength",
    "imageLayerVisual",
    "unityNodeGeometry",
    "unityNodeOrder",
    "unityNodeState",
    "tmpMaterialPluginData",
    "textOutlineStroke",
    "prefabInstanceNodeType",
    "prefabInstanceGeometry",
    "nineSliceSourceImageMetadata",
    "componentModeResult",
    "screenshotAcceptance",
    "fontConsistency",
}

if str(MCP_CLIENT_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_CLIENT_DIR))

from figma_mcp_client import health as mcp_health, submit_job as mcp_submit_job  # noqa: E402


def load_json(path: Path) -> dict[str, Any]:
    """读取 UTF-8 或 UTF-8-BOM JSON 文件。"""

    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """按 UTF-8 写入 JSON 文件，并自动创建父目录。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_mcp_companion(relay_url: str, startup_timeout: float = 10.0) -> dict[str, Any]:
    """确保 figmaMcpRelay 本地 companion 可用，并返回 health 信息。"""

    del startup_timeout
    return mcp_health(relay_url=relay_url.rstrip("/"))


def build_job(
    package_path: Path,
    write_plan_path: Path,
    component_mode: str,
    job_name: str,
    job_type: str = "PREFAB_TO_FIGMA_WRITE",
    project_root: Path = PROJECT_ROOT,
) -> tuple[dict[str, Any], dict[str, Path]]:
    """根据导出包和写入计划构建 MCP Relay job 与 assetPaths。"""

    package = load_json(package_path)
    write_plan = load_json(write_plan_path)

    # 移除 missingSprite 节点的 image 数据，避免 MCP Relay 尝试上传不存在的图片
    for node in package.get("nodes") or []:
        img = node.get("image") if isinstance(node, dict) else None
        if isinstance(img, dict) and img.get("missingSprite"):
            node.pop("image", None)

    figma_payload = write_plan.get("figma") or {}
    target_node_id = str(figma_payload.get("targetNodeId") or "")

    resolved_component_mode = component_mode or str(write_plan.get("componentMode") or "component")
    nested_prefab_component_mode = str(write_plan.get("nestedPrefabComponentMode") or "all")
    assets, asset_paths = build_asset_entries(package, write_plan, package_path, project_root)
    return {
        "schemaVersion": 1,
        "task": "prefab-to-figma-write",
        "type": job_type,
        "name": job_name,
        "target": {"nodeId": target_node_id},
        "packagePath": package_path.as_posix(),
        "writePlanPath": write_plan_path.as_posix(),
        "package": package,
        "writePlan": write_plan,
        "componentMode": resolved_component_mode,
        "nestedPrefabComponentMode": nested_prefab_component_mode,
        "assets": assets,
    }, asset_paths


def build_asset_entries(
    package: dict[str, Any],
    write_plan: dict[str, Any],
    package_path: Path,
    project_root: Path,
) -> tuple[list[dict[str, str]], dict[str, Path]]:
    """从导出包和写入计划中收集图片资源路径，供 MCP server 暴露给插件。"""

    asset_sources: dict[str, str] = {}
    operations = write_plan.get("operations") or {}
    for item in operations.get("imageUploads") or []:
        asset_id = str(item.get("asset") or "")
        asset_path = str(item.get("assetPath") or "")
        if asset_id and asset_path:
            asset_sources[asset_id] = asset_path

    package_assets = package.get("assets") or {}
    for asset_id, asset_info in _iter_package_assets(package):
        if not isinstance(asset_info, dict):
            continue
        asset_path = str(asset_info.get("assetPath") or "")
        if asset_path and str(asset_id) not in asset_sources:
            asset_sources[str(asset_id)] = asset_path

    assets: list[dict[str, str]] = []
    asset_paths: dict[str, Path] = {}
    for asset_id, raw_path in sorted(asset_sources.items()):
        resolved = resolve_asset_path(raw_path, package_path.parent, project_root)
        staged = stage_asset_file(asset_id, resolved, package_path.parent)
        assets.append({
            "id": asset_id,
            "path": staged.as_posix(),
        })
        asset_paths[asset_id] = staged
    return assets, asset_paths


def stage_asset_file(asset_id: str, source: Path, package_dir: Path) -> Path:
    """Copy an image into the package-local .tmp staging area allowed by MCP Relay."""

    suffix = source.suffix if source.suffix else ".png"
    staging_dir = package_dir / "_mcp_asset_staging"
    staging_dir.mkdir(parents=True, exist_ok=True)
    staged = staging_dir / f"{asset_id}{suffix.lower()}"
    if not staged.exists() or staged.stat().st_size != source.stat().st_size:
        shutil.copy2(source, staged)
    return staged.resolve()


def _iter_package_assets(package: dict[str, Any]):
    """遍历主包和嵌套 Prefab 包里的所有图片资源。"""

    for asset_id, asset_info in (package.get("assets") or {}).items():
        yield asset_id, asset_info
    for nested_package in _iter_nested_prefab_packages(package):
        for asset_id, asset_info in (nested_package.get("assets") or {}).items():
            yield asset_id, asset_info


def _iter_nested_prefab_packages(package: dict[str, Any]):
    """深度遍历 nestedPrefabPackages，避免子 Prefab 图片漏传给 MCP Relay。"""

    nested = package.get("nestedPrefabPackages") or {}
    if isinstance(nested, dict):
        values = nested.values()
    elif isinstance(nested, list):
        values = nested
    else:
        values = []
    for nested_package in values:
        if not isinstance(nested_package, dict):
            continue
        yield nested_package
        yield from _iter_nested_prefab_packages(nested_package)


def resolve_asset_path(raw_path: str, package_dir: Path, project_root: Path) -> Path:
    """把导出包中的图片相对路径解析为本地绝对路径。"""

    candidate = Path(raw_path)
    candidates = []
    if candidate.is_absolute():
        candidates.append(candidate)
    else:
        candidates.append((project_root / candidate).resolve())
        candidates.append((package_dir / candidate).resolve())
        if not str(candidate).replace("\\", "/").startswith("JellybeanUnity/"):
            candidates.append((project_root / "JellybeanUnity" / candidate).resolve())

    for item in candidates:
        if item.exists():
            return item
    raise FileNotFoundError(f"图片资源不存在：{raw_path}")


def save_screenshot_if_present(result_payload: dict[str, Any], result_path: Path) -> None:
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
    file_name = str(screenshot.get("fileName") or f"{result.get('rootNodeId', 'screenshot')}.png")
    safe_file_name = file_name.replace(":", "_").replace("\\", "_").replace("/", "_")
    screenshot_path = screenshot_dir / safe_file_name
    screenshot_path.write_bytes(base64.b64decode(str(raw_base64)))
    screenshot["path"] = screenshot_path.as_posix()
    screenshot.pop("base64", None)


def build_verify_report(result_payload: dict[str, Any], request_id: str, artifacts: dict[str, str]) -> dict[str, Any]:
    """把插件执行结果归一化为 LLM 审核用的统一报告。"""

    result = result_payload.get("result") if isinstance(result_payload, dict) else {}
    if not isinstance(result, dict):
        result = {}
    blocking_errors = result.get("blockingErrors") if isinstance(result.get("blockingErrors"), list) else []
    warnings = result.get("warnings") if isinstance(result.get("warnings"), list) else []
    checks = result.get("checks") if isinstance(result.get("checks"), dict) else {}
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    readback_gate = validate_required_readback_checks(checks)
    if not readback_gate["pass"]:
        blocking_errors = [*blocking_errors, {
            "code": "requiredReadbackChecks",
            "message": "Figma write result is missing required deterministic readback checks.",
            "details": readback_gate["details"],
        }]
    all_pass = bool(result.get("allPass")) and not blocking_errors
    merged_artifacts = dict(result.get("artifacts") or {})
    merged_artifacts.update(artifacts)
    merged_artifacts["requestId"] = request_id
    return {
        "allPass": all_pass,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "summary": summary,
        "checks": checks,
        "artifacts": merged_artifacts,
    }


def validate_required_readback_checks(checks: dict[str, Any]) -> dict[str, Any]:
    """Ensure the active Figma plugin validates layout, layers, images, and state."""

    missing = sorted(name for name in REQUIRED_WRITE_READBACK_CHECKS if name not in checks)
    failed = sorted(
        name for name, value in checks.items()
        if name in REQUIRED_WRITE_READBACK_CHECKS and isinstance(value, dict) and value.get("pass") is not True
    )
    details: list[dict[str, Any]] = []
    if missing:
        details.append({"reason": "missing_required_checks", "checks": missing})
    if failed:
        details.append({"reason": "failed_required_checks", "checks": failed})
    return {
        "pass": not missing and not failed,
        "details": details,
    }


def run_health(args: argparse.Namespace) -> int:
    """只检查 figmaMcpRelay 本地 companion。"""

    relay_url = args.relay_url.rstrip("/")
    payload = ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    print(json.dumps({
        "status": "ok",
        "relayUrl": relay_url,
        "health": payload,
    }, ensure_ascii=False, indent=2))
    return 0


def run_export(args: argparse.Namespace) -> int:
    """提交 prefab-to-figma 写入任务并保存结果。"""

    relay_url = args.relay_url.rstrip("/")
    package_path = args.package.resolve()
    write_plan_path = args.write_plan.resolve()
    result_path = args.result.resolve()
    write_result_path = args.write_result.resolve() if args.write_result else result_path.parent / DEFAULT_WRITE_RESULT_NAME
    verify_report_path = args.verify_report.resolve() if args.verify_report else result_path.parent / DEFAULT_VERIFY_REPORT_NAME
    if not package_path.exists():
        raise FileNotFoundError(f"导出包不存在：{package_path}")
    if not write_plan_path.exists():
        raise FileNotFoundError(f"写入计划不存在：{write_plan_path}")

    job, asset_paths = build_job(package_path, write_plan_path, args.component_mode, args.job_name, args.job_type)
    job["relayUrl"] = relay_url
    if args.job_output:
        write_json(args.job_output.resolve(), {"job": job, "assetPaths": {key: value.as_posix() for key, value in asset_paths.items()}})
    if args.dry_run:
        print(json.dumps({
            "status": "dry-run",
            "jobType": job["type"],
            "assetCount": len(asset_paths),
            "jobOutput": args.job_output.as_posix() if args.job_output else "",
        }, ensure_ascii=False, indent=2))
        return 0

    ensure_mcp_companion(relay_url, startup_timeout=args.startup_timeout)
    request_id = str(uuid.uuid4())
    result_payload = mcp_submit_job(
        job,
        {key: value.as_posix() for key, value in asset_paths.items()},
        relay_url=relay_url,
        request_id=request_id,
        wait=True,
        timeout=args.timeout,
    )
    save_screenshot_if_present(result_payload, result_path)
    write_json(result_path, result_payload)

    write_result = result_payload.get("result") if isinstance(result_payload.get("result"), dict) else {}
    write_json(write_result_path, write_result)
    verify_report = build_verify_report(result_payload, request_id, {
        "mcpResultPath": result_path.as_posix(),
        "writeResultPath": write_result_path.as_posix(),
        "verifyReportPath": verify_report_path.as_posix(),
        "packagePath": package_path.as_posix(),
        "writePlanPath": write_plan_path.as_posix(),
    })
    write_json(verify_report_path, verify_report)

    print(json.dumps({
        "status": write_result.get("status", "unknown"),
        "allPass": verify_report.get("allPass", False),
        "requestId": request_id,
        "assetCount": len(asset_paths),
        "resultPath": result_path.as_posix(),
        "writeResultPath": write_result_path.as_posix(),
        "verifyReportPath": verify_report_path.as_posix(),
        "blockingErrorCount": len(verify_report.get("blockingErrors") or []),
        "warningCount": len(verify_report.get("warnings") or []),
    }, ensure_ascii=False, indent=2))
    return 0 if verify_report.get("allPass") else 2


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""

    parser = argparse.ArgumentParser(description="Prefab To Figma MCP wrapper")
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE_PATH,
                        help="prefab-to-figma.json 路径")
    parser.add_argument("--write-plan", type=Path, default=DEFAULT_WRITE_PLAN_PATH,
                        help="figma_write_plan.json 路径")
    parser.add_argument("--result", type=Path, default=DEFAULT_RESULT_PATH,
                        help="prefab_to_figma_mcp_result.json 输出路径")
    parser.add_argument("--write-result", type=Path, default=None,
                        help="figma_write_result.json 输出路径，默认写到 result 同目录")
    parser.add_argument("--verify-report", type=Path, default=None,
                        help="figma_write_verify_report.json 输出路径，默认写到 result 同目录")
    parser.add_argument("--job-output", type=Path, default=None,
                        help="可选：保存提交给 MCP 的 job 预览")
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL, help="内部 runtime relay 地址")
    parser.add_argument("--bridge-url", dest="relay_url", default=DEFAULT_RELAY_URL, help=argparse.SUPPRESS)
    parser.add_argument("--job-name", default="Prefab_To_Figma_Write", help="MCP job 名称")
    parser.add_argument("--job-type", choices=["PREFAB_TO_FIGMA_WRITE", "PREFAB_TO_FIGMA_DIAG"],
                        default="PREFAB_TO_FIGMA_WRITE", help="MCP job type")
    parser.add_argument("--component-mode", choices=["component", "frame"], default="component",
                        help="顶层导入节点是否组件化")
    parser.add_argument("--timeout", type=float, default=300.0, help="等待 Figma 结果秒数")
    parser.add_argument("--interval", type=float, default=0.5, help="轮询间隔秒数")
    parser.add_argument("--startup-timeout", type=float, default=10.0, help="兼容参数；MCP wrapper 会忽略")
    parser.add_argument("--health", action="store_true", help="只检查 figmaMcpRelay 本地 companion")
    parser.add_argument("--dry-run", action="store_true", help="只构建 job，不提交给 MCP")
    return parser.parse_args()


def main() -> int:
    """命令行入口。"""

    args = parse_args()
    if args.health:
        return run_health(args)
    return run_export(args)


if __name__ == "__main__":
    raise SystemExit(main())
