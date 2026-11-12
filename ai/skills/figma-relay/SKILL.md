---
name: figma-relay
description: Operate the local Figma Relay plugin through the figma-relay CLI. Use for Figma Relay requests, reading the current Figma selection, inspecting or editing local Figma nodes, hierarchy cleanup, and PSD or Unity Prefab transfers through the connected plugin. 通过本机插件读取或修改 Figma 时使用。
---

# Figma Relay

Use the installed `figma-relay` command from any working directory. If the command is unavailable or project workflow paths are needed, read [installation details](references/installation.md) for this installation's CLI path and repository root.

1. Run `figma-relay --help`, then `figma-relay commands --search <topic> --json` to locate the operation. Use `--kind figma` or `--kind control` to narrow the catalog.
2. Read `figma-relay describe <operation> --json`. It supplies the entry point, payload JSON Schema, example arguments, constraints and implementation source. Keep schemas in the CLI rather than memorizing operation names or guessing payload fields.
3. Run `figma-relay sessions` for Figma operations. Match the user's file/node target and pass the resolved `--session-id`; use `selection` only when the user intends the current selection. Multiple sessions require explicit disambiguation.
4. Execute the authorized operation. In PowerShell, save the payload as UTF-8 JSON and use `--payload-file`; pass Figma routing with `--session-id` / `--file-key`, outside the payload. Follow the specialized project workflow referenced by the operation's notes for cleanup, PSD or Prefab work.
5. Inspect the JSON result and task status. Successful submission is not completion. After a timeout or uncertain write result, query the original task ID before resubmitting. Report returned artifacts and verification evidence.

Help and discovery are offline. Business commands require an independently running Relay and the relevant plugin/Editor connection. A connection error should include the exact failed command and error; service lifecycle is managed outside this skill. Workflow gates and the user's requested scope still apply.
