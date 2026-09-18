import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelayHttpServer } from "../dist/httpServer.js";
import { parseArgs } from "../dist/config.js";
import { createRelayControlHandler } from "../dist/relayControl.js";

test("retired HTTP controls never execute business operations", async () => {
  const relay = new Proxy({}, { get: () => () => { throw new Error("Business HTTP must not execute"); } });
  const server = createRelayHttpServer(parseArgs([]), relay);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const route of ["/mcp", "/mcp/config/write", "/jobs", "/health", "/logs", "/logs/events", "/ai-runner/run", "/cleanup/runs", "/figma/pending", "/figma/result", "/figma/query-selection"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method });
        assert.equal(response.status, 410, `${method} ${route}`);
        assert.equal((await response.json()).code, "UPGRADE_REQUIRED");
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("WS status and log controls are available without a Figma target", async () => {
  const control = createRelayControlHandler({ status: () => ({ status: "ok" }) }, {});
  assert.equal((await control("relay.status", {})).status, "ok");
  assert.ok((await control("relay.status", {})).gateway.pluginRoot);
  await assert.rejects(control("logs.query", { query: { limit: 2000 } }), /pagination/);
  await assert.rejects(control("logs.query", { query: { from: "invalid" } }), /Invalid log from/);
  await assert.rejects(control("logs.query", { query: { keyword: {} } }), /Invalid log keyword/);
  await assert.rejects(control("logs.query", { query: { from: "2026-09-18", to: "2026-09-17" } }), /time range/);
  const result = await control("logs.query", { query: { source: "relay", limit: 2 } });
  assert.ok(Array.isArray(result.events));
  assert.ok(result.events.length <= 2);
});

test("HTTP only downloads registered assets for permitted runtime callers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-assets-"));
  const asset = path.join(root, "fixture.png");
  fs.writeFileSync(asset, Buffer.from([137, 80, 78, 71]));
  const server = createRelayHttpServer(parseArgs([]), { assetPath: (job, id) => job === "job" && id === "image" ? asset : undefined });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/assets/job/image")).status, 403);
  assert.equal((await fetch(base + "/assets/job/image", { headers: { Origin: "https://evil.example" } })).status, 403);
  const headers = { Origin: "https://www.figma.com" };
  assert.equal((await fetch(base + "/assets/job/missing", { headers })).status, 404);
  assert.equal((await fetch(base + "/assets/job/image", { method: "POST", headers })).status, 410);
  const response = await fetch(base + "/assets/job/image", { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(asset));
});

test("removed server options fail with an upgrade diagnosis", () => {
  for (const args of [["--mcp-path", "/mcp"], ["--legacy-port", "12345"], ["--transport", "polling"]]) assert.throws(() => parseArgs(args));
});
