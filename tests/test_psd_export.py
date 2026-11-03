import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from psd_tools import PSDImage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import psd_export as export


def png(size=(4, 4), color=(255, 0, 0, 255)):
    stream = io.BytesIO()
    Image.new("RGBA", size, color).save(stream, format="PNG")
    return base64.b64encode(stream.getvalue()).decode("ascii")


def root():
    return {"id": "__root__", "parentId": "", "name": "Selection", "type": "FRAME", "synthetic": True}


def pixel(node_id="1:2", parent="__root__", **overrides):
    return {"id": node_id, "parentId": parent, "name": "中文图层", "type": "RECTANGLE",
            "bbox": {"x": 2, "y": 3, "width": 4, "height": 4},
            "imageExpected": True, "pngBase64": png(), **overrides}


class PsdExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="psd-export-test-")
        self.output = Path(self.directory.name).resolve()
        self.patch = patch.object(export, "EXPORT_ROOT", self.output)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.directory.cleanup()

    def assemble(self, nodes, **overrides):
        return export.assemble_psd({"nodes": nodes, "size": {"width": 20, "height": 16},
                                    "scale": 1, "imagesPrestretched": True,
                                    "outputDir": str(self.output), **overrides})

    def staged_meta(self, nodes, **overrides):
        return export.stage_meta({"taskId": "task", "nodes": nodes,
                                  "size": {"width": 20, "height": 16}, "scale": 1,
                                  "imagesPrestretched": True, "outputDir": str(self.output), **overrides})

    def chunk(self, layers):
        return export.stage_chunk({"taskId": "task", "layers": layers, "outputDir": str(self.output)})

    def staged_assemble(self):
        return export.assemble_staged({"taskId": "task", "outputDir": str(self.output)})

    def test_output_pixel_coordinates_are_scaled_once_at_1_2_3x(self):
        for scale in (1, 2, 3):
            with self.subTest(scale=scale):
                result = self.assemble([root(), pixel(bbox={"x": 2 * scale, "y": 3 * scale},
                                                    pngBase64=png((4 * scale, 4 * scale)))],
                                       size={"width": 20 * scale, "height": 16 * scale}, scale=scale)
                reopened = PSDImage.open(result["psdPath"])
                self.assertEqual(reopened.size, (20 * scale, 16 * scale))
                self.assertEqual(reopened[0].bbox, (2 * scale, 3 * scale, 6 * scale, 7 * scale))

    def test_legacy_logical_coordinates_and_images_scale_once(self):
        result = self.assemble([root(), pixel()], scale=2, imagesPrestretched=False)
        reopened = PSDImage.open(result["psdPath"])
        self.assertEqual(reopened.size, (40, 32))
        self.assertEqual(reopened[0].bbox, (4, 6, 12, 14))

    def test_unicode_names_layer_order_and_composite_pixels_survive_roundtrip(self):
        result = self.assemble([root(), pixel("1:2", name="底层红色"),
                                pixel("1:3", name="顶层蓝色", pngBase64=png(color=(0, 0, 255, 255)))])
        reopened = PSDImage.open(result["psdPath"])
        self.assertEqual([layer.name for layer in reopened], ["底层红色", "顶层蓝色"])
        self.assertEqual(reopened.composite().convert("RGBA").getpixel((3, 4)), (0, 0, 255, 255))
        self.assertEqual(reopened.composite().mode, "RGBA")
        self.assertEqual(reopened.composite().getpixel((0, 0))[3], 0)

    def test_blend_modes_and_transparent_leaf_pixels_survive_roundtrip(self):
        result = self.assemble([root(), pixel("1:2", name="底层", pngBase64=png(color=(255, 128, 128, 255))),
                                pixel("1:3", name="顶层", blendMode="MULTIPLY", pngBase64=png(color=(128, 255, 255, 255))),
                                pixel("1:4", name="透明层", visible=False, opacity=.5)])
        reopened = PSDImage.open(result["psdPath"])
        self.assertEqual(reopened[1].blend_mode.name, "MULTIPLY")
        self.assertEqual(reopened[2].opacity, 128)
        self.assertFalse(reopened[2].visible)
        self.assertEqual(reopened.composite().getpixel((3, 4)), (128, 128, 128, 255))

    def test_real_root_empty_containers_hidden_groups_and_zero_opacity_are_preserved(self):
        nodes = [{"id": "frame", "parentId": "", "type": "FRAME", "name": "根容器", "opacity": .5},
                 {"id": "empty", "parentId": "frame", "type": "GROUP", "name": "空分组"},
                 {"id": "hidden", "parentId": "frame", "type": "GROUP", "name": "隐藏分组", "visible": False},
                 pixel(parent="hidden", opacity=0)]
        result = self.assemble(nodes)
        reopened = PSDImage.open(result["psdPath"])
        self.assertEqual(reopened[0].name, "根容器")
        self.assertEqual(reopened[0].opacity, 128)
        self.assertEqual(reopened[0][0].name, "空分组")
        self.assertTrue(reopened[0][0].is_group())
        self.assertFalse(reopened[0][1].visible)
        self.assertEqual(reopened[0][1][0].opacity, 0)

    def test_group_background_applies_group_opacity_only_once(self):
        nodes = [root(), pixel("frame", type="FRAME", name="半透明", opacity=.5),
                 pixel("child", "frame", bbox={"x": 10, "y": 10})]
        result = self.assemble(nodes)
        reopened = PSDImage.open(result["psdPath"])
        self.assertEqual(reopened[0].opacity, 128)
        self.assertEqual(reopened[0][0].opacity, 255)
        self.assertEqual(reopened.composite().convert("RGBA").getpixel((3, 4))[3], 128)

    def test_staged_figma_instance_ids_are_hashed_and_roundtrip(self):
        node = pixel("I12:34;56:78")
        encoded = node.pop("pngBase64")
        self.staged_meta([root(), node])
        self.chunk([{"id": node["id"], "pngBase64": encoded}])
        stage = self.output / ".staging" / "task"
        image_files = list(stage.glob("*.png"))
        self.assertEqual(len(image_files), 1)
        self.assertRegex(image_files[0].stem, r"^[a-f0-9]{64}$")
        result = self.staged_assemble()
        self.assertTrue(result["ok"])
        self.assertEqual(result["coverage"], {"nodeCount": 1, "expectedImages": 1, "exportedImages": 1,
                                             "missingImages": 0, "complete": True})
        self.assertFalse(stage.exists())

    def test_staged_large_image_fragments_can_arrive_out_of_order(self):
        node = pixel()
        encoded = node.pop("pngBase64")
        pieces = [encoded[index:index + 16] for index in range(0, len(encoded), 16)]
        self.staged_meta([root(), node])
        for index in reversed(range(len(pieces))):
            self.chunk([{"id": node["id"], "pngBase64": pieces[index],
                         "partIndex": index, "partCount": len(pieces)}])
        result = self.staged_assemble()
        self.assertTrue(result["ok"])
        self.assertEqual(PSDImage.open(result["psdPath"])[0].topil().convert("RGBA").getpixel((0, 0)), (255, 0, 0, 255))

    def test_missing_image_fragment_or_required_image_never_reports_success(self):
        node = pixel()
        encoded = node.pop("pngBase64")
        self.staged_meta([root(), node])
        self.chunk([{"id": node["id"], "pngBase64": encoded[:16], "partIndex": 0, "partCount": 2}])
        with self.assertRaisesRegex(ValueError, "[Mm]issing|[Ii]ncomplete"):
            self.staged_assemble()
        self.assertFalse(list(self.output.glob("*.psd")))
        with self.assertRaisesRegex(ValueError, "[Mm]issing"):
            self.assemble([root(), node])

    def test_malformed_tree_and_bad_fragment_contracts_are_rejected(self):
        for nodes in ([root(), pixel(parent="absent")], [root(), pixel(), pixel()],
                      [{"id": "a", "parentId": "b"}, {"id": "b", "parentId": "a"}]):
            with self.subTest(nodes=nodes), self.assertRaises(ValueError):
                self.assemble(nodes)
        self.staged_meta([root(), pixel(pngBase64="")])
        for fields in ({"partIndex": -1, "partCount": 2}, {"partIndex": 2, "partCount": 2},
                       {"partIndex": 0, "partCount": True}, {"partIndex": 0},
                       {"partIndex": 0, "partCount": 50000}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.chunk([{"id": "1:2", "pngBase64": "AAAA", **fields}])
        with self.assertRaises(ValueError):
            self.chunk([{"id": "unregistered", "pngBase64": png()}])

    def test_full_images_and_fragmented_uploads_cannot_be_mixed(self):
        node = pixel()
        encoded = node.pop("pngBase64")
        self.staged_meta([root(), node])
        self.chunk([{"id": node["id"], "pngBase64": encoded}])
        with self.assertRaisesRegex(ValueError, "already"):
            self.chunk([{"id": node["id"], "pngBase64": encoded[:16], "partIndex": 0, "partCount": 2}])

    def test_invalid_png_and_unbounded_numbers_are_rejected(self):
        for overrides in ({"scale": 0}, {"scale": float("nan")},
                          {"size": {"width": float("inf"), "height": 10}}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.assemble([root(), pixel()], **overrides)
        with self.assertRaises(ValueError):
            self.assemble([root(), pixel(pngBase64="AAAA")])

    def test_roundtrip_failure_leaves_no_success_artifact(self):
        with patch.object(export.PSDImage, "open", side_effect=OSError("broken PSD")):
            with self.assertRaisesRegex(OSError, "broken PSD"):
                self.assemble([root(), pixel()])
        self.assertFalse(list(self.output.iterdir()))

    def test_composited_container_keeps_source_tree_hidden_without_double_render(self):
        nodes = [root(), pixel("frame", type="FRAME", name="蒙版容器", composited=True,
                               opacity=.5, compositedReason="Mask", pngBase64=png(color=(0, 0, 255, 255))),
                 pixel("child", "frame", opacity=0), pixel("child2", "frame", opacity=.5)]
        result = self.assemble(nodes, warnings=["文字图层保留像素", "文字图层保留像素"])
        reopened = PSDImage.open(result["psdPath"])
        group = reopened[0]
        self.assertEqual(group.name, "蒙版容器")
        source = next(layer for layer in group if layer.is_group())
        self.assertEqual(source.name, "源图层")
        self.assertFalse(source.visible)
        self.assertEqual(source[0].name, "中文图层")
        self.assertEqual(source[0].opacity, 0)
        self.assertEqual(source[1].opacity, 128)
        self.assertEqual(group.opacity, 128)
        self.assertEqual(reopened.composite().convert("RGBA").getpixel((3, 4)), (0, 0, 255, 128))
        self.assertTrue(result["warnings"])
        self.assertEqual(result["warnings"].count("文字图层保留像素"), 1)
        self.assertEqual(result["coverage"]["missingImages"], 0)

    def test_deep_tree_is_rejected_before_recursive_emission(self):
        nodes = [root()]
        for index in range(300):
            nodes.append({"id": str(index), "parentId": "__root__" if index == 0 else str(index - 1), "type": "GROUP"})
        with self.assertRaisesRegex(ValueError, "nesting"):
            self.assemble(nodes)

    def test_same_second_exports_do_not_overwrite_and_index_matches_roundtrip(self):
        first = self.assemble([root(), pixel()])
        second = self.assemble([root(), pixel()])
        self.assertNotEqual(first["psdPath"], second["psdPath"])
        index = json.loads(Path(first["indexPath"]).read_text(encoding="utf-8"))
        self.assertEqual(index["coverage"], first["coverage"])
        self.assertEqual(first["layerCount"], 1)
        self.assertEqual(index["layers"][0]["original"], "中文图层")
        self.assertFalse(list(self.output.glob("*.part*")))


if __name__ == "__main__":
    unittest.main()
