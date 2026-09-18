#!/usr/bin/env python3
"""
figma_analyze_reader.py — 一次性提取 Figma hierarchy analyze 结果的关键信息。

问题背景：
  FIGMA_HIERARCHY_CLEANUP_ANALYZE 返回的 JSON 通常超过 500K tokens（~800KB），
  Read 工具无法直接读取。传统做法需要写多个迭代脚本探查数据结构，非常耗时。

解决方案：
  本脚本在单个 python 命令中一次提取所有关键信息到小型文本文件（<50KB），
  然后直接用 Read 工具读取。全程不需要写临时脚本或反复探查。

用法：
    python <relay-root>/ai/skills/figma-hierarchy-cleanup/scripts/figma_analyze_reader.py ^
        --input .tmp/figma-hierarchy-cleanup/analysis_result.json ^
        [--output .tmp/figma-hierarchy-cleanup/analysis_summary.txt] ^
        [--mode all]

参数：
    --input PATH      analyze 结果 JSON 路径（必填）
    --output PATH     输出文本路径（选填，默认 stdout）
    --mode MODE       输出模式（选填，默认 all）
                      all      = 所有内容（完整报告）
                      children = 仅直接子节点表
                      tree     = 仅层级树
                      stats    = 仅节点统计

输出内容：
    1. 根节点摘要（名称、类型、尺寸、节点数）
    2. 直接子节点顺序表（按 Figma index / Z-order）
    3. 直接子节点按 Y 坐标排序（空间布局）
    4. 完整层级树（如果有 hierarchy 字段）
    5. 节点类型统计
    6. 内层冗余包装检测（directChildCount==1 且子节点同尺寸 Frame）
    7. 按 parentId 组织的完整嵌套结构（全部 200+ 节点）

示例：
    # 生成完整摘要到文件
    python <relay-root>/ai/skills/figma-hierarchy-cleanup/scripts/figma_analyze_reader.py ^
        --input .tmp/figma-hierarchy-cleanup/analysis_result.json ^
        --output .tmp/figma-hierarchy-cleanup/analysis_summary.txt

    # 只查看直接子节点表（到标准输出）
    python <relay-root>/ai/skills/figma-hierarchy-cleanup/scripts/figma_analyze_reader.py ^
        --input .tmp/figma-hierarchy-cleanup/analysis_result.json ^
        --mode children
"""

import json
import os
import sys
import argparse
from pathlib import Path


def find_relay_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "client" / "figma_relay_cli.py").is_file():
            return parent
    raise RuntimeError("Unable to locate the Figma Relay root containing client/figma_relay_cli.py.")


def resolve_relay_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    return path.resolve() if path.is_absolute() else (find_relay_root() / path).resolve()


def load_result(path: str) -> dict:
    """加载 analyze 结果 JSON，自动定位到 result 字段"""
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    # 处理嵌套结构: result 可能在 data['result'] 下
    if isinstance(raw, dict):
        if "result" in raw and isinstance(raw["result"], dict):
            if "nodes" in raw["result"] or "directChildren" in raw["result"]:
                return raw["result"]
        if "nodes" in raw or "directChildren" in raw:
            return raw
    # 递归查找
    def find_result(obj, depth=0):
        if depth > 10:
            return None
        if isinstance(obj, dict):
            if "nodes" in obj or "directChildren" in obj:
                return obj
            for v in obj.values():
                r = find_result(v, depth + 1)
                if r:
                    return r
        elif isinstance(obj, list):
            for v in obj[:5]:
                r = find_result(v, depth + 1)
                if r:
                    return r
        return None
    found = find_result(raw)
    if found:
        return found
    return raw


def extract_direct_children(result: dict) -> list:
    """提取直接子节点列表"""
    children = result.get("directChildren", [])
    if children:
        return children
    # 从 nodes 重建: 找出 parentId == rootNodeId 的节点
    nodes = result.get("nodes", [])
    root_id = result.get("rootNodeId", "")
    if nodes and root_id:
        root_kids = [n for n in nodes if n.get("parentId") == root_id]
        root_kids.sort(key=lambda x: x.get("index", 0))
        return root_kids
    return []


def get_children_by_parent(nodes: list) -> dict:
    """按 parentId 组织节点"""
    by_parent = {}
    for n in nodes:
        pid = n.get("parentId", "")
        by_parent.setdefault(pid, []).append(n)
    for pid in by_parent:
        by_parent[pid].sort(key=lambda x: x.get("index", 0))
    return by_parent


def fmt_bounds(b: dict) -> str:
    x = b.get("x", "?")
    y = b.get("y", "?")
    w = b.get("width", "?")
    h = b.get("height", "?")
    return f"({x},{y}) {w}x{h}"


def same_size_bounds(a: dict, b: dict) -> bool:
    return a.get("width") == b.get("width") and a.get("height") == b.get("height")


def build_action_summary(result: dict, children: list, by_parent: dict) -> list:
    root_name = result.get("rootName", "?")
    root_type = result.get("nodeType", "?")
    root_id = result.get("rootNodeId", "?")
    root_bounds = result.get("rootBounds", {})
    dc_count = result.get("directChildCount", len(children))
    lines = [
        "ACTION_SUMMARY",
        f"rootId: {root_id}",
        f"rootName: {root_name}",
        f"rootType: {root_type}",
        f"rootBounds: {fmt_bounds(root_bounds)}",
        f"directChildCount: {dc_count}",
        f"nodeCount: {len(result.get('nodes', []))}",
        "action: READ_SUMMARY_ONLY",
    ]
    if dc_count == 1 and children:
        only_child = children[0]
        child_id = only_child.get("id", "?")
        child_name = only_child.get("name", "?")
        child_type = only_child.get("type", "?")
        child_bounds = only_child.get("bounds", {})
        child_count = len(by_parent.get(child_id, []))
        lines.extend([
            "singleChild: true",
            f"singleChildId: {child_id}",
            f"singleChildName: {child_name}",
            f"singleChildType: {child_type}",
            f"singleChildBounds: {fmt_bounds(child_bounds)}",
            f"singleChildDirectChildCount: {child_count}",
        ])
        if child_type == "FRAME" and same_size_bounds(child_bounds, root_bounds):
            lines.append("action: ANALYZE_INNER_CHILD")
            lines.append(f"nextTargetNodeId: {child_id}")
    lines.append("")
    return lines


def generate_report(result: dict, mode: str = "brief", max_children: int = 80) -> list:
    """生成文本报告"""
    lines = []
    root_name = result.get("rootName", "?")
    root_type = result.get("nodeType", "?")
    root_id = result.get("rootNodeId", "?")
    root_bounds = result.get("rootBounds", {})
    dc_count = result.get("directChildCount", 0)
    nodes = result.get("nodes", [])
    by_parent = get_children_by_parent(nodes)
    children = extract_direct_children(result)

    if mode in ("all", "children", "brief"):
        lines.extend(build_action_summary(result, children, by_parent))

    # ==================== 根节点摘要 ====================
    if mode in ("all",):
        lines.append("=" * 72)
        lines.append(f"  根节点: {root_name} ({root_id})")
        lines.append(f"  类型:   {root_type}")
        lines.append(f"  尺寸:   {fmt_bounds(root_bounds)}")
        lines.append(f"  直接子节点数: {dc_count}")
        lines.append(f"  总节点数: {len(nodes)}")
        lines.append("=" * 72)
        lines.append("")

    # ==================== 内层冗余包装检测 ====================
    if mode in ("all",):
        if dc_count == 1 and children:
            only_child = children[0]
            if only_child.get("type") == "FRAME":
                cb = only_child.get("bounds", {})
                rb = root_bounds
                same_size = same_size_bounds(cb, rb)
                inner_id = only_child.get("id", "?")
                inner_name = only_child.get("name", "?")
                inner_kids = by_parent.get(inner_id, [])
                if same_size:
                    lines.append("⚠️  检测到内层冗余包装框架!")
                    lines.append(f"    外层: {root_name} ({root_id})")
                    lines.append(f"    内层: {inner_name} ({inner_id})")
                    lines.append(f"    内层子节点数: {len(inner_kids)}")
                    lines.append(f"    建议: 将此内层 Frame 重命名为 [Content] 作为操作目标")
                    lines.append("")
            lines.append("")

    # ==================== 直接子节点顺序表 (Z-order) ====================
    if mode in ("all", "children"):
        lines.append("=" * 72)
        lines.append("DIRECT_CHILDREN_BY_INDEX (later sibling renders above earlier sibling)")
        lines.append("=" * 72)
        header = f"{'Idx':<6} {'Visible':<8} {'Type':<18} {'ChildCnt':<10} {'Name'}"
        lines.append(header)
        lines.append("-" * 72)
        visible_children = children if mode == "all" else children[:max_children]
        for i, c in enumerate(visible_children):
            name = c.get("name", "?")
            tp = c.get("type", "?")
            visible = c.get("visible", True)
            b = c.get("bounds", {})
            cc = c.get("childCount", 0)
            mark = " [H]" if not visible else ""
            lines.append(
                f"[{i:<4}] {'Y' if visible else 'N':<8} {tp:<18} {str(cc):<10} \"{name}\" {fmt_bounds(b)}{mark}"
            )
        lines.append("")
        if len(children) > len(visible_children):
            lines.append(f"childrenTruncated: true ({len(visible_children)}/{len(children)})")
            lines.append("use --mode all or increase --max-children only when full direct-child detail is required")
            lines.append("")

        # ==================== 按 Y 排序 ====================
        if children:
            lines.append("=" * 72)
            lines.append("Y_ORDER (top to bottom)")
            lines.append("=" * 72)
            lines.append(f"{'Idx':<6} {'Y':<8} {'Type':<18} {'Name'}")
            lines.append("-" * 72)
            sorted_by_y = sorted(
                enumerate(children), key=lambda x: x[1].get("bounds", {}).get("y", 0)
            )
            sorted_visible = sorted_by_y if mode == "all" else sorted_by_y[:max_children]
            for orig_idx, c in sorted_visible:
                name = c.get("name", "?")
                tp = c.get("type", "?")
                y = c.get("bounds", {}).get("y", "?")
                lines.append(f"[{orig_idx:<4}] y={str(y):<6} {tp:<18} \"{name}\"")
            lines.append("")
            if len(sorted_by_y) > len(sorted_visible):
                lines.append(f"yOrderTruncated: true ({len(sorted_visible)}/{len(sorted_by_y)})")
                lines.append("")

    # ==================== 按 Parent 组织的嵌套结构 ====================
    if mode in ("all", "tree"):
        lines.append("=" * 72)
        lines.append("TREE_BY_PARENT_ID")
        lines.append("=" * 72)
        lines.append("")

        def print_tree(node_id, depth=0, visited=None):
            if visited is None:
                visited = set()
            if node_id in visited or depth > 20:
                return []
            visited.add(node_id)
            out = []
            kids = by_parent.get(node_id, [])
            node = next((n for n in nodes if n["id"] == node_id), None)
            if node_id == root_id:
                prefix = ""
            else:
                prefix = "  " * depth
            for c in kids:
                name = c.get("name", "?")
                tp = c.get("type", "?")
                cid = c.get("id", "?")
                vis = c.get("visible", True)
                cc = c.get("childCount", 0)
                b = c.get("bounds", {})
                hide_str = " [H]" if not vis else ""
                child_str = f" [{cc}c]" if cc > 0 else ""
                out.append(
                    f"{prefix}[{cid}] {name} ({tp}){hide_str}{child_str} {fmt_bounds(b)}"
                )
                if cc > 0:
                    out.extend(print_tree(cid, depth + 1, visited))
            return out

        # 从 root 开始逐层打印
        tree_lines = print_tree(root_id)
        lines.extend(tree_lines)
        if not tree_lines:
            # 尝试从 hierarchy 打印
            hierarchy = result.get("hierarchy", {})
            if hierarchy:
                def print_hierarchy(node, depth=0):
                    out = []
                    p = "  " * depth
                    name = node.get("name", "?")
                    tp = node.get("type", "?")
                    nid = node.get("id", "?")
                    vis = node.get("visible", True)
                    kids = node.get("children", [])
                    b = node.get("bounds", {})
                    hide_str = " [H]" if not vis else ""
                    child_str = f" [{len(kids)}c]" if kids else ""
                    out.append(f"{p}[{nid}] {name} ({tp}){hide_str}{child_str} {fmt_bounds(b)}")
                    for k in kids:
                        out.extend(print_hierarchy(k, depth + 1))
                    return out
                lines.extend(print_hierarchy(hierarchy))

        lines.append("")

    # ==================== 节点类型统计 ====================
    if mode in ("all", "stats", "brief"):
        lines.append("━" * 72)
        lines.append("  节点类型统计")
        lines.append("━" * 72)
        type_count = {}
        for n in nodes:
            tp = n.get("type", "?")
            type_count[tp] = type_count.get(tp, 0) + 1
        for tp, cnt in sorted(type_count.items(), key=lambda x: -x[1]):
            lines.append(f"  {tp:<20} {cnt}")
        lines.append("")

    # ==================== Top-Level 分组摘要 ====================
    if mode in ("all",):
        tlg = result.get("topLevelGroups", [])
        if tlg:
            lines.append("━" * 72)
            lines.append("  Top-Level 分组摘要")
            lines.append("━" * 72)
            for g in tlg:
                name = g.get("name", "?")
                tp = g.get("type", "?")
                gid = g.get("id", "?")
                cc = g.get("childCount", 0)
                b = g.get("bounds", {})
                lines.append(f"  [{gid}] {name} ({tp}) {cc}c {fmt_bounds(b)}")
            lines.append("")

    # ==================== 特定 parent 的子节点查询 ====================
    # 展示按 parent 分组后的每个父级子节点数量
    if mode in ("all",):
        lines.append("━" * 72)
        lines.append("  各父级节点子节点数分布")
        lines.append("━" * 72)
        pid_counts = [(pid, len(kids)) for pid, kids in sorted(by_parent.items(), key=lambda x: -len(x[1]))]
        for pid, cnt in pid_counts:
            parent_node = next((n for n in nodes if n["id"] == pid), None)
            pname = parent_node.get("name", "?") if parent_node else "?"
            lines.append(f"  [{pid}] {pname}: {cnt} 个子节点")
        lines.append("")

    return lines


def main():
    parser = argparse.ArgumentParser(
        description="一次性提取 Figma hierarchy analyze 结果的关键信息"
    )
    parser.add_argument("--input", required=True, help="analyze 结果 JSON 路径")
    parser.add_argument("--output", help="输出文本路径（默认 stdout）")
    parser.add_argument(
        "--mode",
        default="brief",
        choices=["brief", "all", "children", "tree", "stats"],
        help="输出模式",
    )
    parser.add_argument("--max-children", type=int, default=80, help="Limit children/Y-order rows in --mode children; --mode all is unbounded")
    args = parser.parse_args()

    input_path = resolve_relay_path(args.input)
    output_path = resolve_relay_path(args.output) if args.output else None
    if not input_path.exists():
        print(f"ERROR: 文件不存在: {input_path}", file=sys.stderr)
        sys.exit(1)

    result = load_result(str(input_path))
    lines = generate_report(result, args.mode, max(0, args.max_children))

    output = "\n".join(lines)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("w", encoding="utf-8") as f:
            f.write(output)
        file_size = output_path.stat().st_size
        print(f"摘要已写入: {output_path}")
        print(f"文件大小: {file_size:,} bytes ({len(lines)} 行)")
    else:
        print(output)


if __name__ == "__main__":
    main()
