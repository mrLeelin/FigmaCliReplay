import assert from "node:assert/strict";
import test from "node:test";
import { PythonAlgorithms } from "../dist/pythonAlgorithms.js";
import { parseArgs } from "../dist/config.js";

test("Python subprocess returns crop validation without an HTTP worker", { timeout: 15000 }, async (t) => {
  const algorithms = new PythonAlgorithms(parseArgs([]));
  t.after(() => algorithms.close());
  const result = await algorithms.crop({ unityProjectPath: "/nonexistent/project" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid Unity project/);
  assert.equal(algorithms.status().processRunning, false);
  assert.equal(algorithms.status().url, "");
});

test("Prefab requests deduplicate, reject conflicts, and isolate snapshots by session", { timeout: 15000 }, async (t) => {
  const algorithms = new PythonAlgorithms(parseArgs([]));
  t.after(() => algorithms.close());
  const payload = { clientRequestId: "test-import", sessionId: "one", fileKey: "file",
    unityProjectPath: "/nonexistent/project", prefabPaths: ["Assets/a.prefab"] };
  assert.throws(() => algorithms.startImport({ ...payload, sessionId: "" }), /sessionId/);
  const started = algorithms.startImport(payload);
  assert.deepEqual(algorithms.startImport(Object.fromEntries(Object.entries(payload).reverse())), started);
  assert.throws(() => algorithms.startImport({ ...payload, fileKey: "other" }), /conflicts/);
  assert.throws(() => algorithms.getImport(started.taskId, "two"), /different Figma session/);
  const snapshot = algorithms.getImport(started.taskId, "one");
  snapshot.status = "tampered";
  assert.notEqual(algorithms.getImport(started.taskId, "one").status, "tampered");
  const deadline = Date.now() + 10000;
  while (algorithms.getImport(started.taskId, "one").status !== "error") {
    assert.ok(Date.now() < deadline, "Python failure should reach the stored task");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(algorithms.getImport(started.taskId, "one").errors[0], /Unity project/);
  assert.deepEqual(algorithms.startImport(payload), started);
  assert.equal(algorithms.getImport(started.taskId, "one").status, "error");
  assert.throws(() => algorithms.getImport("missing", "one"), /do not replay/);
});

test("disabled Python algorithms reject without launching a process", async () => {
  const algorithms = new PythonAlgorithms(parseArgs(["--no-python-worker"]));
  await assert.rejects(algorithms.crop({}), /disabled/);
  assert.equal(algorithms.status().processRunning, false);
});
