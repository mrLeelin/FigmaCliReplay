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


class BooleanExportTests(unittest.TestCase):
    def test_boolean_uses_composite_png_without_emitting_operands(self):
        output = io.BytesIO()
        Image.new("RGBA", (95, 66), (100, 200, 150, 255)).save(output, "PNG")
        raw = output.getvalue()
        bounds = {"x": 0, "y": 0, "width": 94.7, "height": 65.49}
        nodes = [
            {"id": "1:1", "name": "Screen", "type": "FRAME", "bounds": bounds, "childIds": ["1:2"]},
            {"id": "1:2", "name": "Subtract", "type": "BOOLEAN_OPERATION", "bounds": bounds,
             "childIds": ["1:3", "1:4"], "fills": [{"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0}}]},
            {"id": "1:3", "name": "Rectangle 14", "type": "RECTANGLE", "bounds": bounds, "childIds": []},
            {"id": "1:4", "name": "Rectangle 15", "type": "RECTANGLE", "bounds": bounds, "childIds": []},
        ]
        exports = [{"id": "composite", "nodeId": "1:2", "source": "nodeExport", "width": 95, "height": 66,
                    "base64": base64.b64encode(raw).decode("ascii")}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figma_node_manifest.json").write_text(json.dumps({
                "rootNodeId": "1:1", "rootBounds": bounds, "nodes": nodes,
            }), encoding="utf-8")
            (root / "image_export_manifest.json").write_text(json.dumps({"exports": exports}), encoding="utf-8")
            with patch.object(gen_spec, "UNITY_PROJECT", root), patch.object(gen_spec, "scan_common_prefabs", return_value={}):
                spec, plan, _ = gen_spec.build_spec(root, "Assets/Export/Screen.prefab", "Assets/Export/Texture/", "Screen", {})
        self.assertEqual([node["name"] for node in spec["nodes"]], ["[Screen]", "Subtract"])
        self.assertEqual(spec["nodes"][1]["type"], "Image")
        self.assertEqual(spec["nodes"][1]["childIndices"], [])
        self.assertEqual(len(plan["images"]), 1)
        self.assertEqual(plan["images"][0]["figmaNodeId"], "1:2")
        self.assertEqual(plan["images"][0]["expectedMD5"], hashlib.md5(raw).hexdigest())
        self.assertEqual(plan["images"][0]["expectedSize"], {"x": 95, "y": 66})


if __name__ == "__main__":
    unittest.main()
