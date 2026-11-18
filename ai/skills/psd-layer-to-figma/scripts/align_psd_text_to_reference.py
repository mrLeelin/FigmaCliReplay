"""导入后把 Figma 原生文字按 Photoshop 合成图逐像素对齐。

Figma 按 PSD 文字包围盒居中放置文字，但 Figma 与 Photoshop 的字体度量不同，
文字整体会偏 1~6px。本脚本导出根节点截图，在每个文字层附近搜索与参照图误差
最小的整像素偏移，并用 FIGMA_HIERARCHY_SET_NODE_POSITIONS 校正；参照图为
photoshop_render_units.py 输出的 reference.png（Photoshop 自身合成）。

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


def run_cli(job_type: str, payload: Dict[str, Any], session_id: str) -> Dict[str, Any]:
    proc = subprocess.run(
        ["node", str(CLI), "figma-command", "--job-type", job_type,
         "--payload", json.dumps(payload, ensure_ascii=False), "--session-id", session_id],
        capture_output=True, text=True, encoding="utf-8", timeout=300)
    lines = [line for line in proc.stdout.splitlines() if line.startswith("{") and '"ok"' in line]
    if not lines:
        raise RuntimeError(f"{job_type} 无响应：{proc.stderr[-500:]}")
    data = json.loads(lines[-1])
    if not data.get("ok"):
        raise RuntimeError(f"{job_type} 失败：{lines[-1][:500]}")
    return data["result"]


def flatten_gray(path: str) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.alpha_composite(image)
    return background.convert("L")


def abs_error(a: Image.Image, b: Image.Image) -> int:
    return sum(value * count for value, count in enumerate(ImageChops.difference(a, b).histogram()))


def best_shift(figma: Image.Image, reference: Image.Image, box: tuple, search: int) -> tuple:
    """返回 (误差, dx, dy)：Figma 中文字内容相对参照图的偏移。"""
    target = reference.crop(box)
    best = (abs_error(figma.crop(box), target), 0, 0)
    for dy in range(-search, search + 1):
        for dx in range(-search, search + 1):
            shifted = figma.crop((box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy))
            error = abs_error(shifted, target)
            if error < best[0]:
                best = (error, dx, dy)
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description="按 Photoshop 合成图校正 Figma 文字位置。")
    parser.add_argument("root_node_id")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--search", type=int, default=12, help="单轴最大搜索像素。")
    parser.add_argument("--apply", action="store_true", help="写回位置；缺省只报告。")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    layers = {int(layer["idx"]): layer for layer in manifest["layers"]}
    shot = run_cli("FIGMA_EXPORT_NODE_SCREENSHOT", {"target": {"nodeId": args.root_node_id}}, args.session_id)
    figma = flatten_gray(shot["screenshot"]["path"])
    reference = flatten_gray(str(args.reference))
    if figma.size != reference.size:
        raise RuntimeError(f"截图尺寸 {figma.size} 与参照图 {reference.size} 不一致")
    root = run_cli("FIGMA_INSPECT_NODES", {"nodeIds": [args.root_node_id], "depth": 1, "includeText": False},
                   args.session_id)["nodes"][0]

    positions: List[Dict[str, Any]] = []
    report: List[Dict[str, Any]] = []
    for node in root.get("children", []):
        if node["type"] != "TEXT" or node.get("visible") is False:
            continue
        prefix = node["name"].split("_", 1)[0]
        layer = layers.get(int(prefix)) if prefix.isdigit() else None
        if not layer:
            continue
        box = (layer["x"] - BOX_PADDING, layer["y"] - BOX_PADDING,
               layer["x"] + layer["w"] + BOX_PADDING, layer["y"] + layer["h"] + BOX_PADDING)
        error, dx, dy = best_shift(figma, reference, box, args.search)
        area = (box[2] - box[0]) * (box[3] - box[1])
        report.append({"nodeId": node["id"], "idx": layer["idx"], "shift": [dx, dy],
                       "meanAbsAfter": round(error / area, 2)})
        if dx or dy:
            positions.append({"nodeId": node["id"], "x": node["x"] - dx, "y": node["y"] - dy})

    applied = None
    if args.apply and positions:
        applied = run_cli("FIGMA_HIERARCHY_SET_NODE_POSITIONS", {"plan": {"positions": positions}}, args.session_id)
    print(json.dumps({"texts": report, "moves": len(positions),
                      "applied": bool(applied and applied.get("allPass"))}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
