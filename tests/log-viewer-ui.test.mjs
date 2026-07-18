import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const uiPath = new URL("../ui.html", import.meta.url);

test("log viewer exposes source, level, operation and keyword filters", async () => {
  const ui = await readFile(uiPath, "utf8");

  for (const id of [
    "logSourceFilter",
    "logLevelFilter",
    "logOperationFilter",
    "logKeywordFilter",
    "refreshLogsBtn",
    "downloadLogsBtn"
  ]) {
    assert.match(ui, new RegExp(`id=["']${id}["']`), `missing ${id}`);
  }
});

test("log viewer queries the Relay log API and can download filtered JSONL", async () => {
  const ui = await readFile(uiPath, "utf8");

  assert.match(ui, /relayEndpoint\("\/logs\?"\s*\+\s*query\.toString\(\)\)/);
  assert.match(ui, /relayEndpoint\("\/logs\/download\?"\s*\+\s*query\.toString\(\)\)/);
  assert.match(ui, /function\s+refreshLogViewer\s*\(/);
  assert.match(ui, /function\s+downloadFilteredLogs\s*\(/);
});

test("log viewer renders structured event fields and keeps error visibility", async () => {
  const ui = await readFile(uiPath, "utf8");

  assert.match(ui, /event\.operationId/);
  assert.match(ui, /event\.source/);
  assert.match(ui, /event\.level/);
  assert.match(ui, /log-event-error/);
});
