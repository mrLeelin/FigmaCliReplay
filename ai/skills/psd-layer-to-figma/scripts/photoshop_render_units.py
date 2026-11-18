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
# Relay invokes Python with -I; explicitly expose only these trusted sibling helpers.
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from photoshop_lifecycle import PhotoshopSession

JSX_TEMPLATE = SCRIPT_DIR / "photoshop_render_units.jsx"
EXPORTER = SCRIPT_DIR / "export_psd_layers.py"
FIGMA_IMAGE_LIMIT = 4096
FIGMA_FONT_AGENT_URL = "http://127.0.0.1:44950/figma/font-files"
CJK_PATTERN = re.compile(r"[　-〿㐀-䶿一-鿿＀-￯]")
# PSD 中文字体本机缺失时的替代：Noto Sans SC（思源黑体）与 Adobe 黑体字宽最接近，其次是黑体。
CJK_FONT_FALLBACK = [{"family": "Noto Sans SC", "style": "Regular"}, {"family": "SimHei", "style": "Regular"}]

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


def _run_photoshop(psd_path: Path, render_dir: Path, only_orders: Optional[List[int]] = None,
                   session_receipt: Optional[Path] = None) -> Dict[str, Any]:
    """注入配置后通过 COM 让 Photoshop 执行 JSX，返回 ps_units.json 内容。"""
    config: Dict[str, Any] = {"psdPath": psd_path.as_posix(), "outDir": render_dir.as_posix()}
    if only_orders:
        # 调试用：只渲染指定序号的单元，其余单元仍会出现在结果中但没有图片。
        config["onlyOrders"] = only_orders
    jsx = JSX_TEMPLATE.read_text(encoding="utf-8").replace("__CONFIG__", json.dumps(config, ensure_ascii=False))
    jsx_path = render_dir / "render_units.jsx"
    # ExtendScript 按 BOM 识别 UTF-8，图层名与路径含中文时必须带 BOM。
    jsx_path.write_text(jsx, encoding="utf-8-sig")
    session = PhotoshopSession(session_receipt)
    try:
        app = session.acquire()
        # A pre-existing Photoshop instance must never be quit/restarted on error.
        status = app.DoJavaScriptFile(str(jsx_path))
        units_path = render_dir / "ps_units.json"
        if not units_path.exists():
            raise RuntimeError(f"Photoshop 未生成 ps_units.json：{status}")
        result = json.loads(units_path.read_text(encoding="utf-8"))
        return result
    finally:
        # A deferred session is released by Relay's bounded cleanup process on
        # success, failure and cancellation. Never block this renderer on Quit.
        if session_receipt is None:
            cleanup = session.release()
            if cleanup.get("startedByImport") and cleanup.get("action") not in {"closed", "already-closed"}:
                print("[WARN] Photoshop automatic exit: " + json.dumps(cleanup, ensure_ascii=False), file=sys.stderr)


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


def _figma_local_fonts() -> Dict[str, Dict[str, str]]:
    """从 Figma 字体服务读取本机字体：PostScript 名 -> Figma 使用的 family/style。不可用时返回空表。"""
    import urllib.request

    request = urllib.request.Request(FIGMA_FONT_AGENT_URL, headers={"Origin": "https://www.figma.com"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return {}
    fonts: Dict[str, Dict[str, str]] = {}
    for entries in (data.get("fontFiles") or {}).values():
        for entry in entries:
            postscript = str(entry.get("postscript") or "")
            if postscript and entry.get("family"):
                fonts[postscript.lower()] = {"family": str(entry["family"]), "style": str(entry.get("style") or "Regular")}
    return fonts


def _psd_font_runs(psd_path: Path, layer_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    """读取文字图层的字体分段：返回 layerId -> [{start, end, postscript, text}]，只保留混用多种字体的图层。"""
    if not layer_ids:
        return {}
    from psd_tools import PSDImage  # 只有存在文字单元时才需要。

    wanted = set(layer_ids)
    runs_by_id: Dict[int, List[Dict[str, Any]]] = {}
    for layer in PSDImage.open(psd_path).descendants():
        if layer.layer_id not in wanted or layer.kind != "type":
            continue
        try:
            # psd_tools 的描述符字符串 str() 后带引号，去掉后才是 PostScript 名。
            font_set = [str(getattr(font["Name"], "value", font["Name"])).strip("'\"") for font in layer.resource_dict["FontSet"]]
            style_run = layer.engine_dict["StyleRun"]
            lengths = [int(n) for n in style_run["RunLengthArray"]]
            sheets = [run["StyleSheet"]["StyleSheetData"] for run in style_run["RunArray"]]
        except (KeyError, TypeError, IndexError):
            continue
        text = str(layer.text or "")
        runs: List[Dict[str, Any]] = []
        position = 0
        for length, sheet in zip(lengths, sheets):
            font_index = sheet.get("Font")
            postscript = font_set[int(font_index)] if font_index is not None and int(font_index) < len(font_set) else ""
            if runs and runs[-1]["postscript"] == postscript:
                runs[-1]["end"] = position + length
            else:
                runs.append({"start": position, "end": position + length, "postscript": postscript})
            position += length
        if len({run["postscript"] for run in runs}) > 1:
            for run in runs:
                run["text"] = text[run["start"]:run["end"]]
            runs_by_id[layer.layer_id] = runs
    return runs_by_id


def _attach_font_runs(entry: Dict[str, Any], runs: List[Dict[str, Any]], fonts: Dict[str, Dict[str, str]],
                      warnings: List[str]) -> None:
    """把 PSD 字体分段转换为插件的 fontRuns；字符序列与清单不一致时不写入。"""
    chars = str(entry.get("chars") or "")
    psd_text = "".join(run["text"] for run in runs)
    # Photoshop 文字以 \r 分段并以 \r 结尾，清单文字用 \n 分行且去掉末尾换行。
    if psd_text.replace("\r", "\n").rstrip("\n") != chars:
        warnings.append(f"{entry.get('name')}: PSD 分段文字与清单不一致，未设置分段字体")
        return
    font_runs = []
    for run in runs:
        end = min(run["end"], len(chars))
        if end <= run["start"]:
            continue
        candidates = []
        resolved = fonts.get(str(run["postscript"]).lower())
        if resolved:
            candidates.append(resolved)
        if CJK_PATTERN.search(run["text"]):
            candidates.extend(CJK_FONT_FALLBACK)
        if not candidates:
            warnings.append(f"{entry.get('name')}: 本机未安装字体 {run['postscript']}，该段沿用整段字体")
            continue
        font_runs.append({"start": run["start"], "end": end, "postscript": run["postscript"], "fontFallback": candidates})
    if font_runs:
        entry["fontRuns"] = font_runs


def build_manifest(psd_path: Path, out_dir: Path, base_manifest: Optional[Path],
                   only_orders: Optional[List[int]] = None,
                   session_receipt: Optional[Path] = None) -> Dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    render_dir = out_dir / "ps_render"
    render_dir.mkdir(exist_ok=True)
    base = _ensure_base_manifest(psd_path, base_manifest, out_dir)
    base_by_id = {int(layer["layerId"]): layer for layer in base.get("layers", []) if layer.get("layerId") is not None}
    ps = _run_photoshop(psd_path, render_dir, only_orders, session_receipt=session_receipt)
    text_ids = [int(unit["layerId"]) for unit in ps["units"] if unit["kind"] == "text"]
    font_runs = _psd_font_runs(psd_path, text_ids)
    local_fonts = _figma_local_fonts() if font_runs else {}

    layers: List[Dict[str, Any]] = []
    rendered_image_ids = set()
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
            # 普通原生文字：插件按自动宽高 + 自动行高创建，导入后由 align_psd_text_to_reference 按
            # Photoshop 合成图校正位置；旧式固定尺寸文字会被导入验收记为裁切风险而判定失败。
            entry["textRole"] = "ordinary"
            if unit.get("compositeLayerId") in rendered_image_ids:
                entry["visible"] = False
                source_state = entry.get("sourceState")
                if isinstance(source_state, dict):
                    display = dict(source_state.get("display") or {})
                    display["visible"] = False
                    entry["sourceState"] = {**source_state, "display": display}
            if layer_id in font_runs:
                _attach_font_runs(entry, font_runs[layer_id], local_fonts, warnings)
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
        rendered_image_ids.add(layer_id)

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
    parser.add_argument("--session-receipt", type=Path, default=None,
                        help="把 Photoshop 启动归属记录到此文件，由 Relay 在 Figma 导入结束后清理。")
    args = parser.parse_args()
    manifest = build_manifest(args.psd.resolve(), args.out.resolve(), args.base_manifest, args.only,
                              session_receipt=args.session_receipt)
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
