"""Render PSD visual units with psd-tools, without Photoshop or COM.

The output contract matches photoshop_render_units.py. Ordinary text remains
editable in Figma; image opacity, masks and clipping are baked into PNG pixels.
"""

from __future__ import annotations

import argparse
import copy
from dataclasses import dataclass
import json
import logging
from pathlib import Path
import sys
from typing import Any, Dict, Iterator, List, Optional, Tuple

from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import AdjustmentLayer, Artboard, Layer
from psd_tools.constants import BlendMode

# Relay launches scripts with python -I; explicitly expose sibling data helpers.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_psd_layers import _generate_summary, _infer_constraints, _normalize_layer_semantics
from photoshop_render_units import (
    FIGMA_IMAGE_LIMIT,
    _attach_font_runs,
    _ensure_base_manifest,
    _figma_local_fonts,
    _image_entry,
    _psd_font_runs,
    _safe_file_name,
)

Rect = Tuple[int, int, int, int]
# The psd-tools compositor currently implements these layer effects. Ordinary
# text effects use the existing native Figma text data instead of this renderer.
SUPPORTED_IMAGE_EFFECTS = {"ColorOverlay", "GradientOverlay", "PatternOverlay", "Stroke"}


@dataclass
class RenderUnit:
    layer: Layer
    layer_id: int
    layer_ids: List[int]
    path: List[str]
    clip: Rect
    native_text: bool = False
    hide_texts: Tuple[int, ...] = ()


def _intersection(a: Rect, b: Rect) -> Optional[Rect]:
    result = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return result if result[2] > result[0] and result[3] > result[1] else None


def _blend_name(layer: Layer) -> str:
    words = layer.blend_mode.name.lower().split("_")
    return words[0] + "".join(word.title() for word in words[1:])


def _group_is_atomic(layer: Layer) -> bool:
    return (layer.has_mask() or layer.has_vector_mask() or layer.has_effects()
            or (not isinstance(layer, Artboard) and layer.blend_mode != BlendMode.PASS_THROUGH)
            or layer.opacity < 255
            or layer.fill_opacity < 255
            or any(isinstance(child, AdjustmentLayer) and child.is_visible() and not child.clipping
                   for child in layer))


def _native_texts(layer: Layer) -> Iterator[Layer]:
    if layer.is_group():
        for child in layer:
            if child.is_visible():
                yield from _native_texts(child)
    elif layer.kind == "type" and not layer.clipping and not layer.has_clip_layers(visible=True):
        yield layer


def _text_ancestor_opacity(layer: Layer, warnings: List[str]) -> float:
    opacity = 1.0
    parent = layer.parent
    while parent is not None and isinstance(parent, Layer):
        opacity *= parent.opacity / 255.0
        if parent.has_mask() or parent.has_vector_mask() or parent.has_effects():
            warning = f"{layer.name}: editable text cannot reproduce the composited mask/effects of {parent.name}"
            if warning not in warnings:
                warnings.append(warning)
        parent = parent.parent
    return opacity


def collect_units(psd: PSDImage, warnings: List[str]) -> List[RenderUnit]:
    """Collect bottom-to-top units, respecting ancestor visibility and artboards."""
    canvas: Rect = (0, 0, psd.width, psd.height)
    ids: Dict[int, int] = {}
    for index, layer in enumerate(psd.descendants(), start=1):
        actual = layer.layer_id
        ids[id(layer)] = int(actual) if actual is not None and actual >= 0 else -index
        if actual is None or actual < 0:
            warnings.append(f"{layer.name}: PSD has no stable layer ID; using a document-order ID")

    units: List[RenderUnit] = []

    def walk(container: Any, clip: Rect, path: List[str]) -> None:
        for layer in container:
            # psd-tools composites clipping siblings through their base layer.
            if not layer.is_visible() or layer.clipping:
                continue
            if isinstance(layer, AdjustmentLayer):
                warnings.append(f"{layer.name}: standalone document adjustment cannot be exported as an independent image")
                continue
            unit_path = path + [str(layer.name)]
            clipped = list(layer.clip_layers)
            chain_ids = [ids[id(item)] for item in [layer, *clipped]]
            layer_clip = clip
            if isinstance(layer, Artboard):
                overlap = _intersection(clip, tuple(int(value) for value in layer.bbox))
                if overlap is None:
                    continue
                layer_clip = overlap
            if layer.is_group() and not _group_is_atomic(layer) and not clipped:
                walk(layer, layer_clip, unit_path)
                continue
            native_text = layer.kind == "type" and not clipped
            texts = list(_native_texts(layer)) if layer.is_group() else []
            units.append(RenderUnit(layer, ids[id(layer)], chain_ids, unit_path, layer_clip,
                                    native_text=native_text,
                                    hide_texts=tuple(id(text) for text in texts)))
            for text in texts:
                # Native text is kept directly above the composited group image,
                # matching the Photoshop renderer's existing import contract.
                text_path = [str(text.name)]
                parent = text.parent
                while parent is not None and parent is not layer:
                    text_path.insert(0, str(parent.name))
                    parent = getattr(parent, "parent", None)
                units.append(RenderUnit(text, ids[id(text)], [ids[id(text)]],
                                        unit_path + text_path, layer_clip, native_text=True))

    walk(psd, canvas, [])
    return units


class _WarningCollector(logging.Handler):
    def __init__(self, warnings: List[str]) -> None:
        super().__init__(logging.WARNING)
        self.warnings = warnings

    def emit(self, record: logging.LogRecord) -> None:
        message = "psd-tools: " + record.getMessage()[:400]
        if message not in self.warnings and len(self.warnings) < 100:
            self.warnings.append(message)


def _effect_warnings(unit: RenderUnit) -> List[str]:
    result = []
    candidates = [unit.layer]
    if unit.layer.is_group():
        candidates.extend(unit.layer.descendants())
    candidates.extend(unit.layer.clip_layers)
    for layer in candidates:
        if not layer.is_visible() or id(layer) in unit.hide_texts:
            continue
        effects = layer.effects
        if not effects.enabled:
            continue
        for effect in effects:
            kind = type(effect).__name__
            if effect.enabled and kind not in SUPPORTED_IMAGE_EFFECTS:
                result.append(f"{layer.name}: psd-tools does not render {kind}; visual appearance may differ")
    return result


def build_manifest(psd_path: Path, out_dir: Path, base_manifest: Optional[Path] = None) -> Dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = _ensure_base_manifest(psd_path, base_manifest, out_dir)
    if "hasGroups" in base:
        base = _generate_summary(base)
    base_by_id = {int(layer["layerId"]): layer for layer in base.get("layers", [])
                  if layer.get("layerId") is not None}
    psd = PSDImage.open(psd_path)
    warnings: List[str] = []
    units = collect_units(psd, warnings)
    text_ids = [unit.layer_id for unit in units if unit.native_text]
    font_runs = _psd_font_runs(psd_path, text_ids)
    fonts = _figma_local_fonts() if font_runs else {}
    layers: List[Dict[str, Any]] = []
    logger = logging.getLogger("psd_tools")
    collector = _WarningCollector(warnings)
    logger.addHandler(collector)
    try:
        for unit in units:
            source = base_by_id.get(unit.layer_id)
            if unit.native_text:
                if source is None or source.get("mode") != "text":
                    raise RuntimeError(f"{unit.layer.name}: editable text metadata is missing from the base manifest")
                entry = copy.deepcopy(source)
                entry.pop("idx", None)
                entry["textRole"] = "ordinary"
                entry["renderSource"] = "psd-tools"
                ancestor_opacity = _text_ancestor_opacity(unit.layer, warnings)
                if ancestor_opacity != 1.0:
                    entry["opacity"] = round(float(entry.get("opacity", 255)) * ancestor_opacity)
                    display = (entry.get("sourceState") or {}).get("display")
                    if display is not None:
                        display["opacity"] = float(display.get("opacity", 1.0)) * ancestor_opacity
                if unit.layer_id in font_runs:
                    _attach_font_runs(entry, font_runs[unit.layer_id], fonts, warnings)
                layers.append(entry)
                continue

            for warning in _effect_warnings(unit):
                if warning not in warnings:
                    warnings.append(warning)
            hidden_texts = set(unit.hide_texts)
            # Keep document coordinates even for a small artboard viewport. The
            # compositor applies masks/clipping; reading topil() alone would not.
            rendered = unit.layer.composite(
                viewport=unit.clip, force=True, color=1.0, alpha=0.0,
                layer_filter=lambda layer: layer.is_visible() and id(layer) not in hidden_texts,
            )
            if rendered is None:
                continue
            try:
                rgba = rendered.convert("RGBA")
                try:
                    bounds = rgba.getchannel("A").getbbox()
                    if bounds is None:
                        continue
                    x, y = unit.clip[0] + bounds[0], unit.clip[1] + bounds[1]
                    with rgba.crop(bounds) as cropped:
                        w, h = cropped.size
                        png = out_dir / f"{len(layers) + 1:03d}_{_safe_file_name(str(unit.layer.name))}.png"
                        cropped.save(png, optimize=False, compress_level=3)
                finally:
                    rgba.close()
            finally:
                rendered.close()
            if max(w, h) > FIGMA_IMAGE_LIMIT:
                warnings.append(f"{unit.layer.name}: {w}x{h} exceeds Figma's {FIGMA_IMAGE_LIMIT}px image limit")
            constraints = (source or {}).get("constraints") or _infer_constraints(
                float(x), float(y), float(w), float(h), float(psd.width), float(psd.height))
            entry = _image_entry({"name": str(unit.layer.name), "layerId": unit.layer_id,
                                  "layerIds": unit.layer_ids, "path": unit.path,
                                  "blend": _blend_name(unit.layer)}, png, x, y, w, h, constraints)
            entry.update(_normalize_layer_semantics(str(unit.layer.name), "image"))
            entry["renderSource"] = "psd-tools"
            entry["path"] = png.as_posix()
            if unit.layer_id < 0:
                entry["sourceState"]["unsupported"].append("missing-layer-id")
            layers.append(entry)
    finally:
        logger.removeHandler(collector)
        collector.close()

    for index, layer in enumerate(layers, start=1):
        layer["idx"] = index
    text_layers = [layer for layer in layers if layer["mode"] == "text"]
    image_layers = [layer for layer in layers if layer["mode"] != "text"]
    manifest = {
        "canvas": {"width": psd.width, "height": psd.height}, "renderSource": "psd-tools",
        "layerCount": len(layers), "commonCount": 0, "nineSliceCount": 0,
        "textCount": len(text_layers), "imageCount": len(image_layers),
        "layers": layers, "commonLayers": [], "nineSliceLayers": [],
        "textLayers": text_layers, "imageLayers": image_layers,
        "warnings": warnings, "referencePath": "",
    }
    (out_dir / "manifest_summary.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Render PSD layers with psd-tools without Photoshop.")
    parser.add_argument("psd", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--base-manifest", type=Path, default=None)
    args = parser.parse_args()
    manifest = build_manifest(args.psd.resolve(), args.out.resolve(), args.base_manifest)
    print(json.dumps({"manifest": (args.out / "manifest_summary.json").resolve().as_posix(),
                      "renderSource": "psd-tools", "layerCount": manifest["layerCount"],
                      "textCount": manifest["textCount"], "imageCount": manifest["imageCount"],
                      "warnings": manifest["warnings"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
