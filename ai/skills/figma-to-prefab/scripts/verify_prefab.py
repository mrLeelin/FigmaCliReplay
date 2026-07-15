#!/usr/bin/env python3
"""
Prefab YAML 静态验证器
用法: python verify_prefab.py --prefab Assets/_Resources/Sharders/<targetPrefab>.prefab

检查项:
- m_Sprite: {fileID: 0} 残留
- m_RaycastTarget: 1 残留
- m_enableAutoSizing: 0 残留
- TMP 默认字体 GUID 8f586378b4e144a9851e7b34d9b748ee 残留
- m_sharedMaterial: {fileID: 0} 残留

输出 JSON 结果，AI 直接读取无需分析。
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

TMP_DEFAULT_FONT_GUID = "8f586378b4e144a9851e7b34d9b748ee"


def find_unity_project_root(start_dir=None):
    """从当前目录向上解析 Unity 工程根，兼容仓库根和工程根。"""
    configured = os.environ.get("FIGMA_UNITY_PROJECT", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if (candidate / "Assets").is_dir() and (candidate / "ProjectSettings").is_dir():
            return candidate
        raise RuntimeError(f"FIGMA_UNITY_PROJECT is not a Unity project: {candidate}")
    current = Path(start_dir or ".").resolve()
    for candidate in [current, *current.parents]:
        if (candidate / "Assets").is_dir() and (candidate / "ProjectSettings").is_dir():
            return candidate
        nested = candidate / "JellybeanUnity"
        if (nested / "Assets").is_dir() and (nested / "ProjectSettings").is_dir():
            return nested
    return current


UNITY_PROJECT_ROOT = find_unity_project_root()


def read_configured_font_asset():
    settings_path = UNITY_PROJECT_ROOT / "ProjectSettings" / "FigmaBridgeImportSettings.json"
    if not settings_path.is_file():
        return ""
    try:
        value = json.loads(settings_path.read_text(encoding="utf-8")).get("commonFontAsset", "")
    except (json.JSONDecodeError, OSError):
        return ""
    return value if isinstance(value, str) and value.startswith("Assets/") else ""


COMMON_FONT_ASSET = read_configured_font_asset()
COMMON_FONT_MAT = str(Path(COMMON_FONT_ASSET).with_suffix(".mat")).replace("\\", "/") if COMMON_FONT_ASSET else ""
FIGMA_TEXT_MAT_ASSET_DIR = str(Path(COMMON_FONT_ASSET).parent).replace("\\", "/") if COMMON_FONT_ASSET else ""


def resolve_asset_path(path):
    """把 Unity Assets 路径或本地路径解析为磁盘路径。"""
    raw = str(path or "").replace("\\", "/")
    if raw.startswith("JellybeanUnity/Assets/"):
        raw = raw[len("JellybeanUnity/"):]
    if raw.startswith("Assets/"):
        return UNITY_PROJECT_ROOT / raw
    return Path(path)


COMMON_FONT_META = resolve_asset_path(COMMON_FONT_ASSET + ".meta")
COMMON_FONT_MAT_META = resolve_asset_path(COMMON_FONT_MAT + ".meta")
FIGMA_TEXT_MAT_DIR = resolve_asset_path(FIGMA_TEXT_MAT_ASSET_DIR)


def make_blocking_errors(checks):
    """把失败检查转换为统一阻塞错误列表。"""
    messages = {
        "spriteNull": "Prefab 中存在空 Sprite 引用。",
        "raycastTargetOn": "Prefab 中存在未关闭 RaycastTarget 的图片组件。",
        "autoSizeOff": "Prefab 中存在 AutoSize 关闭的 TMP 文本。",
        "defaultFont": "Prefab 中存在 TMP 默认字体残留。",
        "matNull": "Prefab 中存在空 TMP 材质引用。",
        "commonFontExact": "Prefab 中存在非 CommonFont.asset 的 TMP 字体引用。",
        "allowedMaterial": "Prefab 中存在非 CommonFont.mat 且非生成描边/投影材质的 TMP 材质引用。",
        "textRectSize": "Prefab 中存在 Text 节点 RectTransform 宽高与 Spec 不一致。",
    }
    blocking_errors = []
    for check_name, check_result in checks.items():
        if check_result.get("pass"):
            continue
        blocking_errors.append({
            "code": check_name,
            "message": messages.get(check_name, f"{check_name} 检查失败。"),
            "details": check_result,
        })
    return blocking_errors


def read_meta_guid(meta_path):
    """读取 Unity .meta 文件中的 guid，文件不存在时返回空字符串。"""
    if not meta_path.is_file():
        return ""
    match = re.search(r"^guid:\s*([a-f0-9]+)\s*$", meta_path.read_text(encoding="utf-8"), re.MULTILINE)
    return match.group(1) if match else ""


def collect_generated_text_material_guids():
    """收集 Figma 生成的 TMP 描边/投影材质 GUID，允许验证脚本识别复用材质。"""
    guids = {}
    if FIGMA_TEXT_MAT_DIR.is_dir():
        for meta_path in FIGMA_TEXT_MAT_DIR.glob("*.mat.meta"):
            guid = read_meta_guid(meta_path)
            if guid:
                guids[guid] = str(meta_path)
    return guids


def collect_fallback_text_material_guids(explicit_allowed_guids):
    """收集历史 CommonFont_figma 材质作为回退白名单，并在报告中提示人工关注。"""
    guids = {}
    assets_root = UNITY_PROJECT_ROOT / "Assets"
    if not assets_root.is_dir():
        return guids
    for meta_path in assets_root.rglob("CommonFont_figma_*.mat.meta"):
        guid = read_meta_guid(meta_path)
        if guid and guid not in explicit_allowed_guids:
            guids[guid] = str(meta_path)
    return guids


def load_spec_allowed_material_names(spec_path):
    """从 prefab_spec.json 读取本次允许的 textMaterial 材质名。"""
    if not spec_path or not Path(spec_path).is_file():
        return set()
    try:
        spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()

    names = set()
    for node in spec.get("nodes", []):
        material = node.get("textMaterial")
        if material and material.get("materialName"):
            names.add(material["materialName"])
    return names


def collect_allowed_material_guids(spec_path):
    """组合 CommonFont.mat、生成目录和 Spec 指定材质作为允许材质集合。"""
    allowed = {}
    common_mat_guid = read_meta_guid(COMMON_FONT_MAT_META)
    if common_mat_guid:
        allowed[common_mat_guid] = str(COMMON_FONT_MAT_META)

    allowed.update(collect_generated_text_material_guids())
    for material_name in load_spec_allowed_material_names(spec_path):
        for meta_path in (UNITY_PROJECT_ROOT / "Assets").rglob(f"{material_name}.mat.meta"):
            guid = read_meta_guid(meta_path)
            if guid:
                allowed[guid] = str(meta_path)
    return allowed


def load_spec_text_rects(spec_path):
    """从 prefab_spec.json 读取 Text 节点期望 RectTransform 宽高。"""
    if not spec_path or not Path(spec_path).is_file():
        return {}
    try:
        spec = json.loads(Path(spec_path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}

    expected = {}
    for node in spec.get("nodes", []):
        if node.get("type") != "Text":
            continue
        rect = node.get("rect") or {}
        name = str(node.get("name") or "")
        if not name:
            continue
        expected[name] = {
            "w": float(rect.get("w", 0) or 0),
            "h": float(rect.get("h", 0) or 0),
        }
    return expected


def collect_prefab_rect_sizes(content):
    """从 Prefab YAML 读取 GameObject 名称对应的 RectTransform sizeDelta。"""
    go_names = {}
    for match in re.finditer(r'--- !u!1 &(\d+)\s+GameObject:.*?\n  m_Name: ([^\r\n]+)', content, re.DOTALL):
        go_names[match.group(1)] = normalize_yaml_scalar(match.group(2))

    rect_sizes = {}
    rect_pattern = (
        r'--- !u!224 &\d+\s+RectTransform:.*?'
        r'm_GameObject:\s*\{fileID:\s*(\d+)\}.*?'
        r'm_SizeDelta:\s*\{x:\s*([-\d.]+),\s*y:\s*([-\d.]+)\}'
    )
    for match in re.finditer(rect_pattern, content, re.DOTALL):
        go_name = go_names.get(match.group(1))
        if not go_name:
            continue
        rect_sizes[go_name] = {
            "w": float(match.group(2)),
            "h": float(match.group(3)),
        }
    return rect_sizes


def normalize_yaml_scalar(value):
    """规范化 Unity YAML 标量，去掉 m_Name 可能带的单双引号。"""
    text = str(value or "").strip()
    if len(text) >= 2 and ((text[0] == "'" and text[-1] == "'") or (text[0] == '"' and text[-1] == '"')):
        text = text[1:-1]
    return text


def compare_text_rect_sizes(content, spec_path, tolerance=0.5):
    """比较 Spec Text rect 与 Prefab RectTransform sizeDelta。"""
    expected = load_spec_text_rects(spec_path)
    if not expected:
        return {
            "count": 0,
            "mismatch": 0,
            "missing": 0,
            "pass": True,
            "tolerance": tolerance,
            "details": [],
        }

    actual = collect_prefab_rect_sizes(content)
    details = []
    for name, expected_rect in expected.items():
        actual_rect = actual.get(name)
        if not actual_rect:
            details.append({
                "name": name,
                "reason": "missingTextRect",
                "expected": expected_rect,
                "actual": None,
            })
            continue
        delta_w = abs(actual_rect["w"] - expected_rect["w"])
        delta_h = abs(actual_rect["h"] - expected_rect["h"])
        if delta_w > tolerance or delta_h > tolerance:
            details.append({
                "name": name,
                "reason": "sizeMismatch",
                "expected": expected_rect,
                "actual": actual_rect,
                "delta": {"w": round(delta_w, 3), "h": round(delta_h, 3)},
            })

    return {
        "count": len(expected),
        "mismatch": len(details),
        "missing": sum(1 for item in details if item["reason"] == "missingTextRect"),
        "pass": len(details) == 0,
        "tolerance": tolerance,
        "details": details[:50],
    }


def _find_image_component_guid(prefab_path):
    """从 Prefab YAML 中找到一个 Image 组件的 m_Script GUID，用作过滤器。"""
    content = Path(prefab_path).read_text(encoding="utf-8")
    # 找一个既有 m_Sprite 又有 m_RaycastTarget 的 MonoBehaviour 块
    blocks = re.split(r'\n--- !u!114 ', content)
    for block in blocks:
        if re.search(r'm_SourcePrefab:\s*\{fileID:\s*\d+,\s*guid:\s*[0-9a-fA-F]+,', block):
            continue
        name_match = re.search(r'\bm_Name:\s*(.+)', block)
        if name_match:
            name = name_match.group(1).strip().strip('"').strip("'").strip("[]")
            if name.startswith(("Common_", "CommonTexture_", "Common_Texture_", "Common_Prefab_", "UI_Common_")):
                continue
        if 'm_Sprite:' in block and ('m_RaycastTarget:' in block or 'm_Type:' in block):
            m = re.search(r'guid:\s*([a-f0-9]+)', block)
            if m:
                return m.group(1)
    return ""


def _scan_image_blocks(prefab_path, field_pattern):
    """只在 Image/CustomImage 组件的 MonoBehaviour 块内搜索 field_pattern。"""
    content = Path(prefab_path).read_text(encoding="utf-8")
    # 用 --- !u!114 分块
    blocks = re.split(r'\n--- !u!114 ', content)
    count = 0
    for block in blocks:
        # 是 Image 组件块的特征：有 m_Sprite 或 m_Type 字段
        if re.search(r'm_SourcePrefab:\s*\{fileID:\s*\d+,\s*guid:\s*[0-9a-fA-F]+,', block):
            continue
        name_match = re.search(r'\bm_Name:\s*(.+)', block)
        if name_match:
            name = name_match.group(1).strip().strip('"').strip("'").strip("[]")
            if name.startswith(("Common_", "CommonTexture_", "Common_Texture_", "Common_Prefab_", "UI_Common_")):
                continue
        if 'm_Sprite:' not in block and 'm_Type:' not in block:
            continue
        count += len(re.findall(field_pattern, block))
    return count


def verify_prefab(prefab_path, spec_path=""):
    """读取 Prefab YAML 并输出验证结果"""
    resolved_prefab_path = resolve_asset_path(prefab_path)
    if not resolved_prefab_path.is_file():
        error = {
            "code": "prefabNotFound",
            "message": f"Prefab not found: {prefab_path}",
            "details": {"prefabPath": prefab_path, "resolvedPrefabPath": str(resolved_prefab_path)},
        }
        return {
            "prefabPath": prefab_path,
            "resolvedPrefabPath": str(resolved_prefab_path),
            "prefabSize": 0,
            "checks": {
                "prefabExists": {"pass": False, "path": prefab_path, "resolvedPath": str(resolved_prefab_path)},
            },
            "summary": {},
            "allPass": False,
            "blockingErrors": [error],
            "warnings": [],
            "artifacts": {"prefabPath": prefab_path, "resolvedPrefabPath": str(resolved_prefab_path)},
            "error": error["message"],
        }

    content = resolved_prefab_path.read_text(encoding="utf-8")

    # 只在 Image/CustomImage 组件块内搜索（避免其他组件的同名字段误报）
    sprite_null = _scan_image_blocks(resolved_prefab_path, r'm_Sprite:\s*\{fileID:\s*0\}')
    raycast_on = _scan_image_blocks(resolved_prefab_path, r'm_RaycastTarget:\s*1')
    auto_size_off = len(re.findall(r'm_enableAutoSizing:\s*0', content))
    font_asset_refs = re.findall(r'm_fontAsset:\s*\{fileID:\s*(\d+),\s*guid:\s*([a-f0-9]+)', content)
    default_font_count = sum(1 for _, g in font_asset_refs if g == TMP_DEFAULT_FONT_GUID)
    mat_refs = re.findall(r'm_sharedMaterial:\s*\{fileID:\s*(\d+),\s*guid:\s*([a-f0-9]+)', content)
    mat_null = sum(1 for fid, _ in mat_refs if fid == "0")
    common_font_guid = read_meta_guid(COMMON_FONT_META)
    explicit_allowed_mat_guids = collect_allowed_material_guids(spec_path)
    all_fallback_mat_guids = collect_fallback_text_material_guids(explicit_allowed_mat_guids)
    fallback_allowed_mat_guids = {
        guid: path
        for guid, path in all_fallback_mat_guids.items()
        if any(guid == ref_guid for _, ref_guid in mat_refs)
    }
    allowed_mat_guids = dict(explicit_allowed_mat_guids)
    allowed_mat_guids.update(fallback_allowed_mat_guids)
    common_font_mismatch = sum(1 for _, g in font_asset_refs if common_font_guid and g != common_font_guid)
    allowed_mat_mismatch = sum(1 for fid, g in mat_refs if fid != "0" and g not in allowed_mat_guids)
    font_mismatch_details = sorted({
        f"{guid}"
        for _, guid in font_asset_refs
        if common_font_guid and guid != common_font_guid
    })
    material_mismatch_details = sorted({
        f"{fid}:{guid}"
        for fid, guid in mat_refs
        if fid != "0" and guid not in allowed_mat_guids
    })
    common_font_exact_pass = bool(common_font_guid) and common_font_mismatch == 0
    allowed_mat_pass = bool(allowed_mat_guids) and allowed_mat_mismatch == 0
    text_rect_size = compare_text_rect_sizes(content, spec_path)
    fallback_material_refs = sorted({
        f"{fid}:{guid}"
        for fid, guid in mat_refs
        if guid in fallback_allowed_mat_guids
    })

    checks = {
        "spriteNull": {"count": sprite_null, "pass": sprite_null == 0},
        "raycastTargetOn": {"count": raycast_on, "pass": raycast_on == 0},
        "autoSizeOff": {"count": auto_size_off, "pass": True},
        "defaultFont": {"count": default_font_count, "pass": default_font_count == 0},
        "matNull": {"count": mat_null, "pass": mat_null == 0},
        "commonFontExact": {
            "count": len(font_asset_refs) - common_font_mismatch,
            "mismatch": common_font_mismatch,
            "expectedGuid": common_font_guid,
            "mismatchGuids": font_mismatch_details,
            "pass": common_font_exact_pass,
        },
        "allowedMaterial": {
            "count": len(mat_refs) - allowed_mat_mismatch,
            "mismatch": allowed_mat_mismatch,
            "allowedGuids": allowed_mat_guids,
            "mismatchRefs": material_mismatch_details,
            "pass": allowed_mat_pass,
        },
        "textRectSize": text_rect_size,
    }
    blocking_errors = make_blocking_errors(checks)
    warnings = []
    if len(font_asset_refs) == 0:
        warnings.append({
            "code": "noTmpFontRefs",
            "message": "Prefab 中未检测到 TMP 字体引用；如果设计稿包含文本，需要确认文本是否被正确生成。",
        })
    if fallback_material_refs:
        warnings.append({
            "code": "fallbackCommonFontFigmaMaterial",
            "message": "Prefab 使用了 spec 未声明但命名符合 CommonFont_figma_* 的历史材质，已回退允许并需要人工确认来源。",
            "details": {
                "refs": fallback_material_refs,
                "allowedFallbackGuids": fallback_allowed_mat_guids,
            },
        })

    return {
        "prefabPath": prefab_path,
        "resolvedPrefabPath": str(resolved_prefab_path),
        "unityProjectRoot": str(UNITY_PROJECT_ROOT),
        "prefabSize": resolved_prefab_path.stat().st_size,
        "checks": checks,
        "summary": {
            "totalTmp": len(font_asset_refs),
            "totalMat": len(mat_refs),
            "fontGuids": list(set(g for _, g in font_asset_refs)),
            "matGuids": list(set(g for _, g in mat_refs)),
            "textRectCount": text_rect_size["count"],
            "textRectMismatch": text_rect_size["mismatch"],
            "unityProjectRoot": str(UNITY_PROJECT_ROOT),
            "commonFontMeta": str(COMMON_FONT_META),
            "commonMaterialMeta": str(COMMON_FONT_MAT_META),
            "figmaTextMaterialDir": str(FIGMA_TEXT_MAT_DIR),
        },
        "allPass": len(blocking_errors) == 0,
        "blockingErrors": blocking_errors,
        "warnings": warnings,
        "artifacts": {
            "prefabPath": prefab_path,
            "resolvedPrefabPath": str(resolved_prefab_path),
            "unityProjectRoot": str(UNITY_PROJECT_ROOT),
            "commonFontMeta": str(COMMON_FONT_META),
            "commonMaterialMeta": str(COMMON_FONT_MAT_META),
            "figmaTextMaterialDir": str(FIGMA_TEXT_MAT_DIR),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Unity Prefab YAML 静态验证")
    parser.add_argument("--prefab", required=True, help="Prefab 文件路径")
    parser.add_argument("--spec", default="", help="可选 prefab_spec.json，用于允许本次生成的 TMP 材质")
    parser.add_argument("--json", action="store_true", help="输出 JSON 格式")
    args = parser.parse_args()

    result = verify_prefab(args.prefab, args.spec)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        c = result["checks"]
        PASS = "[PASS]"; FAIL = "[FAIL]"
        print(f"Prefab: {result['prefabPath']} ({result['prefabSize']:,} bytes)")
        print(f"m_Sprite{{fileID:0}}:    {c['spriteNull']['count']:>4} {PASS if c['spriteNull']['pass'] else FAIL}")
        print(f"m_RaycastTarget:1:      {c['raycastTargetOn']['count']:>4} {PASS if c['raycastTargetOn']['pass'] else FAIL}")
        print(f"m_enableAutoSizing:0:   {c['autoSizeOff']['count']:>4} (不阻塞)")
        print(f"TMP default font:       {c['defaultFont']['count']:>4} {PASS if c['defaultFont']['pass'] else FAIL}")
        print(f"m_sharedMaterial:0:     {c['matNull']['count']:>4} {PASS if c['matNull']['pass'] else FAIL}")
        print(f"CommonFont exact:       {c['commonFontExact']['count']:>4} {PASS if c['commonFontExact']['pass'] else FAIL} (mismatch={c['commonFontExact']['mismatch']})")
        print(f"Allowed TMP Mat:        {c['allowedMaterial']['count']:>4} {PASS if c['allowedMaterial']['pass'] else FAIL} (mismatch={c['allowedMaterial']['mismatch']})")
        print(f"Text rect size:         {c['textRectSize']['count']:>4} {PASS if c['textRectSize']['pass'] else FAIL} (mismatch={c['textRectSize']['mismatch']})")
        print(f"\nTMP total: {result['summary']['totalTmp']} | Mat total: {result['summary']['totalMat']}")
        print(f"Font GUIDs: {result['summary']['fontGuids']}")
        print(f"Mat GUIDs: {result['summary']['matGuids']}")
        print(f"\nAll pass: {PASS if result['allPass'] else FAIL}")

    if result.get("error"):
        return 1
    return 0 if result["allPass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
