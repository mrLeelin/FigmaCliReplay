"""
从 manifest.json 提取导入 Figma 所需的精简数据。

避免 Agent 分段读取 2000+ 行的完整 manifest，一次输出所有关键信息。

用法：
    python summarize_manifest.py <manifest.json>

输出（stdout JSON）：
{
  "canvas": { "width": 1146, "height": 2162 },
  "summary": { "total": 33, "image": 22, "text": 6, "common": 3, "nineSlice": 2 },
  "textLayers": [ { "idx": 17, "chars": "20", "fillHex": "#FFEA80", ... } ],
  "commonLayers": [ { "idx": 37, "name": "common_jishi", "candidates": [...] } ],
  "nineSliceLayers": [ { "idx": 25, "name": "jiugong_di_002", "border": {...} } ],
  "imageLayers": [ { "idx": 1, "name": "...", "path": "...", ... } ],
  "warnings": [...]
}

依赖：无（仅标准库）
"""

import argparse
import json


def summarize(manifest_path):
    """读取 manifest 并输出精简摘要。"""
    with open(manifest_path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)

    canvas = data["canvas"]
    layers = data.get("layers", [])

    text_layers = []
    common_layers = []
    nine_slice_layers = []
    image_layers = []

    for layer in layers:
        mode = layer.get("mode", "image")
        base = {
            "idx": layer["index"],
            "name": layer["name"],
            "rawPsdLayerName": layer.get("rawPsdLayerName", layer.get("name", "")),
            "normalizedLayerName": layer.get("normalizedLayerName", layer.get("name", "")),
            "semanticMode": layer.get("semanticMode", mode),
            "normalizationWarnings": layer.get("normalizationWarnings", []),
            "psdPrefix": layer.get("psdPrefix"),
            "x": layer.get("x", 0),
            "y": layer.get("y", 0),
            "w": layer.get("width", 0),
            "h": layer.get("height", 0),
            "opacity": layer.get("opacity", 255),
            "visible": layer.get("visible", True),
            "path": layer.get("path", ""),
            "constraints": layer.get("constraints", {}),
        }

        if mode == "text":
            txt = layer.get("text", {})
            effects = txt.get("effects", {})
            stroke = effects.get("stroke")
            shadow = effects.get("dropShadow")
            text_layers.append({
                **base,
                "chars": txt.get("characters", ""),
                "fontSize": txt.get("fontSize", 0),
                "leading": txt.get("leading", 0),
                "fillColor": txt.get("fillColor", {}),
                "fillHex": txt.get("fillColor", {}).get("hex", ""),
                "stroke": {
                    "enabled": stroke.get("enabled", False),
                    "size": stroke.get("size", 0),
                    "colorR": stroke.get("color", {}).get("r", 0),
                    "colorG": stroke.get("color", {}).get("g", 0),
                    "colorB": stroke.get("color", {}).get("b", 0),
                    "hex": stroke.get("color", {}).get("hex", ""),
                } if stroke else None,
                "dropShadow": {
                    "enabled": shadow.get("enabled", False),
                } if shadow else None,
                "fontFallback": [
                    f.get("family", "") for f in
                    txt.get("figma", {}).get("fontFallbackCandidates", [])[:3]
                ],
            })

        elif mode == "common-component":
            common = layer.get("common", layer.get("componentSearch", {}))
            common_layers.append({
                **base,
                "query": common.get("query", ""),
                "candidates": common.get("candidateNames", []),
                "strategy": common.get("strategy", ""),
            })

        elif mode == "nine-slice":
            ns = layer.get("nineSlice", {})
            nine_slice_layers.append({
                **base,
                "border": ns.get("border", {}),
                "inferredBorder": ns.get("inferredBorder", False),
                "inferMethod": ns.get("inferMethod", ""),
                "confidence": ns.get("confidence", ""),
                "sliceCount": len(ns.get("slices", [])),
            })

        else:
            image_layers.append(base)

    output = {
        "canvas": {"width": canvas["width"], "height": canvas["height"]},
        "summary": {
            "total": len(layers),
            "image": len(image_layers),
            "text": len(text_layers),
            "common": len(common_layers),
            "nineSlice": len(nine_slice_layers),
        },
        "textLayers": text_layers,
        "commonLayers": common_layers,
        "nineSliceLayers": nine_slice_layers,
        "imageLayers": image_layers,
        "semanticHints": data.get("semanticHints", {}),
        "warnings": data.get("warnings", []),
    }

    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="从 manifest.json 提取导入 Figma 所需的精简数据。")
    parser.add_argument("manifest", help="输入 manifest.json 路径。")
    parser.add_argument("--out", help="可选输出 manifest_summary.json 路径；不传则输出到 stdout。")
    args = parser.parse_args()

    result = summarize(args.manifest)
    result_json = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(result_json)
            f.write("\n")
    else:
        print(result_json)
