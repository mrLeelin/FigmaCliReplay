import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// The plugin and terminal share the same installer/status implementation.
export { installAiSkill, getAiSkillStatus } from "../dist/aiSkillManager.js";
import { installAiSkill, getAiSkillStatus } from "../dist/aiSkillManager.js";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { help: { type: "boolean" }, status: { type: "boolean" }, home: { type: "string" }, target: { type: "string" } } });
    if (values.help) process.stdout.write("Usage: node scripts/install_ai_skill.mjs [--status] [--target all|codex|claude] [--home <directory>]\nInstalls or checks the local Figma Relay skill for Codex and/or Claude Code; preserves agent settings and locally edited files.\n");
    else process.stdout.write(JSON.stringify((values.status ? getAiSkillStatus : installAiSkill)(values)) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
