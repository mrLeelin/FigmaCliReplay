import path from "node:path";

import { PLUGIN_ROOT } from "../config.js";

/** Small discovery pointer; command contracts stay in the CLI's own help. */
export function relayCliInstructions(sessionId?: string): string {
  const fallback = `node "${path.join(PLUGIN_ROOT, "dist", "cli.js").replaceAll("\\", "/")}"`;
  return [
    "## Figma Relay CLI entry",
    "The local plugin is available through the figma-relay command. When a Relay operation is needed, discover its installed contract:",
    "1. figma-relay --help",
    "2. figma-relay commands --search <topic> --json",
    "3. figma-relay describe <operation> --json",
    sessionId
      ? `This task belongs to sessionId ${JSON.stringify(sessionId)}. Pass that value with --session-id for Figma operations; use sessions to reconcile availability, without switching to another session.`
      : "Use figma-relay sessions to identify the target. Pass --session-id when multiple sessions match.",
    "In PowerShell, save operation parameters as a UTF-8 JSON object and use --payload-file. Figma routing belongs in --session-id / --file-key outside that payload.",
    `If figma-relay is unavailable on PATH, use ${fallback} with the same arguments; this fallback works from any working directory.`,
    "Discovery is read-only and grants no additional mutation authority. Preserve this task's specialized workflow and phase restrictions; after an uncertain write result, reconcile the original task ID before resubmitting.",
    "",
  ].join("\n");
}
