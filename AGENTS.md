<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
CODEX NATIVE SUBAGENTS MAY BE USED PROACTIVELY FOR INDEPENDENT PARALLEL SUBTASKS OR REVIEW. EXPLICIT USER REQUEST OR A MANDATORY BENEFIT THRESHOLD IS NOT REQUIRED.
<!-- END AUTONOMY DIRECTIVE -->

## Figma Relay CLI discovery

For Figma Relay tasks, read [the CLI skill](ai/skills/figma-relay/SKILL.md). To make it discoverable from other projects, run `npm run ai:install-skill`; it installs this skill for the current user's Codex and Claude Code without changing their global settings.

When reading or editing Figma through this project, start with `figma-relay --help`, then `figma-relay commands --search <topic> --json`. Before invoking a business operation, read `figma-relay describe <name> --json` for its payload schema, examples and runtime constraints. Use `figma-relay sessions` to choose the target; pass `--session-id` when multiple sessions are online.

If the command is unavailable in a source checkout, run `npm link --ignore-scripts --offline` after building, or use `node dist/cli.js` with the same arguments. For JSON payloads in PowerShell, write a UTF-8 request file and pass `--payload-file`; keep Figma routing in `--session-id` / `--file-key`. Follow the workflow in [docs/cli.md](docs/cli.md) for setup, tasks, Unity and import operations. After an uncertain write result, reconcile the original task ID before resubmitting.
