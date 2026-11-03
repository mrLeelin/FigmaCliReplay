"""共享命名工具函数：供 gen_spec.py、process_images.py 等脚本引用，保持命名一致。"""

import re


_CN_TOKEN_MAP = {
    "7日": "SevenDay",
    "七日": "SevenDay",
    "任务": "Task",
    "拆分": "",
}


def sanitize_name(name):
    """清洗节点名为合法文件名：去空格、去 Figma 数字排序前缀、去特殊字符。"""
    name = re.sub(r"^\d+\s*[-_—–]+\s*", "", str(name or "").strip())
    name = extract_identifier_name(name)
    name = name.replace(" ", "_")
    # 去掉 Figma 图层排序编号前缀（如 "96_StickerPack" → "StickerPack"）
    name = re.sub(r"^\d+\s*[-_—–]+\s*", "", name)
    return re.sub(r"[^\w\-_.]", "", name)[:80]


def normalize_unity_display_name(name):
    """保留标识名，去掉 Figma 排序前缀和附加说明，不翻译中文名。"""
    name = strip_outer_brackets(name)
    name = re.sub(r"^\d+\s*[-_—–]+\s*", "", name)
    return extract_identifier_name(name) or "Node"


def strip_outer_brackets(name):
    """移除节点名最外层方括号。"""
    if not name:
        return ""
    name = str(name).strip()
    while name.startswith("[") and name.endswith("]"):
        name = name[1:-1].strip()
    return name


def extract_identifier_name(name):
    """去掉外层括号和竖线后的说明，不翻译或改写标识本身。"""
    value = strip_outer_brackets(name)
    return strip_outer_brackets(re.split(r"[｜|]", value, maxsplit=1)[0].strip())


def clamp(value, minimum, maximum):
    """把浮点值限制在指定区间内。"""
    return max(minimum, min(maximum, value))


def unity_node_name(raw_name, is_root, prefab_name, has_children=False):
    """只有实际保留子节点的物体加方括号，根物体采用相同规则。"""
    name = normalize_unity_display_name(prefab_name if is_root else raw_name)
    return f"[{name}]" if has_children else name


def infer_prefab_name_from_figma_root(root_name, prefix="UI"):
    """Infer a formal Unity Prefab name from a Figma root node name."""
    value = extract_identifier_name(root_name)
    value = re.sub(r"[_\-\s]+", "_", value).strip("_")
    raw_parts = [part for part in value.split("_") if part]
    parts = []
    for raw in raw_parts:
        if raw.lower() in {"psd", "import", "rerun"}:
            continue
        token = raw
        for cn, en in _CN_TOKEN_MAP.items():
            token = token.replace(cn, en)
        token = re.sub(r"[^\w]", "", token)
        if not token:
            continue
        if re.fullmatch(r"[A-Za-z0-9]+", token):
            parts.append(token[:1].upper() + token[1:])
        else:
            parts.append(token)
    stem = "".join(parts) or "FigmaImport"
    return f"{prefix}_{stem}" if prefix else stem


def is_placeholder_prefab_name(name):
    """Return True for benchmark/test placeholder Prefab names."""
    return bool(re.fullmatch(r"(?i)(Import|Test|Prefab)_?\d*", str(name or "").strip()))
