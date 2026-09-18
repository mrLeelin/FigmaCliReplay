import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const genSpec = fs.readFileSync(new URL("../ai/skills/figma-to-prefab/scripts/gen_spec.py", import.meta.url), "utf8");
const processImages = fs.readFileSync(new URL("../ai/skills/figma-to-prefab/scripts/process_images.py", import.meta.url), "utf8");
const verifyPrefab = fs.readFileSync(new URL("../ai/skills/figma-to-prefab/scripts/verify_prefab.py", import.meta.url), "utf8");
const pipeline = fs.readFileSync(new URL("../ai/skills/figma-to-prefab/scripts/run_full_import.py", import.meta.url), "utf8");
const generator = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/PrefabImport/FigmaPrefabGenerator.cs", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs", import.meta.url), "utf8");

test("deterministic spec preserves Figma text metrics and material signatures", () => {
  assert.match(genSpec, /fontSize/);
  assert.match(genSpec, /textMaterial|materialTag|materialSignature/);
  assert.match(genSpec, /bounds/);
  assert.match(generator, /TextMaterialSpec/);
  assert.match(generator, /tmp\.font\s*=\s*commonFont/);
  assert.match(generator, /enableAutoSizing\s*=\s*false/);
  assert.match(generator, /fontSharedMaterial/);
});

test("deterministic image path preserves nine-slice borders and sliced import mode", () => {
  assert.match(genSpec, /nineSlice|spriteBorder|border/);
  assert.match(processImages, /border|jiugong|nine/i);
  assert.match(generator, /spriteBorder|border/);
  assert.match(generator, /Image\.Type\.Sliced|imageType\s*=\s*Image\.Type\.Sliced/);
  assert.match(generator, /new Vector4\(border\.l, border\.b, border\.r, border\.t\)/);
  assert.match(generator, /importer\.spriteBorder\s*=\s*spriteBorder/);
});

test("nine-slice pixels and text material math pass fixture-driven Python tests", () => {
  const script = new URL(
    "../ai/skills/figma-to-prefab/scripts/tests/test_lossless_rules.py",
    import.meta.url
  );
  const result = spawnSync("python", [script.pathname.slice(1)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("deterministic validation blocks image and Unity residue failures", () => {
  assert.match(verifyPrefab, /allPass/);
  assert.match(verifyPrefab, /spriteNull/);
  assert.match(verifyPrefab, /raycastTargetOn/);
  assert.match(verifyPrefab, /autoSizeOff/);
  assert.match(verifyPrefab, /commonFontExact/);
  assert.match(verifyPrefab, /blockingErrors/);
  assert.match(pipeline, /validate_image_manifest_health/);
  assert.match(pipeline, /verifyAllPass=bool\(vp\.get\("allPass"\)\)/);
  assert.match(pipeline, /sys\.exit\(0 if vp\.get\("allPass"\) else 2\)/);
});

test("split output contract remains Prefab, Texture, and UiAtlas with create-new-only", () => {
  assert.match(pipeline, /formal-layout.*choices=\["split", "legacy"\]/);
  assert.match(pipeline, /derive_formal_paths/);
  assert.match(pipeline, /UiAtlas/);
  assert.match(pipeline, /create-new-only/);
});

test("direct import creates a real SpriteAtlas v2 asset from the Texture folder", () => {
  assert.match(bridge, /SpriteAtlasAsset/);
  assert.match(bridge, /addMethod[\s\S]*"Add"/);
  assert.match(bridge, /saveMethod[\s\S]*"Save"/);
  assert.match(bridge, /textureFolder/);
  assert.match(bridge, /spriteatlasv2/);
});
