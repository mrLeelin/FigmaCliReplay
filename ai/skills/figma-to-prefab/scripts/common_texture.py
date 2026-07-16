#!/usr/bin/env python3
"""Common_Texture 缓存索引 — 文件数量校验 + 增量重建"""
import json, argparse, os, sys
from pathlib import Path
from unity_project_paths import resolve_unity_project

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

def common_dir() -> tuple[Path, Path]:
    unity_project = resolve_unity_project()
    return unity_project, unity_project / "Assets" / "_Art" / "Texture" / "GUI" / "_Common"


def cache_file(unity_project: Path) -> Path:
    return unity_project / ".tmp" / "common_texture_index.json"


def build_index() -> dict:
    """扫描 _Common 目录下所有 PNG，建立 {stem: assetPath} 索引"""
    index = {}
    unity_project, directory = common_dir()
    if directory.exists():
        for p in directory.rglob("*.png"):
            rel = "Assets/" + str(p.relative_to(unity_project / "Assets")).replace("\\", "/")
            index[p.stem] = rel
    return index


def get_index(force_rebuild: bool = False) -> dict:
    """获取缓存索引。

    双重校验缓存有效性：
    - 文件数量变化 → 重建
    - 目录 mtime 变化（增/删/改名） → 重建
    任一条件触发即全量重建，确保用户手动放入/移除文件时立即感知。
    """
    unity_project, directory = common_dir()
    project_cache = cache_file(unity_project)
    if not force_rebuild and project_cache.exists():
        cached = json.loads(project_cache.read_text(encoding="utf-8"))
        current_count = len(list(directory.rglob("*.png"))) if directory.exists() else 0
        current_mtime = directory.stat().st_mtime if directory.exists() else 0
        if cached.get("fileCount") == current_count and cached.get("dirMtime") == current_mtime:
            return cached.get("index", {})

    index = build_index()
    dir_mtime = directory.stat().st_mtime if directory.exists() else 0
    project_cache.parent.mkdir(parents=True, exist_ok=True)
    project_cache.write_text(
        json.dumps({
            "unityProject": str(unity_project),
            "fileCount": len(index),
            "dirMtime": dir_mtime,
            "index": index,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return index


def main():
    parser = argparse.ArgumentParser(description="Common_Texture 缓存索引")
    parser.add_argument("--unity-project", default="", help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--rebuild", action="store_true", help="强制重建缓存")
    parser.add_argument("--query", type=str, help="查询指定 stem 的路径")
    args = parser.parse_args()
    if args.unity_project:
        os.environ["FIGMA_UNITY_PROJECT"] = str(resolve_unity_project(args.unity_project))

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
