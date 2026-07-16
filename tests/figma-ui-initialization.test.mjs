import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("plugin initialization tolerates Figma denying local storage access", () => {
  const helperMatch = ui.match(/function getSafeLocalStorage\(\)\s*\{[\s\S]*?\n    \}/);
  assert.ok(helperMatch, "safe local-storage accessor should exist");

  const deniedWindow = {};
  Object.defineProperty(deniedWindow, "localStorage", {
    get() {
      throw new DOMException("Storage denied", "SecurityError");
    },
  });

  const getSafeLocalStorage = new Function(
    "window",
    `${helperMatch[0]}; return getSafeLocalStorage;`,
  )(deniedWindow);

  assert.equal(getSafeLocalStorage(), null);
  assert.match(ui, /const relayRuntimeStorage = getSafeLocalStorage\(\);/);
  assert.doesNotMatch(ui, /readCachedRelayRuntimePaths\(localStorage,/);
  assert.doesNotMatch(ui, /\}, localStorage,/);
  assert.match(ui, /tabButtons\.forEach\([\s\S]*?button\.addEventListener\("click"/);
});

test("window-level PSD drop remains available for hidden import templates", () => {
  assert.match(ui, /document\.addEventListener\("dragover", handleAiPromptPsdWindowDragOver\)/);
  assert.match(ui, /document\.addEventListener\("drop", handleAiPromptPsdWindowDrop\)/);
});
