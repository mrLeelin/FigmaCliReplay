import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deleteCleanupRecoveryBackup,
  listCleanupRecoveryBackups,
  restoreCleanupRecoveryBackup,
} from "../code/08_cleanup_transaction.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeContainer(id = "page") {
  return {
    id,
    name: id,
    children: [],
    insertChild(index, node) {
      if (node.parent && Array.isArray(node.parent.children)) {
        const previous = node.parent.children.indexOf(node);
        if (previous >= 0) node.parent.children.splice(previous, 1);
      }
      const bounded = Math.max(0, Math.min(index, this.children.length));
      this.children.splice(bounded, 0, node);
      node.parent = this;
    },
  };
}

let nextCloneId = 1;
function makeNode(options = {}) {
  const pluginData = new Map(Object.entries(options.pluginData || {}));
  const node = {
    id: options.id || `node-${Math.random()}`,
    name: options.name || "Node",
    type: options.type || "FRAME",
    x: options.x ?? 0,
    y: options.y ?? 0,
    visible: options.visible ?? true,
    locked: options.locked ?? false,
    removed: false,
    parent: null,
    getPluginData(key) { return pluginData.get(key) || ""; },
    setPluginData(key, value) { pluginData.set(key, String(value)); },
    clone() {
      const clone = makeNode({
        id: `clone-${nextCloneId++}`,
        name: this.name,
        type: this.type,
        x: this.x,
        y: this.y,
        visible: this.visible,
        locked: this.locked,
        pluginData: Object.fromEntries(pluginData),
      });
      if (this.parent) this.parent.insertChild(this.parent.children.indexOf(this) + 1, clone);
      return clone;
    },
    remove() {
      if (this.parent && Array.isArray(this.parent.children)) {
        const index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
      }
      this.parent = null;
      this.removed = true;
    },
  };
  return node;
}

test("orphan recovery discovery returns only reserved backup roots", () => {
  const page = makeContainer();
  const normal = makeNode({ id: "normal", name: "Panel" });
  const backup = makeNode({ id: "backup", name: "__cleanup_backup__run-1" });
  page.insertChild(0, normal);
  page.insertChild(1, backup);

  assert.deepEqual(listCleanupRecoveryBackups(page), [{
    nodeId: "backup",
    name: "__cleanup_backup__run-1",
    runId: "run-1",
    sourceName: "",
    type: "FRAME",
  }]);
});

test("explicit recovery replaces the selected damaged root and removes its backup", () => {
  const page = makeContainer();
  const target = makeNode({ id: "damaged", name: "Damaged", x: 90, y: 80 });
  const backup = makeNode({
    id: "backup",
    name: "__cleanup_backup__run-2",
    visible: false,
    locked: true,
    x: 999,
    y: 999,
    pluginData: {
      cleanupRecoveryMetadata: JSON.stringify({
        schemaVersion: 1,
        runId: "run-2",
        sourceName: "Original",
        sourceX: 12,
        sourceY: 34,
        sourceVisible: true,
        sourceLocked: false,
      }),
    },
  });
  page.insertChild(0, target);
  page.insertChild(1, backup);

  const result = restoreCleanupRecoveryBackup(backup, target);
  assert.equal(result.replacedNodeId, "damaged");
  assert.notEqual(result.restoredNodeId, "damaged");
  assert.equal(page.children.length, 1);
  assert.equal(page.children[0].id, result.restoredNodeId);
  assert.equal(page.children[0].name, "Original");
  assert.equal(page.children[0].x, 12);
  assert.equal(page.children[0].y, 34);
  assert.equal(page.children[0].visible, true);
  assert.equal(page.children[0].locked, false);
  assert.equal(target.removed, true);
  assert.equal(backup.removed, true);
});

test("delete recovery removes only the chosen backup", () => {
  const page = makeContainer();
  const backup = makeNode({ id: "backup", name: "__cleanup_backup__run-3" });
  page.insertChild(0, backup);
  assert.deepEqual(deleteCleanupRecoveryBackup(backup), { deletedNodeId: "backup" });
  assert.equal(backup.removed, true);
  assert.equal(page.children.length, 0);
});

test("plugin UI exposes restore, delete, and defer without persisting source node IDs", () => {
  const ui = fs.readFileSync(path.join(root, "ui.html"), "utf8");
  const handlers = fs.readFileSync(path.join(root, "code", "01_handlers.js"), "utf8");
  const transaction = fs.readFileSync(path.join(root, "code", "08_cleanup_transaction.mjs"), "utf8");
  assert.match(ui, /id="restoreCleanupRecoveryBtn"[^>]*>恢复所选节点</);
  assert.match(ui, /id="deleteCleanupRecoveryBtn"[^>]*>删除备份</);
  assert.match(ui, /id="deferCleanupRecoveryBtn"[^>]*>暂不处理</);
  assert.match(handlers, /QUERY_CLEANUP_RECOVERY_BACKUPS/);
  assert.match(handlers, /RESTORE_CLEANUP_RECOVERY_BACKUP/);
  assert.match(handlers, /DELETE_CLEANUP_RECOVERY_BACKUP/);
  assert.doesNotMatch(transaction, /sourceNodeId|sourceParentId/);
});
