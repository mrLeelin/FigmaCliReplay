import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const packageScript = fs.readFileSync(new URL("../scripts/package_release.ps1", import.meta.url), "utf8");
const hiddenStartScript = fs.readFileSync(new URL("../scripts/start_mcp_hidden.ps1", import.meta.url), "utf8");
const installScriptUrl = new URL("../scripts/install_unity_bridge.ps1", import.meta.url);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.slice(1));

test("release packaging owns its Unity bridge and stops it before replacing a release", () => {
  assert.doesNotMatch(packageScript, /Find-RepositoryRoot/);
  assert.doesNotMatch(packageScript, /JellybeanUnity\\Assets\\Editor\\FigmaBridge/);
  assert.match(packageScript, /Join-Path \$PluginRoot "unity\\Assets\\Editor\\FigmaBridge"/);
  assert.ok(packageScript.indexOf("Stop-RelayFromPath -RelayPath $releaseRoot") < packageScript.indexOf("Remove-Item -LiteralPath $releaseRoot"));
});

test("background Relay launch cannot open a visible console window", () => {
  const startProcessLine = hiddenStartScript.split(/\r?\n/).find((line) => /Start-Process\s+-FilePath\s+\$node\.Source/.test(line)) || "";
  assert.match(startProcessLine, /-WindowStyle\s+Hidden/);
  assert.match(startProcessLine, /-RedirectStandardOutput/);
  assert.match(startProcessLine, /-RedirectStandardError/);
});

test("Unity bridge installer copies only the editor plugin and preserves ProjectSettings", () => {
  assert.equal(fs.existsSync(installScriptUrl), true);
  const installer = fs.readFileSync(installScriptUrl, "utf8");
  assert.match(installer, /Assets\\Editor\\FigmaBridge/);
  assert.doesNotMatch(installer, /Remove-Item.*ProjectSettings/i);
  assert.doesNotMatch(installer, /Copy-Item.*ProjectSettings/i);
});

test("PSD submit helper starts from the standalone relay without a JellybeanUnity parent", () => {
  const script = path.join(
    repoRoot,
    "ai",
    "skills",
    "psd-layer-to-figma",
    "scripts",
    "submit_psd_import_job.py"
  );
  const result = spawnSync("python", [script, "--help"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--relay-url/);
});
