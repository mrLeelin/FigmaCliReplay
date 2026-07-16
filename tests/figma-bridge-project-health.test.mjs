import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs", import.meta.url), "utf8");
const discoveryPath = new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeGatewayDiscovery.cs", import.meta.url);

test("Unity bridge health reports the actual project name and path", () => {
  assert.doesNotMatch(source, /projectName\\\":\\\"JellybeanUnity/);
  assert.match(source, /projectName/);
  assert.match(source, /projectPath/);
  assert.match(source, /Path\.GetDirectoryName\(Application\.dataPath\)/);
});

test("Unity bridge publishes and safely removes its actual gateway record", () => {
  assert.equal(fs.existsSync(discoveryPath), true, "gateway discovery helper should ship with the bridge");
  const discovery = fs.readFileSync(discoveryPath, "utf8");
  assert.match(discovery, /Library[\s\S]*FigmaBridge[\s\S]*gateways/);
  assert.match(discovery, /Process\.GetCurrentProcess\(\)\.Id \+ "\.json"/);
  assert.match(discovery, /processId/);
  assert.match(discovery, /updatedAtUtc/);
  assert.match(discovery, /File\.Move\(temporaryPath, ownedDiscoveryPath\)/);
  assert.match(discovery, /finally\s*\{\s*TryDeleteFile\(temporaryPath\)/);
  assert.match(discovery, /internal static void RemoveOwned\(string gatewayUrl\)[\s\S]*TryDeleteFile\(OwnedDiscoveryPath\)/);
  assert.doesNotMatch(discovery, /File\.Delete\(DiscoveryPath\)/);
  assert.match(source, /FigmaBridgeGatewayDiscovery\.Publish\(CurrentGatewayUrl\)/);
  const removeIndex = source.indexOf("FigmaBridgeGatewayDiscovery.RemoveOwned(CurrentGatewayUrl)");
  const clearPortIndex = source.indexOf("_currentPort = 0", source.indexOf("public static void Stop()"));
  assert.ok(removeIndex >= 0 && removeIndex < clearPortIndex, "owned discovery must be removed before clearing the active port");
});
