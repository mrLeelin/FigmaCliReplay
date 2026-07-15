#!/usr/bin/env python3
"""验证 Figma Prefab JSON Spec 的结构契约。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def find_project_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".figma" / "plugins" / "figma-mcp-relay").is_dir() and (parent / "JellybeanUnity").is_dir():
            return parent
    raise RuntimeError("Unable to locate the JellybeanUnity repository root.")


PROJECT_ROOT = find_project_root()
UNITY_PROJECT = PROJECT_ROOT / "JellybeanUnity"
COMMON_PREFAB_DIR = UNITY_PROJECT / "Assets" / "MagicWarrior" / "_Resources" / "Prefabs" / "UGUI" / "_Common"


def load_json(path: Path) -> dict:
    """读取 UTF-8 JSON 文件。"""
    with path.open("r", encoding="utf-8-sig") as file:
        return json.load(file)


def normalize_name(name: str) -> str:
    """移除最外层方括号，用于匹配 Figma/Unity 业务节点名。"""
    value = str(name or "").strip()
    while value.startswith("[") and value.endswith("]") and len(value) >= 2:
        value = value[1:-1].strip()
    return value


def normalize_asset_dir(path: str) -> str:
    """归一化 Unity 资源目录，避免尾部斜杠造成误报。"""
    return str(path or "").replace("\\", "/").rstrip("/")


def normalize_common_prefab_candidate(name: str) -> str:
    value = normalize_name(str(name or ""))
    if value.lower().endswith(".prefab"):
        value = value[:-7]
    return value


def is_common_prefab_candidate(name: str) -> bool:
    value = normalize_common_prefab_candidate(name)
    if value.startswith("Common_Texture_"):
        return False
    return value.startswith(("Common_Prefab_", "Common_", "UI_Common_"))


def strip_common_prefab_prefix(name: str) -> str:
    value = str(name or "").lower()
    for prefix in ("common_prefab_", "ui_common_", "common_"):
        if value.startswith(prefix):
            return value[len(prefix):]
    return value


def scan_common_prefabs() -> dict[str, str]:
    prefab_index: dict[str, str] = {}
    if not COMMON_PREFAB_DIR.is_dir():
        return prefab_index
    for prefab_path in COMMON_PREFAB_DIR.rglob("*.prefab"):
        try:
            unity_path = "Assets" + str(prefab_path).split("Assets", 1)[1].replace("\\", "/")
        except IndexError:
            continue
        prefab_index[prefab_path.stem] = unity_path
    return prefab_index


def match_common_prefab(candidate_name: str, prefab_index: dict[str, str]) -> str | None:
    search_name = normalize_common_prefab_candidate(candidate_name)
    if not search_name:
        return None
    if search_name in prefab_index:
        return prefab_index[search_name]

    stripped = search_name
    for prefix in ("Common_Prefab_", "UI_Common_", "Common_"):
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix):]
            if stripped in prefab_index:
                return prefab_index[stripped]

    search_lower = search_name.lower()
    search_clean = strip_common_prefab_prefix(search_name)
    for key, path in prefab_index.items():
        key_lower = key.lower()
        key_clean = strip_common_prefab_prefix(key)
        if search_lower in key_lower or key_lower in search_lower:
            return path
        if search_clean == key_clean:
            return path
        s_parts = search_clean.split("_")
        k_parts = key_clean.split("_")
        if len(s_parts) == len(k_parts):
            diff_idx = [i for i in range(len(s_parts)) if s_parts[i] != k_parts[i]]
            if len(diff_idx) == 1:
                i = diff_idx[0]
                a, b = s_parts[i], k_parts[i]
                if len(a) >= 3 and len(b) >= 3 and a[0] == b[0]:
                    overlap = sum(1 for c in a if c in b)
                    if overlap / max(len(a), len(b)) > 0.6:
                        return path
    return None


def parse_expected_mapping(value: str) -> tuple[str, str]:
    """解析 Name=prefabId 格式的预期 PrefabInstance 映射。"""
    if "=" not in value:
        raise argparse.ArgumentTypeError("expected mapping must be Name=prefabId")
    name, prefab_id = value.split("=", 1)
    name = normalize_name(name)
    prefab_id = prefab_id.strip()
    if not name or not prefab_id:
        raise argparse.ArgumentTypeError("expected mapping must include non-empty Name and prefabId")
    return name, prefab_id


def make_error(code: str, message: str, details: dict) -> dict:
    """创建统一阻塞错误对象。"""
    return {
        "code": code,
        "message": message,
        "details": details,
    }


def verify_spec(path: Path, expected_image_dir: str, common_prefab_index: dict[str, str]) -> dict:
    """验证单个 spec 文件。"""
    spec = load_json(path)
    nodes = spec.get("nodes") or []
    images = spec.get("images") or []
    prefab_instances = spec.get("prefabInstances") or []
    blocking_errors: list[dict] = []
    warnings: list[dict] = []

    if not nodes:
        blocking_errors.append(make_error("nodesMissing", "Spec 缺少 nodes。", {"spec": str(path)}))
    elif nodes[0].get("type") != "Root":
        blocking_errors.append(make_error(
            "rootTypeInvalid",
            "Spec 第一个节点必须是 Root。",
            {"spec": str(path), "actual": nodes[0].get("type")},
        ))

    image_ids: set[str] = set()
    duplicate_image_ids: set[str] = set()
    mismatched_dirs: list[dict] = []
    for image in images:
        image_id = str(image.get("id") or "")
        if image_id in image_ids:
            duplicate_image_ids.add(image_id)
        image_ids.add(image_id)

        target_dir = str(image.get("targetDir") or "")
        if expected_image_dir and normalize_asset_dir(target_dir) != normalize_asset_dir(expected_image_dir):
            mismatched_dirs.append({
                "imageId": image_id,
                "fileName": image.get("fileName"),
                "targetDir": target_dir,
                "expected": expected_image_dir,
            })

    if duplicate_image_ids:
        blocking_errors.append(make_error(
            "duplicateImageIds",
            "Spec 中存在重复 images[].id。",
            {"spec": str(path), "ids": sorted(duplicate_image_ids)},
        ))

    if mismatched_dirs:
        blocking_errors.append(make_error(
            "imageTargetDirMismatch",
            "Spec 中存在 images[].targetDir 与期望目录不一致。",
            {"spec": str(path), "items": mismatched_dirs},
        ))

    prefab_ids: set[str] = set()
    duplicate_prefab_ids: set[str] = set()
    prefab_ref_by_id: dict[str, dict] = {}
    for prefab in prefab_instances:
        prefab_id = str(prefab.get("id") or "")
        if prefab_id in prefab_ids:
            duplicate_prefab_ids.add(prefab_id)
        prefab_ids.add(prefab_id)
        prefab_ref_by_id[prefab_id] = prefab
        source_path = str(prefab.get("sourcePrefabPath") or "")
        if not source_path.startswith("Assets/") or not source_path.endswith(".prefab"):
            blocking_errors.append(make_error(
                "prefabSourcePathInvalid",
                "PrefabInstance sourcePrefabPath 必须是 Assets/.../*.prefab。",
                {"spec": str(path), "prefabId": prefab_id, "sourcePrefabPath": source_path},
            ))

    if duplicate_prefab_ids:
        blocking_errors.append(make_error(
            "duplicatePrefabIds",
            "Spec 中存在重复 prefabInstances[].id。",
            {"spec": str(path), "ids": sorted(duplicate_prefab_ids)},
        ))

    used_image_ids: set[str] = set()
    used_prefab_ids: set[str] = set()
    nodes_by_plain_name: dict[str, list[dict]] = {}
    for index, node in enumerate(nodes):
        plain_name = normalize_name(str(node.get("name") or ""))
        nodes_by_plain_name.setdefault(plain_name, []).append({"index": index, "node": node})

        if node.get("type") == "Image":
            image_id = str(node.get("imageId") or "")
            used_image_ids.add(image_id)
            if image_id not in image_ids:
                blocking_errors.append(make_error(
                    "imageIdMissing",
                    "Image 节点引用了不存在的 imageId。",
                    {"spec": str(path), "nodeIndex": index, "nodeName": node.get("name"), "imageId": image_id},
                ))

        if node.get("type") == "PrefabInstance":
            prefab_id = str(node.get("prefabId") or "")
            used_prefab_ids.add(prefab_id)
            if prefab_id not in prefab_ids:
                blocking_errors.append(make_error(
                    "prefabIdMissing",
                    "PrefabInstance 节点引用了不存在的 prefabId。",
                    {"spec": str(path), "nodeIndex": index, "nodeName": node.get("name"), "prefabId": prefab_id},
                ))

        if is_common_prefab_candidate(plain_name):
            matched_common_prefab = match_common_prefab(plain_name, common_prefab_index)
            if matched_common_prefab:
                if node.get("type") != "PrefabInstance":
                    blocking_errors.append(make_error(
                        "commonPrefabShouldReuseProjectAsset",
                        "项目中已有同名 Common Prefab，Spec 不应降级为普通节点。",
                        {
                            "spec": str(path),
                            "nodeIndex": index,
                            "nodeName": node.get("name"),
                            "actualType": node.get("type"),
                            "expectedSourcePrefabPath": matched_common_prefab,
                        },
                    ))
                else:
                    prefab_id = str(node.get("prefabId") or "")
                    prefab_ref = prefab_ref_by_id.get(prefab_id) or {}
                    source_path = str(prefab_ref.get("sourcePrefabPath") or "")
                    if source_path != matched_common_prefab:
                        blocking_errors.append(make_error(
                            "commonPrefabSourceMismatch",
                            "Common PrefabInstance 没有指向项目已有同名 Prefab。",
                            {
                                "spec": str(path),
                                "nodeIndex": index,
                                "nodeName": node.get("name"),
                                "prefabId": prefab_id,
                                "sourcePrefabPath": source_path,
                                "expectedSourcePrefabPath": matched_common_prefab,
                            },
                        ))

    unused_prefab_ids = sorted(prefab_ids - used_prefab_ids)
    if unused_prefab_ids:
        warnings.append({
            "code": "unusedPrefabRefs",
            "message": "存在未被节点引用的 prefabInstances 项。",
            "details": {"spec": str(path), "prefabIds": unused_prefab_ids},
        })

    return {
        "specPath": str(path),
        "prefabPath": spec.get("prefabPath"),
        "summary": {
            "nodes": len(nodes),
            "images": len(images),
            "prefabInstances": len(prefab_instances),
            "usedImages": len(used_image_ids),
            "usedPrefabInstances": len(used_prefab_ids),
        },
        "allPass": not blocking_errors,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
    }


def verify_expected_instances(spec_paths: list[Path], expected_instances: dict[str, str]) -> list[dict]:
    """在传入的 spec 集合中验证预期 PrefabInstance 映射。"""
    blocking_errors: list[dict] = []
    loaded_specs = [(path, load_json(path)) for path in spec_paths]

    for name, expected_prefab_id in expected_instances.items():
        matches: list[dict] = []
        valid_matches: list[dict] = []

        for path, spec in loaded_specs:
            prefab_refs = {
                str(item.get("id") or ""): item
                for item in (spec.get("prefabInstances") or [])
            }
            for index, node in enumerate(spec.get("nodes") or []):
                if normalize_name(str(node.get("name") or "")) != name:
                    continue

                match = {
                    "spec": str(path),
                    "index": index,
                    "type": node.get("type"),
                    "prefabId": node.get("prefabId"),
                    "imageId": node.get("imageId"),
                }
                matches.append(match)
                if node.get("type") == "PrefabInstance" and str(node.get("prefabId") or "") == expected_prefab_id:
                    source = prefab_refs.get(expected_prefab_id)
                    if source:
                        valid_matches.append({
                            **match,
                            "sourcePrefabPath": source.get("sourcePrefabPath"),
                        })
                    else:
                        blocking_errors.append(make_error(
                            "expectedPrefabRefMissing",
                            "预期 prefabId 没有对应 prefabInstances 引用。",
                            {"spec": str(path), "name": name, "expectedPrefabId": expected_prefab_id},
                        ))

        if valid_matches:
            continue

        if not matches:
            blocking_errors.append(make_error(
                "expectedPrefabInstanceMissing",
                "预期 PrefabInstance 节点不存在。",
                {"name": name, "expectedPrefabId": expected_prefab_id},
            ))
            continue

        blocking_errors.append(make_error(
            "expectedPrefabInstanceMismatch",
            "预期节点没有按指定 prefabId 生成为 PrefabInstance。",
            {"name": name, "expectedPrefabId": expected_prefab_id, "actual": matches},
        ))

    return blocking_errors


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="验证 Figma Prefab JSON Spec 结构契约")
    parser.add_argument("--spec", action="append", required=True, help="要验证的 JSON Spec，可重复传入")
    parser.add_argument("--expected-image-dir", default="", help="期望的 images[].targetDir")
    parser.add_argument(
        "--expect-prefab-instance",
        action="append",
        type=parse_expected_mapping,
        default=[],
        metavar="Name=prefabId",
        help="要求某个节点必须生成为指定 prefabId 的 PrefabInstance，可重复传入",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    expected_instances = dict(args.expect_prefab_instance)
    spec_paths = [Path(spec_path) for spec_path in args.spec]
    common_prefab_index = scan_common_prefabs()
    reports = [
        verify_spec(spec_path, args.expected_image_dir, common_prefab_index)
        for spec_path in spec_paths
    ]
    blocking_errors = [
        error
        for report in reports
        for error in report["blockingErrors"]
    ]
    blocking_errors.extend(verify_expected_instances(spec_paths, expected_instances))
    warnings = [
        warning
        for report in reports
        for warning in report["warnings"]
    ]
    result = {
        "allPass": not blocking_errors,
        "reports": reports,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"All pass: {result['allPass']}")
        for report in reports:
            print(f"- {report['specPath']}: pass={report['allPass']} summary={report['summary']}")
        for error in blocking_errors:
            print(f"[BLOCKING] {error['code']}: {error['message']} {error['details']}")
        for warning in warnings:
            print(f"[WARN] {warning['code']}: {warning['message']} {warning['details']}")

    return 0 if result["allPass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
