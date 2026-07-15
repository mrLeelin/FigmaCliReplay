import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs", import.meta.url), "utf8");

test("Unity bridge health reports the actual project name and path", () => {
  assert.doesNotMatch(source, /projectName\\\":\\\"JellybeanUnity/);
  assert.match(source, /projectName/);
  assert.match(source, /projectPath/);
  assert.match(source, /Path\.GetDirectoryName\(Application\.dataPath\)/);
});
