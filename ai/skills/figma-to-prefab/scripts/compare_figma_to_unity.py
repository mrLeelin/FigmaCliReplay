#!/usr/bin/env python3
"""
Figma → Unity 差异对比器

输入: Relay analyze 结果 + Unity Prefab 路径
输出: 差异报告 + 路径判定 (lightweight / lightweight+images / full)
"""

import argparse, json, os, re, sys, hashlib
from pathlib import Path

# ── Prefab 解析 ──────────────────────────────────────────

def parse_prefab(prefab_path):
    """从 Unity Prefab YAML 中提取所有节点的 name / sizeDelta / anchoredPosition / Sprite GUID"""
    text = Path(prefab_path).read_text(encoding="utf-8", errors="replace")

    # 提取所有 GameObject → fileID 映射
    go_map = {}
    for m in re.finditer(r'--- !u!1 &(\d+)\s+GameObject:.*?\n  m_Name: (.+)', text, re.DOTALL):
        go_map[m.group(1)] = m.group(2)

    # 提取所有 RectTransform
    rt_blocks = re.findall(
        r'--- !u!224 &(\d+)\s+RectTransform:.*?'
        r'm_GameObject: \{fileID: (\d+)\}.*?'
        r'm_AnchoredPosition: \{x: ([\d.-]+), y: ([\d.-]+)\}.*?'
        r'm_SizeDelta: \{x: ([\d.-]+), y: ([\d.-]+)\}',
        text, re.DOTALL
    )

    # 提取父子关系
    children_map = {}
    for m in re.finditer(
        r'--- !u!224 &(\d+)\s+RectTransform:.*?'
        r'm_Children:.*?\n((?:\s*- \{fileID: \d+\}\s*\n)*)',
        text, re.DOTALL
    ):
        fid = m.group(1)
        child_ids = re.findall(r'fileID: (\d+)', m.group(2))
        children_map[fid] = child_ids

    # 提取 Sprite 引用
    sprite_map = {}
    for m in re.finditer(
        r'm_GameObject: \{fileID: (\d+)\}.*?'
        r'm_Sprite: \{fileID: \d+, guid: ([a-f0-9]+), type: \d+\}',
        text, re.DOTALL
    ):
        sprite_map[m.group(1)] = m.group(2)

    # 提取 TMP 文本
    text_map = {}
    for m in re.finditer(
        r'm_GameObject: \{fileID: (\d+)\}.*?'
        r'm_text: (.+?)\n\s+m_isRightToLeft:',
        text, re.DOTALL
    ):
        raw = m.group(2).strip()
        if raw.startswith("'") and raw.endswith("'"):
            raw = raw[1:-1]
        text_map[m.group(1)] = raw

    # 提取颜色
    color_map = {}
    for m in re.finditer(
        r'm_GameObject: \{fileID: (\d+)\}.*?'
        r'm_fontColor:\s*\n\s+r: ([\d.]+)\s*\n\s+g: ([\d.]+)\s*\n\s+b: ([\d.]+)\s*\n\s+a: ([\d.]+)',
        text, re.DOTALL
    ):
        color_map[m.group(1)] = {
            'r': float(m.group(2)), 'g': float(m.group(3)),
            'b': float(m.group(4)), 'a': float(m.group(5))
        }

    # 组装节点列表
    nodes = {}
    for fid, go_id, ax, ay, sx, sy in rt_blocks:
        name = go_map.get(go_id, f'Unknown_{go_id}')
        node = {
            'name': name,
            'x': float(ax),
            'y': float(ay),
            'w': float(sx),
            'h': float(sy),
            'spriteGuid': sprite_map.get(go_id, None),
            'text': text_map.get(go_id, None),
            'color': color_map.get(go_id, None),
        }
        nodes[name] = node

    return nodes


# ── Relay analyze 结果解析 ───────────────────────────────

def parse_mcp_analysis(analysis_path):
    """从 figma-hierarchy-cleanup 的 analysis_result.json 提取节点信息"""
    data = json.loads(Path(analysis_path).read_text(encoding="utf-8"))

    result = data.get('result', data)
    nodes_list = result.get('nodes', [])

    nodes = {}
    for n in nodes_list:
        # 提取相对坐标（relativeBounds 或 bounds 相对于 root）
        rb = n.get('relativeBounds', n.get('bounds', {}))
        nodes[n['name']] = {
            'name': n['name'],
            'id': n.get('id', ''),
            'type': n.get('type', ''),
            'x': rb.get('x', 0),
            'y': rb.get('y', 0),
            'w': rb.get('width', 0),
            'h': rb.get('height', 0),
            'visible': n.get('visible', True),
            'childCount': n.get('childCount', 0),
        }

    return nodes


# ── 差异计算 ──────────────────────────────────────────────

def compute_diff(unity_nodes, figma_nodes, image_hashes):
    """对比 Unity ↔ Figma，返回差异报告"""
    unity_names = set(unity_nodes.keys())
    figma_names = set(figma_nodes.keys())

    added = figma_names - unity_names
    removed = unity_names - figma_names
    common = unity_names & figma_names

    position_changes = []
    size_changes = []
    image_changes = []
    other_changes = []

    for name in sorted(common):
        u = unity_nodes[name]
        f = figma_nodes[name]

        # 位置变化（容差 0.5px）
        if abs(u['x'] - f['x']) > 0.5 or abs(u['y'] - f['y']) > 0.5:
            position_changes.append({
                'name': name,
                'unity_x': u['x'], 'unity_y': u['y'],
                'figma_x': f['x'], 'figma_y': f['y'],
            })

        # 尺寸变化（容差 0.5px）
        if abs(u['w'] - f['w']) > 0.5 or abs(u['h'] - f['h']) > 0.5:
            size_changes.append({
                'name': name,
                'unity_w': u['w'], 'unity_h': u['h'],
                'figma_w': f['w'], 'figma_h': f['h'],
            })

    # 图片哈希变化
    for img_info in image_hashes:
        name = img_info.get('nodeName', '')
        if name in common:
            # 这里需要 Unity 侧图片 MD5 与 Figma 侧 imageHash 对比
            # 简化版：由 process_images.py 报告
            pass

    return {
        'added': sorted(added),
        'removed': sorted(removed),
        'position_changes': position_changes,
        'size_changes': size_changes,
        'image_changes': image_changes,
    }


def verdict(diff):
    """根据差异判定走哪条链路"""
    has_structure_change = len(diff['added']) > 0 or len(diff['removed']) > 0
    has_image_change = len(diff.get('image_changes', [])) > 0
    has_position_or_size = len(diff['position_changes']) > 0 or len(diff['size_changes']) > 0

    if has_structure_change:
        return 'full', '节点数量或层级结构变化，必须完整链路'
    elif has_image_change and has_position_or_size:
        return 'lightweight+images', '图片变更 + 位置/尺寸变更'
    elif has_image_change:
        return 'lightweight+images', '仅图片变更'
    elif has_position_or_size:
        return 'lightweight', '仅位置/尺寸变更'
    else:
        return 'none', '无差异'


# ── 报告输出 ──────────────────────────────────────────────

def output_report(diff, verdict_label, reason, output_path):
    """生成结构化差异报告 JSON"""
    report = {
        'allPass': True,
        'blockingErrors': [],
        'verdict': verdict_label,
        'reason': reason,
        'summary': {
            'addedCount': len(diff['added']),
            'removedCount': len(diff['removed']),
            'positionChanges': len(diff['position_changes']),
            'sizeChanges': len(diff['size_changes']),
            'imageChanges': len(diff.get('image_changes', [])),
        },
        'diff': diff,
        'steps': {
            'none': [],
            'lightweight': ['roslyn_modify_prefab'],
            'lightweight+images': ['process_images', 'assetdatabase_refresh', 'roslyn_modify_prefab'],
            'full': ['mcp_relay_export', 'gen_spec', 'process_images', 'assetdatabase_refresh', 'generate_prefab', 'verify'],
        }.get(verdict_label, []),
    }
    Path(output_path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


# ── CLI ───────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Figma → Unity 差异对比')
    parser.add_argument('--figma-analysis', required=True, help='Relay analyze 结果 JSON')
    parser.add_argument('--prefab', required=True, help='Unity Prefab 路径')
    parser.add_argument('--output', default='.tmp/compare_report.json', help='输出路径')
    args = parser.parse_args()

    unity_nodes = parse_prefab(args.prefab)
    figma_nodes = parse_mcp_analysis(args.figma_analysis)

    # 图片哈希（如果有 image_export_manifest）
    # 当前从 analysis_result 中不直接含 image hash，如需要可传额外参数

    diff = compute_diff(unity_nodes, figma_nodes, [])
    v, reason = verdict(diff)
    output_report(diff, v, reason, args.output)


if __name__ == '__main__':
    main()
