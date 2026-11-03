#!/usr/bin/env python3
"""Compose explicit resource groups from an ordered raster import manifest.

Pillow is the only dependency. This utility performs no model or Relay calls.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import math
from pathlib import Path
import shutil
from typing import Any

from PIL import Image, ImageChops


def number(value: Any, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    value = float(value)
    if not math.isfinite(value) or (positive and value <= 0):
        raise ValueError(f"{label} must be {'positive and ' if positive else ''}finite")
    return value


def overlaps(a: dict, b: dict) -> bool:
    return (a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"]
            and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"])


def validate(manifest: dict, plan: dict, manifest_dir: Path,
             pixels_per_unit: float) -> tuple[list[dict], list[dict]]:
    """Validate the complete partition and conservative stacking safety first."""
    if not isinstance(manifest, dict) or not isinstance(plan, dict):
        raise ValueError("manifest and plan must be JSON objects")
    number(pixels_per_unit, "pixels_per_unit", positive=True)
    canvas = manifest.get("canvas", {})
    if not isinstance(canvas, dict):
        raise ValueError("manifest.canvas must be an object")
    for key in ("width", "height"):
        number(canvas.get(key), f"canvas.{key}", positive=True)
    layers = deepcopy(manifest.get("layers"))
    if not isinstance(layers, list) or not layers:
        raise ValueError("manifest.layers must be a nonempty list")
    by_idx = {}
    for ordinal, layer in enumerate(layers):
        if not isinstance(layer, dict):
            raise ValueError("Every manifest layer must be an object")
        idx = layer.get("idx")
        if isinstance(idx, bool) or not isinstance(idx, int) or idx in by_idx:
            raise ValueError(f"Invalid or duplicate layer idx: {idx!r}")
        by_idx[idx] = ordinal
        for key in ("x", "y", "w", "h"):
            number(layer.get(key), f"layer {idx}.{key}", positive=key in ("w", "h"))
        opacity = number(layer.get("opacity", 1), f"layer {idx}.opacity")
        if not 0 <= opacity <= 1:
            raise ValueError(f"layer {idx}.opacity must be between 0 and 1")
        if not isinstance(layer.get("visible", True), bool):
            raise ValueError(f"layer {idx}.visible must be boolean")
        if layer.get("mode", "image") != "image":
            raise ValueError(f"layer {idx} must be a raster image")
        raw_path = layer.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            raise ValueError(f"layer {idx}.path must name an image")
        path = Path(raw_path)
        layer["_path"] = path if path.is_absolute() else (manifest_dir / path).resolve()
        with Image.open(layer["_path"]) as image:
            image.load()
    if plan.get("granularity") != "resource":
        raise ValueError("plan.granularity must be resource")
    resources = deepcopy(plan.get("resources"))
    if not isinstance(resources, list) or not resources:
        raise ValueError("plan.resources must be a nonempty list")
    owners, ids = {}, set()
    for resource in resources:
        if not isinstance(resource, dict):
            raise ValueError("Every plan resource must be an object")
        resource_id = resource.get("id")
        if not isinstance(resource_id, str) or not resource_id.strip() or resource_id in ids:
            raise ValueError(f"Invalid or duplicate resource id: {resource_id!r}")
        ids.add(resource_id)
        if not isinstance(resource.get("name"), str) or not resource["name"].strip():
            raise ValueError(f"resource {resource_id} requires a name")
        if not isinstance(resource.get("reason"), str) or not resource["reason"].strip():
            raise ValueError(f"resource {resource_id} requires a semantic reason")
        members = resource.get("members")
        if not isinstance(members, list) or not members:
            raise ValueError(f"resource {resource_id} requires members")
        positions = []
        for idx in members:
            if isinstance(idx, bool) or not isinstance(idx, int) or idx not in by_idx:
                raise ValueError(f"Unknown member idx: {idx!r}")
            if idx in owners:
                raise ValueError(f"Duplicate ownership of layer {idx}")
            owners[idx] = resource_id
            positions.append(by_idx[idx])
        positions.sort()
        resource["_positions"] = positions
        anchor = resource.get("anchor", "last")
        if anchor not in ("first", "last"):
            raise ValueError(f"resource {resource_id}.anchor must be first or last")
        resource["anchor"] = anchor
        resource["_anchorOrdinal"] = positions[0] if anchor == "first" else positions[-1]
        visibility = {layers[p].get("visible", True) for p in positions}
        if len(visibility) != 1:
            raise ValueError(f"resource {resource_id} mixes hidden and visible layers")
        own = set(positions)
        for outside in range(positions[0], positions[-1] + 1):
            if outside in own:
                continue
            moved = [member for member in positions
                     if (member < outside if anchor == "last" else member > outside)]
            if any(overlaps(layers[member], layers[outside]) for member in moved):
                raise ValueError(f"resource {resource_id} crosses overlapping layer "
                                 f"{layers[outside]['idx']}; stacking would change")
    missing = set(by_idx) - set(owners)
    if missing:
        raise ValueError(f"Unassigned layer idx values: {sorted(missing)}")
    resources.sort(key=lambda resource: resource["_anchorOrdinal"])
    return layers, resources


def grid_box(layers: list[dict], ppu: float) -> tuple[int, int, int, int]:
    return (math.floor(min(layer["x"] for layer in layers) * ppu),
            math.floor(min(layer["y"] for layer in layers) * ppu),
            math.ceil(max(layer["x"] + layer["w"] for layer in layers) * ppu),
            math.ceil(max(layer["y"] + layer["h"] for layer in layers) * ppu))


def rasterize(layer: dict, bounds: tuple[int, int, int, int], ppu: float) -> Image.Image:
    """Sample a layer on the document's shared global grid, baking opacity."""
    left, top, right, bottom = bounds
    with Image.open(layer["_path"]) as original:
        original = original.convert("RGBA")
        sx = original.width / (layer["w"] * ppu)
        sy = original.height / (layer["h"] * ppu)
        sampled = original.transform(
            (right - left, bottom - top), Image.Transform.AFFINE,
            (sx, 0, (left / ppu - layer["x"]) * original.width / layer["w"],
             0, sy, (top / ppu - layer["y"]) * original.height / layer["h"]),
            Image.Resampling.BICUBIC)
    opacity = layer.get("opacity", 1)
    if opacity != 1:
        sampled.putalpha(sampled.getchannel("A").point(
            [round(alpha * opacity) for alpha in range(256)]))
    return sampled


def render(layers: list[dict], bounds: tuple[int, int, int, int], ppu: float,
           *, include_hidden: bool = False) -> Image.Image:
    left, top, right, bottom = bounds
    canvas = Image.new("RGBA", (right - left, bottom - top))
    for layer in layers:
        if not include_hidden and not layer.get("visible", True):
            continue
        layer_box = grid_box([layer], ppu)
        clipped = (max(left, layer_box[0]), max(top, layer_box[1]),
                   min(right, layer_box[2]), min(bottom, layer_box[3]))
        if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
            continue
        sampled = rasterize(layer, clipped, ppu)
        canvas.alpha_composite(sampled, (clipped[0] - left, clipped[1] - top))
    return canvas


def difference_stats(before: Image.Image, after: Image.Image) -> dict:
    difference = ImageChops.difference(before, after)
    histograms = difference.histogram()
    count = before.width * before.height
    channel_stats = []
    for channel in range(4):
        histogram = histograms[channel * 256:(channel + 1) * 256]
        channel_stats.append({
            "max": max((value for value, frequency in enumerate(histogram) if frequency), default=0),
            "mean": sum(value * frequency for value, frequency in enumerate(histogram)) / count,
        })
    return {"units": "8-bit RGBA channel values, 0..255", "channels": dict(zip("RGBA", channel_stats)),
            "max": max(stat["max"] for stat in channel_stats),
            "mean": sum(stat["mean"] for stat in channel_stats) / 4,
            "pixelsIdentical": before.tobytes() == after.tobytes()}


def compose(manifest_path: Path, plan_path: Path, out_dir: Path,
            pixels_per_unit: float = 2) -> dict:
    manifest_path, plan_path, out_dir = map(lambda p: Path(p).resolve(),
                                           (manifest_path, plan_path, out_dir))
    if out_dir.exists() and (not out_dir.is_dir() or any(out_dir.iterdir())):
        raise ValueError("Output directory must be absent or empty")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    layers, resources = validate(manifest, plan, manifest_path.parent, pixels_per_unit)
    ppu = float(pixels_per_unit)
    out_dir.mkdir(parents=True, exist_ok=True)
    output_layers, mapping = [], []
    for idx, resource in enumerate(resources):
        members = [layers[position] for position in resource["_positions"]]
        path = f"resource-{idx:03d}.png"
        name = resource["name"]
        if len(members) == 1:
            source = members[0]
            shutil.copyfile(source["_path"], out_dir / path)
            geometry = {key: source[key] for key in ("x", "y", "w", "h")}
            opacity = source.get("opacity", 1)
            operation = "copy-original"
        else:
            bounds = grid_box(members, ppu)
            merged = render(members, bounds, ppu, include_hidden=True)
            merged.save(out_dir / path)
            geometry = {"x": bounds[0] / ppu, "y": bounds[1] / ppu,
                        "w": merged.width / ppu, "h": merged.height / ppu}
            opacity, operation = 1, "alpha-composite"
        with Image.open(out_dir / path) as image:
            pixel_size = list(image.size)
        layer = {"idx": idx, "assetId": str(idx), "layerId": "resource:" + resource["id"],
                 "name": name, "rawPsdLayerName": name, "normalizedLayerName": name,
                 "mode": "image", "semanticMode": "image", "path": path, **geometry,
                 "opacity": opacity, "visible": members[0].get("visible", True),
                 "constraints": {"horizontal": "MIN", "vertical": "MIN"}}
        output_layers.append(layer)
        mapping.append({"id": resource["id"], "name": name, "group": resource.get("group"),
                        "reason": resource["reason"], "outputIdx": idx,
                        "anchor": resource["anchor"], "anchorSourceOrdinal": resource["_anchorOrdinal"],
                        "sourceMembersInStackingOrder": [member["idx"] for member in members],
                        "sourceOrdinals": resource["_positions"], "operation": operation,
                        "outputGeometry": geometry, "outputPixelSize": pixel_size,
                        "pixelsPerUnit": ppu if len(members) > 1 else None,
                        "sourceLayers": [{key: value for key, value in member.items() if key != "_path"}
                                         for member in members]})
    output_manifest = {key: deepcopy(value) for key, value in manifest.items() if key != "layers"}
    output_manifest.update({"granularity": "resource", "layers": output_layers})
    write_json(out_dir / "manifest.json", output_manifest)
    write_json(out_dir / "resource-map.json", {
        "sourceManifest": str(manifest_path), "plan": str(plan_path), "resources": mapping})
    sample_bounds = (0, 0, math.ceil(manifest["canvas"]["width"] * ppu),
                     math.ceil(manifest["canvas"]["height"] * ppu))
    before = render(layers, sample_bounds, ppu)
    output_for_render = [{**layer, "_path": out_dir / layer["path"]} for layer in output_layers]
    after = render(output_for_render, sample_bounds, ppu)
    before.save(out_dir / "before.png")
    after.save(out_dir / "after.png")
    verification = {"sourceLayers": len(layers), "outputResources": len(resources),
                    "allSourceLayersAssignedExactlyOnce": True,
                    "stackingSafety": "conservative-bounding-box-check-passed",
                    "pixelsPerUnit": ppu, "samplePixelSize": list(before.size),
                    "difference": difference_stats(before, after),
                    "scope": "Local Pillow sampling comparison; not a Figma renderer or source-fidelity proof."}
    write_json(out_dir / "verification.json", verification)
    return verification


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--pixels-per-unit", type=float, default=2)
    args = parser.parse_args()
    try:
        result = compose(args.manifest, args.plan, args.out_dir, args.pixels_per_unit)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(2, f"compose_resources: {error}\n")
    print(json.dumps({"outputDirectory": str(args.out_dir.resolve()),
                      "sourceLayers": result["sourceLayers"],
                      "outputResources": result["outputResources"],
                      "localDifference": result["difference"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
