import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { RuntimeRelay } from "../dist/runtimeRelay.js";

const run = promisify(execFile);
async function explorerWindows() {
  const script = "$shellApp = New-Object -ComObject Shell.Application; ConvertTo-Json -InputObject @(@($shellApp.Windows()) | ForEach-Object { [pscustomobject]@{ hwnd=[string]$_.HWND; visible=[bool]$_.Visible; url=[string]$_.LocationURL } }) -Compress";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ""));
}

test("PSD folder action creates a visible Explorer window", {
  skip: process.platform !== "win32" || process.env.FIGMA_RELAY_FOLDER_OPEN_INTEGRATION !== "1",
  timeout: 15000,
}, async () => {
  const before = new Set((await explorerWindows()).map((window) => window.hwnd));
  const result = await RuntimeRelay.prototype.algorithmControl.call({}, "psd.export.open-folder", {});
  assert.equal(result.ok, true);
  const expected = new URL("file:///" + result.path.replaceAll("\\", "/")).href.toLowerCase();
  const deadline = Date.now() + 6000;
  let created = [];
  while (Date.now() < deadline) {
    created = (await explorerWindows()).filter((window) => !before.has(window.hwnd));
    if (created.some((window) => window.visible && window.url.toLowerCase() === expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail("Folder opener acknowledged success without showing the requested folder: " + JSON.stringify(created));
});
