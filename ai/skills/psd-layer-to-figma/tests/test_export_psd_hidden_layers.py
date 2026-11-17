import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_psd_layers.py"
SPEC = importlib.util.spec_from_file_location("export_psd_layers", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _layer(index, name, visible=True, section_type=None, size=8):
    """构造 _parse_layer_records 风格的图层记录；组记录尺寸为 0。"""
    return {
        "index": index,
        "layerId": index + 100,
        "name": name,
        "type": "raster",
        "x": 0,
        "y": 0,
        "width": size,
        "height": size,
        "opacity": 255,
        "visible": visible,
        "blend": "norm",
        "flags": 0 if visible else 2,
        "sectionType": section_type,
        "tags": [],
        "_tagPayloads": {},
        "channels": [],
    }


def _group(start_index, name, children, visible=True):
    """按 PSD 自底向上顺序生成组：结束分隔符、子图层、组起点。"""
    records = [_layer(start_index, "</Layer group>", section_type=3, size=0)]
    records.extend(children)
    records.append(_layer(start_index + len(children) + 1, name, visible=visible, section_type=1, size=0))
    return records


class PsdHiddenLayerTests(unittest.TestCase):
    def _export(self, layers, out_dir, include_hidden=False):
        canvas = {"width": 32, "height": 32, "channels": 4, "depth": 8,
                  "colorMode": 3, "layerCountRaw": len(layers)}
        source = out_dir.parent / "sample.psd"
        source.write_bytes(b"fixture")
        with mock.patch.object(MODULE, "_parse_layer_records", return_value=(canvas, [dict(layer) for layer in layers])), \
                mock.patch.object(MODULE, "_render_layer", side_effect=lambda data, layer: Image.new(
                    "RGBA", (layer["width"], layer["height"]), (layer["layerId"], 20, 30, 255))):
            return MODULE._write_layers(source, out_dir, composite_check=False, include_hidden=include_hidden)

    def test_hidden_layer_is_hidden(self):
        layers = [_layer(0, "Bg"), _layer(1, "Hidden", visible=False)]

        self.assertEqual(MODULE._effective_hidden_indices(layers), {1})

    def test_children_of_hidden_group_are_hidden_even_if_visible_themselves(self):
        layers = [_layer(0, "Bg")] + _group(1, "HiddenGroup", [_layer(2, "Child")], visible=False)

        self.assertEqual(MODULE._effective_hidden_indices(layers), {1, 2, 3})

    def test_nested_group_inherits_hidden_ancestor(self):
        inner = _group(2, "Inner", [_layer(3, "Deep")])
        layers = [_layer(0, "Bg")] + _group(1, "Outer", inner, visible=False)

        self.assertEqual(MODULE._effective_hidden_indices(layers), {1, 2, 3, 4, 5})

    def test_visible_group_keeps_visible_children_only(self):
        layers = _group(0, "Panel", [_layer(1, "Shown"), _layer(2, "Off", visible=False)])

        self.assertEqual(MODULE._effective_hidden_indices(layers), {2})

    def test_write_layers_skips_hidden_layers(self):
        layers = [_layer(0, "Bg"), _layer(1, "Hidden", visible=False)]
        layers += _group(2, "HiddenGroup", [_layer(3, "GroupChild")], visible=False)
        canvas = {"width": 32, "height": 32, "channels": 4, "depth": 8, "colorMode": 3, "layerCountRaw": len(layers)}
        original_parse = MODULE._parse_layer_records
        original_render = MODULE._render_layer
        MODULE._parse_layer_records = lambda data: (canvas, [dict(layer) for layer in layers])
        MODULE._render_layer = lambda data, layer: Image.new(
            "RGBA", (int(layer["width"]), int(layer["height"])), (255, 0, 0, 255)
        )
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                psd_path = Path(temp_dir) / "sample.psd"
                psd_path.write_bytes(b"")
                out_dir = Path(temp_dir) / "out"

                manifest = MODULE._write_layers(psd_path, out_dir, composite_check=False)

                self.assertEqual([layer["name"] for layer in manifest["layers"]], ["Bg"])
                self.assertEqual(manifest["layerCount"], 1)
                self.assertEqual(manifest["skippedHiddenLayerCount"], 2)
                self.assertEqual(sorted(path.name for path in out_dir.glob("*.png")), ["00_Bg.png"])
                saved = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(saved["skippedHiddenLayerCount"], 2)
        finally:
            MODULE._parse_layer_records = original_parse
            MODULE._render_layer = original_render

    def test_include_hidden_keeps_badge_identity_pixels_geometry_and_display_change(self):
        before = [_layer(0, "Bg"), _layer(1, "Badge")]
        after = [_layer(0, "Bg"), _layer(1, "Badge", visible=False)]
        after[1].update({"x": 7, "y": 9, "opacity": 128})
        before[1].update({"x": 7, "y": 9, "opacity": 128})
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            baseline = self._export(before, root / "before", include_hidden=True)
            incoming = self._export(after, root / "after", include_hidden=True)
            self.assertEqual([layer["layerId"] for layer in incoming["layers"]], [100, 101])
            self.assertEqual([layer["name"] for layer in incoming["layers"]], ["Bg", "Badge"])
            self.assertEqual(incoming["skippedHiddenLayerCount"], 0)
            badge = incoming["layers"][1]
            old_badge = baseline["layers"][1]
            self.assertFalse(badge["visible"])
            self.assertFalse(badge["sourceState"]["display"]["visible"])
            self.assertTrue(old_badge["sourceState"]["display"]["visible"])
            self.assertEqual(badge["sourceState"]["geometry"], old_badge["sourceState"]["geometry"])
            self.assertEqual(badge["sourceState"]["content"], old_badge["sourceState"]["content"])
            with Image.open(badge["path"]) as image:
                self.assertEqual(image.getpixel((2, 2)), (101, 20, 30, 255))
            summary = MODULE._generate_summary(incoming)
            self.assertFalse(summary["layers"][1]["visible"])
            self.assertFalse(summary["layers"][1]["sourceState"]["display"]["visible"])

    def test_include_hidden_writes_effective_visibility_for_hidden_ancestors(self):
        inner = _group(2, "Inner", [_layer(3, "Deep")])
        layers = [_layer(0, "Bg")] + _group(1, "Outer", inner, visible=False)
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = self._export(layers, Path(temp_dir) / "out", include_hidden=True)
            self.assertEqual([layer["name"] for layer in manifest["layers"]], ["Bg", "Deep"])
            self.assertEqual(manifest["skippedHiddenLayerCount"], 0)
            deep = manifest["layers"][1]
            self.assertEqual(deep["layerId"], 103)
            self.assertFalse(deep["visible"])
            self.assertFalse(deep["sourceState"]["display"]["visible"])

    def test_default_export_still_excludes_hidden_source_records(self):
        layers = [_layer(0, "Bg"), _layer(1, "Badge", visible=False)]
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = self._export(layers, Path(temp_dir) / "out")
            self.assertEqual([layer["name"] for layer in manifest["layers"]], ["Bg"])
            self.assertEqual(manifest["skippedHiddenLayerCount"], 1)

    def test_include_hidden_cli_flag_reaches_summary_source_state(self):
        layers = [_layer(0, "Bg"), _layer(1, "Badge", visible=False)]
        canvas = {"width": 32, "height": 32, "channels": 4, "depth": 8,
                  "colorMode": 3, "layerCountRaw": len(layers)}
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "sample.psd"
            source.write_bytes(b"fixture")
            out_dir = Path(temp_dir) / "out"
            with mock.patch("sys.argv", [str(SCRIPT), str(source), "--out", str(out_dir), "--summary", "--include-hidden"]), \
                    mock.patch.object(MODULE, "_parse_layer_records", return_value=(canvas, layers)), \
                    mock.patch.object(MODULE, "_render_layer", return_value=Image.new("RGBA", (8, 8), (0, 255, 0, 255))), \
                    mock.patch("builtins.print"):
                self.assertEqual(MODULE.main(), 0)
            summary = json.loads((out_dir / "manifest_summary.json").read_text(encoding="utf-8"))
            self.assertEqual([layer["layerId"] for layer in summary["layers"]], [100, 101])
            self.assertFalse(summary["layers"][1]["sourceState"]["display"]["visible"])


if __name__ == "__main__":
    unittest.main()
