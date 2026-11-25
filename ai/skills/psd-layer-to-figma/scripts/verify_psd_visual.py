"""Compare the final Figma render with the PSD composition in text regions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil

from PIL import Image, ImageChops

from align_psd_text_to_reference import run_cli


def flatten(path: Path) -> Image.Image:
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(background, rgba).convert("RGB")


def regions(manifest: dict, size: tuple[int, int]):
    layers = manifest.get("layers", [])
    by_id = {str(layer["layerId"]): layer for layer in layers if layer.get("layerId") is not None}
    group_ids = set()
    for text in layers:
        if text.get("mode") != "text":
            continue
        group_id = str(text.get("compositeLayerId") or "")
        group = by_id.get(group_id)
        if group is not None and group.get("visible", True):
            if group_id in group_ids:
                continue
            group_ids.add(group_id)
            layer = group
        elif text.get("visible", True):
            layer = text
        else:
            continue
        x, y = int(layer["x"]), int(layer["y"])
        w, h = int(layer["w"]), int(layer["h"])
        box = (max(0, x - 12), max(0, y - 12), min(size[0], x + w + 12), min(size[1], y + h + 12))
        if box[0] < box[2] and box[1] < box[3]:
            yield layer, box, group is layer


def compare(manifest: dict, reference_path: Path, screenshot_path: Path, output: Path) -> dict:
    reference, screenshot = flatten(reference_path), flatten(screenshot_path)
    if reference.size != screenshot.size:
        raise ValueError(f"Reference size {reference.size} differs from final Figma size {screenshot.size}")
    output.mkdir(parents=True, exist_ok=True)
    final_screenshot = output / "final.png"
    if screenshot_path.resolve() != final_screenshot.resolve():
        shutil.copyfile(screenshot_path, final_screenshot)
    results = []
    for layer, box, composite in regions(manifest, reference.size):
        expected, actual = reference.crop(box), screenshot.crop(box)
        difference = ImageChops.difference(expected, actual)
        pixels = difference.width * difference.height
        histogram = difference.histogram()
        mean_error = sum((index % 256) * count for index, count in enumerate(histogram)) / (3 * pixels)
        red, green, blue = difference.split()
        largest = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        changed = sum(largest.histogram()[25:]) / pixels
        # Raster composites should closely match Photoshop. Native text tolerates
        # differences in font hinting and antialiasing while catching lost glyphs and color.
        passed = mean_error <= (3 if composite else 10) and changed <= (0.08 if composite else 0.22)
        item = {
            "layerId": layer.get("layerId"), "name": layer.get("name"), "bounds": box,
            "kind": "composite" if composite else "text",
            "status": "passed" if passed else "difference",
            "meanChannelError": round(mean_error, 3), "changedPixelRatio": round(changed, 5),
        }
        if not passed:
            crop = output / f"region-{len(results) + 1}.png"
            preview = Image.new("RGB", (difference.width, difference.height * 3))
            for index, image in enumerate((expected, actual, difference)):
                preview.paste(image, (0, index * difference.height))
            preview.save(crop)
            item["comparisonPath"] = crop.as_posix()
        results.append(item)
    differences = sum(item["status"] == "difference" for item in results)
    return {
        "status": "differences" if differences else "passed" if results else "not-applicable",
        "screenshotPath": final_screenshot.as_posix(),
        "referencePath": reference_path.as_posix(),
        "differenceCount": differences,
        "regions": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--root-node-id")
    parser.add_argument("--session-id")
    parser.add_argument("--relay-url", default="")
    args = parser.parse_args()
    screenshot = args.screenshot
    if screenshot is None:
        if not args.root_node_id or not args.session_id:
            parser.error("--screenshot or both --root-node-id and --session-id are required")
        result = run_cli("FIGMA_EXPORT_NODE_SCREENSHOT", {"target": {"nodeId": args.root_node_id}},
                         args.session_id, args.relay_url)
        screenshot = Path(result["screenshot"]["path"])
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    report = compare(manifest, args.reference, screenshot, args.out)
    report_path = args.out / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {key: value for key, value in report.items() if key != "regions"}
    summary["regionCount"] = len(report["regions"])
    print(json.dumps({**summary, "reportPath": report_path.as_posix()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
