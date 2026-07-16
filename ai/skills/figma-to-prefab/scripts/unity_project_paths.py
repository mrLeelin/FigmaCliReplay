#!/usr/bin/env python3
"""Portable Unity project and asset-path helpers shared by Relay scripts."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path


def resolve_unity_project(
    explicit: str | os.PathLike[str] = "",
    env: Mapping[str, str] | None = None,
) -> Path:
    values = os.environ if env is None else env
    raw = str(explicit or "").strip() or values.get("FIGMA_UNITY_PROJECT", "").strip()
    if not raw:
        raise RuntimeError(
            "Unity project is required. Pass --unity-project <path> or set FIGMA_UNITY_PROJECT."
        )
    root = Path(raw).expanduser().resolve()
    missing = [name for name in ("Assets", "ProjectSettings") if not (root / name).is_dir()]
    if missing:
        raise RuntimeError(f"Invalid Unity project {root}: missing {', '.join(missing)}")
    return root


def normalize_asset_path(raw: str | os.PathLike[str]) -> str:
    value = str(raw or "").replace("\\", "/").strip()
    error = ValueError(
        f"Unity asset path must be Assets/... or <project>/Assets/... without traversal: {raw}"
    )
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise error
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise error
    if parts[0] == "Assets" and len(parts) >= 2:
        asset_parts = parts
    elif len(parts) >= 3 and parts[1] == "Assets":
        asset_parts = parts[1:]
    else:
        raise error
    return "/".join(asset_parts)
