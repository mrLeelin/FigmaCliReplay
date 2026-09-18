import base64
import io
import sys
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

from gen_spec import (  # noqa: E402
    apply_name_size_fallback_dedup,
    build_text_material_spec,
    resolve_asset_path_collisions,
)
from process_images import expected_sliced_size, synthesize_h3slice  # noqa: E402


class LosslessRuleTests(unittest.TestCase):
    def test_same_filename_different_content_gets_unique_asset_paths(self):
        images = [
            {"id": "img_a", "fileName": "Layer.png", "targetDir": "Assets/Import/Texture"},
            {"id": "img_b", "fileName": "Layer.png", "targetDir": "Assets/Import/Texture"},
            {"id": "img_c", "fileName": "Layer.png", "targetDir": "Assets/Import/Texture"},
        ]
        downloads = [
            {"imageId": "img_a", "imageHash": "hash-a", "expectedSize": {"x": 100, "y": 100}, "targetAssetPath": "Assets/Import/Texture/Layer.png"},
            {"imageId": "img_b", "imageHash": "hash-b", "expectedSize": {"x": 101, "y": 100}, "targetAssetPath": "Assets/Import/Texture/Layer.png"},
            {"imageId": "img_c", "imageHash": "hash-c", "expectedSize": {"x": 102, "y": 100}, "targetAssetPath": "Assets/Import/Texture/Layer.png"},
        ]

        resolve_asset_path_collisions(images, downloads, [])

        self.assertEqual(
            [item["fileName"] for item in images],
            ["Layer.png", "Layer_hash-b.png", "Layer_hash-c.png"],
        )
        self.assertEqual(
            [item["targetAssetPath"] for item in downloads],
            [
                "Assets/Import/Texture/Layer.png",
                "Assets/Import/Texture/Layer_hash-b.png",
                "Assets/Import/Texture/Layer_hash-c.png",
            ],
        )

    def test_identical_content_with_same_filename_is_reused(self):
        images = [
            {"id": "img_a", "fileName": "Layer.png", "targetDir": "Assets/Import/Texture"},
            {"id": "img_b", "fileName": "Layer.png", "targetDir": "Assets/Import/Texture"},
        ]
        downloads = [
            {"imageId": "img_a", "imageHash": "same", "expectedSize": {"x": 100, "y": 100}, "targetAssetPath": "Assets/Import/Texture/Layer.png"},
            {"imageId": "img_b", "imageHash": "same", "expectedSize": {"x": 100, "y": 100}, "targetAssetPath": "Assets/Import/Texture/Layer.png"},
        ]
        nodes = [{"imageId": "img_a"}, {"imageId": "img_b"}]

        resolve_asset_path_collisions(images, downloads, nodes)

        self.assertEqual([node["imageId"] for node in nodes], ["img_a", "img_a"])
        self.assertEqual([item["id"] for item in images], ["img_a"])

    def test_same_name_and_size_different_content_is_not_merged(self):
        images = [
            {"id": "img_a", "fileName": "Layer.png", "targetDir": "Assets/Import/Texture"},
            {"id": "img_b", "fileName": "Layer.png", "targetDir": "Assets/Import/Texture"},
        ]
        downloads = [
            {"imageId": "img_a", "imageHash": "aaaaaaaa", "expectedSize": {"x": 100, "y": 100}, "targetAssetPath": "Assets/Import/Texture/Layer.png"},
            {"imageId": "img_b", "imageHash": "bbbbbbbb", "expectedSize": {"x": 100, "y": 100}, "targetAssetPath": "Assets/Import/Texture/Layer.png"},
        ]
        nodes = [{"imageId": "img_a"}, {"imageId": "img_b"}]

        resolve_asset_path_collisions(images, downloads, nodes)
        result_images, result_downloads, review = apply_name_size_fallback_dedup(nodes, images, downloads)

        self.assertEqual([node["imageId"] for node in nodes], ["img_a", "img_b"])
        self.assertEqual([item["id"] for item in result_images], ["img_a", "img_b"])
        self.assertEqual([item["imageId"] for item in result_downloads], ["img_a", "img_b"])
        self.assertEqual(review["mergedCount"], 0)

    def test_text_material_uses_exact_font_size_for_outline_and_shadow(self):
        node = {
            "strokes": [{
                "type": "SOLID",
                "visible": True,
                "color": {"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0},
            }],
            "strokeWeight": 2,
            "effects": [{
                "type": "DROP_SHADOW",
                "visible": True,
                "color": {"r": 0.0, "g": 0.0, "b": 0.0, "a": 0.5},
                "offset": {"x": 5, "y": 10},
                "radius": 4,
                "spread": 1,
            }],
        }

        material = build_text_material_spec(node, 50)

        self.assertIsNotNone(material)
        self.assertEqual(material["outlineWidth"], 0.09)
        self.assertEqual(material["underlayOffsetX"], 0.1)
        self.assertEqual(material["underlayOffsetY"], -0.2)
        self.assertEqual(material["underlaySoftness"], 0.08)
        self.assertTrue(material["materialName"].startswith("CommonFont_figma_"))

    def test_h3_slice_preserves_edge_and_center_pixels_at_minimum_size(self):
        from PIL import Image

        source = Image.new("RGBA", (8, 4), (0, 255, 0, 255))
        for y in range(4):
            source.putpixel((0, y), (255, 0, 0, 255))
            source.putpixel((1, y), (255, 0, 0, 255))
            source.putpixel((6, y), (0, 0, 255, 255))
            source.putpixel((7, y), (0, 0, 255, 255))
        buffer = io.BytesIO()
        source.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        slices = {
            "__slice_left": {"bounds": {"width": 2}},
            "__slice_right": {"bounds": {"width": 2}},
        }

        result = synthesize_h3slice(slices, {}, {"parent": encoded}, display_height=4, parent_node_id="parent")

        self.assertEqual(expected_sliced_size("h3slice", {"left": 2, "right": 2}, 100, 4), (6, 4))
        self.assertEqual(result.size, (6, 4))
        self.assertEqual(result.getpixel((0, 2)), (255, 0, 0, 255))
        self.assertEqual(result.getpixel((2, 2)), (0, 255, 0, 255))
        self.assertEqual(result.getpixel((5, 2)), (0, 0, 255, 255))


if __name__ == "__main__":
    unittest.main()
