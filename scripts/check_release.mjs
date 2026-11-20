import fs from "node:fs";
import path from "node:path";
import { bundledRuntime } from "./update_common.mjs";

// Called by package_release.ps1 inside its logged validation stage, before ZIP creation.
const root = process.argv[2];
if (!root) throw new Error("Specify the assembled Relay directory.");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const checks = [
  ["ui.html", /BEGIN_RELEASE_VERSION -->v([^<]+)</],
  ["src/config.ts", /SERVER_VERSION = "([^"]+)"/],
  ["dist/config.js", /SERVER_VERSION = "([^"]+)"/],
  ["unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs", /private const string Version = "([^"]+)"/],
];
for (const [file, pattern] of checks) {
  if (fs.readFileSync(path.join(root, file), "utf8").match(pattern)?.[1] !== version) {
    throw new Error(`Release version mismatch: ${file}`);
  }
}
for (const file of ["manifest.json", "code.js", "scripts/setup_relay.ps1", "scripts/install_unity_bridge.mjs",
  "release-config.json", "scripts/update_common.mjs", "scripts/install_release.mjs", "scripts/apply_update.mjs",
  "scripts/installed_launcher.mjs", "scripts/installed_bootstrap.mjs", "scripts/extract_update.ps1", "scripts/inspect_update_process.ps1",
  "unity/Assets/Editor/FigmaBridge.meta", "server/requirements.txt", "LICENSE"]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Release item missing: ${file}`);
}
if (!bundledRuntime(root)) throw new Error("The Windows release has no bundled runtime.");
for (const file of ["runtime/node/LICENSE", "runtime/python/LICENSE.txt", "node_modules/ws/package.json", "scripts/quick_start_release.ps1", "scripts/start_installed.ps1"]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Bundled release item missing: ${file}`);
}
