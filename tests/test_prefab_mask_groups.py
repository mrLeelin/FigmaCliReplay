import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "ai/skills/figma-to-prefab" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import gen_spec


class MaskGroupSpecTests(unittest.TestCase):
    @staticmethod
    def node(node_id, kind, children=(), **extra):
        return {"id": node_id, "name": "Group 5" if node_id == "mask" else node_id,
                "type": kind, "bounds": {"x": 0, "y": 0, "width": 233, "height": 194},
                "childIds": list(children), **extra}

    def build(self, nodes, image_nodes, existing_images=None):
        output = io.BytesIO()
        Image.new("RGBA", (233, 194), (20, 100, 150, 128)).save(output, "PNG")
        exports = [{"id": f"export_{nid}", "nodeId": nid, "source": "nodeExport", "width": 233, "height": 194,
                    "base64": base64.b64encode(output.getvalue()).decode("ascii")} for nid in image_nodes]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figma_node_manifest.json").write_text(json.dumps({
                "rootNodeId": nodes[0]["id"], "rootBounds": nodes[0]["bounds"], "nodes": nodes,
            }), encoding="utf-8")
            (root / "image_export_manifest.json").write_text(json.dumps({"exports": exports}), encoding="utf-8")
            for name, content in (existing_images or {}).items():
                path = root / "Assets/Export/Texture" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            with patch.object(gen_spec, "UNITY_PROJECT", root), patch.object(gen_spec, "scan_common_prefabs", return_value={}):
                result = gen_spec.build_spec(root, "Assets/Export/Screen.prefab", "Assets/Export/Texture/", "Screen", {})[:2]
            for name, content in (existing_images or {}).items():
                self.assertEqual((root / "Assets/Export/Texture" / name).read_bytes(), content)
            return result

    def test_mask_group_uses_composite_instead_of_gray_mask_and_empty_shapes(self):
        spec, plan = self.build([
            self.node("root", "FRAME", ["mask"]),
            self.node("mask", "GROUP", ["ellipse", "union", "vector"], rasterize=True, rasterizeReason="maskGroup"),
            self.node("ellipse", "ELLIPSE"), self.node("union", "BOOLEAN_OPERATION", isMask=True),
            self.node("vector", "VECTOR"),
        ], ["mask", "ellipse", "union", "vector"])
        self.assertEqual([node["type"] for node in spec["nodes"]], ["Root", "Image"])
        self.assertEqual(spec["nodes"][1]["name"], "Group 5")
        self.assertEqual(spec["nodes"][1]["childIndices"], [])
        self.assertEqual([image["figmaNodeId"] for image in plan["images"]], ["mask"])

    def test_mask_group_export_root_keeps_root_and_composite_image_child(self):
        spec, plan = self.build([self.node("mask", "GROUP", rasterize=True, rasterizeReason="maskGroup")], ["mask"])
        self.assertEqual([node["type"] for node in spec["nodes"]], ["Root", "Image"])
        self.assertEqual(spec["nodes"][0]["childIndices"], [1])
        self.assertEqual(spec["nodes"][1]["rect"], {"x": 0, "y": 0, "w": 233, "h": 194})
        self.assertEqual(plan["images"][0]["figmaNodeId"], "mask")

    def test_group_with_editable_text_does_not_draw_mask_source(self):
        spec, plan = self.build([
            self.node("root", "FRAME", ["mixed"]),
            self.node("mixed", "GROUP", ["source-mask", "shape", "title"]),
            self.node("source-mask", "RECTANGLE", isMask=True, fills=[{"type": "SOLID"}]),
            self.node("shape", "RECTANGLE", fills=[{"type": "GRADIENT_LINEAR"}]),
            self.node("title", "TEXT", characters="12", fontSize=24),
        ], ["source-mask", "shape"])
        self.assertEqual([node["type"] for node in spec["nodes"]], ["Root", "Panel", "Image", "Text"])
        self.assertEqual([image["figmaNodeId"] for image in plan["images"]], ["shape"])
        self.assertEqual(spec["nodes"][-1]["text"], "12")

    def test_ellipse_moved_outside_mask_group_stays_an_independent_image(self):
        spec, plan = self.build([
            self.node("root", "FRAME", ["parent"]),
            self.node("parent", "GROUP", ["ellipse", "mask"]),
            self.node("ellipse", "ELLIPSE", name="Ellipse 7", fills=[{
                "type": "SOLID", "color": {"r": 0.25, "g": 0.47, "b": 0.55},
            }]),
            self.node("mask", "GROUP", rasterize=True, rasterizeReason="maskGroup"),
        ], ["ellipse", "mask"])
        self.assertEqual([node["type"] for node in spec["nodes"]], ["Root", "Panel", "Image", "Image"])
        self.assertEqual(spec["nodes"][1]["childIndices"], [2, 3])
        self.assertEqual(spec["nodes"][2]["name"], "Ellipse 7")
        self.assertNotEqual(spec["nodes"][2]["imageId"], gen_spec.WHITE_PIXEL_IMAGE_ID)
        self.assertEqual({image["figmaNodeId"] for image in plan["images"]}, {"ellipse", "mask"})

    def test_changed_same_name_after_mask_folding_reuses_only_matching_pixels(self):
        import hashlib
        stale = io.BytesIO()
        Image.new("RGBA", (233, 194), (200, 200, 200, 255)).save(stale, "PNG")
        correct = io.BytesIO()
        Image.new("RGBA", (233, 194), (20, 100, 150, 128)).save(correct, "PNG")
        expected_name = "Union_" + hashlib.md5(correct.getvalue()).hexdigest()[:8] + ".png"
        for has_matching_asset in [False, True]:
            with self.subTest(has_matching_asset=has_matching_asset):
                existing = {"Union.png": stale.getvalue()}
                if has_matching_asset:
                    existing[expected_name] = correct.getvalue()
                spec, plan = self.build([
                    self.node("root", "FRAME", ["union"]),
                    self.node("union", "BOOLEAN_OPERATION", name="Union"),
                ], ["union"], existing)
                self.assertEqual(plan["images"][0]["fileName"], expected_name)
                self.assertEqual(spec["images"][0]["fileName"], expected_name)
                self.assertEqual(plan["images"][0]["reuseExistingAsset"], has_matching_asset)


if __name__ == "__main__":
    unittest.main()
