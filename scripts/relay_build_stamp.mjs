import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertVersion, writeJsonAtomic } from "./update_common.mjs";

const stampName = "relay-build.json";

function builtFiles(directory, relative = "") {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return builtFiles(directory, name);
    return entry.isFile() && name.endsWith(".js") ? [name] : [];
  });
}

function describeBuild(root) {
  const dist = path.join(root, "dist");
  const version = assertVersion(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  const compiledVersion = fs.readFileSync(path.join(dist, "config.js"), "utf8")
    .match(/^export const SERVER_VERSION = "([^"]+)";/m)?.[1];
  if (version !== compiledVersion || !fs.statSync(path.join(dist, "index.js")).isFile()) {
    throw new Error("Relay build files and release version are inconsistent.");
  }
  const hash = createHash("sha256");
  for (const file of builtFiles(dist).sort()) {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(dist, file))).digest("hex");
    hash.update(`${file}\0${digest}\n`);
  }
  return { schemaVersion: 1, version, id: hash.digest("hex") };
}

export function readRelayBuild(root, verify = false) {
  const file = path.join(root, "dist", stampName);
  if (!fs.existsSync(file)) return undefined;
  const stamp = JSON.parse(fs.readFileSync(file, "utf8"));
  if (stamp?.schemaVersion !== 1 || typeof stamp.id !== "string" || !/^[a-f0-9]{64}$/.test(stamp.id)) {
    throw new Error("Invalid Relay build stamp.");
  }
  assertVersion(stamp.version);
  if (verify) {
    const build = describeBuild(root);
    if (build.id !== stamp.id || build.version !== stamp.version) throw new Error("Relay build changed before it was ready.");
  }
  return stamp;
}

export function writeRelayBuild(root) {
  const stamp = describeBuild(root);
  writeJsonAtomic(path.join(root, "dist", stampName), stamp);
  return stamp;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeRelayBuild(fileURLToPath(new URL("../", import.meta.url)));
}
