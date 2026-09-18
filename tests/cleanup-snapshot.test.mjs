import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  CleanupSnapshotLimits,
  buildCleanupSnapshot,
} from "../code/07_cleanup_snapshot.mjs";

const MetadataNamespace = "psd_layer_to_figma_bridge";

function fakeNode({
  id,
  type = "FRAME",
  name = id,
  x = 0,
  y = 0,
  width = 100,
  height = 40,
  visible = true,
  opacity = 1,
  characters,
  fills = [],
  metadata = {},
  children = [],
}) {
  const node = {
    id,
    type,
    name,
    x,
    y,
    width,
    height,
    visible,
    opacity,
    fills,
    children,
    arbitrarySecret: "must-not-leak",
    getSharedPluginData(namespace, key) {
      assert.equal(namespace, MetadataNamespace);
      return metadata[key] || "";
    },
  };
  if (characters !== undefined) node.characters = characters;
  for (const child of children) child.parent = node;
  return node;
}

test("captures one compact pre-order subtree with stable sibling indexes", () => {
  const title = fakeNode({
    id: "1:2",
    type: "TEXT",
    name: "Title",
    x: 12,
    y: 20,
    width: 80,
    height: 24,
    opacity: 0.75,
    characters: "x".repeat(300),
    metadata: {
      psdLayerId: "205",
      psdOwnership: "text",
      psdContentHash: "sha256-title",
      rawPsdLayerName: "标题",
      ignoredPrivateKey: "no",
    },
  });
  const icon = fakeNode({
    id: "1:3",
    type: "RECTANGLE",
    name: "Icon_Image",
    fills: [{ type: "IMAGE", imageHash: "secret-image-hash", bytes: "secret-bytes" }],
  });
  const slices = fakeNode({
    id: "1:5",
    type: "FRAME",
    name: "Button__slice_9",
    metadata: { spriteBorder: "4,4,4,4" },
  });
  const component = fakeNode({ id: "1:4", type: "INSTANCE", name: "CommonBtn", children: [slices] });
  const root = fakeNode({
    id: "1:1",
    name: "Screen",
    metadata: {
      psdSourceFileName: "screen.psd",
      psdSourceKey: "screen.psd:750x1334:abc",
      psdLayerSetFingerprint: "abc",
    },
    children: [title, icon, component],
  });

  const snapshot = buildCleanupSnapshot(root, {
    ...CleanupSnapshotLimits,
    now: () => "2026-07-17T06:30:00.000Z",
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.rootNodeId, "1:1");
  assert.equal(snapshot.capturedAt, "2026-07-17T06:30:00.000Z");
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ["1:1", "1:2", "1:3", "1:4", "1:5"]);
  assert.deepEqual(snapshot.nodes.map((node) => node.depth), [0, 1, 1, 1, 2]);
  assert.deepEqual(snapshot.nodes.slice(1, 4).map((node) => node.siblingIndex), [0, 1, 2]);

  const titleRecord = snapshot.nodes[1];
  assert.deepEqual(
    {
      parentId: titleRecord.parentId,
      type: titleRecord.type,
      name: titleRecord.name,
      x: titleRecord.x,
      y: titleRecord.y,
      w: titleRecord.w,
      h: titleRecord.h,
      visible: titleRecord.visible,
      opacity: titleRecord.opacity,
      childCount: titleRecord.childCount,
    },
    {
      parentId: "1:1",
      type: "TEXT",
      name: "Title",
      x: 12,
      y: 20,
      w: 80,
      h: 24,
      visible: true,
      opacity: 0.75,
      childCount: 0,
    },
  );
  assert.equal(titleRecord.characters.length, 256);
  assert.deepEqual(titleRecord.psd, {
    psdLayerId: "205",
    psdOwnership: "text",
    psdContentHash: "sha256-title",
    rawPsdLayerName: "标题",
  });
  assert.equal(titleRecord.roles.psdSource, true);
  assert.equal(snapshot.nodes[2].roles.image, true);
  assert.equal(snapshot.nodes[3].roles.component, true);
  assert.equal(snapshot.nodes[4].roles.nineSlice, true);

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret-image-hash|secret-bytes|must-not-leak|ignoredPrivateKey/);
  assert.doesNotMatch(serialized, /fills|imageHash|absolutePath|token/);
});

test("rejects a subtree above the node limit", () => {
  const root = fakeNode({ id: "root", children: [fakeNode({ id: "a" }), fakeNode({ id: "b" })] });
  assert.throws(
    () => buildCleanupSnapshot(root, { ...CleanupSnapshotLimits, maxNodes: 2 }),
    /cleanup snapshot exceeds 2 nodes/,
  );
});

test("rejects a subtree above the depth limit", () => {
  const leaf = fakeNode({ id: "leaf" });
  const child = fakeNode({ id: "child", children: [leaf] });
  const root = fakeNode({ id: "root", children: [child] });
  assert.throws(
    () => buildCleanupSnapshot(root, { ...CleanupSnapshotLimits, maxDepth: 1 }),
    /cleanup snapshot exceeds depth 1/,
  );
});

test("rejects a serialized snapshot above the byte limit", () => {
  const root = fakeNode({ id: "root", name: "large-name".repeat(20) });
  assert.throws(
    () => buildCleanupSnapshot(root, { ...CleanupSnapshotLimits, maxBytes: 80 }),
    /cleanup snapshot exceeds 80 bytes/,
  );
});

test("plugin exposes one read-only cleanup snapshot command", () => {
  const handlers = fs.readFileSync(new URL("../code/01_handlers.js", import.meta.url), "utf8");
  const buildScript = fs.readFileSync(new URL("../scripts/build.py", import.meta.url), "utf8");

  assert.match(handlers, /message\.type === "QUERY_CLEANUP_SNAPSHOT"/);
  assert.match(handlers, /async function handleQueryCleanupSnapshot/);
  assert.match(handlers, /message\.rootNodeId/);
  assert.match(handlers, /figma\.getNodeByIdAsync\(requestedRootId\)/);
  assert.match(handlers, /buildCleanupSnapshot\(selection\[0\]\)/);
  assert.match(handlers, /type: "QUERY_CLEANUP_SNAPSHOT_RESULT"/);
  assert.match(buildScript, /"07_cleanup_snapshot\.mjs"/);
});
