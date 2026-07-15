#!/usr/bin/env python3
"""为低置信九宫图层生成 Agent 手动视觉审核包。"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, List


def _load_json(path: Path) -> Dict[str, Any]:
    """读取 JSON 文件，兼容 Windows UTF-8 BOM。"""
    with path.open("r", encoding="utf-8-sig") as file:
        return json.load(file)


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    """以 UTF-8 写入格式化 JSON，方便人工和 Agent 审核。"""
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _safe_stem(layer: Dict[str, Any]) -> str:
    """生成稳定且可读的审核文件名前缀。"""
    index = int(layer.get("index", 0))
    name = str(layer.get("normalizedLayerName") or layer.get("name") or f"layer_{index}")
    cleaned = "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in name).strip("_")
    return f"{index:02d}_{cleaned or 'nine_slice'}"


def _should_review(layer: Dict[str, Any], include_explicit: bool) -> bool:
    """判断九宫层是否需要进入 Agent 视觉审核。"""
    if layer.get("mode") != "nine-slice":
        return False
    if include_explicit:
        return True

    nine_slice = layer.get("nineSlice") or {}
    return bool(nine_slice.get("inferredBorder")) or nine_slice.get("confidence") != "explicit"


def _build_default_candidates(layer: Dict[str, Any]) -> List[Dict[str, Any]]:
    """为审核包写入当前推算和 25% fallback 候选，辅助 Agent 判断。"""
    width = float(layer.get("width", 0) or 0)
    height = float(layer.get("height", 0) or 0)
    nine_slice = layer.get("nineSlice") or {}
    candidates: List[Dict[str, Any]] = []

    current_border = nine_slice.get("border")
    if isinstance(current_border, dict):
        candidates.append(
            {
                "name": "current-script-border",
                "border": current_border,
                "inferMethod": nine_slice.get("inferMethod"),
                "confidence": nine_slice.get("confidence"),
                "reason": "当前脚本推算或显式解析结果。",
            }
        )

    if width > 0 and height > 0:
        candidates.append(
            {
                "name": "fallback-25-percent",
                "border": {
                    "left": width * 0.25,
                    "bottom": height * 0.25,
                    "right": width * 0.25,
                    "top": height * 0.25,
                },
                "inferMethod": "size-ratio-25-percent",
                "confidence": "low",
                "reason": "按图层宽高 25% 生成的兜底候选。",
            }
        )

    return candidates


def _copy_layer_png(layer: Dict[str, Any], manifest_dir: Path, out_dir: Path, stem: str) -> str:
    """复制九宫源 PNG 到审核目录，保持原始文件不变。"""
    source_path = Path(str(layer.get("path", "")))
    if not source_path.is_absolute():
        source_path = manifest_dir / source_path
    if not source_path.exists():
        return ""

    target_path = out_dir / f"{stem}{source_path.suffix or '.png'}"
    shutil.copy2(source_path, target_path)
    return target_path.as_posix()


def prepare_review(manifest_path: Path, out_dir: Path, include_explicit: bool = False) -> Dict[str, Any]:
    """从 manifest 生成九宫审核包索引和每层 review 模板。"""
    manifest = _load_json(manifest_path)
    manifest_dir = manifest_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    review_items: List[Dict[str, Any]] = []
    for layer in manifest.get("layers", []):
        if not _should_review(layer, include_explicit):
            continue

        stem = _safe_stem(layer)
        png_path = _copy_layer_png(layer, manifest_dir, out_dir, stem)
        candidates = _build_default_candidates(layer)
        candidates_path = out_dir / f"{stem}_candidates.json"
        review_path = out_dir / f"{stem}_review.json"

        nine_slice = layer.get("nineSlice") or {}
        candidate_data = {
            "layerIndex": layer.get("index"),
            "layerName": layer.get("name"),
            "normalizedLayerName": layer.get("normalizedLayerName", layer.get("name")),
            "sourcePng": png_path,
            "width": layer.get("width"),
            "height": layer.get("height"),
            "currentNineSlice": nine_slice,
            "candidates": candidates,
        }
        review_template = {
            "layerIndex": layer.get("index"),
            "layerName": layer.get("name"),
            "sourcePng": png_path,
            "selectedBorder": nine_slice.get("border", {"left": 0, "bottom": 0, "right": 0, "top": 0}),
            "confidence": "medium",
            "reason": "请由 Agent/人工根据 PNG 视觉边界填写：圆角、描边、阴影等不可拉伸区域。",
            "needsHumanReview": True,
            "apply": False,
        }

        _write_json(candidates_path, candidate_data)
        _write_json(review_path, review_template)
        review_items.append(
            {
                "layerIndex": layer.get("index"),
                "layerName": layer.get("name"),
                "sourcePng": png_path,
                "candidates": candidates_path.as_posix(),
                "review": review_path.as_posix(),
                "currentConfidence": nine_slice.get("confidence"),
                "currentInferMethod": nine_slice.get("inferMethod"),
            }
        )

    index = {
        "sourceManifest": manifest_path.as_posix(),
        "outDir": out_dir.as_posix(),
        "reviewCount": len(review_items),
        "items": review_items,
        "instructions": [
            "打开 sourcePng 观察九宫不可拉伸边界。",
            "在 review JSON 中填写 selectedBorder，确认 apply=true 后再执行 apply_nine_slice_ai_review.py。",
            "如果无法判断，保持 needsHumanReview=true 并说明 reason。",
        ],
    }
    _write_json(out_dir / "review_index.json", index)
    return index


def main() -> int:
    """解析命令行参数并生成九宫审核包。"""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="为低置信九宫图层生成 Agent 手动视觉审核包。")
    parser.add_argument("manifest", type=Path, help="输入 manifest.json 路径。")
    parser.add_argument("--out", type=Path, required=True, help="输出审核包目录。")
    parser.add_argument("--include-explicit", action="store_true", help="同时导出显式 border 九宫层。")
    args = parser.parse_args()

    result = prepare_review(args.manifest, args.out, args.include_explicit)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
