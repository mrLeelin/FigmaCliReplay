---
name: dxx-image
description: Use the project's local DXX Python CLI to generate or edit images, or decompose a screenshot into background and transparent layers. Applies to explicit DXX image requests and the project's screenshot decomposition workflow; credentials come from the plugin settings.
---

# DXX Image

Use this repository's `scripts/dxx_image.py` with Python 3.9+. It uses the standard library, its bundled module snapshot, and the same local settings as the plugin. No separately installed DXX Skill or MCP server is required. Module names do not establish the upstream model/version.

## Configuration and test

The plugin's Settings → DXX 图片拆层 saves `<relay-root>/.local/dxx-config.json`. The CLI resolves it from its own location, independent of the working directory. Each saved field takes priority over process `GORILLA_API_KEY` / `GORILLA_API_BASE`, then Windows current-user environment variables. A blank/missing project Key falls back to those environment variables; the default API origin is `https://canvas.dxx.cn`. Invalid saved configuration fails explicitly instead of silently switching accounts. Keep the Key out of requests, logs, prompts, and committed files.

The settings page test button and the following command use authenticated read-only `GET /api/v1/layer-decomposition`; they do not upload or generate an image:

```powershell
python -X utf8 ai/skills/dxx-image/scripts/dxx_image.py Test
```

Only run that test when the user asks to verify configuration. Actual image work normally validates authentication during its required calls.

## Choose the requested capability

| User request | Capability |
|---|---|
| Screenshot/image layering, background plus transparent layers, or Seedream5.0Pro layering | `Decompose`, separate built-in decomposition API |
| `dxx_image2.5` | `image2.5生图`, zero to ten reference images |
| `dxx_banana` / `dxx_banana2` | `文生图(banana)` without references, `图像编辑(banana)` with references |
| `dxx_seedream5` | `文生图(seedream5.0)` without references, `图像编辑(seedream5.0)` with references |

The aliases are request names, not separate API modules. If the user requests ordinary generation/editing without choosing a model, ask which supported model they want; decomposition already identifies its capability and needs no generation-model choice. Read [api.md](references/api.md) only for unfamiliar generation/edit parameters.

## Generate or edit

Use `Run --request-file - --out-dir <unique-directory>` with UTF-8 JSON on stdin containing `function`, `prompt`, optional `images`, and requested `config`. Reuse known Python and source image paths. Do not first request the module catalog, inspect unrelated environment variables, install dependencies, or submit a paid sample merely to test installation.

`Run` uploads, submits once, polls, downloads, and optionally previews in one process. Wait on that existing process. A new job needs a new directory. Keep `request.json`, task IDs, response, and original downloaded images. Transient GET failures have bounded retries; POST is not automatically retried. Use `Wait --task-id ... --out-dir ...` for a known task after interruption. An unknown ordinary generation submission must be matched read-only against task/history records, not submitted again.

Only send requested configuration. Review returned images and report mismatches. Preview failure does not invalidate a downloaded result; optional previews do not replace the original delivery. Report measured timing boundaries without promising fixed completion times.

## Decompose an image

Read [layer-decomposition.md](references/layer-decomposition.md) once for the exact endpoint and recovery contract. The command takes one local image:

```powershell
python -X utf8 ai/skills/dxx-image/scripts/dxx_image.py Decompose --file <image.png> --prompt <resource-boundaries> --size 2K --out-dir <unique-directory>
```

For the screenshot-to-Figma workflow, resource boundaries come from the adjacent [image-layer-to-figma Skill](../image-layer-to-figma/SKILL.md). The CLI executes that plan; it does not choose the user-facing asset granularity.

Deliver the original ZIP, manifest, upstream response, and extracted files. Restore placement from document dimensions, placement coordinates and zIndex, rather than PNG size. A ZIP is not PSD; transparent boundaries and occluded pixels are approximate. The API does not establish an exact upstream model version.

Preserve UUID/request body before submission. Query a known ID with `Layerwait` / `Layerstatus`. Only use `Layerresume` explicitly to recover a missing submission response using the same saved UUID/body. `error`, `submission_unknown`, or client timeout retains recovery evidence and does not authorize a fresh paid task. Send a billing-group parameter only when the user selects one. Do not search unrelated files for credentials or expose raw authentication failures.
