import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const plugin = fs.readFileSync(new URL("../code.js", import.meta.url), "utf8");

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fixture(exportPng) {
  const messages = [];
  const page = { id: "page", selection: [], children: [] };
  const objects = [];
  const figma = {
    currentPage: page, showUI() {}, notify() {}, on() {}, off() {},
    ui: { postMessage: data => messages.push(JSON.parse(JSON.stringify(data))) },
    createFrame() {
      const frame = createNode(page, "stage", { children: [], exportAsync: options => exportPng(frame, options) });
      frame.appendChild = clone => {
        clone.remove();
        clone.removed = false;
        clone.parent = frame;
        frame.children.push(clone);
      };
      return frame;
    },
    createRectangle: () => createNode(page, "output"),
    createImage: () => ({ hash: "png-hash" })
  };
  function createNode(parent, id, properties) {
    const node = Object.assign({
      id, parent, name: id, visible: true, removed: false,
      resize(width, height) { this.width = width; this.height = height; },
      remove() {
        this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.removed = true;
        for (const child of [...(this.children || [])]) child.remove();
      },
    }, properties);
    parent.children.push(node);
    objects.push(node);
    return node;
  }
  function createImage(parent, id, x, y, transform = [[1, 0, x], [0, 1, y]]) {
    const bounds = { x, y, width: 40, height: 30 };
    return createNode(parent, id, {
      fills: [{ type: "IMAGE", imageHash: id }],
      absoluteRenderBounds: bounds, absoluteTransform: transform,
      clone() { return createNode(parent, id + "-clone", { fills: this.fills, opacity: this.opacity }); }
    });
  }
  vm.runInNewContext(plugin, { figma, __html__: "", setTimeout() {} });
  const requestId = "test-merge";
  return {
    page, figma, objects, createNode, createImage,
    run: () => figma.ui.onmessage({ type: "MERGE_IMAGE_LAYERS", requestId }),
    result: () => messages.find(message => message.type === "MERGE_IMAGE_LAYERS_RESULT" && message.requestId === requestId).result,
    logs: () => messages.filter(message => message.event?.operationId === requestId
      && message.event.operationName === "figma.merge-image-layers").map(message => message.event)
  };
}

test("merges by canvas order and keeps source hierarchy and transforms intact", async () => {
  const app = fixture((stage, options) => {
    assert.equal(options.format, "PNG");
    assert.equal(options.contentsOnly, true);
    assert.equal(options.useAbsoluteBounds, true);
    assert.equal(stage.fills.length, 0);
    assert.deepEqual(stage.children.map(node => node.id), ["back-clone", "second-clone", "first-clone"]);
    assert.equal(stage.children[2].opacity, 0.5);
    assert.deepEqual(JSON.parse(JSON.stringify(stage.children[2].relativeTransform)), [[0, 1, 10], [-1, 0, 15]]);
    return pngHeader(stage.width, stage.height);
  });
  const back = app.createImage(app.page, "back", -10, 10);
  const group = app.createNode(app.page, "layout", { children: [], layoutMode: "HORIZONTAL", itemReverseZIndex: true });
  const first = app.createImage(group, "first", 0, 25, [[0, 1, 0], [-1, 0, 25]]);
  first.opacity = 0.5;
  const second = app.createImage(group, "second", 5, 25);
  app.page.selection = [first, second, back];
  await app.run();

  const output = app.page.children[2];
  assert.deepEqual(app.result(), { ok: true, count: 3, nodeId: "output", width: 55, height: 45, scale: 1 });
  assert.deepEqual(app.page.children, [back, group, output]);
  assert.deepEqual(group.children, [first, second]);
  assert.deepEqual(first.absoluteTransform, [[0, 1, 0], [-1, 0, 25]]);
  assert.deepEqual([output.x, output.y, output.width, output.height], [77, 10, 55, 45]);
  assert.equal(output.fills[0].scaleMode, "CROP");
  assert.equal(output.fills[0].imageHash, "png-hash");
  assert.equal(app.page.selection[0], output);
  assert.deepEqual(app.logs().map(log => log.status), ["started", "progress", "progress", "progress", "progress", "succeeded"]);
});

test("rejects an invalid selection before creating any temporary nodes", async () => {
  const app = fixture(() => assert.fail("invalid selection reached export"));
  const image = app.createImage(app.page, "image", 0, 0);
  const solid = app.createNode(app.page, "solid", { fills: [{ type: "SOLID" }] });
  app.page.selection = [image, solid];
  await app.run();
  assert.match(app.result().error, /solid.*图片填充/);
  assert.equal(app.objects.length, 2);
  assert.deepEqual(app.logs().map(log => log.status), ["started", "progress", "failed"]);
});

test("cleans up staged clones and preserves the selection when rendering fails", async () => {
  const app = fixture(() => { throw new Error("renderer failed"); });
  const originals = [app.createImage(app.page, "one", 0, 0), app.createImage(app.page, "two", 20, 0)];
  app.page.selection = originals;
  await app.run();
  assert.equal(app.result().error, "renderer failed");
  assert.equal(app.page.selection, originals);
  assert.deepEqual(app.page.children, originals);
  assert.ok(app.objects.slice(2).every(node => node.removed));
  assert.deepEqual(app.logs().map(log => log.step), ["operation.start", "validate-selection", "render", "cleanup", "operation.complete"]);
  assert.equal(app.logs().at(-1).status, "failed");
});

test("downsamples wide selections and preserves an in-flight selection change", async () => {
  const app = fixture(async (stage, options) => {
    assert.equal(options.constraint.value, 0.5);
    app.page.selection = [app.page.children[0]];
    return pngHeader(stage.width * 0.5, stage.height * 0.5);
  });
  const first = app.createImage(app.page, "one", 0, 0);
  const second = app.createImage(app.page, "two", 8152, 0);
  app.page.selection = [first, second];
  await app.run();
  assert.equal(app.result().width, 4096);
  assert.equal(app.result().scale, 0.5);
  assert.equal(app.page.children[2].width, 8192);
  assert.deepEqual(app.page.selection, [first]);
});
