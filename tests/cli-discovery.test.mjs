import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SERVER_VERSION } from "../dist/config.js";
import { controlOperations } from "../dist/cliControlCatalog.js";
import { figmaOperations } from "../dist/cliFigmaCatalog.js";
import { commandDefinitions, describeEntry } from "../dist/cliDiscovery.js";
import {
  MAX_EDITS_PER_BATCH,
  MAX_INSPECT_NODE_IDS,
  validateFigmaEditJob,
} from "../dist/figmaEditSchema.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

// An unavailable endpoint and missing credentials prove discovery needs no Relay.
async function runOffline(args) {
  const child = spawn(process.execPath, [cliPath, ...args, "--url", "ws://127.0.0.1:1/relay"], {
    cwd: os.tmpdir(),
    windowsHide: true,
    env: {
      ...process.env,
      FIGMA_RELAY_TOKEN: "",
      FIGMA_RELAY_TOKEN_FILE: path.join(os.tmpdir(), "figma-relay-discovery-missing-token", "token.txt"),
      LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, stderr);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
  }
}

async function jsonOffline(args) {
  const result = await runOffline([...args, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim().split("\n").length, 1, "machine output must be one JSON document");
  return JSON.parse(result.stdout);
}

test("offline command discovery lists executable commands and uniquely named operations", async () => {
  const directory = await jsonOffline(["commands"]);
  assert.equal(directory.schemaVersion, 1);
  assert.equal(directory.version, SERVER_VERSION);
  for (const name of [
    "sessions", "selection", "figma-status", "figma-children", "figma-components", "figma-pages",
    "figma-command", "control", "task-status", "task-wait", "task-cancel", "psd-status",
    "psd-wait", "psd-cancel", "serve", "commands", "describe",
  ]) {
    assert.ok(directory.commands.some((entry) => entry.name === name && entry.summary), `missing command ${name}`);
  }
  assert.deepEqual(
    directory.operations.map((entry) => entry.name).sort(),
    [...controlOperations, ...figmaOperations].map((entry) => entry.name).sort(),
  );
  const names = [...directory.commands, ...directory.operations].map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "names must be unambiguous to describe");
  assert.ok(directory.operations.every((entry) => entry.summary && ["figma", "control"].includes(entry.kind)));
});

test("discovery filters return only the requested operation family and matching text", async () => {
  const controls = await jsonOffline(["commands", "--kind", "control"]);
  assert.deepEqual(controls.commands, []);
  assert.ok(controls.operations.length > 0 && controls.operations.every((entry) => entry.kind === "control"));
  const search = await jsonOffline(["commands", "--search", "INSPECT"]);
  assert.ok(search.operations.some((entry) => entry.name === "FIGMA_INSPECT_NODES"));
  assert.ok([...search.commands, ...search.operations].every((entry) => /inspect/i.test(`${entry.name} ${entry.summary}`)));
});

test("the control catalog covers every concrete runtime control action", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "relayControl.ts"), "utf8");
  const implemented = [...new Set([...source.matchAll(/case\s+["']([^"']+)["']\s*:/g)].map((match) => match[1]))].sort();
  assert.deepEqual(controlOperations.map((entry) => entry.name).sort(), implemented);
});

test("the Figma catalog covers dispatchable jobs while excluding UI-only message paths", () => {
  // These handlers use UI-specific responses or arguments, rather than the generic Relay job path.
  const uiOnly = new Set([
    "CREATE_NINE_SLICE_FROM_SELECTION", "DELETE_CLEANUP_RECOVERY_BACKUP", "EXPORT_IMAGES_TO_UNITY",
    "EXPORT_PSD_COLLECT", "EXPORT_SELECTED_TEXT_STYLE_TO_UNITY", "GET_CLEANUP_PROVIDER_PREFERENCE",
    "QUERY_AI_PROMPT_SELECTION", "QUERY_CLEANUP_RECOVERY_BACKUPS", "QUERY_FIGMA_FILE_KEY",
    "RESIZE_PLUGIN_UI", "RESTORE_CLEANUP_RECOVERY_BACKUP", "SET_CLEANUP_PROVIDER_PREFERENCE",
    "SET_PLUGIN_UI_MINIMIZED", "SUGGEST_NINE_SLICE_FROM_SELECTION",
  ]);
  const source = ["00_init.js", "01_handlers.js"]
    .map((file) => fs.readFileSync(path.join(projectRoot, "code", file), "utf8")).join("\n");
  const implemented = [...new Set([...source.matchAll(/message\.type\s*===\s*["']([^"']+)["']/g)]
    .map((match) => match[1]))].filter((name) => !uiOnly.has(name)).sort();
  assert.deepEqual(figmaOperations.map((entry) => entry.name).sort(), implemented);
});

test("every advertised command and operation resolves to a description", () => {
  for (const entry of [...commandDefinitions, ...controlOperations, ...figmaOperations]) {
    const description = describeEntry(entry.name);
    assert.equal(description.name, entry.name);
    assert.ok(description.summary);
  }
});

test("offline descriptions expose precise inspect input constraints and runnable examples", async () => {
  const description = await jsonOffline(["describe", "FIGMA_INSPECT_NODES"]);
  assert.equal(description.schemaVersion, 1);
  assert.equal(description.version, SERVER_VERSION);
  assert.equal(description.name, "FIGMA_INSPECT_NODES");
  assert.equal(description.kind, "figma");
  const schema = description.payloadSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("nodeIds"));
  assert.ok(!schema.required.includes("type"));
  assert.equal(schema.properties.type, undefined, "job type belongs in --job-type rather than payload");
  assert.equal(schema.properties.nodeIds.minItems, 1);
  assert.equal(schema.properties.nodeIds.maxItems, MAX_INSPECT_NODE_IDS);
  assert.equal(schema.properties.depth.minimum, 0);
  assert.equal(schema.properties.depth.maximum, 3);
  assert.equal(schema.properties.depth.default, 1);
  assert.equal(schema.properties.includeText.default, true);
  assert.ok(description.examples.length > 0);
  for (const example of description.examples) {
    assert.ok(Array.isArray(example.argv));
    assert.ok(example.argv.includes("FIGMA_INSPECT_NODES"));
    assert.match(example.command, /figma-relay/);
    assert.equal(validateFigmaEditJob(description.name, example.payload).ok, true);
  }
});

test("edit descriptions retain nested operations and disclose runtime-only constraints", async () => {
  const description = await jsonOffline(["describe", "FIGMA_APPLY_EDITS"]);
  const schema = description.payloadSchema;
  assert.equal(schema.properties.type, undefined);
  assert.equal(schema["x-runtimeValidation"], true);
  assert.equal(schema.properties.edits.minItems, 1);
  assert.equal(schema.properties.edits.maxItems, MAX_EDITS_PER_BATCH);
  const branches = schema.properties.edits.items.oneOf ?? schema.properties.edits.items.anyOf;
  assert.ok(Array.isArray(branches) && branches.length >= 10);
  const rename = branches.find((entry) => entry.properties?.op?.const === "rename");
  assert.ok(rename?.required.includes("nodeId"));
  assert.ok(rename?.required.includes("name"));
  for (const example of description.examples) {
    assert.equal(validateFigmaEditJob(description.name, example.payload).ok, true);
  }
});

test("control descriptions distinguish empty payloads from required Unity project identities", async () => {
  const list = await jsonOffline(["describe", "unity.projects.list"]);
  assert.equal(list.kind, "control");
  assert.equal(list.payloadSchema.type, "object");
  assert.equal(list.payloadSchema.required?.length ?? 0, 0);
  assert.ok(list.examples.some((example) => Object.keys(example.payload).length === 0));
  const command = await jsonOffline(["describe", "unity.command"]);
  for (const field of ["id", "requestId", "action"]) {
    assert.ok(command.payloadSchema.required.includes(field), `missing required Unity field ${field}`);
  }
});

test("command help is focused and equivalent through the help command", async () => {
  const direct = await runOffline(["selection", "--help"]);
  const help = await runOffline(["help", "selection"]);
  assert.equal(direct.code, 0, direct.stderr);
  assert.equal(help.code, 0, help.stderr);
  assert.equal(direct.stdout, help.stdout);
  assert.match(direct.stdout, /Usage:\s*figma-relay selection/);
  assert.match(direct.stdout, /Examples?:/i);
  assert.match(direct.stdout, /--session-id/);
  assert.doesNotMatch(direct.stdout, /task-cancel\s+Request/);
  const describe = await runOffline(["describe", "--help"]);
  assert.equal(describe.code, 0, describe.stderr);
  assert.match(describe.stdout, /figma-relay describe/);
});

test("job-specific help exposes its actual fields without submitting a job", async () => {
  const help = await runOffline(["figma-command", "--job-type", "FIGMA_INSPECT_NODES", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /FIGMA_INSPECT_NODES/);
  assert.match(help.stdout, /nodeIds/);
  assert.match(help.stdout, /depth/);
  const controlHelp = await runOffline(["control", "--job-type", "unity.command", "--help"]);
  assert.equal(controlHelp.code, 0, controlHelp.stderr);
  assert.match(controlHelp.stdout, /requestId/);
});

test("unknown discovery names fail as usage errors with a discovery hint", async () => {
  for (const args of [["describe", "not-an-operation"], ["help", "not-a-command"], ["describe"]]) {
    const result = await runOffline(args);
    assert.equal(result.code, 2, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "USAGE");
    assert.match(output.error.message, /commands|describe|help/i);
  }
});
