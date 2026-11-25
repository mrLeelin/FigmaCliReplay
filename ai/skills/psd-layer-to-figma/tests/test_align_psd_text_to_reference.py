import importlib.util
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "align_psd_text_to_reference.py"
SPEC = importlib.util.spec_from_file_location("align_psd_text_to_reference", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PsdTextAlignmentTests(unittest.TestCase):
    def test_aligns_glyphs_across_a_high_contrast_background(self):
        fill = (140, 141, 150)
        reference = Image.new("RGB", (100, 80), (101, 46, 123))
        live = Image.new("RGB", reference.size, (101, 46, 123))
        glyphs = [(26, 23, 30, 35), (31, 27, 35, 31), (40, 26, 45, 36), (55, 23, 59, 34)]
        for image, dx, dy in ((reference, 0, 0), (live, 3, 7)):
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 40, 99, 79), fill=(32, 11, 81))
            for left, top, right, bottom in glyphs:
                draw.rectangle((left + dx, top + dy, right + dx, bottom + dy), fill=fill)

        self.assertEqual(MODULE.best_shift(live, reference, (15, 15, 70, 46), 12, {fill}), (1, 3, 7))

        ImageDraw.Draw(live).rectangle((0, 15, 99, 46), fill=(32, 11, 81))
        self.assertEqual(MODULE.best_shift(live, reference, (15, 15, 70, 46), 12, {fill}), (0, 0, 0))

    def test_uses_mixed_fills_and_opaque_outlines_for_matching(self):
        cyan = {"r": 141 / 255, "g": 251 / 255, "b": 1}
        white = {"r": 1, "g": 1, "b": 1}
        stroke = {"enabled": True, "r": 0, "g": 0, "b": 0, "opacity": 1}
        layer = {
            "fillColor": white,
            "fillRuns": [{"color": white}, {"color": cyan}],
            "stroke": stroke,
        }
        self.assertEqual(MODULE.text_colors(layer), {(255, 255, 255), (141, 251, 255), (0, 0, 0)})
        self.assertEqual(MODULE.text_colors({**layer, "fillGradient": {"angle": 90}}), {(0, 0, 0)})
        self.assertEqual(MODULE.text_colors({**layer, "opacity": 128}), set())


if __name__ == "__main__":
    unittest.main()
