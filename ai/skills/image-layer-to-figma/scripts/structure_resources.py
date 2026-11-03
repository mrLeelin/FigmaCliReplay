#!/usr/bin/env python3
"""Validate and apply an explicit nested resource tree through the project Relay.

Semantic decisions belong to the agent's plan. This executor does not infer
screen names, resource roles, component variants, or editable text.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import uuid

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "ai/skills/figma-hierarchy-cleanup/scripts"))
sys.path.insert(0, str(ROOT / "server"))
import figma_hierarchy_cleanup_cli as relay
from figma_relay_cli import inspect_nodes, wait_task
from apply_cleanup_plan import build_transaction_job, normalize_transaction_report
from python_logger import PythonLogger
from verify_figma_hierarchy_cleanup import validate_static_horizontal_layout


class HierarchyError(ValueError):
    """A proposed resource hierarchy cannot be applied without changing its scope."""


MAX_PLAN_DEPTH = 10
MAX_SNAPSHOT_DEPTH = 12
ANALYSIS_DEPTH = MAX_PLAN_DEPTH + MAX_SNAPSHOT_DEPTH + 2


def result_of(payload):
    return payload.get("result", payload)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fingerprint(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def bounds(node):
    box = node.get("bounds")
    if not isinstance(box, dict):
        raise HierarchyError("Every analyzed node requires absolute bounds")
    values = {key: box.get(key) for key in ("x", "y", "width", "height")}
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values.values()):
        raise HierarchyError("Node bounds must be finite numbers")
    if values["width"] <= 0 or values["height"] <= 0:
        raise HierarchyError("Node bounds must have positive dimensions")
    return values


def overlaps(a, b):
    return (min(a["x"] + a["width"], b["x"] + b["width"]) > max(a["x"], b["x"])
            and min(a["y"] + a["height"], b["y"] + b["height"]) > max(a["y"], b["y"]))


def compile_hierarchy(plan, analysis):
    """Compile only CREATE_GROUP operations; preserve existing containers whole."""
    analysis = result_of(analysis)
    target = plan.get("target", {})
    if plan.get("schemaVersion") != 1 or not isinstance(target, dict):
        raise HierarchyError("Resource hierarchy schemaVersion must be 1 with an explicit target")
    if any(not isinstance(target.get(key), str) or not target[key].strip() for key in ("fileKey", "pageId", "nodeId")):
        raise HierarchyError("target.fileKey, pageId and nodeId are required")
    if analysis.get("rootNodeId") != target["nodeId"] or analysis.get("fileKey") != target["fileKey"]:
        raise HierarchyError("Analysis file/root identity differs from the requested target")
    original = analysis.get("directChildren")
    if not isinstance(original, list) or not original:
        raise HierarchyError("The current target must have direct children")
    ids = [node.get("id") for node in original]
    if len(ids) != len(set(ids)) or any(not isinstance(key, str) or not key for key in ids):
        raise HierarchyError("Analysis contains invalid or duplicate source IDs")
    by_id = {node["id"]: node for node in original}
    for node in original:
        bounds(node)
        if node.get("parentId") != target["nodeId"]:
            raise HierarchyError("Only current direct children may be assigned; descendants stay inside their original container")
    order = {key: index for index, key in enumerate(ids)}
    assigned, operations, mappings, containers, lines, static_checks = [], [], [], [], [], []
    members_by_path = {}

    def visit(children, parent_ref, path, depth):
        if depth > MAX_PLAN_DEPTH or not isinstance(children, list) or not children:
            raise HierarchyError("Hierarchy children must be nonempty and no deeper than ten groups")
        members, anchors, local_names = [], [], set()
        for index, item in enumerate(children):
            if not isinstance(item, dict):
                raise HierarchyError("Each child must be a nodeId reference or a named group")
            if "nodeId" in item:
                if set(item) != {"nodeId"} or item["nodeId"] not in by_id:
                    raise HierarchyError("Leaf references must identify a current direct child exactly")
                key = item["nodeId"]
                assigned.append(key)
                members.append(key)
                anchors.append(order[key])
                mappings.append({"nodeId": key, "nodeName": by_id[key]["name"], "targetParent": path, "targetSiblingIndex": index})
                lines.append("  " * depth + by_id[key]["name"] + " (" + key + ")")
                continue
            if set(item) - {"name", "children", "layoutIntent"}:
                raise HierarchyError("Group fields are name, children and optional layoutIntent")
            name = item.get("name")
            if not isinstance(name, str) or not re.fullmatch(r"\[[^\]\r\n]+\]", name) or "\ufffd" in name or "???" in name:
                raise HierarchyError("Group names must be meaningful UTF-8 names inside brackets")
            if name in local_names:
                raise HierarchyError("Sibling group names must be unique")
            local_names.add(name)
            if not isinstance(item.get("children"), list) or len(item["children"]) < 2:
                raise HierarchyError("Avoid single-child wrappers; leave the complete resource directly under its semantic parent")
            if len(item["children"]) >= 12 and not any("children" in child for child in item["children"] if isinstance(child, dict)):
                raise HierarchyError("A group with twelve or more flat children must be expanded into functional subgroups")
            op_id = f"resource-group-{len(operations) + 1:03d}"
            operation = {"id": op_id, "type": "CREATE_GROUP", **parent_ref, "name": name, "childNodeIds": []}
            operations.append(operation)
            group_path = path + "/" + name
            containers.append({"operationId": op_id, "parent": parent_ref, "path": group_path, "name": name, "siblingIndex": index})
            lines.append("  " * depth + name)
            group_members = visit(item["children"], {"parentOperationId": op_id}, group_path, depth + 1)
            members_by_path[group_path] = group_members
            operation["childNodeIds"] = sorted(group_members, key=order.__getitem__)
            members.extend(group_members)
            anchors.append(min(order[key] for key in group_members))
            intent = item.get("layoutIntent")
            if intent is not None:
                if intent != "static-horizontal" or any("children" not in child for child in item["children"]):
                    raise HierarchyError("static-horizontal must describe a fixed strip of item groups")
                item_groups = []
                for child in item["children"]:
                    child_path = group_path + "/" + child["name"]
                    child_ids = members_by_path[child_path]
                    item_groups.append({"childNodeIds": child_ids})
                check = validate_static_horizontal_layout(item_groups, original)
                if not check["pass"]:
                    raise HierarchyError("Static horizontal geometry rejected: " + "; ".join(check["rejectReasons"]))
                static_checks.append({"path": group_path, **check})
        if anchors != sorted(anchors):
            raise HierarchyError("Sibling groups and standalone resources must follow their earliest original member")
        return members

    lines.append(analysis.get("rootName", target["nodeId"]))
    flattened = visit(plan.get("children"), {"parentNodeId": target["nodeId"]}, "Root", 1)
    missing = sorted(set(ids) - set(assigned))
    duplicates = sorted({key for key in assigned if assigned.count(key) > 1})
    if missing or duplicates or len(assigned) != len(ids):
        raise HierarchyError(f"Each original node must be assigned once; missing={missing}, duplicate={duplicates}")
    if not operations:
        raise HierarchyError("Flat output is not a semantic hierarchy; add functional groups")
    rank = {key: index for index, key in enumerate(flattened)}
    for index, left in enumerate(ids):
        for right in ids[index+1:]:
            if rank[left] > rank[right] and overlaps(bounds(by_id[left]), bounds(by_id[right])):
                raise HierarchyError(f"Grouping crosses overlapping nodes {left} and {right}; revise the resource boundary")
    return {"operations": operations, "nodeMappings": mappings, "containers": containers,
            "staticHorizontalChecks": static_checks, "tree": "\n".join(lines) + "\n",
            "coverage": {"beforeCount": len(ids), "assignedCount": len(assigned), "missing": [], "duplicate": [], "extra": []}}


def validate_snapshot(plan, analysis, snapshot):
    """Compare the entire authoritative source subtree before permitting a write."""
    analysis = result_of(analysis)
    before = {node["id"]: node for node in analysis["nodes"]}
    current = {node["id"]: node for node in snapshot["nodes"]}
    root_id = plan["target"]["nodeId"]
    if snapshot.get("rootNodeId") != root_id or set(before) != set(current):
        raise HierarchyError("Source subtree changed between analysis and snapshot")
    for node_id, original in before.items():
        node = current[node_id]
        if any(node.get(field) != original.get(field) for field in ("parentId", "name", "type", "visible", "opacity", "childCount")):
            raise HierarchyError("Resource properties changed between analysis and snapshot")
        box = bounds(original)
        if node_id == root_id:
            local = analysis.get("rootLocalBounds")
            if local is None and original["parentId"] == plan["target"]["pageId"]:
                local = box
            if local is None:
                raise HierarchyError("Nested roots require local geometry evidence")
        else:
            parent = before.get(original["parentId"])
            if parent is None or node.get("siblingIndex") != original.get("index"):
                raise HierarchyError("Protected subtree parent/order changed between analysis and snapshot")
            parent_box = bounds(parent)
            local = {"x": box["x"]-parent_box["x"], "y": box["y"]-parent_box["y"],
                     "width": box["width"], "height": box["height"]}
        for field, source_field in (("x", "x"), ("y", "y"), ("w", "width"), ("h", "height")):
            value = node.get(field)
            if not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value - local[source_field]) > 0.01:
                raise HierarchyError("Resource geometry changed between analysis and snapshot")


def verify_hierarchy(plan, compiled, before, after, operation_results):
    before, after = result_of(before), result_of(after)
    existing = {node["id"]: node for node in before["nodes"]}
    live = {node["id"]: node for node in after["nodes"]}
    created = {item["id"]: item["createdNodeId"] for item in operation_results if item.get("type") == "CREATE_GROUP"}
    if set(created) != {item["id"] for item in compiled["operations"]} or len(set(created.values())) != len(created):
        raise HierarchyError("Created group IDs differ from the compiled transaction")
    paths = {"Root": plan["target"]["nodeId"]}
    expected_children = {}
    for container in compiled["containers"]:
        key = created[container["operationId"]]
        ref = container["parent"]
        parent = created[ref["parentOperationId"]] if "parentOperationId" in ref else ref["parentNodeId"]
        node = live.get(key, {})
        if node.get("type") != "FRAME" or node.get("name") != container["name"] or node.get("parentId") != parent:
            raise HierarchyError("Live semantic group differs from its planned parent/name/type")
        if node.get("childCount", 0) < 2:
            raise HierarchyError("A semantic group became a single-child wrapper")
        paths[container["path"]] = key
        expected_children.setdefault(parent, []).append((container["siblingIndex"], key))
    for row in compiled["nodeMappings"]:
        parent = paths[row["targetParent"]]
        if live.get(row["nodeId"], {}).get("parentId") != parent:
            raise HierarchyError("Original resource parent differs from the complete hierarchy plan")
        expected_children.setdefault(parent, []).append((row["targetSiblingIndex"], row["nodeId"]))
    if set(live) != set(existing) | set(created.values()):
        raise HierarchyError("Original nodes were lost or unexpected nodes appeared")
    for key, original in existing.items():
        actual = live[key]
        if any(original.get(field) != actual.get(field) for field in ("type", "name", "visible", "opacity", "childCount") if field != "childCount" or key not in expected_children):
            raise HierarchyError("Original resource properties changed")
        if max(abs(bounds(original)[field] - bounds(actual)[field]) for field in bounds(original)) > 0.01:
            raise HierarchyError("Original resource bounds drifted")
        if key != plan["target"]["nodeId"] and key not in {row["nodeId"] for row in compiled["nodeMappings"]}:
            if actual["parentId"] != original["parentId"] or actual["index"] != original["index"]:
                raise HierarchyError("A protected resource subtree was changed")
    for parent, children in expected_children.items():
        actual = sorted((node for node in live.values() if node.get("parentId") == parent), key=lambda node: node["index"])
        if [node["id"] for node in actual] != [key for _, key in sorted(children)]:
            raise HierarchyError("Live sibling order differs from the hierarchy plan")
    root_id = plan["target"]["nodeId"]
    if (before["rootBounds"] != after["rootBounds"] or before["fileKey"] != after["fileKey"]
            or after.get("rootNodeId") != root_id or existing[root_id]["parentId"] != live[root_id]["parentId"]):
        raise HierarchyError("Root geometry or file identity changed")
    with Image.open(before["screenshot"]["path"]) as left, Image.open(after["screenshot"]["path"]) as right:
        if left.size != right.size or ImageChops.difference(left.convert("RGBA"), right.convert("RGBA")).getbbox(alpha_only=False):
            raise HierarchyError("Live rendered pixels differ; retain recovery evidence and stop downstream delivery")
    return {"originalNodeCount": len(existing), "resourceCount": len(compiled["nodeMappings"]),
            "semanticGroupCount": len(created), "nodeIdsPreserved": True, "boundsDriftCount": 0,
            "renderPixelsIdentical": True, "treeMatchesPlan": True}


class RelayBackend:
    def __init__(self, session_id, file_key, relay_url, timeout):
        relay.configure_target(file_key, session_id, preflight=False)
        self.session_id, self.file_key, self.relay_url, self.timeout = session_id, file_key, relay_url, timeout

    def job(self, job, request_id=""):
        return relay.submit_job(self.relay_url, job, self.timeout, 0.2, request_id=request_id)

    def analyze(self, node_id):
        local = self.inspect(node_id)
        response = self.job({"type": "FIGMA_HIERARCHY_CLEANUP_ANALYZE", "target": {"nodeId": node_id},
                             "options": {"includeHidden": True, "includeScreenshot": True, "maxDepth": ANALYSIS_DEPTH}})
        relay.assert_completed(response)
        result_of(response)["rootLocalBounds"] = {field: local[field] for field in ("x", "y", "width", "height")}
        return response

    def inspect(self, node_id):
        response = inspect_nodes([node_id], session_id=self.session_id, file_key=self.file_key,
                                 relay_url=self.relay_url, timeout=min(self.timeout, 30))
        if response.get("status") != "completed" or len(response.get("nodes", [])) != 1 or response["nodes"][0].get("id") != node_id:
            raise HierarchyError("Could not inspect the exact requested node")
        return response["nodes"][0]

    def containing_page(self, root):
        parent_id, seen = root.get("parentId"), set()
        while parent_id and parent_id not in seen and len(seen) < 64:
            seen.add(parent_id)
            parent = self.inspect(parent_id)
            if parent.get("type") == "PAGE":
                return parent["id"]
            parent_id = parent.get("parentId")
        raise HierarchyError("Could not resolve the root's containing Page")

    def snapshot(self, node_id):
        response = self.job({"type": "QUERY_CLEANUP_SNAPSHOT", "rootNodeId": node_id})
        relay.assert_completed(response)
        return result_of(response)["snapshot"]

    def recover(self, request_id):
        status = wait_task(request_id, relay_url=self.relay_url, timeout=min(self.timeout, 120))
        if status.get("status") != "succeeded" or not isinstance(status.get("result"), dict):
            raise HierarchyError(f"Task {request_id} is {status.get('status')}; no write was resubmitted")
        return {"requestId": request_id, "result": status["result"]}


def snapshot_hash(snapshot):
    process = subprocess.run(["node", str(Path(__file__).with_name("snapshot_hash.mjs"))],
                             input=json.dumps(snapshot, ensure_ascii=False), capture_output=True, encoding="utf-8", check=True)
    value = process.stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise HierarchyError("Native snapshot hash did not return SHA-256")
    return value


def execute(args, backend=None, logger=None):
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    state_path = output / "state.json"
    had_submission = state_path.exists()
    state = None
    logger = logger or PythonLogger("resource-hierarchy")
    operation = logger.start_operation("resource-hierarchy")
    try:
        plan = read_json(args.plan)
        state = read_json(state_path) if state_path.exists() else None
        if state:
            operation.step("load-submission", data={"parentOperationId": state.get("operationId"), "requestId": state.get("requestId")})
        if state and not args.recover:
            raise HierarchyError("This output directory already has a submission; use --recover to query its original request")
        if args.analysis and (args.apply or args.recover):
            raise HierarchyError("--analysis is offline validation only; live writes require a fresh snapshot")
        if not args.analysis and not (args.apply or args.recover):
            raise HierarchyError("Choose offline --analysis, or an already-authorized live --apply/--recover")
        if not args.analysis and not args.session_id:
            raise HierarchyError("A verified explicit --session-id is required for live operations")
        if args.recover:
            if not state or state.get("planHash") != fingerprint(plan):
                raise HierarchyError("Recovery requires the original unchanged plan and submission directory")
            before = read_json(output / "before-analysis.json")
            compiled = compile_hierarchy(plan, before)
        else:
            backend = backend or (RelayBackend(args.session_id, plan["target"]["fileKey"], args.relay_url, args.timeout) if not args.analysis else None)
            before = read_json(args.analysis) if args.analysis else backend.analyze(plan["target"]["nodeId"])
            compiled = compile_hierarchy(plan, before)
            write_json(output / "before-analysis.json", before)
            write_json(output / "compiled-hierarchy.json", compiled)
            (output / "hierarchy-tree.txt").write_text(compiled["tree"], encoding="utf-8")
        operation.step("validate", data={**compiled["coverage"], "groupCount": len(compiled["operations"])})
        if args.analysis:
            report = {"status": "validated", "coverage": compiled["coverage"], "groupCount": len(compiled["operations"]), "writes": 0}
            write_json(output / "report.json", report)
            operation.succeed(data=report)
            return report
        backend = backend or RelayBackend(args.session_id, plan["target"]["fileKey"], args.relay_url, args.timeout)
        if args.recover:
            operation.step("recover", data={"requestId": state["requestId"], "resubmit": False})
            response = backend.recover(state["requestId"])
        else:
            snapshot = backend.snapshot(plan["target"]["nodeId"])
            root = next((node for node in snapshot["nodes"] if node["id"] == snapshot["rootNodeId"]), {})
            if snapshot["rootNodeId"] != plan["target"]["nodeId"] or backend.containing_page(root) != plan["target"]["pageId"]:
                raise HierarchyError("Live snapshot page/root differs from the authorized target")
            validate_snapshot(plan, before, snapshot)
            transaction = {"schemaVersion": 3, "operation": "figma-hierarchy-cleanup-transaction",
                "target": {"nodeId": plan["target"]["nodeId"], "fileKey": plan["target"]["fileKey"], "snapshotHash": snapshot_hash(snapshot)},
                "operations": compiled["operations"], "verification": {"preserveAbsoluteBoundsTolerance": 0.01}, "createBackup": False}
            write_json(output / "before-snapshot.json", snapshot)
            write_json(output / "transaction.json", transaction)
            state = {"operationId": operation.operation_id, "requestId": "resource-hierarchy-" + uuid.uuid4().hex,
                     "planHash": fingerprint(plan), "phase": "submission_prepared"}
            write_json(state_path, state)
            operation.step("submit", data={"requestId": state["requestId"], "operationCount": len(compiled["operations"])})
            response = backend.job(build_transaction_job(transaction, args.session_id), state["requestId"])
        write_json(output / "transaction-result.json", response)
        transaction_report = normalize_transaction_report(response)
        state["phase"] = transaction_report["state"]
        write_json(state_path, state)
        if transaction_report["state"] != "succeeded":
            raise HierarchyError("Hierarchy transaction ended in " + transaction_report["state"])
        if transaction_report["checks"].get("allPass") is not True:
            raise HierarchyError("Native transaction verification did not pass")
        operation.step("verify", data={"requestId": state["requestId"]})
        after = backend.analyze(plan["target"]["nodeId"])
        write_json(output / "after-analysis.json", after)
        checks = verify_hierarchy(plan, compiled, before, after, transaction_report["result"].get("operationResults", []))
        report = {"status": "completed", "target": plan["target"], "requestId": state["requestId"], **checks}
        write_json(output / "report.json", report)
        state["phase"] = "verified"
        write_json(state_path, state)
        operation.succeed(data=report)
        return report
    except Exception as error:
        report = {"status": "failed", "error": str(error), "requestId": (state or {}).get("requestId", ""),
                  "recovery": "Query the recorded request; never resubmit an unknown write." if state else "No hierarchy transaction was submitted."}
        error_path = output / ("last-error.json" if had_submission and not getattr(args, "recover", False) else "report.json")
        write_json(error_path, report)
        operation.fail(error, data={"requestId": report["requestId"]})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--analysis", type=Path, help="Offline read-only validation against an existing includeHidden analysis")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Execute an already-authorized semantic hierarchy plan")
    mode.add_argument("--recover", action="store_true", help="Read the original recorded task; never submit a new write")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--relay-url", default=relay.DEFAULT_RELAY_URL)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    try:
        report = execute(args)
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
