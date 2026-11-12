import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import https from "node:https";

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function assertVersion(version) {
  if (typeof version !== "string" || version.length > 100 || !versionPattern.test(version)) throw new Error("Invalid release version.");
  return version;
}
export function compareVersions(left, right) {
  const a = versionPattern.exec(assertVersion(left)), b = versionPattern.exec(assertVersion(right));
  for (let i = 1; i <= 3; i++) { const n = BigInt(a[i]) - BigInt(b[i]); if (n) return n < 0n ? -1 : 1; }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split("."), bp = b[4].split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return BigInt(ap[i]) < BigInt(bp[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] < bp[i] ? -1 : 1;
  }
  return 0;
}
export function validateDownloadUrl(value, options = {}) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(options.allowLoopbackHttp && loopback && url.protocol === "http:"))) throw new Error("Updates require an HTTPS URL without credentials or fragments.");
  return url;
}
export function readReleaseConfig(root) {
  const file = path.join(root, "release-config.json");
  if (!fs.existsSync(file)) return { schemaVersion: 1, manifestUrl: "", publicKey: "" };
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (config.schemaVersion !== 1 || typeof config.manifestUrl !== "string" || typeof config.publicKey !== "string") throw new Error("Invalid release configuration.");
  if (config.manifestUrl) validateDownloadUrl(config.manifestUrl);
  if (config.publicKey) { const key = crypto.createPublicKey(config.publicKey); if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 update key is required."); }
  return { schemaVersion: 1, manifestUrl: config.manifestUrl, publicKey: config.publicKey };
}
export function parseSignedManifest(envelope, publicKey, options = {}) {
  if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.payload !== "string" || typeof envelope.signature !== "string"
      || envelope.payload.length > 192 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)) throw new Error("Invalid signed update manifest.");
  const bytes = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || !crypto.verify(null, bytes, key, signature)) throw new Error("Update manifest signature verification failed.");
  const payload = JSON.parse(bytes.toString("utf8"));
  assertVersion(payload.version);
  if (payload.schemaVersion !== 1 || typeof payload.publishedAt !== "string" || !Number.isFinite(Date.parse(payload.publishedAt))
      || !Array.isArray(payload.notes) || payload.notes.length > 100 || payload.notes.some((note) => typeof note !== "string" || note.length > 4000)
      || typeof payload.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.sha256)
      || !Number.isSafeInteger(payload.size) || payload.size < 1 || payload.size > MAX_ARCHIVE_BYTES) throw new Error("Invalid release manifest payload.");
  validateDownloadUrl(payload.archiveUrl, options);
  return payload;
}
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function pathInside(candidate, root) {
  const base = path.resolve(root), resolved = path.resolve(candidate), relative = path.relative(base, resolved);
  if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) throw new Error("Refusing a path outside the installation directory.");
  return resolved;
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const identity = crypto.randomUUID();
  for (let retry = 0; retry < 2; retry++) {
    try {
      const descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, identity, startedAt: new Date().toISOString() })); fs.closeSync(descriptor);
      return () => { try { if (JSON.parse(fs.readFileSync(file, "utf8")).identity === identity) fs.unlinkSync(file); } catch { /* Another owner already recovered it. */ } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let old;
      try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("An incomplete update lock exists; inspect it before retrying."); }
      try { process.kill(old.pid, 0); throw new Error("Another installer or updater is running."); }
      catch (failure) { if (failure.code !== "ESRCH") throw failure; }
      fs.unlinkSync(file);
    }
  }
  throw new Error("Could not acquire the update lock.");
}
export async function downloadFile(value, file, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  let url = validateDownloadUrl(value, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);
  let handle, response;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await new Promise((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).get(url, { signal: controller.signal, agent: false, headers: { "User-Agent": "FigmaRelay-Updater/1" } }, resolve);
        request.once("error", reject);
      });
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) break;
      const location = response.headers.location; response.destroy();
      if (!location || redirects === 5) throw new Error("Too many update redirects.");
      url = validateDownloadUrl(new URL(location, url).href, options);
    }
    if (response.statusCode !== 200) throw new Error(`Update download failed (HTTP ${response.statusCode}).`);
    const declared = Number(response.headers["content-length"] || 0);
    if (declared > maxBytes) throw new Error("Update response exceeds the allowed size.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    handle = await fs.promises.open(file, "wx", 0o600);
    let received = 0;
    for await (const chunk of response) {
      received += chunk.length;
      if (received > maxBytes) { controller.abort(); throw new Error("Update response exceeds the allowed size."); }
      await handle.writeFile(chunk); options.onProgress?.(received, options.expectedBytes ?? declared);
    }
    if (options.expectedBytes !== undefined && received !== options.expectedBytes) throw new Error("Update archive size does not match the signed manifest.");
    return { bytes: received };
  } catch (error) { if (handle) { await handle.close(); handle = undefined; fs.unlinkSync(file); } throw error; }
  finally { clearTimeout(timer); response?.destroy(); controller.abort(); await handle?.close(); }
}
export async function hashFile(file) {
  const hash = crypto.createHash("sha256"); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export function readInstall(root) {
  const record = JSON.parse(fs.readFileSync(path.join(root, "install.json"), "utf8"));
  if (record.schemaVersion !== 1) throw new Error("Unsupported installation record.");
  assertVersion(record.currentVersion);
  if (record.previousVersion) assertVersion(record.previousVersion);
  if (typeof record.publicKey !== "string" || typeof record.manifestUrl !== "string") throw new Error("Invalid installation trust configuration.");
  return record;
}
export function versionRoot(root, version) { return pathInside(path.join(root, "versions", assertVersion(version), "figma-relay"), root); }
export function runtimeEnvironment(root, releaseRoot) {
  const dataRoot = path.join(root, "data"), localDir = path.join(dataRoot, ".local"); fs.mkdirSync(localDir, { recursive: true });
  const tokenFile = path.join(localDir, "admin-token.txt");
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error("The installation authentication token is empty.");
  const python = path.join(releaseRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return { ...process.env, FIGMA_RELAY_DATA_ROOT: dataRoot, FIGMA_RELAY_INSTALL_ROOT: root, FIGMA_RELAY_TOKEN: token,
    FIGMA_RELAY_BRIDGE_TOKEN: token, FIGMA_RELAY_INSTANCE_ID: crypto.randomUUID(), ...(fs.existsSync(python) ? { FIGMA_RELAY_PYTHON: python } : {}) };
}
export async function relayControl(root, releaseRoot, version, runtime, action, payload = {}, timeoutMs = 8000) {
  const WebSocket = createRequire(path.join(releaseRoot, "package.json"))("ws");
  const tokenPath = path.join(root, "data", ".local", "admin-token.txt");
  if (runtime.tokenFile && path.resolve(runtime.tokenFile) !== path.resolve(tokenPath)) throw new Error("Runtime token path does not belong to this installation.");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/relay`, { headers: { Authorization: `Bearer ${token}` } });
    const requestId = crypto.randomUUID(); let ready = false, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error("Relay update handshake timed out.")), timeoutMs);
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("Relay disconnected during the update handshake.")));
    socket.once("open", () => socket.send(JSON.stringify({ type: "relay.hello", role: "cli", protocolVersion: 1, clientVersion: version })));
    socket.on("message", (raw) => {
      let message; try { message = JSON.parse(String(raw)); } catch { return; }
      if (!ready) {
        if (message.type !== "relay.ready" || message.serverVersion !== version) return finish(new Error("The running Relay version does not match this installation."));
        ready = true;
        if (!action) return finish(null, message);
        socket.send(JSON.stringify({ type: "relay.request", requestId, operationId: crypto.randomUUID(), action: "relay.control", payload: { controlAction: action, controlPayload: payload } }));
      } else if (message.type === "relay.response" && message.requestId === requestId) {
        if (!message.ok) finish(new Error(message.error?.message || "Relay rejected the update control.")); else finish(null, message.result);
      }
    });
  });
}
export async function waitForHealth(root, releaseRoot, version, runtime, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { return await relayControl(root, releaseRoot, version, runtime, undefined, {}, Math.min(2000, deadline - Date.now())); }
    catch (error) { last = error; await sleep(200); }
  }
  throw new Error(`New Relay failed its authenticated health check: ${last?.message}`);
}
