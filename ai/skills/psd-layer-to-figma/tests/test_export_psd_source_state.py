import importlib.util
import math
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_psd_layers.py"
SPEC = importlib.util.spec_from_file_location("export_psd_layers", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PsdSourceStateTests(unittest.TestCase):
    def test_source_state_contains_geometry_display_text_and_content(self):
        angle = math.radians(15)
        layer = {
            "layerId": 406,
            "x": 580,
            "y": 1514,
            "width": 363,
            "height": 140,
            "opacity": 128,
            "visible": False,
            "blend": "mul ",
        }
        text = {
            "characters": "Play",
            "fontFamily": "Arial",
            "fontSize": 30,
            "effectiveFontSize": 36,
            "leading": 42,
            "lineHeightMode": "PIXELS",
            "textAlignHorizontal": "CENTER",
            "fillColor": {"r": 1, "g": 0.5, "b": 0.25, "a": 1},
            "textTransform": {
                "matrix": [
                    math.cos(angle),
                    -math.sin(angle),
                    math.sin(angle),
                    math.cos(angle),
                    0,
                    0,
                ]
            },
            "effects": {"stroke": None, "dropShadow": None},
            "figma": {"fontFallbackCandidates": [{"family": "Arial", "style": "Regular"}]},
        }

        state = MODULE._build_psd_source_state(
            layer=layer,
            mode="text",
            content_hash="hash-406",
            constraints={"horizontal": "CENTER", "vertical": "MAX"},
            text_info=text,
            nine_slice_info=None,
        )

        self.assertEqual(state["version"], 3)
        self.assertEqual(state["layerId"], "406")
        self.assertEqual(
            state["geometry"],
            {"x": 580.0, "y": 1514.0, "width": 363.0, "height": 140.0, "rotation": 15.0},
        )
        self.assertAlmostEqual(state["display"]["opacity"], 128 / 255)
        self.assertEqual(state["display"]["blendMode"], "MULTIPLY")
        self.assertEqual(state["text"]["characters"], "Play")
        self.assertEqual(state["content"]["contentHash"], "hash-406")
        self.assertEqual(state["unsupported"], [])

    def test_unknown_blend_is_explicitly_unsupported(self):
        state = MODULE._build_psd_source_state(
            layer={
                "layerId": 7,
                "x": 0,
                "y": 0,
                "width": 10,
                "height": 10,
                "opacity": 255,
                "visible": True,
                "blend": "zzzz",
            },
            mode="image",
            content_hash="hash-7",
            constraints={},
            text_info=None,
            nine_slice_info=None,
        )
        self.assertIsNone(state["display"]["blendMode"])
        self.assertEqual(state["unsupported"], [{"path": "display.blendMode", "value": "zzzz"}])

    def test_undecoded_placed_transform_is_fingerprinted_as_unsupported(self):
        state = MODULE._build_psd_source_state(
            layer={
                "layerId": 8,
                "x": 0,
                "y": 0,
                "width": 10,
                "height": 10,
                "opacity": 255,
                "visible": True,
                "blend": "norm",
                "_tagPayloads": {"SoLd": b"placed-transform-record"},
            },
            mode="image",
            content_hash="hash-8",
            constraints={},
            text_info=None,
            nine_slice_info=None,
        )
        unsupported = state["unsupported"][0]
        self.assertEqual(unsupported["path"], "geometry.rotation")
        self.assertEqual(unsupported["value"]["tag"], "SoLd")
        self.assertEqual(len(unsupported["value"]["sha256"]), 64)

    def test_rotation_is_emitted_only_for_a_non_skewed_text_transform(self):
        transform = MODULE._normalize_text_rotation(
            {"matrix": [math.sqrt(0.5), math.sqrt(0.5), -math.sqrt(0.5), math.sqrt(0.5), 0, 0]}
        )
        self.assertAlmostEqual(transform, -45.0)
        self.assertIsNone(MODULE._normalize_text_rotation({"matrix": [1, 0.5, 0, 1, 0, 0]}))

    def test_summary_preserves_source_state_verbatim(self):
        source_state = {
            "version": 3,
            "layerId": "406",
            "geometry": {"x": 1, "y": 2, "width": 3, "height": 4, "rotation": 0},
            "display": {
                "visible": True,
                "opacity": 1,
                "blendMode": "NORMAL",
                "constraints": {},
            },
            "content": {"contentHash": "abc"},
            "text": None,
            "nineSlice": None,
            "unsupported": [],
        }
        summary = MODULE._generate_summary(
            {
                "canvas": {"width": 100, "height": 100},
                "layers": [
                    {
                        "index": 1,
                        "layerId": 406,
                        "name": "Button",
                        "mode": "image",
                        "x": 1,
                        "y": 2,
                        "width": 3,
                        "height": 4,
                        "opacity": 255,
                        "visible": True,
                        "constraints": {},
                        "path": "1.png",
                        "contentHash": "abc",
                        "sourceState": source_state,
                    }
                ],
            }
        )
        self.assertEqual(summary["layers"][0]["sourceState"], source_state)


if __name__ == "__main__":
    unittest.main()
