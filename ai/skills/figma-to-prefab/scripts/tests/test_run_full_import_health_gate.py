import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from run_full_import import validate_image_manifest_health


class RunFullImportHealthGateTests(unittest.TestCase):
    def test_returns_blocking_errors_before_unity_write(self):
        manifest = {"exports": [{"id": "img_0", "width": 0, "height": 0, "byteLength": 0, "base64": ""}]}
        errors = validate_image_manifest_health(manifest)
        self.assertEqual(errors[0]["code"], "invalidImagePayload")

    def test_accepts_valid_manifest(self):
        import base64
        png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 24).decode("ascii")
        manifest = {"exports": [{"id": "img_0", "width": 2, "height": 2, "byteLength": 32, "base64": png}]}
        self.assertEqual(validate_image_manifest_health(manifest), [])


if __name__ == "__main__":
    unittest.main()
