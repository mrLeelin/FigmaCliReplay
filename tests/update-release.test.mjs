import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditReleaseTree, prepareRelease, finalizeRelease, githubReleaseUrls, verifyReleaseArtifacts } from "../scripts/create_release_manifest.mjs";
import { parseSignedManifest } from "../scripts/update_common.mjs";

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-release-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "figma-relay");
  const outputDir = path.join(temporary, "output");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.50" }));
  fs.writeFileSync(path.join(root, "release-config.json"), JSON.stringify({ schemaVersion: 1, manifestUrl: "", publicKey: "" }));
  const archive = path.join(temporary, "figma-relay-0.1.50.zip");
  fs.writeFileSync(archive, Buffer.from("archive contents are hashed without re-encoding\0\xff", "latin1"));
  return { root, archive, outputDir, privateKeyPath: path.join(temporary, "publisher-only", "private.pem") };
}

test("release feed signs exact archive metadata and pins a reusable publisher identity", (t) => {
  const options = fixture(t);
  const first = prepareRelease({ ...options, baseUrl: "https://downloads.example.com/relay" });
  const second = prepareRelease({ ...options, baseUrl: "https://downloads.example.com/relay" });
  assert.equal(first.config.publicKey, second.config.publicKey);
  assert.equal(first.config.manifestUrl, "https://downloads.example.com/relay/latest.json");
  const result = finalizeRelease({ ...options, notes: ["修复 PSD 导入", "更新 Bridge"], publishedAt: "2026-11-12T00:00:00.000Z" });
  assert.equal(result.configured, true);
  const envelope = JSON.parse(fs.readFileSync(result.latestFile, "utf8"));
  assert.deepEqual(envelope, JSON.parse(fs.readFileSync(result.manifestFile, "utf8")));
  const payload = Buffer.from(envelope.payload, "base64");
  assert.equal(crypto.verify(null, payload, first.config.publicKey, Buffer.from(envelope.signature, "base64")), true);
  assert.deepEqual(parseSignedManifest(envelope, first.config.publicKey), JSON.parse(payload));
  assert.deepEqual(JSON.parse(payload), {
    schemaVersion: 1, version: "0.1.50", publishedAt: "2026-11-12T00:00:00.000Z",
    notes: ["修复 PSD 导入", "更新 Bridge"], archiveUrl: "https://downloads.example.com/relay/figma-relay-0.1.50.zip",
    sha256: crypto.createHash("sha256").update(fs.readFileSync(options.archive)).digest("hex"), size: fs.statSync(options.archive).size,
  });
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(payload), version: "99.0.0" }));
  assert.equal(crypto.verify(null, changed, first.config.publicKey, Buffer.from(envelope.signature, "base64")), false);
  const wrongKey = crypto.generateKeyPairSync("ed25519").publicKey;
  assert.equal(crypto.verify(null, payload, wrongKey, Buffer.from(envelope.signature, "base64")), false);
  assert.equal(fs.readFileSync(result.checksumFile, "utf8").endsWith("  figma-relay-0.1.50.zip\n"), true);
  assert.doesNotMatch(fs.readFileSync(path.join(options.root, "release-config.json"), "utf8"), /PRIVATE KEY/);
  assert.equal(auditReleaseTree(options.root).files, 2);
});

test("unconfigured packages expose no signed latest feed and do not imply online availability", (t) => {
  const options = fixture(t);
  assert.equal(prepareRelease(options).configured, false);
  const result = finalizeRelease(options);
  assert.equal(result.configured, false);
  assert.equal(result.latestFile, undefined);
  assert.equal(fs.existsSync(path.join(options.outputDir, "latest.json")), false);
  assert.equal(fs.existsSync(path.join(options.outputDir, "figma-relay-0.1.50.manifest.json")), false);
  const metadata = JSON.parse(fs.readFileSync(result.metadataFile, "utf8"));
  assert.equal(metadata.available, false);
  assert.equal(metadata.archiveUrl, "");
  assert.match(result.message, /not configured/);
});

test("missing or replaced publisher keys cannot silently change an existing trusted release identity", (t) => {
  const options = fixture(t);
  prepareRelease({ ...options, baseUrl: "https://updates.example.com" });
  fs.unlinkSync(options.privateKeyPath);
  assert.throws(() => prepareRelease(options), /private key is missing/);
  assert.equal(fs.existsSync(options.privateKeyPath), false);
  const replacement = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(options.privateKeyPath, replacement.privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.throws(() => prepareRelease(options), /does not match/);
  assert.throws(() => finalizeRelease(options), /does not match/);
});

test("release URL inputs reject insecure or credential-bearing update sources", (t) => {
  for (const baseUrl of ["http://example.com", "https://user:pass@example.com", "https://example.com/#fragment", "https://example.com/?token=secret"]) {
    const options = fixture(t);
    assert.throws(() => prepareRelease({ ...options, baseUrl }), /HTTPS URL/);
    assert.equal(fs.existsSync(options.privateKeyPath), false);
  }
});

test("archive URL may use a separate HTTPS asset directory and release notes may come from UTF-8 text", (t) => {
  const options = fixture(t);
  const notesFile = path.join(path.dirname(options.root), "notes.txt");
  fs.writeFileSync(notesFile, "\uFEFF修复连接\n\n优化导入\n", "utf8");
  prepareRelease({ ...options, manifestUrl: "https://updates.example.com/channels/stable.json" });
  const result = finalizeRelease({ ...options, baseUrl: "https://cdn.example.com/releases", notesFile });
  const payload = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(result.latestFile, "utf8")).payload, "base64"));
  assert.deepEqual(payload.notes, ["修复连接", "优化导入"]);
  assert.equal(payload.archiveUrl, "https://cdn.example.com/releases/figma-relay-0.1.50.zip");
});

test("release tree audit rejects machine state, private keys and symbolic links before packaging", (t) => {
  for (const relative of [".local/admin-token.txt", "scripts/.env", "ai/__pycache__/retired.pyc", "scripts/publisher.pem"]) {
    const options = fixture(t);
    const file = path.join(options.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith(".pem") ? "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" : "local state");
    assert.throws(() => prepareRelease(options), /Machine-local|Private signing/);
    assert.equal(fs.existsSync(options.privateKeyPath), false);
  }
});

test("publisher key location cannot create private signing material inside the distributable tree", (t) => {
  const options = fixture(t);
  const privateKeyPath = path.join(options.root, "signing.pem");
  assert.throws(() => prepareRelease({ ...options, privateKeyPath }), /outside the assembled release/);
  assert.equal(fs.existsSync(privateKeyPath), false);
});

test("GitHub release configuration keeps a stable feed and pins each archive to its own version tag", (t) => {
  const options = fixture(t);
  const repository = "mrLeelin/FigmaCliReplay";
  const urls = githubReleaseUrls(repository, "0.1.50");
  assert.equal(urls.manifestUrl, "https://github.com/mrLeelin/FigmaCliReplay/releases/latest/download/latest.json");
  assert.equal(urls.archiveUrl, "https://github.com/mrLeelin/FigmaCliReplay/releases/download/v0.1.50/figma-relay-0.1.50.zip");
  fs.writeFileSync(path.join(options.root, "release-config.json"), JSON.stringify({ schemaVersion: 1, publicKey: "", manifestUrl: urls.manifestUrl, githubRepository: repository }));
  const prepared = prepareRelease(options);
  assert.equal(prepared.config.githubRepository, repository);
  const finalized = finalizeRelease(options);
  const verified = verifyReleaseArtifacts({ ...options, githubRepository: repository });
  assert.equal(verified.tag, "v0.1.50");
  assert.equal(verified.files.length, 5);
  assert.equal(JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(finalized.latestFile)).payload, "base64")).archiveUrl, urls.archiveUrl);
  fs.appendFileSync(options.archive, "tampered");
  assert.throws(() => verifyReleaseArtifacts({ ...options, githubRepository: repository }), /does not match/);
  for (const invalid of ["../repo", "owner/repo/path", "https://github.com/owner/repo", "owner/repo?token=secret"]) {
    assert.throws(() => githubReleaseUrls(invalid, "0.1.50"), /owner\/repository/);
  }
});

test("GitHub publisher dry-run verifies local artifacts and makes no remote calls", { skip: process.platform !== "win32" }, (t) => {
  const options = fixture(t);
  const repository = "mrLeelin/FigmaCliReplay";
  const outputDir = options.outputDir;
  const root = path.join(outputDir, "figma-relay-0.1.50", "figma-relay");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.cpSync(options.root, root, { recursive: true });
  const archive = path.join(outputDir, "figma-relay-0.1.50.zip");
  fs.copyFileSync(options.archive, archive);
  const publisherOptions = { ...options, root, archive, githubRepository: repository };
  prepareRelease(publisherOptions);
  finalizeRelease(publisherOptions);
  const target = "a".repeat(40);
  const script = path.resolve("scripts/publish_github_release.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Version", "0.1.50", "-TargetCommit", target, "-Repository", repository, "-OutputDirectory", outputDir, "-DryRun"];
  const result = spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.repository, repository);
  assert.equal(plan.targetCommit, target);
  assert.equal(plan.draftFirst, true);
  assert.equal(plan.publish, false);
  assert.equal(plan.assets.length, 5);
  fs.appendFileSync(archive, "tampered");
  const rejected = spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Local release verification failed/);
});
