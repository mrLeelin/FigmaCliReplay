"""Structured logging shared by every Python entrypoint in Figma MCP Relay."""

from __future__ import annotations

import datetime as _datetime
import json
import os
import sys
import threading
import time
import traceback
import uuid
from typing import Any, Dict, Optional, TextIO


LOG_MARKER = "FIGMA_RELAY_LOG "
_SENSITIVE_KEY = ("password", "token", "authorization", "cookie", "apikey", "api_key", "secret")
_MAX_TEXT = 4096


class PythonLogger:
    """Emit redacted log events on stderr without touching protocol stdout."""

    def __init__(
        self,
        module: str,
        stream: Optional[TextIO] = None,
        clock: Any = time.time,
        operation_id: str = "",
    ) -> None:
        self.module = module
        self.stream = stream or sys.stderr
        self.clock = clock
        self.default_operation_id = operation_id or os.environ.get("FIGMA_RELAY_OPERATION_ID", "")
        self._lock = threading.Lock()

    def child(self, module: str) -> "PythonLogger":
        return PythonLogger(
            module=module,
            stream=self.stream,
            clock=self.clock,
            operation_id=self.default_operation_id,
        )

    def start_operation(
        self,
        operation_name: str,
        operation_id: str = "",
        data: Optional[Dict[str, Any]] = None,
    ) -> "PythonOperationScope":
        return PythonOperationScope(self, operation_name, operation_id, data or {})

    def trace(self, message: str, **kwargs: Any) -> None:
        self._diagnostic("trace", message, **kwargs)

    def debug(self, message: str, **kwargs: Any) -> None:
        self._diagnostic("debug", message, **kwargs)

    def info(self, message: str, **kwargs: Any) -> None:
        self._diagnostic("info", message, **kwargs)

    def warn(self, message: str, **kwargs: Any) -> None:
        self._diagnostic("warn", message, **kwargs)

    def error(self, message: str, error: Optional[BaseException] = None, **kwargs: Any) -> None:
        self._emit(level="error", status="failed", step="diagnostic", message=message, error=error, **kwargs)

    def _diagnostic(self, level: str, message: str, **kwargs: Any) -> None:
        self._emit(level=level, status="progress", step="diagnostic", message=message, **kwargs)

    def _emit(
        self,
        level: str,
        status: str,
        step: str,
        message: str,
        data: Optional[Dict[str, Any]] = None,
        operation_id: str = "",
        operation_name: str = "diagnostic",
        step_index: int = 0,
        duration_ms: Optional[int] = None,
        error: Optional[BaseException] = None,
    ) -> None:
        now = float(self.clock())
        event: Dict[str, Any] = {
            "timestamp": _datetime.datetime.fromtimestamp(now, _datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": level,
            "source": "python",
            "module": self.module,
            "operationId": operation_id or self.default_operation_id or f"py-{uuid.uuid4().hex}",
            "operationName": operation_name,
            "step": step,
            "stepIndex": max(0, int(step_index)),
            "status": status,
            "message": str(message or step),
            "data": _redact(data or {}),
        }
        if duration_ms is not None:
            event["durationMs"] = max(0, int(duration_ms))
        if error is not None:
            event["error"] = {
                "name": type(error).__name__,
                "message": str(error) or type(error).__name__,
                "stack": "".join(traceback.format_exception(type(error), error, error.__traceback__))[-_MAX_TEXT:],
            }
        line = LOG_MARKER + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            self.stream.write(line)
            self.stream.flush()


class PythonOperationScope:
    """Record an ordered operation lifecycle with exactly one terminal event."""

    def __init__(
        self,
        logger: PythonLogger,
        operation_name: str,
        operation_id: str,
        data: Dict[str, Any],
    ) -> None:
        self.logger = logger
        self.operation_name = operation_name
        self.operation_id = operation_id or logger.default_operation_id or f"py-{uuid.uuid4().hex}"
        self.started_at = float(logger.clock())
        self.step_index = 0
        self.terminal = False
        logger._emit(
            level="info",
            status="started",
            step="operation.start",
            message="Python operation started",
            data=data,
            operation_id=self.operation_id,
            operation_name=self.operation_name,
        )

    def step(self, step: str, message: str = "", data: Optional[Dict[str, Any]] = None, level: str = "info") -> None:
        if self.terminal:
            return
        self.step_index += 1
        self.logger._emit(
            level=level,
            status="progress",
            step=step,
            message=message or step,
            data=data,
            operation_id=self.operation_id,
            operation_name=self.operation_name,
            step_index=self.step_index,
            duration_ms=self._duration_ms(),
        )

    def succeed(self, message: str = "Python operation succeeded", data: Optional[Dict[str, Any]] = None) -> None:
        self._finish("info", "succeeded", message, data, None)

    def fail(self, error: BaseException, message: str = "Python operation failed", data: Optional[Dict[str, Any]] = None) -> None:
        self._finish("error", "failed", message, data, error)

    def cancel(self, message: str = "Python operation cancelled", data: Optional[Dict[str, Any]] = None) -> None:
        self._finish("warn", "cancelled", message, data, None)

    def _finish(
        self,
        level: str,
        status: str,
        message: str,
        data: Optional[Dict[str, Any]],
        error: Optional[BaseException],
    ) -> None:
        self.step_index += 1
        if self.terminal:
            self.logger._emit(
                level="warn",
                status="progress",
                step="operation.terminal.ignored",
                message="Ignored duplicate Python terminal event",
                operation_id=self.operation_id,
                operation_name=self.operation_name,
                step_index=self.step_index,
                duration_ms=self._duration_ms(),
            )
            return
        self.terminal = True
        self.logger._emit(
            level=level,
            status=status,
            step="operation.complete",
            message=message,
            data=data,
            operation_id=self.operation_id,
            operation_name=self.operation_name,
            step_index=self.step_index,
            duration_ms=self._duration_ms(),
            error=error,
        )

    def _duration_ms(self) -> int:
        return max(0, round((float(self.logger.clock()) - self.started_at) * 1000))


def _redact(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        result: Dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            result[str(key)] = "[REDACTED]" if any(part in normalized for part in _SENSITIVE_KEY) else _redact(item, depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [_redact(item, depth + 1) for item in value[:200]]
    if isinstance(value, bytes):
        return {"kind": "bytes", "bytes": len(value), "truncated": True}
    if isinstance(value, str) and len(value) > _MAX_TEXT:
        return {"kind": "large-payload", "chars": len(value), "truncated": True}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)
