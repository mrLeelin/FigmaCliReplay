import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LogStore } from "../dist/logging/logStore.js";

function makeEvent(overrides = {}) {
  return {
    timestamp: "2026-07-18T10:00:00.000Z",
    level: "info",
    source: "relay",
    module: "test",
    operationId: "op-default",
    operationName: "test-operation",
    step: "run",
    stepIndex: 1,
    status: "progress",
    message: "message",
    ...overrides,
  };
}

test("appends JSONL and queries by operation, source, level, and keyword", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-logs-"));
  try {
    const store = new LogStore({ directory: root });
    store.append(makeEvent({ operationId: "op-a", source: "relay", level: "info", message: "started" }));
    store.append(makeEvent({ operationId: "op-a", source: "plugin", level: "error", message: "node failed" }));
    store.append(makeEvent({ operationId: "op-b", source: "unity", level: "info", message: "unrelated" }));
    await store.flush();

    const result = await store.query({ operationId: "op-a", level: "error", keyword: "failed", limit: 100 });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].source, "plugin");
    assert.equal(result.totalMatched, 1);
    assert.equal(fs.readFileSync(path.join(root, "relay-2026-07-18.jsonl"), "utf8").trim().split("\n").length, 3);
    await store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ingests cross-runtime batches with monotonic sequence and rejects oversized batches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-ingest-"));
  try {
    const store = new LogStore({
      directory: root,
      now: () => new Date("2026-07-18T10:00:01.000Z"),
    });
    const ingested = store.ingest([
      makeEvent({ source: "plugin", operationId: "op-cross", stepIndex: 2 }),
      makeEvent({ source: "ui", operationId: "op-cross", stepIndex: 1 }),
    ]);
    assert.deepEqual(ingested.map((event) => event.ingestSequence), [1, 2]);
    assert.ok(ingested.every((event) => event.ingestedAt === "2026-07-18T10:00:01.000Z"));
    assert.throws(() => store.ingest(Array.from({ length: 201 }, () => makeEvent())), /200/);
    await store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deletes files older than 14 days before enforcing 200 MB total", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-retention-"));
  try {
    fs.writeFileSync(path.join(root, "relay-2026-06-30.jsonl"), "x".repeat(40));
    fs.writeFileSync(path.join(root, "relay-2026-07-10.jsonl"), "y".repeat(80));
    fs.writeFileSync(path.join(root, "relay-2026-07-17.jsonl"), "z".repeat(80));
    const store = new LogStore({
      directory: root,
      retentionDays: 14,
      maxTotalBytes: 100,
      now: () => new Date("2026-07-18T10:00:00.000Z"),
    });
    await store.cleanup();
    assert.equal(fs.existsSync(path.join(root, "relay-2026-06-30.jsonl")), false);
    assert.equal(fs.existsSync(path.join(root, "relay-2026-07-10.jsonl")), false);
    assert.equal(fs.existsSync(path.join(root, "relay-2026-07-17.jsonl")), true);
    await store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uses emergency sink and never throws when the primary append fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-fallback-"));
  try {
    const blocker = path.join(root, "blocker");
    fs.writeFileSync(blocker, "not-a-directory");
    const emergency = [];
    const store = new LogStore({
      directory: path.join(blocker, "logs"),
      emergencyWrite: (line) => emergency.push(line),
    });
    assert.doesNotThrow(() => store.append(makeEvent({ level: "error" })));
    await store.flush();
    assert.equal(emergency.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
