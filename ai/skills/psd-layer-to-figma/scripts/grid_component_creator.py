"""
PSD 网格布局分析 + MCP Relay 提交脚本。

用法:
    python grid_component_creator.py <manifest_summary.json> --root-id <figma_root_id> --relay-url <url>

流程:
    1. 读取 manifest_summary.json 获取图层坐标
    2. 通过 root frame 子节点映射 Figma node ID
    3. 分析 7 日签到网格布局
    4. 提交 CREATE_GRID_COMPONENT 任务到 MCP Relay
"""
import argparse
import json
import sys
from pathlib import Path

# 添加 figmaMcpRelay CLI wrapper 到路径
def find_relay_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "client" / "figma_mcp_client.py").is_file():
            return parent
    raise RuntimeError("Unable to locate the Figma MCP Relay root containing client/figma_mcp_client.py.")


RELAY_ROOT = find_relay_root()
sys.path.insert(0, str(RELAY_ROOT / "client"))
from figma_mcp_client import health as ensure_mcp_companion, submit_grid_component_job

DEFAULT_RELAY_URL = "http://localhost:32130"
DAILY_GRID_Y_RANGE = (1780, 2000)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_daily_grid_analysis(manifest_layers, children_nodes):
    """分析 7 日签到网格，构建 slot 数据。"""
    # 筛选网格区域的层
    grid_layers = [
        l for l in manifest_layers
        if DAILY_GRID_Y_RANGE[0] <= l.get("y", 0) <= DAILY_GRID_Y_RANGE[1]
    ]

    # 按 X 坐标分 7 个 slot（步长 ~133px）
    slots = {}
    for l in grid_layers:
        cx = l["x"] + l["w"] / 2
        slot_idx = round((cx - 77) / 133)  # slot 1 起始 x≈77
        slot_idx = max(0, min(6, slot_idx))
        if slot_idx not in slots:
            slots[slot_idx] = []
        slots[slot_idx].append(l)

    # 构建每个 slot 的详细分析
    bg_variant_map = {
        0: ("bgVariant", "09_ui_daily_yq2", "normal"),
        1: ("bgVariant", "01_ui_daily_yq1", "today"),
    }
    for i in range(2, 7):
        bg_variant_map[i] = ("bgVariant", None, "normal")

    slot_data = []
    for si in sorted(slots.keys()):
        slot_layers = slots[si]
        props = {"dayNumber": "", "isLocked": False, "hasReward": False, "rewardCount": ""}
        node_ids = []
        has_lock = False

        for l in slot_layers:
            name = l["name"]
            raw_idx = l.get("idx", "")
            idx_str = str(raw_idx).zfill(2) if isinstance(raw_idx, (int, float)) else str(raw_idx).zfill(2)
            lx, ly = l.get("x", 0), l.get("y", 0)

            # 匹配策略：优先按名称模式匹配，fallback 到位置匹配
            figma_variants = {
                f"{idx_str}_{name}",          # 普通图片层
                f"{idx_str}_{name}__text",    # 文字层
                f"{idx_str}_{name}__slice",   # 九宫切片层
                name,                         # Instance（如 Common_Texture_Lock）
            }
            actual_node_ids = [n["id"] for n in children_nodes if n.get("name") in figma_variants]

            # Fallback: 如果名称模式没匹配到，用位置匹配（用于 Instance 名不同：Common_Lock vs Common_Texture_Lock）
            if not actual_node_ids:
                actual_node_ids = [
                    n["id"] for n in children_nodes
                    if abs(n.get("x", 0) - lx) <= 5 and abs(n.get("y", 0) - ly) <= 5
                ]

            node_id = actual_node_ids[0] if actual_node_ids else None

            if not node_id:
                continue

            if name == "day":
                node_ids.append({"id": node_id, "key": "constant"})
            elif name in ("ui_daily_yq1", "ui_daily_yq2"):
                node_ids.append({"id": node_id, "key": "bg"})
            elif name.isdigit() and int(name) <= 7:
                props["dayNumber"] = name
                node_ids.append({"id": node_id, "key": "dayNumber"})
            elif name == "ui_mainview_icon_hd":
                props["hasReward"] = True
                node_ids.append({"id": node_id, "key": "hasReward"})
            elif name == "Common_Lock" or name.startswith("Common_"):
                has_lock = True
                node_ids.append({"id": node_id, "key": "isLocked"})
            elif name.isdigit():
                props["rewardCount"] = name
                node_ids.append({"id": node_id, "key": "rewardCount"})

        props["isLocked"] = has_lock

        # bg variant
        _, _, bg_val = bg_variant_map.get(si, ("bgVariant", None, "normal"))
        props["bgVariant"] = bg_val

        # calculate bounds
        xs = [l["x"] for l in slot_layers]
        ys = [l["y"] for l in slot_layers]
        xws = [l["x"] + l["w"] for l in slot_layers]
        yhs = [l["y"] + l["h"] for l in slot_layers]

        slot_data.append({
            "nodes": node_ids,
            "bounds": {
                "x": min(xs) if xs else 0,
                "y": min(ys) if ys else 0,
                "w": max(xws) - min(xs) if xs else 1,
                "h": max(yhs) - min(ys) if ys else 1,
            },
            "properties": props,
        })

    return slot_data


def determine_node_mappings(slot_data):
    """从 slot 分析中提取属性到节点的映射。"""
    text_node_ids = []
    boolean_node_ids = []
    variant_node_id = None

    for slot in slot_data:
        for item in slot["nodes"]:
            key = item.get("key", "")
            if key == "dayNumber":
                if item["id"] not in text_node_ids:
                    text_node_ids.append(item["id"])
            elif key == "rewardCount":
                if item["id"] not in text_node_ids:
                    text_node_ids.append(item["id"])
            elif key == "isLocked":
                if item["id"] not in boolean_node_ids:
                    boolean_node_ids.append(item["id"])
            elif key == "hasReward":
                if item["id"] not in boolean_node_ids:
                    boolean_node_ids.append(item["id"])
            elif key == "bg":
                if variant_node_id is None:
                    variant_node_id = item["id"]

    return {
        "textNodeIds": text_node_ids,
        "booleanNodeIds": boolean_node_ids,
        "variantNodeId": variant_node_id,
    }


def String(value):
    return str(value)


def main():
    parser = argparse.ArgumentParser(description="网格 Component 创建工具")
    parser.add_argument("manifest", type=Path, help="manifest_summary.json 路径")
    parser.add_argument("--root-id", required=True, help="MCP Relay 导入的根 Frame ID")
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL, help="MCP Relay 地址")
    parser.add_argument("--bridge-url", dest="relay_url", default=DEFAULT_RELAY_URL, help=argparse.SUPPRESS)
    parser.add_argument("--component-name", default="C_Daily_Slot", help="Component 名")
    parser.add_argument("--children-json", type=Path, help="根 Frame 子节点 JSON（手动提供）/ 省略时尝试从 manifest 构建")

    args = parser.parse_args()

    manifest = load_json(args.manifest)

    # 读取子节点数据
    if args.children_json:
        children_data = load_json(args.children_json)
        children_nodes = children_data.get("children", children_data) if isinstance(children_data, dict) else children_data
    else:
        # 从 manifest 构建：使用 manifest 的 idx 构建近似匹配
        children_nodes = []
        for l in manifest.get("layers", []):
            children_nodes.append({
                "name": f"{String(l.get('idx', '0')).zfill(2)}_{l['name']}",
                "id": str(l.get("idx", 0)),
                "x": l.get("x", 0),
                "y": l.get("y", 0),
            })

    # 分析网格
    slot_data = build_daily_grid_analysis(manifest.get("layers", []), children_nodes)
    mappings = determine_node_mappings(slot_data)

    # 如果没有提供真实节点 ID（只有 idx），构建虚拟映射
    if not args.children_json:
        print(json.dumps({
            "warning": "No --children-json provided, using manifest idx as placeholder",
            "note": "Run MCP query_frames first to get real node IDs, then pass --children-json",
            "slotAnalysis": slot_data,
            "mappings": mappings,
        }, ensure_ascii=False, indent=2))
        return

    # 构建 propertyDefs
    property_defs = {
        "bgVariant": {"type": "VARIANT", "defaultValue": "normal", "values": ["today", "normal"]},
        "dayNumber": {"type": "TEXT", "defaultValue": "1"},
        "isLocked": {"type": "BOOLEAN", "defaultValue": False},
        "hasReward": {"type": "BOOLEAN", "defaultValue": False},
        "rewardCount": {"type": "TEXT", "defaultValue": "0"},
    }

    # 提交到 MCP Relay
    ensure_mcp_companion(args.relay_url)
    result = submit_grid_component_job(
        relay_url=args.relay_url,
        root_node_id=args.root_id,
        component_name=args.component_name,
        slots=slot_data,
        property_defs=property_defs,
        boolean_node_ids=mappings["booleanNodeIds"],
        text_node_ids=mappings["textNodeIds"],
        variant_node_id=mappings["variantNodeId"],
        reference_slot_index=0,
    )

    print(json.dumps({
        "status": result.get("status", "ok"),
        "componentId": result.get("componentId", ""),
        "componentName": result.get("componentName", ""),
        "instanceCount": result.get("instanceCount", 0),
        "properties": result.get("properties", []),
        "instances": result.get("instances", []),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
