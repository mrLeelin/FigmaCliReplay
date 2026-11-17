"""用本机 Photoshop 渲染 PSD 视觉单元，生成与 export_psd_layers.py 兼容的 manifest。

export_psd_layers.py 只读取图层原始通道像素，图层样式（描边、内阴影、颜色/渐变叠加、
投影）、图层蒙版、剪贴蒙版、组级样式与画板裁切都会丢失。本脚本让 Photoshop 自己渲染
每个可见视觉单元，再按画板裁切、裁掉透明边，普通文字仍复用 export_psd_layers.py 的
原生 Text 数据，保证 Figma 结果与 Photoshop 合成一致。

仅支持 Windows + 已安装 Photoshop（COM: Photoshop.Application）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
JSX_TEMPLATE = SCRIPT_DIR / "photoshop_render_units.jsx"
EXPORTER = SCRIPT_DIR / "export_psd_layers.py"
FIGMA_IMAGE_LIMIT = 4096

# Photoshop 混合模式 stringID -> Figma BlendMode。
BLEND_MAP = {
    "normal": "NORMAL",
    "passThrough": "NORMAL",
    "multiply": "MULTIPLY",
    "screen": "SCREEN",
    "overlay": "OVERLAY",
    "darken": "DARKEN",
    "lighten": "LIGHTEN",
    "colorBurn": "COLOR_BURN",
    "colorDodge": "COLOR_DODGE",
    "linearBurn": "LINEAR_BURN",
    "linearDodge": "LINEAR_DODGE",
    "softLight": "SOFT_LIGHT",
    "hardLight": "HARD_LIGHT",
    "difference": "DIFFERENCE",
    "exclusion": "EXCLUSION",
    "hue": "HUE",
    "saturation": "SATURATION",
    "color": "COLOR",
    "luminosity": "LUMINOSITY",
}


def _safe_file_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name).strip() or "layer"
    return cleaned[:60]


def _run_photoshop(psd_path: Path, render_dir: Path, only_orders: Optional[List[int]] = None) -> Dict[str, Any]:
    """注入配置后通过 COM 让 Photoshop 执行 JSX，返回 ps_units.json 内容。"""
    import win32com.client  # 延迟导入：非 Windows 环境下不影响 --help。

    config: Dict[str, Any] = {"psdPath": psd_path.as_posix(), "outDir": render_dir.as_posix()}
    if only_orders:
        # 调试用：只渲染指定序号的单元，其余单元仍会出现在结果中但没有图片。
        config["onlyOrders"] = only_orders
    jsx = JSX_TEMPLATE.read_text(encoding="utf-8").replace("__CONFIG__", json.dumps(config, ensure_ascii=False))
    jsx_path = render_dir / "render_units.jsx"
    # ExtendScript 按 BOM 识别 UTF-8，图层名与路径含中文时必须带 BOM。
    jsx_path.write_text(jsx, encoding="utf-8-sig")
    app = win32com.client.Dispatch("Photoshop.Application")
    status = app.DoJavaScriptFile(str(jsx_path))
    units_path = render_dir / "ps_units.json"
    if not units_path.exists():
        raise RuntimeError(f"Photoshop 未生成 ps_units.json：{status}")
    return json.loads(units_path.read_text(encoding="utf-8"))


def _ensure_base_manifest(psd_path: Path, base_manifest: Optional[Path], out_dir: Path) -> Dict[str, Any]:
    """读取或生成原导出器 manifest，用于复用原生 Text 数据与约束。"""
    if base_manifest is None:
        base_dir = out_dir / "base"
        subprocess.run([sys.executable, "-I", str(EXPORTER), str(psd_path), "--out", str(base_dir)], check=True)
        base_manifest = base_dir / "manifest.json"
    return json.loads(base_manifest.read_text(encoding="utf-8"))


def _image_entry(unit: Dict[str, Any], png: Path, x: int, y: int, w: int, h: int,
                 constraints: Dict[str, str]) -> Dict[str, Any]:
    raw = png.read_bytes()
    content_hash = hashlib.sha256(raw).hexdigest()
    blend = BLEND_MAP.get(str(unit.get("blend") or "normal"), "NORMAL")
    name = str(unit["name"])
    return {
        "name": name,
        "mode": "image",
        "layerId": int(unit["layerId"]),
        "contentHash": content_hash,
        "sourceState": {
            "version": 3,
            "layerId": str(unit["layerId"]),
            "mode": "image",
            "geometry": {"x": float(x), "y": float(y), "width": float(w), "height": float(h), "rotation": None},
            # 透明度、填充与样式已烘焙进像素，Figma 节点保持 1，避免重复叠加。
            "display": {"visible": True, "opacity": 1.0, "blendMode": blend, "constraints": constraints},
            "content": {"contentHash": content_hash},
            "text": None,
            "nineSlice": None,
            "unsupported": [],
        },
        "rawPsdLayerName": name,
        "normalizedLayerName": name,
        "semanticMode": "image",
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "opacity": 255,
        "visible": True,
        "constraints": constraints,
        "renderSource": "photoshop",
        "psdPath": "/".join(str(p) for p in unit.get("path", [])),
        "psdLayerIds": unit.get("layerIds", []),
        "bytes": len(raw),
    }


def build_manifest(psd_path: Path, out_dir: Path, base_manifest: Optional[Path],
                   only_orders: Optional[List[int]] = None) -> Dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    render_dir = out_dir / "ps_render"
    render_dir.mkdir(exist_ok=True)
    base = _ensure_base_manifest(psd_path, base_manifest, out_dir)
    base_by_id = {int(layer["layerId"]): layer for layer in base.get("layers", []) if layer.get("layerId") is not None}
    ps = _run_photoshop(psd_path, render_dir, only_orders)

    layers: List[Dict[str, Any]] = []
    warnings: List[str] = list(ps.get("errors", []))
    for unit in ps["units"]:
        layer_id = int(unit["layerId"])
        source = base_by_id.get(layer_id)
        constraints = (source or {}).get("constraints") or {"horizontal": "MIN", "vertical": "MIN"}
        if unit["kind"] == "text":
            if source is None or source.get("mode") != "text":
                warnings.append(f"{unit['name']}: 原导出器缺少文字数据，已跳过")
                continue
            entry = dict(source)
            entry.pop("idx", None)
            layers.append(entry)
            continue
        if not unit.get("file"):
            if unit.get("error"):
                warnings.append(f"{unit['name']}: {unit['error']}")
            continue
        image = Image.open(unit["file"]).convert("RGBA")
        rect = [int(v) for v in unit["rect"]]
        clip = unit.get("clip")
        if clip:
            # 画板外的内容在 Photoshop 中不可见：按画板范围裁切后再求透明边界。
            left, top = max(int(clip[0]), rect[0]), max(int(clip[1]), rect[1])
            right, bottom = min(int(clip[2]), rect[2]), min(int(clip[3]), rect[3])
            image = image.crop((left - rect[0], top - rect[1], right - rect[0], bottom - rect[1]))
            rect = [left, top, right, bottom]
        bbox = image.getchannel("A").getbbox()
        if not bbox:
            continue
        x, y = int(rect[0]) + bbox[0], int(rect[1]) + bbox[1]
        cropped = image.crop(bbox)
        w, h = cropped.size
        if max(w, h) > FIGMA_IMAGE_LIMIT:
            warnings.append(f"{unit['name']}: {w}x{h} 超过 Figma 单图 {FIGMA_IMAGE_LIMIT}px 限制")
        png = out_dir / f"{len(layers) + 1:03d}_{_safe_file_name(str(unit['name']))}.png"
        cropped.save(png, optimize=False, compress_level=3)
        entry = _image_entry(unit, png, x, y, w, h, constraints)
        entry["path"] = png.as_posix()
        layers.append(entry)

    for index, layer in enumerate(layers, start=1):
        layer["idx"] = index
    text_layers = [layer for layer in layers if layer["mode"] == "text"]
    image_layers = [layer for layer in layers if layer["mode"] != "text"]
    manifest = {
        "canvas": ps["canvas"],
        "renderSource": "photoshop",
        "layerCount": len(layers),
        "commonCount": 0,
        "nineSliceCount": 0,
        "textCount": len(text_layers),
        "imageCount": len(image_layers),
        "layers": layers,
        "commonLayers": [],
        "nineSliceLayers": [],
        "textLayers": text_layers,
        "imageLayers": image_layers,
        "warnings": warnings,
        "referencePath": str(ps.get("reference") or ""),
    }
    (out_dir / "manifest_summary.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="用 Photoshop 渲染 PSD 视觉单元并生成 Figma 导入 manifest。")
    parser.add_argument("psd", type=Path, help="输入 PSD 文件路径。")
    parser.add_argument("--out", type=Path, required=True, help="输出目录。")
    parser.add_argument("--base-manifest", type=Path, default=None,
                        help="已有 export_psd_layers.py 的 manifest.json；缺省时自动生成。")
    parser.add_argument("--only", type=int, nargs="*", default=None, help="调试：只渲染这些单元序号。")
    args = parser.parse_args()
    manifest = build_manifest(args.psd.resolve(), args.out.resolve(), args.base_manifest, args.only)
    print(json.dumps({
        "manifest": (args.out / "manifest_summary.json").as_posix(),
        "layerCount": manifest["layerCount"],
        "textCount": manifest["textCount"],
        "imageCount": manifest["imageCount"],
        "warnings": manifest["warnings"],
        "reference": manifest["referencePath"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
