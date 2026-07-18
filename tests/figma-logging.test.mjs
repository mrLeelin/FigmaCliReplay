import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");

test("PluginLogger posts correlated plugin events to the Figma UI", () => {
  const source = fs.readFileSync(path.join(ROOT, "code", "00_logging.js"), "utf8");
  const posted = [];
  const context = {
    console: { error() {} },
    Date,
    Math,
    figma: { ui: { postMessage: (message) => posted.push(message) } },
  };
  vm.runInNewContext(`${source}\n;globalThis.__PluginLogger = PluginLogger;`, context);
  const logger = new context.__PluginLogger({
    module: "test-plugin",
    clock: () => Date.parse("2026-07-18T10:00:00.000Z"),
    idFactory: () => "generated",
    postEvent: (event) => context.figma.ui.postMessage({ type: "LOG_EVENT", event }),
  });
  logger.info("插件步骤", { count: 1 }, { operationId: "op-plugin" });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "LOG_EVENT");
  assert.equal(posted[0].event.source, "plugin");
  assert.equal(posted[0].event.operationId, "op-plugin");
});

test("UiLogger caps its queue while preserving error events", () => {
  const html = fs.readFileSync(path.join(ROOT, "ui.html"), "utf8");
  const match = html.match(/\/\/ BEGIN_UI_LOGGER([\s\S]*?)\/\/ END_UI_LOGGER/);
  assert.ok(match, "UI logger marker block is required");
  const rendered = [];
  const context = { Date, Math };
  vm.runInNewContext(`${match[1]}\n;globalThis.__UiLogger = UiLogger;`, context);
  const logger = new context.__UiLogger({
    maxQueue: 2,
    render: (event) => rendered.push(event),
    idFactory: () => `ui-${rendered.length}`,
  });
  logger.info("normal-1");
  logger.error("important", new Error("boom"));
  logger.info("normal-2");

  assert.equal(rendered.length, 3);
  assert.equal(logger.pendingEvents.length, 2);
  assert.ok(logger.pendingEvents.some((event) => event.level === "error"));
  assert.ok(logger.pendingEvents.some((event) => event.message === "normal-2"));
});

test("Figma build and UI transport include the dedicated logging layer", () => {
  const build = fs.readFileSync(path.join(ROOT, "scripts", "build.py"), "utf8");
  assert.ok(build.indexOf('"00_logging.js"') < build.indexOf('"00_init.js"'));

  const html = fs.readFileSync(path.join(ROOT, "ui.html"), "utf8");
  assert.match(html, /type:\s*["']log\.events["']/);
  assert.match(html, /message\.type\s*===\s*["']LOG_EVENT["']/);
  assert.match(html, /operationId/);
});

test("plugin fragments keep direct console diagnostics inside PluginLogger only", () => {
  const offenders = [];
  for (const entry of fs.readdirSync(path.join(ROOT, "code"))) {
    if (!/\.(?:js|mjs)$/.test(entry) || entry === "00_logging.js") continue;
    const source = fs.readFileSync(path.join(ROOT, "code", entry), "utf8");
    if (/console\.(?:log|info|warn|error|debug)\s*\(/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, []);
});
