"""
缓存 Figma 通用组件库和通用图片库的组件索引到本地 JSON。

用法：
    python cache_component_index.py <cache_dir> --check
    python cache_component_index.py <cache_dir> --components <file.json> --images <file.json>

Agent 调用流程：
1. --check 判断缓存是否需要刷新（>24h 或不存在）
2. 如需刷新，用 use_figma 遍历 62:115 和 2896:32，保存为临时 JSON
3. 调用本脚本 --components/--images 保存缓存
4. 后续导入直接读缓存 JSON，跳过 Figma 遍历

缓存格式：
{
  "libraryNodeId": "62:115",
  "fetchedAt": "2025-01-01T00:00:00Z",
  "componentCount": 29,
  "components": [...],
  "normalized": { "closebtn1": {...}, ... }
}
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def normalize_name(name):
    """规范化组件名：去前缀、转小写、移除分隔符。"""
    n = name
    for prefix in ("Common_", "Common-", "common_", "common-"):
        if n.startswith(prefix):
            n = n[len(prefix):]
            break
    return n.lower().replace(" ", "").replace("-", "").replace("_", "").replace("[", "").replace("]", "").replace("(", "").replace(")", "")


def build_cache(components, library_node_id):
    """从组件列表构建缓存，包含规范化索引。"""
    normalized = {}
    for comp in components:
        key = normalize_name(comp["name"])
        if key in normalized:
            existing = normalized[key]
            if isinstance(existing, list):
                existing.append(comp)
            else:
                normalized[key] = [existing, comp]
        else:
            normalized[key] = comp

    return {
        "libraryNodeId": library_node_id,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "componentCount": len(components),
        "components": components,
        "normalized": normalized
    }


def check_cache(cache_dir):
    """检查缓存是否存在且未过期（24小时）。"""
    comp_path = Path(cache_dir) / "component_library_cache.json"
    img_path = Path(cache_dir) / "image_library_cache.json"

    needs_refresh = not comp_path.exists() or not img_path.exists()

    if not needs_refresh:
        try:
            with open(comp_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            fetched = datetime.fromisoformat(data["fetchedAt"])
            age_hours = (datetime.now(timezone.utc) - fetched).total_seconds() / 3600
            needs_refresh = age_hours > 24
        except (json.JSONDecodeError, KeyError, ValueError):
            needs_refresh = True

    return {
        "needsRefresh": needs_refresh,
        "componentCachePath": str(comp_path),
        "imageCachePath": str(img_path),
        "exists": comp_path.exists() and img_path.exists()
    }


def save_cache(cache_dir, components_json=None, images_json=None):
    """保存组件缓存到本地文件。"""
    cache_path = Path(cache_dir)
    cache_path.mkdir(parents=True, exist_ok=True)
    results = {}

    if components_json:
        with open(components_json, "r", encoding="utf-8") as f:
            comp_data = json.load(f)
        cache = build_cache(comp_data.get("components", []), comp_data.get("libraryNodeId", "62:115"))
        out_path = cache_path / "component_library_cache.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
        results["componentCache"] = str(out_path)
        results["componentCount"] = cache["componentCount"]

    if images_json:
        with open(images_json, "r", encoding="utf-8") as f:
            img_data = json.load(f)
        cache = build_cache(img_data.get("components", []), img_data.get("libraryNodeId", "2896:32"))
        out_path = cache_path / "image_library_cache.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
        results["imageCache"] = str(out_path)
        results["imageCount"] = cache["componentCount"]

    return results


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: cache_component_index.py <cache_dir> [--check | --components <f> --images <f>]"}))
        sys.exit(1)

    cache_dir = sys.argv[1]

    if "--check" in sys.argv:
        print(json.dumps(check_cache(cache_dir), ensure_ascii=False, indent=2))
        return

    components_json = None
    images_json = None

    if "--components" in sys.argv:
        idx = sys.argv.index("--components")
        if idx + 1 < len(sys.argv):
            components_json = sys.argv[idx + 1]

    if "--images" in sys.argv:
        idx = sys.argv.index("--images")
        if idx + 1 < len(sys.argv):
            images_json = sys.argv[idx + 1]

    if not components_json and not images_json:
        data = json.load(sys.stdin)
        cache = build_cache(data.get("components", []), data.get("libraryNodeId", "62:115"))
        cache_path = Path(cache_dir)
        cache_path.mkdir(parents=True, exist_ok=True)
        out_path = cache_path / "component_library_cache.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
        print(json.dumps({"saved": str(out_path), "componentCount": cache["componentCount"]}))
        return

    print(json.dumps(save_cache(cache_dir, components_json, images_json), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
