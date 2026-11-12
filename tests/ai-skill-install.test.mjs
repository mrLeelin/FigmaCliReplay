import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { installAiSkill, getAiSkillStatus } from "../scripts/install_ai_skill.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-skill-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("install makes the same skill discoverable for both agents and preserves settings", (t) => {
  const home = fixture(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const settings = path.join(home, ".claude", "settings.json");
  fs.writeFileSync(settings, '{"custom":"preserved"}\n');
  const result = installAiSkill({ home });
  assert.equal(result.ok, true);
  assert.deepEqual(result.installations.map((item) => item.agent), ["codex", "claude"]);
  const [codex, claude] = result.installations;
  assert.equal(codex.directory, path.join(home, ".agents", "skills", "figma-relay"));
  assert.equal(claude.directory, path.join(home, ".claude", "skills", "figma-relay"));
  const source = fs.readFileSync(new URL("../ai/skills/figma-relay/SKILL.md", import.meta.url), "utf8");
  for (const { directory } of result.installations) {
    assert.equal(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8"), source);
    const reference = fs.readFileSync(path.join(directory, "references", "installation.md"), "utf8");
    assert.ok(reference.includes(path.resolve("dist/cli.js")));
    assert.ok(reference.includes("node '"));
    assert.ok(fs.existsSync(path.join(directory, "agents", "openai.yaml")));
  }
  assert.equal(fs.readFileSync(settings, "utf8"), '{"custom":"preserved"}\n');
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
});

test("install is idempotent and supports a single target", (t) => {
  const home = fixture(t);
  const first = installAiSkill({ home, target: "codex" });
  assert.deepEqual(installAiSkill({ home, target: "codex" }), first);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
});

test("conflict preflight preserves an unrelated skill without partially installing the other agent", (t) => {
  const home = fixture(t);
  const existing = path.join(home, ".claude", "skills", "figma-relay", "SKILL.md");
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, "Existing custom skill");
  assert.throws(() => installAiSkill({ home }), /Preserving an existing or locally edited skill/);
  assert.equal(fs.readFileSync(existing, "utf8"), "Existing custom skill");
  assert.equal(fs.existsSync(path.join(home, ".agents")), false);
});

test("reinstall protects local edits but upgrades an unchanged managed version", (t) => {
  const home = fixture(t);
  const [{ directory }] = installAiSkill({ home, target: "claude" }).installations;
  const skillPath = path.join(directory, "SKILL.md");
  fs.writeFileSync(skillPath, "Locally edited skill");
  assert.throws(() => installAiSkill({ home, target: "claude" }), /locally edited/);
  assert.equal(fs.readFileSync(skillPath, "utf8"), "Locally edited skill");
  const manifestPath = path.join(directory, ".figma-relay-install.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // Simulate an earlier installer-owned version whose bytes are unchanged.
  manifest.files["SKILL.md"] = createHash("sha256").update("Locally edited skill").digest("hex");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  installAiSkill({ home, target: "claude" });
  assert.equal(fs.readFileSync(skillPath, "utf8"), fs.readFileSync(new URL("../ai/skills/figma-relay/SKILL.md", import.meta.url), "utf8"));
});

test("unsupported agent target fails before filesystem writes", (t) => {
  const home = fixture(t);
  assert.throws(() => installAiSkill({ home, target: "unknown" }), /--target/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("status checks an absent installation without creating user directories", (t) => {
  const home = fixture(t);
  const status = getAiSkillStatus({ home });
  assert.equal(status.sourceAvailable, true);
  assert.equal(status.installations.length, 2);
  for (const entry of status.installations) {
    assert.equal(entry.status, "missing");
    assert.equal(entry.installed, false);
    assert.equal(entry.current, false);
    assert.equal(entry.canInstall, true);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test("status reads required file bytes, detects deletion and repairs only the selected agent", (t) => {
  const home = fixture(t);
  const written = installAiSkill({ home });
  assert.ok(written.installations.every((entry) => entry.status === "installed" && entry.current));
  const directory = written.installations[0].directory;
  const reference = path.join(directory, "references", "installation.md");
  fs.unlinkSync(reference);
  const missing = getAiSkillStatus({ home }).installations;
  assert.equal(missing[0].status, "missing");
  assert.equal(missing[0].installed, false);
  assert.equal(missing[1].status, "installed");
  const restored = installAiSkill({ home, target: "codex" });
  assert.equal(restored.installations.length, 1);
  assert.equal(restored.installations[0].current, true);
  assert.ok(fs.existsSync(reference));
});

test("status distinguishes managed old content from local modifications", (t) => {
  const home = fixture(t);
  const [{ directory }] = installAiSkill({ home, target: "codex" }).installations;
  const skill = path.join(directory, "SKILL.md");
  const record = path.join(directory, ".figma-relay-install.json");
  fs.writeFileSync(skill, "Previous Skill version");
  const modified = getAiSkillStatus({ home, target: "codex" }).installations[0];
  assert.equal(modified.status, "modified");
  assert.equal(modified.canInstall, false);
  assert.equal(modified.current, false);
  const manifest = JSON.parse(fs.readFileSync(record, "utf8"));
  manifest.files["SKILL.md"] = createHash("sha256").update("Previous Skill version").digest("hex");
  fs.writeFileSync(record, JSON.stringify(manifest));
  const outdated = getAiSkillStatus({ home, target: "codex" }).installations[0];
  assert.equal(outdated.status, "outdated");
  assert.equal(outdated.canInstall, true);
  assert.equal(outdated.installed, true);
  assert.equal(installAiSkill({ home, target: "codex" }).installations[0].current, true);
});

test("moving the Relay package marks its managed fallback path outdated", (t) => {
  const home = fixture(t);
  const [{ directory }] = installAiSkill({ home, target: "codex" }).installations;
  const movedRoot = path.join(home, "MovedRelay");
  fs.mkdirSync(path.join(movedRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(movedRoot, "dist", "cli.js"), "// Fixture CLI");
  fs.cpSync(new URL("../ai/skills/figma-relay", import.meta.url), path.join(movedRoot, "ai", "skills", "figma-relay"), { recursive: true });
  const moved = getAiSkillStatus({ home, projectRoot: movedRoot, target: "codex" });
  assert.equal(moved.installations[0].status, "outdated");
  installAiSkill({ home, projectRoot: movedRoot, target: "codex" });
  assert.ok(fs.readFileSync(path.join(directory, "references", "installation.md"), "utf8").includes(path.join(movedRoot, "dist", "cli.js")));
  assert.equal(getAiSkillStatus({ home, projectRoot: movedRoot, target: "codex" }).installations[0].current, true);
});

test("corrupt installation records and inaccessible paths are errors, not success", (t) => {
  const home = fixture(t);
  const [{ directory }] = installAiSkill({ home, target: "codex" }).installations;
  const record = path.join(directory, ".figma-relay-install.json");
  fs.writeFileSync(record, "{broken-json");
  const entry = getAiSkillStatus({ home, target: "codex" }).installations[0];
  assert.equal(entry.status, "error");
  assert.equal(entry.current, false);
  assert.equal(entry.canInstall, false);
  assert.throws(() => installAiSkill({ home, target: "codex" }), /Preserving/);
  assert.equal(fs.readFileSync(record, "utf8"), "{broken-json");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "skills"), "blocked path");
  assert.equal(getAiSkillStatus({ home, target: "claude" }).installations[0].status, "error");
});

test("missing package sources disable installation without writing user files", (t) => {
  const home = fixture(t);
  const status = getAiSkillStatus({ home, projectRoot: path.join(home, "MissingRelay") });
  assert.equal(status.sourceAvailable, false);
  assert.ok(status.sourceError);
  assert.ok(status.installations.every((entry) => entry.status === "error" && !entry.canInstall));
  assert.throws(() => installAiSkill({ home, projectRoot: path.join(home, "MissingRelay") }), /安装源不可用/);
  assert.deepEqual(fs.readdirSync(home), []);
});
