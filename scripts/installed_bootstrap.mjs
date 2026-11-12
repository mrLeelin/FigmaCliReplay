// Keep this file outside updater/. It must still run between the two directory renames.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const installedRoot = () => path.dirname(fileURLToPath(import.meta.url));
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function regularFile(file) { try { const info = fs.lstatSync(file); return info.isFile() && !info.isSymbolicLink(); } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function directory(folder) { try { const info = fs.lstatSync(folder); return info.isDirectory() && !info.isSymbolicLink(); } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
export async function recoverInstalled(root = installedRoot()) {
  root = path.resolve(root);
  const updater = path.join(root, "updater"), journalFile = path.join(root, "data", "updates", "journal.json");
  if (!fs.existsSync(journalFile)) {
    if (!directory(updater) || !regularFile(path.join(updater, "installed_launcher.mjs"))) throw new Error("The installed updater is missing and has no recovery journal. Reinstall to a new fixed directory.");
    return undefined;
  }
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  if (journal.schemaVersion !== 1 || typeof journal.planId !== "string" || !uuidPattern.test(journal.planId)
    || journal.updaterBackup !== path.join(root, `.updater-backup-${journal.planId}`)
    || journal.pluginBackup !== path.join(root, `.plugin-backup-${journal.planId}`)) throw new Error("Invalid interrupted update recovery record.");
  let recoveryDirectory = updater;
  if (!directory(updater) || !regularFile(path.join(updater, "apply_update.mjs"))) recoveryDirectory = journal.updaterBackup;
  if (!directory(recoveryDirectory) || !regularFile(path.join(recoveryDirectory, "apply_update.mjs"))) throw new Error("The exact updater backup needed for recovery is missing.");
  const { recoverUpdate } = await import(pathToFileURL(path.join(recoveryDirectory, "apply_update.mjs")).href);
  return recoverUpdate(root);
}
export async function runInstalledCli(args, root = installedRoot()) {
  root = path.resolve(root);
  // Existing AI tasks may invoke the CLI while the updater prepares dependencies.
  // Leave the live updater's journal alone; its atomic drain gate owns the switch.
  let preparing = false;
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(root, "data", "updates", "journal.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "data", "updates", "install.lock"), "utf8"));
    if (["preparing", "prepared"].includes(journal.phase) && Number.isSafeInteger(lock.pid) && lock.pid > 0) { process.kill(lock.pid, 0); preparing = true; }
  } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  if (!preparing) await recoverInstalled(root);
  const launcher = await import(pathToFileURL(path.join(root, "updater", "installed_launcher.mjs")).href);
  return launcher.runInstalledCli(args, root);
}
export async function startInstalled(root = installedRoot(), port = 32130) {
  root = path.resolve(root); const recovered = await recoverInstalled(root);
  const launcher = await import(pathToFileURL(path.join(root, "updater", "installed_launcher.mjs")).href);
  const result = await launcher.startInstalled(root, port);
  return { ...result, ...(recovered ? { recovered } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const command = process.argv[2] || "start";
    const { values } = parseArgs({ args: process.argv.slice(3), options: { port: { type: "string" }, "install-root": { type: "string" } } });
    if (command !== "start" && command !== "repair") throw new Error("Expected start or repair.");
    const result = await startInstalled(values["install-root"] ?? installedRoot(), Number(values.port ?? 32130));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (command === "repair") process.stdout.write("Recovery and Relay health check completed. Open the plugin to check for updates.\n");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
