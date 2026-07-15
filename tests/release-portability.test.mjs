import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageScript = fs.readFileSync(new URL("../scripts/package_release.ps1", import.meta.url), "utf8");
const installScriptUrl = new URL("../scripts/install_unity_bridge.ps1", import.meta.url);

test("release packaging owns its Unity bridge and stops it before replacing a release", () => {
  assert.doesNotMatch(packageScript, /Find-RepositoryRoot/);
  assert.doesNotMatch(packageScript, /JellybeanUnity\\Assets\\Editor\\FigmaBridge/);
  assert.match(packageScript, /Join-Path \$PluginRoot "unity\\Assets\\Editor\\FigmaBridge"/);
  assert.ok(packageScript.indexOf("Stop-RelayFromPath -RelayPath $releaseRoot") < packageScript.indexOf("Remove-Item -LiteralPath $releaseRoot"));
});

test("Unity bridge installer copies only the editor plugin and preserves ProjectSettings", () => {
  assert.equal(fs.existsSync(installScriptUrl), true);
  const installer = fs.readFileSync(installScriptUrl, "utf8");
  assert.match(installer, /Assets\\Editor\\FigmaBridge/);
  assert.doesNotMatch(installer, /Remove-Item.*ProjectSettings/i);
  assert.doesNotMatch(installer, /Copy-Item.*ProjectSettings/i);
});
