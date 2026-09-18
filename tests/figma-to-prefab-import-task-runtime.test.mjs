import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const modulePath = path.resolve("dist/figmaPrefabImportTask.js");
assert.equal(fs.existsSync(modulePath), true, "figmaPrefabImportTask module must be built");
const {
  getFigmaPrefabImportTask,
  normalizeFigmaPrefabTargetFolder,
  parseFigmaPrefabImportSummary,
  startFigmaPrefabImportTask
} = await import(pathToFileURL(modulePath));
const { UnityProjectRegistry } = await import(pathToFileURL(path.resolve("dist/unityProjectRegistry.js")));
const { createRelayHttpServer } = await import(pathToFileURL(path.resolve("dist/httpServer.js")));

const config = {
  host: "127.0.0.1",
  publicHost: "localhost",
  port: 32130,
  legacyPort: 32131,
  mcpPath: "/mcp",
  transport: "auto",
  verbose: false,
  pythonWorker: true,
  adminToken: "",
  assetRoots: []
};

test("target folder normalization rejects absolute and traversal paths", () => {
  assert.equal(normalizeFigmaPrefabTargetFolder("Assets/UI/Import"), "Assets/UI/Import");
  assert.equal(normalizeFigmaPrefabTargetFolder("Assets/UI/Import/"), "Assets/UI/Import");
  assert.throws(() => normalizeFigmaPrefabTargetFolder("C:/Project/Assets/UI"), /Assets/);
  assert.throws(() => normalizeFigmaPrefabTargetFolder("Assets/../Outside"), /parent path/);
  assert.throws(() => normalizeFigmaPrefabTargetFolder("Assets"), /child folder/);
});

test("old HTTP import routes require upgrade without invoking business controls", async () => {
  const relay = {
    status: () => ({ status: "ok" }),
    hasLivePluginSession: () => false
  };
  const server = createRelayHttpServer(config, relay);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const startResponse = await fetch(`${baseUrl}/figma-to-prefab/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "not-live" })
    });
    assert.equal(startResponse.status, 410);

    const statusResponse = await fetch(`${baseUrl}/figma-to-prefab/import/not-found/status`);
    assert.equal(statusResponse.status, 410);
    for (const route of ["/prefab-to-figma/resolve-dropped", "/prefab-to-figma/import", "/open-plugin-folder", "/crop-jiugong"]) {
      const response = await fetch(baseUrl + route, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 410, route);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("summary parser requires one verified completion beneath the selected folder", () => {
  const valid = summaryOutput("Assets/Import");
  assert.equal(parseFigmaPrefabImportSummary(valid, "Assets/Import").verifyAllPass, true);
  assert.throws(() => parseFigmaPrefabImportSummary("", "Assets/Import"), /exactly one/);
  assert.throws(() => parseFigmaPrefabImportSummary(`${valid}\n${valid}`, "Assets/Import"), /exactly one/);
  assert.throws(
    () => parseFigmaPrefabImportSummary(summaryOutput("Assets/Elsewhere"), "Assets/Import"),
    /not beneath/
  );
  assert.throws(
    () => parseFigmaPrefabImportSummary(summaryOutput("Assets/Import", { atlasDir: "Assets/Import/Atlas/" }), "Assets/Import"),
    /fixed UiAtlas/
  );
  assert.throws(
    () => parseFigmaPrefabImportSummary(summaryOutput("Assets/Import", { verifyAllPass: false }), "Assets/Import"),
    /did not pass/
  );
});

test("task serializes one Unity project and reaches completed only after verified output", async () => {
  const fixture = createUnityFixture("success");
  let finishProcess;
  let capturedArgs = [];
  const processPromise = new Promise((resolve) => {
    finishProcess = resolve;
  });
  try {
    const task = startFigmaPrefabImportTask(config, fixture.registry, fixture.payload, {
      probeUnityGateway: async () => {},
      executePython: async (_task, _script, args) => {
        capturedArgs = args;
        return processPromise.then((result) => {
          fs.mkdirSync(path.join(fixture.projectPath, "Assets", "Import", "Prefab"), { recursive: true });
          fs.mkdirSync(path.join(fixture.projectPath, "Assets", "Import", "Texture"), { recursive: true });
          fs.mkdirSync(path.join(fixture.projectPath, "Assets", "Import", "UiAtlas"), { recursive: true });
          fs.writeFileSync(path.join(fixture.projectPath, "Assets", "Import", "Prefab", "Root.prefab"), "prefab", "utf8");
          fs.writeFileSync(path.join(fixture.projectPath, "Assets", "Import", "UiAtlas", "Root.spriteatlasv2"), "atlas", "utf8");
          return result;
        });
      }
    });
    assert.equal(task.status, "queued");
    await waitForStatus(task.taskId, "running");
    assert.throws(
      () => startFigmaPrefabImportTask(config, fixture.registry, fixture.payload, {
        probeUnityGateway: async () => {},
        executePython: async () => ({ exitCode: 0, stdout: summaryOutput("Assets/Import"), stderr: "" })
      }),
      /in flight/
    );

    finishProcess({ exitCode: 0, stdout: summaryOutput("Assets/Import"), stderr: "" });
    const completed = await waitForStatus(task.taskId, "completed");
    assert.equal(completed.summary.prefab, "Assets/Import/Prefab/Root.prefab");
    assert.equal(valueAfter(capturedArgs, "--unity-project"), fixture.projectPath);
    assert.equal(valueAfter(capturedArgs, "--formal-layout"), "split");
    assert.equal(valueAfter(capturedArgs, "--formal-output-dir"), "Assets/Import");
    assert.equal(valueAfter(capturedArgs, "--overwrite"), "create-new-only");
    assert.equal(valueAfter(capturedArgs, "--file-key"), fixture.payload.fileKey);
    assert.equal(valueAfter(capturedArgs, "--session-id"), fixture.payload.sessionId);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task records nonzero and malformed-success process results as errors", async () => {
  const fixture = createUnityFixture("errors");
  try {
    const nonzero = startFigmaPrefabImportTask(config, fixture.registry, fixture.payload, {
      probeUnityGateway: async () => {},
      executePython: async () => ({ exitCode: 2, stdout: "", stderr: "verification failed" })
    });
    const nonzeroResult = await waitForStatus(nonzero.taskId, "error");
    assert.match(nonzeroResult.error, /nonzero exit code 2/);
    assert.match(nonzeroResult.error, /verification failed/);

    const failedSummary = startFigmaPrefabImportTask(config, fixture.registry, fixture.payload, {
      probeUnityGateway: async () => {},
      executePython: async () => ({
        exitCode: 2,
        stdout: summaryOutput("Assets/Import", {
          status: "failed",
          verifyAllPass: false,
          blockingErrors: [{ code: "verify", message: "Prefab verification failed" }]
        }),
        stderr: ""
      })
    });
    const failedSummaryResult = await waitForStatus(failedSummary.taskId, "error");
    assert.match(failedSummaryResult.error, /blockingErrors/);
    assert.equal(failedSummaryResult.summary.verifyAllPass, false);

    const malformed = startFigmaPrefabImportTask(config, fixture.registry, fixture.payload, {
      probeUnityGateway: async () => {},
      executePython: async () => ({ exitCode: 0, stdout: "[SUMMARY_JSON]\nnot-json", stderr: "" })
    });
    const malformedResult = await waitForStatus(malformed.taskId, "error");
    assert.match(malformedResult.error, /malformed summary JSON/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task does not report completion when the verified summary points to missing outputs", async () => {
  const fixture = createUnityFixture("missing-output");
  try {
    const task = startFigmaPrefabImportTask(config, fixture.registry, fixture.payload, {
      probeUnityGateway: async () => {},
      executePython: async () => ({ exitCode: 0, stdout: summaryOutput("Assets/Import"), stderr: "" })
    });
    const result = await waitForStatus(task.taskId, "error");
    assert.match(result.error, /Prefab output does not exist/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("task rejects a target folder that escapes Assets through a symlink or junction", () => {
  const fixture = createUnityFixture("escape", false);
  const outside = path.join(fixture.root, "Outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fixture.projectPath, "Assets", "Import"), process.platform === "win32" ? "junction" : "dir");
  try {
    assert.throws(
      () => startFigmaPrefabImportTask(config, fixture.registry, fixture.payload),
      /symlink or junction/
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("stable import identity deduplicates, isolates owners, and survives unknown restart state", async () => {
  const fixture = createUnityFixture("dedupe");
  const payload = { ...fixture.payload, clientRequestId: randomUUID() };
  let executions = 0;
  const dependencies = {
    probeUnityGateway: async () => {},
    executePython: async () => { executions++; return { exitCode: 2, stdout: "", stderr: "fixture failure" }; }
  };
  try {
    const task = startFigmaPrefabImportTask(config, fixture.registry, payload, dependencies);
    assert.equal(startFigmaPrefabImportTask(config, fixture.registry, payload, dependencies).taskId, task.taskId);
    assert.throws(() => startFigmaPrefabImportTask(config, fixture.registry, { ...payload, sessionId: "other" }, dependencies), /identity conflict/);
    await waitForStatus(task.taskId, "error");
    assert.equal(startFigmaPrefabImportTask(config, fixture.registry, payload, dependencies).status, "error");
    assert.equal(executions, 1);
    const { RuntimeRelay } = await import("../dist/runtimeRelay.js");
    const read = (owner) => RuntimeRelay.prototype.algorithmControl.call({ config }, "figma.prefab.get", { taskId: task.taskId, fileKey: payload.fileKey, sessionId: owner });
    await assert.rejects(read("other"), /different Figma session/);
    assert.equal((await read(payload.sessionId)).task.taskId, task.taskId);
    const restarted = await import(pathToFileURL(modulePath).href + "?restart=" + randomUUID());
    assert.throws(() => restarted.startFigmaPrefabImportTask(config, fixture.registry, payload, dependencies), /existing artifacts/);
    assert.equal(executions, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dropped Prefabs resolve only against an explicit registered project", async () => {
  const fixture = createUnityFixture("drop");
  const { createRelayControlHandler } = await import("../dist/relayControl.js");
  const control = createRelayControlHandler({}, {}, {}, fixture.registry);
  try {
    const files = [{ fileName: "Root.prefab" }];
    fs.writeFileSync(path.join(fixture.projectPath, "Assets", "Import", "Root.prefab"), "prefab");
    await assert.rejects(control("prefab.resolve-dropped", { files }), /Explicit Unity project/);
    await assert.rejects(control("prefab.resolve-dropped", { files, projectId: "missing" }), /unknown Unity project/i);
    const result = await control("prefab.resolve-dropped", { files, projectId: fixture.payload.projectId, unityProjectPath: "ignored-untrusted-path" });
    assert.deepEqual(result.prefabPaths, ["Assets/Import/Root.prefab"]);
    fs.mkdirSync(path.join(fixture.projectPath, "Assets", "Other"));
    fs.writeFileSync(path.join(fixture.projectPath, "Assets", "Other", "Root.prefab"), "prefab");
    const conflict = await control("prefab.resolve-dropped", { files, projectId: fixture.payload.projectId });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflicts[0].candidates.length, 2);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createUnityFixture(label, createTarget = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `figma-prefab-${label}-`));
  const projectPath = path.join(root, "UnityProject");
  fs.mkdirSync(path.join(projectPath, "Assets", "Editor", "FigmaBridge"), { recursive: true });
  fs.mkdirSync(path.join(projectPath, "ProjectSettings"), { recursive: true });
  if (createTarget) fs.mkdirSync(path.join(projectPath, "Assets", "Import"), { recursive: true });
  const fontPath = "Assets/Fonts/CommonFont.asset";
  fs.mkdirSync(path.join(projectPath, "Assets", "Fonts"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, "Assets", "Fonts", "CommonFont.asset"), "font", "utf8");
  fs.writeFileSync(path.join(projectPath, "Assets", "Fonts", "CommonFont.mat"), "material", "utf8");
  fs.writeFileSync(
    path.join(projectPath, "ProjectSettings", "FigmaBridgeImportSettings.json"),
    JSON.stringify({ commonFontAsset: fontPath }),
    "utf8"
  );
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const project = registry.add(projectPath);
  return {
    root,
    projectPath,
    registry,
    payload: {
      projectId: project.id,
      gatewayProjectPath: projectPath,
      targetFolder: "Assets/Import",
      sessionId: "session-1",
      fileKey: "abcDEF_123",
      nodeId: "10:20",
      nodeName: "Root",
      nodeWidth: 750,
      nodeHeight: 1334
    }
  };
}

function summaryOutput(base, overrides = {}) {
  return `[SUMMARY_JSON]\n${JSON.stringify({
    status: "completed",
    prefab: `${base}/Prefab/Root.prefab`,
    targetImageDir: `${base}/Texture/`,
    atlasDir: `${base}/UiAtlas/`,
    atlasPath: `${base}/UiAtlas/Root.spriteatlasv2`,
    verifyAllPass: true,
    ...overrides
  })}`;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

async function waitForStatus(taskId, expected) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = getFigmaPrefabImportTask(taskId);
    if (task?.status === expected) return task;
    if (task?.status === "error" && expected !== "error") {
      assert.fail(`task failed before ${expected}: ${task.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`task ${taskId} did not reach ${expected}`);
}
