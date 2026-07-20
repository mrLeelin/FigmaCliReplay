import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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
