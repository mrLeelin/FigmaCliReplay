import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

SCRIPTS = Path(__file__).resolve().parents[1] / "ai/skills/figma-to-prefab" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import gen_spec


class VectorExportTests(unittest.TestCase):
    def test_progressbar_vector_retains_its_png_and_parent_group(self):
        image = Image.new("RGBA", (712, 128), (0, 0, 0, 0))
        ImageDraw.Draw(image).polygon([(8, 8), (704, 8), (704, 80), (470, 80),
                                      (450, 120), (270, 120), (250, 80), (8, 80)],
                                     fill=(228, 241, 224, 255))
        output = io.BytesIO()
        image.save(output, "PNG")
        raw = output.getvalue()
        bounds = {"x": 0, "y": 0, "width": 712, "height": 128.000031}
        nodes = [
            {"id": "root", "name": "Screen", "type": "FRAME", "bounds": bounds, "childIds": ["33:514"]},
            {"id": "33:514", "name": "Group 2", "type": "GROUP", "bounds": bounds, "childIds": ["33:515"]},
            {"id": "33:515", "name": "Vector", "type": "VECTOR", "bounds": bounds, "childIds": [],
             "fills": [{"type": "SOLID", "color": {"r": 0.89, "g": 0.94, "b": 0.88}}]},
        ]
        exports = [{"id": "vector", "nodeId": "33:515", "source": "nodeExport", "width": 712, "height": 128,
                    "base64": base64.b64encode(raw).decode("ascii")}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figma_node_manifest.json").write_text(json.dumps({
                "rootNodeId": "root", "rootBounds": bounds, "nodes": nodes,
            }), encoding="utf-8")
            (root / "image_export_manifest.json").write_text(json.dumps({"exports": exports}), encoding="utf-8")
            with patch.object(gen_spec, "UNITY_PROJECT", root), patch.object(gen_spec, "scan_common_prefabs", return_value={}):
                spec, plan, _ = gen_spec.build_spec(root, "Assets/Export/Screen.prefab", "Assets/Export/Texture/", "Screen", {})
        self.assertEqual([node["type"] for node in spec["nodes"]], ["Root", "Panel", "Image"])
        self.assertEqual(spec["nodes"][1]["name"], "[Group 2]")
        self.assertEqual(spec["nodes"][1]["childIndices"], [2])
        self.assertEqual(spec["nodes"][2]["name"], "Vector")
        self.assertNotEqual(spec["nodes"][2]["imageId"], gen_spec.WHITE_PIXEL_IMAGE_ID)
        self.assertEqual(plan["images"][0]["figmaNodeId"], "33:515")
        self.assertEqual(plan["images"][0]["expectedMD5"], hashlib.md5(raw).hexdigest())
        self.assertEqual(plan["images"][0]["expectedSize"], {"x": 712, "y": 128})


if __name__ == "__main__":
    unittest.main()
