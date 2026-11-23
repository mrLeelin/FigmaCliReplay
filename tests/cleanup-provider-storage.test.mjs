import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const handlers = fs.readFileSync(new URL("../code/01_handlers.js", import.meta.url), "utf8");

test("provider preference uses Figma clientStorage and an allowlist", () => {
  assert.match(handlers, /figma\.clientStorage\.getAsync\("cleanup\.preferredPlanningProvider"\)/);
  assert.match(handlers, /figma\.clientStorage\.setAsync\("cleanup\.preferredPlanningProvider"/);
  assert.match(handlers, /providerId === "codex" \|\| providerId === "claude-code"/);
  assert.match(handlers, /GET_CLEANUP_PROVIDER_PREFERENCE_RESULT/);
  assert.match(handlers, /SET_CLEANUP_PROVIDER_PREFERENCE_RESULT/);
});
