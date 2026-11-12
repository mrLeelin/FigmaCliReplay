import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireLock, compareVersions, downloadFile, hashFile, parseSignedManifest, pathInside, readInstall, relayControl, versionRoot, waitForHealth, writeJsonAtomic } from "./update_common.mjs";
import { connectDataDirectories, copyRelease, prepareDependencies, removeTree, renameDirectory, stagePlugin, stageUpdater, switchPlugin, validateRelease, writeBootstrap } from "./install_release.mjs";
import { childIsAlive, launchRuntime, terminateStartedRuntime } from "./installed_launcher.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const directories = (root) => ({ updates: path.join(root, "data", "updates"), record: path.join(root, "install.json"), journal: path.join(root, "data", "updates", "journal.json") });
function status(root, planId, phase, message, fields = {}) {
  const file = path.join(directories(root).updates, "status.json");
  let previous = {}; try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* First status. */ }
  writeJsonAtomic(file, { ...previous, schemaVersion: 1, planId, phase, message, ...fields, updatedAt: new Date().toISOString() });
}
const processAlive = (pid) => childIsAlive(pid);
function validateRuntime(root, version, runtime) {
  if (!runtime || !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0 || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535
      || typeof runtime.instanceId !== "string" || !runtime.instanceId
      || path.resolve(runtime.entry ?? "") !== path.join(versionRoot(root, version), "dist", "index.js")
      || path.resolve(runtime.tokenFile ?? "") !== path.join(root, "data", ".local", "admin-token.txt")) throw new Error("The update runtime does not belong to this installation.");
}
export async function stopOwnedRuntime(root, version, runtime, planId, options = {}) {
  validateRuntime(root, version, runtime);
  if (!processAlive(runtime.pid)) return;
  const releaseRoot = versionRoot(root, version);
  const deadline = Date.now() + (options.waitTimeoutMs ?? 2 * 60 * 60 * 1000);
  while (Date.now() < deadline) {
    const activity = await relayControl(root, releaseRoot, version, runtime, "relay.update.activity", {}, options.controlTimeoutMs ?? 8000);
    if (activity.instanceId !== runtime.instanceId || activity.pid !== runtime.pid || activity.entry !== runtime.entry || activity.version !== version) throw new Error("The running Relay identity changed; no process was stopped.");
    if (activity.busy) { status(root, planId, "waiting", "正在等待当前任务完成，完成后自动更新。", { progress: 100 }); await sleep(1000); continue; }
    try {
      const accepted = await relayControl(root, releaseRoot, version, runtime, "relay.update.shutdown", { planId });
      if (accepted?.ok !== true) throw new Error("Relay did not accept the controlled update shutdown.");
      break;
    } catch (error) {
      // A new task may have started between activity and the atomic drain gate.
      const retry = await relayControl(root, releaseRoot, version, runtime, "relay.update.activity");
      if (retry.busy) { await sleep(300); continue; }
      throw error;
    }
  }
  if (Date.now() >= deadline) throw new Error("Timed out waiting for running tasks. The installed version was preserved.");
  const exitDeadline = Date.now() + 15000;
  while (processAlive(runtime.pid) && Date.now() < exitDeadline) await sleep(100);
  if (processAlive(runtime.pid)) throw new Error("The owned Relay did not stop. The updater will not force-stop another process.");
}
export async function extractArchive(archive, destination) {
  if (process.platform !== "win32") throw new Error("This release updater currently supports Windows only.");
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptDir, "extract_update.ps1"), "-Archive", archive, "-Destination", destination], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Safe archive extraction failed.")));
  });
}
function rootInArchive(extracted) {
  if (fs.existsSync(path.join(extracted, "figma-relay", "package.json"))) return path.join(extracted, "figma-relay");
  throw new Error("The archive must contain the figma-relay package directory.");
}
async function verifyHealth(root, version, runtime, options) {
  if (options.health) return options.health(root, version, runtime);
  const releaseRoot = versionRoot(root, version);
  await waitForHealth(root, releaseRoot, version, runtime, options.healthTimeoutMs ?? 20000);
  const activity = await relayControl(root, releaseRoot, version, runtime, "relay.update.activity");
  if (activity.pid !== runtime.pid || activity.instanceId !== runtime.instanceId || activity.entry !== runtime.entry || activity.version !== version) throw new Error("New Relay health check returned another process identity.");
}
async function rollback(root, journal, options) {
  const { record, journal: journalPath } = directories(root);
  if (journal.newRuntime && !journal.newRuntime.pid) {
    const file = path.join(root, "data", ".local", "runtime.json");
    if (fs.existsSync(file)) {
      const found = JSON.parse(fs.readFileSync(file, "utf8"));
      if (found.instanceId === journal.newRuntime.instanceId && found.entry === journal.newRuntime.entry) journal.newRuntime = found;
    }
  }
  if (journal.newRuntime?.pid > 0 && processAlive(journal.newRuntime.pid)) {
    validateRuntime(root, journal.targetVersion, journal.newRuntime);
    // Update the local plan so the new authenticated runtime can drain itself too.
    const planFile = path.join(directories(root).updates, "plan.json");
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    writeJsonAtomic(planFile, { ...plan, runtime: journal.newRuntime });
    try { await (options.stopRuntime ?? stopOwnedRuntime)(root, journal.targetVersion, journal.newRuntime, journal.planId, { ...options, waitTimeoutMs: 1500, controlTimeoutMs: 1500 }); }
    catch { await (options.terminateRuntime ?? terminateStartedRuntime)(root, journal.newRuntime); }
  }
  if (fs.existsSync(journal.pluginBackup)) {
    const currentPlugin = pathInside(path.join(root, "plugin"), root);
    if (fs.existsSync(currentPlugin)) removeTree(currentPlugin, root);
    await renameDirectory(journal.pluginBackup, currentPlugin);
  }
  if (journal.updaterBackup && fs.existsSync(journal.updaterBackup)) {
    const installedUpdater = path.join(root, "updater");
    if (fs.existsSync(installedUpdater)) removeTree(installedUpdater, root);
    await renameDirectory(journal.updaterBackup, installedUpdater);
  }
  writeJsonAtomic(record, journal.oldRecord);
  if (journal.oldStopped || journal.phase === "switched" || journal.phase === "starting" || !processAlive(journal.oldRuntime.pid)) {
    const restarted = await (options.startRuntime ?? launchRuntime)(root, journal.oldRecord.currentVersion, journal.oldRuntime.port);
    await verifyHealth(root, journal.oldRecord.currentVersion, restarted, options);
  }
  if (journal.stagedPlugin && fs.existsSync(journal.stagedPlugin)) removeTree(journal.stagedPlugin, root);
  if (journal.stagedUpdater && fs.existsSync(journal.stagedUpdater)) removeTree(journal.stagedUpdater, root);
  const failedVersion = pathInside(path.dirname(versionRoot(root, journal.targetVersion)), root);
  if (journal.ownedVersion && journal.targetVersion !== journal.oldRecord.currentVersion && fs.existsSync(failedVersion)) removeTree(failedVersion, root);
  fs.unlinkSync(journalPath);
  status(root, journal.planId, "rolled-back", "更新未完成，已保留或恢复上一版本。", { error: journal.error || "Interrupted update recovered.", progress: undefined });
  return { ok: true, rolledBack: true, version: journal.oldRecord.currentVersion };
}
export async function recoverUpdate(root, options = {}) {
  root = path.resolve(root);
  const paths = directories(root);
  if (!fs.existsSync(paths.journal)) return undefined;
  const release = options.lockHeld ? () => {} : acquireLock(path.join(paths.updates, "install.lock"));
  try {
    const journal = JSON.parse(fs.readFileSync(paths.journal, "utf8"));
    if (journal.schemaVersion !== 1 || typeof journal.planId !== "string") throw new Error("Invalid interrupted update journal.");
    if (journal.pluginBackup !== path.join(root, `.plugin-backup-${journal.planId}`)) throw new Error("Invalid plugin recovery location.");
    journal.pluginBackup = pathInside(journal.pluginBackup, root);
    if (journal.updaterBackup && journal.updaterBackup !== path.join(root, `.updater-backup-${journal.planId}`)) throw new Error("Invalid updater recovery location.");
    if (journal.stagedPlugin && !/^\.plugin-[a-f0-9-]{36}$/i.test(path.basename(journal.stagedPlugin))) throw new Error("Invalid staged plugin recovery location.");
    if (journal.stagedUpdater && !/^\.updater-[a-f0-9-]{36}$/i.test(path.basename(journal.stagedUpdater))) throw new Error("Invalid staged updater recovery location.");
    validateRuntime(root, journal.oldRecord.currentVersion, journal.oldRuntime);
    if (journal.phase === "committed") {
      const installed = readInstall(root);
      if (installed.currentVersion !== journal.targetVersion) throw new Error("Committed update version does not match the installation record.");
      status(root, journal.planId, "installing", "正在恢复已安装版本并核对 Relay 连接…");
      let runtime = journal.newRuntime;
      if (!runtime?.pid || !processAlive(runtime.pid)) {
        runtime = await (options.startRuntime ?? launchRuntime)(root, installed.currentVersion, journal.oldRuntime.port);
        journal.newRuntime = runtime; writeJsonAtomic(paths.journal, journal);
      }
      await verifyHealth(root, installed.currentVersion, runtime, options);
      writeBootstrap(root, versionRoot(root, installed.currentVersion));
      status(root, journal.planId, "restart-required", "更新完成，请关闭后重新打开 Figma 插件。", { version: installed.currentVersion, progress: 100, error: undefined });
      fs.unlinkSync(paths.journal); return { ok: true, version: installed.currentVersion };
    }
    return await rollback(root, journal, options);
  } finally { release(); }
}
export async function applyUpdate(planPath, options = {}) {
  planPath = path.resolve(planPath);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const root = path.resolve(plan.installRoot ?? "");
  const paths = directories(root);
  if (plan.schemaVersion !== 1 || typeof plan.planId !== "string" || !/^[a-f0-9-]{36}$/i.test(plan.planId) || planPath !== path.join(paths.updates, "plan.json")) throw new Error("Invalid update plan location or identifier.");
  const release = acquireLock(path.join(paths.updates, "install.lock"));
  let journal;
  try {
    if (fs.existsSync(paths.journal)) { await recoverUpdate(root, { ...options, lockHeld: true }); throw new Error("Recovered an interrupted update. Check for updates again before retrying."); }
    const oldRecord = readInstall(root);
    const payload = parseSignedManifest(plan.envelope, oldRecord.publicKey, options);
    if (compareVersions(payload.version, oldRecord.currentVersion) <= 0) throw new Error("Automatic updates must upgrade the installed version.");
    validateRuntime(root, oldRecord.currentVersion, plan.runtime);
    const archive = plan.archivePath ? pathInside(plan.archivePath, paths.updates) : path.join(paths.updates, `${plan.planId}.zip`);
    status(root, plan.planId, "downloading", "正在下载新版本…", { progress: 0, error: undefined });
    if (!plan.archivePath) {
      // Retry only this plan's previous partial download; no installed files are touched.
      if (fs.existsSync(archive)) fs.unlinkSync(archive);
      await downloadFile(payload.archiveUrl, archive, { ...options, maxBytes: payload.size, expectedBytes: payload.size, onProgress: (bytes) => status(root, plan.planId, "downloading", "正在下载新版本…", { progress: Math.min(100, Math.floor(bytes * 100 / payload.size)) }) });
    }
    if (fs.statSync(archive).size !== payload.size || await hashFile(archive) !== payload.sha256) throw new Error("Update archive integrity verification failed.");
    status(root, plan.planId, "preparing", "正在验证并准备新版本依赖…", { progress: 100 });
    const extracted = path.join(paths.updates, `extracted-${plan.planId}`);
    if (fs.existsSync(extracted)) removeTree(extracted, paths.updates);
    await (options.extract ?? extractArchive)(archive, extracted);
    const source = rootInArchive(extracted); validateRelease(source, payload.version);
    const newRoot = versionRoot(root, payload.version);
    if (fs.existsSync(newRoot)) throw new Error("The target version directory already exists; inspect the previous attempt before retrying.");
    const config = JSON.parse(fs.readFileSync(path.join(source, "release-config.json"), "utf8"));
    if (config.publicKey !== oldRecord.publicKey || config.manifestUrl !== oldRecord.manifestUrl) throw new Error("The update attempted to change the pinned update source or signing key.");
    journal = { schemaVersion: 1, planId: plan.planId, phase: "preparing", oldRecord, oldRuntime: plan.runtime, targetVersion: payload.version,
      pluginBackup: pathInside(path.join(root, `.plugin-backup-${plan.planId}`), root), stagedPlugin: path.join(root, `.plugin-${plan.planId}`),
      updaterBackup: path.join(root, `.updater-backup-${plan.planId}`), stagedUpdater: path.join(root, `.updater-${plan.planId}`), ownedVersion: true, oldStopped: false };
    writeJsonAtomic(paths.journal, journal);
    copyRelease(source, newRoot);
    // Setup invokes the real CLI, which may create logs even for --help.
    connectDataDirectories(root, newRoot); await (options.setup ?? prepareDependencies)(newRoot);
    const staged = stagePlugin(root, newRoot, journal.stagedPlugin);
    stageUpdater(root, newRoot, journal.stagedUpdater);
    journal.phase = "prepared";
    writeJsonAtomic(paths.journal, journal);
    status(root, plan.planId, "waiting", "新版本已准备好，正在等待当前任务完成…");
    await (options.stopRuntime ?? stopOwnedRuntime)(root, oldRecord.currentVersion, plan.runtime, plan.planId, options);
    journal.oldStopped = true; journal.phase = "stopped"; writeJsonAtomic(paths.journal, journal);
    status(root, plan.planId, "installing", "正在切换版本并启动 Relay…");
    await switchPlugin(root, staged, journal.pluginBackup);
    await renameDirectory(path.join(root, "updater"), journal.updaterBackup);
    await renameDirectory(journal.stagedUpdater, path.join(root, "updater"));
    writeJsonAtomic(paths.record, { ...oldRecord, currentVersion: payload.version, previousVersion: oldRecord.currentVersion, updatedAt: new Date().toISOString() });
    journal.phase = "switched"; writeJsonAtomic(paths.journal, journal);
    journal.newRuntime = { pid: 0, entry: path.join(newRoot, "dist", "index.js"), port: plan.runtime.port, tokenFile: plan.runtime.tokenFile, instanceId: crypto.randomUUID(), startedAt: new Date().toISOString() };
    journal.phase = "starting"; writeJsonAtomic(paths.journal, journal);
    journal.newRuntime = await (options.startRuntime ?? launchRuntime)(root, payload.version, plan.runtime.port, { instanceId: journal.newRuntime.instanceId });
    journal.phase = "starting"; writeJsonAtomic(paths.journal, journal);
    await verifyHealth(root, payload.version, journal.newRuntime, options);
    journal.phase = "committed"; writeJsonAtomic(paths.journal, journal);
    writeBootstrap(root, newRoot);
    status(root, plan.planId, "restart-required", "更新完成，请关闭后重新打开 Figma 插件。", { version: payload.version, progress: 100 });
    fs.unlinkSync(paths.journal);
    return { ok: true, version: payload.version, restartRequired: true };
  } catch (error) {
    if (journal && journal.phase !== "committed") {
      journal.error = error.message; writeJsonAtomic(paths.journal, journal);
      try { await rollback(root, journal, options); }
      catch (recoveryError) { status(root, plan.planId, "failed", "更新未完成，请运行固定目录中的“更新修复”。", { error: `${error.message}; Recovery: ${recoveryError.message}` }); }
    } else status(root, plan.planId, "failed", "更新失败，原版本已保留。", { error: error.message });
    throw error;
  } finally { release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { plan: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) process.stdout.write("Usage: node updater/apply_update.mjs --plan <installation/data/updates/plan.json>\n");
    else { if (!values.plan) throw new Error("--plan is required."); process.stdout.write(JSON.stringify(await applyUpdate(values.plan), null, 2) + "\n"); }
  } catch (error) { process.stderr.write(`Update failed: ${error.message}\n`); process.exitCode = 1; }
}
