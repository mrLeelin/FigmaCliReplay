import base64
import hashlib
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


class ShadowExportTests(unittest.TestCase):
    def build(self, kind, logical, rendered, effects):
        image = Image.new("RGBA", (rendered["width"], rendered["height"]), (90, 120, 150, 128))
        output = io.BytesIO()
        image.save(output, "PNG")
        raw = output.getvalue()
        nodes = [
            {"id": "root", "name": "Screen", "type": "FRAME", "childIds": ["shape"],
             "bounds": {"x": 0, "y": 0, "width": 1080, "height": 2340}},
            {"id": "shape", "name": "Shape", "type": kind, "childIds": [], "bounds": logical,
             "effects": effects, "fills": [{"type": "SOLID", "color": {"r": 1, "g": 1, "b": 1}}],
             "constraints": {"horizontal": "MIN", "vertical": "MIN"}},
        ]
        exports = [{"id": "png", "nodeId": "shape", "source": "nodeExport", "width": rendered["width"],
                    "height": rendered["height"], "exportBounds": rendered,
                    "base64": base64.b64encode(raw).decode("ascii")}]
        return (*self.build_manifests(nodes, exports), raw)

    def build_manifests(self, nodes, exports):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figma_node_manifest.json").write_text(json.dumps({
                "rootNodeId": "root", "rootBounds": nodes[0]["bounds"], "nodes": nodes,
            }), encoding="utf-8")
            (root / "image_export_manifest.json").write_text(json.dumps({"exports": exports}), encoding="utf-8")
            with patch.object(gen_spec, "UNITY_PROJECT", root), patch.object(gen_spec, "scan_common_prefabs", return_value={}):
                spec, plan, _ = gen_spec.build_spec(root, "Assets/Export/Screen.prefab", "Assets/Export/Texture/", "Screen", {})
        return spec, plan

    def test_outer_stroke_keeps_logical_ellipse_and_expands_only_visual_child(self):
        spec, plan, raw = self.build("ELLIPSE", {"x": 100, "y": 100, "width": 32, "height": 32},
                                     {"x": 96, "y": 96, "width": 40, "height": 40}, [])
        self.assertEqual([node["type"] for node in spec["nodes"]], ["Root", "Panel", "Image"])
        self.assertEqual(spec["nodes"][1]["rect"]["w"], 32)
        self.assertEqual(spec["nodes"][1]["rect"]["h"], 32)
        self.assertEqual(spec["nodes"][1]["childIndices"], [2])
        self.assertEqual(spec["nodes"][2]["rect"], {"x": 0, "y": 0, "w": 40, "h": 40})
        self.assertEqual(spec["nodes"][2]["rectTransform"]["anchorMin"], {"x": 0.5, "y": 0.5})
        self.assertEqual(plan["images"][0]["expectedSize"], {"x": 40, "y": 40})
        self.assertEqual(plan["images"][0]["expectedMD5"], hashlib.md5(raw).hexdigest())

    def test_bottom_shadow_keeps_original_card_size_and_offsets_expanded_visual(self):
        spec, plan, raw = self.build("RECTANGLE", {"x": 629, "y": 0, "width": 298, "height": 486},
                                     {"x": 629, "y": 0, "width": 298, "height": 494},
                                     [{"type": "DROP_SHADOW", "visible": True, "offset": {"x": 0, "y": 8}}])
        self.assertEqual([node["type"] for node in spec["nodes"]], ["Root", "Panel", "Image"])
        self.assertEqual(spec["nodes"][1]["rect"]["h"], 486)
        self.assertEqual(spec["nodes"][2]["rect"], {"x": 0, "y": -4, "w": 298, "h": 494})
        self.assertEqual(plan["images"][0]["expectedMD5"], hashlib.md5(raw).hexdigest())
        self.assertEqual(plan["images"][0]["figmaNodeId"], "shape")
        self.assertNotEqual(spec["nodes"][2]["imageId"], gen_spec.WHITE_PIXEL_IMAGE_ID)

    def test_render_bounds_alone_prevent_white_pixel_optimization(self):
        spec, plan, _ = self.build("RECTANGLE", {"x": 100, "y": 100, "width": 32, "height": 32},
                                   {"x": 96, "y": 96, "width": 40, "height": 40}, [])
        self.assertEqual(len(plan["images"]), 1)
        self.assertNotEqual(spec["nodes"][2]["imageId"], gen_spec.WHITE_PIXEL_IMAGE_ID)

    def test_same_native_image_with_different_shadows_keeps_distinct_pngs(self):
        nodes = [{"id": "root", "name": "Screen", "type": "FRAME", "childIds": ["first", "second"],
                  "bounds": {"x": 0, "y": 0, "width": 1080, "height": 2340}}]
        exports = []
        for index, nid in enumerate(["first", "second"]):
            side = 40 + 4 * index
            x = 100 + 100 * index
            output = io.BytesIO()
            Image.new("RGBA", (side, side), (90, 120, 150, 100 + index)).save(output, "PNG")
            nodes.append({"id": nid, "name": nid, "type": "RECTANGLE", "childIds": [],
                          "bounds": {"x": x, "y": 100, "width": 32, "height": 32},
                          "fills": [{"type": "IMAGE", "imageHash": "same-native-image"}],
                          "effects": [{"type": "DROP_SHADOW", "visible": True, "radius": 4 + index}]})
            exports.append({"id": nid, "nodeId": nid, "source": "imageHash", "imageHash": "same-native-image",
                            "width": side, "height": side, "base64": base64.b64encode(output.getvalue()).decode("ascii"),
                            "exportBounds": {"x": x - (side - 32) / 2, "y": 100 - (side - 32) / 2,
                                             "width": side, "height": side}})
        spec, plan = self.build_manifests(nodes, exports)
        self.assertEqual(len(plan["images"]), 2)
        self.assertEqual({item["figmaNodeId"] for item in plan["images"]}, {"first", "second"})
        self.assertEqual(len({item["expectedMD5"] for item in plan["images"]}), 2)
        self.assertEqual(len({node["imageId"] for node in spec["nodes"] if node["type"] == "Image"}), 2)


if __name__ == "__main__":
    unittest.main()
