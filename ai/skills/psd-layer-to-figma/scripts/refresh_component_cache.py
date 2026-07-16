"""
PSD → Figma 组件缓存刷新工具。
标准流程使用 figmaMcpRelay 查询组件库，写入新鲜缓存。

用法:

  1. 标准入口：通过 figmaMcpRelay 插件查询并写入缓存：
     python refresh_component_cache.py <cache_dir> --from-mcp

  2. 从 MCP Relay 查询结果 JSON 文件构建缓存：
     python refresh_component_cache.py <cache_dir> --components <comp.json> --images <img.json>

  3. 直接传入已知的组件数据 JSON 字符串构建缓存：
     python refresh_component_cache.py <cache_dir> --inline-comp '<json>' --inline-img '<json>'

缓存输出到 <cache_dir>/：
  - component_library_cache.json  (62:115 组件库)
  - image_library_cache.json      (2896:32 图片库)
"""
import json
import sys
import os
import hashlib
import importlib.util
from pathlib import Path

_SCRIPT_DIR = os.path.dirname(__file__)
_ADDED_SCRIPT_DIR = _SCRIPT_DIR not in sys.path
if _ADDED_SCRIPT_DIR:
    sys.path.insert(0, _SCRIPT_DIR)
try:
    from cache_component_index import save_cache
finally:
    if _ADDED_SCRIPT_DIR:
        sys.path.remove(_SCRIPT_DIR)


GENERATE_JS_HELP = "--generate-js is deprecated. Use --from-mcp."


def resolve_relay_root() -> Path:
    """Locate the standalone Relay checkout that owns this bundled skill."""
    script_path = Path(__file__).resolve()
    for candidate in script_path.parents:
        if (candidate / "client" / "figma_mcp_client.py").is_file():
            return candidate
    raise RuntimeError("Unable to locate standalone Figma MCP Relay root")


def load_query_components():
    """Import the Relay client from the standalone checkout."""
    client_file = (resolve_relay_root() / "client" / "figma_mcp_client.py").resolve()
    if not client_file.is_file():
        raise RuntimeError(f"Relay client module not found: {client_file}")
    module_hash = hashlib.sha256(str(client_file).encode("utf-8")).hexdigest()[:12]
    module_name = f"_figma_mcp_client_{module_hash}"
    spec = importlib.util.spec_from_file_location(module_name, client_file)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Relay client module: {client_file}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    query_components = getattr(module, "query_components", None)
    if not callable(query_components):
        raise RuntimeError(f"Relay client has no query_components: {client_file}")
    return query_components


def unwrap_mcp_payload(value):
    """Return the first dict that contains Relay result data."""
    if not isinstance(value, dict):
        return {}
    current = value
    for _ in range(4):
        if not isinstance(current, dict):
            return {}
        if isinstance(current.get("libraries"), dict):
            return current
        if isinstance(current.get("result"), dict):
            current = current["result"]
            continue
        if isinstance(current.get("value"), dict):
            current = current["value"]
            continue
        return current
    return current if isinstance(current, dict) else {}


def extract_libraries(query_result):
    """Support both raw Relay results and MCP tool wrapper results."""
    payload = unwrap_mcp_payload(query_result)
    libs = payload.get("libraries") if isinstance(payload.get("libraries"), dict) else {}
    if libs:
        return libs
    # Some compact callers return library entries at the top level.
    if any(isinstance(payload.get(node_id), dict) for node_id in ("62:115", "2896:32")):
        return payload
    return {}


def library_components(libs, node_id):
    entry = libs.get(node_id) if isinstance(libs, dict) else {}
    if not isinstance(entry, dict):
        return []
    components = entry.get("components")
    return components if isinstance(components, list) else []


def assert_cache_counts(query_result, cache_result):
    """Fail if Relay returned components but cache serialization dropped them."""
    libs = extract_libraries(query_result)
    relay_component_count = len(library_components(libs, "62:115"))
    relay_image_count = len(library_components(libs, "2896:32"))
    cache_component_count = int(cache_result.get("componentCount") or 0)
    cache_image_count = int(cache_result.get("imageCount") or 0)
    if relay_component_count > 0 and cache_component_count == 0:
        raise RuntimeError(
            f"MCP component library returned {relay_component_count} items, "
            "but component cache saved 0. Check Relay payload schema parsing."
        )
    if relay_image_count > 0 and cache_image_count == 0:
        raise RuntimeError(
            f"MCP image library returned {relay_image_count} items, "
            "but image cache saved 0. Check Relay payload schema parsing."
        )


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return
    if "--generate-js" in sys.argv:
        print(json.dumps({
            "status": "deprecated",
            "message": "--generate-js is deprecated. Use --from-mcp; standard PSD import must not query components via use_figma.",
        }, ensure_ascii=False))
        return

    if len(sys.argv) < 2:
        print(__doc__)
        return

    cache_dir = sys.argv[1]

    # 支持 --from-mcp 直接从 MCP Relay 插件查询组件库（无需 MCP use_figma）。
    # --from-bridge 仅作为旧命令兼容别名保留。
    if "--from-mcp" in sys.argv or "--from-bridge" in sys.argv:
        relay_url = "http://localhost:32130"
        if "--relay-url" in sys.argv:
            idx = sys.argv.index("--relay-url")
            if idx + 1 < len(sys.argv):
                relay_url = sys.argv[idx + 1]

        query_components = load_query_components()

        print(json.dumps({"status": "querying-mcp-relay", "relayUrl": relay_url}, ensure_ascii=False))
        query_result = query_components(relay_url=relay_url)
        libs = extract_libraries(query_result)
        if not libs:
            raise RuntimeError("MCP Relay query_components returned no libraries payload")
        print(json.dumps({
            "status": "mcp-relay-components-received",
            "componentCount": len(library_components(libs, "62:115")),
            "imageCount": len(library_components(libs, "2896:32")),
        }, ensure_ascii=False))

        os.makedirs(os.path.join(cache_dir, "_mcp"), exist_ok=True)

        # 62:115 通用组件库
        comp_components = library_components(libs, "62:115")
        comp_data = {
            "libraryNodeId": "62:115",
            "components": comp_components,
        }
        comp_path = os.path.join(cache_dir, "_mcp", "components.json")
        with open(comp_path, "w", encoding="utf-8") as f:
            json.dump(comp_data, f, ensure_ascii=False)
        components_json = comp_path

        # 2896:32 通用图片库
        img_components = library_components(libs, "2896:32")
        img_data = {
            "libraryNodeId": "2896:32",
            "components": img_components,
        }
        img_path = os.path.join(cache_dir, "_mcp", "images.json")
        with open(img_path, "w", encoding="utf-8") as f:
            json.dump(img_data, f, ensure_ascii=False)
        images_json = img_path

        result = save_cache(cache_dir, components_json, images_json)
        assert_cache_counts(query_result, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
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

    # 支持 --inline-comp / --inline-img 直接传 JSON 字符串
    if "--inline-comp" in sys.argv:
        idx = sys.argv.index("--inline-comp")
        if idx + 1 < len(sys.argv):
            os.makedirs(os.path.join(cache_dir, "_inline"), exist_ok=True)
            p = os.path.join(cache_dir, "_inline", "components.json")
            with open(p, "w", encoding="utf-8") as f:
                f.write(sys.argv[idx + 1])
            components_json = p

    if "--inline-img" in sys.argv:
        idx = sys.argv.index("--inline-img")
        if idx + 1 < len(sys.argv):
            os.makedirs(os.path.join(cache_dir, "_inline"), exist_ok=True)
            p = os.path.join(cache_dir, "_inline", "images.json")
            with open(p, "w", encoding="utf-8") as f:
                f.write(sys.argv[idx + 1])
            images_json = p

    if not components_json and not images_json:
        print(json.dumps({"error": "Need --components and/or --images"}), file=sys.stderr)
        sys.exit(1)

    result = save_cache(cache_dir, components_json, images_json)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"✅ 缓存已写入 {cache_dir}/")
    print(f"   组件库: {result.get('componentCache', 'N/A')} ({result.get('componentCount', '?')} 个)")
    print(f"   图片库: {result.get('imageCache', 'N/A')} ({result.get('imageCount', '?')} 个)")


if __name__ == "__main__":
    main()
