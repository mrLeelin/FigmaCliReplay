"""Track the Photoshop instance borrowed or started by one PSD import.

Importing this module never attaches to or starts Photoshop. A deferred session
receipt lets the Relay release an import-owned instance after Figma finishes.
Release only attaches to a running COM object; it never launches or kills one.
"""

from __future__ import annotations

import argparse
import csv
import ctypes
import io
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional


PROG_ID = "Photoshop.Application"


def _process_creation_time(pid: int) -> Optional[str]:
    """Return the Windows creation FILETIME, keeping its full 100 ns precision."""
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(kernel_time), ctypes.byref(user_time)):
            return None
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
    finally:
        kernel.CloseHandle(handle)


def photoshop_processes() -> list[Dict[str, Any]]:
    """Read process identities without COM activation or process mutation."""
    if os.name != "nt":
        raise RuntimeError("Photoshop lifecycle is only available on Windows")
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Photoshop.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, errors="replace", check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    processes = []
    for row in csv.reader(io.StringIO(result.stdout)):
        if len(row) < 2 or row[0].casefold() != "photoshop.exe":
            continue
        pid = int(row[1].replace(",", ""))
        processes.append({"pid": pid, "creationTime": _process_creation_time(pid)})
    return sorted(processes, key=lambda item: item["pid"])


def _client():
    import win32com.client

    return win32com.client


def _active_app(client):
    try:
        return client.GetActiveObject(PROG_ID)
    except Exception:
        return None


def _launch_registered_process() -> Dict[str, Any]:
    """Launch the registered local server explicitly, retaining the actual PID.

    Inferring ownership from "no process before Dispatch, one after" would
    misclassify a user's simultaneous manual launch. Photoshop may forward this
    launch to another instance; its different PID is then never ours to quit.
    """
    import winreg

    clsid = winreg.QueryValue(winreg.HKEY_CLASSES_ROOT, PROG_ID + r"\CLSID")
    command = os.path.expandvars(winreg.QueryValue(winreg.HKEY_CLASSES_ROOT, "CLSID\\" + clsid + r"\LocalServer32"))
    # Adobe registers an unquoted executable path containing spaces on Windows.
    # Supply lpApplicationName explicitly instead of letting Windows guess it.
    match = re.fullmatch(r'\s*(?:"([^"\r\n]+\.exe)"|([^\r\n]+?\.exe))(?:\s+(.*))?\s*', command, re.IGNORECASE)
    if match is None:
        raise RuntimeError("Photoshop LocalServer32 does not contain an executable path")
    executable = match.group(1) or match.group(2)
    if Path(executable).name.casefold() != "photoshop.exe" or not Path(executable).is_file():
        raise RuntimeError("Photoshop LocalServer32 executable is unavailable")
    arguments = match.group(3) or ""
    process = subprocess.Popen(f'"{executable}" {arguments}'.rstrip(), executable=executable,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"pid": process.pid, "creationTime": _process_creation_time(process.pid)}


def _write_receipt(path: Path, data: Dict[str, Any], *, create: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if create:
        with path.open("x", encoding="utf-8") as output:
            output.write(content)
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            output.write(content)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _result(action: str, reason: str, data: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
    return {"ok": action != "error", "action": action, "reason": reason,
            "startedByImport": data.get("startedByImport") is True, **extra}


def _valid_identity(process: Any) -> bool:
    return (isinstance(process, dict) and isinstance(process.get("pid"), int)
            and not isinstance(process.get("pid"), bool) and process["pid"] > 0
            and isinstance(process.get("creationTime"), str) and process["creationTime"].isdigit())


def _release_data(data: Dict[str, Any], app=None, *, timeout_seconds: float = 15.0) -> Dict[str, Any]:
    if data.get("version") != 1:
        return _result("skipped", "unsupported-receipt", data)
    if data.get("state") == "released":
        previous = data.get("release")
        if isinstance(previous, dict):
            return {**previous, "repeated": True}
        return _result("skipped", "already-released", data)
    if data.get("startedByImport") is not True and data.get("wasRunning") is True:
        return _result("kept", "pre-existing-or-unowned-instance", data)
    if data.get("startedByImport") is not True or data.get("wasRunning") is not False:
        return _result("skipped", "ownership-not-proven", data)
    process = data.get("process")
    if not _valid_identity(process):
        return _result("skipped", "process-identity-unavailable", data)
    try:
        deadline = time.monotonic() + timeout_seconds
        current = photoshop_processes()
        same_pid = next((item for item in current if item["pid"] == process["pid"]), None)
        if same_pid is None:
            return _result("already-closed", "owned-process-exited", data)
        if same_pid != process or len(current) != 1:
            return _result("skipped", "process-identity-changed-or-ambiguous", data)
        # Unlike Dispatch, GetActiveObject cannot start a replacement instance.
        if app is None:
            client = _client()
            while app is None:
                app = _active_app(client)
                if app is not None:
                    break
                if time.monotonic() >= deadline:
                    return _result("skipped", "running-instance-not-accessible", data)
                current = photoshop_processes()
                if process not in current:
                    return _result("already-closed", "owned-process-exited", data)
                if current != [process]:
                    return _result("skipped", "process-identity-changed-or-ambiguous", data)
                time.sleep(0.1)
        if photoshop_processes() != [process]:
            return _result("skipped", "process-identity-changed-or-ambiguous", data)
        documents = int(app.Documents.Count)
        if documents:
            return _result("kept", "open-documents", data, openDocumentCount=documents)
        try:
            app.Quit()
        except Exception:
            # COM may disconnect while a successful Quit is returning.
            if process in photoshop_processes():
                raise
        while process in photoshop_processes():
            if time.monotonic() >= deadline:
                return _result("error", "quit-timeout", data)
            time.sleep(0.1)
        return _result("closed", "import-owned-instance", data)
    except Exception as error:
        return _result("error", "cleanup-failed", data, error=str(error))


class PhotoshopSession:
    """One import's ownership decision; shared by the renderer and deferred cleanup."""

    def __init__(self, receipt_path: Optional[Path] = None):
        self.receipt_path = receipt_path.resolve() if receipt_path is not None else None
        self._receipt_reserved = False
        self._launched_process = None
        self.app = None
        self.data: Dict[str, Any] = {
            "version": 1, "state": "checking", "startedByImport": False,
            "wasRunning": True, "process": None,
        }

    def acquire(self):
        # Reserve the receipt before activating COM. A duplicate import must not
        # overwrite another session's cleanup ownership.
        if self.receipt_path is not None:
            _write_receipt(self.receipt_path, self.data, create=True)
            self._receipt_reserved = True
        before = photoshop_processes()
        client = _client()
        self.app = _active_app(client)
        was_running = bool(before) or self.app is not None
        self.data["wasRunning"] = was_running
        try:
            if self.app is None:
                if not was_running:
                    self._launched_process = _launch_registered_process()
                    self.data["process"] = self._launched_process
                    self.data["startedByImport"] = _valid_identity(self._launched_process)
                    self.data["state"] = "active"
                    # Persist the exact native launch identity before COM can
                    # fail or block. Relay cleanup runs in a separate process.
                    if self.receipt_path is not None:
                        _write_receipt(self.receipt_path, self.data)
                self.app = client.Dispatch(PROG_ID)
            after = photoshop_processes()
            self._record_activation(after, was_running)
            self.data["state"] = "active"
            if self.receipt_path is not None:
                _write_receipt(self.receipt_path, self.data)
            return self.app
        except Exception:
            if self.receipt_path is None:
                self.release()
            elif self._receipt_reserved:
                # Never wait for Quit/COM on the renderer failure path: that
                # would prevent Relay's bounded cleanup process from running.
                try:
                    _write_receipt(self.receipt_path, self.data)
                except Exception:
                    pass
            raise

    def _record_activation(self, processes: list[Dict[str, Any]], was_running: bool) -> None:
        process = self._launched_process if self._launched_process is not None else processes[0] if len(processes) == 1 else None
        self.data["process"] = process
        self.data["startedByImport"] = (
            not was_running and _valid_identity(self._launched_process)
            and processes == [self._launched_process]
        )

    def release(self) -> Dict[str, Any]:
        result = _release_data(self.data, self.app)
        self.data["state"] = "released"
        self.data["release"] = result
        if self.receipt_path is not None and self._receipt_reserved:
            try:
                _write_receipt(self.receipt_path, self.data)
            except Exception as error:
                return {**result, "receiptWriteError": str(error)}
        return result


def release_session(receipt_path: Path) -> Dict[str, Any]:
    """Release a persisted session once, without ever Dispatching Photoshop."""
    try:
        data = json.loads(receipt_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _result("skipped", "receipt-missing", {})
    except Exception as error:
        return _result("error", "receipt-unreadable", {}, error=str(error))
    if not isinstance(data, dict):
        return _result("error", "receipt-invalid", {})
    result = _release_data(data)
    data["state"] = "released"
    data["release"] = result
    try:
        _write_receipt(receipt_path, data)
    except Exception as error:
        result["receiptWriteError"] = str(error)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Release only an import-owned Photoshop instance.")
    parser.add_argument("action", choices=["release"])
    parser.add_argument("--session-receipt", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(release_session(args.session_receipt), ensure_ascii=False))
    # Cleanup errors are reported structurally; the Figma result stays valid.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
