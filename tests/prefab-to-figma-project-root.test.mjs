import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const clientPath = new URL("../ai/skills/prefab-to-figma/scripts/prefab_to_figma_mcp_client.py", import.meta.url);
const serverPath = new URL("../server/figma_mcp_relay_server.py", import.meta.url);

test("Prefab-to-Figma MCP client accepts an explicit Unity project root", () => {
  const result = spawnSync("python", [fileURLToPath(clientPath), "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--project-root/);
});

test("Prefab import forwards its Unity project root to the MCP client", () => {
  const server = fs.readFileSync(serverPath, "utf8");
  const functionStart = server.indexOf("def run_single_prefab_to_figma_import(");
  const functionEnd = server.indexOf("def sanitize_path_name", functionStart);
  const source = server.slice(functionStart, functionEnd);

  assert.match(source, /prefab_to_figma_mcp_client\.py[\s\S]*?"--project-root",\s*str\(unity_project_root\)/);
});
