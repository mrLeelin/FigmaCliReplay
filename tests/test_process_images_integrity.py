import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "ai" / "skills" / "figma-to-prefab" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import auto_componentset_specs as componentsets
import gen_spec
import process_images


class ProcessImagesIntegrityTests(unittest.TestCase):
    @staticmethod
    def fixture(size=(11, 10), duplicate=False):
        output = io.BytesIO()
        Image.new("RGBA", size, (20, 40, 60, 128)).save(output, "PNG")
        raw = output.getvalue()
        nodes = [
            {"id": "1:1", "name": "Screen", "type": "FRAME", "childIds": ["1:2"],
             "bounds": {"x": 0, "y": 0, "width": 10, "height": 10}},
            {"id": "1:2", "name": "MonthlyCard_01", "type": "RECTANGLE", "childIds": [],
             "bounds": {"x": 0, "y": 0, "width": 10, "height": 10}, "fills": [{"type": "IMAGE"}]},
        ]
        export = {"id": "img_1", "nodeId": "1:2", "width": 10, "height": 10,
                  "base64": base64.b64encode(raw).decode("ascii"), "imageHash": "source-hash"}
        exports = [export]
        if duplicate:
            exports = [{**export, "id": "source", "nodeId": "other:1"},
                       {k: v for k, v in export.items() if k != "base64"}]
            exports[1]["duplicateOf"] = "source"
        return nodes, exports, raw

    @staticmethod
    def cropped_bytes(raw):
        output = io.BytesIO()
        with Image.open(io.BytesIO(raw)) as image:
            image.crop((0, 0, 10, 10)).save(output, "PNG")
        return output.getvalue()

    def run_pipeline(self, *, size=(11, 10), duplicate=False, descendant=False, expected_error=""):
        temporary = tempfile.TemporaryDirectory(prefix="process-images-integrity-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "Assets").mkdir()
        (root / "ProjectSettings").mkdir()
        manifest = root / "manifest"
        manifest.mkdir()
        nodes, exports, raw = self.fixture(size, duplicate)
        if descendant:
            nodes[1].update(type="INSTANCE", childIds=["1:3"])
            nodes.append({**nodes[1], "id": "1:3", "name": "Source", "type": "RECTANGLE", "childIds": []})
            exports[0]["nodeId"] = "1:3"
        (manifest / "figma_node_manifest.json").write_text(json.dumps({
            "rootNodeId": "1:1", "rootBounds": nodes[0]["bounds"], "nodes": nodes,
        }), encoding="utf-8")
        (manifest / "image_export_manifest.json").write_text(json.dumps({"exports": exports}), encoding="utf-8")
        with patch.object(gen_spec, "UNITY_PROJECT", root), \
             patch.object(gen_spec, "scan_common_prefabs", return_value={}):
            _, plan, _ = gen_spec.build_spec(
                manifest, "Assets/Export/Prefab/Screen.prefab", "Assets/Export/Texture/", "Screen", {},
                disable_common_texture_reuse=True, disable_common_prefab_reuse=True,
            )
        plan_path = root / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        result = subprocess.run([
            sys.executable, str(SCRIPTS / "process_images.py"), "--unity-project", str(root),
            "--manifest-dir", str(manifest), "--download-plan", str(plan_path),
            "--output-dir", "Assets/Export/Texture", "--output-report", str(root / "report.json"),
        ], capture_output=True, text=True, encoding="utf-8", timeout=10,
            env={**os.environ, "PYTHONUTF8": "1", "FIGMA_RELAY_OPERATION_ID": "image-integrity-test"})
        report = json.loads((root / "report.json").read_text(encoding="utf-8"))
        events = [json.loads(line.removeprefix("FIGMA_RELAY_LOG "))
                  for line in result.stderr.splitlines() if line.startswith("FIGMA_RELAY_LOG ")]
        validation_events = [event for event in events if event["operationName"] == "images.validate-download-plan"]
        terminal = "failed" if expected_error else "succeeded"
        self.assertEqual([event["status"] for event in validation_events], ["started", "progress", terminal])
        self.assertTrue(all(event["operationId"] == "image-integrity-test" for event in events))
        self.assertNotIn("FIGMA_RELAY_LOG", result.stdout)
        if expected_error:
            self.assertEqual(result.returncode, 2)
            self.assertFalse(report["allPass"])
            self.assertIn(expected_error, [error["code"] for error in report["blockingErrors"]])
            return root, plan_path, plan["images"][0], raw, result
        self.assertEqual(result.returncode, 0, report.get("blockingErrors", result.stderr))
        self.assertTrue(report["allPass"], report.get("blockingErrors"))
        return root, plan_path, plan["images"][0], raw, result

    def test_oversized_png_plan_matches_final_cropped_file(self):
        root, _, item, raw, _ = self.run_pipeline()
        expected = self.cropped_bytes(raw)
        target = root / item["targetAssetPath"]
        self.assertEqual(target.read_bytes(), expected)
        self.assertEqual(item["expectedMD5"], hashlib.md5(expected).hexdigest())

    def test_exact_size_png_preserves_original_bytes(self):
        root, _, item, raw, _ = self.run_pipeline(size=(10, 10))
        self.assertEqual((root / item["targetAssetPath"]).read_bytes(), raw)
        self.assertEqual(item["expectedMD5"], hashlib.md5(raw).hexdigest())

    def test_duplicate_source_uses_final_cropped_hash(self):
        root, _, item, raw, _ = self.run_pipeline(duplicate=True)
        expected = self.cropped_bytes(raw)
        self.assertEqual((root / item["targetAssetPath"]).read_bytes(), expected)

    def test_resolved_child_uses_same_crop_and_hash_as_its_plan(self):
        root, _, item, raw, _ = self.run_pipeline(descendant=True)
        expected = self.cropped_bytes(raw)
        self.assertEqual((root / item["targetAssetPath"]).read_bytes(), expected)
        self.assertEqual(item["expectedMD5"], hashlib.md5(expected).hexdigest())

    def test_same_size_corruption_still_fails_md5_validation(self):
        root, plan_path, item, _, _ = self.run_pipeline()
        Image.new("RGBA", (10, 10), (255, 0, 0, 255)).save(root / item["targetAssetPath"], "PNG")
        diagnostics = io.StringIO()
        with patch.object(process_images, "UNITY_PROJECT_ROOT", root), \
             patch.dict(os.environ, {"FIGMA_RELAY_OPERATION_ID": "corrupt-image-test"}), \
             contextlib.redirect_stderr(diagnostics):
            report = process_images.validate_download_plan(plan_path)
        self.assertEqual(report["sizeMismatch"], [])
        self.assertEqual(len(report["md5Mismatch"]), 1)
        self.assertEqual(report["md5Mismatch"][0]["expectedMD5"], item["expectedMD5"])
        events = [json.loads(line.removeprefix("FIGMA_RELAY_LOG ")) for line in diagnostics.getvalue().splitlines()]
        self.assertEqual([event["status"] for event in events], ["started", "progress", "failed"])
        self.assertEqual(events[-1]["data"]["md5Mismatch"], 1)
        self.assertTrue(all(event["operationId"] == "corrupt-image-test" for event in events))

    def test_undersized_source_is_rejected_without_padding(self):
        root, _, item, raw, _ = self.run_pipeline(size=(9, 10), expected_error="downloadPlanSizeMismatch")
        self.assertEqual((root / item["targetAssetPath"]).read_bytes(), raw)

    def test_componentset_plan_uses_final_cropped_hash(self):
        nodes, exports, raw = self.fixture()
        nodes[0].update(type="INSTANCE", component={"componentSetName": "CardSwitch"})
        builder = componentsets.ComponentSetSpecBuilder(nodes, exports, "Assets/Export/Texture/")
        _, images = builder.build_component_spec("CardSwitch", [nodes[0]], "Assets/Export/Prefab/CardSwitch.prefab")
        self.assertEqual(images[0]["expectedMD5"], hashlib.md5(self.cropped_bytes(raw)).hexdigest())


if __name__ == "__main__":
    unittest.main()
