import base64
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from process_images import validate_export_health_contract


PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 24).decode("ascii")


class ImageHealthTests(unittest.TestCase):
    def test_accepts_valid_source_and_duplicate(self):
        exports = [
            {"id": "img_0", "width": 4, "height": 4, "byteLength": 32, "base64": PNG},
            {"id": "img_1", "duplicateOf": "img_0", "health": {"status": "repaired", "reason": "duplicateReused"}},
        ]
        self.assertEqual(validate_export_health_contract(exports), [])

    def test_blocks_dangling_duplicate(self):
        errors = validate_export_health_contract([{"id": "img_1", "duplicateOf": "missing"}])
        self.assertEqual(errors[0]["code"], "danglingDuplicate")

    def test_blocks_zero_size_and_invalid_png(self):
        errors = validate_export_health_contract([
            {"id": "img_0", "width": 0, "height": 0, "byteLength": 3, "base64": "eHl6"}
        ])
        self.assertEqual(errors[0]["code"], "invalidImagePayload")

    def test_blocks_explicit_health_failure(self):
        errors = validate_export_health_contract([
            {"id": "img_0", "health": {"status": "blocked", "reason": "imageHashNotFound"}}
        ])
        self.assertEqual(errors[0]["code"], "imageExportBlocked")


if __name__ == "__main__":
    unittest.main()
