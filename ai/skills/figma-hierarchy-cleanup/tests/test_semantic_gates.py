from pathlib import Path
import sys


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from plan_figma_hierarchy_cleanup import reward_marker_ownership_issues, semantic_depth_issues
from verify_figma_hierarchy_cleanup import verify


def node(node_id, name, index=0, parent_id="root"):
    return {
        "id": node_id,
        "name": name,
        "index": index,
        "parentId": parent_id,
        "bounds": {"x": index * 10, "y": index * 20, "width": 100, "height": 40},
    }


def test_verify_blocks_item_groups_without_scrollview_chain():
    before = {
        "rootNodeId": "root",
        "rootName": "[TaskList]",
        "directChildren": [node("1", "row_bg", 0), node("2", "row_text", 1)],
    }
    after = {
        "status": "completed",
        "allPass": True,
        "rootNodeId": "root",
        "originalNodesAfter": [node("1", "row_bg", 0, "item1"), node("2", "row_text", 1, "item1")],
        "topLevelGroups": [{"id": "item1", "name": "[Item_01]"}],
        "screenshot": {"path": "out.png"},
    }
    plan = {
        "target": {"nodeId": "root", "name": "[TaskList]"},
        "groups": [{"name": "[Item_01]", "childNodeIds": ["1", "2"], "childNames": ["row_bg", "row_text"]}],
    }

    report = verify(before, after, plan)

    assert not report["allPass"]
    assert "scrollViewChainMissing" in [error["code"] for error in report["blockingErrors"]]


def test_verify_allows_item_groups_inside_existing_content():
    before = {
        "rootNodeId": "root",
        "rootName": "[Content]",
        "directChildren": [node("1", "row_bg", 0), node("2", "row_text", 1)],
    }
    after = {
        "status": "completed",
        "allPass": True,
        "rootNodeId": "root",
        "originalNodesAfter": [node("1", "row_bg", 0, "item1"), node("2", "row_text", 1, "item1")],
        "topLevelGroups": [{"id": "item1", "name": "[Item_01]"}],
        "screenshot": {"path": "out.png"},
    }
    plan = {
        "target": {"nodeId": "root", "name": "[Content]"},
        "groups": [{"name": "[Item_01]", "childNodeIds": ["1", "2"], "childNames": ["row_bg", "row_text"]}],
    }

    report = verify(before, after, plan)

    assert report["allPass"], report["blockingErrors"]


def test_progress_marker_under_track_is_planner_issue():
    children = [
        node("1", "34_jiugong_daily_jdtbig2__slice", 0),
        node("2", "39_ui_daily_jdtbig3", 1),
        node("3", "reward_icon", 2),
    ]
    groups = [
        {"name": "[ProgressTrack]", "childNodeIds": ["1", "2"], "sourceIndices": [0, 1]},
        {"name": "[RewardSlot_04]", "childNodeIds": ["3"], "sourceIndices": [2]},
    ]

    issues = reward_marker_ownership_issues(groups, children)

    assert [issue["code"] for issue in issues] == ["progressMarkerNotInRewardSlot"]


def test_geometry_groups_are_not_misclassified_as_lists_from_another_group():
    children = []
    groups = []
    for group_index, group_name in enumerate(("[Header]", "[List]", "[Content]", "[Actions]")):
        child_ids = []
        for index in range(6):
            node_id = f"{group_index}-{index}"
            child_ids.append(node_id)
            children.append({
                **node(node_id, f"layer_{group_index}_{index}", index + group_index * 10),
                "bounds": {"x": 0, "y": group_index * 100, "width": 240, "height": 40},
            })
        groups.append({"name": group_name, "childNodeIds": child_ids, "sourceIndices": list(range(group_index * 10, group_index * 10 + 6))})

    assert semantic_depth_issues(groups, children) == []


def test_explicit_list_root_still_requires_item_structure():
    children = [
        {**node(f"item-{index}", f"row_{index}", index), "bounds": {"x": 0, "y": index * 60, "width": 240, "height": 40}}
        for index in range(6)
    ]
    groups = [{"name": "[ListRoot]", "childNodeIds": [item["id"] for item in children], "sourceIndices": list(range(6))}]

    assert [issue["code"] for issue in semantic_depth_issues(groups, children)] == ["needsListItemSplit"]
