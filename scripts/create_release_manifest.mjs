import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptRoot, "..");
const defaultPrivateKey = path.join(repositoryRoot, ".local", "release-signing", "private.pem");

function jsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function httpsUrl(value, label, directory = false) {
  if (!value) return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query or fragment.`);
  }
  if (directory && !parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.href;
}

function signingIdentity(privateKeyPath, expectedPublicKey = "") {
  const privateFile = path.resolve(privateKeyPath || defaultPrivateKey);
  if (!fs.existsSync(privateFile)) {
    if (expectedPublicKey) throw new Error("The configured signing private key is missing. Restore it instead of replacing the trusted update identity.");
    fs.mkdirSync(path.dirname(privateFile), { recursive: true });
    const pair = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(privateFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privateFile));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Release signing requires an Ed25519 private key.");
  const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (expectedPublicKey && !crypto.createPublicKey(expectedPublicKey).export({ type: "spki", format: "der" })
    .equals(crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }))) {
    throw new Error("The signing private key does not match the configured update public key.");
  }
  return { privateKey, publicKey, privateFile };
}

function publisherKeyOutsideRelease(root, privateKeyPath) {
  const relative = path.relative(path.resolve(root), path.resolve(privateKeyPath || defaultPrivateKey));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("The publisher private key must be stored outside the assembled release directory.");
  }
}

function packageVersion(root) {
  const version = jsonFile(path.join(root, "package.json")).version;
  if (typeof version !== "string" || version.length > 100 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error("The release package has an invalid version.");
  }
  return version;
}

export function githubReleaseUrls(repository, version) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) {
    throw new Error("GitHub repository must be an owner/repository name.");
  }
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error("Invalid GitHub release version.");
  }
  const baseUrl = `https://github.com/${repository}/releases/download/v${version}/`;
  return { baseUrl, manifestUrl: `https://github.com/${repository}/releases/latest/download/latest.json`,
    archiveUrl: new URL(`figma-relay-${version}.zip`, baseUrl).href };
}

/** Inspect only the assembled release tree; machine state and private material must never enter a ZIP. */
export function auditReleaseTree(root) {
  let files = 0;
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      const relative = path.relative(root, file);
      if (/^(?:\.local|\.logs|\.venv|\.tmp|node_modules|__pycache__|\.git)$/i.test(item.name)
        || /^\.env(?:\.|$)/i.test(item.name) || /\.(?:pyc|pyo)$/i.test(item.name)) {
        throw new Error(`Machine-local or generated material found in release: ${relative}`);
      }
      if (item.isSymbolicLink()) throw new Error(`Symbolic links cannot be distributed in a release: ${relative}`);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) {
        if (/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m.test(fs.readFileSync(file, "utf8"))) {
          throw new Error(`Private signing material found in release: ${relative}`);
        }
        files += 1;
      } else throw new Error(`Unsupported release item: ${relative}`);
    }
  };
  visit(path.resolve(root));
  return { files };
}

/** Prepare the pinned public identity before the package is compressed. Never copies the private key. */
export function prepareRelease({ root, privateKeyPath, baseUrl, manifestUrl, githubRepository } = {}) {
  if (!root) throw new Error("Specify the assembled Relay root.");
  publisherKeyOutsideRelease(root, privateKeyPath);
  auditReleaseTree(root);
  const configFile = path.join(path.resolve(root), "release-config.json");
  const existing = fs.existsSync(configFile) ? jsonFile(configFile) : {};
  const version = packageVersion(root);
  const repository = githubRepository ?? (!baseUrl && !manifestUrl ? existing.githubRepository : "");
  const github = repository ? githubReleaseUrls(repository, version) : undefined;
  const assetBase = httpsUrl(baseUrl || github?.baseUrl, "Update base URL", true);
  const feedUrl = httpsUrl(manifestUrl || github?.manifestUrl || (assetBase ? new URL("latest.json", assetBase).href : existing.manifestUrl), "Manifest URL");
  const identity = signingIdentity(privateKeyPath, existing.publicKey || "");
  auditReleaseTree(root);
  const config = { schemaVersion: 1, manifestUrl: feedUrl, publicKey: identity.publicKey,
    ...(repository ? { githubRepository: repository } : {}) };
  writeJson(configFile, config);
  return { configured: Boolean(feedUrl), config, privateKeyPath: identity.privateFile };
}

function readNotes(notes, notesFile) {
  if (notes !== undefined) {
    if (!Array.isArray(notes) || notes.length > 100 || notes.some((line) => typeof line !== "string" || line.length > 4000)) {
      throw new Error("Release notes must be a string array of up to 100 entries, each at most 4000 characters.");
    }
    return notes;
  }
  if (!notesFile) return [];
  const content = fs.readFileSync(notesFile, "utf8").replace(/^\uFEFF/, "").trim();
  if (!content) return [];
  if (content.startsWith("[")) return readNotes(JSON.parse(content));
  return readNotes(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

/** Sign immutable archive metadata. latest.json is emitted only for a real configured HTTPS feed. */
export function finalizeRelease({ root, archive, outputDir, privateKeyPath, baseUrl, notes, notesFile, publishedAt = new Date().toISOString() } = {}) {
  if (!root || !archive || !outputDir) throw new Error("Specify root, archive and output directory.");
  publisherKeyOutsideRelease(root, privateKeyPath);
  const version = packageVersion(root);
  const config = jsonFile(path.join(root, "release-config.json"));
  const identity = signingIdentity(privateKeyPath, config.publicKey);
  const feedUrl = httpsUrl(config.manifestUrl, "Manifest URL");
  const github = config.githubRepository ? githubReleaseUrls(config.githubRepository, version) : undefined;
  const assetBase = httpsUrl(baseUrl || github?.baseUrl || (feedUrl ? new URL(".", feedUrl).href : ""), "Update base URL", true);
  const archivePath = path.resolve(archive);
  const archiveName = path.basename(archivePath);
  if (archiveName !== `figma-relay-${version}.zip`) throw new Error("Archive filename must match the packaged release version.");
  const archiveContents = fs.readFileSync(archivePath);
  const size = archiveContents.length;
  const sha256 = crypto.createHash("sha256").update(archiveContents).digest("hex");
  if (!size || size > 512 * 1024 * 1024) throw new Error("The release archive must contain between 1 byte and 512 MiB.");
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("Release publication time is invalid.");
  const releaseNotes = readNotes(notes, notesFile);
  const destination = path.resolve(outputDir);
  fs.mkdirSync(destination, { recursive: true });
  const checksumFile = path.join(destination, `figma-relay-${version}.sha256.txt`);
  fs.writeFileSync(checksumFile, `${sha256}  ${archiveName}\n`, "utf8");
  const metadataFile = path.join(destination, `figma-relay-${version}.release.json`);
  const metadata = {
    schemaVersion: 1, available: Boolean(feedUrl), version, publishedAt,
    notes: releaseNotes, archive: archiveName, sha256, size,
    manifestUrl: feedUrl, archiveUrl: assetBase ? new URL(archiveName, assetBase).href : "",
  };
  writeJson(metadataFile, metadata);
  if (!feedUrl) {
    return { configured: false, version, checksumFile, metadataFile,
      message: "Update source is not configured. No latest.json was generated; rebuild with -UpdateBaseUrl before publishing automatic updates." };
  }
  const payload = Buffer.from(JSON.stringify({
    schemaVersion: 1, version, publishedAt, notes: releaseNotes,
    archiveUrl: metadata.archiveUrl, sha256, size,
  }), "utf8");
  if (payload.toString("base64").length > 192 * 1024) throw new Error("Release manifest exceeds the updater payload limit.");
  const envelope = {
    schemaVersion: 1,
    payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, identity.privateKey).toString("base64"),
  };
  const manifestFile = path.join(destination, `figma-relay-${version}.manifest.json`);
  const latestFile = path.join(destination, "latest.json");
  writeJson(manifestFile, envelope);
  writeJson(latestFile, envelope);
  return { configured: true, version, checksumFile, metadataFile, manifestFile, latestFile, manifestUrl: feedUrl };
}

/** Validate artifacts before any remote release mutation. All paths are version-specific except latest.json. */
export function verifyReleaseArtifacts({ root, archive, outputDir, githubRepository } = {}) {
  const version = packageVersion(root);
  const config = jsonFile(path.join(root, "release-config.json"));
  const repository = githubRepository || config.githubRepository;
  const expected = githubReleaseUrls(repository, version);
  if (config.manifestUrl !== expected.manifestUrl) throw new Error("The packaged feed URL does not match the selected GitHub repository.");
  const manifestFile = path.join(outputDir, `figma-relay-${version}.manifest.json`);
  const latestFile = path.join(outputDir, "latest.json");
  const envelope = jsonFile(manifestFile);
  const latest = jsonFile(latestFile);
  if (JSON.stringify(envelope) !== JSON.stringify(latest)) throw new Error("latest.json belongs to a different packaged release.");
  if (envelope.schemaVersion !== 1 || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("Invalid signed GitHub release manifest.");
  const bytes = Buffer.from(envelope.payload, "base64");
  const publicKey = crypto.createPublicKey(config.publicKey);
  if (publicKey.asymmetricKeyType !== "ed25519" || !crypto.verify(null, bytes, publicKey, Buffer.from(envelope.signature, "base64"))) {
    throw new Error("Release manifest signature verification failed.");
  }
  const payload = JSON.parse(bytes.toString("utf8"));
  const archiveBytes = fs.readFileSync(archive);
  const digest = crypto.createHash("sha256").update(archiveBytes).digest("hex");
  if (payload.schemaVersion !== 1 || payload.version !== version || payload.archiveUrl !== expected.archiveUrl
    || payload.size !== archiveBytes.length || payload.sha256 !== digest || path.basename(archive) !== `figma-relay-${version}.zip`) {
    throw new Error("ZIP, version or GitHub download URL does not match the signed release manifest.");
  }
  const checksumFile = path.join(outputDir, `figma-relay-${version}.sha256.txt`);
  if (fs.readFileSync(checksumFile, "utf8").trim() !== `${digest}  figma-relay-${version}.zip`) throw new Error("Release checksum sidecar does not match the signed ZIP.");
  const metadataFile = path.join(outputDir, `figma-relay-${version}.release.json`);
  const files = [path.resolve(archive), manifestFile, latestFile, checksumFile, metadataFile];
  const validationFile = path.join(outputDir, `figma-relay-${version}.validation.json`);
  if (fs.existsSync(validationFile)) files.push(validationFile);
  return { version, repository, tag: `v${version}`, files: files.map((file) => path.resolve(file)), notes: payload.notes };
}

function parseArguments(argv) {
  const [command, ...args] = argv;
  const names = { "--root": "root", "--archive": "archive", "--output-dir": "outputDir", "--private-key": "privateKeyPath",
    "--base-url": "baseUrl", "--manifest-url": "manifestUrl", "--notes-file": "notesFile",
    "--github-repository": "githubRepository", "--repository": "repository", "--version": "version" };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    if (!name || args[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[name] = args[index + 1];
  }
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (!["prepare", "finalize", "github-urls", "verify-github"].includes(command)) throw new Error("Use prepare, finalize, github-urls or verify-github.");
    const result = command === "prepare" ? prepareRelease(options) : command === "finalize" ? finalizeRelease(options)
      : command === "github-urls" ? githubReleaseUrls(options.repository, options.version) : verifyReleaseArtifacts(options);
    // Do not print key contents or private key paths in public package output.
    console.log(JSON.stringify(command === "prepare" ? { configured: result.configured, manifestUrl: result.config.manifestUrl } : result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
