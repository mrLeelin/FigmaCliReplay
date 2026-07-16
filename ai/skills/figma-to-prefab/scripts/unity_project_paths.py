#!/usr/bin/env python3
"""Portable Unity project and asset-path helpers shared by Relay scripts."""

from __future__ import annotations

import os
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
    value = str(raw or "").replace("\\", "/").strip().lstrip("./")
    if value.startswith("Assets/"):
        return value
    marker = "/Assets/"
    wrapped = "/" + value
    if marker in wrapped:
        return "Assets/" + wrapped.split(marker, 1)[1]
    raise ValueError(f"Unity asset path must be under Assets/: {raw}")
