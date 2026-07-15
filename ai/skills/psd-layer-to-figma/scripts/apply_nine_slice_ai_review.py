#!/usr/bin/env python3
"""校验 Agent 手动九宫审核结果，并回填生成新的 manifest。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple


REQUIRED_BORDER_FIELDS = ("left", "bottom", "right", "top")


def _load_export_module() -> Any:
    """加载 export_psd_layers.py，复用九宫切片生成逻辑，避免双份公式漂移。"""
    script_path = Path(__file__).with_name("export_psd_layers.py")
    spec = importlib.util.spec_from_file_location("psd_layer_export_helpers", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载九宫辅助脚本：{script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_json(path: Path) -> Dict[str, Any]:
    """读取 JSON 文件，兼容 Windows UTF-8 BOM。"""
    with path.open("r", encoding="utf-8-sig") as file:
        return json.load(file)


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    """写入 UTF-8 JSON 文件。"""
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _iter_review_files(review_dir: Path) -> Iterable[Path]:
    """按文件名稳定遍历待应用的 review JSON。"""
    return sorted(review_dir.glob("*_review.json"))


def _normalize_border(raw_border: Dict[str, Any]) -> Dict[str, float]:
    """把 review 中的 border 转换成 float，并检查必需字段。"""
    border: Dict[str, float] = {}
    for field in REQUIRED_BORDER_FIELDS:
        if field not in raw_border:
            raise ValueError(f"selectedBorder 缺少字段：{field}")
        value = float(raw_border[field])
        if value < 0:
            raise ValueError(f"selectedBorder.{field} 不能小于 0：{value}")
        border[field] = value
    return border


def _validate_border(border: Dict[str, float], width: float, height: float) -> None:
    """校验九宫 border 不会导致切片重叠或越界。"""
    if width <= 0 or height <= 0:
        raise ValueError(f"图层尺寸非法：width={width}, height={height}")
    if border["left"] + border["right"] >= width:
        raise ValueError(
            f"left + right 必须小于 width：{border['left']} + {border['right']} >= {width}"
        )
    if border["top"] + border["bottom"] >= height:
        raise ValueError(
            f"top + bottom 必须小于 height：{border['top']} + {border['bottom']} >= {height}"
        )

    limits = {"left": width * 0.5, "right": width * 0.5, "top": height * 0.5, "bottom": height * 0.5}
    for field, limit in limits.items():
        if border[field] > limit:
            raise ValueError(f"selectedBorder.{field} 不能超过对应轴向 50%：{border[field]} > {limit}")


def _find_layer_by_index(layers: List[Dict[str, Any]], layer_index: int) -> Dict[str, Any]:
    """按 layerIndex 定位 manifest 中的九宫图层。"""
    for layer in layers:
        if int(layer.get("index", -1)) == layer_index:
            return layer
    raise ValueError(f"manifest 中找不到 layerIndex={layer_index} 的图层")


def _apply_review_to_layer(
    layer: Dict[str, Any],
    review: Dict[str, Any],
    export_helpers: Any,
) -> Dict[str, Any]:
    """将单个 review 应用到九宫图层并重建 slices。"""
    if layer.get("mode") != "nine-slice":
        raise ValueError(f"layerIndex={layer.get('index')} 不是 nine-slice 图层")

    width = float(layer.get("width", 0) or 0)
    height = float(layer.get("height", 0) or 0)
    border = _normalize_border(review.get("selectedBorder") or {})
    _validate_border(border, width, height)

    slices, slice_warnings = export_helpers._build_nine_slice(width, height, width, height, border)
    if not slices:
        raise ValueError(f"layerIndex={layer.get('index')} 重建 slices 为空，请检查 border")

    updated_layer = deepcopy(layer)
    nine_slice = deepcopy(updated_layer.get("nineSlice") or {})
    previous_warnings = list(nine_slice.get("warnings") or [])
    review_reason = str(review.get("reason") or "").strip()
    review_confidence = str(review.get("confidence") or "medium").strip() or "medium"
    needs_human_review = bool(review.get("needsHumanReview", False))

    nine_slice.update(
        {
            "border": border,
            "declaredBorder": nine_slice.get("declaredBorder", {}),
            "inferredBorder": True,
            "inferMethod": "ai-visual-review",
            "confidence": review_confidence,
            "inferredFields": list(REQUIRED_BORDER_FIELDS),
            "clampedFields": [],
            "slices": slices,
            "aiReview": {
                "reason": review_reason,
                "needsHumanReview": needs_human_review,
                "source": "agent-manual-visual-review",
            },
            "warnings": previous_warnings + slice_warnings,
        }
    )
    if review_reason:
        nine_slice["warnings"].append(f"nine-slice border selected by Agent visual review: {review_reason}")
    if needs_human_review:
        nine_slice["warnings"].append("nine-slice Agent review still requires human verification")

    updated_layer["nineSlice"] = nine_slice
    updated_layer["warnings"] = list(updated_layer.get("warnings") or []) + list(nine_slice["warnings"])
    return updated_layer


def apply_reviews(manifest_path: Path, review_dir: Path, out_path: Path) -> Dict[str, Any]:
    """读取 review 目录并输出回填后的 manifest。"""
    manifest = _load_json(manifest_path)
    layers = list(manifest.get("layers") or [])
    export_helpers = _load_export_module()

    applied: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    layer_by_index = {int(layer.get("index", -1)): layer for layer in layers}

    for review_file in _iter_review_files(review_dir):
        try:
            review = _load_json(review_file)
            layer_index = int(review.get("layerIndex"))
            if not review.get("apply", False):
                skipped.append({"review": review_file.as_posix(), "layerIndex": layer_index, "reason": "apply=false"})
                continue

            layer = _find_layer_by_index(layers, layer_index)
            updated_layer = _apply_review_to_layer(layer, review, export_helpers)
            layer_by_index[layer_index] = updated_layer
            applied.append(
                {
                    "review": review_file.as_posix(),
                    "layerIndex": layer_index,
                    "border": updated_layer["nineSlice"]["border"],
                    "confidence": updated_layer["nineSlice"]["confidence"],
                }
            )
        except Exception as exc:  # noqa: BLE001 - 命令行工具需要汇总所有 review 错误
            errors.append({"review": review_file.as_posix(), "error": str(exc)})

    if errors:
        return {"ok": False, "applied": applied, "skipped": skipped, "errors": errors}

    updated_manifest = deepcopy(manifest)
    updated_manifest["layers"] = [layer_by_index[int(layer.get("index", -1))] for layer in layers]
    updated_manifest["nineSliceAiReview"] = {
        "reviewDir": review_dir.as_posix(),
        "appliedCount": len(applied),
        "skippedCount": len(skipped),
        "applied": applied,
        "skipped": skipped,
    }
    _write_json(out_path, updated_manifest)
    return {"ok": True, "out": out_path.as_posix(), "applied": applied, "skipped": skipped}


def main() -> int:
    """解析命令行参数并执行九宫审核回填。"""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="校验 Agent 手动九宫审核结果，并回填生成新的 manifest。")
    parser.add_argument("manifest", type=Path, help="输入原始 manifest.json 路径。")
    parser.add_argument("review_dir", type=Path, help="prepare_nine_slice_ai_review.py 生成的审核目录。")
    parser.add_argument("--out", type=Path, required=True, help="输出新的 manifest 路径。")
    args = parser.parse_args()

    result = apply_reviews(args.manifest, args.review_dir, args.out)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
