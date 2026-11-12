# Source checkout

The skill installer writes this file with the absolute Relay CLI and repository paths for the destination machine. In this source checkout, the CLI is `dist/cli.js` under the repository root. Build the CLI and register it with `npm link --ignore-scripts --offline`, then run `figma-relay --help`.

Project workflow documentation is in `docs/cli.md` and `ai/skills` under the Relay repository root. Operation descriptions identify the relevant workflow.
