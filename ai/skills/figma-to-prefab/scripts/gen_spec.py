#!/usr/bin/env python3
"""
参数化 Figma → Unity Prefab Spec 生成器
用法: python gen_spec.py --figma-url "https://..." --target-prefab "Assets/.../X.prefab" --target-image-dir "Assets/.../Images/"

固化经验:
- 九宫识别 (startswith('__slice_'))
- 九宫副本去重 (同类型+同border → 共享图片)
- INSTANCE 子节点全部 SKIP
- Common_Texture 优先复用项目公共贴图 (缓存索引)
- imageHash 去重
- 父子相对坐标转换
"""
import argparse
import base64
from collections import Counter
import hashlib
import json
import os
from copy import deepcopy
from copy import deepcopy

from nine_slice_common import detect_type_and_border, validate_spec
from common_texture import get_index
import re
import sys
from auto_componentset_specs import apply_auto_componentsets_to_data
from name_utils import sanitize_name, normalize_unity_display_name, strip_outer_brackets, clamp, unity_node_name
from constraints_utils import convert_figma_bounds_to_unity_rect, figma_constraints_to_rect_transform_spec

# Windows GBK 编码兼容 — 强制 stdout 使用 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from pathlib import Path
from collections import defaultdict
from urllib.parse import urlparse, parse_qs

# ── 项目路径 ──────────────────────────────────
def find_project_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".figma" / "plugins" / "figma-mcp-relay").is_dir() and (parent / "JellybeanUnity").is_dir():
            return parent
    raise RuntimeError("Unable to locate the JellybeanUnity repository root.")


PROJECT_ROOT = find_project_root()
UNITY_PROJECT = PROJECT_ROOT / "JellybeanUnity"
COMMON_DIR = UNITY_PROJECT / "Assets" / "_Art" / "Texture" / "GUI" / "_Common"

# ── 本地白像素 Sprite ─────────────────────────
# SOLID fill 无效果节点复用此 1×1 白像素 + Image.color，避免每个节点生成独立 PNG
# 每个 Prefab 目录独立放置，确保在同一图集中与普通 Sprite 合批
WHITE_PIXEL_FILENAME = "white_1x1.png"
WHITE_PIXEL_IMAGE_ID = "builtin_white_1x1"  # 特殊 imageId，不被视为"需要下载的图片"

# ── 公共 Prefab 路径 ────────────────────────────
COMMON_PREFAB_DIR = UNITY_PROJECT / "Assets" / "MagicWarrior" / "_Resources" / "Prefabs" / "UGUI" / "_Common"

# ── 公共贴图缓存（运行时从 common_texture.py 构建） ──────────
# gen_spec.py 启动时加载 .tmp/common_texture_index.json，按节点名匹配现有公共贴图
# 匹配命中后 ImageSpec 直接指向 _Common 下的已有文件，不自建副本
COMMON_TEXTURE_PATHS_CACHE = {}  # 运行时填充：{节点名 → 资产路径}


def resolve_manifest_dir(manifest_dir):
    """相对 manifest-dir 固定按仓库根解析，避免从不同 cwd 启动时读错同名 .tmp。"""
    raw_path = Path(str(manifest_dir))
    if raw_path.is_absolute():
        return raw_path.resolve()
    return (PROJECT_ROOT / raw_path).resolve()


def file_sha256(path):
    file_path = Path(path)
    if not file_path.is_file():
        return ""
    return hashlib.sha256(file_path.read_bytes()).hexdigest()


def id_prefixes(ids):
    prefixes = set()
    for node_id in ids:
        value = str(node_id or "")
        if value:
            prefixes.add(value.split(":", 1)[0])
    return sorted(prefixes)


def build_manifest_provenance(manifest_dir, node_data, export_data):
    manifest_path = Path(manifest_dir).resolve()
    node_manifest_path = manifest_path / "figma_node_manifest.json"
    image_manifest_path = manifest_path / "image_export_manifest.json"
    node_ids = [n.get("id", "") for n in node_data.get("nodes", [])]
    export_ids = [e.get("nodeId", "") for e in export_data.get("exports", [])]
    root_id = (node_data.get("root") or {}).get("id", "") or node_data.get("rootId", "") or node_data.get("rootNodeId", "")
    root_node = next((n for n in node_data.get("nodes", []) if n.get("id") == root_id), {})
    root_bounds = (
        node_data.get("rootBounds")
        or (node_data.get("root") or {}).get("bounds")
        or root_node.get("bounds")
        or root_node.get("relativeBounds")
        or {}
    )
    child_ids = root_node.get("childIds") or (node_data.get("root") or {}).get("childIds") or []
    return {
        "schemaVersion": 1,
        "manifestDir": str(manifest_path),
        "figmaNodeManifestPath": str(node_manifest_path),
        "imageExportManifestPath": str(image_manifest_path),
        "figmaNodeManifestSha256": file_sha256(node_manifest_path),
        "imageExportManifestSha256": file_sha256(image_manifest_path),
        "nodeCount": len(node_ids),
        "exportCount": len(export_ids),
        "nodeIdPrefixes": id_prefixes(node_ids),
        "exportNodeIdPrefixes": id_prefixes(export_ids),
        "fileKey": node_data.get("fileKey", ""),
        "pageName": node_data.get("pageName", ""),
        "rootId": root_id,
        "rootName": (node_data.get("root") or {}).get("name", "") or node_data.get("rootName", "") or root_node.get("name", ""),
        "rootType": root_node.get("type") or (node_data.get("root") or {}).get("type", ""),
        "rootWidth": root_bounds.get("width", 0),
        "rootHeight": root_bounds.get("height", 0),
        "directChildCount": len(child_ids),
    }


def parse_figma_url(url):
    """从 Figma URL 提取 fileKey 和 nodeId"""
    # https://www.figma.com/design/{fileKey}/{name}?node-id=1-2
    path_parts = urlparse(url).path.strip("/").split("/")
    file_key = path_parts[2] if len(path_parts) > 2 else ""
    qs = parse_qs(urlparse(url).query)
    node_id_raw = qs.get("node-id", [""])[0]
    node_id = node_id_raw.replace("-", ":")
    return file_key, node_id


def sanitize_name(name):
    """委托到共享模块。"""
    from name_utils import sanitize_name as _sn
    return _sn(name)


def strip_outer_brackets(name):
    """委托到共享模块。"""
    from name_utils import strip_outer_brackets as _so
    return _so(name)


def normalize_unity_display_name(name):
    """委托到共享模块。"""
    from name_utils import normalize_unity_display_name as _nu
    return _nu(name)


def normalize_unity_asset_dir(asset_dir):
    """规范化 Unity 资产目录，保证后续拼接不会漏掉目录分隔符。"""
    normalized = str(asset_dir or "").replace("\\", "/").strip()
    if not normalized:
        return ""
    return normalized.rstrip("/") + "/"


def is_solid_only_no_effects(node):
    """
    判断节点是否只有纯色填充，无圆角、无描边、无投影。
    这种节点可以用白像素 Sprite + Image.color 还原，不需要导出 PNG。
    """
    fills = node.get("fills", [])
    # 只接受单个 SOLID fill
    if len(fills) != 1 or fills[0].get("type") != "SOLID":
        return False
    # 无圆角
    if node.get("cornerRadius", 0) > 0:
        return False
    # 无可见描边
    for s in node.get("strokes", []):
        if s.get("visible", True) and s.get("type") == "SOLID":
            return False
    # 无效果（投影/发光）
    effects = node.get("effects", [])
    if effects and len(effects) > 0:
        return False
    return True


def get_solid_fill_color(node):
    """取第一个 SOLID fill 的颜色和有效透明度（fill.opacity × node.opacity）。"""
    for f in node.get("fills", []):
        if f.get("type") == "SOLID" and f.get("visible", True):
            c = f.get("color", {})
            fa = f.get("opacity", 1)
            no = node.get("opacity", 1)
            return {
                "r": round(c.get("r", 1), 4),
                "g": round(c.get("g", 1), 4),
                "b": round(c.get("b", 1), 4),
                "a": round(fa * no, 4),
            }
    return {"r": 1, "g": 1, "b": 1, "a": 1}


def _ensure_white_pixel_png(target_image_dir):
    """
    在图片目标目录生成 1×1 白像素 PNG，供 SOLID fill 节点共享。
    文件不存在时生成，已存在则跳过。
    """
    # 将 Unity 资产路径转为磁盘路径
    unity_asset_dir = str(target_image_dir).replace("\\", "/").strip("/")
    if unity_asset_dir.startswith("Assets/"):
        disk_dir = UNITY_PROJECT / unity_asset_dir
    else:
        disk_dir = Path(unity_asset_dir)
    disk_dir.mkdir(parents=True, exist_ok=True)
    png_path = disk_dir / WHITE_PIXEL_FILENAME
    if png_path.exists():
        return
    import struct, zlib
    def _make_1x1_white_png():
        w, h = 1, 1
        ihdr_d = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
        ihdr = struct.pack(">I", 13) + b"IHDR" + ihdr_d + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr_d))
        raw = b"\x00\xff\xff\xff"
        compressed = zlib.compress(raw)
        idat = struct.pack(">I", len(compressed)) + b"IDAT" + compressed + struct.pack(">I", zlib.crc32(b"IDAT" + compressed))
        iend = struct.pack(">I", 0) + b"IEND" + struct.pack(">I", zlib.crc32(b"IEND"))
        return b"\x89PNG\r\n\x1a\n" + ihdr + idat + iend
    png_path.write_bytes(_make_1x1_white_png())


def _spec_uses_white_pixel(spec):
    """判断当前 Prefab Spec 是否实际引用了 white_1x1。"""
    for node in spec.get("nodes", []):
        if node.get("imageId") == WHITE_PIXEL_IMAGE_ID:
            return True
    for image in spec.get("images", []):
        if image.get("id") == WHITE_PIXEL_IMAGE_ID:
            return True
    return False


def _cleanup_orphan_pngs(target_image_dir, spec):
    """保留目标目录已有 PNG，避免导入时删除 Unity 现有图片资源。"""
    return


def _unity_asset_exists(asset_path):
    """判断 Unity 资产路径对应的磁盘文件是否已经存在。"""
    normalized = str(asset_path or "").replace("\\", "/")
    if normalized.startswith("Assets/"):
        return (UNITY_PROJECT / normalized).is_file()
    if normalized.startswith("JellybeanUnity/"):
        return (REPO_ROOT / normalized).is_file()
    raw_path = Path(normalized)
    if raw_path.is_absolute():
        return raw_path.is_file()
    return (REPO_ROOT / raw_path).is_file()


def _find_common_texture_on_disk(name):
    """当 Common_Texture_* 节点未命中缓存时，回退扫描 _Common/ 目录查找已有文件。

    Args:
        name: Figma 节点名，如 "Common_Texture_Bg_4"

    Returns:
        找到的 Unity 资产路径（如 "Assets/_Art/Texture/GUI/_Common/Bg/Common_Texture_Bg_4.png"）
        或 None（未找到）
    """
    png_name = name + ".png"
    if not COMMON_DIR.is_dir():
        return None
    for fpath in COMMON_DIR.rglob(png_name):
        rel = fpath.resolve().relative_to(UNITY_PROJECT.resolve())
        return "Assets/" + rel.as_posix()
    return None


def unity_asset_join(asset_dir, file_name):
    """拼接 Unity 资产路径，统一使用 POSIX 分隔符。"""
    normalized_dir = normalize_unity_asset_dir(asset_dir)
    normalized_file = str(file_name or "").replace("\\", "/").lstrip("/")
    if not normalized_dir:
        return normalized_file
    return normalized_dir + normalized_file


def strip_hash_suffix_from_png(file_name):
    """移除脚本追加的 8 位 hash 后缀，用于最后一层名称+尺寸兜底去重。"""
    stem, ext = os.path.splitext(file_name)
    if ext.lower() != ".png":
        return file_name
    match = re.match(r"^(.*)_[0-9a-fA-F]{8}$", stem)
    return f"{match.group(1)}{ext}" if match else file_name


def image_plan_size_key(dl_item):
    """读取下载计划中的图片尺寸，作为同名兜底去重的尺寸依据。"""
    expected_size = dl_item.get("expectedSize") or {}
    width = int(expected_size.get("x", expected_size.get("width", 0)) or 0)
    height = int(expected_size.get("y", expected_size.get("height", 0)) or 0)
    return width, height


def apply_name_size_fallback_dedup(spec_nodes, images_spec, dl_images):
    """在所有精确判断后，按基础文件名+尺寸兜底合并图片，并输出人工审核数据。"""
    canonical_by_name_size = {}
    remap_image_ids = {}
    review_items = []

    for index, img in enumerate(images_spec):
        if index >= len(dl_images):
            continue
        dl_item = dl_images[index]
        if dl_item.get("reuseExistingAsset"):
            continue
        base_name = strip_hash_suffix_from_png(img.get("fileName", ""))
        size_key = image_plan_size_key(dl_item)
        if size_key == (0, 0):
            continue
        key = (base_name.lower(), size_key)
        if key not in canonical_by_name_size:
            canonical_by_name_size[key] = index
            continue

        canonical_index = canonical_by_name_size[key]
        canonical_img = images_spec[canonical_index]
        canonical_dl = dl_images[canonical_index]
        remap_image_ids[img["id"]] = canonical_img["id"]
        review_items.append({
            "reason": "sameNameAndSizeFallback",
            "baseFileName": base_name,
            "size": {"x": size_key[0], "y": size_key[1]},
            "fromImageId": img["id"],
            "toImageId": canonical_img["id"],
            "fromFileName": img.get("fileName", ""),
            "toFileName": canonical_img.get("fileName", ""),
            "fromFigmaNodeId": dl_item.get("figmaNodeId", ""),
            "toFigmaNodeId": canonical_dl.get("figmaNodeId", ""),
            "fromExpectedMD5": dl_item.get("expectedMD5", ""),
            "toExpectedMD5": canonical_dl.get("expectedMD5", ""),
            "fromImageHash": dl_item.get("imageHash", ""),
            "toImageHash": canonical_dl.get("imageHash", ""),
            "fromBorder": deepcopy(dl_item.get("border", {})),
            "toBorder": deepcopy(canonical_dl.get("border", {})),
        })

    if remap_image_ids:
        for sn in spec_nodes:
            image_id = sn.get("imageId")
            if image_id in remap_image_ids:
                sn["imageId"] = remap_image_ids[image_id]
        keep_ids = {sn["imageId"] for sn in spec_nodes if sn.get("imageId")}
        images_spec = [img for img in images_spec if img["id"] in keep_ids]
        dl_images = [img for img in dl_images if img["imageId"] in keep_ids]

    return images_spec, dl_images, {
        "allPass": True,
        "rule": "After exact hash/MD5/common-texture checks, images with the same normalized file name and planned size are merged for reuse.",
        "reviewRequired": bool(review_items),
        "mergedCount": len(review_items),
        "items": review_items,
    }


def unity_node_name(raw_name, is_root, prefab_name):
    """委托到共享模块。"""
    from name_utils import unity_node_name as _un
    return _un(raw_name, is_root, prefab_name)


def calculate_base64_md5(base64_value):
    """计算 MCP Relay 导出 base64 图片内容的 MD5，失败时返回空字符串。"""
    if not base64_value:
        return ""
    try:
        raw_bytes = base64.b64decode(str(base64_value))
    except (ValueError, TypeError):
        return ""
    return hashlib.md5(raw_bytes).hexdigest()


def clamp(value, minimum, maximum):
    """委托到共享模块。"""
    from name_utils import clamp as _cl
    return _cl(value, minimum, maximum)


def round_float(value, digits=2):
    """统一浮点精度，减少等价描边/投影生成重复材质。"""
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return 0.0


def first_visible_solid_paint(paints):
    """从 Figma paints 中取第一个可见纯色，用于文本描边颜色。"""
    for paint in paints or []:
        if paint.get("type") != "SOLID" or not paint.get("visible", True):
            continue
        color = paint.get("color", {})
        return {
            "r": round_float(color.get("r", 0), 3),
            "g": round_float(color.get("g", 0), 3),
            "b": round_float(color.get("b", 0), 3),
            "a": round_float(paint.get("opacity", 1), 3),
        }
    return None


def first_visible_drop_shadow(effects):
    """从 Figma effects 中取第一个可见 DropShadow，TMP Underlay 只做近似还原。"""
    for effect in effects or []:
        if effect.get("type") != "DROP_SHADOW" or not effect.get("visible", True):
            continue
        return effect
    return None


def color_to_hex(color):
    """把 0-1 RGBA 颜色转成短签名，便于材质命名和复用。"""
    r = int(round(clamp(color.get("r", 0), 0, 1) * 255))
    g = int(round(clamp(color.get("g", 0), 0, 1) * 255))
    b = int(round(clamp(color.get("b", 0), 0, 1) * 255))
    a = int(round(clamp(color.get("a", 1), 0, 1) * 255))
    return f"{r:02x}{g:02x}{b:02x}{a:02x}"


def build_text_material_spec(node, font_size):
    """根据 Figma 文本描边和投影生成可复用 TMP 材质需求。"""
    strokes = node.get("strokes", [])
    stroke_color = first_visible_solid_paint(strokes)
    stroke_weight = round_float(node.get("strokeWeight", 0), 2)
    outline_width = 0.0
    if stroke_color and stroke_weight > 0 and font_size > 0:
        # OutlineWidth = 7/3 × strokeWeight/fontSize, FaceDilate = OutlineWidth/2
        outline_width = round_float(clamp(7.0 / 3.0 * stroke_weight / max(font_size, 1), 0, 1), 2)
    if outline_width <= 0.01:
        stroke_color = None
        outline_width = 0.0

    shadow = first_visible_drop_shadow(node.get("effects", []))
    underlay_color = None
    underlay_offset_x = 0.0
    underlay_offset_y = 0.0
    underlay_softness = 0.0
    underlay_dilate = 0.0
    if shadow:
        color = shadow.get("color", {})
        underlay_color = {
            "r": round_float(color.get("r", 0), 3),
            "g": round_float(color.get("g", 0), 3),
            "b": round_float(color.get("b", 0), 3),
            "a": round_float(color.get("a", 1), 3),
        }
        offset = shadow.get("offset", {})
        # Figma 投影像素到 TMP Underlay 参数没有一一对应关系，这里按字号做归一化近似。
        underlay_offset_x = round_float(clamp(offset.get("x", 0) / max(font_size, 1), -1, 1), 2)
        underlay_offset_y = round_float(clamp(-offset.get("y", 0) / max(font_size, 1), -1, 1), 2)
        underlay_softness = round_float(clamp(shadow.get("radius", 0) / max(font_size, 1), 0, 1), 2)
        underlay_dilate = round_float(clamp(shadow.get("spread", 0) / max(font_size, 1), 0, 1), 2)
        if underlay_color["a"] <= 0.01:
            underlay_color = None

    if not stroke_color and not underlay_color:
        return None

    outline_hex = color_to_hex(stroke_color) if stroke_color else "none"
    underlay_hex = color_to_hex(underlay_color) if underlay_color else "none"
    signature = (
        f"o_{outline_hex}_w_{int(round(outline_width * 100)):03d}"
        f"_u_{underlay_hex}_x_{int(round((underlay_offset_x + 1) * 100)):03d}"
        f"_y_{int(round((underlay_offset_y + 1) * 100)):03d}"
        f"_s_{int(round(underlay_softness * 100)):03d}"
        f"_d_{int(round(underlay_dilate * 100)):03d}"
    )
    material_name = f"CommonFont_figma_{signature}"
    return {
        "enabled": True,
        "signature": signature,
        "materialName": material_name,
        "outlineColor": stroke_color or {"r": 0, "g": 0, "b": 0, "a": 1},
        "outlineWidth": outline_width,
        "underlayColor": underlay_color or {"r": 0, "g": 0, "b": 0, "a": 1},
        "underlayOffsetX": underlay_offset_x,
        "underlayOffsetY": underlay_offset_y,
        "underlaySoftness": underlay_softness,
        "underlayDilate": underlay_dilate,
        "hasOutline": bool(stroke_color),
        "hasUnderlay": bool(underlay_color),
        "sourceStrokeWeight": stroke_weight,
    }


def find_export_for_download(node_id, export_by_node, children_map, node_map=None):
    """查找用于下载计划的导出记录。

    优先级：
    1. 节点自身带 base64 或 imageHash 的导出
    2. 直接子节点中**尺寸最大**的导出（避免 v3slice 拿到 __slice_top 的局部裁剪图）

    对于 v3slice/h3slice 容器，__slice_top/__slice_left 等子节点的导出可能是
    CROP 裁剪后的局部图（如只含顶部 78px）。必须取尺寸最大的子节点导出，
    因为它包含完整源图。
    """
    for export_item in export_by_node.get(node_id, []):
        if export_item.get("base64") or export_item.get("imageHash"):
            return export_item

    best_export = {}
    best_area = 0
    for child_id in children_map.get(node_id, []):
        for export_item in export_by_node.get(child_id, []):
            if export_item.get("base64") or export_item.get("imageHash"):
                w = export_item.get("width", 0) or 0
                h = export_item.get("height", 0) or 0
                area = w * h
                if area > best_area:
                    best_area = area
                    best_export = export_item
    return best_export


def collect_skip_ids(node_id, children_map, skip_set):
    if node_id in skip_set:
        return
    skip_set.add(node_id)
    for cid in children_map.get(node_id, []):
        collect_skip_ids(cid, children_map, skip_set)


def scan_common_prefabs():
    """扫描 _Common 目录下所有 .prefab 文件，返回 {文件名(不含扩展名) → 资产路径} 映射。"""
    prefab_index = {}
    if not COMMON_PREFAB_DIR.is_dir():
        return prefab_index
    for root, _dirs, files in os.walk(str(COMMON_PREFAB_DIR)):
        for fn in files:
            if not fn.endswith(".prefab"):
                continue
            name_without_ext = fn[:-7]  # 去掉 ".prefab"
            full_path = os.path.join(root, fn)
            # 转成 Unity 资产路径（以 Assets/ 开头）
            try:
                unity_path = "Assets" + full_path.split("Assets", 1)[1].replace("\\", "/")
            except IndexError:
                continue
            prefab_index[name_without_ext] = unity_path
    return prefab_index


def normalize_common_prefab_candidate(name):
    """规范化 Figma 组件名，供公共 Prefab 复用匹配。"""
    value = str(name or "").replace("[", "").replace("]", "").strip()
    if value.lower().endswith(".prefab"):
        value = value[:-7]
    return value


def iter_instance_prefab_candidates(node):
    """按组件元数据优先级产出 INSTANCE 的公共 Prefab 候选名。"""
    candidates = []
    component = node.get("component") if isinstance(node.get("component"), dict) else {}
    for key in ("componentName", "mainComponentName", "componentSetName"):
        candidates.append((key, component.get(key, "")))
        candidates.append((key, node.get(key, "")))
    candidates.append(("nodeName", node.get("name", "")))

    seen = set()
    for source, raw_name in candidates:
        candidate = normalize_common_prefab_candidate(raw_name)
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        yield source, candidate


def strip_common_prefab_prefix(name):
    """移除公共 Prefab 命名前缀，用于容错比较。"""
    value = name.lower()
    for prefix in ("common_prefab_", "ui_common_", "common_"):
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def is_common_prefab_candidate(name):
    """Return true for reusable Common prefab names, excluding Common_Texture assets."""
    value = normalize_common_prefab_candidate(name)
    if value.startswith("Common_Texture_"):
        return False
    return value.startswith(("Common_Prefab_", "Common_", "UI_Common_"))


def match_common_prefab(candidate_name, prefab_index):
    """用单个候选名匹配 _Common 下的公共 Prefab。"""
    search_name = normalize_common_prefab_candidate(candidate_name)
    if not search_name:
        return None
    if search_name in prefab_index:
        return prefab_index[search_name]

    stripped = search_name
    for prefix in ["Common_Prefab_", "UI_Common_", "Common_"]:
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix):]
            if stripped in prefab_index:
                return prefab_index[stripped]

    search_lower = search_name.lower()
    search_clean = strip_common_prefab_prefix(search_name)
    for key, path in prefab_index.items():
        key_lower = key.lower()
        key_clean = strip_common_prefab_prefix(key)
        if search_lower in key_lower or key_lower in search_lower:
            return path
        if search_clean == key_clean:
            return path
        s_parts = search_clean.split("_")
        k_parts = key_clean.split("_")
        if len(s_parts) == len(k_parts):
            diff_idx = [i for i in range(len(s_parts)) if s_parts[i] != k_parts[i]]
            if len(diff_idx) == 1:
                i = diff_idx[0]
                a, b = s_parts[i], k_parts[i]
                if len(a) >= 3 and len(b) >= 3 and a[0] == b[0]:
                    overlap = sum(1 for c in a if c in b)
                    if overlap / max(len(a), len(b)) > 0.6:
                        return path
    return None


def resolve_common_prefab_match(node, prefab_index, require_common_candidate=False):
    """Resolve an INSTANCE node to an existing project Common prefab."""
    for candidate_source, candidate_name in iter_instance_prefab_candidates(node):
        if require_common_candidate and not is_common_prefab_candidate(candidate_name):
            continue
        matched_prefab_path = match_common_prefab(candidate_name, prefab_index)
        if matched_prefab_path:
            return matched_prefab_path, candidate_source
    return None, ""


def build_spec(
    manifest_dir,
    target_prefab,
    target_image_dir,
    prefab_name,
    common_index,
    disable_common_texture_reuse=False,
    disable_common_prefab_reuse=False,
):
    target_image_dir = normalize_unity_asset_dir(target_image_dir)
    """核心：从 MCP Relay manifest 生成 prefab_spec.json 和 image_download_plan.json"""
    manifest_dir = resolve_manifest_dir(manifest_dir)
    with open(manifest_dir / "figma_node_manifest.json", "r", encoding="utf-8-sig") as f:
        node_data = json.load(f)
    with open(manifest_dir / "image_export_manifest.json", "r", encoding="utf-8-sig") as f:
        export_data = json.load(f)

    nodes_list = node_data["nodes"]
    exports_list = export_data["exports"]
    root_bounds = node_data["rootBounds"]
    manifest_provenance = build_manifest_provenance(manifest_dir, node_data, export_data)

    # 构建索引
    node_map = {n["id"]: n for n in nodes_list}
    children_map = defaultdict(list)
    for n in nodes_list:
        for cid in n.get("childIds", []):
            children_map[n["id"]].append(cid)

    export_by_node = defaultdict(list)
    for e in exports_list:
        export_by_node[e["nodeId"]].append(e)

    # ── Phase 1: 九宫识别 ──
    SIXED_DATA = {}
    SKIP_IDS = set()

    for n in nodes_list:
        if n["type"] != "FRAME":
            continue
        nid = n["id"]
        children = children_map.get(nid, [])
        child_names = [node_map[c]["name"] for c in children if c in node_map]
        slice_names = [x for x in child_names if x.startswith("__slice_")]
        if not slice_names:
            continue

        slices = {}
        for c in children:
            if c not in node_map:
                continue
            cn = node_map[c]["name"]
            if cn.startswith("__slice_"):
                slices[cn] = node_map[c]
                collect_skip_ids(c, children_map, SKIP_IDS)

        w, h = n["bounds"]["width"], n["bounds"]["height"]
        st, bd = detect_type_and_border(slices, w, h)
        if st is None:
            continue

        SIXED_DATA[nid] = {"type": st, "border": bd, "displayBounds": n["bounds"]}

    # ── Phase 1b: 从 exports 识别 Instance 中的九宫 ──
    # MCP Relay 导出时会标记 sliceKind，但 Instance 内部结构不在 nodes_list 中
    for e in exports_list:
        slice_kind = e.get("sliceKind")
        if slice_kind not in ("9slice", "h3slice", "v3slice"):
            continue
        nid = e["nodeId"]
        if nid in SIXED_DATA:  # 已从 nodes_list 识别，跳过
            continue
        border = e.get("border", {})
        source_size = e.get("sourceVisibleSize", {})
        SIXED_DATA[nid] = {
            "type": slice_kind,
            "border": border,
            "displayBounds": {
                "width": source_size.get("width", e.get("width", 0)),
                "height": source_size.get("height", e.get("height", 0)),
            },
            "fromExport": True,  # 标记来源为 export manifest
        }

    # ── Phase 2: 九宫副本去重 ──
    DUPE_SRC = {}
    for nid_a in SIXED_DATA:
        if nid_a in DUPE_SRC:
            continue
        sa = SIXED_DATA[nid_a]
        if sa["border"]["left"] == 0 and sa["border"]["right"] == 0:
            continue
        for nid_b in SIXED_DATA:
            if nid_b == nid_a or nid_b in DUPE_SRC:
                continue
            sb = SIXED_DATA[nid_b]
            if sa["type"] == sb["type"] and sa["border"] == sb["border"]:
                DUPE_SRC[nid_b] = nid_a

    # ── Phase 3: INSTANCE 处理 ──
    COMMON_PREFAB_INDEX = scan_common_prefabs()
    INSTANCE_IMAGE_DATA = {}
    PREFAB_INSTANCE_REFS = []
    PREFAB_ID_COUNTER = [0]
    for n in nodes_list:
        if n["type"] != "INSTANCE":
            continue
        nid, nname = n["id"], n.get("name", "")
        for cid in children_map.get(nid, []):
            collect_skip_ids(cid, children_map, SKIP_IDS)

        # 优先级 1: Common_Texture 贴图复用
        if not disable_common_texture_reuse and nname in common_index:
            INSTANCE_IMAGE_DATA[nid] = {"type": "CommonTexture", "assetPath": common_index[nname]}
            continue
        if not disable_common_texture_reuse and "Common_Texture_" in nname:
            # 索引未命中时，回退扫描磁盘（用户可能手动放入 _Common/）
            found_path = _find_common_texture_on_disk(nname)
            if found_path:
                INSTANCE_IMAGE_DATA[nid] = {"type": "CommonTexture", "assetPath": found_path}
            else:
                # 磁盘也不存在 → 降级为普通 Image
                for cid in children_map.get(nid, []):
                    for e in export_by_node.get(cid, []):
                        if e.get("base64"):
                            export_by_node[nid].append(e)
                            INSTANCE_IMAGE_DATA[nid] = {"type": "Image"}
                            break
            continue

        # 优先级 2: 公共 Prefab 复用（去括号搜索 + 容错匹配）
        matched_prefab_path, matched_prefab_source = resolve_common_prefab_match(
            n,
            COMMON_PREFAB_INDEX,
            require_common_candidate=disable_common_prefab_reuse,
        )
        if disable_common_prefab_reuse:
            # Isolated test imports still reuse project Common prefabs when they already exist.
            # Only non-Common instances are downgraded to local images.
            if not matched_prefab_path:
                for cid in children_map.get(nid, []):
                    for e in export_by_node.get(cid, []):
                        if e.get("base64"):
                            export_by_node[nid].append(e)
                            INSTANCE_IMAGE_DATA[nid] = {"type": "Image"}
                            break
                    if nid in INSTANCE_IMAGE_DATA:
                        break
                continue

        search_name = nname.replace("[", "").replace("]", "").strip()
        # 精确匹配
        if not matched_prefab_path and search_name in COMMON_PREFAB_INDEX:
            matched_prefab_path = COMMON_PREFAB_INDEX[search_name]
            matched_prefab_source = "nodeName"
        elif not matched_prefab_path:
            # 模糊匹配：去除 Common_Prefab_ 前缀后匹配
            stripped = search_name
            for prefix in ["Common_Prefab_", "UI_Common_", "Common_"]:
                if stripped.startswith(prefix):
                    stripped = stripped[len(prefix):]
                    if stripped in COMMON_PREFAB_INDEX:
                        matched_prefab_path = COMMON_PREFAB_INDEX[stripped]
                        break
            # 最后尝试：在 index 中找 search_name 的容错匹配
            if not matched_prefab_path:
                search_lower = search_name.lower()
                # 先去 Common_Prefab_ 前缀再比
                for key, path in COMMON_PREFAB_INDEX.items():
                    key_lower = key.lower()
                    # 子串匹配
                    if search_lower in key_lower or key_lower in search_lower:
                        matched_prefab_path = path
                        break
                    # 两边都去掉 Common_Prefab_ 后比较
                    s_clean = search_lower
                    k_clean = key_lower
                    for prefix in ["common_prefab_", "ui_common_", "common_"]:
                        if s_clean.startswith(prefix):
                            s_clean = s_clean[len(prefix):]
                        if k_clean.startswith(prefix):
                            k_clean = k_clean[len(prefix):]
                    if s_clean == k_clean:
                        matched_prefab_path = path
                        break
                    # 按 _ 分割后仅一段不同，且该段共享首字母+字符重叠 > 60%
                    s_parts = s_clean.split("_")
                    k_parts = k_clean.split("_")
                    if len(s_parts) == len(k_parts):
                        diff_idx = [i for i in range(len(s_parts)) if s_parts[i] != k_parts[i]]
                        if len(diff_idx) == 1:
                            i = diff_idx[0]
                            a, b = s_parts[i], k_parts[i]
                            if len(a) >= 3 and len(b) >= 3 and a[0] == b[0]:
                                overlap = sum(1 for c in a if c in b)
                                if overlap / max(len(a), len(b)) > 0.6:
                                    matched_prefab_path = path
                                    break
        if matched_prefab_path:
            pid = f"prefab_{PREFAB_ID_COUNTER[0]}"
            PREFAB_ID_COUNTER[0] += 1
            PREFAB_INSTANCE_REFS.append({
                "id": pid, "figmaName": nname,
                "sourcePrefabPath": matched_prefab_path,
                "matchSource": matched_prefab_source,
            })
            INSTANCE_IMAGE_DATA[nid] = {"type": "PrefabInstance", "prefabId": pid,
                                        "assetPath": matched_prefab_path}
            continue

        # 优先级 3: 降级为普通 Image，从子节点取图
        for cid in children_map.get(nid, []):
            for e in export_by_node.get(cid, []):
                if e.get("base64"):
                    export_by_node[nid].append(e)
                    INSTANCE_IMAGE_DATA[nid] = {"type": "Image"}
                    break
            if nid in INSTANCE_IMAGE_DATA:
                break

    # ── Phase 4: Hash 去重 ──
    HASH_TO_IMAGE_ID = {}
    img_counter = [0]

    def get_image_hash_for_node(node_id):
        result = None
        for e in export_by_node.get(node_id, []):
            h = e.get("imageHash", "")
            if h:
                if not result:
                    result = h
                if h in HASH_TO_IMAGE_ID:
                    return h
        if not result:
            for cid in children_map.get(node_id, []):
                for e in export_by_node.get(cid, []):
                    h = e.get("imageHash", "")
                    if h:
                        if not result:
                            result = h
                        if h in HASH_TO_IMAGE_ID:
                            return h
        return result if (result and result in HASH_TO_IMAGE_ID) else None

    def register_image(node_id, nine_slice_data=None):
        if nine_slice_data:
            img_id = "img_" + str(img_counter[0])
            img_counter[0] += 1
            return img_id

        for e in export_by_node.get(node_id, []):
            h = e.get("imageHash", "")
            if h and h in HASH_TO_IMAGE_ID:
                return HASH_TO_IMAGE_ID[h]

        img_id = "img_" + str(img_counter[0]); img_counter[0] += 1
        for e in export_by_node.get(node_id, []):
            h = e.get("imageHash", "")
            if h:
                HASH_TO_IMAGE_ID[h] = img_id
        return img_id

    # ── Phase 5: 生成节点树 ──
    spec_nodes = []

    def convert_coords(child_bounds, parent_bounds, rect_transform=None):
        return convert_figma_bounds_to_unity_rect(child_bounds, parent_bounds, rect_transform)

    def figma_constraints_to_rect_transform(node):
        return figma_constraints_to_rect_transform_spec(node.get("constraints") or {})

    def process_node(node_id, parent_bounds, idx_map):
        if node_id in SKIP_IDS:
            return None
        node = node_map.get(node_id)
        if not node:
            return None

        ntype, nname, bounds = node["type"], node["name"], node["bounds"]
        rect_transform = figma_constraints_to_rect_transform(node)
        rect = convert_coords(bounds, parent_bounds, rect_transform)

        if node_id == nodes_list[0]["id"]:
            spec_type, spec_fields = "Root", {}
            ch_ids = [c for c in children_map.get(node_id, []) if c not in SKIP_IDS]
        elif ntype == "TEXT":
            fs = int(node.get("fontSize", 24)) or 24
            # 读取 manifest 中文本实际填充颜色，替代硬编码白色
            _text_fills = node.get("fills", [])
            _fill_color = {"r": 1, "g": 1, "b": 1, "a": node.get("opacity", 1)}
            for _f in _text_fills:
                if _f.get("type") == "SOLID" and _f.get("visible", True):
                    _fc = _f.get("color", {})
                    _fill_color = {"r": _fc.get("r", 1), "g": _fc.get("g", 1), "b": _fc.get("b", 1), "a": node.get("opacity", 1)}
                    break
            spec_type, spec_fields = "Text", {
                "text": node.get("characters", ""), "fontSize": fs,
                "color": _fill_color,
                "alignment": "Center",
            }
            text_material = build_text_material_spec(node, fs)
            if text_material:
                spec_fields["textMaterial"] = text_material
            ch_ids = []
        elif node_id in SIXED_DATA:
            sd = SIXED_DATA[node_id]
            src_id = DUPE_SRC.get(node_id, node_id)
            iid = register_image(src_id, nine_slice_data=SIXED_DATA[src_id])
            spec_type, spec_fields = "Image", {"imageId": iid, "imageType": "Sliced", "color": {"r": 1, "g": 1, "b": 1, "a": node.get("opacity", 1)}}
            ch_ids = []
        elif node_id in INSTANCE_IMAGE_DATA:
            _idata = INSTANCE_IMAGE_DATA[node_id]
            if _idata.get("type") == "PrefabInstance":
                spec_type, spec_fields = "PrefabInstance", {"prefabId": _idata["prefabId"]}
                ch_ids = []
            else:
                iid = register_image(node_id)
                spec_type, spec_fields = "Image", {"imageId": iid, "imageType": "Simple", "color": {"r": 1, "g": 1, "b": 1, "a": node.get("opacity", 1)}}
                ch_ids = []
        elif ntype in ("RECTANGLE", "FRAME"):
            has_own_export = len(export_by_node.get(node_id, [])) > 0
            # 只查节点自身的导出，不递归子节点（避免把子节点有图的 FRAME 容器误判为 Image）
            if has_own_export:
                # 纯色无效果节点 → 共享白像素 + color，不导出 PNG
                if is_solid_only_no_effects(node):
                    spec_type, spec_fields = "Image", {
                        "imageId": WHITE_PIXEL_IMAGE_ID,
                        "imageType": "Simple",
                        "color": get_solid_fill_color(node),
                    }
                else:
                    iid = register_image(node_id)
                    spec_type, spec_fields = "Image", {
                        "imageId": iid, "imageType": "Simple",
                        "color": {"r": 1, "g": 1, "b": 1, "a": node.get("opacity", 1)},
                    }
            else:
                spec_type, spec_fields = "Panel", {}
            ch_ids = [c for c in children_map.get(node_id, []) if c not in SKIP_IDS]
        else:
            spec_type, spec_fields = "Panel", {}
            ch_ids = [c for c in children_map.get(node_id, []) if c not in SKIP_IDS]

        # 先添加到数组（确保 Root 在 index 0）
        idx = len(spec_nodes)
        spec_node = {
            "name": unity_node_name(nname, spec_type == "Root", prefab_name),
            "type": spec_type, "rect": rect, "childIndices": [],
        }
        spec_node["rectTransform"] = rect_transform
        spec_node.update(spec_fields)
        spec_nodes.append(spec_node)
        idx_map[node_id] = idx

        # 再处理子节点
        child_indices = []
        # Instance 节点通常不处理子节点（由 PrefabInstance/CommonTexture 处理）
        # 但如果 Instance 内部有九宫图，需要处理这些子节点
        should_process_children = ntype != "INSTANCE"
        if ntype == "INSTANCE":
            # 检查是否有九宫子节点需要处理
            has_sliced_child = any(cid in SIXED_DATA for cid in ch_ids)
            if has_sliced_child:
                should_process_children = True

        if should_process_children:
            for cid in ch_ids:
                ci = process_node(cid, bounds, idx_map)
                if ci is not None:
                    child_indices.append(ci)

        spec_nodes[idx]["childIndices"] = child_indices
        return idx

    idx_map = {}
    process_node(nodes_list[0]["id"], root_bounds, idx_map)

    # ── Phase 6: 构建 ImageSpec ──
    used_ids = {sn["imageId"] for sn in spec_nodes if sn.get("imageId")}
    images_spec, dl_images = [], []

    for iid in sorted(used_ids):
        # 内置白像素：引用本地白像素文件（已在 main() 中生成），不加入下载清单
        if iid == WHITE_PIXEL_IMAGE_ID:
            images_spec.append({
                "id": WHITE_PIXEL_IMAGE_ID,
                "fileName": WHITE_PIXEL_FILENAME,
                "targetDir": target_image_dir,
                "spriteSettingJson": json.dumps({"pivot": {"x": 0.5, "y": 0.5}, "border": {"l": 0, "b": 0, "r": 0, "t": 0}}),
            })
            continue

        # 找代表性节点
        rep_nid = None
        for nid, ix in idx_map.items():
            if ix < len(spec_nodes) and spec_nodes[ix].get("imageId") == iid:
                rep_nid = nid; break

        node_name = spec_nodes[idx_map[rep_nid]]["name"].strip("[]") if rep_nid else "unknown"
        is_sliced = spec_nodes[idx_map[rep_nid]].get("imageType") == "Sliced" if rep_nid else False

        bd = SIXED_DATA[rep_nid]["border"] if rep_nid and rep_nid in SIXED_DATA else {}
        border = {"l": bd.get("left", 0), "b": bd.get("bottom", 0), "r": bd.get("right", 0), "t": bd.get("top", 0)}

        # Common_Texture 节点直接指向已有公共贴图路径，不自建副本
        is_common_texture = rep_nid and rep_nid in INSTANCE_IMAGE_DATA and INSTANCE_IMAGE_DATA[rep_nid].get("type") == "CommonTexture"
        if is_common_texture:
            ct_path = INSTANCE_IMAGE_DATA[rep_nid]["assetPath"]
            ct_fname = os.path.basename(ct_path)
            target_dir = normalize_unity_asset_dir(os.path.dirname(ct_path))
            fname = ct_fname
        else:
            target_dir = target_image_dir
            fname = sanitize_name(node_name) + ".png"
            if is_sliced:
                fname = fname.replace("__slice.png", "_jiugong.png")

        images_spec.append({
            "id": iid, "fileName": fname, "targetDir": target_dir,
            "spriteSettingJson": json.dumps({"pivot": {"x": 0.5, "y": 0.5}, "border": border}),
        })
        export_item = find_export_for_download(rep_nid, export_by_node, children_map) if rep_nid else {}
        expected_width = int(export_item.get("width", 0) or 0)
        expected_height = int(export_item.get("height", 0) or 0)

        asset_path = unity_asset_join(target_dir, fname)
        reuse_existing_asset = bool(is_common_texture) or _unity_asset_exists(asset_path)

        dl_images.append({
            "imageId": iid, "fileName": fname,
            "figmaNodeId": rep_nid or "",
            "imageHash": export_item.get("imageHash", ""),
            "downloadUrl": export_item.get("downloadUrl", ""),
            "targetAssetPath": asset_path,
            "expectedSize": {"x": expected_width, "y": expected_height},
            "expectedMD5": calculate_base64_md5(export_item.get("base64", "")),
            "imageType": "Sliced" if is_sliced else "Simple", "border": border,
            "needsContentVerification": not bool(export_item.get("base64", "")),
            "reuseExistingAsset": reuse_existing_asset,
            "reuseReason": "CommonTexture" if is_common_texture else ("ExistingUnityAsset" if reuse_existing_asset else ""),
        })

    # 图片文件名去重：同名不同图的节点追加唯一后缀，防止 process_images.py 覆盖
    canonical_by_content = {}
    remap_image_ids = {}
    for i, dl_item in enumerate(dl_images):
        content_md5 = dl_item.get("expectedMD5") or dl_item.get("imageHash") or ""
        if not content_md5:
            continue
        key = (images_spec[i]["fileName"], content_md5)
        if key in canonical_by_content:
            canonical_index = canonical_by_content[key]
            remap_image_ids[images_spec[i]["id"]] = images_spec[canonical_index]["id"]
            continue
        canonical_by_content[key] = i
    if remap_image_ids:
        for sn in spec_nodes:
            image_id = sn.get("imageId")
            if image_id in remap_image_ids:
                sn["imageId"] = remap_image_ids[image_id]
        keep_ids = {sn["imageId"] for sn in spec_nodes if sn.get("imageId")}
        images_spec = [img for img in images_spec if img["id"] in keep_ids]
        dl_images = [img for img in dl_images if img["imageId"] in keep_ids]

    asset_path_to_image_id = {}
    remap_image_ids = {}
    for dl_item in dl_images:
        target_asset_path = str(dl_item.get("targetAssetPath") or "").replace("\\", "/")
        image_id = dl_item.get("imageId")
        if not target_asset_path or not image_id:
            continue
        if target_asset_path in asset_path_to_image_id:
            remap_image_ids[image_id] = asset_path_to_image_id[target_asset_path]
            continue
        asset_path_to_image_id[target_asset_path] = image_id
    if remap_image_ids:
        for sn in spec_nodes:
            image_id = sn.get("imageId")
            if image_id in remap_image_ids:
                sn["imageId"] = remap_image_ids[image_id]
        keep_ids = {sn["imageId"] for sn in spec_nodes if sn.get("imageId")}
        images_spec = [img for img in images_spec if img["id"] in keep_ids]
        dl_images = [img for img in dl_images if img["imageId"] in keep_ids]

    fname_counts = Counter(
        img["fileName"]
        for i, img in enumerate(images_spec)
        if not (i < len(dl_images) and dl_images[i].get("reuseExistingAsset"))
    )
    if any(v > 1 for v in fname_counts.values()):
        # 为每个重复图片准备唯一后缀：优先用 imageHash 前 8 位，否则用序号
        fname_seq = {fname: 0 for fname, v in fname_counts.items() if v > 1}
        for i, img in enumerate(images_spec):
            dl_item = dl_images[i] if i < len(dl_images) else {}
            if dl_item.get("reuseExistingAsset"):
                continue
            fname = img["fileName"]
            if fname_counts.get(fname, 0) > 1:
                hash_suffix = (dl_item.get("expectedMD5") or dl_item.get("imageHash") or "")[:8]
                if not hash_suffix:
                    hash_suffix = str(fname_seq[fname])
                    fname_seq[fname] += 1
                base, ext = fname.rsplit(".", 1)
                new_fname = f"{base}_{hash_suffix}.{ext}"
                img["fileName"] = new_fname
                if i < len(dl_images):
                    dl_images[i]["fileName"] = new_fname
                    dl_images[i]["targetAssetPath"] = unity_asset_join(img.get("targetDir", ""), new_fname)

    images_spec, dl_images, name_size_dedup_review = apply_name_size_fallback_dedup(spec_nodes, images_spec, dl_images)

    # ── 保护门禁：reuseExistingAsset 的图片，从已有 .meta 读取正确 border ──
    # 防止 FigmaPrefabGenerator.ApplySpriteBorderAfterImport() 用 Spec 中 border=0
    # 覆写已有 Common_Texture_* 的正确九宫 border。
    # 这里不删除 images_spec 条目（GUID 解析需要保留），只修正 border 为已有文件实际值。
    for idx, dl in enumerate(dl_images):
        if not dl.get("reuseExistingAsset"):
            continue
        target_path = dl.get("targetAssetPath", "")
        if not target_path:
            continue
        _dp = str(target_path or "").replace("\\", "/")
        if _dp.startswith("Assets/"):
            meta_path = str(UNITY_PROJECT / _dp) + ".meta"
        elif _dp.startswith("JellybeanUnity/"):
            meta_path = str(REPO_ROOT / _dp) + ".meta"
        else:
            meta_path = str(REPO_ROOT / _dp) + ".meta"
        if not os.path.isfile(meta_path):
            continue
        import re as _re
        with open(meta_path, "r", encoding="utf-8") as _mf:
            _mc = _mf.read()
        _m = _re.search(r"spriteBorder:\s*\{\s*x:\s*([\d.]+)\s*,\s*y:\s*([\d.]+)\s*,\s*z:\s*([\d.]+)\s*,\s*w:\s*([\d.]+)\s*\}", _mc)
        if not _m:
            continue
        existing_border = {"l": int(float(_m.group(1))), "b": int(float(_m.group(2))), "r": int(float(_m.group(3))), "t": int(float(_m.group(4)))}
        if existing_border == {"l": 0, "b": 0, "r": 0, "t": 0}:
            continue
        # 修正 images_spec 中对应的边框
        for img in images_spec:
            if img["id"] == dl.get("imageId"):
                old_ss = json.loads(img["spriteSettingJson"])
                old_ss["border"] = existing_border
                img["spriteSettingJson"] = json.dumps(old_ss)
                break
        # 同时修正对应节点的 imageType：非零 border 表示九宫图，必须设为 Sliced
        for sn in spec_nodes:
            if sn.get("imageId") == dl.get("imageId") and sn.get("imageType") == "Simple":
                sn["imageType"] = "Sliced"

    used_prefab_ids = {
        str(node.get("prefabId") or "")
        for node in spec_nodes
        if node.get("type") == "PrefabInstance" and node.get("prefabId")
    }
    prefab_instance_refs = [
        ref for ref in PREFAB_INSTANCE_REFS
        if str(ref.get("id") or "") in used_prefab_ids
    ]

    spec = {
        "prefabName": prefab_name, "prefabPath": target_prefab,
        "rootSize": {"x": root_bounds["width"], "y": root_bounds["height"]},
        "images": images_spec, "prefabInstances": prefab_instance_refs, "nodes": spec_nodes,
    }
    dl_plan = {
        "manifestProvenance": manifest_provenance,
        "images": dl_images,
    }

    return spec, dl_plan, name_size_dedup_review


def generate_markdown_report(spec, dl_plan, node_types, sixed_summary, dedup_summary, mismatch_report):
    """生成 AI 可直接展示的 Markdown 确认报告"""
    lines = []
    lines.append("## 批量确认报告：阶段一完成")
    lines.append("")
    lines.append("### Spec 生成预检")
    lines.append("")
    lines.append("| 项目 | 数量 |")
    lines.append("|------|------|")
    lines.append(f"| 总节点 | **{len(spec['nodes'])}** |")
    lines.append(f"| 图片规格 | **{len(spec['images'])}** |")
    lines.append(f"| 去重后唯一图片 | **{dedup_summary.get('uniqueImageFiles', len(spec['images']))}** |")
    for t, c in sorted(node_types.items()):
        lines.append(f"| {t} 节点 | {c} |")
    lines.append("")
    material_summary = dedup_summary.get("textMaterials", {})
    if material_summary:
        lines.append("### TMP 描边/投影材质复用")
        lines.append("")
        lines.append("| 签名 | 节点数 | 材质名 |")
        lines.append("|------|--------|--------|")
        for signature, info in sorted(material_summary.items()):
            lines.append(f"| `{signature}` | {info['count']} | `{info['materialName']}` |")
        lines.append("")
    lines.append("### 九宫容器门禁表")
    lines.append("")
    if sixed_summary:
        lines.append("| 文件 | 类型 | Border (L/B/R/T) | 实际尺寸 | 期望最小 | 状态 |")
        lines.append("|------|------|------------------|----------|----------|------|")
        for s in sixed_summary:
            status = "✅" if s.get("sizeOk") else "⚠️ 偏大"
            lines.append(f"| {s['fileName']} | {s['sliceType']} | {s['border']} | {s['actualSize']} | {s['minSize']} | {status} |")
    else:
        lines.append("无九宫容器")
    lines.append("")
    lines.append("### 去重 / Common_Texture 复用")
    lines.append("")
    if dedup_summary.get("commonTexture"):
        lines.append("| 资源 | 出现次数 | 处理 |")
        lines.append("|------|---------|------|")
        for ct in dedup_summary["commonTexture"]:
            lines.append(f"| {ct['name']} | ×{ct['count']} | {ct['handling']} |")
    lines.append("")
    if dedup_summary.get("duplicateSliced"):
        lines.append("| 副本容器 | 源容器 |")
        lines.append("|---------|--------|")
        for d in dedup_summary["duplicateSliced"]:
            lines.append(f"| {d['dup']} | {d['src']} |")
        lines.append("")

    # ── 公共 Prefab 复用 ──
    if spec.get("prefabInstances"):
        lines.append("### 公共 Prefab 复用")
        lines.append("")
        lines.append("| INSTANCE 节点 | 源 Prefab 路径 |")
        lines.append("|-------------|---------------|")
        for pi in spec["prefabInstances"]:
            lines.append(f"| {pi['figmaName']} | `{pi['sourcePrefabPath']}` |")
        lines.append("")

    # 文件名不匹配告警
    if mismatch_report and mismatch_report.get("specMissing", []):
        lines.append("### ⚠️ 文件名不匹配")
        lines.append("")
        for m in mismatch_report.get("specMissing", []):
            lines.append(f"- Spec 期望 `{m['expected']}` → 磁盘存在 `{m['disk']}`")
        lines.append("")

    lines.append("### 影响文件")
    lines.append("")
    lines.append(f"- Prefab: `{spec['prefabPath']}` (新建)")
    lines.append(f"- 图片: `{spec['images'][0]['targetDir'] + '*' if spec['images'] else '无'}` ({len(spec['images'])} 文件)")
    lines.append("")
    lines.append("已加载: workflow ✅ | pitfalls ✅ | conventions ✅ | json-spec-format ✅")

    return "\n".join(lines)


def check_file_mismatch(images_spec, image_dir_abs):
    """对比 Spec 中的文件名与磁盘实际文件名，返回不匹配报告"""
    import os as _os

    report = {"specMissing": [], "diskExtra": [], "ok": 0}
    spec_names = {img["fileName"] for img in images_spec}

    disk_names = set()
    if _os.path.isdir(image_dir_abs):
        for f in _os.listdir(image_dir_abs):
            if f.endswith(".png"):
                disk_names.add(f)

    for sname in sorted(spec_names):
        if sname in disk_names:
            report["ok"] += 1
            continue
        # 尝试找近似匹配
        base = sname.replace("__slice.png", "")
        for dname in disk_names:
            dbase = dname.replace("_jiugong.png", "").replace(".png", "")
            if base == dbase:
                report["specMissing"].append({"expected": sname, "disk": dname, "fix": "rename"})
                break
        else:
            report["specMissing"].append({"expected": sname, "disk": None, "fix": "missing"})

    for dname in sorted(disk_names - spec_names):
        report["diskExtra"].append(dname)

    return report


def unity_project_relative_path(path):
    """把仓库根路径或 Unity 工程路径统一转为 Unity 工程内相对路径。"""
    normalized = str(path).replace("\\", "/")
    marker = "JellybeanUnity/"
    if normalized.startswith(marker):
        return normalized[len(marker):]
    if marker in normalized:
        return normalized.split(marker, 1)[1]
    return normalized


def make_check(pass_state, summary=None, details=None):
    """创建统一审核检查项，供 LLM 直接读取判断。"""
    return {
        "pass": bool(pass_state),
        "summary": summary or {},
        "details": details or [],
    }


def validate_child_indices(spec):
    """校验 childIndices 是否都指向合法节点，避免 Prefab 递归挂载错乱。"""
    nodes = spec.get("nodes", [])
    invalid = []
    for node_index, node in enumerate(nodes):
        seen = set()
        for child_index in node.get("childIndices", []):
            if not isinstance(child_index, int) or child_index < 0 or child_index >= len(nodes):
                invalid.append({
                    "nodeIndex": node_index,
                    "nodeName": node.get("name", ""),
                    "childIndex": child_index,
                    "reason": "out_of_range",
                })
                continue
            if child_index in seen:
                invalid.append({
                    "nodeIndex": node_index,
                    "nodeName": node.get("name", ""),
                    "childIndex": child_index,
                    "reason": "duplicate_child",
                })
            seen.add(child_index)
    return make_check(len(invalid) == 0, {"nodeCount": len(nodes)}, invalid)


def validate_image_references(spec, dl_plan):
    """校验 Image 节点、ImageSpec 与下载计划之间的一致性。"""
    image_ids = {img.get("id") for img in spec.get("images", [])}
    plan_by_id = {img.get("imageId"): img for img in dl_plan.get("images", [])}
    missing_refs = []
    plan_mismatches = []
    verification_warnings = []

    for node_index, node in enumerate(spec.get("nodes", [])):
        if node.get("type") != "Image":
            continue
        image_id = node.get("imageId")
        if not image_id or image_id not in image_ids:
            missing_refs.append({
                "nodeIndex": node_index,
                "nodeName": node.get("name", ""),
                "imageId": image_id,
            })

    for image_spec in spec.get("images", []):
        image_id = image_spec.get("id")
        if image_id == WHITE_PIXEL_IMAGE_ID:
            continue  # 本地生成的白像素，无需 MCP Relay 下载
        plan_item = plan_by_id.get(image_id)
        if not plan_item:
            plan_mismatches.append({"imageId": image_id, "reason": "missing_download_plan"})
            continue
        expected_target = unity_asset_join(image_spec.get("targetDir", ""), image_spec.get("fileName", ""))
        if plan_item.get("targetAssetPath") != expected_target:
            plan_mismatches.append({
                "imageId": image_id,
                "reason": "target_path_mismatch",
                "specTarget": expected_target,
                "planTarget": plan_item.get("targetAssetPath", ""),
            })
        if plan_item.get("needsContentVerification"):
            verification_warnings.append({
                "imageId": image_id,
                "fileName": image_spec.get("fileName", ""),
                "reason": "missing_base64_md5",
            })

    return (
        make_check(
            len(missing_refs) == 0,
            {"imageNodeMissingRefCount": len(missing_refs), "imageSpecCount": len(image_ids)},
            missing_refs,
        ),
        make_check(
            len(plan_mismatches) == 0,
            {"downloadPlanCount": len(plan_by_id), "mismatchCount": len(plan_mismatches)},
            plan_mismatches,
        ),
        verification_warnings,
    )


def validate_target_paths(spec):
    """校验 Prefab 和图片目标路径格式，避免脚本写入 Unity 工程外。"""
    invalid = []
    prefab_path = spec.get("prefabPath", "")
    if not prefab_path.startswith("Assets/") or not prefab_path.endswith(".prefab"):
        invalid.append({"field": "prefabPath", "value": prefab_path})
    for image_spec in spec.get("images", []):
        target_dir = image_spec.get("targetDir", "")
        file_name = image_spec.get("fileName", "")
        if not target_dir.startswith("Assets/") or not file_name.endswith(".png"):
            invalid.append({
                "imageId": image_spec.get("id", ""),
                "targetDir": target_dir,
                "fileName": file_name,
            })
    return make_check(len(invalid) == 0, {"invalidPathCount": len(invalid)}, invalid)


def build_audit_report(spec, dl_plan, node_types, sixed_summary, dedup_summary, mismatch_report, artifacts, filename_mismatch_blocking=True):
    """生成结构化审核报告，LLM 只负责读取和判断。"""
    checks = {
        "rootNode": make_check(
            bool(spec.get("nodes")) and spec["nodes"][0].get("type") == "Root",
            {"firstNodeType": spec.get("nodes", [{}])[0].get("type", "") if spec.get("nodes") else ""},
        ),
        "childIndices": validate_child_indices(spec),
        "targetPaths": validate_target_paths(spec),
    }
    image_ref_check, download_plan_check, verification_warnings = validate_image_references(spec, dl_plan)
    checks["imageReferences"] = image_ref_check
    checks["downloadPlan"] = download_plan_check

    mismatch_details = (mismatch_report or {}).get("specMissing", [])
    filename_mismatch_pass = len(mismatch_details) == 0 or not filename_mismatch_blocking
    checks["filenameMismatch"] = make_check(
        filename_mismatch_pass,
        {
            "specMissing": len(mismatch_details),
            "diskExtra": len((mismatch_report or {}).get("diskExtra", [])),
            "blocking": bool(filename_mismatch_blocking),
        },
        mismatch_details,
    )

    blocking_errors = []
    for check_name, check_result in checks.items():
        if check_result.get("pass"):
            continue
        blocking_errors.append({
            "code": check_name,
            "message": f"{check_name} 检查失败",
            "details": check_result.get("details", []),
        })

    warnings = []
    if mismatch_details and not filename_mismatch_blocking:
        warnings.append({
            "code": "prewriteMissingImages",
            "message": "写入前图片目录尚未包含下载计划将写入的 PNG，已降级为 warning；写后以 process_images.py 报告为准。",
            "details": mismatch_details,
        })
    warnings.extend({
        "code": "imageContentVerificationPending",
        "message": "下载计划缺少 base64 MD5，需要后续图片处理脚本校验实际内容。",
        "details": item,
    } for item in verification_warnings)
    if sixed_summary:
        warnings.append({
            "code": "nineSliceActualSizePending",
            "message": "阶段一只生成九宫期望尺寸，实际 PNG 尺寸必须以 process_images.py 报告为准。",
            "details": {"slicedCount": len(sixed_summary)},
        })
    if mismatch_report and mismatch_report.get("diskExtra"):
        warnings.append({
            "code": "diskExtraImages",
            "message": "目标目录存在 Spec 未引用的 PNG，创建新 Prefab 时通常可忽略，同步时需人工确认。",
            "details": mismatch_report.get("diskExtra", []),
        })

    return {
        "allPass": len(blocking_errors) == 0,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "summary": {
            "nodeCount": len(spec.get("nodes", [])),
            "imageCount": len(spec.get("images", [])),
            "downloadPlanImageCount": len(dl_plan.get("images", [])),
            "nodeTypes": node_types,
            "slicedCount": len(sixed_summary),
            "uniqueImageFiles": dedup_summary.get("uniqueImageFiles", 0),
            "commonTextureReuseCount": len(dedup_summary.get("commonTexture", [])),
            "textMaterialSignatureCount": len(dedup_summary.get("textMaterials", {})),
            "textMaterialNodeCount": sum(item.get("count", 0) for item in dedup_summary.get("textMaterials", {}).values()),
        },
        "checks": checks,
        "artifacts": artifacts,
    }


def main():
    parser = argparse.ArgumentParser(description="Figma → Unity Prefab Spec 生成器")
    parser.add_argument("--self-test", action="store_true", help="运行 Constraints/RectTransform 转换自测")
    parser.add_argument("--figma-url", help="Figma 设计稿 URL")
    parser.add_argument("--target-prefab", help="目标 Prefab 路径，如 Assets/_Resources/X/UI_X.prefab")
    parser.add_argument("--target-image-dir", help="图片输出目录，如 Assets/_Art/Texture/GUI/X/")
    parser.add_argument("--prefab-name", help="Prefab 根节点名（默认从 URL 推断）")
    parser.add_argument("--manifest-dir", default=".tmp/figma-to-prefab", help="MCP Relay manifest 目录")
    parser.add_argument("--output-spec", default="JellybeanUnity/.tmp/prefab_spec.json", help="Spec 输出路径")
    parser.add_argument("--output-plan", default="JellybeanUnity/.tmp/image_download_plan.json", help="下载计划输出路径")
    parser.add_argument("--output-roslyn-import-plan", default="JellybeanUnity/.tmp/roslyn_import_plan.txt",
                        help="Roslyn Prefab 生成 code-file 读取的导入计划")
    parser.add_argument("--output-report", default="", help="Markdown 确认报告输出路径（留空则输出到 stdout）")
    parser.add_argument("--output-audit-report", default="JellybeanUnity/.tmp/spec_audit_report.json",
                        help="结构化审核报告输出路径")
    parser.add_argument("--auto-componentsets", dest="auto_componentsets", action="store_true", default=True,
                        help="默认开启：自动检测本节点内 ComponentSet 并生成旁边 Prefab specs")
    parser.add_argument("--no-auto-componentsets", dest="auto_componentsets", action="store_false",
                        help="关闭自动 ComponentSet 检测")
    parser.add_argument("--component-spec-dir", default="JellybeanUnity/.tmp/figma_component_specs",
                        help="自动 ComponentSet spec 输出目录")
    parser.add_argument("--componentset-report", default="JellybeanUnity/.tmp/componentset_report.json",
                        help="自动 ComponentSet 结构化报告输出路径")
    parser.add_argument("--check-disk-dir", default="", help="检查磁盘文件与 Spec 一致性（图片目录绝对路径）")
    parser.add_argument("--check-disk-prewrite", action="store_true",
                        help="写入前检查模式：Spec 中即将由下载计划写入的缺失图片只作为 warning，不阻塞")
    parser.add_argument("--disable-common-texture-reuse", action="store_true",
                        help="Export Common_Texture_* into --target-image-dir for isolated test imports")
    parser.add_argument("--disable-common-prefab-reuse", action="store_true",
                        help="Do not bind Figma instances to project-wide common Prefabs")
    parser.add_argument("--dry-run", action="store_true", help="试运行：只打印摘要")

    args = parser.parse_args()
    if args.self_test:
        run_self_test()
        print("figma-to-prefab gen_spec self-test passed")
        return 0
    missing_required = [
        name for name in ("figma_url", "target_prefab", "target_image_dir")
        if not getattr(args, name)
    ]
    if missing_required:
        parser.error("missing required arguments: " + ", ".join("--" + name.replace("_", "-") for name in missing_required))
    args.target_image_dir = normalize_unity_asset_dir(args.target_image_dir)

    file_key, node_id = parse_figma_url(args.figma_url)
    if not args.prefab_name:
        args.prefab_name = Path(args.target_prefab).stem

    manifest_dir = resolve_manifest_dir(args.manifest_dir)

    # 加载 Common_Texture 缓存（自动构建）
    common_index = get_index()

    # 生成
    spec, dl_plan, name_size_dedup_review = build_spec(
        manifest_dir, args.target_prefab, args.target_image_dir,
        args.prefab_name, common_index,
        disable_common_texture_reuse=args.disable_common_texture_reuse,
        disable_common_prefab_reuse=args.disable_common_prefab_reuse,
    )
    manifest_provenance = dl_plan.get("manifestProvenance", {})
    componentset_report = None
    if args.auto_componentsets:
        target_dir = str(Path(args.target_prefab).parent).replace("\\", "/")
        spec, dl_plan, componentset_report = apply_auto_componentsets_to_data(
            manifest_dir=str(manifest_dir),
            spec=spec,
            download_plan=dl_plan,
            component_spec_dir=args.component_spec_dir,
            target_dir=target_dir,
            target_image_dir=args.target_image_dir,
            output_report=args.componentset_report,
        )
        if manifest_provenance and not dl_plan.get("manifestProvenance"):
            dl_plan["manifestProvenance"] = manifest_provenance

    if _spec_uses_white_pixel(spec):
        _ensure_white_pixel_png(args.target_image_dir)

    # ── 目标目录一致性门禁 ──
    mismatched_dirs = {}
    for img in spec.get("images", []):
        td = img.get("targetDir", "")
        if img["id"] == WHITE_PIXEL_IMAGE_ID:
            continue  # 内置白像素驻留在 _Common/，不依赖 --target-image-dir
        fname = img.get("fileName", "")
        if (
            not args.disable_common_texture_reuse
            and fname.startswith("Common_Texture_")
            and "_Common/" in td.replace("\\", "/")
        ):
            continue  # Common_Texture 复用指向 _Common/ 目录，不依赖 --target-image-dir
        if td != args.target_image_dir:
            mismatched_dirs[img["id"]] = {"fileName": img["fileName"], "targetDir": td, "expected": args.target_image_dir}
    if mismatched_dirs:
        print(f"[BLOCKING] {len(mismatched_dirs)} 个 ImageSpec.targetDir 与 --target-image-dir 不一致!")
        for mid, minfo in mismatched_dirs.items():
            print(f"  {mid}: {minfo['fileName']} → {minfo['targetDir']} (期望: {minfo['expected']})")

    # ── 统计数据 ──
    types = defaultdict(int)
    for sn in spec["nodes"]:
        types[sn["type"]] += 1

    # ── 九宫摘要 ──
    sixed_summary = []
    used_sliced = {sn["imageId"] for sn in spec["nodes"] if sn.get("imageType") == "Sliced"}
    for img in spec["images"]:
        if img["id"] in used_sliced:
            border = json.loads(img["spriteSettingJson"]).get("border", {})
            b_l, b_b, b_r, b_t = border.get("l", 0), border.get("b", 0), border.get("r", 0), border.get("t", 0)
            min_w = b_l + b_r + 2
            min_h = b_t + b_b + 2
            sixed_summary.append({
                "fileName": img["fileName"],
                "sliceType": "9slice" if b_t > 0 and b_b > 0 else ("h3slice" if b_l > 0 and b_r > 0 else "v3slice"),
                "border": f"{b_l}/{b_b}/{b_r}/{b_t}",
                "actualSize": "?",
                "minSize": f"{min_w}×{min_h}",
                "sizeOk": None,  # 由 process_images 后填充
            })

    # ── 去重摘要 ──
    dedup_summary = {"commonTexture": [], "duplicateSliced": [], "uniqueImageFiles": 0, "textMaterials": {}, "filenameConflicts": []}
    dedup_review_path = Path(args.output_spec).parent / "image_dedup_review.json"
    dedup_summary["nameSizeFallback"] = {
        "mergedCount": name_size_dedup_review.get("mergedCount", 0),
        "reportPath": str(dedup_review_path).replace("\\", "/"),
    }
    unique_names = set()
    for img in spec["images"]:
        unique_names.add(img["fileName"])
    dedup_summary["uniqueImageFiles"] = len(unique_names)
    # 检测文件名冲突（gen_spec 内核去重后仍残留的冲突）
    raw_names = Counter(img["fileName"].rsplit("_", 1)[0] for img in spec["images"])
    for name_root, count in raw_names.items():
        if count > 1:
            dedup_summary["filenameConflicts"].append({
                "nameRoot": name_root, "count": count,
                "status": "已自动去重追加哈希后缀" if name_root in [img["fileName"].rsplit("_", 1)[0] for img in spec["images"]] else "未去重",
            })

    # 统计 Common_Texture（从缓存索引查找）
    ct_counts = defaultdict(int)
    ct_paths = {}
    for img in spec["images"]:
        name = img["fileName"].replace(".png", "")
        if name in common_index:
            ct_counts[name] += 1
            ct_paths[name] = common_index[name]
    for ct_name, count in ct_counts.items():
        dedup_summary["commonTexture"].append({
            "name": ct_name, "count": count,
            "handling": f"共用一个文件，{ct_paths[ct_name]}",
        })

    # 统计 TMP 描边/投影材质签名，相同效果在 Unity 侧只生成或复用一个材质。
    for sn in spec["nodes"]:
        tm = sn.get("textMaterial")
        if not tm:
            continue
        signature = tm.get("signature", "")
        if not signature:
            continue
        item = dedup_summary["textMaterials"].setdefault(signature, {
            "count": 0,
            "materialName": tm.get("materialName", ""),
        })
        item["count"] += 1

    if args.dry_run:
        print(f"节点: {len(spec['nodes'])} {dict(types)}")
        print(f"图片: {len(spec['images'])} 唯一: {dedup_summary['uniqueImageFiles']}")
        if componentset_report:
            print(f"ComponentSet: {componentset_report['summary']['componentSetCount']}")
        if sixed_summary:
            print(f"\n九宫门禁表:")
            for s in sixed_summary:
                print(f"  {s['fileName']}: border={s['border']} min={s['minSize']}")
        return 0

    # ── 写入 ──
    for path, data in [(args.output_spec, spec), (args.output_plan, dl_plan)]:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    dedup_review_path.write_text(json.dumps(name_size_dedup_review, ensure_ascii=False, indent=2), encoding="utf-8")
    dedup_review_path.write_text(json.dumps(name_size_dedup_review, ensure_ascii=False, indent=2), encoding="utf-8")

    roslyn_spec_paths = []
    if componentset_report:
        for item in componentset_report.get("componentSets", []):
            unity_spec_path = item.get("unitySpecPath") or unity_project_relative_path(item.get("specPath", ""))
            if unity_spec_path:
                roslyn_spec_paths.append(unity_spec_path)
    roslyn_spec_paths.append(unity_project_relative_path(args.output_spec))
    roslyn_plan_path = Path(args.output_roslyn_import_plan)
    roslyn_plan_path.parent.mkdir(parents=True, exist_ok=True)
    roslyn_plan_lines = [
        "projectRoot=" + str(UNITY_PROJECT.resolve().as_posix()),
        "imageDir=" + args.target_image_dir,
    ]
    roslyn_plan_lines.extend("specPath=" + path for path in roslyn_spec_paths)
    roslyn_plan_path.write_text("\n".join(roslyn_plan_lines) + "\n", encoding="utf-8")

    # ── 文件名一致性检查 ──
    mismatch_report = None
    mismatch_path = None
    if args.check_disk_dir:
        mismatch_report = check_file_mismatch(spec["images"], args.check_disk_dir)
        mismatch_path = Path(args.output_spec).parent / "filename_mismatch_report.json"
        mismatch_path.write_text(json.dumps(mismatch_report, ensure_ascii=False, indent=2), encoding="utf-8")
        if mismatch_report["specMissing"]:
            if args.check_disk_prewrite:
                print(f"⚠ 写入前待生成图片: {len(mismatch_report['specMissing'])} 个 (详情 → {mismatch_path})")
            else:
                print(f"⚠ 文件名不匹配: {len(mismatch_report['specMissing'])} 个 (详情 → {mismatch_path})")

    # ── 生成 Markdown 报告 ──
    report = generate_markdown_report(spec, dl_plan, dict(types), sixed_summary, dedup_summary, mismatch_report)
    if args.output_report:
        Path(args.output_report).write_text(report, encoding="utf-8")
        print(f"Report → {args.output_report}")
    else:
        # 输出到 stdout，AI 可直接读取
        print("\n=== CONFIRMATION_REPORT_START ===")
        print(report)
        print("=== CONFIRMATION_REPORT_END ===")

    audit_report = build_audit_report(
        spec,
        dl_plan,
        dict(types),
        sixed_summary,
        dedup_summary,
        mismatch_report,
        {
            "specPath": args.output_spec,
            "downloadPlanPath": args.output_plan,
            "roslynImportPlanPath": args.output_roslyn_import_plan,
            "markdownReportPath": args.output_report or "stdout",
            "filenameMismatchReportPath": str(mismatch_path) if mismatch_path else "",
            "componentSetReportPath": args.componentset_report if componentset_report else "",
            "componentSpecDir": args.component_spec_dir if componentset_report else "",
        },
        filename_mismatch_blocking=not args.check_disk_prewrite,
    )
    if componentset_report:
        audit_report["summary"]["componentSetCount"] = componentset_report["summary"].get("componentSetCount", 0)
        audit_report["summary"]["expectedPrefabInstanceCount"] = componentset_report["summary"].get("expectedPrefabInstanceCount", 0)
        if componentset_report.get("blockingErrors"):
            audit_report["allPass"] = False
            audit_report["blockingErrors"].extend(componentset_report["blockingErrors"])
        audit_report["warnings"].extend(componentset_report.get("warnings", []))
    audit_path = Path(args.output_audit_report)
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(json.dumps(audit_report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Audit → {args.output_audit_report} | allPass={audit_report['allPass']}")

    # ── 九宫验证门禁 ──
    nine_val = validate_spec(spec, args.target_image_dir)
    if nine_val["blockingErrors"]:
        print("\n[九宫验证] 发现阻塞错误:")
        for e in nine_val["blockingErrors"]:
            print(f"  ❌ [{e['code']}] {e['message']}")
        audit_report["allPass"] = False
        audit_report["blockingErrors"].extend(nine_val["blockingErrors"])
    if nine_val["warnings"]:
        for w in nine_val["warnings"]:
            print(f"  ⚠️ {w.get('message', str(w))}")

    # ── 清理旧版 SOLID fill 残留 PNG ──
    _cleanup_orphan_pngs(args.target_image_dir, spec)

    print(f"Spec → {args.output_spec}")
    print(f"Plan → {args.output_plan}")
    print(f"节点: {len(spec['nodes'])} | 图片: {len(spec['images'])}")
    return 0 if audit_report["allPass"] else 1


def run_self_test():
    """Verify Figma Constraints to Unity RectTransform conversion invariants."""

    expected = {
        ("MIN", "MIN"): ({"x": 0.0, "y": 1.0}, {"x": 0.0, "y": 1.0}),
        ("CENTER", "CENTER"): ({"x": 0.5, "y": 0.5}, {"x": 0.5, "y": 0.5}),
        ("MAX", "MAX"): ({"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 0.0}),
        ("STRETCH", "STRETCH"): ({"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 1.0}),
    }
    for (horizontal, vertical), (anchor_min, anchor_max) in expected.items():
        rect_transform = figma_constraints_to_rect_transform_spec({
            "horizontal": horizontal,
            "vertical": vertical,
        })
        assert rect_transform["anchorMin"] == anchor_min, rect_transform
        assert rect_transform["anchorMax"] == anchor_max, rect_transform
        assert rect_transform["constraints"] == {
            "horizontal": horizontal,
            "vertical": vertical,
        }, rect_transform

    parent = {"x": 0.0, "y": 0.0, "width": 1080.0, "height": 1920.0}
    child = {"x": 0.0, "y": 0.0, "width": 1080.0, "height": 100.0}
    rect_transform = figma_constraints_to_rect_transform_spec({
        "horizontal": "STRETCH",
        "vertical": "MIN",
    })
    rect = convert_figma_bounds_to_unity_rect(child, parent, rect_transform)
    assert rect == {"x": 0.0, "y": -50.0, "w": 0.0, "h": 100.0}, rect

    fallback = figma_constraints_to_rect_transform_spec({
        "horizontal": "BAD",
        "vertical": None,
    })
    assert fallback["constraints"] == {"horizontal": "CENTER", "vertical": "CENTER"}, fallback


if __name__ == "__main__":
    raise SystemExit(main())
