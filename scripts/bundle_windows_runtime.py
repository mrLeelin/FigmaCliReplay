"""Assemble Windows x64 runtimes on the publisher's machine."""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


def copy_node(version: str, destination: Path) -> None:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", version):
        raise ValueError(f"Invalid Node.js release version: {version}")
    directory = f"node-{version}-win-x64"
    filename = f"{directory}.zip"
    base_url = f"https://nodejs.org/dist/{version}/"
    with urllib.request.urlopen(base_url + "SHASUMS256.txt", timeout=30) as response:
        checksums = dict(line.split()[::-1] for line in response.read().decode("ascii").splitlines())
    with tempfile.TemporaryDirectory(prefix="figma-relay-node-") as temporary:
        archive = Path(temporary, filename)
        with urllib.request.urlopen(base_url + filename, timeout=60) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        with archive.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != checksums[filename]:
                raise ValueError("Node.js archive did not match the official SHA-256 checksum.")
        destination.mkdir(parents=True)
        with zipfile.ZipFile(archive) as package:
            for name in ("node.exe", "LICENSE"):
                (destination / name).write_bytes(package.read(f"{directory}/{name}"))


def copy_python(destination: Path, requirements: Path) -> None:
    base = Path(sys.base_prefix)
    destination.mkdir(parents=True)
    version_dll = f"python{sys.version_info.major}{sys.version_info.minor}.dll"
    for name in ("python.exe", "python3.dll", version_dll, "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"):
        shutil.copy2(base / name, destination / name)
    shutil.copytree(base / "DLLs", destination / "DLLs", ignore=shutil.ignore_patterns("_test*", "*.cat"))
    shutil.copytree(base / "Lib", destination / "Lib", ignore=shutil.ignore_patterns(
        "site-packages", "__pycache__", "*.pyc", "*.pyo", "test", "tests", "ensurepip", "idlelib", "tkinter", "turtledemo",
    ))
    # The publisher's pip resolves wheels for this exact Python ABI. The shipped
    # interpreter uses the normal relocatable Lib/site-packages layout.
    site_packages = destination / "Lib" / "site-packages"
    subprocess.run([sys.executable, "-I", "-m", "pip", "install", "--disable-pip-version-check", "--ignore-installed", "--no-warn-conflicts",
                    "--only-binary=:all:", "--no-compile", "--target", str(site_packages), "-r", str(requirements)], check=True)
    if (site_packages / "bin").is_dir():
        shutil.rmtree(site_packages / "bin")
    probe = "import sys, PIL, psd_tools, aggdraw, scipy, pythoncom, win32com.client; assert sys.prefix == sys.base_prefix"
    subprocess.run([str(destination / "python.exe"), "-I", "-B", "-c", probe], check=True, cwd=destination.parent)


def main(root: Path, node_version: str) -> None:
    if os.name != "nt" or platform.machine().lower() != "amd64" or sys.maxsize <= 2**32 or sys.version_info < (3, 11):
        raise RuntimeError("Windows x64 packaging requires 64-bit CPython 3.11+ on Windows x64.")
    runtime = root / "runtime"
    copy_node(node_version, runtime / "node")
    copy_python(runtime / "python", root / "server" / "requirements.txt")
    (runtime / "windows-x64.json").write_text(json.dumps({
        "schemaVersion": 1, "platform": "win32", "arch": "x64", "node": node_version, "python": platform.python_version(),
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(), sys.argv[2])
