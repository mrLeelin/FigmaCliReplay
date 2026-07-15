#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""解析 Unity Sprite 资源与 .meta 信息。"""

from __future__ import annotations

import os
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, Optional, Tuple


GUID_PATTERN = re.compile(r"\bguid:\s*([0-9a-fA-F]{32})\b")
NUMBER_PATTERN = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DEFAULT_SPRITE_PIXELS_TO_UNITS = 100.0
DEFAULT_BORDER_XYZW = {"x": 0.0, "y": 0.0, "z": 0.0, "w": 0.0}
SKIPPED_META_DIR_NAMES = {
    ".codex",
    ".git",
    ".idea",
    ".kiro",
    ".omx",
    ".tmp",
    ".vs",
    "__pycache__",
    "build",
    "builds",
    "library",
    "logs",
    "obj",
    "serverdata",
    "temp",
    "usersettings",
}


@dataclass(frozen=True)
class SpriteAsset:
    """描述一个已解析的 Unity Sprite PNG 资源。"""

    guid: str
    asset_path: Path
    meta_path: Path
    width: int
    height: int
    border: Dict[str, float]
    pixels_to_units: float


def build_guid_index(project_root: Path | str) -> Dict[str, Path]:
    """遍历可用 .meta 文件，并建立 guid 到 meta 路径的索引。"""

    root = Path(project_root).resolve()
    guid_index: Dict[str, Path] = {}
    if not root.exists():
        return guid_index

    for meta_path in _iter_meta_files(root):
        guid = _read_guid(meta_path)
        if not guid or guid in guid_index:
            continue
        guid_index[guid] = meta_path

    return guid_index


def _iter_meta_files(root: Path) -> Iterator[Path]:
    """按目录剪枝遍历 .meta，避免扫描 Library、Temp 等大型生成目录。"""

    for dir_path, dir_names, file_names in os.walk(root):
        dir_names[:] = sorted(
            name for name in dir_names if name.casefold() not in SKIPPED_META_DIR_NAMES
        )
        for file_name in sorted(file_names):
            if file_name.endswith(".meta"):
                yield Path(dir_path) / file_name


def read_png_size(path: Path | str) -> Tuple[int, int]:
    """读取 PNG 文件 IHDR 块中的宽高。"""

    png_path = Path(path)
    with png_path.open("rb") as handle:
        signature = handle.read(8)
        if signature != PNG_SIGNATURE:
            raise ValueError(f"not a PNG file: {png_path}")

        chunk_length_data = handle.read(4)
        chunk_type = handle.read(4)
        if len(chunk_length_data) != 4 or len(chunk_type) != 4:
            raise ValueError(f"missing PNG IHDR chunk: {png_path}")

        chunk_length = struct.unpack(">I", chunk_length_data)[0]
        if chunk_type != b"IHDR" or chunk_length < 8:
            raise ValueError(f"invalid PNG IHDR chunk: {png_path}")

        size_data = handle.read(8)
        if len(size_data) != 8:
            raise ValueError(f"incomplete PNG IHDR size data: {png_path}")

    return struct.unpack(">II", size_data)


def parse_sprite_meta(meta_path: Path | str) -> Tuple[Dict[str, float], float]:
    """读取 Unity Sprite 的九宫格边框和 pixels-to-units。"""

    path = Path(meta_path)
    lines = _read_text_lines(path)
    content = "\n".join(lines)
    pixels_to_units = _parse_pixels_to_units(content)
    border_xyzw = _parse_sprite_border(lines, content)
    border = {
        "left": border_xyzw["x"],
        "bottom": border_xyzw["y"],
        "right": border_xyzw["z"],
        "top": border_xyzw["w"],
    }
    return border, pixels_to_units


def resolve_sprite(
    guid: str,
    guid_index: Dict[str, Path],
    project_root: Path | str,
) -> Tuple[Optional[SpriteAsset], Optional[str]]:
    """按 guid 解析 Sprite PNG 资源，失败时返回 warning 而不是抛出异常。"""

    normalized_guid = (guid or "").strip().lower()
    if not normalized_guid:
        return None, "Sprite guid is empty."

    meta_path = guid_index.get(normalized_guid)
    if meta_path is None:
        return None, f"Sprite guid not found in index: {normalized_guid}"

    root = Path(project_root).resolve()
    meta_path = Path(meta_path)
    if not meta_path.is_absolute():
        meta_path = root / meta_path
    meta_path = meta_path.resolve()
    if not meta_path.exists():
        return None, f"Sprite meta does not exist: {meta_path}"

    asset_path = meta_path.with_suffix("")
    if not asset_path.exists():
        return None, f"Sprite asset does not exist for meta: {meta_path}"
    if asset_path.suffix.lower() != ".png":
        return None, f"Sprite asset is not PNG: {asset_path}"

    try:
        width, height = read_png_size(asset_path)
    except (OSError, ValueError, struct.error) as exc:
        return None, f"Unable to read PNG size for {asset_path}: {exc}"

    try:
        border, pixels_to_units = parse_sprite_meta(meta_path)
    except (OSError, ValueError) as exc:
        return None, f"Unable to parse sprite meta {meta_path}: {exc}"

    return (
        SpriteAsset(
            guid=normalized_guid,
            asset_path=asset_path,
            meta_path=meta_path,
            width=width,
            height=height,
            border=border,
            pixels_to_units=pixels_to_units,
        ),
        None,
    )


def _read_guid(meta_path: Path) -> Optional[str]:
    """从单个 .meta 文件中逐行读取 guid。"""

    try:
        with meta_path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                match = GUID_PATTERN.search(line)
                if match:
                    return match.group(1).lower()
    except OSError:
        return None
    return None


def _read_text_lines(path: Path) -> list[str]:
    """以 UTF-8 读取文本文件，并忽略不可解码字符。"""

    return path.read_text(encoding="utf-8", errors="ignore").splitlines()


def _parse_pixels_to_units(content: str) -> float:
    """解析 spritePixelsToUnits，缺省时使用 Unity 默认值。"""

    match = re.search(
        rf"^\s*spritePixelsToUnits:\s*({NUMBER_PATTERN})\s*$",
        content,
        re.MULTILINE,
    )
    if not match:
        return DEFAULT_SPRITE_PIXELS_TO_UNITS
    return float(match.group(1))


def _parse_sprite_border(lines: list[str], content: str) -> Dict[str, float]:
    """解析 spriteBorder，并保留 Unity 的 x/y/z/w 原始含义。"""

    border_xyzw = dict(DEFAULT_BORDER_XYZW)
    inline_match = re.search(r"^\s*spriteBorder:\s*\{(?P<body>[^}]*)\}", content, re.MULTILINE)
    if inline_match:
        border_xyzw.update(_parse_xyzw_pairs(inline_match.group("body")))
        return border_xyzw

    for index, line in enumerate(lines):
        match = re.match(r"^(?P<indent>\s*)spriteBorder:\s*$", line)
        if not match:
            continue

        base_indent = len(match.group("indent"))
        for child_line in lines[index + 1 :]:
            if not child_line.strip():
                continue

            child_indent = len(child_line) - len(child_line.lstrip())
            if child_indent <= base_indent:
                break

            child_match = re.match(
                rf"^\s*(?P<key>[xyzw]):\s*(?P<value>{NUMBER_PATTERN})\s*$",
                child_line,
            )
            if child_match:
                border_xyzw[child_match.group("key")] = float(child_match.group("value"))
        break

    return border_xyzw


def _parse_xyzw_pairs(text: str) -> Dict[str, float]:
    """解析 Unity 内联字典格式中的 x/y/z/w 数值。"""

    values: Dict[str, float] = {}
    for key, value in re.findall(rf"\b([xyzw]):\s*({NUMBER_PATTERN})", text):
        values[key] = float(value)
    return values


def _write_self_test_png(path: Path, width: int, height: int) -> None:
    """写入一个只用于 IHDR 解析的最小 PNG 文件。"""

    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png_bytes = (
        PNG_SIGNATURE
        + struct.pack(">I", len(ihdr_data))
        + b"IHDR"
        + ihdr_data
        + b"\x00\x00\x00\x00"
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    path.write_bytes(png_bytes)


def _run_self_test() -> None:
    """执行 asset_resolver 的最小自测。"""

    self_test_dir = Path.cwd() / ".tmp" / "prefab-to-figma-self-test"
    png_path = self_test_dir / "sample.png"
    meta_path = self_test_dir / "sample.png.meta"
    missing_asset_meta_path = self_test_dir / "missing_asset.png.meta"
    text_asset_path = self_test_dir / "not_png.txt"
    text_meta_path = self_test_dir / "not_png.txt.meta"
    guid = "0123456789abcdef0123456789abcdef"
    missing_asset_guid = "11111111111111111111111111111111"
    text_guid = "22222222222222222222222222222222"
    tmp_root_existed = self_test_dir.parent.exists()
    self_test_dir_existed = self_test_dir.exists()

    self_test_dir.mkdir(parents=True, exist_ok=True)
    try:
        _write_self_test_png(png_path, width=17, height=23)
        meta_path.write_text(
            "\n".join(
                [
                    "fileFormatVersion: 2",
                    f"guid: {guid}",
                    "TextureImporter:",
                    "  spritePixelsToUnits: 32",
                    "  spriteBorder: {x: 1, y: 2, z: 3, w: 4}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        guid_index = build_guid_index(self_test_dir)
        border, pixels_to_units = parse_sprite_meta(meta_path)
        assert border == {"left": 1.0, "bottom": 2.0, "right": 3.0, "top": 4.0}
        assert pixels_to_units == 32.0

        sprite, warning = resolve_sprite(guid, guid_index, self_test_dir)
        assert warning is None
        assert sprite is not None
        assert sprite.width == 17
        assert sprite.height == 23
        assert sprite.border == border
        assert sprite.pixels_to_units == 32.0

        empty_sprite, empty_warning = resolve_sprite("", guid_index, self_test_dir)
        assert empty_sprite is None
        assert empty_warning is not None

        missing_meta_sprite, missing_meta_warning = resolve_sprite(
            "ffffffffffffffffffffffffffffffff",
            guid_index,
            self_test_dir,
        )
        assert missing_meta_sprite is None
        assert missing_meta_warning is not None

        missing_asset_meta_path.write_text(
            "\n".join(["fileFormatVersion: 2", f"guid: {missing_asset_guid}", ""]),
            encoding="utf-8",
        )
        missing_asset_index = build_guid_index(self_test_dir)
        missing_asset_sprite, missing_asset_warning = resolve_sprite(
            missing_asset_guid,
            missing_asset_index,
            self_test_dir,
        )
        assert missing_asset_sprite is None
        assert missing_asset_warning is not None

        text_asset_path.write_text("not png", encoding="utf-8")
        text_meta_path.write_text(
            "\n".join(["fileFormatVersion: 2", f"guid: {text_guid}", ""]),
            encoding="utf-8",
        )
        text_index = build_guid_index(self_test_dir)
        text_sprite, text_warning = resolve_sprite(text_guid, text_index, self_test_dir)
        assert text_sprite is None
        assert text_warning is not None
        print("asset_resolver self-test passed")
    finally:
        for generated_path in (
            png_path,
            meta_path,
            missing_asset_meta_path,
            text_asset_path,
            text_meta_path,
        ):
            if generated_path.exists():
                generated_path.unlink()
        if not self_test_dir_existed:
            try:
                self_test_dir.rmdir()
            except OSError:
                pass
        if not tmp_root_existed:
            try:
                self_test_dir.parent.rmdir()
            except OSError:
                pass


if __name__ == "__main__":
    _run_self_test()
