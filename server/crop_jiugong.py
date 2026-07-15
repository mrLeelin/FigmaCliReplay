"""Figma 九宫图片裁切与 Unity Sprite .meta 写入模块。"""

from __future__ import annotations

import base64
import hashlib
import io
import re
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def find_repository_root(start_path: Path) -> Path:
    """从源码或打包产物目录向上定位同时包含 .figma 与 Unity 工程的仓库根目录。"""
    for candidate in (start_path, *start_path.parents):
        if (candidate / ".figma").is_dir() and (candidate / "JellybeanUnity" / "Assets").is_dir():
            return candidate
    return start_path


REPOSITORY_ROOT = find_repository_root(PLUGIN_ROOT)
UNITY_PROJECT_ROOT = REPOSITORY_ROOT / "JellybeanUnity"


def crop_jiugong_images(payload: Dict[str, Any]) -> Dict[str, Any]:
    """处理 Figma 九宫导出请求，裁切图片并写入 Unity Sprite meta。"""
    diagnostics = [
        f"payloadKeys={','.join(sorted(str(key) for key in payload.keys()))}",
        f"targetDirRaw={payload.get('targetDir') or ''}",
        f"targetModeRaw={payload.get('targetMode') or ''}",
        f"replaceAssetPathRaw={payload.get('replaceAssetPath') or ''}",
    ]
    if not HAS_PIL:
        diagnostics.append("PIL=missing")
        return {"ok": False, "error": "PIL not installed. Run: pip install Pillow", "diagnostics": diagnostics}
    diagnostics.append("PIL=ok")
    target_dir = str(payload.get("targetDir") or "")
    if not target_dir:
        diagnostics.append("fail=missing targetDir")
        return {"ok": False, "error": "missing targetDir", "diagnostics": diagnostics}
    target_path = resolve_export_target_dir(target_dir)
    if not target_path:
        diagnostics.append(f"fail=targetDir not found targetDir={target_dir}")
        return {"ok": False, "error": f"targetDir not found: {target_dir}", "diagnostics": diagnostics}
    diagnostics.append(f"targetPath={target_path}")
    images = payload.get("images")
    if not isinstance(images, list) or len(images) == 0:
        diagnostics.append("fail=missing images array")
        return {"ok": False, "error": "missing images array", "diagnostics": diagnostics}
    diagnostics.append(f"imageCount={len(images)}")
    target_mode = str(payload.get("targetMode") or "")
    replace_asset_path = str(payload.get("replaceAssetPath") or "")
    replace_path: Optional[Path] = None
    if target_mode == "replaceImage" or replace_asset_path:
        diagnostics.append("replaceBranch=entered")
        if len(images) != 1:
            return {"ok": False, "targetDir": str(target_path), "imported": [], "errors": [
                f"Unity 当前选中图片时只能覆盖 1 张九宫图，当前收到 {len(images)} 张。"
            ], "importedCount": 0, "errorCount": 1, "diagnostics": diagnostics}
        replace_path = resolve_unity_asset_path(replace_asset_path)
        diagnostics.append(f"resolvedReplacePath={replace_path or '<none>'}")
        if not replace_path:
            return {"ok": False, "targetDir": str(target_path), "imported": [], "errors": [
                f"replaceAssetPath not found or unsupported: {replace_asset_path}"
            ], "importedCount": 0, "errorCount": 1, "diagnostics": diagnostics}
    else:
        diagnostics.append("replaceBranch=not-entered")

    imported = []
    errors = []
    for index, img in enumerate(images):
        try:
            result = _process_one_image(img, target_path, replace_path if index == 0 else None)
            diagnostics.extend(result.get("diagnostics", []))
            if result.get("error"):
                errors.append(f"{img.get('fileName', '?')}: {result['error']}")
            else:
                imported.append(str(result.get("relativePath", "")))
        except Exception as exc:
            errors.append(f"{img.get('fileName', '?')}: {exc}")
    ok = len(imported) > 0 and len(errors) == 0
    target_display = f"替换图片：{replace_asset_path}" if replace_path else f"导入文件夹：{target_dir}"
    return {"ok": ok, "targetDir": str(target_path), "targetDisplay": target_display,
            "replaceAssetPath": replace_asset_path if replace_path else "",
            "imported": imported, "errors": errors,
            "importedCount": len(imported), "errorCount": len(errors),
            "diagnostics": diagnostics}


def resolve_export_target_dir(target_dir: str) -> Optional[Path]:
    """解析导出目标目录，兼容 MCP Relay 从插件目录启动时传入的 Unity 相对路径。"""
    raw_path = Path(target_dir).expanduser()
    if raw_path.is_absolute():
        candidates = [raw_path]
    else:
        candidates = [
            UNITY_PROJECT_ROOT / raw_path,
            REPOSITORY_ROOT / raw_path,
            raw_path,
        ]
    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate.resolve()
    return None


def resolve_unity_asset_path(asset_path: str) -> Optional[Path]:
    """解析 Unity Assets 相对路径，并限制只能覆盖常见图片资源。"""
    if not asset_path:
        return None
    normalized = asset_path.replace("\\", "/")
    if not normalized.startswith("Assets/"):
        return None
    suffix = Path(normalized).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".tga"}:
        return None
    full_path = (UNITY_PROJECT_ROOT / normalized).resolve()
    assets_root = (UNITY_PROJECT_ROOT / "Assets").resolve()
    try:
        full_path.relative_to(assets_root)
    except ValueError:
        return None
    if not full_path.exists() or not full_path.is_file():
        return None
    return full_path


def _process_one_image(img: Dict[str, Any], target_path: Path, replace_path: Optional[Path] = None) -> Dict[str, Any]:
    """处理单张图片：解码 base64、九宫裁切、写 PNG 和 .meta。"""
    diagnostics = [
        f"process fileName={img.get('fileName', '?')} replace={replace_path is not None}",
    ]
    base64_str = str(img.get("base64") or "")
    if not base64_str:
        diagnostics.append("fail=empty base64")
        return {"error": "empty base64", "diagnostics": diagnostics}
    raw = base64.b64decode(base64_str)

    file_name = _sanitize_name(str(img.get("fileName") or "image.png"))
    if not file_name.endswith(".png"):
        file_name = file_name.rsplit(".", 1)[0] + ".png"
    out_path = replace_path or (target_path / file_name)
    update_existing_meta = replace_path is not None
    diagnostics.append(f"outPath={out_path}")
    diagnostics.append(f"updateExistingMeta={update_existing_meta}")

    image_type = str(img.get("imageType") or "")
    border_left = int(float(img.get("borderLeft") or 0))
    border_right = int(float(img.get("borderRight") or 0))
    border_top = int(float(img.get("borderTop") or 0))
    border_bottom = int(float(img.get("borderBottom") or 0))
    has_border = border_left > 0 or border_right > 0 or border_top > 0 or border_bottom > 0
    diagnostics.append(
        f"imageType={image_type} border={{left:{border_left},bottom:{border_bottom},right:{border_right},top:{border_top}}}"
    )

    src = Image.open(io.BytesIO(raw)).convert("RGBA")
    diagnostics.append(f"sourceSize={src.size[0]}x{src.size[1]}")
    if image_type == "Sliced" and has_border:
        expected_w, expected_h = _expected_sliced_size(src, border_left, border_right, border_top, border_bottom)
        diagnostics.append(f"expectedSlicedSize={expected_w}x{expected_h}")
        if src.size == (expected_w, expected_h):
            dst = src
            diagnostics.append("cropMode=already-minimal")
        else:
            dst = _crop_nine_slice_image(src, border_left, border_right, border_top, border_bottom)
            diagnostics.append(f"cropMode=cropped outputSize={dst.size[0]}x{dst.size[1]}")
        dst.save(str(out_path), "PNG")
        meta_mode = _write_meta(out_path, border_left, border_bottom, border_right, border_top, update_existing_meta)
        diagnostics.append(f"metaMode={meta_mode}")
    else:
        src.save(str(out_path), "PNG")
        meta_mode = _write_meta(out_path, 0, 0, 0, 0, update_existing_meta)
        diagnostics.append(f"metaMode={meta_mode}")

    diagnostics.append(f"relativePath={_unity_relative_path(out_path) if replace_path else file_name}")
    return {"relativePath": _unity_relative_path(out_path) if replace_path else file_name, "diagnostics": diagnostics}


def _unity_relative_path(path: Path) -> str:
    """把绝对路径转成 Unity 资源相对路径，失败时退回文件名。"""
    try:
        return str(path.resolve().relative_to(UNITY_PROJECT_ROOT)).replace("\\", "/")
    except ValueError:
        return path.name


def _expected_sliced_size(img, left: int, right: int, top: int, bottom: int):
    """计算九宫或三切片导出后应写入 Unity 的最小 PNG 尺寸。"""
    sw, sh = img.size
    h_border = left > 0 or right > 0
    v_border = top > 0 or bottom > 0
    if h_border and v_border:
        return left + right + 2, top + bottom + 2
    if h_border:
        return left + right + 2, sh
    return sw, top + bottom + 2


def _crop_nine_slice_image(img, left: int, right: int, top: int, bottom: int):
    """按 Unity 九宫规则将完整源图合成为最小可拉伸 PNG。"""
    sw, sh = img.size
    h_border = left > 0 or right > 0
    v_border = top > 0 or bottom > 0
    if h_border and v_border:
        return _crop_9slice(img, left, right, top, bottom, sw, sh)
    elif h_border:
        return _crop_h3slice(img, left, right, sw, sh)
    else:
        return _crop_v3slice(img, top, bottom, sw, sh)


def _crop_9slice(img, left, right, top, bottom, sw, sh):
    """合成标准九宫最小图，保留四角和四边保护区。"""
    tw, th = left + right + 2, top + bottom + 2
    dst = Image.new("RGBA", (tw, th))
    cw, ch = max(1, sw - left - right), max(1, sh - top - bottom)
    sections = [
        ((0, 0, left, top), (0, 0, left, top)),
        ((left, 0, cw, top), (left, 0, 2, top)),
        ((sw - right, 0, right, top), (left + 2, 0, right, top)),
        ((0, top, left, ch), (0, top, left, 2)),
        ((left, top, cw, ch), (left, top, 2, 2)),
        ((sw - right, top, right, ch), (left + 2, top, right, 2)),
        ((0, sh - bottom, left, bottom), (0, top + 2, left, bottom)),
        ((left, sh - bottom, cw, bottom), (left, top + 2, 2, bottom)),
        ((sw - right, sh - bottom, right, bottom), (left + 2, top + 2, right, bottom)),
    ]
    for (sx, sy, sw2, sh2), (dx, dy, dw, dh) in sections:
        if sw2 <= 0 or sh2 <= 0 or dw <= 0 or dh <= 0:
            continue
        region = img.crop((sx, sy, sx + sw2, sy + sh2))
        if sw2 == dw and sh2 == dh:
            dst.paste(region, (dx, dy))
        else:
            dst.paste(region.resize((dw, dh), Image.LANCZOS), (dx, dy))
    return dst


def _crop_h3slice(img, left, right, sw, sh):
    """合成横向三切片最小图，Y 方向保留完整高度。"""
    tw = left + right + 2
    dst = Image.new("RGBA", (tw, sh))
    cw = max(1, sw - left - right)
    sections = [
        ((0, 0, left, sh), (0, 0, left, sh)),
        ((left, 0, cw, sh), (left, 0, 2, sh)),
        ((sw - right, 0, right, sh), (left + 2, 0, right, sh)),
    ]
    for (sx, sy, sw2, sh2), (dx, dy, dw, dh) in sections:
        if sw2 <= 0 or sh2 <= 0 or dw <= 0 or dh <= 0:
            continue
        region = img.crop((sx, sy, sx + sw2, sy + sh2))
        if sw2 == dw and sh2 == dh:
            dst.paste(region, (dx, dy))
        else:
            dst.paste(region.resize((dw, dh), Image.LANCZOS), (dx, dy))
    return dst


def _crop_v3slice(img, top, bottom, sw, sh):
    """合成纵向三切片最小图，X 方向保留完整宽度。"""
    th = top + bottom + 2
    dst = Image.new("RGBA", (sw, th))
    ch = max(1, sh - top - bottom)
    sections = [
        ((0, 0, sw, top), (0, 0, sw, top)),
        ((0, top, sw, ch), (0, top, sw, 2)),
        ((0, sh - bottom, sw, bottom), (0, top + 2, sw, bottom)),
    ]
    for (sx, sy, sw2, sh2), (dx, dy, dw, dh) in sections:
        if sw2 <= 0 or sh2 <= 0 or dw <= 0 or dh <= 0:
            continue
        region = img.crop((sx, sy, sx + sw2, sy + sh2))
        if sw2 == dw and sh2 == dh:
            dst.paste(region, (dx, dy))
        else:
            dst.paste(region.resize((dw, dh), Image.LANCZOS), (dx, dy))
    return dst


def _guid_for_path(path: Path) -> str:
    """根据输出路径生成稳定 GUID，避免同一次导出反复变化。"""
    h = hashlib.md5(str(path).encode()).hexdigest()
    return f"{h[:8]}{h[8:12]}{h[12:16]}{h[16:20]}{h[20:]}"


def _write_meta(png_path: Path, left: int, bottom: int, right: int, top: int, update_existing: bool = False) -> str:
    """写入 Unity .meta 文件，配置 Sprite 类型和 spriteBorder。"""
    meta_path = Path(str(png_path) + ".meta")
    border = f"{{x: {left}, y: {bottom}, z: {right}, w: {top}}}"
    if update_existing and meta_path.exists():
        _update_existing_meta(meta_path, border)
        return f"updateExisting:{meta_path}"

    guid = _guid_for_path(png_path)
    meta = f'''fileFormatVersion: 2
guid: {guid}
TextureImporter:
  internalIDToNameTable: []
  externalObjects: {{}}
  serializedVersion: 13
  mipmaps:
    mipMapMode: 0
    enableMipMap: 0
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
    flipGreenChannel: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  vTOnly: 0
  ignoreMipmapLimit: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 1
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
    wrapW: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 1
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {{x: 0.5, y: 0.5}}
  spritePixelsToUnits: 100
  spriteBorder: {border}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 1
  spriteTessellationDetail: -1
  textureType: 8
  textureShape: 1
  singleChannelComponent: 0
  flipbookRows: 1
  flipbookColumns: 1
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  ignorePngGamma: 0
  applyGammaDecoding: 0
  swizzle: 50462976
  cookieLightType: 0
  platformSettings:
  - serializedVersion: 4
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 1
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_BC6H_BC7: 0
  - serializedVersion: 4
    buildTarget: Standalone
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 1
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_BC6H_BC7: 0
  - serializedVersion: 4
    buildTarget: Android
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 1
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_BC6H_BC7: 0
  - serializedVersion: 4
    buildTarget: iOS
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 1
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_BC6H_BC7: 0
  spriteSheet:
    serializedVersion: 2
    sprites: []
    outline: []
    customData:
    physicsShape: []
    bones: []
    spriteID: 5e97eb03825dee720800000000000000
    internalID: 0
    vertices: []
    indices:
    edges: []
    weights: []
    secondaryTextures: []
    spriteCustomMetadata:
      entries: []
    nameFileIdTable: {{}}
  mipmapLimitGroupName:
  pSDRemoveMatte: 0
  userData:
  assetBundleName:
  assetBundleVariant:
'''
    meta_path.write_text(meta, encoding="utf-8")
    return f"writeNew:{meta_path}"


def _update_existing_meta(meta_path: Path, border: str) -> None:
    """更新已有 Unity 图片 .meta，保留 GUID 和既有平台导入设置。"""
    text = meta_path.read_text(encoding="utf-8")
    text = _replace_or_insert_meta_value(text, "textureType", "8", "  textureShape:")
    text = _replace_or_insert_meta_value(text, "spriteMode", "1", "  spriteExtrude:")
    text = _replace_or_insert_meta_value(text, "spriteBorder", border, "  spriteGenerateFallbackPhysicsShape:")
    text = _replace_or_insert_meta_value(text, "alphaIsTransparency", "1", "  spriteTessellationDetail:")
    meta_path.write_text(text, encoding="utf-8")


def _replace_or_insert_meta_value(text: str, key: str, value: str, anchor: str) -> str:
    """替换 Unity .meta 中的单行字段；不存在时插入到指定锚点前。"""
    pattern = re.compile(rf"^(\s*{re.escape(key)}:\s*).*$", re.MULTILINE)
    replacement = rf"\g<1>{value}"
    if pattern.search(text):
        return pattern.sub(replacement, text, count=1)
    index = text.find(anchor)
    line = f"  {key}: {value}\n"
    if index >= 0:
        return text[:index] + line + text[index:]
    return text.rstrip() + "\n" + line


def _sanitize_name(name: str) -> str:
    """清理 Windows 和 Unity 资源路径不允许的文件名字符。"""
    return re.sub(r'[\\/:*?"<>|]', '_', name)
