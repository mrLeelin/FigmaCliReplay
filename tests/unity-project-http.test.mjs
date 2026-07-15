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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
