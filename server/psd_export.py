"""把 Figma 导出的图层清单组装成分层 PSD。

输出约定：
- imagesPrestretched=true 时，PNG、size 和 bbox 均已经是最终输出像素，不能再次乘倍率。
- 图层用 Unicode 名称；文件名才做 ASCII 转换。文字当前作为像素层保留。
- Figma children 和 psd-tools append 都按从底到顶排列，保留输入顺序。
- 每个声明需要图像的节点都必须有完整 PNG，缺图或缺分片禁止返回成功。

两条入口：
- assemble_psd(payload)：单请求内联，图层 PNG 以 base64 随请求送达（小项目）。
- stage_meta / stage_chunk / assemble_staged：分批暂存（大项目，规避 16 MiB 单帧上限）。

输出目录被强制限制在仓库的 .tmp/exports 之内，避免畸形请求写到任意路径。
"""

from __future__ import annotations

import base64
import io
import json
import hashlib
import math
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import BlendMode

# 层名软上限：PSD 的 Pascal 字符串长度按字节计，留足余量避免边界问题。
MAX_LAYER_NAME = 120
CONTAINER_TYPES = {"FRAME", "GROUP", "COMPONENT", "INSTANCE", "COMPONENT_SET", "SECTION"}
MAX_PARTS = 4096

EXPORT_ROOT = (Path(__file__).resolve().parents[1] / ".tmp" / "exports").resolve()

# 中文等非 ASCII 名的替换词表；未命中时退化为 Layer_<序号>。
_NAME_HINTS = {
    "背景": "Background",
    "标题": "Title",
    "机台": "Machine",
    "底座": "Base",
    "金币堆": "CoinPile",
    "金币": "Coin",
    "出币口": "Chute",
    "按钮底": "ButtonBG",
    "按钮文字": "ButtonLabel",
    "按钮": "Button",
    "文字": "Text",
    "图标": "Icon",
    "信息栏": "InfoBar",
    "底部": "BottomBar",
    "数量": "Count",
}


def latinize(name: str, index: int, taken: Optional[set] = None) -> str:
    """生成安全的 ASCII 文件名；PSD 内部名称保留原始 Unicode。"""
    raw = str(name or "").strip()
    # 先把已知中文词替换成英文，再剔除剩余非 ASCII。
    # 必须按词条长度倒序：否则「按钮底」会先被短词「按钮」命中，得到 Button 而非 ButtonBG。
    for cn, en in sorted(_NAME_HINTS.items(), key=lambda item: len(item[0]), reverse=True):
        if cn in raw:
            raw = raw.replace(cn, en)
    ascii_name = re.sub(r"[^\x20-\x7E]", "", raw).strip()
    ascii_name = re.sub(r"[\\/:*?\"<>|]", "_", ascii_name)
    ascii_name = re.sub(r"\s+", "_", ascii_name)
    if not ascii_name:
        ascii_name = f"Layer_{index:03d}"
    ascii_name = ascii_name[:MAX_LAYER_NAME]
    if taken is None:
        return ascii_name
    base, suffix = ascii_name, 2
    while ascii_name.lower() in taken:
        tail = f"_{suffix}"
        ascii_name = base[: MAX_LAYER_NAME - len(tail)] + tail
        suffix += 1
    taken.add(ascii_name.lower())
    return ascii_name


def resolve_output_dir(value: Any) -> Path:
    """只允许写到 .tmp/exports 之内；省略时默认就是它。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return EXPORT_ROOT
    if not isinstance(value, str):
        raise ValueError("outputDir must be a string")
    target = Path(value).resolve()
    try:
        target.relative_to(EXPORT_ROOT)
    except ValueError:
        raise ValueError(f"outputDir must be inside {EXPORT_ROOT}") from None
    return target


def _safe_token(value: Any, field: str) -> str:
    token = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", token):
        raise ValueError(f"Invalid {field}")
    return token


def _decode_png(b64: str) -> Image.Image:
    payload = b64.split(",", 1)[1] if b64.startswith("data:") else b64
    try:
        with Image.open(io.BytesIO(base64.b64decode(payload, validate=True))) as source:
            if source.format != "PNG":
                raise ValueError("Layer image must be PNG")
            return source.convert("RGBA")
    except (OSError, TypeError) as error:
        raise ValueError(f"Invalid layer PNG: {error}") from error


def _node_id(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024 or any(ord(c) < 32 for c in value):
        raise ValueError("Invalid layer id")
    return value


def _image_token(node_id: str) -> str:
    return hashlib.sha256(_node_id(node_id).encode("utf-8")).hexdigest()


def _load_layer_image(node: Dict[str, Any], staging_root: Optional[Path], scale: float, prestretched: bool) -> Optional[Image.Image]:
    """优先取暂存的 PNG 文件，其次取内联 base64。"""
    png_file = node.get("pngFile")
    if png_file and staging_root is not None:
        path = (staging_root / Path(str(png_file)).name).resolve()
        if staging_root not in path.parents:
            raise ValueError("Layer file escapes staging directory")
        if not path.exists():
            raise ValueError(f"Staged layer missing: {path.name}")
        with Image.open(path) as source:
            if source.format != "PNG":
                raise ValueError(f"Layer image must be PNG: {node.get('id')}")
            image = source.convert("RGBA")
    else:
        b64 = node.get("pngBase64") or ""
        if not b64:
            return None
        image = _decode_png(b64)
    if not prestretched and scale != 1:
        image = image.resize(
            (max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale)))),
            Image.LANCZOS,
        )
    return image


def build_psd(
    nodes: List[Dict[str, Any]],
    size: Dict[str, int],
    scale: float,
    staging_root: Optional[Path] = None,
    prestretched: bool = False,
) -> tuple:
    """按输入层序逐节点建组/建层，返回 (PSDImage, 层名对照表)。"""
    nodes = _validate_nodes(nodes)
    size = _validate_size(size)
    scale = _validate_scale(scale)
    coordinate_scale = 1 if prestretched else scale
    width = max(1, int(round(size["width"] * coordinate_scale)))
    height = max(1, int(round(size["height"] * coordinate_scale)))
    if width > 30000 or height > 30000:
        raise ValueError("PSD canvas exceeds 30000 pixels; reduce export scale or selection")
    psd = PSDImage.new(mode="RGBA", size=(width, height), color=(0, 0, 0, 0))
    psd.background_color = None

    children: Dict[str, List[Dict[str, Any]]] = {}
    for node in nodes:
        parent = str(node.get("parentId") or "")
        children.setdefault(parent, []).append(node)

    mapping: List[Dict[str, str]] = []
    def display_name(value: Any) -> str:
        name = str(value if value is not None else "")
        if len(name) > 255:
            raise ValueError("PSD layer names cannot exceed 255 characters")
        return name

    def add_mapping(node, name, kind, **details):
        mapping.append({"nodeId": node["id"], "original": str(node.get("name") or ""),
                        "layer": name, "kind": kind, "sourceType": node.get("type", "UNKNOWN"), **details})

    def add_group(parent_container, name, node, auxiliary=False):
        # 构造器的 Pascal 名称字段先使用 ASCII；setter 同时填写 Unicode tagged block。
        group = psd.create_group(name="Group", opacity=_opacity(node), blend_mode=_blend_mode(node, True))
        group.name = display_name(name)
        group.visible = node.get("visible", True) is not False
        parent_container.append(group)
        add_mapping(node, group.name, "group", auxiliary=auxiliary)
        return group

    def add_pixel(parent_container, image, name, node, own=False):
        bbox = node.get("bbox") or {}
        layer = psd.create_pixel_layer(
            image, name="Layer",
            top=int(round(float(bbox.get("y", 0)) * coordinate_scale)),
            left=int(round(float(bbox.get("x", 0)) * coordinate_scale)),
            opacity=255 if own else _opacity(node),
            blend_mode=BlendMode.NORMAL if own else _blend_mode(node, False),
        )
        layer.name = display_name(name)
        layer.visible = True if own else node.get("visible", True) is not False
        parent_container.append(layer)
        add_mapping(node, layer.name, "pixel", ownImage=own)

    def emit(parent_container, parent_id: str) -> None:
        for node in children.get(parent_id, []):
            node_id = node["id"]
            if node.get("synthetic") is True:
                emit(parent_container, node_id)
                continue
            name = display_name(node.get("name", ""))
            image = _load_layer_image(node, staging_root, scale, prestretched)
            if node.get("imageExpected") is True and image is None:
                raise ValueError(f"Missing required layer PNG: {node_id} ({name})")
            is_container = bool(children.get(node_id)) or node.get("type") in CONTAINER_TYPES
            if is_container:
                group = add_group(parent_container, name, node)
                if image is not None:
                    suffix = "（合成效果）" if node.get("composited") else "（自身填充）"
                    add_pixel(group, image, display_name((name[:240] + suffix)), node, own=True)
                if node.get("composited") and children.get(node_id):
                    if image is None:
                        raise ValueError(f"Missing composited container PNG: {node_id}")
                    sources = add_group(group, "源图层", {**node, "opacity": 1, "visible": False, "blendMode": "PASS_THROUGH"}, True)
                    emit(sources, node_id)
                else:
                    emit(group, node_id)
            else:
                # 无绘制内容的节点仍保留透明占位层，不从层级清单中静默消失。
                if image is None:
                    image = Image.new("RGBA", (1, 1))
                add_pixel(parent_container, image, name, node)

    emit(psd, "")
    # PSD 规范用负的 layer_count 标记合成图第一个额外通道为透明度。
    # psd-tools 的新建 RGBA 文档没有自动设置该标记；否则 save 后预览丢 alpha。
    layer_info = psd._record.layer_and_mask_information.layer_info
    if layer_info is not None and layer_info.layer_count:
        layer_info.layer_count = -abs(layer_info.layer_count)
        psd._merged_alpha = True
    return psd, mapping


def _opacity(node: Dict[str, Any]) -> int:
    value = node.get("opacity", 1)
    opacity = float(1 if value is None else value)
    if not math.isfinite(opacity):
        raise ValueError("Layer opacity must be finite")
    return max(0, min(255, int(round(opacity * 255))))


def _blend_mode(node: Dict[str, Any], group: bool) -> BlendMode:
    name = node.get("blendMode") or ("PASS_THROUGH" if group else "NORMAL")
    try:
        mode = BlendMode[name]
    except (KeyError, TypeError):
        raise ValueError(f"Unsupported PSD blend mode: {name}") from None
    return BlendMode.NORMAL if mode == BlendMode.PASS_THROUGH and not group else mode


def _write_outputs(psd, mapping, output_dir: Path, base_name: str, scale: float,
                   nodes: List[Dict[str, Any]], warnings=None) -> Dict[str, Any]:
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:12]
    psd_path = output_dir / f"{base_name}-{stamp}.psd"
    index_path = output_dir / f"{base_name}-{stamp}.index.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    temporary_psd = output_dir / ("." + psd_path.name + ".part")
    temporary_index = output_dir / ("." + index_path.name + ".part")
    expected = sum(node.get("imageExpected") is True for node in nodes)
    exported = sum(node.get("imageExpected") is True and bool(node.get("pngBase64") or node.get("pngFile")) for node in nodes)
    coverage = {"nodeCount": sum(node.get("synthetic") is not True for node in nodes),
                "expectedImages": expected, "exportedImages": exported,
                "missingImages": expected - exported, "complete": expected == exported}
    if not coverage["complete"]:
        raise ValueError("Missing required layer images")
    warning_list = [str(w) for w in (warnings or [])]
    for node in nodes:
        if node.get("composited"):
            warning_list.append(f"{node.get('name') or node['id']}：{node.get('compositedReason') or '复杂合成'} 已保留合成效果，源图层位于隐藏分组。")
    warning_list = list(dict.fromkeys(warning_list))
    index = {
        "schemaVersion": 2,
        "psd": str(psd_path),
        "size": {"width": psd.width, "height": psd.height},
        "scale": scale,
        "layers": mapping,
        "coverage": coverage,
        "warnings": warning_list,
    }
    groups = sum(1 for item in mapping if item["kind"] == "group")
    pixels = sum(1 for item in mapping if item["kind"] == "pixel")
    try:
        psd.save(str(temporary_psd))
        reopened = PSDImage.open(temporary_psd)
        expected_layers = list(psd.descendants())
        actual_layers = list(reopened.descendants())
        if reopened.size != psd.size or len(actual_layers) != len(expected_layers):
            raise ValueError("PSD roundtrip lost canvas size or layers")
        for original, actual in zip(expected_layers, actual_layers):
            if (actual.name, actual.kind, actual.visible, actual.opacity, actual.bbox, actual.blend_mode) != (original.name, original.kind, original.visible, original.opacity, original.bbox, original.blend_mode):
                raise ValueError(f"PSD roundtrip changed layer: {original.name}")
            if not actual.is_group():
                image = actual.topil()
                if image is None:
                    raise ValueError(f"PSD roundtrip lost layer pixels: {actual.name}")
                image.load()
        temporary_index.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary_psd, psd_path)
        try:
            os.replace(temporary_index, index_path)
        except Exception:
            psd_path.unlink(missing_ok=True)
            raise
    finally:
        temporary_psd.unlink(missing_ok=True)
        temporary_index.unlink(missing_ok=True)
    return {
        "ok": True,
        "psdPath": str(psd_path),
        "indexPath": str(index_path),
        "layerCount": pixels,
        "groupCount": groups,
        "bytes": psd_path.stat().st_size,
        "layers": mapping,
        "coverage": coverage,
        "warnings": warning_list,
    }


def _validate_nodes(nodes: Any) -> List[Dict[str, Any]]:
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("nodes must be a non-empty list")
    if len(nodes) > 5000:
        raise ValueError("nodes exceeds 5000 entries")
    by_id = {}
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("Every node must be an object")
        node_id = _node_id(node.get("id"))
        if node_id in by_id:
            raise ValueError(f"Duplicate layer id: {node_id}")
        by_id[node_id] = node
        bbox = node.get("bbox") or {}
        if not isinstance(bbox, dict):
            raise ValueError("Layer bbox must be an object")
        for value in bbox.values():
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                raise ValueError("Layer bbox coordinates must be finite numbers")
    depths = {}
    for node_id in by_id:
        path = set()
        chain = []
        current = node_id
        while current and current not in depths:
            if current in path:
                raise ValueError(f"Layer parent cycle: {current}")
            if current not in by_id:
                raise ValueError(f"Missing parent layer: {current}")
            path.add(current)
            chain.append(current)
            parent = by_id[current].get("parentId", "")
            if parent is None:
                parent = ""
            if not isinstance(parent, str):
                raise ValueError("Layer parentId must be a string")
            current = parent
        depth = depths.get(current, 0)
        for ancestor in reversed(chain):
            depth += 1
            if depth > 128:
                raise ValueError("Layer nesting exceeds 128 levels")
            depths[ancestor] = depth
    return nodes


def _validate_scale(value: Any) -> float:
    scale = float(1 if value is None else value)
    if not math.isfinite(scale) or not 0.1 <= scale <= 8:
        raise ValueError("scale must be between 0.1 and 8")
    return scale


def _validate_size(value: Any) -> Dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError("size must be an object")
    for key in ("width", "height"):
        if isinstance(value.get(key), bool) or not isinstance(value.get(key), (int, float)) or not math.isfinite(value[key]) or value[key] <= 0:
            raise ValueError("size.width/height must be positive")
    return value


def assemble_psd(payload: Dict[str, Any]) -> Dict[str, Any]:
    """单请求内联路径：nodes 里直接携带 pngBase64。"""
    nodes = _validate_nodes(payload.get("nodes"))
    size = _validate_size(payload.get("size"))
    scale = _validate_scale(payload.get("scale"))
    output_dir = resolve_output_dir(payload.get("outputDir"))
    base_name = latinize(str(payload.get("baseName") or "export"), 0)
    psd, mapping = build_psd(
        nodes, size, scale,
        prestretched=bool(payload.get("imagesPrestretched")),
    )
    return _write_outputs(psd, mapping, output_dir, base_name, scale, nodes, payload.get("warnings"))


# ───────────────────────── 分批暂存路径 ─────────────────────────

def _staging_dir(task_id: str, output_dir: Path) -> Path:
    stage = (output_dir / ".staging" / task_id).resolve()
    if output_dir.resolve() not in stage.parents:
        raise ValueError("Staging directory escapes output directory")
    stage.mkdir(parents=True, exist_ok=True)
    return stage


def stage_meta(payload: Dict[str, Any]) -> Dict[str, Any]:
    """写入任务清单（不含像素）：完成整体结构与画布尺寸登记。"""
    task_id = _safe_token(payload.get("taskId"), "taskId")
    output_dir = resolve_output_dir(payload.get("outputDir"))
    nodes = _validate_nodes(payload.get("nodes"))
    size = _validate_size(payload.get("size"))
    scale = _validate_scale(payload.get("scale"))
    stage = _staging_dir(task_id, output_dir)
    manifest = {
        "taskId": task_id,
        "nodes": nodes,
        "size": size,
        "scale": scale,
        "baseName": str(payload.get("baseName") or "export"),
        "prestretched": bool(payload.get("imagesPrestretched")),
        "warnings": payload.get("warnings") or [],
    }
    manifest_path = stage / "manifest.json"
    if manifest_path.exists() and json.loads(manifest_path.read_text(encoding="utf-8")) != manifest:
        raise ValueError("taskId already has a different staging manifest")
    _atomic_bytes(manifest_path, json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
    return {"ok": True, "taskId": task_id, "nodeCount": len(nodes)}


def stage_chunk(payload: Dict[str, Any]) -> Dict[str, Any]:
    """写入一批图层 PNG。每批独立请求，规避单帧 16 MiB 上限。"""
    task_id = _safe_token(payload.get("taskId"), "taskId")
    output_dir = resolve_output_dir(payload.get("outputDir"))
    layers = payload.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("layers must be a non-empty list")
    if len(layers) > 500:
        raise ValueError("layers per chunk must not exceed 500")
    stage = _staging_dir(task_id, output_dir)
    manifest_path = stage / "manifest.json"
    if not manifest_path.exists():
        raise ValueError("Staging manifest is missing; send stage-meta first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    registered = {node["id"] for node in _validate_nodes(manifest.get("nodes")) if node.get("synthetic") is not True}
    stored = 0
    for layer in layers:
        if not isinstance(layer, dict):
            raise ValueError("Every layer chunk must be an object")
        node_id = _node_id(layer.get("id"))
        if node_id not in registered:
            raise ValueError(f"Unregistered layer id: {node_id}")
        b64 = layer.get("pngBase64") or ""
        if not isinstance(b64, str) or not b64:
            raise ValueError(f"Layer {node_id} has no pngBase64")
        token = _image_token(node_id)
        image_path = stage / f"{token}.png"
        if "partIndex" in layer or "partCount" in layer:
            part_index, part_count = layer.get("partIndex"), layer.get("partCount")
            if type(part_index) is not int or type(part_count) is not int or not 0 <= part_index < part_count <= MAX_PARTS:
                raise ValueError("Invalid image fragment index/count")
            if len(b64) % 4 or b64.startswith("data:"):
                raise ValueError("Image fragments must be base64 aligned to four characters")
            raw = base64.b64decode(b64, validate=True)
            part_manifest = stage / f"{token}.parts.json"
            part_info = {"partCount": part_count}
            if image_path.exists() and not part_manifest.exists():
                raise ValueError(f"Layer already uses a complete image: {node_id}")
            if part_manifest.exists() and json.loads(part_manifest.read_text(encoding="utf-8")) != part_info:
                raise ValueError(f"Conflicting image fragment count: {node_id}")
            _atomic_bytes(part_manifest, json.dumps(part_info).encode("utf-8"))
            part_path = stage / f"{token}.part-{part_index}"
            if part_path.exists() and part_path.read_bytes() != raw:
                raise ValueError(f"Conflicting image fragment: {node_id}/{part_index}")
            _atomic_bytes(part_path, raw)
            parts = [stage / f"{token}.part-{index}" for index in range(part_count)]
            if all(path.exists() for path in parts):
                temporary = stage / f"{token}.assembling"
                try:
                    with temporary.open("wb") as output:
                        for path in parts:
                            with path.open("rb") as source:
                                shutil.copyfileobj(source, output)
                    _validate_png_file(temporary)
                    os.replace(temporary, image_path)
                finally:
                    temporary.unlink(missing_ok=True)
        else:
            raw = base64.b64decode(b64.split(",", 1)[1] if b64.startswith("data:") else b64, validate=True)
            _decode_png(b64)
            if (stage / f"{token}.parts.json").exists():
                raise ValueError(f"Layer already uses image fragments: {node_id}")
            if image_path.exists() and image_path.read_bytes() != raw:
                raise ValueError(f"Conflicting layer image: {node_id}")
            _atomic_bytes(image_path, raw)
        stored += 1
    return {"ok": True, "taskId": task_id, "stored": stored}


def assemble_staged(payload: Dict[str, Any]) -> Dict[str, Any]:
    """从暂存目录组装 PSD，成功后清理暂存。"""
    task_id = _safe_token(payload.get("taskId"), "taskId")
    output_dir = resolve_output_dir(payload.get("outputDir"))
    stage = output_dir / ".staging" / task_id
    manifest_path = stage / "manifest.json"
    if not manifest_path.exists():
        raise ValueError("Staging manifest is missing; send stage-meta first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    nodes = _validate_nodes(manifest.get("nodes"))
    for node in nodes:
        token = _image_token(node["id"])
        node_path = stage / f"{token}.png"
        parts_manifest = stage / f"{token}.parts.json"
        if parts_manifest.exists() and not node_path.exists():
            raise ValueError(f"Incomplete image fragments: {node['id']}")
        if node_path.exists():
            node["pngFile"] = node_path.name
    psd, mapping = build_psd(
        nodes, manifest["size"], float(manifest["scale"]),
        staging_root=stage, prestretched=bool(manifest.get("prestretched")),
    )
    result = _write_outputs(
        psd, mapping, output_dir,
        latinize(str(manifest.get("baseName") or "export"), 0),
        float(manifest["scale"]),
        nodes, manifest.get("warnings"),
    )
    if output_dir.resolve() not in stage.resolve().parents:
        raise ValueError("Refusing to clean a staging directory outside the output directory")
    shutil.rmtree(stage, ignore_errors=True)
    return result


def _atomic_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".part")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _validate_png_file(path: Path) -> None:
    try:
        with Image.open(path) as source:
            if source.format != "PNG":
                raise ValueError("Layer image must be PNG")
            source.verify()
    except OSError as error:
        raise ValueError(f"Invalid layer PNG: {error}") from error


def read_psd_summary(path: str) -> Dict[str, Any]:
    """回读校验：返回层级结构与层数，供测试与验收使用。"""
    psd = PSDImage.open(path)
    flat: List[Dict[str, Any]] = []

    def walk(container, depth: int = 0) -> None:
        for layer in container:
            flat.append({"name": layer.name, "kind": layer.kind, "bbox": list(layer.bbox), "depth": depth,
                         "visible": layer.visible, "opacity": layer.opacity, "blendMode": layer.blend_mode.name})
            if layer.is_group():
                walk(layer, depth + 1)

    walk(psd)
    return {"width": psd.width, "height": psd.height, "layers": flat}
