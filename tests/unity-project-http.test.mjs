import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "../dist/config.js";
import { createRelayHttpServer } from "../dist/httpServer.js";
import { UnityProjectRegistry } from "../dist/unityProjectRegistry.js";

function createUnityProject(root, name) {
  const projectPath = path.join(root, name);
  fs.mkdirSync(path.join(projectPath, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
  return projectPath;
}

test("HTTP API manages the standalone Unity project registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-http-"));
  const projectPath = createUnityProject(root, "ProjectA");
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const config = parseArgs(["--port", "32198", "--admin-token", "test-token"]);
  const relay = { status: () => ({ status: "ok" }) };
  const server = createRelayHttpServer(config, relay, registry);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const initial = await fetch(`${baseUrl}/unity-projects`);
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json()).projects, []);

    const added = await fetch(`${baseUrl}/unity-projects/add`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ path: projectPath })
    });
    assert.equal(added.status, 200);
    const addedBody = await added.json();
    assert.equal(addedBody.project.path, path.resolve(projectPath));

    const listed = await fetch(`${baseUrl}/unity-projects`);
    const listedBody = await listed.json();
    assert.equal(listedBody.projects.length, 1);
    assert.equal(listedBody.lastSelectedProjectId, addedBody.project.id);

    const discoveryDirectory = path.join(projectPath, "Library", "FigmaBridge", "gateways");
    const olderDiscoveryPath = path.join(discoveryDirectory, "11111.json");
    const discoveryPath = path.join(discoveryDirectory, "12345.json");
    fs.mkdirSync(discoveryDirectory, { recursive: true });
    fs.writeFileSync(olderDiscoveryPath, JSON.stringify({
      version: 1,
      projectPath: path.resolve(projectPath),
      gatewayUrl: "http://localhost:32131",
      processId: 11111,
      updatedAtUtc: "2026-07-15T09:19:00.000Z"
    }), "utf8");
    fs.writeFileSync(discoveryPath, JSON.stringify({
      version: 1,
      projectPath: path.resolve(projectPath),
      gatewayUrl: "http://localhost:32132",
      processId: 12345,
      updatedAtUtc: "2026-07-15T09:20:00.000Z"
    }), "utf8");

    const gatewayEndpoint = `${baseUrl}/unity-projects/${encodeURIComponent(addedBody.project.id)}/gateway`;
    const discovered = await fetch(gatewayEndpoint);
    assert.equal(discovered.status, 200);
    assert.deepEqual(await discovered.json(), {
      found: true,
      gatewayUrl: "http://localhost:32132",
      updatedAtUtc: "2026-07-15T09:20:00.000Z"
    });

    fs.unlinkSync(discoveryPath);
    const olderFallback = await fetch(gatewayEndpoint);
    assert.deepEqual(await olderFallback.json(), {
      found: true,
      gatewayUrl: "http://localhost:32131",
      updatedAtUtc: "2026-07-15T09:19:00.000Z"
    });

    fs.writeFileSync(discoveryPath, JSON.stringify({
      version: 1,
      projectPath: path.join(root, "AnotherProject"),
      gatewayUrl: "http://localhost:32132",
      processId: 12345,
      updatedAtUtc: "2026-07-15T09:20:00.000Z"
    }), "utf8");
    const mismatched = await fetch(gatewayEndpoint);
    const mismatchedBody = await mismatched.json();
    assert.equal(mismatched.status, 200);
    assert.equal(mismatchedBody.gatewayUrl, "http://localhost:32131");
    assert.doesNotMatch(JSON.stringify(mismatchedBody), /AnotherProject/);

    fs.writeFileSync(path.join(discoveryDirectory, "99999.json"), JSON.stringify({
      version: 1,
      projectPath: path.resolve(projectPath),
      gatewayUrl: "https://example.com:32132",
      processId: 99999,
      updatedAtUtc: "not-an-iso-timestamp"
    }), "utf8");
    fs.unlinkSync(olderDiscoveryPath);
    const invalidOnly = await fetch(gatewayEndpoint);
    assert.deepEqual(await invalidOnly.json(), { found: false });

    fs.unlinkSync(discoveryPath);
    const missing = await fetch(gatewayEndpoint);
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), { found: false });

    fs.writeFileSync(path.join(discoveryDirectory, "77777.json"), JSON.stringify({
      version: 1,
      projectPath: path.resolve(projectPath),
      gatewayUrl: "http://localhost:32133",
      processId: 77777,
      updatedAtUtc: "2026-07-15T09:21:00.000Z"
    }), "utf8");
    fs.rmSync(path.join(projectPath, "Assets"), { recursive: true });
    const unavailableProject = await fetch(gatewayEndpoint);
    const unavailableBody = await unavailableProject.json();
    assert.equal(unavailableProject.status, 200);
    assert.deepEqual(unavailableBody, { found: false });
    assert.doesNotMatch(JSON.stringify(unavailableBody), new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const unknownProject = await fetch(`${baseUrl}/unity-projects/not-registered/gateway`);
    assert.equal(unknownProject.status, 404);
    assert.deepEqual(await unknownProject.json(), { error: "unknown Unity project" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
