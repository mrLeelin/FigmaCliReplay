import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../unity/Assets/Editor/FigmaBridge/", import.meta.url);

test("Unity Bridge owns diagnostics in a dedicated BridgeLogger", async () => {
  const logger = await readFile(new URL("BridgeLogger.cs", root), "utf8");
  assert.match(logger, /class\s+BridgeLogger/);
  assert.match(logger, /class\s+BridgeOperationScope/);
  assert.match(logger, /source\\\":\\\"unity/);
  assert.match(logger, /figma-bridge-logs/);
  assert.match(logger, /StartOperation/);
});

test("Bridge server delegates logging and exposes structured Unity logs", async () => {
  const server = await readFile(new URL("FigmaBridgeServer.cs", root), "utf8");
  assert.match(server, /BridgeLogger\.Info\(message\)/);
  assert.match(server, /case\s+"\/logs"/);
  assert.match(server, /BridgeLogger\.QueryJson/);
  assert.match(server, /BridgeLogger\.StartOperation/);
});

test("Bridge window reads and clears the standalone logger", async () => {
  const window = await readFile(new URL("FigmaBridgeWindow.cs", root), "utf8");
  assert.match(window, /BridgeLogger\.OnChanged/);
  assert.match(window, /BridgeLogger\.DisplayLogs/);
  assert.match(window, /BridgeLogger\.Clear/);
});

test("Unity source image metadata uses the existing portable asset path normalizer", async () => {
  const converter = await readFile(new URL("PrefabToLksConverter.cs", root), "utf8");
  assert.match(converter, /NormalizeAssetPath\(sourceImage\.assetPath\s*\?\?\s*""\)/);
  assert.doesNotMatch(converter, /StripUnityPrefix/);
});

test("BridgeLogger JSON escaping covers every control character", async () => {
  const logger = await readFile(new URL("BridgeLogger.cs", root), "utf8");
  assert.match(logger, /character\s*<\s*0x20/);
  assert.match(logger, /Append\("\\\\u"\)/);
  assert.match(logger, /EscapeRawControlCharacters\(rawLine\.Trim\(\)\)/);
});
