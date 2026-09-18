#!/usr/bin/env python3
"""
并行九宫合成 + 图片导出
- ThreadPoolExecutor 并行处理九宫容器（2min → 30s）
- 参数化：Figma 导出目录、输出目录
"""
import hashlib
import json, os, re, sys, argparse, base64, shutil
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

from nine_slice_common import detect_type_and_border
from name_utils import sanitize_name
from unity_project_paths import normalize_asset_path, resolve_unity_project
from io import BytesIO

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


PLUGIN_ROOT = Path(__file__).resolve().parents[4]


def find_repository_root():
    """Standalone relay runtime root for manifests and caches."""
    return PLUGIN_ROOT


REPOSITORY_ROOT = find_repository_root()
UNITY_PROJECT_ROOT = PLUGIN_ROOT


def get_png_from_base64(b64_str):
    from PIL import Image
    return Image.open(BytesIO(base64.b64decode(b64_str)))


def write_base64_png(b64_str, file_path):
    """把 Relay 导出的 PNG base64 原样写入磁盘，避免重编码导致 MD5 变化。"""
    raw = base64.b64decode(b64_str)
    file_path.write_bytes(raw)
    return len(raw)


def collect_reuse_asset_paths(plan_data):
    """Collect explicit reusable Unity asset paths, downgrading missing files to generated outputs."""
    paths = set()
    missing = []
    for item in plan_data.get("images", []):
        if not item.get("reuseExistingAsset"):
            continue
        target_asset_path = item.get("targetAssetPath", "")
        if target_asset_path:
            resolved = resolve_unity_asset_path(target_asset_path)
            if resolved.is_file():
                paths.add(resolved)
            else:
                missing.append({
                    "imageId": item.get("imageId", ""),
                    "fileName": item.get("fileName", "") or Path(target_asset_path).name,
                    "targetAssetPath": target_asset_path,
                    "reason": "reuseExistingAssetTargetMissing",
                })
    return paths, missing


def should_skip_existing_image(file_path, reuse_asset_paths):
    """已有图片直接复用，不覆盖、不删除、不重新写入。"""
    resolved = Path(file_path).resolve()
    if resolved in reuse_asset_paths:
        return True, "reuseExistingAsset"
    if resolved.is_file():
        return True, "existingUnityAsset"
    return False, ""


def should_skip_existing_generated_image(file_path, reuse_asset_paths):
    """Only explicit reused assets are immutable; generated outputs may refresh."""
    resolved = Path(file_path).resolve()
    if resolved in reuse_asset_paths:
        return True, "reuseExistingAsset"
    return False, ""


def calculate_file_md5(file_path):
    """计算磁盘文件 MD5，用于和下载计划中的 expectedMD5 对比。"""
    return hashlib.md5(Path(file_path).read_bytes()).hexdigest()


def md5_of_base64(b64_str):
    return hashlib.md5(base64.b64decode(b64_str)).hexdigest() if b64_str else ""


def resolve_unity_asset_path(asset_path):
    """把 Unity Assets 相对路径转换为仓库内实际文件路径。"""
    return resolve_project_asset_path(asset_path)


def resolve_project_asset_path(asset_path):
    normalized = normalize_asset_path(asset_path)
    assets_root = (UNITY_PROJECT_ROOT / "Assets").resolve()
    candidate = (assets_root / normalized.removeprefix("Assets/")).resolve()
    try:
        candidate.relative_to(assets_root)
    except ValueError as error:
        raise ValueError(f"Unity asset path escapes project Assets: {asset_path}") from error
    return candidate


def resolve_output_dir(output_dir):
    """规范化输出目录，禁止相对 Assets 落到仓库根。"""
    normalized = str(output_dir).replace("\\", "/")
    raw_path = Path(normalized)
    if raw_path.is_absolute():
        resolved = raw_path.resolve()
        assets_root = (UNITY_PROJECT_ROOT / "Assets").resolve()
        try:
            resolved.relative_to(assets_root)
        except ValueError as error:
            raise ValueError(f"Output directory must remain under Unity Assets: {output_dir}") from error
        return resolved
    return resolve_project_asset_path(normalized)


def resolve_manifest_dir(manifest_dir):
    """相对 manifest-dir 固定按仓库根解析，避免从不同 cwd 启动时读错同名 .tmp。"""
    raw_path = Path(str(manifest_dir))
    if raw_path.is_absolute():
        return raw_path.resolve()
    return (REPOSITORY_ROOT / raw_path).resolve()


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


def sample_ids(ids, limit=8):
    return sorted(str(node_id) for node_id in ids if node_id)[:limit]


def load_download_plan(download_plan_path):
    """读取图片下载计划；缺失或解析失败时返回前置门禁错误。"""
    plan_path = Path(download_plan_path)
    if not plan_path.is_file():
        return {
            "images": [],
            "_loadErrors": [{
                "code": "downloadPlanMissing",
                "message": "未找到 image_download_plan.json，停止图片写入。",
                "path": str(plan_path),
            }],
        }
    try:
        plan_data = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        return {
            "images": [],
            "_loadErrors": [{
                "code": "downloadPlanParseFailed",
                "message": "image_download_plan.json 解析失败，停止图片写入。",
                "path": str(plan_path),
                "error": str(exc),
            }],
        }
    if not isinstance(plan_data, dict) or not isinstance(plan_data.get("images", []), list):
        return {
            "images": [],
            "_loadErrors": [{
                "code": "downloadPlanInvalid",
                "message": "image_download_plan.json 缺少合法 images 数组，停止图片写入。",
                "path": str(plan_path),
            }],
        }
    return plan_data


def validate_output_dir_matches_plan(output_dir, plan_data):
    """校验输出目录必须等于下载计划中非复用图片的目标目录。"""
    if plan_data.get("_loadErrors"):
        return list(plan_data["_loadErrors"])
    expected_dirs = {}
    for item in plan_data.get("images", []):
        if item.get("reuseExistingAsset"):
            continue
        target_asset_path = item.get("targetAssetPath", "")
        if not target_asset_path:
            continue
        expected_dir = resolve_unity_asset_path(target_asset_path).parent.resolve()
        expected_dirs[str(expected_dir)] = {
            "fileName": item.get("fileName", ""),
            "targetAssetPath": target_asset_path,
        }
    if not expected_dirs:
        return []

    resolved_output = output_dir.resolve()
    if len(expected_dirs) == 1 and str(resolved_output) in expected_dirs:
        return []
    return [{
        "code": "outputDirMismatch",
        "message": "--output-dir 与 image_download_plan.json 中的目标图片目录不一致。",
        "outputDir": str(resolved_output),
        "expectedDirs": expected_dirs,
    }]


def read_image_size(file_path):
    """读取 PNG 宽高，读取失败时返回 0 尺寸。"""
    try:
        from PIL import Image
        with Image.open(file_path) as image:
            return image.size
    except Exception:
        return (0, 0)


def sanitize_name(name):
    """委托到共享模块，保持与 gen_spec.py 完全一致。"""
    from name_utils import sanitize_name as _sn
    return _sn(name)


def synthesize_9slice(slices, children, base64_by_node):
    """9-slice: 四角 + 四边 + 中心合成最小 PNG"""
    from PIL import Image

    tl_name = "__slice_top_left"

    def get_slice(slice_name):
        for cid, cn in children.items():
            if cn == slice_name and cid in base64_by_node:
                return get_png_from_base64(base64_by_node[cid])
        return None

    tl = get_slice(tl_name)
    if not tl:
        return None

    left_w = tl.size[0]
    top_h = tl.size[1]
    tr = get_slice("__slice_top_right")
    right_w = tr.size[0] if tr else 0
    bl = get_slice("__slice_bottom_left")
    bottom_h = bl.size[1] if bl else 0

    new_w = left_w + right_w + 2
    new_h = top_h + bottom_h + 2
    result = Image.new("RGBA", (new_w, new_h), (0, 0, 0, 0))

    if tl:
        result.paste(tl, (0, 0))
    if tr:
        result.paste(tr, (left_w + 2, 0))
    if bl:
        result.paste(bl, (0, top_h + 2))
    br = get_slice("__slice_bottom_right")
    if br:
        result.paste(br, (left_w + 2, top_h + 2))

    top = get_slice("__slice_top")
    if top and top.size[0] > 0:
        result.paste(top.resize((2, top_h), Image.LANCZOS), (left_w, 0))
    bottom = get_slice("__slice_bottom")
    if bottom and bottom.size[0] > 0:
        result.paste(bottom.resize((2, bottom_h), Image.LANCZOS), (left_w, top_h + 2))
    left = get_slice("__slice_left")
    if left and left.size[1] > 0:
        result.paste(left.resize((left_w, 2), Image.LANCZOS), (0, top_h))
    right = get_slice("__slice_right")
    if right and right.size[1] > 0:
        result.paste(right.resize((right_w, 2), Image.LANCZOS), (left_w + 2, top_h))

    center = get_slice("__slice_center")
    if center:
        result.paste(center.resize((2, 2), Image.LANCZOS), (left_w, top_h))
    return result


def synthesize_h3slice(slices, children, base64_by_node, display_height=None, parent_node_id=None):
    """h3-slice: 左 + 中 + 右 横向合成，保留完整显示高度。

    Relay 把 Figma CROP fill 导出为完整源图，需要根据 slice bounds 手动裁剪。
    """
    from PIL import Image

    source = None
    if parent_node_id and parent_node_id in base64_by_node:
        parent_source = get_png_from_base64(base64_by_node[parent_node_id])
        if not display_height or parent_source.size[1] >= display_height:
            source = parent_source
    for cid, cn in children.items():
        if source is not None:
            break
        if cid in base64_by_node:
            source = get_png_from_base64(base64_by_node[cid])
            break
    if not source:
        return None

    src_w, src_h = source.size
    left_w = int(slices.get("__slice_left", {}).get("bounds", {}).get("width", 0))
    right_w = int(slices.get("__slice_right", {}).get("bounds", {}).get("width", 0))
    if left_w == 0:
        return None

    h = display_height or source.size[1]
    new_w = left_w + right_w + 2

    result = Image.new("RGBA", (new_w, h), (0, 0, 0, 0))
    # 左边：从源图裁 left_w 列
    result.paste(source.crop((0, 0, left_w, src_h)).resize((left_w, h), Image.LANCZOS),
                 (0, 0))
    # 中部：从源图取 1 列（left 和 center 交界处），缩放到 2×h
    center_x = left_w
    if src_w > center_x:
        strip = source.crop((center_x, 0, center_x + 1, src_h))
        result.paste(strip.resize((2, h), Image.LANCZOS), (left_w, 0))
    # 右边：从源图裁 right_w 列
    if right_w > 0 and src_w > right_w:
        result.paste(source.crop((src_w - right_w, 0, src_w, src_h)).resize((right_w, h), Image.LANCZOS),
                     (left_w + 2, 0))
    return result


def synthesize_v3slice(slices, children, base64_by_node, display_width=None, parent_node_id=None):
    """v3-slice: 上 + 中 + 下 纵向合成，保留完整显示宽度。

    Relay 把 Figma CROP fill 导出为完整源图（不是裁剪后区域），
    所以 get_slice 拿到的是整张源图，需要根据 slice bounds 手动裁剪。
    """
    from PIL import Image

    source = None
    if parent_node_id and parent_node_id in base64_by_node:
        parent_source = get_png_from_base64(base64_by_node[parent_node_id])
        if not display_width or parent_source.size[0] >= display_width:
            source = parent_source
    # 父节点不可用时，从任意 __slice_* 子节点获取完整源图。
    for cid, cn in children.items():
        if source is not None:
            break
        if cid in base64_by_node:
            source = get_png_from_base64(base64_by_node[cid])
            break
    if not source:
        return None

    src_w, src_h = source.size
    top_h = int(slices.get("__slice_top", {}).get("bounds", {}).get("height", 0))
    bottom_h = int(slices.get("__slice_bottom", {}).get("bounds", {}).get("height", 0))
    if top_h == 0:
        return None

    w = display_width or source.size[0]
    new_h = top_h + bottom_h + 2

    result = Image.new("RGBA", (w, new_h), (0, 0, 0, 0))
    # 顶部：从源图裁 top_h 行
    result.paste(source.crop((0, 0, src_w, top_h)).resize((w, top_h), Image.LANCZOS),
                 (0, 0))
    # 中部：从源图取 1 行（top 和 center 交界处），缩放到 w×2
    center_y = top_h
    if src_h > center_y:
        strip = source.crop((0, center_y, min(src_w, w), center_y + 1))
        result.paste(strip.resize((w, 2), Image.LANCZOS), (0, top_h))
    # 底部：从源图裁 bottom_h 行
    if bottom_h > 0 and src_h > bottom_h:
        result.paste(source.crop((0, src_h - bottom_h, src_w, src_h)).resize((w, bottom_h), Image.LANCZOS),
                     (0, top_h + 2))
    return result


SYNTHESIZERS = {"9slice": synthesize_9slice, "h3slice": synthesize_h3slice, "v3slice": synthesize_v3slice}


def resolve_output_file_name(nid, fallback_name, plan_name_map=None, add_jiugong_suffix=False):
    """优先使用下载计划中的目标文件名，保证资源写入路径和 Prefab Spec 一致。"""
    planned_name = (plan_name_map or {}).get(str(nid))
    if planned_name:
        return Path(planned_name).name

    safe_name = sanitize_name(fallback_name.replace("__slice", ""))
    if add_jiugong_suffix and not safe_name.endswith("_jiugong"):
        safe_name = safe_name + "_jiugong"
    return safe_name + ".png"


def process_one_nine_slice(nid, sd, node_map, children_map, base64_by_node, output_dir, plan_name_map=None):
    """处理单个九宫容器（供线程池调用）"""
    slices = sd["slices"]
    children = sd["sliceChildren"]
    synth = SYNTHESIZERS.get(sd["type"])
    if not synth:
        return None

    dw = sd.get("displayWidth")
    dh = sd.get("displayHeight")
    if sd["type"] == "v3slice":
        result = synth(slices, children, base64_by_node, display_width=dw, parent_node_id=nid)
    elif sd["type"] == "h3slice":
        result = synth(slices, children, base64_by_node, display_height=dh, parent_node_id=nid)
    else:
        result = synth(slices, children, base64_by_node)
    if not result:
        return None

    file_name = resolve_output_file_name(
        nid,
        node_map[nid]["name"],
        plan_name_map=plan_name_map,
        add_jiugong_suffix=True,
    )
    file_path = output_dir / file_name
    result.save(str(file_path))

    # ── 尺寸校验 ──
    border = sd.get("border", {})
    min_w = int(border.get("left", 0) or 0) + int(border.get("right", 0) or 0) + 2
    min_h = int(border.get("top", 0) or 0) + int(border.get("bottom", 0) or 0) + 2
    expected_w, expected_h = expected_sliced_size(sd["type"], border, dw, dh)
    size_ok = (result.size[0] == expected_w and result.size[1] == expected_h)

    return {
        "nid": nid, "file": str(file_path), "size": result.size,
        "minSize": (min_w, min_h), "expectedSize": (expected_w, expected_h),
        "sizeOk": size_ok, "sliceType": sd["type"],
        "fileName": file_name,
    }


def process_one_nine_slice_guarded(nid, sd, node_map, children_map, base64_by_node, output_dir, plan_name_map, reuse_asset_paths):
    """Process generated nine-slice images while protecting explicit reused assets."""
    file_name = resolve_output_file_name(
        nid,
        node_map[nid]["name"],
        plan_name_map=plan_name_map,
        add_jiugong_suffix=True,
    )
    file_path = output_dir / file_name
    skip, reason = should_skip_existing_generated_image(file_path, reuse_asset_paths)
    if skip:
        actual_w, actual_h = read_image_size(file_path)
        border = sd.get("border", {})
        min_w = int(border.get("left", 0) or 0) + int(border.get("right", 0) or 0) + 2
        min_h = int(border.get("top", 0) or 0) + int(border.get("bottom", 0) or 0) + 2
        expected_w, expected_h = expected_sliced_size(sd["type"], border, sd.get("displayWidth"), sd.get("displayHeight"))
        return {
            "nid": nid, "file": str(file_path), "size": (actual_w, actual_h),
            "minSize": (min_w, min_h), "expectedSize": (expected_w, expected_h),
            "sizeOk": actual_w > 0 and actual_h > 0, "sliceType": sd["type"],
            "fileName": file_name, "skippedExisting": True, "skipReason": reason,
        }
    return process_one_nine_slice(nid, sd, node_map, children_map, base64_by_node, output_dir, plan_name_map)


def make_check(pass_state, summary=None, details=None):
    """创建统一审核检查项，供 LLM 直接读取判断。"""
    return {
        "pass": bool(pass_state),
        "summary": summary or {},
        "details": details or [],
    }


def validate_download_plan(download_plan_path, resolved_plan_exports=None, base64_by_node=None):
    """校验下载计划中的图片文件是否存在、尺寸和 MD5 是否匹配。"""
    plan_path = Path(download_plan_path)
    if not plan_path.is_file():
        return {
            "planExists": False,
            "items": [],
            "missingFiles": [],
            "sizeMismatch": [],
            "md5Mismatch": [],
            "contentVerificationPending": [],
        }

    plan_data = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    items = plan_data.get("images", [])
    missing_files = []
    size_mismatch = []
    md5_mismatch = []
    content_pending = []
    resolved_by_planned = {
        str(item.get("plannedNodeId") or ""): item
        for item in (resolved_plan_exports or [])
        if item.get("plannedNodeId") and item.get("resolvedExportNodeId")
    }
    base64_by_node = base64_by_node or {}

    for item in items:
        file_path = resolve_unity_asset_path(item.get("targetAssetPath", ""))
        if not file_path.is_file():
            missing_files.append({
                "imageId": item.get("imageId", ""),
                "fileName": item.get("fileName", ""),
                "targetAssetPath": item.get("targetAssetPath", ""),
            })
            continue

        expected_size = item.get("expectedSize") or {}
        expected_w = int(expected_size.get("x", expected_size.get("width", 0)) or 0)
        expected_h = int(expected_size.get("y", expected_size.get("height", 0)) or 0)
        actual_w, actual_h = read_image_size(file_path)
        if item.get("reuseExistingAsset"):
            continue
        if expected_w > 0 and expected_h > 0 and (actual_w != expected_w or actual_h != expected_h):
            size_mismatch.append({
                "imageId": item.get("imageId", ""),
                "fileName": item.get("fileName", ""),
                "expectedSize": f"{expected_w}x{expected_h}",
                "actualSize": f"{actual_w}x{actual_h}",
            })

        expected_md5 = item.get("expectedMD5", "")
        resolved = resolved_by_planned.get(str(item.get("figmaNodeId") or ""))
        if resolved:
            resolved_b64 = base64_by_node.get(str(resolved.get("resolvedExportNodeId") or ""))
            if resolved_b64:
                expected_md5 = md5_of_base64(resolved_b64)
        if expected_md5:
            actual_md5 = calculate_file_md5(file_path)
            if actual_md5 != expected_md5:
                md5_mismatch.append({
                    "imageId": item.get("imageId", ""),
                    "fileName": item.get("fileName", ""),
                    "expectedMD5": expected_md5,
                    "actualMD5": actual_md5,
                })
        elif item.get("needsContentVerification"):
            content_pending.append({
                "imageId": item.get("imageId", ""),
                "fileName": item.get("fileName", ""),
                "reason": "expectedMD5_empty",
            })

    return {
        "planExists": True,
        "items": items,
        "missingFiles": missing_files,
        "sizeMismatch": size_mismatch,
        "md5Mismatch": md5_mismatch,
        "contentVerificationPending": content_pending,
    }


def load_required_node_ids_from_plan(download_plan_path):
    """从下载计划读取明确需要写出的 Figma 节点 ID。"""
    plan_path = Path(download_plan_path)
    if not plan_path.is_file():
        return set()
    try:
        plan_data = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    except Exception:
        return set()
    return {
        str(item.get("figmaNodeId") or "")
        for item in plan_data.get("images", [])
        if item.get("figmaNodeId")
    }


def build_download_plan_name_map(download_plan_path):
    """读取下载计划中的 Figma 节点到目标 PNG 文件名映射。"""
    plan_path = Path(download_plan_path)
    if not plan_path.is_file():
        return {}
    try:
        plan_data = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}

    name_map = {}
    for item in plan_data.get("images", []):
        node_id = str(item.get("figmaNodeId") or "")
        if not node_id:
            continue
        file_name = item.get("fileName") or Path(str(item.get("targetAssetPath") or "")).name
        if file_name:
            name_map[node_id] = Path(str(file_name)).name
    return name_map


def read_expected_size(item):
    expected_size = item.get("expectedSize") or {}
    expected_w = int(expected_size.get("x", expected_size.get("width", 0)) or 0)
    expected_h = int(expected_size.get("y", expected_size.get("height", 0)) or 0)
    return expected_w, expected_h


def build_download_plan_size_map(plan_data):
    """Map planned figma node ids to expected PNG sizes."""
    size_map = {}
    for item in plan_data.get("images", []):
        node_id = str(item.get("figmaNodeId") or "")
        if not node_id or item.get("reuseExistingAsset"):
            continue
        expected_w, expected_h = read_expected_size(item)
        if expected_w > 0 and expected_h > 0:
            size_map[node_id] = (expected_w, expected_h)
    return size_map


def load_manifest_data(manifest_dir):
    """读取 Relay manifest；缺失或解析失败时返回前置门禁错误。"""
    manifest_path = Path(manifest_dir)
    node_path = manifest_path / "figma_node_manifest.json"
    export_path = manifest_path / "image_export_manifest.json"
    errors = []

    if not node_path.is_file():
        errors.append({
            "code": "figmaNodeManifestMissing",
            "message": "未找到 figma_node_manifest.json，停止图片写入。",
            "path": str(node_path),
        })
    if not export_path.is_file():
        errors.append({
            "code": "imageExportManifestMissing",
            "message": "未找到 image_export_manifest.json，停止图片写入。",
            "path": str(export_path),
        })
    if errors:
        return {}, {}, errors

    try:
        node_data = json.loads(node_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        errors.append({
            "code": "figmaNodeManifestParseFailed",
            "message": "figma_node_manifest.json 解析失败，停止图片写入。",
            "path": str(node_path),
            "error": str(exc),
        })
        node_data = {}

    try:
        export_data = json.loads(export_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        errors.append({
            "code": "imageExportManifestParseFailed",
            "message": "image_export_manifest.json 解析失败，停止图片写入。",
            "path": str(export_path),
            "error": str(exc),
        })
        export_data = {}

    if errors:
        return {}, {}, errors

    if not isinstance(node_data, dict) or not isinstance(node_data.get("nodes", []), list):
        errors.append({
            "code": "figmaNodeManifestInvalid",
            "message": "figma_node_manifest.json 缺少合法 nodes 数组，停止图片写入。",
            "path": str(node_path),
        })
    if not isinstance(export_data, dict) or not isinstance(export_data.get("exports", []), list):
        errors.append({
            "code": "imageExportManifestInvalid",
            "message": "image_export_manifest.json 缺少合法 exports 数组，停止图片写入。",
            "path": str(export_path),
        })

    return node_data, export_data, errors


def build_manifest_identity(manifest_dir, node_data, export_data):
    manifest_path = Path(manifest_dir).resolve()
    node_path = manifest_path / "figma_node_manifest.json"
    export_path = manifest_path / "image_export_manifest.json"
    node_ids = {
        str(node.get("id") or "")
        for node in node_data.get("nodes", [])
        if node.get("id")
    }
    export_ids = {
        str(item.get("nodeId") or "")
        for item in export_data.get("exports", [])
        if item.get("nodeId")
    }
    return {
        "manifestDir": str(manifest_path),
        "figmaNodeManifestPath": str(node_path),
        "imageExportManifestPath": str(export_path),
        "figmaNodeManifestSha256": file_sha256(node_path),
        "imageExportManifestSha256": file_sha256(export_path),
        "nodeCount": len(node_ids),
        "exportCount": len(export_ids),
        "nodeIdPrefixes": id_prefixes(node_ids),
        "exportNodeIdPrefixes": id_prefixes(export_ids),
        "rootId": (node_data.get("root") or {}).get("id", "") or node_data.get("rootId", ""),
        "nodeIds": node_ids,
        "exportIds": export_ids,
    }


def validate_manifest_plan_contract(manifest_dir, plan_data, node_data, export_data):
    """阻断 plan 和 manifest 不同源，避免读错同名目录后静默写 0 张图。"""
    actual = build_manifest_identity(manifest_dir, node_data, export_data)
    plan_ids = {
        str(item.get("figmaNodeId") or "")
        for item in plan_data.get("images", [])
        if item.get("figmaNodeId")
    }
    errors = []
    provenance = plan_data.get("manifestProvenance") or {}
    if provenance:
        mismatches = []
        for key in ("figmaNodeManifestSha256", "imageExportManifestSha256"):
            expected = str(provenance.get(key) or "")
            actual_value = str(actual.get(key) or "")
            if expected and actual_value and expected != actual_value:
                mismatches.append({
                    "field": key,
                    "expected": expected,
                    "actual": actual_value,
                })
        if mismatches:
            errors.append({
                "code": "manifestProvenanceMismatch",
                "message": "image_download_plan.json 与当前 Relay manifest 不是同一批产物，停止图片写入。",
                "details": {
                    "downloadPlanManifest": provenance,
                    "actualManifest": {
                        key: actual[key]
                        for key in (
                            "manifestDir",
                            "figmaNodeManifestPath",
                            "imageExportManifestPath",
                            "figmaNodeManifestSha256",
                            "imageExportManifestSha256",
                            "nodeCount",
                            "exportCount",
                            "nodeIdPrefixes",
                            "exportNodeIdPrefixes",
                            "rootId",
                        )
                    },
                    "mismatches": mismatches,
                },
            })
            return errors

    node_ids = actual["nodeIds"]
    export_ids = actual["exportIds"]
    plan_node_overlap = plan_ids & node_ids
    plan_export_overlap = plan_ids & export_ids
    if plan_ids and not plan_node_overlap and not plan_export_overlap:
        errors.append({
            "code": "manifestNodeIdNamespaceMismatch",
            "message": "下载计划中的 figmaNodeId 在当前 node/export manifest 中均不存在，疑似读错 manifest-dir，停止图片写入。",
            "details": {
                "manifestDir": actual["manifestDir"],
                "planImageCount": len(plan_data.get("images", [])),
                "planNodeIdCount": len(plan_ids),
                "manifestNodeCount": actual["nodeCount"],
                "manifestExportCount": actual["exportCount"],
                "planNodeIdPrefixes": id_prefixes(plan_ids),
                "manifestNodeIdPrefixes": actual["nodeIdPrefixes"],
                "manifestExportNodeIdPrefixes": actual["exportNodeIdPrefixes"],
                "samplePlanNodeIds": sample_ids(plan_ids),
                "sampleManifestNodeIds": sample_ids(node_ids),
                "sampleExportNodeIds": sample_ids(export_ids),
            },
        })
    return errors


def crop_png_to_expected_size(file_path, expected_size):
    """Crop oversized generated PNGs to the explicit download-plan size."""
    if not expected_size:
        return False
    expected_w, expected_h = expected_size
    actual_w, actual_h = read_image_size(file_path)
    if actual_w == expected_w and actual_h == expected_h:
        return False
    if actual_w < expected_w or actual_h < expected_h:
        return False
    from PIL import Image
    with Image.open(file_path) as image:
        cropped = image.crop((0, 0, expected_w, expected_h))
        cropped.save(file_path)
    return True


def build_exports_by_node(exports_list):
    """按 Figma nodeId 聚合 Relay 图片导出记录。"""
    exports_by_node = defaultdict(list)
    for item in exports_list:
        node_id = str(item.get("nodeId") or "")
        if node_id:
            exports_by_node[node_id].append(item)
    return exports_by_node


def build_exports_by_id(exports_list):
    exports_by_id = {}
    for item in exports_list:
        export_id = str(item.get("id") or "")
        if export_id:
            exports_by_id[export_id] = item
    return exports_by_id


def export_has_base64(export_item):
    return isinstance(export_item.get("base64"), str) and bool(export_item.get("base64"))


def resolve_export_with_base64(export_item, exports_by_id):
    if export_has_base64(export_item):
        return export_item
    duplicate_of = str(export_item.get("duplicateOf") or "")
    if not duplicate_of:
        return None
    duplicate_source = exports_by_id.get(duplicate_of)
    if duplicate_source and export_has_base64(duplicate_source):
        return duplicate_source
    return None


def validate_export_health_contract(exports_list):
    """阻止空图片、无效 PNG 和悬空 duplicateOf 进入 Unity 写入阶段。"""
    exports_by_id = build_exports_by_id(exports_list)
    errors = []
    for item in exports_list:
        health = item.get("health") if isinstance(item.get("health"), dict) else {}
        if health.get("status") == "blocked":
            errors.append({
                "code": "imageExportBlocked",
                "message": "Figma 图片导出已标记为阻断。",
                "details": {"exportId": item.get("id", ""), "nodeId": item.get("nodeId", ""), "nodePath": item.get("nodePath", ""), "reason": health.get("reason", "")},
            })
            continue
        duplicate_of = str(item.get("duplicateOf") or "")
        candidate = exports_by_id.get(duplicate_of) if duplicate_of else item
        if duplicate_of and candidate is None:
            errors.append({
                "code": "danglingDuplicate",
                "message": "重复图片引用的源导出不存在。",
                "details": {"exportId": item.get("id", ""), "nodeId": item.get("nodeId", ""), "nodePath": item.get("nodePath", ""), "sourceExportId": duplicate_of},
            })
            continue
        try:
            raw = base64.b64decode(str(candidate.get("base64") or ""), validate=True)
        except (ValueError, TypeError):
            raw = b""
        width = int(candidate.get("width", 0) or 0)
        height = int(candidate.get("height", 0) or 0)
        if width < 1 or height < 1 or len(raw) <= 8 or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            errors.append({
                "code": "invalidImagePayload",
                "message": "图片 payload、PNG 签名或尺寸无效。",
                "details": {"exportId": item.get("id", ""), "nodeId": item.get("nodeId", ""), "nodePath": item.get("nodePath", ""), "width": width, "height": height, "byteLength": len(raw)},
            })
    return errors


def resolve_node_export_with_base64(node_id, exports_by_node, exports_by_id):
    for item in exports_by_node.get(node_id, []):
        resolved = resolve_export_with_base64(item, exports_by_id)
        if resolved:
            return str(resolved.get("nodeId") or ""), resolved
    return "", None


def build_base64_by_node(exports_list, exports_by_node, exports_by_id):
    """Collect only usable inline base64 strings, resolving duplicate exports when needed."""
    base64_by_node = {}
    for item in exports_list:
        node_id = str(item.get("nodeId") or "")
        if not node_id:
            continue
        resolved = resolve_export_with_base64(item, exports_by_id)
        if not resolved:
            continue
        b64 = resolved.get("base64")
        if isinstance(b64, str) and b64:
            base64_by_node[node_id] = b64

    for node_id in list(exports_by_node.keys()):
        if node_id in base64_by_node:
            continue
        _resolved_id, resolved = resolve_node_export_with_base64(node_id, exports_by_node, exports_by_id)
        if not resolved:
            continue
        b64 = resolved.get("base64")
        if isinstance(b64, str) and b64:
            base64_by_node[node_id] = b64
    return base64_by_node


def collect_descendant_ids(node_id, children_map):
    """递归收集节点的所有子孙节点。"""
    result = []
    for child_id in children_map.get(node_id, []):
        result.append(child_id)
        result.extend(collect_descendant_ids(child_id, children_map))
    return result


def export_area(exports_by_node, node_id):
    """读取某节点最大导出面积，用于 INSTANCE 子节点解析排序。"""
    area = 0
    for item in exports_by_node.get(node_id, []):
        width = int(item.get("width", 0) or 0)
        height = int(item.get("height", 0) or 0)
        area = max(area, width * height)
    return area


def export_size_for_node(exports_by_node, exports_by_id, node_id):
    width = 0
    height = 0
    for item in exports_by_node.get(node_id, []):
        candidate = resolve_export_with_base64(item, exports_by_id) or item
        width = max(width, int(candidate.get("width", 0) or 0))
        height = max(height, int(candidate.get("height", 0) or 0))
    return width, height


def export_covers_expected(exports_by_node, exports_by_id, node_id, expected_size):
    expected_w, expected_h = expected_size
    if expected_w <= 0 or expected_h <= 0:
        return True
    width, height = export_size_for_node(exports_by_node, exports_by_id, node_id)
    return width >= expected_w and height >= expected_h


def find_descendant_export_covering_expected(planned_id, expected_size, children_map, exports_by_node, exports_by_id, base64_by_node):
    expected_w, expected_h = expected_size
    if expected_w <= 0 or expected_h <= 0:
        return "", ""
    candidates = []
    candidate_sources = {}
    for cid in collect_descendant_ids(planned_id, children_map):
        source_id = ""
        if cid in base64_by_node:
            source_id = cid
        else:
            resolved_id, _resolved_export = resolve_node_export_with_base64(cid, exports_by_node, exports_by_id)
            if resolved_id and resolved_id in base64_by_node:
                source_id = resolved_id
        if not source_id:
            continue
        width, height = export_size_for_node(exports_by_node, exports_by_id, source_id)
        if width >= expected_w and height >= expected_h:
            candidates.append((width * height, width, height, cid, source_id))
            candidate_sources[cid] = source_id
    if not candidates:
        return "", ""
    _area, _width, _height, intermediate_id, source_id = max(candidates)
    return intermediate_id, candidate_sources.get(intermediate_id, source_id)


def resolve_download_plan_node_exports(plan_data, node_map, children_map, exports_by_node, exports_by_id, base64_by_node):
    """把下载计划中的父节点需求解析到实际有导出数据的节点。"""
    required_node_ids = set()
    plan_name_map = {}
    resolutions = []
    for item in plan_data.get("images", []):
        planned_id = str(item.get("figmaNodeId") or "")
        if not planned_id:
            continue
        file_name = item.get("fileName") or Path(str(item.get("targetAssetPath") or "")).name
        if not file_name:
            continue

        required_node_ids.add(planned_id)
        plan_name_map[planned_id] = Path(str(file_name)).name
        expected_size = read_expected_size(item)
        planned_node = node_map.get(planned_id) or {}
        if planned_id in base64_by_node and export_covers_expected(exports_by_node, exports_by_id, planned_id, expected_size):
            continue
        if planned_id in base64_by_node:
            intermediate_id, source_id = find_descendant_export_covering_expected(
                planned_id, expected_size, children_map, exports_by_node, exports_by_id, base64_by_node
            )
            if source_id:
                required_node_ids.add(source_id)
                plan_name_map[source_id] = Path(str(file_name)).name
                resolutions.append({
                    "plannedNodeId": planned_id,
                    "plannedNodeName": planned_node.get("name", ""),
                    "resolvedExportNodeId": source_id,
                    "resolvedExportNodeName": (node_map.get(source_id) or {}).get("name", ""),
                    "intermediateNodeId": intermediate_id if source_id != intermediate_id else "",
                    "resolvedReason": "descendant-export-covers-expected-size",
                    "fileName": Path(str(file_name)).name,
                    "expectedSize": {"width": expected_size[0], "height": expected_size[1]},
                    "directExportSize": {
                        "width": export_size_for_node(exports_by_node, exports_by_id, planned_id)[0],
                        "height": export_size_for_node(exports_by_node, exports_by_id, planned_id)[1],
                    },
                })
                continue

        resolved_id, resolved_export = resolve_node_export_with_base64(planned_id, exports_by_node, exports_by_id)
        if resolved_id and resolved_id in base64_by_node:
            required_node_ids.add(resolved_id)
            plan_name_map[resolved_id] = Path(str(file_name)).name
            reason = "duplicate-export" if resolved_id != planned_id else "direct-export"
            resolutions.append({
                "plannedNodeId": planned_id,
                "plannedNodeName": planned_node.get("name", ""),
                "resolvedExportNodeId": resolved_id,
                "resolvedExportNodeName": (node_map.get(resolved_id) or {}).get("name", ""),
                "resolvedReason": reason,
                "sourceExportId": resolved_export.get("id", "") if resolved_export else "",
                "fileName": Path(str(file_name)).name,
            })
            continue

        descendants = collect_descendant_ids(planned_id, children_map)
        candidates = []
        candidate_sources = {}
        for cid in descendants:
            if cid in base64_by_node:
                candidates.append(cid)
                candidate_sources[cid] = cid
                continue
            resolved_id, _resolved_export = resolve_node_export_with_base64(cid, exports_by_node, exports_by_id)
            if resolved_id and resolved_id in base64_by_node:
                candidates.append(cid)
                candidate_sources[cid] = resolved_id
        if not candidates:
            continue

        resolved_id = max(candidates, key=lambda cid: export_area(exports_by_node, cid))
        source_id = candidate_sources.get(resolved_id, resolved_id)
        required_node_ids.add(source_id)
        plan_name_map[source_id] = Path(str(file_name)).name
        reason_prefix = "instance-child-export" if planned_node.get("type") == "INSTANCE" else "child-export"
        reason = reason_prefix if source_id == resolved_id else f"{reason_prefix}-duplicate"
        resolutions.append({
            "plannedNodeId": planned_id,
            "plannedNodeName": planned_node.get("name", ""),
            "resolvedExportNodeId": source_id,
            "resolvedExportNodeName": (node_map.get(source_id) or {}).get("name", ""),
            "intermediateNodeId": resolved_id if source_id != resolved_id else "",
            "resolvedReason": reason,
            "fileName": Path(str(file_name)).name,
        })
    return required_node_ids, plan_name_map, resolutions


def expected_sliced_size(slice_type, border, display_width, display_height):
    """计算不同九宫类型的 PNG 期望输出尺寸。"""
    min_w = int(border.get("left", 0) or 0) + int(border.get("right", 0) or 0) + 2
    min_h = int(border.get("top", 0) or 0) + int(border.get("bottom", 0) or 0) + 2
    if slice_type == "h3slice":
        return min_w, int(display_height or min_h)
    if slice_type == "v3slice":
        return int(display_width or min_w), min_h
    return min_w, min_h


def should_keep_slice_frame_as_simple_image(node, slice_type, exports_by_node, exports_by_id):
    """Keep already-composited h3/v3 frames as Simple images."""
    if slice_type != "h3slice":
        return False
    resolved_id, export_item = resolve_node_export_with_base64(str(node.get("id") or ""), exports_by_node, exports_by_id)
    if not export_item:
        return False
    width = int(float(export_item.get("width") or 0))
    height = int(float(export_item.get("height") or 0))
    bounds = node.get("bounds", {})
    display_width = int(round(float(bounds.get("width", 0) or 0)))
    display_height = int(round(float(bounds.get("height", 0) or 0)))
    return width >= max(1, display_width // 2) and height >= max(1, display_height)


def get_export_size(exports_by_node, node_id, exports_by_id=None):
    """Read exported PNG dimensions, resolving duplicate export records."""
    exports_by_id = exports_by_id or {}
    for item in exports_by_node.get(node_id, []):
        candidate = resolve_export_with_base64(item, exports_by_id) or item
        width = int(candidate.get("width", 0) or 0)
        height = int(candidate.get("height", 0) or 0)
        if width > 0 and height > 0:
            return width, height
    return 0, 0


def build_image_process_report(nine_results, skipped_nine, written, normal_errors, skipped_existing, copy_results, output_dir, validation_report_path, plan_validation, resolved_plan_exports=None, reuse_missing_regenerated=None):
    """生成图片处理结构化报告，避免 LLM 手工统计终端输出。"""
    oversize_items = [r for r in nine_results if not r["sizeOk"]]
    size_mismatch = list(plan_validation.get("sizeMismatch", []))
    md5_mismatch = list(plan_validation.get("md5Mismatch", []))
    blocking_errors = []
    if oversize_items:
        blocking_errors.append({
            "code": "nineSliceSizeMismatch",
            "message": "九宫 PNG 实际尺寸不符合 sliceKind 期望尺寸。",
            "details": [{
                "fileName": r["fileName"],
                "sliceType": r["sliceType"],
                "actualSize": f"{r['size'][0]}x{r['size'][1]}",
                "minSize": f"{r['minSize'][0]}x{r['minSize'][1]}",
                "expectedSize": f"{r['expectedSize'][0]}x{r['expectedSize'][1]}",
            } for r in oversize_items],
        })
    if normal_errors:
        blocking_errors.append({
            "code": "normalImageWriteFailed",
            "message": "部分普通图片写入失败。",
            "details": normal_errors,
        })
    if plan_validation.get("missingFiles"):
        blocking_errors.append({
            "code": "downloadPlanFileMissing",
            "message": "下载计划中的部分目标图片不存在。",
            "details": plan_validation["missingFiles"],
        })
    if size_mismatch:
        blocking_errors.append({
            "code": "downloadPlanSizeMismatch",
            "message": "下载计划中的部分图片尺寸与实际文件不一致。",
            "details": size_mismatch,
        })
    if md5_mismatch:
        blocking_errors.append({
            "code": "downloadPlanMd5Mismatch",
            "message": "下载计划中的部分图片 MD5 与实际文件不一致。",
            "details": md5_mismatch,
        })
    if not plan_validation.get("planExists"):
        blocking_errors.append({
            "code": "downloadPlanMissing",
            "message": "未找到 image_download_plan.json，无法完成图片完整性校验。",
            "details": {},
        })

    warnings = []
    if plan_validation.get("contentVerificationPending"):
        warnings.append({
            "code": "contentVerificationPending",
            "message": "部分图片缺少 expectedMD5，只完成文件和尺寸校验。",
            "details": plan_validation["contentVerificationPending"],
        })
    if skipped_nine:
        warnings.append({
            "code": "nineSliceSkipped",
            "message": "部分九宫容器缺少可合成数据，已跳过，需要检查 Relay 图片导出。",
            "details": skipped_nine,
        })
    if resolved_plan_exports:
        warnings.append({
            "code": "downloadPlanNodeResolved",
            "message": "部分下载计划节点没有直接导出图，已解析到实际导出的子节点。",
            "details": resolved_plan_exports,
        })

    reuse_missing_regenerated = reuse_missing_regenerated or []
    copied_common = [item for item in copy_results if item.get("copied")]
    skipped_nine_existing = [item for item in nine_results if item.get("skippedExisting")]
    missing_common = [item for item in copy_results if item.get("missingSource")]
    if missing_common:
        warnings.append({
            "code": "commonTextureSourceMissing",
            "message": "部分 Common_Texture 源文件不存在，若 Spec 引用这些图片会导致后续阻塞。",
            "details": missing_common,
        })

    return {
        "allPass": len(blocking_errors) == 0,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "summary": {
            "nineSliceTotal": len(nine_results),
            "nineSliceOk": sum(1 for r in nine_results if r["sizeOk"]),
            "nineSliceOversize": len(oversize_items),
            "nineSliceSkipped": len(skipped_nine),
            "normalImageWritten": written,
            "existingImageReused": len(skipped_existing) + len(skipped_nine_existing),
            "reuseMissingRegenerated": len(reuse_missing_regenerated),
            "reuseOutsideOutputDir": sum(
                1 for r in nine_results if r.get("reuseOutsideOutputDir")
            ) + sum(
                1 for s in skipped_existing if s.get("reason") == "reuseOutsideOutputDir"
            ),
            "normalImageErrors": len(normal_errors),
            "commonTextureCopied": len(copied_common),
            "downloadPlanImageCount": len(plan_validation.get("items", [])),
            "resolvedPlanExportCount": len(resolved_plan_exports or []),
            "outputDir": str(output_dir),
        },
        "checks": {
            "nineSliceSize": make_check(
                len(oversize_items) == 0,
                {"ok": sum(1 for r in nine_results if r["sizeOk"]), "total": len(nine_results)},
                [{
                    "fileName": r["fileName"],
                    "actualSize": f"{r['size'][0]}x{r['size'][1]}",
                    "minSize": f"{r['minSize'][0]}x{r['minSize'][1]}",
                    "expectedSize": f"{r['expectedSize'][0]}x{r['expectedSize'][1]}",
                } for r in oversize_items],
            ),
            "nineSliceData": make_check(
                len(skipped_nine) == 0,
                {"skipped": len(skipped_nine)},
                skipped_nine,
            ),
            "downloadPlanFiles": make_check(
                len(plan_validation.get("missingFiles", [])) == 0,
                {"checked": len(plan_validation.get("items", []))},
                plan_validation.get("missingFiles", []),
            ),
            "reuseMissingRegenerated": make_check(
                True,
                {"count": len(reuse_missing_regenerated)},
                reuse_missing_regenerated,
            ),
            "downloadPlanSize": make_check(
                len(size_mismatch) == 0,
                {"mismatch": len(size_mismatch)},
                size_mismatch,
            ),
            "downloadPlanMd5": make_check(
                len(md5_mismatch) == 0,
                {"mismatch": len(md5_mismatch)},
                md5_mismatch,
            ),
            "existingImageReuse": make_check(
                True,
                {"normal": len(skipped_existing), "nineSlice": len(skipped_nine_existing)},
                skipped_existing + skipped_nine_existing,
            ),
        },
        "artifacts": {
            "outputDir": str(output_dir),
            "nineSliceValidationPath": str(validation_report_path),
        },
        "resolvedPlanExports": resolved_plan_exports or [],
    }


def write_guard_failure_report(output_report, output_dir, blocking_errors):
    """写出前置门禁失败报告，确保调用方能看到阻断原因。"""
    report_path = Path(output_report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "allPass": False,
        "blockingErrors": blocking_errors,
        "warnings": [],
        "summary": {
            "outputDir": str(output_dir),
        },
        "checks": {
            "preflight": make_check(False, {"outputDir": str(output_dir)}, blocking_errors),
        },
        "artifacts": {
            "outputDir": str(output_dir),
        },
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Report → {report_path} | allPass=False")


def main():
    global UNITY_PROJECT_ROOT
    parser = argparse.ArgumentParser(description="并行九宫合成 + 图片导出")
    parser.add_argument("--unity-project", default="", help="Unity project root containing Assets and ProjectSettings")
    parser.add_argument("--manifest-dir", default=".tmp/figma-to-prefab",
                        help="Relay manifest 目录")
    parser.add_argument("--output-dir", default="Assets/_Art/Texture/GUI/Sharders",
                        help="PNG 输出目录")
    parser.add_argument("--common-dir", default="Assets/_Art/Texture/GUI/_Common/Element",
                        help="公共贴图目录")
    parser.add_argument("--workers", type=int, default=6, help="并行线程数")
    parser.add_argument("--output-report", default="",
                        help="结构化图片处理报告输出路径")
    parser.add_argument("--download-plan", default="",
                        help="图片下载/校验计划路径")
    args = parser.parse_args()
    try:
        UNITY_PROJECT_ROOT = resolve_unity_project(args.unity_project)
    except RuntimeError as error:
        parser.error(str(error))
    os.environ["FIGMA_UNITY_PROJECT"] = str(UNITY_PROJECT_ROOT)
    args.output_report = args.output_report or str(UNITY_PROJECT_ROOT / ".tmp" / "image_process_report.json")
    args.download_plan = args.download_plan or str(UNITY_PROJECT_ROOT / ".tmp" / "image_download_plan.json")

    manifest_dir = resolve_manifest_dir(args.manifest_dir)
    output_dir = resolve_output_dir(args.output_dir)
    plan_data = load_download_plan(args.download_plan)
    reuse_asset_paths, reuse_missing_regenerated = collect_reuse_asset_paths(plan_data)
    output_dir_errors = validate_output_dir_matches_plan(output_dir, plan_data)
    if output_dir_errors:
        write_guard_failure_report(args.output_report, output_dir, output_dir_errors)
        return 2

    # 加载 Relay 数据
    node_data, export_data, manifest_errors = load_manifest_data(manifest_dir)
    if manifest_errors:
        write_guard_failure_report(args.output_report, output_dir, manifest_errors)
        return 2

    manifest_contract_errors = validate_manifest_plan_contract(manifest_dir, plan_data, node_data, export_data)
    if manifest_contract_errors:
        write_guard_failure_report(args.output_report, output_dir, manifest_contract_errors)
        return 2

    image_health_errors = validate_export_health_contract(export_data.get("exports", []))
    if image_health_errors:
        write_guard_failure_report(args.output_report, output_dir, image_health_errors)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)

    nodes_list = node_data["nodes"]
    exports_list = export_data["exports"]

    # 构建索引
    node_map = {n["id"]: n for n in nodes_list}
    children_map = defaultdict(list)
    for n in nodes_list:
        for cid in n.get("childIds", []):
            children_map[n["id"]].append(cid)

    exports_by_node = build_exports_by_node(exports_list)
    exports_by_id = build_exports_by_id(exports_list)
    base64_by_node = build_base64_by_node(exports_list, exports_by_node, exports_by_id)
    plan_size_map = build_download_plan_size_map(plan_data)
    required_node_ids, plan_name_map, resolved_plan_exports = resolve_download_plan_node_exports(
        plan_data, node_map, children_map, exports_by_node, exports_by_id, base64_by_node
    )

    # 收集 reuseExistingAsset=true 且 targetAssetPath 不在 output_dir 下的节点 ID
    # 用于九宫和普通图片导出时跳过，避免把 Common_Texture 等已有资源重复写入输出目录
    reuse_outside_output_map = {}
    reuse_outside_by_planned_id = {}
    for item in plan_data.get("images", []):
        if not item.get("reuseExistingAsset"):
            continue
        planned_id = str(item.get("figmaNodeId") or "")
        if not planned_id:
            continue
        target_path = item.get("targetAssetPath", "")
        if not target_path:
            continue
        target_dir = resolve_unity_asset_path(target_path).parent.resolve()
        if target_dir != output_dir.resolve():
            reuse_info = {
                "fileName": Path(target_path).name,
                "targetAssetPath": target_path,
            }
            reuse_outside_output_map[planned_id] = reuse_info
            reuse_outside_by_planned_id[planned_id] = reuse_info

    # 识别九宫容器
    for resolved in resolved_plan_exports:
        planned_id = str(resolved.get("plannedNodeId") or "")
        resolved_id = str(resolved.get("resolvedExportNodeId") or "")
        if not planned_id or not resolved_id:
            continue
        reuse_info = reuse_outside_by_planned_id.get(planned_id)
        if reuse_info:
            reuse_outside_output_map[resolved_id] = reuse_info

    skip_ids = set()
    sixed_tasks = []
    direct_nine_results = []
    direct_nine_parent_ids = set()

    def collect_skip(nid, s):
        if nid in s:
            return
        s.add(nid)
        for cid in children_map.get(nid, []):
            collect_skip(cid, s)

    for n in nodes_list:
        if n["type"] != "FRAME":
            continue
        children = children_map.get(n["id"], [])
        cn = [node_map[c]["name"] for c in children if c in node_map]
        slice_names = [x for x in cn if x.startswith("__slice_")]
        if not slice_names:
            continue

        slices = {}
        slice_children = {}
        for c in children:
            if c not in node_map:
                continue
            c_name = node_map[c]["name"]
            if c_name.startswith("__slice_"):
                slices[c_name] = node_map[c]
                slice_children[c] = c_name
                collect_skip(c, skip_ids)

        w, h = n["bounds"]["width"], n["bounds"]["height"]
        st, bd = detect_type_and_border(slices, w, h)
        if st is None:
            continue
        if should_keep_slice_frame_as_simple_image(n, st, exports_by_node, exports_by_id):
            continue

        expected_w, expected_h = expected_sliced_size(st, bd, int(w), int(h))
        actual_w, actual_h = get_export_size(exports_by_node, n["id"], exports_by_id)
        if n["id"] in base64_by_node and actual_w == expected_w and actual_h == expected_h:
            nn = n["name"]
            sixed_fname = resolve_output_file_name(
                n["id"],
                nn,
                plan_name_map=plan_name_map,
                add_jiugong_suffix=True,
            )
            sixed_fpath = output_dir / sixed_fname
            skip_existing, skip_reason = should_skip_existing_generated_image(sixed_fpath, reuse_asset_paths)
            # 检查该节点是否应跳过（targetAssetPath 在 output_dir 之外）
            reuse_outside = n["id"] in reuse_outside_output_map
            if not skip_existing and not reuse_outside:
                write_base64_png(base64_by_node[n["id"]], sixed_fpath)
            if reuse_outside:
                skip_existing = True
                skip_reason = "reuseOutsideOutputDir"
            direct_nine_parent_ids.add(n["id"])
            direct_nine_results.append({
                "nid": n["id"], "file": str(sixed_fpath), "size": (actual_w, actual_h),
                "minSize": (expected_w, expected_h), "sizeOk": True, "sliceType": st,
                "fileName": sixed_fname,
                "skippedExisting": skip_existing,
                "skipReason": skip_reason,
                "reuseOutsideOutputDir": n["id"] in reuse_outside_output_map,
            })
            # 标记切片子节点为 skip，避免它们被当作普通图片重复导出
            for c in children:
                if c in node_map and node_map[c]["name"].startswith("__slice_"):
                    collect_skip(c, skip_ids)
            continue  # 跳过 synthesize 流程

        sixed_tasks.append({
            "nid": n["id"],
            "sd": {"type": st, "slices": slices, "sliceChildren": slice_children, "border": bd,
                    "displayWidth": int(w), "displayHeight": int(h)},
        })

    # ── 从 exports 识别 Instance 中的九宫 ──
    # Relay 导出时会标记 sliceKind，但 Instance 内部结构不在 nodes_list 中
    for e in exports_list:
        slice_kind = e.get("sliceKind")
        if slice_kind not in ("9slice", "h3slice", "v3slice"):
            continue
        nid = e["nodeId"]
        if nid in direct_nine_parent_ids:  # 已从 nodes_list 识别，跳过
            continue

        border = e.get("border", {})
        source_size = e.get("sourceVisibleSize", {})
        w = source_size.get("width", e.get("width", 0))
        h = source_size.get("height", e.get("height", 0))

        # Relay 已经导出了合成后的九宫图，直接写入
        if nid in base64_by_node:
            nn = node_map.get(nid, {}).get("name", "unknown")
            sixed_fname = resolve_output_file_name(
                nid, nn, plan_name_map=plan_name_map, add_jiugong_suffix=True,
            )
            sixed_fpath = output_dir / sixed_fname
            skip_existing, skip_reason = should_skip_existing_generated_image(sixed_fpath, reuse_asset_paths)
            if not skip_existing:
                write_base64_png(base64_by_node[nid], sixed_fpath)
            direct_nine_parent_ids.add(nid)
            direct_nine_results.append({
                "nid": nid, "file": str(sixed_fpath),
                "size": (e.get("width", 0), e.get("height", 0)),
                "minSize": (w, h), "sizeOk": True, "sliceType": slice_kind,
                "fileName": sixed_fname, "skippedExisting": skip_existing,
                "skipReason": skip_reason,
            })

    # 并行合成九宫（仅处理需要从子节点合成的九宫）
    print(f"九宫容器: {len(sixed_tasks)} (待合成) + {len(direct_nine_results)} (已导出), 线程: {args.workers}")
    nine_results = list(direct_nine_results)
    skipped_nine = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                process_one_nine_slice_guarded,
                t["nid"], t["sd"], node_map, children_map, base64_by_node, output_dir,
                plan_name_map,
                reuse_asset_paths,
            ): t["nid"]
            for t in sixed_tasks
        }
        for f in as_completed(futures):
            r = f.result()
            if r:
                status = "OK" if r["sizeOk"] else "OVERSIZE"
                print(f"  [{status}] {node_map[r['nid']]['name']} → {r['size'][0]}x{r['size'][1]} (min={r['minSize'][0]}x{r['minSize'][1]})")
                nine_results.append(r)
            else:
                print(f"  [SKIP] {node_map[futures[f]]['name']} (无数据)")
                skipped_nine.append({
                    "nodeId": futures[f],
                    "nodeName": node_map[futures[f]]["name"],
                    "reason": "missing_slice_base64",
                })

    # ── 输出尺寸校验报告 ──
    validation_report_path = Path(args.output_report).parent / "nine_slice_validation.json"
    validation_report_path.parent.mkdir(parents=True, exist_ok=True)
    validation_data = {
        "total": len(nine_results),
        "ok": sum(1 for r in nine_results if r["sizeOk"]),
        "oversize": sum(1 for r in nine_results if not r["sizeOk"]),
        "items": [{
            "fileName": r["fileName"],
            "sliceType": r["sliceType"],
            "actualSize": f"{r['size'][0]}x{r['size'][1]}",
            "minSize": f"{r['minSize'][0]}x{r['minSize'][1]}",
            "sizeOk": r["sizeOk"],
        } for r in nine_results],
    }
    validation_report_path.write_text(json.dumps(validation_data, ensure_ascii=False, indent=2), encoding="utf-8")
    if validation_data["oversize"] > 0:
        print(f"\n⚠ 尺寸校验: {validation_data['ok']}/{validation_data['total']} OK, {validation_data['oversize']} 偏大 (→ {validation_report_path})")

    # 导出普通图片（跳过九宫 slice 子节点和 INSTANCE 子节点）
    print("\n导出普通图片...")
    slice_parent_ids = set(t["nid"] for t in sixed_tasks) | direct_nine_parent_ids
    instance_child_ids = set()
    for n in nodes_list:
        if n["type"] == "INSTANCE":
            for cid in children_map.get(n["id"], []):
                collect_skip(cid, instance_child_ids)

    written = 0
    normal_errors = []
    skipped_existing = []
    for nid, b64 in base64_by_node.items():
        if required_node_ids and nid not in required_node_ids:
            continue
        if nid not in required_node_ids and (nid in skip_ids or nid in slice_parent_ids):
            continue
        if nid in instance_child_ids and nid not in required_node_ids:
            continue
        if nid in reuse_outside_output_map:
            info = reuse_outside_output_map[nid]
            skipped_existing.append({
                "nodeId": nid,
                "nodeName": node_map.get(nid, {}).get("name", ""),
                "fileName": info["fileName"],
                "targetPath": str(output_dir / info["fileName"]),
                "reason": "reuseOutsideOutputDir",
            })
            continue
        node = node_map.get(nid)
        if not node:
            continue
        fname = resolve_output_file_name(nid, node["name"], plan_name_map=plan_name_map)
        fpath = output_dir / fname
        skip_existing, skip_reason = should_skip_existing_generated_image(fpath, reuse_asset_paths)
        if skip_existing:
            skipped_existing.append({
                "nodeId": nid,
                "nodeName": node.get("name", ""),
                "fileName": fname,
                "targetPath": str(fpath),
                "reason": skip_reason,
            })
            continue
        try:
            write_base64_png(b64, fpath)
            crop_png_to_expected_size(fpath, plan_size_map.get(nid))
            written += 1
        except Exception as ex:
            print(f"  [ERR] {fname}: {ex}")
            normal_errors.append({
                "nodeId": nid,
                "nodeName": node.get("name", ""),
                "fileName": fname,
                "error": str(ex),
            })

    # 复制 Common_Texture 图片
    copy_results = []

    # 注：这里不再做"删除误写入 Common_Texture_* 副本"的安全检查，
    # 因为 gen_spec.py 中 Common_Texture 索引未命中时会回退磁盘扫描，
    # 若已存在于 _Common/ 目录则标记为 reuseExistingAsset=true，此处会跳过写入；
    # 若磁盘也不存在，说明该 Common_Texture 文件是本次新建资源，不应被删除。
    # 之前的安全删除逻辑会误删刚写入的文件，已废弃。

    print(f"\n完成: 九宫={len(sixed_tasks)} 普通={written}")
    plan_validation = validate_download_plan(args.download_plan, resolved_plan_exports, base64_by_node)
    audit_report = build_image_process_report(
        nine_results,
        skipped_nine,
        written,
        normal_errors,
        skipped_existing,
        copy_results,
        output_dir,
        validation_report_path,
        plan_validation,
        resolved_plan_exports,
        reuse_missing_regenerated,
    )
    report_path = Path(args.output_report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(audit_report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Report → {report_path} | allPass={audit_report['allPass']}")
    return 0 if audit_report["allPass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
