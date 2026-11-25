import importlib.util
import math
import unittest
from pathlib import Path

from psd_tools.psd.descriptor import Bool, Descriptor, DescriptorBlock2, Double, Enumerated, Integer, List


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_psd_layers.py"
SPEC = importlib.util.spec_from_file_location("export_psd_layers", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _effect_payload(items, master_enabled=True):
    return DescriptorBlock2(items={b"masterFXSwitch": Bool(master_enabled), **items}).tobytes()


def _rgb(red, green, blue):
    return Descriptor({b"Rd  ": Double(red), b"Grn ": Double(green), b"Bl  ": Double(blue)}, classID=b"RGBC")


def _overlay(class_id, settings, enabled=True):
    return Descriptor({
        b"enab": Bool(enabled),
        b"present": Bool(True),
        b"Md  ": Enumerated(b"BlnM", b"Nrml"),
        b"Opct": Double(100),
        **settings,
    }, classID=class_id)


def _gradient(reverse=False, gradient_type=b"Lnr "):
    colors = [
        Descriptor({b"Lctn": Integer(location), b"Mdpn": Integer(50), b"Clr ": _rgb(*color)})
        for location, color in [
            (0, (248, 240, 85)), (1935, (248, 212, 85)),
            (1986, (255, 255, 255)), (4096, (255, 207, 41)),
        ]
    ]
    opacity_stops = [
        Descriptor({b"Lctn": Integer(location), b"Mdpn": Integer(50), b"Opct": Double(100)})
        for location in (0, 4096)
    ]
    return _overlay(b"GrFl", {
        b"Type": Enumerated(b"GrdT", gradient_type), b"Angl": Double(90), b"Scl ": Double(87),
        b"Algn": Bool(True), b"Rvrs": Bool(reverse),
        b"Grad": Descriptor({
            b"GrdF": Enumerated(b"GrdF", b"CstS"), b"Clrs": List(colors), b"Trns": List(opacity_stops),
        }),
    })


def _text_info(effects):
    return MODULE._build_text_info({
        "TySh": b"\x00" * 52 + b"/Text (Example) /FontSize 36 /FillColor << /Values [1 0 0 0] >>",
        "lfx2": effects,
    })


class PsdSourceStateTests(unittest.TestCase):
    def test_opaque_normal_color_overlay_overrides_engine_fill(self):
        white = _overlay(b"SoFi", {b"Clr ": _rgb(255, 255, 255)})
        active = _text_info(_effect_payload({b"SoFi": white}))
        disabled = _text_info(_effect_payload({b"SoFi": white}, master_enabled=False))

        self.assertEqual(active["fillColor"], {"r": 1, "g": 1, "b": 1, "a": 1, "hex": "#FFFFFF"})
        self.assertEqual(disabled["fillColor"]["hex"], "#000000")

    def test_partial_normal_color_overlay_blends_over_the_opaque_engine_fill(self):
        tint = _overlay(b"SoFi", {b"Clr ": _rgb(238, 238.8, 255), b"Opct": Double(59)})
        text = _text_info(_effect_payload({
            b"SoFi": tint,
            b"GrFl": _overlay(b"GrFl", {}, enabled=False),
        }))

        self.assertEqual(text["fillColor"]["hex"], "#8C8D96")
        self.assertEqual(text["fillColor"]["a"], 1)
        self.assertEqual(text["warnings"], [])

    def test_enabled_linear_overlay_and_ignored_disabled_color_overlay_survive_manifest(self):
        style = _effect_payload({
            b"SoFi": _overlay(b"SoFi", {b"Clr ": _rgb(255, 165, 25)}, enabled=False),
            b"gradientFillMulti": List([_gradient()]),
        })
        text = _text_info(style)
        layer = {
            "index": 1, "layerId": 39, "name": "Example", "mode": "text", "text": text,
            "x": 0, "y": 0, "width": 800, "height": 145, "opacity": 255, "visible": True,
            "path": "text.png",
        }
        layer["sourceState"] = MODULE._build_psd_source_state(
            layer=layer, mode="text", content_hash="example", constraints={},
            text_info=text, nine_slice_info=None,
        )
        manifest = MODULE._generate_summary({"canvas": {"width": 800, "height": 145}, "layers": [layer]}, None)
        gradient = manifest["layers"][0]["fillGradient"]

        self.assertEqual(gradient["scale"], 0.87)
        self.assertEqual(gradient["angle"], 90)
        self.assertEqual([stop["position"] for stop in gradient["stops"]], [0, 1935 / 4096, 1986 / 4096, 1])
        self.assertEqual(gradient["stops"][-1]["color"], {"r": 1, "g": 207 / 255, "b": 41 / 255, "a": 1})
        self.assertEqual(manifest["layers"][0]["sourceState"]["text"]["fillGradient"], gradient)

    def test_reversed_gradient_reverses_stops_and_positions(self):
        gradient = _text_info(_effect_payload({b"GrFl": _gradient(reverse=True)}))["fillGradient"]

        self.assertEqual([stop["position"] for stop in gradient["stops"]], [0, 1 - 1986 / 4096, 1 - 1935 / 4096, 1])
        self.assertEqual(gradient["stops"][0]["color"], {"r": 1, "g": 207 / 255, "b": 41 / 255, "a": 1})

    def test_unsupported_overlay_keeps_engine_fill_and_reports_limitation(self):
        text = _text_info(_effect_payload({b"GrFl": _gradient(gradient_type=b"Rdl ")}))

        self.assertEqual(text["fillColor"]["hex"], "#000000")
        self.assertNotIn("fillGradient", text)
        self.assertTrue(any("Gradient Overlay" in warning for warning in text["warnings"]))

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

    def test_raster_placed_payload_churn_is_not_reported_as_rotation_change(self):
        states = []
        for payload in (b"first-save-record", b"second-save-record"):
            states.append(MODULE._build_psd_source_state(
                layer={
                    "layerId": 8,
                    "x": 0,
                    "y": 0,
                    "width": 10,
                    "height": 10,
                    "opacity": 255,
                    "visible": True,
                    "blend": "norm",
                    "_tagPayloads": {"SoLd": payload},
                },
                mode="image",
                content_hash="same-rendered-pixels",
                constraints={},
                text_info=None,
                nine_slice_info=None,
            ))

        self.assertEqual(states[0]["unsupported"], [])
        self.assertEqual(states[0], states[1])

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
