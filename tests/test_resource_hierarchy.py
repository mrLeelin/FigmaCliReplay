from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "ai/skills/image-layer-to-figma/scripts"
spec = importlib.util.spec_from_file_location("resource_hierarchy", SCRIPTS / "structure_resources.py")
hierarchy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hierarchy)


def case(directory):
    image = Path(directory) / "before.png"
    Image.new("RGBA", (200, 100), (12, 35, 70, 255)).save(image)
    boxes = [("bg", 0, 0, 200, 100), ("a", 10, 10, 20, 20), ("b", 110, 10, 20, 20),
             ("caption-a", 10, 40, 20, 10), ("caption-b", 110, 40, 20, 10)]
    nodes = []
    for index, (key, x, y, width, height) in enumerate(boxes):
        bounds = {"x": x, "y": y, "width": width, "height": height}
        nodes.append({"id": key, "parentId": "R", "name": key, "type": "RECTANGLE", "index": index,
                      "bounds": bounds, "relativeBounds": bounds.copy(), "childCount": 0,
                      "visible": True, "opacity": 1})
    root = {"id": "R", "parentId": "P", "name": "Store", "type": "FRAME", "index": 0,
            "bounds": {"x": 0, "y": 0, "width": 200, "height": 100}, "childCount": 5, "visible": True, "opacity": 1}
    analysis = {"status": "completed", "rootNodeId": "R", "rootName": "Store", "fileKey": "file",
                "rootBounds": root["bounds"].copy(), "directChildren": nodes,
                "nodes": [root, *deepcopy(nodes)], "screenshot": {"path": str(image)}}
    plan = {"schemaVersion": 1, "target": {"fileKey": "file", "pageId": "P", "nodeId": "R"},
            "children": [{"nodeId": "bg"}, {"name": "[Benefits_Layout]", "layoutIntent": "static-horizontal", "children": [
                {"name": "[Item_01]", "children": [{"nodeId": "a"}, {"nodeId": "caption-a"}]},
                {"name": "[Item_02]", "children": [{"nodeId": "b"}, {"nodeId": "caption-b"}]},
            ]}]}
    return plan, analysis


def apply_operations(analysis, operations):
    """Model existing CREATE_GROUP insertion semantics, without altering leaf pixels."""
    data = deepcopy(analysis)
    nodes = {node["id"]: node for node in data["nodes"]}
    children = {key: [node["id"] for node in sorted(nodes.values(), key=lambda item: item["index"])
                      if node.get("parentId") == key] for key in nodes}
    created, results = {}, []
    for ordinal, operation in enumerate(operations):
        parent = operation.get("parentNodeId") or created[operation["parentOperationId"]]
        source = operation["childNodeIds"]
        first = min(children[parent].index(key) for key in source)
        key = f"created-{ordinal}"
        group_boxes = [nodes[child]["bounds"] for child in source]
        x = min(box["x"] for box in group_boxes)
        y = min(box["y"] for box in group_boxes)
        right = max(box["x"] + box["width"] for box in group_boxes)
        bottom = max(box["y"] + box["height"] for box in group_boxes)
        nodes[key] = {"id": key, "parentId": parent, "type": "FRAME", "name": operation["name"],
                      "visible": True, "opacity": 1, "childCount": len(source), "index": first,
                      "bounds": {"x": x, "y": y, "width": right-x, "height": bottom-y}}
        children[parent] = [child for child in children[parent] if child not in source]
        children[parent].insert(first, key)
        children[key] = source.copy()
        for child in source:
            nodes[child]["parentId"] = key
        created[operation["id"]] = key
        results.append({"id": operation["id"], "type": "CREATE_GROUP", "createdNodeId": key})
    for parent, ids in children.items():
        nodes[parent]["childCount"] = len(ids)
        for index, key in enumerate(ids):
            nodes[key]["index"] = index
    data["nodes"] = list(nodes.values())
    data["directChildren"] = [nodes[key] for key in children["R"]]
    return data, results


class Backend:
    def __init__(self, before, timeout_once=False):
        self.before = before
        self.after = None
        self.writes = []
        self.timeout_once = timeout_once
        self.reads = 0
        self.recovered = []
        self.snapshot_changed = False
        self.snapshot_mutation = None

    def analyze(self, _):
        self.reads += 1
        return deepcopy(self.before if self.after is None else self.after)

    def snapshot(self, _):
        nodes = []
        by_id = {node["id"]: node for node in self.before["nodes"]}
        for original in self.before["nodes"]:
            box = original["bounds"].copy()
            if original["id"] == "R":
                box = self.before.get("rootLocalBounds", box)
            else:
                parent = by_id[original["parentId"]]["bounds"]
                box["x"] -= parent["x"]
                box["y"] -= parent["y"]
            nodes.append({**{key: original[key] for key in ["id", "parentId", "name", "type", "childCount", "visible", "opacity"]},
                          "depth": 0 if original["id"] == "R" else 1, "siblingIndex": original["index"],
                          "x": box["x"], "y": box["y"], "w": box["width"], "h": box["height"]})
        if self.snapshot_changed:
            nodes[1]["x"] += 10
        if self.snapshot_mutation:
            self.snapshot_mutation(nodes)
        return {"rootNodeId": "R", "nodes": nodes}

    def containing_page(self, _):
        return "P"

    def job(self, job, request_id):
        self.writes.append((job, request_id))
        self.after, results = apply_operations(self.before, job["plan"]["operations"])
        self.response = {"requestId": request_id, "result": {"status": "completed", "state": "succeeded",
                         "checks": {"allPass": True}, "operationResults": results}}
        if self.timeout_once:
            self.timeout_once = False
            raise TimeoutError("submission response lost")
        return self.response

    def recover(self, request_id):
        self.recovered.append(request_id)
        return self.response


class ResourceHierarchyTests(unittest.TestCase):
    def test_compiles_nested_groups_with_standalone_background_and_noncontiguous_items(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            compiled = hierarchy.compile_hierarchy(plan, before)
            self.assertEqual(compiled["coverage"]["assignedCount"], 5)
            self.assertEqual(len(compiled["operations"]), 3)
            self.assertNotIn("bg", [key for operation in compiled["operations"] for key in operation["childNodeIds"]])
            self.assertEqual(compiled["operations"][1]["parentOperationId"], compiled["operations"][0]["id"])
            self.assertEqual(compiled["staticHorizontalChecks"][0]["ignoredSignals"], ["name", "path", "characters"])
            after, operations = apply_operations(before, compiled["operations"])
            report = hierarchy.verify_hierarchy(plan, compiled, before, after, operations)
            self.assertTrue(report["renderPixelsIdentical"])

    def test_static_item_geometry_includes_nested_resource_members(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            value = deepcopy(before["directChildren"][3])
            value.update(id="value-a", name="value-a", index=4,
                         bounds={"x": 35, "y": 40, "width": 10, "height": 10})
            before["directChildren"].insert(4, value)
            for index, node in enumerate(before["directChildren"]):
                node["index"] = index
            before["nodes"] = [before["nodes"][0], *deepcopy(before["directChildren"])]
            before["nodes"][0]["childCount"] = 6
            item = plan["children"][1]["children"][0]
            item["children"] = [{"nodeId": "a"}, {"name": "[TextContent]", "children": [
                {"nodeId": "caption-a"}, {"nodeId": "value-a"}]}]
            compiled = hierarchy.compile_hierarchy(plan, before)
            self.assertEqual(compiled["staticHorizontalChecks"][0]["assignedCount"], 5)
            after, operations = apply_operations(before, compiled["operations"])
            self.assertTrue(hierarchy.verify_hierarchy(plan, compiled, before, after, operations)["treeMatchesPlan"])

    def test_missing_duplicate_and_nested_source_ids_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            bad = deepcopy(plan)
            bad["children"].pop(0)
            with self.assertRaisesRegex(ValueError, "assigned once"):
                hierarchy.compile_hierarchy(bad, before)
            bad = deepcopy(plan)
            bad["children"].append({"nodeId": "bg"})
            with self.assertRaises(ValueError):
                hierarchy.compile_hierarchy(bad, before)
            bad = deepcopy(plan)
            bad["children"][0]["nodeId"] = "nested-child"
            with self.assertRaisesRegex(ValueError, "current direct child"):
                hierarchy.compile_hierarchy(bad, before)

    def test_overlapping_z_crossings_and_singleton_wrappers_are_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            plan["children"][1].pop("layoutIntent")
            before["directChildren"][2]["bounds"] = before["directChildren"][3]["bounds"].copy()
            with self.assertRaisesRegex(ValueError, "overlapping nodes"):
                hierarchy.compile_hierarchy(plan, before)
            plan, before = case(directory)
            plan["children"][0] = {"name": "[Background]", "children": [{"nodeId": "bg"}]}
            with self.assertRaisesRegex(ValueError, "single-child"):
                hierarchy.compile_hierarchy(plan, before)

    def test_rgb_difference_is_detected_even_when_alpha_is_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            compiled = hierarchy.compile_hierarchy(plan, before)
            after, operations = apply_operations(before, compiled["operations"])
            image = Image.open(before["screenshot"]["path"]).convert("RGBA")
            image.putpixel((3, 3), (13, 35, 70, 255))
            changed = Path(directory) / "changed.png"
            image.save(changed)
            after["screenshot"]["path"] = str(changed)
            with self.assertRaisesRegex(ValueError, "rendered pixels"):
                hierarchy.verify_hierarchy(plan, compiled, before, after, operations)

    def test_resource_subtree_cannot_be_reparented_or_renamed_by_grouping(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            source = next(node for node in before["nodes"] if node["id"] == "a")
            source["type"], source["childCount"] = "FRAME", 1
            before["directChildren"][1].update(type="FRAME", childCount=1)
            nested = deepcopy(source)
            nested.update(id="slice", parentId="a", name="__slice_left", type="RECTANGLE", index=0, childCount=0)
            before["nodes"].append(nested)
            compiled = hierarchy.compile_hierarchy(plan, before)
            after, operations = apply_operations(before, compiled["operations"])
            self.assertTrue(hierarchy.verify_hierarchy(plan, compiled, before, after, operations)["nodeIdsPreserved"])
            next(node for node in after["nodes"] if node["id"] == "slice")["parentId"] = "R"
            with self.assertRaisesRegex(ValueError, "protected resource subtree"):
                hierarchy.verify_hierarchy(plan, compiled, before, after, operations)

    def test_bad_plan_parse_has_structured_failure_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text("invalid JSON", encoding="utf-8")
            stream = io.StringIO()
            args = SimpleNamespace(plan=path, output_dir=Path(directory) / "out")
            with self.assertRaises(ValueError):
                hierarchy.execute(args, logger=hierarchy.PythonLogger("test", stream=stream))
            statuses = [json.loads(line.split(" ", 1)[1])["status"] for line in stream.getvalue().splitlines()]
            self.assertEqual(statuses, ["started", "failed"])

    def test_live_submission_logs_and_unknown_recovery_never_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            plan_path = Path(directory) / "plan.json"
            hierarchy.write_json(plan_path, plan)
            args = SimpleNamespace(plan=plan_path, output_dir=Path(directory) / "out", analysis=None,
                    apply=True, recover=False, session_id="session", relay_url="http://localhost:32130", timeout=10)
            backend = Backend(before, timeout_once=True)
            stream = io.StringIO()
            logger = hierarchy.PythonLogger("test-resource-hierarchy", stream=stream)
            with self.assertRaises(TimeoutError):
                hierarchy.execute(args, backend, logger)
            saved_id = backend.writes[0][1]
            with self.assertRaisesRegex(ValueError, "already has a submission"):
                hierarchy.execute(args, backend, logger)
            artifacts = ["before-analysis.json", "compiled-hierarchy.json", "state.json", "report.json"]
            saved = {name: (args.output_dir / name).read_bytes() for name in artifacts}
            args.analysis, args.apply = plan_path, False
            with self.assertRaisesRegex(ValueError, "already has a submission"):
                hierarchy.execute(args, backend, logger)
            self.assertEqual(saved, {name: (args.output_dir / name).read_bytes() for name in artifacts})
            args.analysis = None
            args.apply, args.recover = False, True
            report = hierarchy.execute(args, backend, logger)
            self.assertEqual(report["status"], "completed")
            self.assertEqual(len(backend.writes), 1)
            self.assertEqual(backend.recovered, [saved_id])
            events = [json.loads(line.split(" ", 1)[1]) for line in stream.getvalue().splitlines()]
            self.assertIn("failed", {event["status"] for event in events})
            self.assertIn("succeeded", {event["status"] for event in events})
            self.assertIn("verify", {event["step"] for event in events})

    def test_stale_geometry_and_wrong_page_fail_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            plan_path = Path(directory) / "plan.json"
            hierarchy.write_json(plan_path, plan)
            args = SimpleNamespace(plan=plan_path, output_dir=Path(directory) / "out", analysis=None,
                    apply=True, recover=False, session_id="session", relay_url="http://localhost:32130", timeout=10)
            backend = Backend(before)
            backend.snapshot_changed = True
            with self.assertRaisesRegex(ValueError, "geometry changed"):
                hierarchy.execute(args, backend, hierarchy.PythonLogger("test", stream=io.StringIO()))
            self.assertEqual(backend.writes, [])
            backend.snapshot_changed = False
            plan["target"]["pageId"] = "wrong-page"
            hierarchy.write_json(plan_path, plan)
            with self.assertRaisesRegex(ValueError, "page/root differs"):
                hierarchy.execute(args, backend, hierarchy.PythonLogger("test", stream=io.StringIO()))
            self.assertEqual(backend.writes, [])

    def test_root_and_protected_descendant_changes_are_rejected_before_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            before["directChildren"][1].update(type="FRAME", childCount=1)
            before["nodes"][1+1].update(type="FRAME", childCount=1)
            source = next(node for node in before["nodes"] if node["id"] == "a")
            nested = deepcopy(source)
            nested.update(id="protected", parentId="a", index=0, childCount=0, type="RECTANGLE")
            before["nodes"].append(nested)
            plan_path = Path(directory) / "plan.json"
            hierarchy.write_json(plan_path, plan)
            args = SimpleNamespace(plan=plan_path, output_dir=Path(directory) / "out", analysis=None,
                    apply=True, recover=False, session_id="session", relay_url="http://localhost:32130", timeout=10)
            for changed_id in ["R", "protected"]:
                backend = Backend(before)
                def change(nodes):
                    next(node for node in nodes if node["id"] == changed_id)["x"] += 10
                backend.snapshot_mutation = change
                with self.assertRaisesRegex(ValueError, "geometry changed"):
                    hierarchy.execute(args, backend, hierarchy.PythonLogger("test", stream=io.StringIO()))
                self.assertEqual(backend.writes, [])

    def test_group_descendants_use_nearest_frame_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            source = next(node for node in before["nodes"] if node["id"] == "a")
            source.update(type="GROUP", childCount=1)
            inner = deepcopy(source)
            inner.update(id="inner", parentId="a", index=0, type="BOOLEAN_OPERATION", childCount=1)
            leaf = deepcopy(source)
            leaf.update(id="leaf", parentId="inner", index=0, type="RECTANGLE", childCount=0,
                        bounds={"x": 12, "y": 14, "width": 5, "height": 6})
            before["nodes"] += [inner, leaf]
            snapshot = {"rootNodeId": "R", "nodes": []}
            for original in before["nodes"]:
                box = original["bounds"]
                snapshot["nodes"].append({**{key: original[key] for key in ["id", "parentId", "name", "type", "childCount", "visible", "opacity"]},
                                          "siblingIndex": original["index"],
                                          "x": box["x"], "y": box["y"], "w": box["width"], "h": box["height"]})
            hierarchy.validate_snapshot(plan, before, snapshot)
            next(node for node in snapshot["nodes"] if node["id"] == "leaf")["x"] += 1
            with self.assertRaisesRegex(ValueError, "geometry changed"):
                hierarchy.validate_snapshot(plan, before, snapshot)

    def test_absolute_snapshot_bounds_accept_rotated_nodes_and_still_detect_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            snapshot = {"rootNodeId": "R", "nodes": []}
            for original in before["nodes"]:
                box = original["bounds"]
                snapshot["nodes"].append({**{key: original[key] for key in ["id", "parentId", "name", "type", "childCount", "visible", "opacity"]},
                                          "siblingIndex": original["index"], "x": -999, "y": -999, "w": box["height"], "h": box["width"],
                                          "abs": {"x": box["x"], "y": box["y"], "w": box["width"], "h": box["height"]}})
            hierarchy.validate_snapshot(plan, before, snapshot)
            next(node for node in snapshot["nodes"] if node["id"] == "a")["abs"]["y"] += 1
            with self.assertRaisesRegex(ValueError, "geometry changed"):
                hierarchy.validate_snapshot(plan, before, snapshot)
            next(node for node in snapshot["nodes"] if node["id"] == "a")["abs"]["y"] -= 1
            next(node for node in snapshot["nodes"] if node["id"] == "b")["siblingIndex"] = 0
            with self.assertRaisesRegex(ValueError, "parent/order changed"):
                hierarchy.validate_snapshot(plan, before, snapshot)

    def test_nested_root_on_authorized_page_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, before = case(directory)
            before["nodes"][0]["parentId"] = "host-frame"
            before["rootLocalBounds"] = before["rootBounds"].copy()
            plan_path = Path(directory) / "plan.json"
            hierarchy.write_json(plan_path, plan)
            args = SimpleNamespace(plan=plan_path, output_dir=Path(directory) / "out", analysis=None,
                    apply=True, recover=False, session_id="session", relay_url="http://localhost:32130", timeout=10)
            report = hierarchy.execute(args, Backend(before), hierarchy.PythonLogger("test", stream=io.StringIO()))
            self.assertTrue(report["treeMatchesPlan"])

    def test_backend_resolves_containing_page_and_reads_beyond_source_snapshot_depth(self):
        backend = hierarchy.RelayBackend("session", "file", "http://localhost:32130", 10)
        records = {"host": {"id": "host", "parentId": "P", "type": "FRAME"},
                   "P": {"id": "P", "parentId": "document", "type": "PAGE"}}
        with patch.object(backend, "inspect", side_effect=lambda key: records[key]):
            self.assertEqual(backend.containing_page({"parentId": "host"}), "P")
        with patch.object(backend, "inspect", return_value={"x": 0, "y": 0, "width": 10, "height": 10}), \
             patch.object(backend, "job", return_value={"result": {"status": "completed"}}) as job:
            backend.analyze("R")
            self.assertGreaterEqual(job.call_args.args[0]["options"]["maxDepth"], hierarchy.MAX_PLAN_DEPTH + hierarchy.MAX_SNAPSHOT_DEPTH)

    def test_task_wait_only_queries_the_saved_id(self):
        with patch("figma_relay_cli._run", return_value={"status": "running"}) as run:
            self.assertEqual(hierarchy.wait_task("saved-id")["status"], "running")
            self.assertEqual(run.call_args.args, ("task-wait",))
            self.assertEqual(run.call_args.kwargs["task_id"], "saved-id")
        with patch("figma_relay_cli._run", return_value={"status": "completed", "nodes": []}) as run:
            hierarchy.inspect_nodes(["1:1"], session_id="session", file_key="file")
            self.assertEqual(run.call_args.kwargs["payload"], {"nodeIds": ["1:1"], "depth": 0, "includeText": False})
            self.assertEqual(run.call_args.kwargs["file_key"], "file")


if __name__ == "__main__":
    unittest.main()
