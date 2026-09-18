"""One JSON request on stdin; NDJSON progress/result on stdout. No listener."""
from __future__ import annotations

import json
import re
import sys
from urllib.parse import urlparse

from crop_jiugong import crop_jiugong_images
from python_logger import PythonLogger
from prefab_import_pipeline import (
    ImportState, PrefabImportTask, is_valid_project_prefab_path,
    normalize_prefab_import_paths, resolve_legacy_unity_project,
    run_prefab_to_figma_import_task, serialize_prefab_import_task,
)

MAX_REQUEST_BYTES = 16 * 1024 * 1024


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def execute(request: dict, progress) -> dict:
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    action = request.get("action")
    if action == "crop-jiugong":
        return crop_jiugong_images(payload)
    if action != "prefab-to-figma":
        raise ValueError("Unsupported algorithm action")
    task_id = request.get("taskId")
    if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", task_id):
        raise ValueError("Invalid taskId")
    for field in ("sessionId", "fileKey"):
        if not isinstance(payload.get(field), str) or not payload[field].strip():
            raise ValueError(f"{field} is required")
    relay_url = str(request.get("relayUrl") or "")
    parsed = urlparse(relay_url)
    if parsed.scheme not in ("http", "ws") or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password:
        raise ValueError("relayUrl must reference the local Relay")
    root = resolve_legacy_unity_project(payload)
    paths = normalize_prefab_import_paths(payload.get("prefabPaths"))
    if not paths or any(not is_valid_project_prefab_path(item, root) for item in paths):
        raise ValueError("No valid project Prefab paths supplied")
    task = PrefabImportTask(task_id, {**payload, "unityProjectPath": str(root), "prefabPaths": paths}, total=len(paths))
    state = ImportState(task, progress)
    run_prefab_to_figma_import_task(state, task_id, relay_url)
    return serialize_prefab_import_task(task)


def main() -> int:
    operation = PythonLogger("algorithm-cli").start_operation("python.algorithm")
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("Request exceeds 16 MiB")
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            raise ValueError("Request must be an object")
        operation.step("validate", "Validate fixed algorithm action", {"action": request.get("action"), "taskId": request.get("taskId")})

        def progress(task: dict) -> None:
            operation.step("progress", "Import progressed", {"stage": task["stage"], "percent": task["percent"], "taskId": task["taskId"]})
            emit({"type": "progress", "task": task})

        result = execute(request, progress)
        emit({"type": "result", "result": result})
        if result.get("ok") is False:
            operation.fail(RuntimeError(str(result.get("error") or result.get("errors") or "Algorithm rejected")))
        else:
            operation.succeed("Algorithm completed")
        return 0
    except Exception as error:
        operation.fail(error, "Algorithm failed")
        emit({"type": "error", "error": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
