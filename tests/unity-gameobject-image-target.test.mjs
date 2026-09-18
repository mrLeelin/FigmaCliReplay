import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const bridge = fs.readFileSync(
  new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs", import.meta.url),
  "utf8"
);

test("Hierarchy GameObject target requires exactly one local Image-derived component", () => {
  const resolverStart = bridge.indexOf("private static ImageImportTarget ResolveImageImportTarget()");
  const resolverEnd = bridge.indexOf("private static bool IsAssetsPath", resolverStart);
  const resolver = bridge.slice(resolverStart, resolverEnd);

  assert.match(resolver, /Selection\.activeGameObject/);
  assert.match(resolver, /GetComponents<Image>\(\)/);
  assert.match(resolver, /imageComponents\.Length\s*!=\s*1/);
  assert.match(resolver, /ImageImportTarget\.Replace\(/);
});

test("Hierarchy GameObject target rejects missing and non-asset-backed sprites", () => {
  const resolverStart = bridge.indexOf("private static ImageImportTarget ResolveImageImportTarget()");
  const resolverEnd = bridge.indexOf("private static bool IsAssetsPath", resolverStart);
  const resolver = bridge.slice(resolverStart, resolverEnd);

  assert.match(resolver, /image\.sprite\s*==\s*null/);
  assert.match(resolver, /AssetDatabase\.GetAssetPath\(image\.sprite\)/);
  assert.match(resolver, /IsImageAssetSelection\(image\.sprite,/);
});

test("Unity bridge reports whether the selected Assets folder is empty", () => {
  const handlerStart = bridge.indexOf("private static void HandleSelectedFolder");
  const handlerEnd = bridge.indexOf("private static void HandleExportSelected", handlerStart);
  const handler = bridge.slice(handlerStart, handlerEnd);

  assert.match(handler, /selectedObjectIsFolder/);
  assert.match(handler, /selectedFolderIsEmpty/);
  assert.match(bridge, /using System\.Linq;/);
  assert.match(bridge, /private static bool IsAssetFolderEmpty\(/);
});

test("Unity bridge exposes the deterministic Figma Prefab import endpoint", () => {
  assert.ok(bridge.includes('case "/figma-to-prefab-import"'));
  assert.match(bridge, /HandleFigmaToPrefabImport\(/);
  assert.match(bridge, /ConfigureFigmaImportSprites\(/);
  assert.match(bridge, /MagicWarrior\.Editor\.FigmaBridge\.PrefabImport\.FigmaPrefabGenerator/);
  assert.match(bridge, /GetMethod\(/);
});
