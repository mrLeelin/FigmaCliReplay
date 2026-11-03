"""Prepare explicitly reviewed screenshot text for the existing Figma importer.

This module does not perform OCR, choose fonts, contact a provider, or write Figma.
The plan supplies the verified content and styling; resource names are not evidence.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
import shutil


class NativeTextError(ValueError):
    """The supplied text inventory cannot produce an editable-text delivery."""


def _number(value, label, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise NativeTextError(f"{label} must be a finite number")
    if positive and value <= 0:
        raise NativeTextError(f"{label} must be positive")
    return value


def _string(value, label):
    if not isinstance(value, str) or not value.strip():
        raise NativeTextError(f"{label} must be a nonempty string")
    return value


def _color(value, label):
    if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        channels = [int(value[i:i+2], 16) / 255 for i in (1, 3, 5)]
        return dict(zip(("r", "g", "b"), channels), hex=value.upper())
    if isinstance(value, dict):
        channels = [_number(value.get(k), f"{label}.{k}") for k in ("r", "g", "b")]
        if all(0 <= channel <= 1 for channel in channels):
            return dict(zip(("r", "g", "b"), channels),
                        hex="#" + "".join(f"{round(channel * 255):02X}" for channel in channels))
    raise NativeTextError(f"{label} must be #RRGGBB or r/g/b channels in 0..1")


def manifest_layers(manifest):
    if not isinstance(manifest, dict):
        raise NativeTextError("manifest must be an object")
    if isinstance(manifest.get("layers"), list):
        return manifest["layers"]
    return [layer for key in ("imageLayers", "textLayers", "commonLayers", "nineSliceLayers")
            for layer in manifest.get(key, [])]


def validate_native_text(manifest):
    """Fail before submission when declared ordinary text would remain a bitmap.

Unmarked legacy manifests keep their existing behavior. Classification comes
from a reviewed resource inventory, never a filename/character regex or OCR guess.
"""
    counts = {"nativeTextCount": 0, "decorativeRasterTextCount": 0}
    for layer in manifest_layers(manifest):
        if not isinstance(layer, dict):
            raise NativeTextError("every manifest layer must be an object")
        role = layer.get("textRole")
        if role is None:
            continue
        label = f"layer {layer.get('idx', layer.get('index', '?'))}"
        if role == "mixed":
            raise NativeTextError(f"{label}: separate ordinary text from artwork before import")
        if role == "decorative":
            _string(layer.get("rasterTextReason"), f"{label}.rasterTextReason")
            counts["decorativeRasterTextCount"] += 1
            continue
        if role != "ordinary":
            raise NativeTextError(f"{label}: unknown textRole {role!r}")
        if layer.get("mode", layer.get("semanticMode")) != "text":
            raise NativeTextError(f"{label}: ordinary text must use mode=text; run prepare_native_text.py")
        if layer.get("semanticMode", "text") != "text":
            raise NativeTextError(f"{label}: ordinary text semanticMode must be text")
        text = layer.get("text") if isinstance(layer.get("text"), dict) else {}
        _string(layer.get("chars", text.get("characters")), f"{label}.chars")
        _number(layer.get("effectiveFontSize", layer.get("fontSize", text.get("fontSize"))),
                f"{label}.fontSize", positive=True)
        figma_text = text.get("figma") if isinstance(text.get("figma"), dict) else {}
        # Match applyNestedManifestCompatibility/extractTextFontFallback exactly:
        # a top-level array wins, then nested Figma candidates, then text fallback.
        fonts = layer.get("fontFallback")
        if not isinstance(fonts, list):
            fonts = figma_text.get("fontFallbackCandidates")
            if not isinstance(fonts, list):
                fonts = text.get("fontFallback")
        if not isinstance(fonts, list) or not fonts:
            raise NativeTextError(f"{label}: supply an observed, loadable fontFallback")
        for font in fonts:
            if not isinstance(font, dict):
                raise NativeTextError(f"{label}: fontFallback entries must be objects")
            _string(font.get("family"), f"{label}.font.family")
            _string(font.get("style"), f"{label}.font.style")
        # The runtime consumes numeric channels, not a hex-only dictionary.
        fill = layer.get("fillColor", text.get("fillColor"))
        if not isinstance(fill, dict):
            raise NativeTextError(f"{label}: explicit normalized fillColor is required")
        _color(fill, f"{label}.fillColor")
        effects = text.get("effects") if isinstance(text.get("effects"), dict) else {}
        stroke = layer.get("stroke")
        if stroke is None:
            stroke = effects.get("stroke")
        if stroke is not None and not isinstance(stroke, dict):
            raise NativeTextError(f"{label}.stroke must be an object")
        if isinstance(stroke, dict) and stroke.get("enabled") is True:
            color = stroke.get("color") if isinstance(stroke.get("color"), dict) else {}
            channels = {key: stroke[key] if stroke.get(key) is not None else color.get(key)
                        for key in ("r", "g", "b")}
            _color(channels, f"{label}.stroke")
            _number(stroke.get("size"), f"{label}.stroke.size", positive=True)
        counts["nativeTextCount"] += 1
    return counts


def prepare_native_text(manifest_path, plan_path, out_dir):
    """Compile reviewed layer IDs into a mixed raster/native-text import manifest."""
    manifest_path, plan_path, out_dir = [Path(p).resolve() for p in (manifest_path, plan_path, out_dir)]
    if out_dir.exists() and (not out_dir.is_dir() or any(out_dir.iterdir())):
        raise NativeTextError("output directory must be absent or empty")
    source_bytes, plan_bytes = manifest_path.read_bytes(), plan_path.read_bytes()
    source = json.loads(source_bytes.decode("utf-8-sig"))
    plan = json.loads(plan_bytes.decode("utf-8-sig"))
    if not isinstance(plan, dict) or plan.get("schemaVersion") != 1 or not isinstance(plan.get("layers"), list):
        raise NativeTextError("plan requires schemaVersion=1 and a layers array")
    layers = deepcopy(manifest_layers(source))
    if not layers:
        raise NativeTextError("manifest must contain layers")
    canvas = source.get("canvas", {})
    if not isinstance(canvas, dict):
        raise NativeTextError("manifest.canvas must be an object")
    for key in ("width", "height"):
        _number(canvas.get(key), f"canvas.{key}", positive=True)
    by_idx = {}
    for layer in layers:
        if not isinstance(layer, dict):
            raise NativeTextError("every layer must be an object")
        idx = layer.get("idx", layer.get("index"))
        if isinstance(idx, bool) or not isinstance(idx, int) or idx in by_idx:
            raise NativeTextError(f"invalid or duplicate layer index: {idx!r}")
        by_idx[idx] = layer
    seen, mappings = set(), []
    for entry in plan["layers"]:
        if not isinstance(entry, dict):
            raise NativeTextError("every text plan entry must be an object")
        idx = entry.get("sourceIdx")
        if isinstance(idx, bool) or not isinstance(idx, int) or idx not in by_idx or idx in seen:
            raise NativeTextError(f"unknown or duplicate sourceIdx: {idx!r}")
        seen.add(idx)
        layer = by_idx[idx]
        role = entry.get("classification")
        if role == "mixed" or layer.get("textRole") == "mixed":
            raise NativeTextError(f"layer {idx}: separate ordinary text and artwork first")
        if role not in ("ordinary", "decorative"):
            raise NativeTextError(f"layer {idx}: classification must be ordinary or decorative")
        layer["textRole"] = role
        if role == "decorative":
            layer["rasterTextReason"] = _string(entry.get("reason"), f"layer {idx}.reason")
            mappings.append({"sourceIdx": idx, "classification": role, "reason": entry["reason"]})
            continue
        chars = _string(entry.get("characters"), f"layer {idx}.characters")
        font = entry.get("font")
        if not isinstance(font, dict):
            raise NativeTextError(f"layer {idx}: explicit observed font is required")
        font = {key: _string(font.get(key), f"layer {idx}.font.{key}") for key in ("family", "style")}
        size = _number(entry.get("fontSize"), f"layer {idx}.fontSize", positive=True)
        fill = _color(entry.get("fillColor"), f"layer {idx}.fillColor")
        stroke = {"enabled": False, "size": 0}
        if entry.get("stroke") is not None:
            value = entry["stroke"]
            if not isinstance(value, dict):
                raise NativeTextError(f"layer {idx}.stroke must be an object")
            stroke = {"enabled": True,
                      "size": _number(value.get("size"), f"layer {idx}.stroke.size", positive=True),
                      **_color(value.get("color"), f"layer {idx}.stroke.color")}
        bounds = entry.get("bounds", {k: layer.get(k) for k in ("x", "y", "w", "h")})
        if not isinstance(bounds, dict):
            raise NativeTextError(f"layer {idx}.bounds must be an object")
        geometry = {k: _number(bounds.get(k), f"layer {idx}.bounds.{k}", positive=k in ("w", "h"))
                    for k in ("x", "y", "w", "h")}
        raster_path = layer.pop("path", None)
        if raster_path:
            reference = (manifest_path.parent / raster_path).resolve()
            layer["rasterReference"] = {"path": str(reference), "referenceOnly": True}
            if reference.is_file():
                layer["rasterReference"]["sha256"] = hashlib.sha256(reference.read_bytes()).hexdigest()
        # Existing image source-state hashes describe the old bitmap, not this text.
        for key in ("sourceState", "sourceStateHash", "text", "rasterTextReason"):
            layer.pop(key, None)
        layer.update(mode="text", semanticMode="text", chars=chars, fontSize=size,
                     effectiveFontSize=size, fontFallback=[font], fillColor=fill, stroke=stroke,
                     leading=0, textAlign="CENTER", componentSearch={"strategy": "none"}, **geometry)
        layer["text"] = {"characters": chars, "fontFamily": font["family"], "fontSize": size,
                         "effectiveFontSize": size, "fillColor": fill, "lineHeightMode": "AUTO",
                         "figma": {"fontFallbackCandidates": [font]},
                         "effects": {"stroke": {"enabled": stroke["enabled"], "size": stroke["size"],
                                                 "color": {k: stroke.get(k, 0) for k in ("r", "g", "b")}}}}
        mappings.append({"sourceIdx": idx, "classification": role, "characters": chars, "font": font,
                         "sourceBounds": geometry, "rasterReference": layer.get("rasterReference")})
    output = deepcopy(source)
    for bucket in ("imageLayers", "textLayers", "commonLayers", "nineSliceLayers", "__source_path"):
        output.pop(bucket, None)
    output.update(layers=layers, textPolicy="ordinary-native")
    counts = validate_native_text(output)
    copies = []
    for ordinal, layer in enumerate(layers):
        path = layer.get("path")
        if not path:
            if layer.get("mode", layer.get("semanticMode", "image")) != "text":
                raise NativeTextError(f"layer {layer.get('idx')}: raster resource path is required")
            continue
        path = (manifest_path.parent / path).resolve()
        if not path.is_file():
            raise NativeTextError(f"raster resource does not exist: {path}")
        name = f"asset-{ordinal:04d}{path.suffix.lower()}"
        copies.append((path, name))
        layer["path"] = name
    # All semantic/asset checks precede output creation. Source files are never mutated.
    out_dir.mkdir(parents=True, exist_ok=True)
    for path, name in copies:
        shutil.copyfile(path, out_dir / name)
    report = {"status": "prepared", "sourceManifest": str(manifest_path),
              "sourceManifestSha256": hashlib.sha256(source_bytes).hexdigest(),
              "planSha256": hashlib.sha256(plan_bytes).hexdigest(), **counts,
              "layerCount": len(layers), "copiedRasterAssets": len(copies),
              "unclassifiedLayerCount": sum(layer.get("textRole") is None for layer in layers),
              "textMappings": mappings,
              "figmaWrites": 0, "liveVerificationRequired": True}
    for name, value in (("manifest.json", output), ("native-text-report.json", report)):
        (out_dir / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report
