"""photoshop_render_units.build_manifest 的离线测试：用假 Photoshop 结果验证清单生成规则。"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import photoshop_render_units as renderer  # noqa: E402


def _text_layer(layer_id: int) -> dict:
    return {"idx": 7, "name": "Hello", "mode": "text", "layerId": layer_id, "chars": "Hello",
            "x": 120, "y": 40, "w": 80, "h": 30, "constraints": {"horizontal": "CENTER", "vertical": "MIN"}}


class BuildManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.base = self.tmp / "base_manifest.json"
        self.base.write_text(json.dumps({"layers": [_text_layer(30)]}), encoding="utf-8")
        canvas = (300, 100)
        # 单元 0：画板外也有像素，必须按画板 [100,0,200,100] 裁掉。
        unit0 = Image.new("RGBA", canvas, (0, 0, 0, 0))
        unit0.paste((255, 0, 0, 255), (90, 10, 150, 20))
        unit0.save(self.tmp / "u_0.png")
        # 单元 2：完全透明，应被跳过。
        Image.new("RGBA", canvas, (0, 0, 0, 0)).save(self.tmp / "u_2.png")
        self.ps_result = {
            "canvas": {"width": 300, "height": 100},
            "reference": str(self.tmp / "reference.png"),
            "errors": [],
            "units": [
                {"order": 0, "kind": "image", "layerId": 10, "name": "bubble", "path": ["画板", "bubble"],
                 "clip": [100, 0, 200, 100], "blend": "multiply", "layerIds": [10],
                 "file": str(self.tmp / "u_0.png"), "rect": [0, 0, 300, 100]},
                {"order": 1, "kind": "text", "layerId": 30, "name": "Hello", "path": ["Hello"],
                 "clip": None, "blend": "normal", "layerIds": [30]},
                {"order": 2, "kind": "image", "layerId": 20, "name": "empty", "path": ["empty"],
                 "clip": None, "blend": "normal", "layerIds": [20],
                 "file": str(self.tmp / "u_2.png"), "rect": [0, 0, 300, 100]},
            ],
        }

    def build(self) -> dict:
        with mock.patch.object(renderer, "_run_photoshop", return_value=self.ps_result),                 mock.patch.object(renderer, "_psd_font_runs", return_value={}):
            return renderer.build_manifest(self.tmp / "a.psd", self.tmp / "out", self.base)

    def test_image_unit_is_clipped_to_artboard_and_trimmed(self) -> None:
        layer = self.build()["layers"][0]
        self.assertEqual((layer["x"], layer["y"], layer["w"], layer["h"]), (100, 10, 50, 10))
        with Image.open(layer["path"]) as image:
            self.assertEqual(image.size, (50, 10))

    def test_rendered_pixels_carry_opacity_so_node_state_is_neutral(self) -> None:
        layer = self.build()["layers"][0]
        display = layer["sourceState"]["display"]
        self.assertEqual(display["opacity"], 1.0)
        self.assertEqual(display["blendMode"], "MULTIPLY")
        self.assertEqual(layer["renderSource"], "photoshop")

    def test_text_units_reuse_native_text_entries_in_photoshop_order(self) -> None:
        manifest = self.build()
        self.assertEqual([l["mode"] for l in manifest["layers"]], ["image", "text"])
        self.assertEqual([l["idx"] for l in manifest["layers"]], [1, 2])
        self.assertEqual(manifest["layers"][1]["chars"], "Hello")
        self.assertEqual(manifest["layers"][1]["textRole"], "ordinary")
        self.assertEqual(manifest["textCount"], 1)

    def test_empty_units_are_skipped_and_reference_is_reported(self) -> None:
        manifest = self.build()
        self.assertEqual(manifest["imageCount"], 1)
        self.assertEqual(manifest["referencePath"], self.ps_result["reference"])
        self.assertTrue((self.tmp / "out" / "manifest_summary.json").exists())


class PhotoshopRenderSessionTest(unittest.TestCase):
    """渲染与导入归属协调：已有应用不重启，延迟会话由 Figma 导入 finally 清理。"""

    def _fake_app(self, documents: int, outcomes: list) -> mock.Mock:
        app = mock.Mock()
        app.Documents.Count = documents

        def run(path):
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            Path(path).with_name("ps_units.json").write_text('{"units": []}', encoding="utf-8")
            return "ok"

        app.DoJavaScriptFile.side_effect = run
        return app

    def _run(self, app: mock.Mock, deferred=False):
        tmp = Path(tempfile.mkdtemp())
        session = mock.Mock()
        session.acquire.return_value = app
        session.release.return_value = {"startedByImport": False, "action": "kept"}
        receipt = tmp / "session.json" if deferred else None
        with mock.patch.object(renderer, "PhotoshopSession", return_value=session):
            result = renderer._run_photoshop(tmp / "a.psd", tmp, session_receipt=receipt)
        return result, session

    def test_successful_deferred_session_stays_alive_for_figma_import(self) -> None:
        result, session = self._run(self._fake_app(0, ["ok"]), deferred=True)
        self.assertEqual(result, {"units": []})
        session.acquire.assert_called_once()
        session.release.assert_not_called()

    def test_direct_render_without_receipt_releases_after_render(self) -> None:
        result, session = self._run(self._fake_app(0, ["ok"]))
        self.assertEqual(result, {"units": []})
        session.release.assert_called_once()

    def test_preexisting_photoshop_is_never_restarted_after_render_error(self) -> None:
        app = self._fake_app(1, [RuntimeError("I/O error")])
        with self.assertRaisesRegex(RuntimeError, "I/O error"):
            self._run(app)
        app.Quit.assert_not_called()
        self.assertEqual(app.DoJavaScriptFile.call_count, 1)

    def test_failed_deferred_render_leaves_cleanup_to_bounded_external_process(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        session = mock.Mock()
        session.acquire.return_value = self._fake_app(0, [RuntimeError("render failed")])
        session.release.return_value = {"startedByImport": True, "action": "closed"}
        with mock.patch.object(renderer, "PhotoshopSession", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "render failed"):
                renderer._run_photoshop(tmp / "a.psd", tmp, session_receipt=tmp / "session.json")
        session.release.assert_not_called()

    def test_failed_deferred_acquire_does_not_release_on_renderer_finally(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        session = mock.Mock()
        session.acquire.side_effect = RuntimeError("COM startup failed")
        with mock.patch.object(renderer, "PhotoshopSession", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "COM startup failed"):
                renderer._run_photoshop(tmp / "a.psd", tmp, session_receipt=tmp / "session.json")
        session.release.assert_not_called()


class FontRunsTest(unittest.TestCase):
    """PSD 字体分段 -> 插件 fontRuns 的换算规则。"""

    RUNS = [
        {"start": 0, "end": 10, "postscript": "GROBOLD", "text": "44 FFFFFF "},
        {"start": 10, "end": 15, "postscript": "AdobeHeitiStd-Regular", "text": "描边4 0\r"},
    ]
    FONTS = {"grobold": {"family": "GROBOLD", "style": "Regular"},
             "adobeheitistd-regular": {"family": "Adobe Heiti Std", "style": "R"}}

    def test_runs_map_postscript_names_and_add_cjk_fallback(self) -> None:
        entry, warnings = {"name": "t", "chars": "44 FFFFFF 描边4 0"}, []
        renderer._attach_font_runs(entry, self.RUNS, self.FONTS, warnings)
        self.assertEqual(warnings, [])
        self.assertEqual([(r["start"], r["end"]) for r in entry["fontRuns"]], [(0, 10), (10, 15)])
        self.assertEqual(entry["fontRuns"][0]["fontFallback"], [{"family": "GROBOLD", "style": "Regular"}])
        families = [f["family"] for f in entry["fontRuns"][1]["fontFallback"]]
        self.assertEqual(families, ["Adobe Heiti Std", "Noto Sans SC", "SimHei"])

    def test_text_mismatch_skips_runs_with_warning(self) -> None:
        entry, warnings = {"name": "t", "chars": "different"}, []
        renderer._attach_font_runs(entry, self.RUNS, self.FONTS, warnings)
        self.assertNotIn("fontRuns", entry)
        self.assertEqual(len(warnings), 1)

    def test_uninstalled_latin_font_keeps_layer_font(self) -> None:
        entry, warnings = {"name": "t", "chars": "44 FFFFFF 描边4 0"}, []
        renderer._attach_font_runs(entry, self.RUNS, {}, warnings)
        self.assertEqual([r["start"] for r in entry["fontRuns"]], [10])
        self.assertEqual(len(warnings), 1)


class ImportCompatibilityTest(unittest.TestCase):
    def test_pure_helpers_import_without_windows_com_modules_in_isolated_python(self):
        code = """
import builtins
import sys
sys.path.insert(0, sys.argv[1])
original_import = builtins.__import__
def without_windows(name, *args, **kwargs):
    if name == 'winreg' or name.startswith('win32'):
        raise ImportError('Windows COM modules are unavailable')
    return original_import(name, *args, **kwargs)
builtins.__import__ = without_windows
import photoshop_render_units
print('pure helpers imported')
"""
        result = subprocess.run([sys.executable, "-I", "-c", code, str(SCRIPTS)],
                                 capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "pure helpers imported")

if __name__ == "__main__":
    unittest.main()
