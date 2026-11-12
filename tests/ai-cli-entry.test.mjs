import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { PLUGIN_ROOT } from "../dist/config.js";
import { relayCliInstructions } from "../dist/ai/relayCliInstructions.js";
import {
  buildInteractiveTerminalTask,
  buildLocalAiConversationTask,
  runLocalAiPrompt,
} from "../dist/localAiRunner.js";

function assertDiscovery(task, sessionId) {
  const help = task.indexOf("figma-relay --help");
  const commands = task.indexOf("figma-relay commands --search <topic> --json");
  const describe = task.indexOf("figma-relay describe <operation> --json");
  assert.ok(help >= 0 && commands > help && describe > commands, "discover operations before constructing their payloads");
  assert.ok(task.includes(`sessionId ${JSON.stringify(sessionId)}`), "pin the task to its originating plugin");
  assert.match(task, /--session-id/);
  assert.match(task, /--payload-file/);
  assert.match(task, /Discovery is read-only and grants no additional mutation authority/);
  assert.ok(task.includes(`node "${path.join(PLUGIN_ROOT, "dist", "cli.js").replaceAll("\\", "/")}"`));
}

test("tracked task templates expose discovery without losing their workflow context", () => {
  const project = { id: "game-project", name: "Game", path: "E:/Games/Game", lastSeenAt: "2026-11-12T00:00:00Z", valid: true, bridgeInstalled: true, settingsConfigured: true };
  for (const template of ["cleanup", "unity", "componentVariants"]) {
    const task = buildLocalAiConversationTask(template, "Read the selected panel", template === "unity" ? project : undefined, undefined, "origin-session");
    assertDiscovery(task, "origin-session");
    assert.match(task, /Read the selected panel/);
    if (template === "cleanup") {
      assert.match(task, /Mandatory skill file: .*figma-hierarchy-cleanup\/SKILL\.md/);
      assert.match(task, /This initial turn is read-only/);
      assert.match(task, /Relay dispatches the validated safe hierarchy transaction automatically/);
    }
    if (template === "unity") assert.ok(task.includes(JSON.stringify(project, null, 2)));
  }
});

test("interactive terminal templates preserve endpoint ownership and target context", () => {
  for (const template of ["cleanup", "unity", "componentVariants"]) {
    const task = buildInteractiveTerminalTask(template, "Inspect the current selection", undefined, "terminal-session");
    assertDiscovery(task, "terminal-session");
    assert.match(task, /Inspect the current selection/);
    assert.match(task, /externally managed endpoint/);
    assert.match(task, /never launch, restart, stop/);
  }
});

test("a discovery pointer without a known session requests target selection instead of guessing", () => {
  const instructions = relayCliInstructions();
  assert.match(instructions, /figma-relay sessions/);
  assert.match(instructions, /multiple sessions match/);
  assert.doesNotMatch(instructions, /sessionId undefined/);
});

test("tracked launch persists discovery in the actual task file sent to the provider", (context) => {
  const launched = [];
  context.mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: Buffer.from("fixture-ai.exe\n") }));
  context.mock.method(childProcess, "spawn", (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    launched.push({ child, args });
    return child;
  });
  syncBuiltinESMExports();
  const runDirs = [];
  context.after(() => {
    // Closing fixture children clears runner timers; no external AI process exists.
    for (const { child } of launched) child.emit("close", 1);
    context.mock.restoreAll();
    syncBuiltinESMExports();
    const runRoot = path.resolve(PLUGIN_ROOT, ".tmp", "ai-runs") + path.sep;
    for (const directory of runDirs) {
      assert.ok(path.resolve(directory).startsWith(runRoot));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const template of ["componentVariants", "cleanup"]) {
    const result = runLocalAiPrompt({
      sessionId: `fixture-${template}`, template, prompt: "Inspect without changing the design", clientRequestId: "fixture-discovery",
      ...(template === "cleanup" ? { cleanupSnapshot: { schemaVersion: 1, rootNodeId: "1:2", nodes: [{ id: "1:2", parentId: "", type: "FRAME", name: "Panel", siblingIndex: 0, depth: 0 }] } } : {}),
    });
    const runDir = path.join(PLUGIN_ROOT, ".tmp", "ai-runs", result.runId);
    runDirs.push(runDir);
    const taskFile = path.join(runDir, "task.md");
    const task = fs.readFileSync(taskFile, "utf8");
    assertDiscovery(task, `fixture-${template}`);
    assert.match(task, /Inspect without changing the design/);
    assert.ok(launched.at(-1).args.some((arg) => arg.includes(taskFile.replaceAll("\\", "/"))), "the provider launch points to this exact task artifact");
  }
});
