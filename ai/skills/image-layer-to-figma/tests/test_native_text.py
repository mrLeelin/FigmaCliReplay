"""Behavioral coverage for reviewed screenshot text and the import boundary."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "client"))
from native_text import NativeTextError, prepare_native_text, validate_native_text

SUBMIT_PATH = ROOT / "ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py"
SPEC = importlib.util.spec_from_file_location("submit_native_text_under_test", SUBMIT_PATH)
SUBMIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUBMIT)
CLI = ROOT / "ai/skills/image-layer-to-figma/scripts/prepare_native_text.py"


class NativeTextTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "输入 resources"
        self.source.mkdir()
        self.manifest = self.source / "manifest.json"
        self.plan = self.root / "plan.json"
        self.output = self.root / "prepared"
        # File bytes are deliberately opaque to this compiler: it must not redraw them.
        (self.source / "background.png").write_bytes(b"original raster bytes\x00\xff")
        (self.source / "quantity.png").write_bytes(b"original quantity reference")
        (self.source / "title.png").write_bytes(b"artistic lettering original")
        self.layers = [
            {"idx": 0, "name": "background", "path": "background.png", "mode": "image",
             "x": 0, "y": 0, "w": 500, "h": 900},
            {"idx": 7, "layerId": "resource:quantity", "name": "reward", "path": "quantity.png",
             "mode": "image", "x": 10.125, "y": 20.375, "w": 55.02, "h": 24.91,
             "opacity": 0.8, "visible": True, "constraints": {"horizontal": "MAX", "vertical": "MIN"}},
            {"idx": 12, "name": "art title", "path": "title.png", "mode": "image",
             "x": 5, "y": 5, "w": 120, "h": 80},
        ]
        self.entries = [
            {"sourceIdx": 7, "classification": "ordinary", "characters": "×50",
             "font": {"family": "Arial", "style": "Bold"}, "fontSize": 28,
             "fillColor": "#060605", "stroke": {"color": "#F0F3F6", "size": 1}},
            {"sourceIdx": 12, "classification": "decorative", "reason": "Custom sculpted lettering"},
        ]

    def write_inputs(self):
        self.manifest.write_text(json.dumps({"canvas": {"width": 500, "height": 900},
                                             "layers": self.layers}, ensure_ascii=False), encoding="utf-8")
        self.plan.write_text(json.dumps({"schemaVersion": 1, "layers": self.entries},
                                       ensure_ascii=False), encoding="utf-8")

    def prepare(self):
        self.write_inputs()
        report = prepare_native_text(self.manifest, self.plan, self.output)
        return report, json.loads((self.output / "manifest.json").read_text(encoding="utf-8"))

    def test_mixed_delivery_preserves_unicode_geometry_and_original_raster_bytes(self):
        self.write_inputs()
        original_manifest = self.manifest.read_bytes()
        report = prepare_native_text(self.manifest, self.plan, self.output)
        result = json.loads((self.output / "manifest.json").read_text(encoding="utf-8"))
        background, text, art = result["layers"]
        self.assertEqual([l["idx"] for l in result["layers"]], [0, 7, 12])
        self.assertEqual(text["mode"], "text")
        self.assertEqual(text["semanticMode"], "text")
        self.assertEqual(text["chars"], "×50")
        self.assertEqual(text["text"]["characters"], "×50")
        self.assertEqual(text["text"]["figma"]["fontFallbackCandidates"], [{"family": "Arial", "style": "Bold"}])
        self.assertNotIn("path", text)
        self.assertTrue(text["rasterReference"]["referenceOnly"])
        for key in ("x", "y", "w", "h", "opacity", "visible", "constraints", "layerId"):
            self.assertEqual(text[key], self.layers[1][key])
        self.assertAlmostEqual(text["fillColor"]["r"], 6 / 255)
        self.assertAlmostEqual(text["stroke"]["r"], 240 / 255)
        self.assertEqual(art["textRole"], "decorative")
        self.assertEqual((self.output / background["path"]).read_bytes(), (self.source / "background.png").read_bytes())
        self.assertEqual((self.output / art["path"]).read_bytes(), (self.source / "title.png").read_bytes())
        self.assertEqual(self.manifest.read_bytes(), original_manifest)
        self.assertEqual((report["nativeTextCount"], report["decorativeRasterTextCount"], report["figmaWrites"]), (1, 1, 0))
        self.assertTrue(report["liveVerificationRequired"])

    def test_native_import_needs_no_png_and_cannot_pick_up_accidental_index_png(self):
        _, manifest = self.prepare()
        manifest["__source_path"] = str(self.output / "manifest.json")
        (self.output / "7.png").write_bytes(b"unrelated file, not a text fallback")
        payload = SUBMIT.build_payload(manifest, "test", "", "")
        self.assertEqual([asset["id"] for asset in payload["job"]["assets"]], ["0", "12"])
        self.assertNotIn("7", payload["assetPaths"])
        self.assertEqual(payload["job"]["manifest"]["layers"][1]["chars"], "×50")

    def test_unprepared_ordinary_bitmap_is_blocked_before_assets_or_relay(self):
        self.layers[1]["textRole"] = "ordinary"
        self.write_inputs()
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        with patch.object(SUBMIT, "build_assets", side_effect=AssertionError("asset registration must not happen")):
            with self.assertRaisesRegex(NativeTextError, "ordinary text must use mode=text"):
                SUBMIT.build_payload(manifest, "test", "", "")

    def test_partial_text_metadata_is_not_guessed(self):
        for field in ("characters", "font", "fontSize", "fillColor"):
            with self.subTest(field=field):
                entry = deepcopy(self.entries[0])
                entry.pop(field)
                original = self.entries
                self.entries = [entry]
                self.write_inputs()
                with self.assertRaises(NativeTextError):
                    prepare_native_text(self.manifest, self.plan, self.output)
                self.assertFalse(self.output.exists())
                self.entries = original

    def test_mixed_art_and_text_must_be_separated_before_conversion(self):
        self.entries[0]["classification"] = "mixed"
        self.write_inputs()
        with self.assertRaisesRegex(NativeTextError, "separate ordinary text"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.assertFalse(self.output.exists())

    def test_decorative_exception_requires_a_reason(self):
        self.entries[1].pop("reason")
        self.write_inputs()
        with self.assertRaisesRegex(NativeTextError, "reason"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.assertFalse(self.output.exists())

    def test_invalid_geometry_and_duplicate_ownership_fail_before_any_output(self):
        variants = [
            [self.entries[0], deepcopy(self.entries[0])],
            [{**self.entries[0], "sourceIdx": 999}],
            [{**self.entries[0], "sourceIdx": True}],
            [{**self.entries[0], "bounds": {"x": 0, "y": float("nan"), "w": 55, "h": 25}}],
        ]
        for entries in variants:
            with self.subTest(entries=entries):
                self.entries = entries
                self.write_inputs()
                with self.assertRaises(NativeTextError):
                    prepare_native_text(self.manifest, self.plan, self.output)
                self.assertFalse(self.output.exists())

    def test_existing_output_cannot_be_overwritten(self):
        self.prepare()
        result = (self.output / "manifest.json").read_bytes()
        with self.assertRaisesRegex(NativeTextError, "absent or empty"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.assertEqual((self.output / "manifest.json").read_bytes(), result)

    def test_missing_raster_asset_blocks_before_output(self):
        (self.source / "background.png").unlink()
        self.write_inputs()
        with self.assertRaisesRegex(NativeTextError, "raster resource does not exist"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.assertFalse(self.output.exists())

    def test_unmarked_names_do_not_trigger_semantic_guesses(self):
        self.entries = []
        self.layers[0]["name"] = "text_quantity_50"
        report, manifest = self.prepare()
        self.assertEqual(report["nativeTextCount"], 0)
        self.assertEqual(manifest["layers"][0]["mode"], "image")

    def test_cli_runs_offline_from_an_unrelated_working_directory(self):
        self.write_inputs()
        result = subprocess.run([sys.executable, "-X", "utf8", str(CLI), "--manifest", str(self.manifest),
                                 "--plan", str(self.plan), "--out-dir", str(self.output)],
                                cwd=self.root, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["nativeTextCount"], 1)
        manifest = json.loads((self.output / "manifest.json").read_text(encoding="utf-8"))
        # Verify the actual CLI artifact can be consumed by the ordinary importer.
        manifest["__source_path"] = str(self.output / "manifest.json")
        self.assertEqual(SUBMIT.build_payload(manifest, "test", "", "")["job"]["type"], "IMPORT_PSD_JOB")

    def test_nested_native_text_schema_is_validated(self):
        _, manifest = self.prepare()
        text = manifest["layers"][1]
        for key in ("chars", "fontSize", "effectiveFontSize", "fontFallback", "fillColor", "stroke"):
            text.pop(key)
        self.assertEqual(validate_native_text(manifest)["nativeTextCount"], 1)

    def test_nested_invalid_stroke_is_blocked_before_import(self):
        _, manifest = self.prepare()
        text = manifest["layers"][1]
        text.pop("stroke")
        for stroke in (
            {"enabled": True, "size": -3, "color": {"r": 0.2, "g": 0, "b": 0}},
            {"enabled": True, "size": 1, "color": {"r": 255, "g": 0, "b": 0}},
        ):
            with self.subTest(stroke=stroke):
                text["text"]["effects"]["stroke"] = stroke
                with self.assertRaisesRegex(NativeTextError, "stroke"):
                    SUBMIT.build_payload(manifest, "test", "", "")

    def test_font_validation_checks_the_candidates_the_runtime_will_load(self):
        _, manifest = self.prepare()
        text = manifest["layers"][1]
        text.pop("fontFallback")
        text["text"]["fontFallback"] = [{"family": "", "style": ""}]
        self.assertEqual(validate_native_text(manifest)["nativeTextCount"], 1)
        text["text"]["fontFallback"] = [{"family": "Arial", "style": "Bold"}]
        text["text"]["figma"]["fontFallbackCandidates"] = [{"family": "", "style": ""}]
        with self.assertRaisesRegex(NativeTextError, "font.family"):
            SUBMIT.build_payload(manifest, "test", "", "")


class ComposedResourceIdxTests(unittest.TestCase):
    """compose_resources.py renumbers layers; text plans must not silently hit the wrong resource."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.composed = self.root / "composed"
        self.composed.mkdir()
        self.manifest = self.composed / "manifest.json"
        self.plan = self.root / "plan.json"
        self.output = self.root / "prepared"
        for name in ("resource-000.png", "resource-001.png", "resource-002.png"):
            (self.composed / name).write_bytes(name.encode())
        # Output idx 1 is the SPIN label (source 9); output idx 2 is a panel merged from sources 1 and 2.
        self.manifest.write_text(json.dumps({"canvas": {"width": 100, "height": 200}, "layers": [
            {"idx": 0, "name": "background", "path": "resource-000.png", "mode": "image", "x": 0, "y": 0, "w": 100, "h": 200},
            {"idx": 1, "name": "spin label", "path": "resource-001.png", "mode": "image", "x": 10, "y": 150, "w": 40, "h": 20},
            {"idx": 2, "name": "bottom panel", "path": "resource-002.png", "mode": "image", "x": 0, "y": 160, "w": 100, "h": 40},
        ]}), encoding="utf-8")
        (self.composed / "resource-map.json").write_text(json.dumps({"resources": [
            {"id": "r00", "outputIdx": 0, "sourceMembersInStackingOrder": [0]},
            {"id": "r01", "outputIdx": 1, "sourceMembersInStackingOrder": [9]},
            {"id": "r02", "outputIdx": 2, "sourceMembersInStackingOrder": [1, 2]},
        ]}), encoding="utf-8")

    def write_plan(self, source_idx, idx_space="__unset__"):
        plan = {"schemaVersion": 1, "layers": [
            {"sourceIdx": source_idx, "classification": "ordinary", "characters": "SPIN",
             "font": {"family": "Chewy", "style": "Regular"}, "fontSize": 30, "fillColor": "#FFFFFF"}]}
        if idx_space != "__unset__":
            plan["idxSpace"] = idx_space
        self.plan.write_text(json.dumps(plan), encoding="utf-8")

    def test_composed_manifest_requires_an_explicit_idx_space(self):
        self.write_plan(2)
        with self.assertRaisesRegex(NativeTextError, "declare plan.idxSpace"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.assertFalse(self.output.exists())

    def test_source_idx_is_translated_through_resource_map(self):
        self.write_plan(9, "source")
        report = prepare_native_text(self.manifest, self.plan, self.output)
        layers = json.loads((self.output / "manifest.json").read_text(encoding="utf-8"))["layers"]
        self.assertEqual([layer["mode"] for layer in layers], ["image", "text", "image"])
        self.assertEqual(layers[1]["chars"], "SPIN")
        self.assertEqual(layers[2]["name"], "bottom panel", "the panel keeps its artwork")
        self.assertEqual(report["textMappings"][0]["sourceIdx"], 1)
        self.assertEqual(report["textMappings"][0]["planSourceIdx"], 9)
        self.assertEqual(report["idxSpace"], "source")
        self.assertTrue(report["resourceMap"].endswith("resource-map.json"))

    def test_output_idx_space_uses_composed_numbers_directly(self):
        self.write_plan(1, "output")
        report = prepare_native_text(self.manifest, self.plan, self.output)
        self.assertEqual(report["textMappings"][0]["sourceIdx"], 1)
        self.assertNotIn("planSourceIdx", report["textMappings"][0])

    def test_source_text_merged_with_artwork_is_rejected(self):
        self.write_plan(2, "source")
        with self.assertRaisesRegex(NativeTextError, "merged into resource 'r02'"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.assertFalse(self.output.exists())

    def test_unknown_source_idx_and_invalid_space_are_rejected(self):
        self.write_plan(7, "source")
        with self.assertRaisesRegex(NativeTextError, "not a source member"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.write_plan(1, "dxx")
        with self.assertRaisesRegex(NativeTextError, "idxSpace must be"):
            prepare_native_text(self.manifest, self.plan, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
