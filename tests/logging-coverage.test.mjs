import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const operationOwners = [
  "src/cleanup/cleanupController.ts",
  "src/cleanup/cleanupExecutor.ts",
  "src/cleanup/cleanupRunStore.ts",
  "src/cleanup/cleanupRuntime.ts",
  "src/cleanup/cleanupPlanner.ts",
  "src/cleanupPlan.ts",
  "src/ai/providerRegistry.ts",
  "src/ai/cliPlanningTransport.ts",
  "src/ai/claudeCodeCliProvider.ts",
  "src/ai/codexCliProvider.ts",
  "src/localAiRunner.ts",
  "src/psdImportTask.ts",
  "src/pythonWorker.ts",
  "src/mcpConfig.ts",
  "src/unityProjectRegistry.ts",
  "src/unityGatewayDiscovery.ts",
  "src/unityBridgeInstaller.ts",
];

test("Node operation owners route diagnostics through the standalone logging system", () => {
  const missing = [];
  for (const relativePath of operationOwners) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    if (!/loggingRuntime|RelayLogger|utils\/logger/.test(source)) missing.push(relativePath);
  }
  assert.deepEqual(missing, []);
});

test("Node source has no diagnostic console calls", () => {
  const sourceFiles = walk(path.join(ROOT, "src")).filter((file) => file.endsWith(".ts"));
  const offenders = [];
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (/console\.(?:log|info|warn|error|debug)\s*\(/.test(source)) {
      offenders.push(path.relative(ROOT, file).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(offenders, []);
});

test("decisive operation steps remain covered by source-level guardrails", () => {
  const source = operationOwners.map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  const requiredSteps = [
    "planning", "approval", "execution", "rollback", "verification",
    "provider-probe", "cli-spawn", "cli-exit", "timeout", "cancel",
    "queued", "export", "submit", "result",
    "discover", "install", "connect",
    "read", "write", "delete", "open",
  ];
  const missing = requiredSteps.filter((step) => !source.includes(`"${step}"`));
  assert.deepEqual(missing, []);
});

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(fullPath));
    else result.push(fullPath);
  }
  return result;
}
