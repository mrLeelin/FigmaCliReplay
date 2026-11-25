"""导入后把 Figma 原生文字按 Photoshop 合成图逐像素对齐。

Figma 与 Photoshop 的字体度量不同。本脚本通过截图中的文字填充和描边像素匹配字形，
再用 FIGMA_HIERARCHY_SET_NODE_POSITIONS 校正位置。可匹配的字形不足时保留原位置。

用法：
  python align_psd_text_to_reference.py <rootNodeId> <manifest_summary.json> <reference.png>
      --session-id <id> [--search 12] [--apply]
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any, Dict, List

from PIL import Image, ImageChops

RELAY_ROOT = Path(__file__).resolve().parents[4]
CLI = RELAY_ROOT / "dist" / "cli.js"
BOX_PADDING = 8  # 文字包围盒外扩，覆盖外描边。
CHANNEL_MATCH = [255 if error <= 2 else 0 for error in range(256)]


def run_cli(job_type: str, payload: Dict[str, Any], session_id: str, relay_url: str = "") -> Dict[str, Any]:
    args = ["node", str(CLI), "figma-command", "--job-type", job_type,
            "--payload", json.dumps(payload, ensure_ascii=False), "--session-id", session_id]
    if relay_url:
        args.extend(["--url", relay_url])
    proc = subprocess.run(
        args,
        capture_output=True, text=True, encoding="utf-8", timeout=300)
    lines = [line for line in proc.stdout.splitlines() if line.startswith("{") and '"ok"' in line]
    if not lines:
        raise RuntimeError(f"{job_type} 无响应：{proc.stderr[-500:]}")
    data = json.loads(lines[-1])
    if not data.get("ok"):
        raise RuntimeError(f"{job_type} 失败：{lines[-1][:500]}")
    return data["result"]


def text_colors(layer: Dict[str, Any]) -> set[tuple[int, int, int]]:
    if layer.get("opacity", 255) not in (1, 255):
        return set()
    stroke = layer.get("stroke") or {}
    colors = []
    if stroke.get("enabled") and stroke.get("opacity", 1) == 1:
        colors.append(stroke)
    if not layer.get("fillGradient"):
        fills = layer.get("fillRuns") or [{"color": layer.get("fillColor")}]
        colors.extend(run["color"] for run in fills if run.get("color"))
    return {
        tuple(round(color[channel] * 255) for channel in "rgb")
        for color in colors
        if color.get("a", 1) == 1 and all(channel in color for channel in "rgb")
    }


def color_mask(image: Image.Image, colors: set[tuple[int, int, int]]) -> Image.Image:
    alpha = image.getchannel("A") if image.mode == "RGBA" else None
    image = image.convert("RGB")
    mask = Image.new("L", image.size)
    for color in colors:
        red, green, blue = ImageChops.difference(image, Image.new("RGB", image.size, color)).split()
        distance = ImageChops.lighter(ImageChops.lighter(red, green), blue)
        mask = ImageChops.lighter(mask, distance.point(CHANNEL_MATCH))
    if alpha is not None:
        mask = ImageChops.darker(mask, alpha.point(lambda value: 255 if value >= 254 else 0))
    return mask


def best_shift(figma: Image.Image, reference: Image.Image, box: tuple,
               search: int, colors: set[tuple[int, int, int]]) -> tuple[float, int, int]:
    """返回 (字形重合率, dx, dy)：Figma 中文字内容相对参照图的偏移。"""
    if not colors:
        return 0, 0, 0
    x, y, right, bottom = box
    x, y = max(x, 0), max(y, 0)
    right, bottom = min(right, reference.width), min(bottom, reference.height)
    if x >= right or y >= bottom:
        return 0, 0, 0
    target = color_mask(reference.crop((x, y, right, bottom)), colors)
    target_pixels = target.histogram()[255]
    if target_pixels < 16:
        return 0, 0, 0
    origin_x, origin_y = max(0, x - search), max(0, y - search)
    roi = (origin_x, origin_y, min(figma.width, right + search), min(figma.height, bottom + search))
    candidate = color_mask(figma.crop(roi), colors)
    left, top = x - origin_x, y - origin_y

    def score(dx: int, dy: int) -> float:
        shifted = candidate.crop((left + dx, top + dy, right - origin_x + dx, bottom - origin_y + dy))
        matched = ImageChops.darker(shifted, target).histogram()[255]
        return matched / (target_pixels + shifted.histogram()[255] - matched)

    baseline = score(0, 0)
    best = (baseline, 0, 0)
    for dy in range(-search, search + 1):
        for dx in range(-search, search + 1):
            overlap = score(dx, dy)
            if overlap > best[0]:
                best = (overlap, dx, dy)
    if best[0] < 0.55 or best[0] - baseline < 0.02:
        return baseline, 0, 0
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description="按 Photoshop 合成图校正 Figma 文字位置。")
    parser.add_argument("root_node_id")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--relay-url", default="")
    parser.add_argument("--search", type=int, default=12, help="单轴最大搜索像素。")
    parser.add_argument("--apply", action="store_true", help="写回位置；缺省只报告。")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    layers = {int(layer["idx"]): layer for layer in manifest["layers"]}
    layer_ids = {str(layer["layerId"]): layer for layer in manifest["layers"] if layer.get("layerId")}
    shot = run_cli("FIGMA_EXPORT_NODE_SCREENSHOT", {"target": {"nodeId": args.root_node_id}},
                   args.session_id, args.relay_url)
    figma = Image.open(shot["screenshot"]["path"]).convert("RGBA")
    reference = Image.open(args.reference).convert("RGBA")
    if figma.size != reference.size:
        raise RuntimeError(f"截图尺寸 {figma.size} 与参照图 {reference.size} 不一致")
    root = run_cli("FIGMA_INSPECT_NODES", {"nodeIds": [args.root_node_id], "depth": 1, "includeText": False},
                   args.session_id, args.relay_url)["nodes"][0]

    positions: List[Dict[str, Any]] = []
    report: List[Dict[str, Any]] = []
    for node in root.get("children", []):
        if node["type"] != "TEXT" or node.get("visible") is False:
            continue
        prefix = node["name"].split("_", 1)[0]
        layer = layer_ids.get(str(node["psdLayerId"])) if node.get("psdLayerId") else (
            layers.get(int(prefix)) if prefix.isdigit() else None
        )
        if not layer:
            continue
        box = (layer["x"] - BOX_PADDING, layer["y"] - BOX_PADDING,
               layer["x"] + layer["w"] + BOX_PADDING, layer["y"] + layer["h"] + BOX_PADDING)
        overlap, dx, dy = best_shift(figma, reference, box, args.search, text_colors(layer))
        report.append({"nodeId": node["id"], "idx": layer["idx"], "shift": [dx, dy],
                       "glyphOverlap": round(overlap, 3)})
        if dx or dy:
            positions.append({"nodeId": node["id"], "x": node["x"] - dx, "y": node["y"] - dy})

    applied = None
    if args.apply and positions:
        applied = run_cli(
            "FIGMA_HIERARCHY_SET_NODE_POSITIONS",
            {"plan": {"positions": positions}, "options": {"psdTextRootId": args.root_node_id}},
            args.session_id, args.relay_url,
        )
        if not applied.get("allPass"):
            raise RuntimeError(f"Figma did not apply all PSD text positions: {applied.get('errors', [])}")
    print(json.dumps({"texts": report, "moves": len(positions),
                      "applied": bool(applied and applied.get("allPass"))}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
