import importlib.util
import hashlib
import struct
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_psd_layers.py"
SPEC = importlib.util.spec_from_file_location("export_psd_layers", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PsdLayerIdTests(unittest.TestCase):
    def test_reads_big_endian_lyid_payload(self):
        self.assertEqual(
            MODULE._read_psd_layer_id({"lyid": struct.pack(">I", 205)}),
            205,
        )

    def test_rejects_missing_short_or_zero_layer_id(self):
        self.assertIsNone(MODULE._read_psd_layer_id({}))
        self.assertIsNone(MODULE._read_psd_layer_id({"lyid": b"\x00\x01"}))
        self.assertIsNone(
            MODULE._read_psd_layer_id({"lyid": struct.pack(">I", 0)})
        )

    def test_summary_keeps_layer_id_and_content_hash(self):
        manifest = {
            "canvas": {"width": 100, "height": 100},
            "layers": [
                {
                    "index": 0,
                    "layerId": 205,
                    "name": "Avatar",
                    "mode": "image",
                    "x": 0,
                    "y": 0,
                    "width": 32,
                    "height": 32,
                    "opacity": 1,
                    "visible": True,
                    "constraints": {},
                    "path": "0.png",
                    "contentHash": "abc123",
                }
            ],
        }

        summary = MODULE._generate_summary(manifest)

        self.assertEqual(summary["layers"][0]["layerId"], 205)
        self.assertEqual(summary["layers"][0]["contentHash"], "abc123")

    def test_finds_duplicate_nonzero_layer_ids(self):
        duplicates = MODULE._find_duplicate_layer_ids(
            [{"layerId": 10}, {"layerId": None}, {"layerId": 20}, {"layerId": 10}]
        )

        self.assertEqual(duplicates, [10])

    def test_text_content_hash_tracks_characters_only(self):
        expected = hashlib.sha256("Hello\nWorld".encode("utf-8")).hexdigest()

        self.assertEqual(MODULE._text_content_hash("Hello\r\nWorld"), expected)


if __name__ == "__main__":
    unittest.main()
