import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildPsdIncrementalDiff,
  isPsdIncrementalCandidate,
  normalizePsdSourceState,
} from "../code/06_psd_incremental.mjs";
import { buildCleanupSnapshot, isCleanupRecoveryNode } from "../code/07_cleanup_snapshot.mjs";

function fakeNode(id, name, type = "FRAME") {
  return {
    id,
    name,
    type,
    parent: null,
    children: [],
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    visible: true,
    opacity: 1,
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
    },
  };
}

test("backup descendants are excluded from cleanup snapshots", () => {
  const root = fakeNode("R", "Root");
  const active = fakeNode("A", "Active");
  const backup = fakeNode("B", "__cleanup_backup__run-1");
  const backupSource = fakeNode("PSD-A", "Source", "RECTANGLE");
  root.appendChild(active);
  root.appendChild(backup);
  backup.appendChild(backupSource);

  assert.equal(isCleanupRecoveryNode(backupSource), true);
  const snapshot = buildCleanupSnapshot(root, { now: () => "2026-07-17T00:00:00.000Z" });
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ["R", "A"]);
  assert.equal(snapshot.nodes[0].childCount, 1);
  assert.equal(snapshot.nodes[1].siblingIndex, 0);
});

test("PSD incremental matching ignores records under cleanup recovery backups", () => {
  const backup = fakeNode("B", "__cleanup_backup__run-1");
  const backupSource = fakeNode("PSD-A", "Source", "RECTANGLE");
  backup.appendChild(backupSource);
  const recoveryRecord = { layerId: "42", contentHash: "old", node: backupSource };
  const incoming = { layerId: "42", contentHash: "new" };
  const activeRecord = {
    layerId: "42",
    contentHash: "new",
    sourceState: normalizePsdSourceState(incoming),
    node: fakeNode("A", "Active", "RECTANGLE"),
  };
  assert.equal(isPsdIncrementalCandidate(recoveryRecord), false);
  const diff = buildPsdIncrementalDiff([recoveryRecord, activeRecord], [incoming]);
  assert.equal(diff.conflicts.length, 0);
  assert.equal(diff.unchanged.length, 1);
});

test("Unity and hierarchy collectors guard the shared recovery predicate", () => {
  const hierarchy = fs.readFileSync(new URL("../code/04_hierarchy.js", import.meta.url), "utf8");
  const utils = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");
  assert.match(hierarchy, /collectFigmaPrefabNodes[\s\S]{0,300}isCleanupRecoveryNode/);
  assert.match(utils, /collectPsdBoundNodes[\s\S]{0,300}isCleanupRecoveryNode/);
  assert.match(utils, /collectHierarchyExportNode[\s\S]{0,500}isCleanupRecoveryNode/);
});
