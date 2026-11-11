import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "ai/skills/figma-to-prefab" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import gen_spec


class TextAlignmentExportTests(unittest.TestCase):
    def build_text_spec(self, **align):
        text = {"id": "text", "name": "20", "type": "TEXT", "childIds": [], "characters": "20", "fontSize": 28,
                "bounds": {"x": 172, "y": 143, "width": 84, "height": 47},
                "fills": [{"type": "SOLID", "color": {"r": 0.32, "g": 0.36, "b": 0.48}}],
                "constraints": {"horizontal": "MIN", "vertical": "MIN"}, **align}
        nodes = [
            {"id": "root", "name": "Screen", "type": "FRAME", "childIds": ["text"],
             "bounds": {"x": 0, "y": 0, "width": 260, "height": 190}},
            text,
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figma_node_manifest.json").write_text(json.dumps({
                "rootNodeId": "root", "rootBounds": nodes[0]["bounds"], "nodes": nodes,
            }), encoding="utf-8")
            (root / "image_export_manifest.json").write_text(json.dumps({"exports": []}), encoding="utf-8")
            with patch.object(gen_spec, "UNITY_PROJECT", root), patch.object(gen_spec, "scan_common_prefabs", return_value={}):
                spec, _, _ = gen_spec.build_spec(root, "Assets/Export/Screen.prefab", "Assets/Export/Texture/", "Screen", {})
        return next(node for node in spec["nodes"] if node["type"] == "Text")

    def test_left_top_text_keeps_figma_alignment(self):
        node = self.build_text_spec(textAlignHorizontal="LEFT", textAlignVertical="TOP")
        self.assertEqual(node["alignment"], "TopLeft")

    def test_right_bottom_text_keeps_figma_alignment(self):
        node = self.build_text_spec(textAlignHorizontal="RIGHT", textAlignVertical="BOTTOM")
        self.assertEqual(node["alignment"], "BottomRight")

    def test_center_text_stays_center(self):
        node = self.build_text_spec(textAlignHorizontal="CENTER", textAlignVertical="CENTER")
        self.assertEqual(node["alignment"], "Center")

    def test_manifest_without_alignment_falls_back_to_center(self):
        self.assertEqual(self.build_text_spec()["alignment"], "Center")


if __name__ == "__main__":
    unittest.main()
