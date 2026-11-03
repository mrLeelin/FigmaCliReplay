"""Behavioral checks for resource partitioning, compositing, and placement."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "compose_resources.py"
SPEC = importlib.util.spec_from_file_location("compose_resources", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ResourceCompositionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.input = self.root / "input"
        self.input.mkdir()

    def layer(self, idx, color=(255, 0, 0, 255), **overrides):
        path = f"layer-{idx}.png"
        Image.new("RGBA", (2, 2), color).save(self.input / path)
        return {"idx": idx, "path": path, "x": 0, "y": 0, "w": 2, "h": 2,
                "opacity": 1, "visible": True, **overrides}

    @staticmethod
    def resource(resource_id, members):
        return {"id": resource_id, "name": resource_id, "members": members,
                "reason": "independently reusable whole object"}

    def run_composition(self, layers, resources, ppu=2):
        manifest = {"canvas": {"width": 8, "height": 8}, "layers": layers}
        plan = {"granularity": "resource", "resources": resources}
        manifest_path = self.input / "manifest.json"
        plan_path = self.root / "plan.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        self.out = self.root / "output"
        result = MODULE.compose(manifest_path, plan_path, self.out, ppu)
        output = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        return result, output

    def test_alpha_opacity_and_source_array_order_are_preserved(self):
        layers = [self.layer(9, (255, 0, 0, 128), opacity=0.5),
                  self.layer(3, (0, 0, 255, 128))]
        report, output = self.run_composition(layers, [self.resource("whole", [3, 9])])
        with Image.open(self.out / output["layers"][0]["path"]) as image:
            expected = Image.alpha_composite(Image.new("RGBA", (1, 1), (255, 0, 0, 64)),
                                             Image.new("RGBA", (1, 1), (0, 0, 255, 128)))
            self.assertEqual(image.getpixel((1, 1)), expected.getpixel((0, 0)))
        self.assertEqual(output["layers"][0]["opacity"], 1)
        self.assertTrue(report["difference"]["pixelsIdentical"])
        mapping = json.loads((self.out / "resource-map.json").read_text(encoding="utf-8"))
        self.assertEqual(mapping["resources"][0]["sourceMembersInStackingOrder"], [9, 3])

    def test_single_resource_copies_bytes_and_fractional_placement(self):
        source = self.layer(7, x=0.125, y=-0.375, w=1.75, h=2.125,
                            opacity=0.625, visible=False)
        report, manifest = self.run_composition([source], [self.resource("whole", [7])])
        output = manifest["layers"][0]
        for key in ("x", "y", "w", "h", "opacity", "visible"):
            self.assertEqual(output[key], source[key])
        self.assertEqual((self.input / source["path"]).read_bytes(),
                         (self.out / output["path"]).read_bytes())
        self.assertTrue(report["difference"]["pixelsIdentical"])

    def test_all_hidden_group_retains_asset_but_stays_hidden(self):
        layers = [self.layer(1, visible=False), self.layer(2, (0, 255, 0, 128), visible=False)]
        report, manifest = self.run_composition(layers, [self.resource("hidden", [1, 2])])
        layer = manifest["layers"][0]
        self.assertFalse(layer["visible"])
        with Image.open(self.out / layer["path"]) as image:
            self.assertGreater(image.getchannel("A").getextrema()[1], 0)
        with Image.open(self.out / "after.png") as image:
            self.assertEqual(image.getchannel("A").getextrema(), (0, 0))
        self.assertTrue(report["difference"]["pixelsIdentical"])

    def test_noncontiguous_disjoint_layers_can_merge_without_reordering_overlap(self):
        layers = [self.layer(10), self.layer(11, (0, 255, 0, 255), x=5),
                  self.layer(12, (0, 0, 255, 128))]
        report, manifest = self.run_composition(layers, [self.resource("whole", [10, 12]),
                                                        self.resource("separate", [11])])
        self.assertEqual([l["name"] for l in manifest["layers"]], ["separate", "whole"])
        self.assertTrue(report["difference"]["pixelsIdentical"])

    def test_noncontiguous_overlap_is_rejected_before_writing(self):
        layers = [self.layer(1), self.layer(2), self.layer(3)]
        with self.assertRaisesRegex(ValueError, "crosses overlapping"):
            self.run_composition(layers, [self.resource("a", [1, 3]), self.resource("b", [2])])
        self.assertFalse(self.out.exists())

    def test_first_anchor_keeps_button_plate_below_separate_price(self):
        layers = [self.layer(11, w=8),
                  self.layer(12, (0, 255, 0, 255), x=2),
                  self.layer(13, (0, 0, 255, 255), x=6)]
        button = {**self.resource("button", [11, 13]), "anchor": "first"}
        report, manifest = self.run_composition(layers, [self.resource("price", [12]), button])
        self.assertEqual([layer["name"] for layer in manifest["layers"]], ["button", "price"])
        self.assertTrue(report["difference"]["pixelsIdentical"])
        mapping = json.loads((self.out / "resource-map.json").read_text(encoding="utf-8"))
        self.assertEqual(mapping["resources"][0]["anchor"], "first")
        self.assertEqual(mapping["resources"][0]["anchorSourceOrdinal"], 0)
        with Image.open(self.out / "after.png") as image:
            self.assertEqual(image.getpixel((5, 1)), (0, 255, 0, 255))

    def test_first_anchor_rejects_overlapping_icon_crossing_price(self):
        layers = [self.layer(1, w=8), self.layer(2, x=2), self.layer(3, x=2)]
        with self.assertRaisesRegex(ValueError, "crosses overlapping"):
            self.run_composition(layers, [{**self.resource("a", [1, 3]), "anchor": "first"},
                                         self.resource("b", [2])])
        self.assertFalse(self.out.exists())

    def test_unknown_anchor_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "anchor must be"):
            self.run_composition([self.layer(1)],
                                 [{**self.resource("a", [1]), "anchor": "middle"}])
        self.assertFalse(self.out.exists())

    def test_mixed_visibility_is_rejected_before_writing(self):
        with self.assertRaisesRegex(ValueError, "mixes hidden"):
            self.run_composition([self.layer(1), self.layer(2, visible=False)],
                                 [self.resource("a", [1, 2])])
        self.assertFalse(self.out.exists())

    def test_complete_unique_partition_and_resource_ids(self):
        invalid = [
            ([self.resource("a", [1])], "Unassigned"),
            ([self.resource("a", [1, 1]), self.resource("b", [2])], "Duplicate ownership"),
            ([self.resource("a", [1, 3]), self.resource("b", [2])], "Unknown member"),
            ([self.resource("a", [1]), self.resource("a", [2])], "duplicate resource id"),
            ([self.resource("a", [True]), self.resource("b", [2])], "Unknown member"),
        ]
        for resources, message in invalid:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    self.run_composition([self.layer(1), self.layer(2)], resources)
                self.assertFalse(self.out.exists())

    def test_invalid_geometry_opacity_and_duplicate_idx(self):
        for field, value in [("x", float("nan")), ("y", float("inf")),
                             ("w", 0), ("h", -1), ("opacity", 1.01),
                             ("opacity", True), ("visible", "false")]:
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    self.run_composition([self.layer(1, **{field: value})],
                                         [self.resource("a", [1])])
                self.assertFalse(self.out.exists())
        with self.assertRaisesRegex(ValueError, "duplicate layer idx"):
            self.run_composition([self.layer(1), self.layer(1)], [self.resource("a", [1])])

    def test_fractional_merged_bounds_align_to_shared_sampling_grid(self):
        layers = [self.layer(1, x=0.125, y=0.375, w=1.5, h=1.25),
                  self.layer(2, (0, 255, 0, 128), x=1.375, y=0.625, w=1.5, h=1.25)]
        report, manifest = self.run_composition(layers, [self.resource("a", [1, 2])], ppu=4)
        layer = manifest["layers"][0]
        self.assertEqual([layer[k] for k in ("x", "y", "w", "h")], [0, 0.25, 3, 1.75])
        self.assertTrue(report["difference"]["pixelsIdentical"])

    def test_existing_nonempty_output_is_never_overwritten(self):
        layers, resources = [self.layer(1)], [self.resource("a", [1])]
        self.run_composition(layers, resources)
        marker = self.out / "keep.txt"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "absent or empty"):
            self.run_composition(layers, resources)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main()
