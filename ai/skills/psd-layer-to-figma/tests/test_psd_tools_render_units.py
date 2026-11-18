"""Exercise actual PSD compositing without Photoshop, including masks and clips."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import AdjustmentLayer, Artboard, TypeLayer
from psd_tools.constants import BlendMode, Tag
from psd_tools.psd.descriptor import Bool as Boolean, Descriptor, DescriptorBlock, Double, Enumerated, Integer, UnitFloat
from psd_tools.terminology import Key, Klass, Unit

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import psd_tools_render_units as renderer


class PsdToolsRenderTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="psd-tools-render-test-")
        self.addCleanup(self.directory.cleanup)
        self.tmp = Path(self.directory.name)
        self.psd = PSDImage.new("RGB", (24, 20))
        self.next_id = 100
        self.base_layers = []

    def identify(self, layer):
        self.next_id += 1
        layer.tagged_blocks.set_data(Tag.LAYER_ID, self.next_id)
        return layer

    def pixel(self, name, parent=None, color=(255, 0, 0, 255), size=(8, 8), left=4, top=3, opacity=255):
        parent = self.psd if parent is None else parent
        mode, paint = ("RGB", color[:3]) if color[3] == 255 else ("RGBA", color)
        with Image.new(mode, size, paint) as image:
            return self.identify(parent.create_pixel_layer(image, name=name, left=left, top=top, opacity=opacity))

    def group(self, name, parent=None, opacity=255):
        parent = self.psd if parent is None else parent
        return self.identify(parent.create_group(name=name, opacity=opacity))

    def build(self, psd=None, patch_open=False):
        psd = self.psd if psd is None else psd
        path = self.tmp / "input.psd"
        base_path = self.tmp / "base.json"
        base_path.write_text(json.dumps({"layers": self.base_layers}), encoding="utf-8")
        if not patch_open:
            psd.save(path)
            return renderer.build_manifest(path, self.tmp / "out", base_path)
        with mock.patch.object(renderer.PSDImage, "open", return_value=psd), \
                mock.patch.object(renderer, "_psd_font_runs", return_value={}):
            return renderer.build_manifest(path, self.tmp / "out", base_path)

    def image(self, entry):
        with Image.open(entry["path"]) as image:
            return image.convert("RGBA")

    def test_hidden_ancestor_and_transparent_unit_are_not_exported(self):
        hidden = self.group("hidden group")
        self.pixel("hidden child", hidden, color=(0, 255, 0, 255))
        hidden.visible = False
        self.pixel("empty", color=(0, 0, 0, 0))
        visible = self.pixel("visible")
        result = self.build()
        self.assertEqual([item["name"] for item in result["layers"]], ["visible"])
        self.assertEqual(result["layers"][0]["layerId"], visible.layer_id)
        self.assertEqual(result["renderSource"], "psd-tools")

    def test_pixel_mask_is_composited_and_trimmed_in_document_coordinates(self):
        layer = self.pixel("masked")
        with Image.new("L", (8, 8), 0) as mask:
            mask.paste(255, (2, 1, 6, 7))
            layer.create_mask(mask)
        entry = self.build()["layers"][0]
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"]), (6, 4, 4, 6))
        with self.image(entry) as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0, 255))

    def test_clipping_chain_is_one_unit_and_hidden_clipping_pixels_stay_hidden(self):
        base = self.pixel("base", size=(4, 4))
        blue = self.pixel("blue", color=(0, 0, 255, 255), size=(12, 12), left=0, top=0)
        blue.clipping = True
        hidden = self.pixel("hidden clip", color=(0, 255, 0, 255), size=(12, 12), left=0, top=0)
        hidden.clipping, hidden.visible = True, False
        result = self.build()
        self.assertEqual(result["imageCount"], 1)
        entry = result["layers"][0]
        self.assertEqual(entry["psdLayerIds"], [base.layer_id, blue.layer_id, hidden.layer_id])
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"]), (4, 3, 4, 4))
        with self.image(entry) as image:
            self.assertEqual(image.getpixel((2, 2)), (0, 0, 255, 255))

    def test_group_opacity_is_baked_once_into_the_atomic_group_image(self):
        group = self.group("half", opacity=128)
        self.pixel("red", group)
        self.pixel("blue", group, color=(0, 0, 255, 255), left=8)
        result = self.build()
        self.assertEqual(result["imageCount"], 1)
        entry = result["layers"][0]
        self.assertEqual(entry["layerId"], group.layer_id)
        self.assertEqual(entry["opacity"], 255)
        self.assertEqual(entry["sourceState"]["display"]["opacity"], 1.0)
        with self.image(entry) as image:
            self.assertIn(image.getpixel((5, 2))[3], (127, 128))

    def test_group_mask_is_applied_to_its_children_before_trim(self):
        group = self.group("group mask")
        self.pixel("red", group, left=2, top=2)
        with Image.new("L", (4, 5), 255) as mask:
            group.create_mask(mask, left=4, top=3)
        # Group.create_mask() cannot currently round-trip the synthetic group's
        # bounding record. Exercise the real compositor on the in-memory PSD;
        # the pixel-mask test above still saves and reopens the actual file.
        entry = self.build(patch_open=True)["layers"][0]
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"]), (4, 3, 4, 5))

    def test_artboard_clips_each_child_without_exporting_its_white_background(self):
        group = self.group("board")
        self.pixel("outside", group, left=1, top=1, size=(12, 12))
        rect = Descriptor(items=[(key, Double(value)) for key, value in
                                 [(b"Left", 5), (b"Top ", 4), (b"Rght", 10), (b"Btom", 11)]])
        group.tagged_blocks.set_data(Tag.ARTBOARD_DATA1, DescriptorBlock(items=[
            (b"artboardRect", rect), (b"artboardBackgroundType", Integer(2))]))
        board = Artboard._move(group)
        # Photoshop artboards normally use NORMAL, which must not cause flattening.
        board.blend_mode = BlendMode.NORMAL
        entry = self.build()["layers"][0]
        self.assertEqual(entry["name"], "outside")
        self.assertEqual((entry["x"], entry["y"], entry["w"], entry["h"]), (5, 4, 5, 7))
        with self.image(entry) as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0, 255))

    def test_enabled_color_overlay_changes_the_actual_image_pixels(self):
        layer = self.pixel("green overlay")
        color = Descriptor(classID=Klass.RGBColor.value, items=[
            (Key.Red, Double(0)), (Key.Green, Double(255)), (Key.Blue, Double(0))])
        effect = Descriptor(classID=Klass.SolidFill.value, items=[
            (b"present", Boolean(True)), (Key.Enabled, Boolean(True)),
            (Key.Mode, Enumerated(b"BlnM", b"Nrml")), (Key.Opacity, UnitFloat(100.0, Unit.Percent)),
            (Key.Color, color)])
        layer.tagged_blocks.set_data(Tag.OBJECT_BASED_EFFECTS_LAYER_INFO, DescriptorBlock(items=[
            (b"masterFXSwitch", Boolean(True)), (Key.SolidFill, effect)]))
        with self.image(self.build()["layers"][0]) as image:
            self.assertEqual(image.getpixel((2, 2)), (0, 255, 0, 255))

    def test_bottom_to_top_order_is_preserved_through_pass_through_groups(self):
        self.pixel("bottom")
        group = self.group("pass through")
        self.pixel("middle", group)
        self.pixel("top")
        result = self.build()
        self.assertEqual([item["name"] for item in result["layers"]], ["bottom", "middle", "top"])
        self.assertEqual([item["idx"] for item in result["layers"]], [1, 2, 3])

    def test_native_text_is_preserved_and_not_baked_into_the_group_image(self):
        group = self.group("atomic", opacity=128)
        background = self.pixel("background", group)
        pixels = self.pixel("Hello", group, color=(0, 255, 0, 255))
        text = TypeLayer(group, pixels._record, pixels._channels)
        group._layers[group.index(pixels)] = text
        self.base_layers = [{"idx": 90, "name": "Hello", "layerId": text.layer_id,
                             "mode": "text", "chars": "Hello", "fill": "#123456",
                             "x": 4, "y": 3, "w": 8, "h": 8,
                             "constraints": {"horizontal": "CENTER", "vertical": "MIN"}}]
        result = self.build(patch_open=True)
        self.assertEqual([item["mode"] for item in result["layers"]], ["image", "text"])
        entry = result["textLayers"][0]
        self.assertEqual((entry["chars"], entry["textRole"], entry["fill"]), ("Hello", "ordinary", "#123456"))
        self.assertEqual(entry["layerId"], text.layer_id)
        self.assertEqual(entry["constraints"], self.base_layers[0]["constraints"])
        self.assertEqual(entry["opacity"], 128)
        with self.image(result["imageLayers"][0]) as image:
            self.assertEqual(image.getpixel((2, 2))[:3], (255, 0, 0))

    def test_missing_editable_text_data_fails_instead_of_silently_dropping_text(self):
        pixels = self.pixel("Hello")
        self.psd._layers[0] = TypeLayer(self.psd, pixels._record, pixels._channels)
        with self.assertRaisesRegex(RuntimeError, "editable text metadata is missing"):
            self.build(patch_open=True)

    def test_color_dodge_text_is_baked_with_a_hidden_editable_copy(self):
        group = self.group("CASH", opacity=240)
        texts = []
        for name, left in (("Cash", 4), ("Keep", 15)):
            pixels = self.pixel(name, group, color=(255, 166, 25, 255), left=left)
            text = TypeLayer(group, pixels._record, pixels._channels)
            group._layers[group.index(pixels)] = text
            texts.append(text)
            self.base_layers.append({
                "name": name, "layerId": text.layer_id, "mode": "text", "chars": name,
                "x": left, "y": 3, "w": 8, "h": 8, "visible": True,
                "sourceState": {"display": {"visible": True, "opacity": 1.0}},
            })
        highlight = self.pixel("highlight", group, color=(244, 162, 70, 255))
        highlight.blend_mode = BlendMode.COLOR_DODGE
        hidden = self.pixel("hidden highlight", group, left=15)
        hidden.blend_mode = BlendMode.COLOR_DODGE
        hidden.visible = False

        result = self.build(patch_open=True)
        cash, keep = result["textLayers"]
        self.assertEqual(cash["chars"], "Cash")
        self.assertEqual(cash["layerId"], texts[0].layer_id)
        self.assertFalse(cash["visible"])
        self.assertFalse(cash["sourceState"]["display"]["visible"])
        self.assertTrue(keep["visible"])
        self.assertTrue(keep["sourceState"]["display"]["visible"])
        with group.composite(viewport=(4, 3, 12, 11), force=True, color=1.0, alpha=0.0) as reference, \
                self.image(result["imageLayers"][0]) as image:
            self.assertEqual(image.getpixel((2, 2)), reference.getpixel((2, 2)))

    def test_adjustments_keep_their_group_atomic_and_root_adjustments_warn(self):
        group = self.group("adjusted")
        self.pixel("red", group)
        pixels = self.pixel("adjustment", group)
        group._layers[group.index(pixels)] = AdjustmentLayer(group, pixels._record, pixels._channels)
        standalone = self.pixel("root adjustment")
        self.psd._layers[self.psd.index(standalone)] = AdjustmentLayer(self.psd, standalone._record, standalone._channels)
        warnings = []
        units = renderer.collect_units(self.psd, warnings)
        self.assertEqual([unit.layer.name for unit in units], ["adjusted"])
        self.assertTrue(any("root adjustment" in warning and "standalone" in warning for warning in warnings))


if __name__ == "__main__":
    unittest.main()
