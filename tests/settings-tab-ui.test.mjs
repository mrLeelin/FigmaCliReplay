import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("connection settings live behind a dedicated settings tab", () => {
  const settingsButtonIndex = ui.indexOf('data-tab="settings-tab"');
  const settingsPageIndex = ui.indexOf('class="tab-page" id="settings-tab"');
  const mcpSectionIndex = ui.indexOf('id="ai-section"');
  const unitySectionIndex = ui.indexOf('id="unity-section"');
  const settingsPageEndIndex = ui.indexOf("<!-- SETTINGS_TAB_END -->");

  assert.notEqual(settingsButtonIndex, -1, "main navigation should expose the settings tab");
  assert.notEqual(settingsPageIndex, -1, "settings tab page should exist");
  assert.match(ui, /data-tab="settings-tab"[^>]*>设置<\/button>/);
  assert.ok(settingsPageIndex < mcpSectionIndex, "MCP Companion should be inside settings");
  assert.ok(mcpSectionIndex < unitySectionIndex, "Unity gateway should follow MCP Companion");
  assert.ok(unitySectionIndex < settingsPageEndIndex, "Unity gateway should remain inside settings");
  assert.match(ui, /\.tabs\s*\{[\s\S]*?display:\s*flex/);
  assert.match(ui, /\.tab-button\s*\{[\s\S]*?flex:\s*1/);
});

test("Figma location stays on the main screen before feature navigation", () => {
  const locationIndex = ui.indexOf('id="figma-location-section"');
  const tabsIndex = ui.indexOf('<div class="tabs" role="tablist">');

  assert.ok(locationIndex >= 0 && locationIndex < tabsIndex);
});
