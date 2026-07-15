#!/usr/bin/env python3
"""Common_Texture 缓存索引 — 文件数量校验 + 增量重建"""
import json, argparse, os, sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PLUGIN_ROOT = Path(__file__).resolve().parents[4]
UNITY_PROJECT = Path(os.environ.get("FIGMA_UNITY_PROJECT", PLUGIN_ROOT / "JellybeanUnity")).expanduser().resolve()
CACHE_FILE = PLUGIN_ROOT / ".tmp" / "common_texture_index.json"
COMMON_DIR = UNITY_PROJECT / "Assets" / "_Art" / "Texture" / "GUI" / "_Common"


def build_index() -> dict:
    """扫描 _Common 目录下所有 PNG，建立 {stem: assetPath} 索引"""
    index = {}
    if COMMON_DIR.exists():
        for p in COMMON_DIR.rglob("*.png"):
            rel = "Assets/" + str(p.relative_to(UNITY_PROJECT / "Assets")).replace("\\", "/")
            index[p.stem] = rel
    return index


def get_index(force_rebuild: bool = False) -> dict:
    """获取缓存索引。

    双重校验缓存有效性：
    - 文件数量变化 → 重建
    - 目录 mtime 变化（增/删/改名） → 重建
    任一条件触发即全量重建，确保用户手动放入/移除文件时立即感知。
    """
    if not force_rebuild and CACHE_FILE.exists():
        cached = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        current_count = len(list(COMMON_DIR.rglob("*.png"))) if COMMON_DIR.exists() else 0
        current_mtime = COMMON_DIR.stat().st_mtime if COMMON_DIR.exists() else 0
        if cached.get("fileCount") == current_count and cached.get("dirMtime") == current_mtime:
            return cached.get("index", {})

    index = build_index()
    dir_mtime = COMMON_DIR.stat().st_mtime if COMMON_DIR.exists() else 0
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(
        json.dumps({
            "fileCount": len(index),
            "dirMtime": dir_mtime,
            "index": index,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return index


def main():
    parser = argparse.ArgumentParser(description="Common_Texture 缓存索引")
    parser.add_argument("--rebuild", action="store_true", help="强制重建缓存")
    parser.add_argument("--query", type=str, help="查询指定 stem 的路径")
    args = parser.parse_args()

    index = get_index(force_rebuild=args.rebuild)

    if args.query:
        path = index.get(args.query)
        if path:
            print(path)
            return 0
        else:
            print("", end="")
            return 1

    print(json.dumps({"count": len(index), "items": index}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
