import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireLock, assertVersion, compareVersions, pathInside, readInstall, readReleaseConfig, versionRoot, writeJsonAtomic } from "./update_common.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const excluded = new Set([".local", ".logs", ".tmp", ".venv", ".git", "node_modules", "__pycache__"]);
export function copyRelease(source, target) {
  const copy = (from, to) => {
    if (excluded.has(path.basename(from)) || /^\.env(?:\.|$)/.test(path.basename(from))) return;
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) throw new Error("A release package must not contain symbolic links.");
    if (info.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name)); }
    else if (info.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    else throw new Error("A release package contains a non-regular file.");
  };
  copy(source, target);
}
/** Explicit traversal avoids Node 24 Windows recursive rm/cp failures on Unicode paths. Never follow junctions. */
export function removeTree(candidate, scope) {
  const target = pathInside(candidate, scope);
  const remove = (entry) => {
    let info; try { info = fs.lstatSync(entry); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink()) {
      try { fs.unlinkSync(entry); } catch (error) { if (!["EISDIR", "EPERM"].includes(error.code)) throw error; fs.rmdirSync(entry); }
    } else if (info.isDirectory()) { for (const name of fs.readdirSync(entry)) remove(path.join(entry, name)); fs.rmdirSync(entry); }
    else fs.unlinkSync(entry);
  };
  remove(target);
}
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "inherit", ...options });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Dependency setup failed (${path.basename(command)}, exit ${code}).`)));
  });
}
export async function prepareDependencies(root) {
  if (process.platform === "win32") {
    await runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd ci --omit=dev --no-audit --no-fund"], { cwd: root });
  } else await runCommand("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root });
  await runCommand("python", ["-c", "import sys; assert sys.version_info >= (3, 10), 'Python 3.10+ is required'"]);
  await runCommand("python", ["-m", "venv", path.join(root, ".venv")]);
  const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await runCommand(python, ["-m", "pip", "install", "-r", path.join(root, "server", "requirements.txt")]);
  await runCommand(python, ["-c", "import PIL, psd_tools; from psd_tools import PSDImage"]);
  await runCommand(process.execPath, [path.join(root, "dist", "cli.js"), "--help"], { cwd: root });
}
export function connectDataDirectories(root, releaseRoot) {
  for (const name of [".local", ".logs", ".tmp"]) {
    const target = path.join(root, "data", name), link = path.join(releaseRoot, name);
    fs.mkdirSync(target, { recursive: true });
    if (fs.existsSync(link)) {
      if (fs.realpathSync(link) !== fs.realpathSync(target)) throw new Error(`Version-local ${name} conflicts with the persistent data directory.`);
    } else fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  }
}
export function migrateLocalSettings(source, root) {
  const target = path.join(root, "data", ".local"); fs.mkdirSync(target, { recursive: true });
  const migrated = [];
  for (const name of ["admin-token.txt", "dxx-config.json", "projects.json", "ai-runner.json"]) {
    const from = path.join(source, ".local", name), to = path.join(target, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    if (!fs.lstatSync(from).isFile()) throw new Error("Settings migration does not follow links.");
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); migrated.push(name);
  }
  return migrated;
}
export function validateRelease(root, expectedVersion) {
  const version = assertVersion(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  if (expectedVersion && version !== expectedVersion) throw new Error("Archive package version does not match the signed manifest.");
  for (const relative of ["manifest.json", "code.js", "ui.html", "dist/index.js", "dist/cli.js", "scripts/update_common.mjs", "scripts/apply_update.mjs", "scripts/installed_launcher.mjs", "scripts/installed_bootstrap.mjs", "scripts/install_release.mjs", "scripts/extract_update.ps1", "scripts/inspect_update_process.ps1", "server/requirements.txt"]) {
    if (!fs.statSync(path.join(root, relative)).isFile()) throw new Error(`Incomplete release: ${relative}`);
  }
  return version;
}
export function writeStableEntrypoints(root, releaseRoot) {
  const updater = path.join(root, "updater"); fs.mkdirSync(updater, { recursive: true });
  for (const name of updaterFiles) fs.copyFileSync(path.join(releaseRoot, "scripts", name), path.join(updater, name));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "figma-relay-installed", private: true, type: "module", bin: { "figma-relay": "dist/cli.js" } }, null, 2));
  writeBootstrap(root, releaseRoot);
  fs.writeFileSync(path.join(root, "dist", "cli.js"), '#!/usr/bin/env node\nimport { runInstalledCli } from "../bootstrap.mjs";\nawait runInstalledCli(process.argv.slice(2));\n');
  fs.writeFileSync(path.join(root, "start_relay.bat"), '@echo off\r\nnode "%~dp0bootstrap.mjs" start %*\r\nif errorlevel 1 pause\r\n');
  fs.copyFileSync(path.join(root, "start_relay.bat"), path.join(root, "启动Relay.bat"));
  fs.writeFileSync(path.join(root, "更新修复.bat"), '@echo off\r\nnode "%~dp0bootstrap.mjs" repair %*\r\npause\r\n');
}
export function writeBootstrap(root, releaseRoot) {
  const temporary = path.join(root, `.bootstrap-${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(path.join(releaseRoot, "scripts", "installed_bootstrap.mjs"), temporary, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, path.join(root, "bootstrap.mjs"));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export const updaterFiles = ["update_common.mjs", "apply_update.mjs", "installed_launcher.mjs", "install_release.mjs", "extract_update.ps1", "inspect_update_process.ps1"];
export function stageUpdater(root, releaseRoot, staged) {
  staged = pathInside(staged, root); fs.mkdirSync(staged);
  for (const name of updaterFiles) fs.copyFileSync(path.join(releaseRoot, "scripts", name), path.join(staged, name));
  return staged;
}
export function stagePlugin(root, releaseRoot, stagedPath) {
  const staged = pathInside(stagedPath ?? path.join(root, `.plugin-${crypto.randomUUID()}`), root); fs.mkdirSync(staged);
  for (const name of ["manifest.json", "code.js", "ui.html"]) fs.copyFileSync(path.join(releaseRoot, name), path.join(staged, name));
  return staged;
}
export async function renameDirectory(source, destination) {
  for (let attempt = 0;; attempt++) {
    try { await fs.promises.rename(source, destination); return; }
    catch (error) { if (attempt >= 12 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) { error.message += ` (source exists=${fs.existsSync(source)}, destination exists=${fs.existsSync(destination)})`; throw error; } await sleep(100); }
  }
}
export async function switchPlugin(root, staged, backup) {
  const target = path.join(root, "plugin");
  if (fs.existsSync(target)) await renameDirectory(target, backup);
  try { await renameDirectory(staged, target); }
  catch (error) { if (fs.existsSync(backup)) await renameDirectory(backup, target); throw error; }
}
export async function installRelease(options = {}) {
  const source = path.resolve(options.source ?? path.join(scriptDir, ".."));
  const installRoot = path.resolve(options.installRoot ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "FigmaRelay"));
  if (source === installRoot || path.relative(source, installRoot).split(path.sep)[0] !== ".." && !path.isAbsolute(path.relative(source, installRoot))) throw new Error("Install outside the extracted package directory.");
  const version = validateRelease(source), config = readReleaseConfig(source);
  fs.mkdirSync(installRoot, { recursive: true });
  const release = acquireLock(path.join(installRoot, "data", "updates", "install.lock"));
  let created = false;
  const target = versionRoot(installRoot, version);
  try {
    let previous;
    if (fs.existsSync(path.join(installRoot, "install.json"))) {
      previous = readInstall(installRoot);
      if (previous.publicKey !== config.publicKey || previous.manifestUrl !== config.manifestUrl) throw new Error("The new package uses a different update source or signing key. Install it in a different directory.");
      if (compareVersions(version, previous.currentVersion) !== 0) throw new Error("This directory already has an installation. Use its update button instead of replacing it manually.");
      validateRelease(target, version); writeStableEntrypoints(installRoot, target);
      return { ok: true, installRoot, version, alreadyInstalled: true, manifestPath: path.join(installRoot, "plugin", "manifest.json") };
    }
    if (fs.existsSync(target)) throw new Error("This version directory already exists without an installation record; inspect it before retrying.");
    if (fs.existsSync(path.join(installRoot, "plugin"))) throw new Error("An unregistered plugin directory already exists. Choose a different installation directory.");
    created = true; copyRelease(source, target);
    const migrated = migrateLocalSettings(source, installRoot);
    connectDataDirectories(installRoot, target);
    // CLI help and dependency checks can emit logs. Link persistent directories first.
    await (options.setup ?? prepareDependencies)(target);
    writeStableEntrypoints(installRoot, target);
    const staged = stagePlugin(installRoot, target);
    await switchPlugin(installRoot, staged, path.join(installRoot, ".plugin-backup-initial"));
    writeJsonAtomic(path.join(installRoot, "install.json"), { ...config, currentVersion: version, installedAt: new Date().toISOString() });
    return { ok: true, installRoot, version, migrated, manifestPath: path.join(installRoot, "plugin", "manifest.json"), launcherPath: path.join(installRoot, "start_relay.bat") };
  } catch (error) {
    if (created && !fs.existsSync(path.join(installRoot, "install.json"))) {
      removeTree(path.join(installRoot, "versions", version), installRoot);
      if (fs.existsSync(path.join(installRoot, "plugin"))) removeTree(path.join(installRoot, "plugin"), installRoot);
    }
    throw error;
  } finally { release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { source: { type: "string" }, "install-root": { type: "string" }, help: { type: "boolean" } } });
    if (values.help) process.stdout.write("Usage: node scripts/install_release.mjs [--source <extracted figma-relay>] [--install-root <fixed directory>]\n");
    else process.stdout.write(JSON.stringify(await installRelease({ source: values.source, installRoot: values["install-root"] }), null, 2) + "\n");
  } catch (error) { process.stderr.write(`Installation failed: ${error.message}\n`); process.exitCode = 1; }
}
