import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

const submitSource = fs.readFileSync(
  new URL("../ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py", import.meta.url),
  "utf8",
);

test("PSD submit accepts the current manifest index field when building asset ids", () => {
  assert.match(submitSource, /idx = str\(layer\.get\("idx", layer\.get\("index", 0\)\)\)/);
});

test("PSD submit preserves distinct asset ids from manifest index values", () => {
  const output = execFileSync("python", ["-c", `
import importlib.util
from pathlib import Path

script_path = Path.cwd() / "ai" / "skills" / "psd-layer-to-figma" / "scripts" / "submit_psd_import_job.py"
spec = importlib.util.spec_from_file_location("submit_psd_import_job_under_test", script_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.os.path.exists = lambda path: True
assets, asset_paths = module.build_assets("C:/layers", [
    {"index": 1, "path": "01_background.png"},
    {"index": 3, "path": "03_badge.png"},
])
assert [asset["id"] for asset in assets] == ["1", "3"]
assert sorted(asset_paths) == ["1", "3"]
print("ok")
`], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(output.trim(), "ok");
});
