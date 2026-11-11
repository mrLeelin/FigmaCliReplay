import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { computeCleanupSnapshotHash } from "../dist/cleanupPlan.js";
import {
  captureCleanupRollbackJournal,
  computeCleanupSnapshotHashFromNodes,
  rollbackCleanupTransaction,
} from "../code/08_cleanup_transaction.mjs";

function fakeNode(id, name = id) {
  return {
    id,
    name,
    type: "FRAME",
    parent: null,
    children: [],
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    visible: true,
    opacity: 1,
    appendChild(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    },
    insertChild(index, child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.splice(index, 0, child);
    },
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
      this.removed = true;
    },
  };
}

test("Figma and Node canonical snapshot hashes stay identical", () => {
  const snapshot = {
    schemaVersion: 1,
    rootNodeId: "R",
    nodes: [
      { id: "R", parentId: "", type: "FRAME", name: "根", siblingIndex: 0, depth: 0, x: 0, y: 0, w: 100, h: 100, visible: true, opacity: 1, childCount: 1, roles: { image: false } },
      { id: "A", parentId: "R", type: "TEXT", name: "标题", siblingIndex: 0, depth: 1, x: 5, y: 5, w: 30, h: 10, visible: true, opacity: 1, childCount: 0, characters: "开始", roles: { image: false } },
    ],
  };
  assert.equal(computeCleanupSnapshotHashFromNodes(snapshot.nodes), computeCleanupSnapshotHash(snapshot));
});

test("rollback restores original parents, indices, and names", async () => {
  const root = fakeNode("R", "Root");
  const a = fakeNode("A");
  const b = fakeNode("B");
  const c = fakeNode("C");
  root.appendChild(a);
  root.appendChild(b);
  root.appendChild(c);
  const journal = captureCleanupRollbackJournal(root);

  const group = fakeNode("G", "[Group]");
  root.appendChild(group);
  journal.createdNodes.push(group);
  group.appendChild(a);
  group.appendChild(b);
  a.name = "Changed";

  const result = await rollbackCleanupTransaction(journal);
  assert.equal(result.pass, true);
  assert.deepEqual(root.children.map((node) => node.id), ["A", "B", "C"]);
  assert.equal(a.name, "A");
  assert.equal(group.removed, true);
});

// 模拟 Figma 坐标：Frame 建立坐标系，GROUP 不建立；bboxOffset 模拟旋转/翻转后外接包围盒与 x/y 的差。
function geoNode(id, { type = "RECTANGLE", x = 0, y = 0, width = 10, height = 10, bboxOffset = { x: 0, y: 0 } } = {}) {
  const node = fakeNode(id);
  Object.assign(node, { type, x, y, width, height, resizeCalls: 0 });
  node.resize = function (newWidth, newHeight) {
    this.resizeCalls += 1;
    this.width = newWidth;
    this.height = newHeight;
  };
  Object.defineProperty(node, "absoluteBoundingBox", {
    get() {
      const origin = containerOrigin(this.parent);
      return { x: origin.x + this.x + bboxOffset.x, y: origin.y + this.y + bboxOffset.y, width: this.width, height: this.height };
    },
  });
  return node;
}

function containerOrigin(parent) {
  if (!parent) return { x: 0, y: 0 };
  if (parent.type === "GROUP") return containerOrigin(parent.parent);
  const origin = containerOrigin(parent.parent);
  return { x: origin.x + parent.x, y: origin.y + parent.y };
}

function runtimeFunctionSource(source, name) {
  const match = new RegExp(`^function ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing runtime function ${name}`);
  const remainder = source.slice(match.index + match[0].length);
  const next = /\n(?:async )?function [A-Za-z]/.exec(remainder);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : undefined);
}

test("moving a rotated group into a new frame preserves its absolute bounds", () => {
  const source = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");
  const sandbox = { getNodeBounds: (node) => node.absoluteBoundingBox, pluginLogger: { warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(["numericOr", "preserveHierarchyChildAbsoluteBounds"].map((name) => runtimeFunctionSource(source, name)).join("\n"), sandbox);

  const root = geoNode("R", { type: "FRAME", width: 1080, height: 2340 });
  const marker = geoNode("M", { type: "GROUP", x: 366, y: 1155, width: 34, height: 86, bboxOffset: { x: -20, y: 0 } });
  root.appendChild(marker);
  const before = { ...marker.absoluteBoundingBox };
  const frame = geoNode("F", { type: "FRAME", x: 340, y: 1100 });
  root.appendChild(frame);
  frame.appendChild(marker);

  sandbox.preserveHierarchyChildAbsoluteBounds(marker, frame, before);
  assert.deepEqual(marker.absoluteBoundingBox, before);
});

test("rollback restores rotated nodes and group children by bounds delta without resizing groups", async () => {
  const root = geoNode("R", { type: "FRAME", width: 500, height: 500 });
  const flipped = geoNode("A", { x: 10, y: 40, width: 32, height: 32, bboxOffset: { x: 0, y: -32 } });
  const group = geoNode("G", { type: "GROUP", x: 50, y: 60, width: 100, height: 100 });
  const child = geoNode("C", { x: 60, y: 70 });
  root.appendChild(flipped);
  root.appendChild(group);
  group.appendChild(child);
  const journal = captureCleanupRollbackJournal(root);

  const frame = geoNode("F", { type: "FRAME", x: 5, y: 5 });
  root.appendChild(frame);
  journal.createdNodes.push(frame);
  frame.appendChild(flipped);
  frame.appendChild(child);
  flipped.x = 99;
  child.y = -7;

  const result = await rollbackCleanupTransaction(journal);
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.deepEqual(root.children.map((node) => node.id), ["A", "G"]);
  assert.deepEqual([flipped.x, flipped.y], [10, 40]);
  assert.deepEqual([child.parent.id, child.x, child.y], ["G", 60, 70]);
  assert.equal(group.resizeCalls, 0);
  assert.equal(frame.removed, true);
});

test("rollback leaves instance sublayers in place and reports leftover drift", async () => {
  const root = geoNode("R", { type: "FRAME" });
  const instance = geoNode("I", { type: "INSTANCE", x: 20, y: 20 });
  const inner = geoNode("I;1");
  const loose = geoNode("L", { x: 5, y: 5 });
  root.appendChild(instance);
  instance.appendChild(inner);
  root.appendChild(loose);
  instance.insertChild = () => { throw new Error("Cannot move node. New parent is an instance"); };
  const journal = captureCleanupRollbackJournal(root);

  assert.equal((await rollbackCleanupTransaction(journal)).pass, true);

  Object.defineProperty(loose, "x", { get: () => 77, set: () => {} });
  const stuck = await rollbackCleanupTransaction(journal);
  assert.equal(stuck.pass, false);
  assert.deepEqual(stuck.mismatches.map((item) => [item.nodeId, item.boundsDrift]), [["L", 72]]);
});

test("transaction source implements V2/V3 operations, nested-parent resolution, and recovery states", () => {
  const source = fs.readFileSync(new URL("../code/08_cleanup_transaction.mjs", import.meta.url), "utf8");
  for (const type of ["CREATE_GROUP", "RENAME_NODE", "MOVE_NODE", "REORDER_CHILDREN", "SET_AUTO_LAYOUT"]) {
    assert.match(source, new RegExp(`case ["']${type}["']`));
  }
  assert.match(source, /__cleanup_backup__/);
  assert.match(source, /state:\s*"rolled_back"/);
  assert.match(source, /state:\s*"recovery_required"/);
  assert.match(source, /parentOperationId/);
  assert.match(source, /cleanupResolveOperationParent/);
  assert.match(source, /createdNodeIds\.set/);
});
