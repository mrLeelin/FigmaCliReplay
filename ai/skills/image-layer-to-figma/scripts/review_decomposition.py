#!/usr/bin/env python3
"""拆层结果一次性审核：合成、并排对比、图层总览、差异区域与“背景残留”定位。

只读离线脚本。输入 DXX 原始 manifest（dxx/manifest.json）或本地修补后的导入 manifest
（含 layers[].x/y/w/h/path），输出：
- composite.png：按层级合成结果
- side-by-side.png：原图 | 合成 | 差异热图（缩小一半）
- contact-sheet.png：每层缩略图（棋盘格底，标 idx 与名称）
- review.json：整体差异、差异区域列表；每个区域标出该处最上层可见的图层
  （exposedLayer 为底图时，通常是前景几何被修正/偏短后露出的底图残留，或前景缺失）
"""
from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

TILE = 8            # 差异区域检测的网格尺寸（像素）
STRONG_DELTA = 48   # 单像素 RGB 最大通道差超过该值视为明显差异（0–255）
TILE_RATIO = 0.15   # 网格内明显差异像素占比超过该值则标记
MIN_REGION_PIXELS = 40
SIGNIFICANT_PIXELS = 500  # 明显差异像素达到该数量的区域才计入摘要，其余多为模型重绘的细小偏差


def load_layers(manifest_path: Path):
    """统一两种 manifest 格式，返回 (画布尺寸, 自下而上的图层列表)。"""
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    base = manifest_path.parent
    layers = []
    if "items" in data:
        size = (int(data["documentWidth"]), int(data["documentHeight"]))
        for item in sorted(data["items"], key=lambda row: row["zIndex"]):
            place = item["placement"]
            layers.append({"idx": item["zIndex"], "name": item.get("name") or item["file"],
                           "path": base / "layers" / item["file"], "visible": item.get("visible", True),
                           "opacity": float(item.get("opacity", 100)) / 100.0,
                           "box": (place["left"], place["top"], place["width"], place["height"])})
    else:
        size = (int(data["canvas"]["width"]), int(data["canvas"]["height"]))
        for layer in sorted(data["layers"], key=lambda row: row["idx"]):
            if layer.get("mode", "image") != "image" or not layer.get("path"):
                continue  # 原生文字层没有位图，审核只看美术
            layers.append({"idx": layer["idx"], "name": layer["name"], "path": base / layer["path"],
                           "visible": layer.get("visible", True), "opacity": float(layer.get("opacity", 1.0)),
                           "box": (layer["x"], layer["y"], layer["w"], layer["h"])})
    return size, layers


def placed(layer, size):
    """把图层按文档坐标放到整张画布上，返回 RGBA 数组。"""
    x, y, w, h = layer["box"]
    image = Image.open(layer["path"]).convert("RGBA").resize((max(1, round(w)), max(1, round(h))), Image.LANCZOS)
    if layer["opacity"] < 1:
        alpha = np.asarray(image.getchannel("A"), dtype=np.float32) * layer["opacity"]
        image.putalpha(Image.fromarray(alpha.astype(np.uint8)))
    canvas = Image.new("RGBA", size)
    canvas.alpha_composite(image, (round(x), round(y)))
    return canvas


def find_regions(mask: np.ndarray):
    """在网格上做 4 邻接连通，返回差异区域的像素级包围盒与明显差异像素数。"""
    rows, cols = -(-mask.shape[0] // TILE), -(-mask.shape[1] // TILE)
    padded = np.zeros((rows * TILE, cols * TILE), dtype=bool)
    padded[:mask.shape[0], :mask.shape[1]] = mask
    counts = padded.reshape(rows, TILE, cols, TILE).sum(axis=(1, 3))
    flagged = counts >= TILE * TILE * TILE_RATIO
    seen = np.zeros_like(flagged)
    regions = []
    for row, col in zip(*np.nonzero(flagged)):
        if seen[row, col]:
            continue
        queue, tiles = deque([(row, col)]), []
        seen[row, col] = True
        while queue:
            r, c = queue.popleft()
            tiles.append((r, c))
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < rows and 0 <= nc < cols and flagged[nr, nc] and not seen[nr, nc]:
                    seen[nr, nc] = True
                    queue.append((nr, nc))
        pixels = int(sum(counts[r, c] for r, c in tiles))
        if pixels < MIN_REGION_PIXELS:
            continue
        r0, r1 = min(t[0] for t in tiles), max(t[0] for t in tiles)
        c0, c1 = min(t[1] for t in tiles), max(t[1] for t in tiles)
        regions.append({"bbox": [int(c0 * TILE), int(r0 * TILE), int(min(mask.shape[1], (c1 + 1) * TILE)),
                                 int(min(mask.shape[0], (r1 + 1) * TILE))], "strongPixels": pixels})
    return sorted(regions, key=lambda row: row["strongPixels"], reverse=True)


def contact_sheet(layers, out: Path):
    """生成图层总览：每格一层，棋盘格底便于看透明边缘。"""
    cell, label = 180, 28
    cols = 6
    rows = -(-len(layers) // cols)
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label)), "white")
    draw = ImageDraw.Draw(sheet)
    checker = Image.new("RGB", (cell, cell), (235, 235, 235))
    cd = ImageDraw.Draw(checker)
    for y in range(0, cell, 12):
        for x in range(0, cell, 12):
            if (x // 12 + y // 12) % 2:
                cd.rectangle((x, y, x + 11, y + 11), fill=(200, 200, 200))
    for index, layer in enumerate(layers):
        image = Image.open(layer["path"]).convert("RGBA")
        image.thumbnail((cell - 8, cell - 8))
        tile = checker.copy().convert("RGBA")
        tile.alpha_composite(image, ((cell - image.width) // 2, (cell - image.height) // 2))
        x, y = (index % cols) * cell, (index // cols) * (cell + label)
        sheet.paste(tile.convert("RGB"), (x, y))
        draw.text((x + 4, y + cell + 4), f"{layer['idx']} {layer['name']}"[:30], fill="black")
    sheet.save(out)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path, help="原图 source.png")
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    size, layers = load_layers(args.manifest)
    source = Image.open(args.source).convert("RGBA")
    if source.size != size:
        source = source.resize(size, Image.LANCZOS)
    composite = Image.new("RGBA", size)
    # 记录每个像素最上层可见（alpha>128）的图层序号，用于判断差异区域露出的是哪一层
    top_layer = np.full((size[1], size[0]), -1, dtype=np.int32)
    for order, layer in enumerate(layers):
        if not layer["visible"]:
            continue
        canvas = placed(layer, size)
        composite.alpha_composite(canvas)
        top_layer[np.asarray(canvas.getchannel("A")) > 128] = order
    composite.save(args.out_dir / "composite.png")

    src = np.asarray(source.convert("RGB"), dtype=np.int16)
    comp = np.asarray(composite.convert("RGB"), dtype=np.int16)
    delta = np.abs(src - comp).max(axis=2)
    regions = find_regions(delta > STRONG_DELTA)
    for region in regions:
        x0, y0, x1, y1 = region["bbox"]
        window = top_layer[y0:y1, x0:x1][delta[y0:y1, x0:x1] > STRONG_DELTA]
        values, counts = np.unique(window, return_counts=True)
        order = int(values[np.argmax(counts)])
        region["exposedLayer"] = None if order < 0 else {"idx": layers[order]["idx"], "name": layers[order]["name"]}
        region["exposesBase"] = order == 0
        region["meanDelta"] = round(float(delta[y0:y1, x0:x1].mean()), 2)

    heat = Image.fromarray(np.clip(delta * 3, 0, 255).astype(np.uint8)).convert("RGB")
    draw = ImageDraw.Draw(heat)
    for number, region in enumerate(regions[:30], 1):
        draw.rectangle(region["bbox"], outline=(255, 64, 64), width=3)
        draw.text((region["bbox"][0] + 4, region["bbox"][1] + 4), str(number), fill=(255, 255, 0))
    width, height = size
    side = Image.new("RGB", (width * 3 + 20, height), "white")
    side.paste(source.convert("RGB"), (0, 0))
    side.paste(composite.convert("RGB"), (width + 10, 0))
    side.paste(heat, (width * 2 + 20, 0))
    side.resize((side.width // 2, side.height // 2), Image.LANCZOS).save(args.out_dir / "side-by-side.png")
    contact_sheet(layers, args.out_dir / "contact-sheet.png")

    report = {"manifest": str(args.manifest), "canvas": list(size), "layerCount": len(layers),
              "meanAbsDelta": round(float(np.abs(src - comp).mean()), 3),
              "strongDeltaThreshold": STRONG_DELTA, "regionCount": len(regions),
              "significantRegionCount": sum(region["strongPixels"] >= SIGNIFICANT_PIXELS for region in regions),
              "baseExposedSignificantCount": sum(region["exposesBase"] and region["strongPixels"] >= SIGNIFICANT_PIXELS
                                                 for region in regions),
              "regions": regions[:30]}
    (args.out_dir / "review.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("layerCount", "meanAbsDelta", "significantRegionCount",
                                                         "baseExposedSignificantCount")}
                     | {"topRegions": [{"bbox": region["bbox"], "strongPixels": region["strongPixels"],
                                        "exposedLayer": region["exposedLayer"]}
                                       for region in regions[:8]]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
