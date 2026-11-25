import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from verify_psd_visual import compare


class PsdVisualVerificationTests(unittest.TestCase):
    def test_reports_missing_group_style_and_keeps_a_final_screenshot_and_diff(self):
        manifest = {"layers": [
            {"layerId": 3, "name": "Amount group", "mode": "image", "x": 20, "y": 20, "w": 66, "h": 45},
            {"layerId": 4, "name": "Amount", "mode": "text", "visible": False, "compositeLayerId": 3},
            {"layerId": 5, "name": "Another label", "mode": "text", "visible": False, "compositeLayerId": 3},
        ]}
        with TemporaryDirectory() as directory:
            root = Path(directory)
            reference = Image.new("RGB", (120, 100), "#415293")
            draw = ImageDraw.Draw(reference)
            draw.rectangle((20, 20, 85, 64), fill="#3F2C2C")
            draw.rectangle((25, 25, 80, 59), fill="#FFD56A")
            broken = reference.copy()
            ImageDraw.Draw(broken).rectangle((20, 49, 85, 64), fill="#415293")
            reference.save(root / "reference.png")
            broken.save(root / "broken.png")

            report = compare(manifest, root / "reference.png", root / "broken.png", root / "diff")
            self.assertEqual((report["status"], report["differenceCount"]), ("differences", 1))
            self.assertEqual(report["regions"][0]["layerId"], 3)
            self.assertTrue(Path(report["regions"][0]["comparisonPath"]).is_file())
            self.assertEqual(Path(report["screenshotPath"]).read_bytes(), (root / "broken.png").read_bytes())

            passed = compare(manifest, root / "reference.png", root / "reference.png", root / "pass")
            self.assertEqual((passed["status"], passed["differenceCount"]), ("passed", 0))


if __name__ == "__main__":
    unittest.main()
