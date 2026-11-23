#!/usr/bin/env python3
"""查找可复用的历史拆图运行目录，避免对同一张图重复提交收费拆层。

只读：不调用 DXX、不修改 Figma、不改动任何历史目录。按原图 SHA256 和 DXX 选项（model/size 等）
匹配 `.tmp/image-decompose/*/`，报告每个候选已经完成到哪个阶段，供 Agent 从最靠后的可用阶段继续。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import sys
from pathlib import Path

RELAY_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(RELAY_ROOT / "ai/skills/dxx-image/scripts"))
from dxx_layers import layer_options  # noqa: E402

# 按流程先后排列；后面的阶段依赖前面的产物，Agent 从最靠后且存在的阶段继续
STAGE_ARTIFACTS = [
    ("dxx", "dxx/manifest.json"),
    ("repaired", "source-resources/manifest.json"),
    ("composed", "composed/manifest.json"),
    ("prepared", "prepared*/manifest.json"),
    ("imported", "import*/result.json"),
    ("hierarchy", "hierarchy/apply*/report.json"),
]


def sha256(path: Path) -> str:
    """返回文件 SHA256（小写十六进制）。"""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_decompose_args(text: str) -> dict:
    """把插件给出的 DXX 参数串解析成与 layer-request.json body 同口径的选项字典。"""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model")
    parser.add_argument("--size")
    parser.add_argument("--max-images", type=int)
    parser.add_argument("--text-recognition", action="store_true")
    parser.add_argument("--output-format")
    parsed, _unknown = parser.parse_known_args(shlex.split(text or ""))
    return layer_options(parsed)


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def dxx_state(run: Path) -> dict:
    """判断 DXX 结果是否完整可用：manifest 中每个图层文件都存在才算 complete。"""
    task_id_file = run / "dxx/layer-task-id.txt"
    task_id = task_id_file.read_text(encoding="utf-8").strip() if task_id_file.is_file() else None
    manifest = read_json(run / "dxx/manifest.json")
    if isinstance(manifest, dict) and manifest.get("items"):
        missing = [item.get("file") for item in manifest["items"]
                   if not (run / "dxx/layers" / str(item.get("file"))).is_file()]
        if not missing:
            return {"status": "complete", "taskId": task_id, "layerCount": len(manifest["items"])}
        return {"status": "incomplete-files", "taskId": task_id, "missingFiles": missing[:5]}
    if task_id:
        # 已提交但结果未取回：用 Layerwait 继续取，不得重新提交
        return {"status": "pending", "taskId": task_id}
    return {"status": "none", "taskId": None}


def inspect_run(run: Path, source_hash: str, options: dict, hint: str | None) -> dict | None:
    source = run / "source.png"
    if not source.is_file() or sha256(source) != source_hash:
        return None
    request = read_json(run / "dxx/layer-request.json") or {}
    body = request.get("body") or {}
    previous = {key: value for key, value in body.items() if key not in ("image", "prompt", "projectGroupId")}
    if previous and previous != options:
        return {"runDir": str(run), "reusable": False, "reason": "DXX 选项不同", "previousOptions": previous}
    hint_file = run / "hint.txt"
    if hint is None or not hint_file.is_file():
        hint_match = "unknown"
    else:
        hint_match = hint_file.read_text(encoding="utf-8").strip() == hint.strip()
    if hint_match is False:
        return {"runDir": str(run), "reusable": False, "reason": "拆分说明不同"}
    dxx = dxx_state(run)
    stages = [name for name, pattern in STAGE_ARTIFACTS if any(run.glob(pattern))]
    reusable = dxx["status"] in ("complete", "pending")
    return {"runDir": str(run), "reusable": reusable, "hintMatch": hint_match, "dxx": dxx,
            "completedStages": stages, "latestStage": stages[-1] if stages else None,
            "reason": None if reusable else "DXX 结果不可用（%s）" % dxx["status"]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="本次导出的 source.png")
    parser.add_argument("--decompose-args", required=True, help="插件给出的 DXX 参数串，例如 \"--model seedream55 --size auto\"")
    parser.add_argument("--hint-file", type=Path, help="本次拆分说明原文（hint.txt）")
    parser.add_argument("--runs-root", type=Path, default=RELAY_ROOT / ".tmp/image-decompose")
    args = parser.parse_args(argv)

    source_hash = sha256(args.source)
    options = parse_decompose_args(args.decompose_args)
    hint = args.hint_file.read_text(encoding="utf-8") if args.hint_file and args.hint_file.is_file() else None
    current = args.source.resolve().parent
    runs = sorted((path for path in args.runs_root.glob("*/") if path.resolve() != current),
                  key=lambda path: path.name, reverse=True)
    candidates = [row for row in (inspect_run(run, source_hash, options, hint) for run in runs) if row]
    reusable = [row for row in candidates if row["reusable"]]
    # 优先 DXX 已完成的；同等条件下阶段更靠后、目录更新的优先
    order = {name: index for index, (name, _) in enumerate(STAGE_ARTIFACTS)}
    reusable.sort(key=lambda row: (row["dxx"]["status"] == "complete",
                                   order.get(row["latestStage"], -1), row["runDir"]), reverse=True)
    best = reusable[0] if reusable else None
    if best is None:
        action = "submit-new"
    elif best["dxx"]["status"] == "pending":
        action = "layerwait-existing-task"
    else:
        action = "reuse-existing-result"
    print(json.dumps({"sourceSha256": source_hash, "decomposeOptions": options, "action": action,
                      "best": best, "candidates": candidates}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
