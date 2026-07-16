# Portable Path Resolution Design

## Goal

Remove hard dependencies on the `JellybeanUnity` repository name, machine-local absolute paths, and the legacy `.figma/plugins/figma-mcp-relay` checkout layout. The standalone Relay, bundled workflow scripts, and Unity Bridge must work from arbitrary install locations and with arbitrarily named Unity projects.

## Scope

This change covers:

- Python workflow entrypoints under `ai/skills/**/scripts`.
- The legacy Python relay helpers under `server/`.
- Unity Bridge path normalization and Prefab export path contracts.
- Bundled skill instructions, prompts, and reference documents.
- Regression tests and a repository scan that prevents machine-local paths from returning.

Generated artifacts, historical design examples, test-only sentinel paths, and user-supplied paths are not runtime defaults. Historical documents may keep a clearly labeled example only when it cannot influence an executable workflow; current workflow documentation must use portable placeholders.

## Path Contracts

### Relay root

Scripts that need the bundled MCP client locate the Relay root by walking upward from `__file__` until `client/figma_mcp_client.py` exists. They must not require a `.figma` directory or a sibling Unity project.

### Unity project root

Unity-writing scripts resolve the project in this order:

1. An explicit `--unity-project <path>` argument.
2. The `FIGMA_UNITY_PROJECT` environment variable.
3. The selected project from the Relay's existing Unity project registry when the caller already operates through the Relay.

The resolved directory must contain both `Assets/` and `ProjectSettings/`. A missing project is an explicit error that explains how to provide one; scripts must not silently append `JellybeanUnity` or guess a project from a fixed directory name.

Read-only evidence commands may operate without a Unity project when all supplied artifacts are absolute and already exist. Defaults that need Unity files must use the same resolver and error contract.

### Asset paths

Cross-process and persisted Unity asset paths use the Unity-native form `Assets/...`. Relay and Unity Bridge code must not prepend or depend on a project-name prefix such as `JellybeanUnity/Assets/...`.

For compatibility with existing saved artifacts, readers may accept one leading project-directory segment before `Assets/`, but they must strip it generically rather than compare it to a fixed project name. New outputs always emit `Assets/...`.

### Documentation

Current commands use placeholders:

- `<relay-root>` for the standalone Relay directory.
- `<unity-project>` for the directory containing `Assets/` and `ProjectSettings/`.
- `<unity-assets-path>` for an `Assets/...` path.

Current skills and references must not contain developer-machine paths such as `E:\Project\...` or `C:\Users\...`.

## Component Changes

### Python MCP clients

Hierarchy cleanup, PSD follow-up helpers, and Prefab-to-Figma clients share the same Relay-root marker contract. Each CLI must reach argument parsing successfully when launched from the standalone checkout.

### Figma-to-Prefab scripts

Scripts that read or write Unity files receive the resolved Unity project explicitly through their call chain. Defaults for temporary files are derived from the resolved project rather than from `JellybeanUnity/.tmp`. Benchmark and verification scripts expose `--unity-project` and propagate it to child commands.

### Legacy Python relay

The crop/nine-slice path accepts the Unity project root from request/config context. It does not derive the root from the Relay directory. Prefab path normalization emits `Assets/...`.

### Unity Bridge

Prefab and image exporters emit `Assets/...`. Importers accept `Assets/...` and generically normalize older `<project-name>/Assets/...` input. Repository-root calculations based on `Application.dataPath` are replaced with direct Unity project-root calculations where repository ownership is unnecessary.

## Error Handling

- Invalid explicit Unity paths report the received path and the missing `Assets/` or `ProjectSettings/` marker.
- Missing Unity project context reports the supported argument and environment variable.
- Missing Relay client reports the searched script location and required marker.
- No resolver silently falls back to a directory named `JellybeanUnity`.

## Testing

Tests must first reproduce the current failures and then cover:

- Every bundled Python CLI reaches `--help` from the standalone Relay root.
- Unity-writing scripts accept a temporary Unity project whose directory name is not `JellybeanUnity`.
- Explicit arguments override environment configuration.
- Asset-path normalization converts both `Assets/X` and legacy `AnyProject/Assets/X` to `Assets/X`.
- Unity Bridge source contracts do not emit `JellybeanUnity/`.
- Current executable sources and workflow documentation contain neither machine-local absolute paths nor runtime `JellybeanUnity` root discovery.
- Existing TypeScript build, typecheck, Node tests, and Python compilation remain green.

## Compatibility and Boundaries

- Existing `Assets/...` callers remain unchanged.
- Existing saved artifacts with a single project-name prefix remain readable.
- The project registry remains the source of selected-project state; this change does not create a second settings store.
- The change does not redesign import behavior, Figma routing, image processing, or Prefab generation beyond path resolution and propagation.

## Success Criteria

- No executable workflow requires the Unity project to be named `JellybeanUnity`.
- No current workflow instruction requires a specific drive, checkout, or user profile.
- All affected CLIs start from the standalone Relay checkout.
- A real workflow can target an explicitly selected, arbitrarily named Unity project.
- Automated scans prevent these path dependencies from returning.
