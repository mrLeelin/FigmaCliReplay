from pathlib import Path
import sys


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from plan_figma_hierarchy_cleanup import reward_marker_ownership_issues
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
