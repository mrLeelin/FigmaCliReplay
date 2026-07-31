import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);

test("auto-start installer creates a current-user startup command that starts the hidden gateway", async () => {
  const source = await readFile(new URL("scripts/install_mcp_autostart.ps1", root), "utf8");

  assert.match(source, /start_mcp_hidden\.ps1/);
  assert.match(source, /SpecialFolder\]::Startup/);
  assert.match(source, /Set-Content.*StartupCommand/);
  assert.match(source, /Remove-Item.*StartupCommand/);
});

test("auto-start installer does not require elevation or run the gateway as another account", async () => {
  const source = await readFile(new URL("scripts/install_mcp_autostart.ps1", root), "utf8");

  assert.doesNotMatch(source, /-RunLevel\s+Highest/i);
  assert.doesNotMatch(source, /-User\s+/i);
});
