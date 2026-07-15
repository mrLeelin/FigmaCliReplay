#!/usr/bin/env python3
"""计算图片 pHash 并对比，用于通用组件视觉匹配 fallback。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("缺少 Pillow，请先安装 pillow。") from exc


def compute_phash(image_path: Path, hash_size: int = 8) -> int:
    """计算图片的感知哈希（差分哈希 dHash），返回 64 位整数。"""
    img = Image.open(image_path).convert("L").resize(
        (hash_size + 1, hash_size), Image.Resampling.LANCZOS
    )
    pixels = list(img.getdata())
    bits = 0
    for row in range(hash_size):
        for col in range(hash_size):
            idx = row * (hash_size + 1) + col
            if pixels[idx] < pixels[idx + 1]:
                bits |= 1 << (row * hash_size + col)
    return bits


def hamming_distance(hash1: int, hash2: int) -> int:
    """计算两个哈希的 hamming distance。"""
    return bin(hash1 ^ hash2).count("1")


def compute_phash_for_directory(directory: Path) -> Dict[str, int]:
    """计算目录下所有 PNG 的 pHash。"""
    results = {}
    for png in sorted(directory.glob("*.png")):
        try:
            results[png.name] = compute_phash(png)
        except Exception:
            results[png.name] = -1
    return results


def compare_image_to_library(
    image_path: Path,
    library_hashes: Dict[str, int],
    max_ratio_diff: float = 0.5,
    library_sizes: Dict[str, tuple] = None,
) -> List[Dict[str, Any]]:
    """将单张图片与库中所有图片做 pHash 对比，返回按 distance 排序的结果。"""
    img = Image.open(image_path)
    img_w, img_h = img.size
    img_ratio = img_w / max(img_h, 1)
    img_hash = compute_phash(image_path)

    results = []
    for name, lib_hash in library_hashes.items():
        if lib_hash < 0:
            continue
        if library_sizes and name in library_sizes:
            lib_w, lib_h = library_sizes[name]
            lib_ratio = lib_w / max(lib_h, 1)
            if abs(img_ratio - lib_ratio) / max(img_ratio, lib_ratio, 0.01) > max_ratio_diff:
                continue
        dist = hamming_distance(img_hash, lib_hash)
        results.append({"name": name, "distance": dist})

    results.sort(key=lambda x: x["distance"])
    return results


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="pHash 视觉匹配工具")
    sub = parser.add_subparsers(dest="command")

    hash_cmd = sub.add_parser("hash", help="计算目录下所有 PNG 的 pHash")
    hash_cmd.add_argument("directory", type=Path)
    hash_cmd.add_argument("--out", type=Path, help="输出 JSON 路径")

    compare_cmd = sub.add_parser("compare", help="对比图片与 pHash 库")
    compare_cmd.add_argument("image", type=Path)
    compare_cmd.add_argument("--library", type=Path, required=True, help="库 pHash JSON")
    compare_cmd.add_argument("--top", type=int, default=5)

    args = parser.parse_args()

    if args.command == "hash":
        hashes = compute_phash_for_directory(args.directory)
        output = json.dumps(hashes, indent=2)
        if args.out:
            args.out.write_text(output, encoding="utf-8")
        print(output)
        return 0

    if args.command == "compare":
        library = json.loads(args.library.read_text(encoding="utf-8"))
        results = compare_image_to_library(args.image, library)
        print(json.dumps(results[: args.top], indent=2))
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
