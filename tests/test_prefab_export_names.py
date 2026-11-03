import base64
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image


SCRIPTS = Path(__file__).resolve().parents[1] / "ai" / "skills" / "figma-to-prefab" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import gen_spec
import name_utils
import auto_componentset_specs as componentsets


class PrefabExportNamingTests(unittest.TestCase):
    def test_identifier_annotation_and_brackets_are_removed_without_translation(self):
        for raw, expected in (
            ("[cat_header｜顶部白猫｜原图插画]", "cat_header"),
            (" [cat_header | 顶部白猫 | 原图插画] ", "cat_header"),
            ("[[cat_header｜顶部白猫]]", "cat_header"),
            ("cat_header", "cat_header"),
            ("顶部白猫", "顶部白猫"),
            ("[顶部白猫｜原图插画]", "顶部白猫"),
        ):
            with self.subTest(raw=raw):
                self.assertEqual(name_utils.extract_identifier_name(raw), expected)

    def test_only_actual_containers_get_brackets_including_root(self):
        raw = "[cat_header｜顶部白猫｜原图插画]"
        self.assertEqual(name_utils.unity_node_name(raw, False, "screen", has_children=False), "cat_header")
        self.assertEqual(name_utils.unity_node_name(raw, False, "screen", has_children=True), "[cat_header]")
        self.assertEqual(name_utils.unity_node_name(raw, True, "cat_header", has_children=False), "cat_header")
        self.assertEqual(name_utils.unity_node_name(raw, True, "cat_header", has_children=True), "[cat_header]")

    def test_png_names_use_identifier_without_annotation_or_brackets(self):
        self.assertEqual(name_utils.sanitize_name("[cat_header｜顶部白猫｜原图插画]"), "cat_header")
        self.assertEqual(name_utils.sanitize_name("[cat_header | 顶部白猫]"), "cat_header")
        self.assertEqual(name_utils.sanitize_name("[顶部白猫]"), "顶部白猫")
        self.assertEqual(name_utils.sanitize_name("96_[cat_header｜顶部白猫]"), "cat_header")

    @staticmethod
    def node(node_id, name, kind="FRAME", children=(), **extra):
        return {"id": node_id, "name": name, "type": kind, "childIds": list(children),
                "bounds": {"x": 0, "y": 0, "width": 10, "height": 10}, **extra}

    @staticmethod
    def image_export(node_id, color):
        output = io.BytesIO()
        Image.new("RGBA", (10, 10), color).save(output, "PNG")
        raw = output.getvalue()
        return {"nodeId": node_id, "width": 10, "height": 10, "base64": base64.b64encode(raw).decode("ascii"),
                "imageHash": "hash-" + node_id}, raw

    def build(self, nodes, exports=(), common_prefabs=None):
        with tempfile.TemporaryDirectory(prefix="prefab-export-names-") as directory:
            root = Path(directory)
            node_data = {"root": {"id": nodes[0]["id"], "name": nodes[0]["name"]},
                         "rootBounds": nodes[0]["bounds"], "fileKey": "file", "nodes": nodes}
            node_path = root / "figma_node_manifest.json"
            node_path.write_text(json.dumps(node_data, ensure_ascii=False), encoding="utf-8")
            image_path = root / "image_export_manifest.json"
            image_path.write_text(json.dumps({"exports": list(exports)}), encoding="utf-8")
            original_nodes = node_path.read_bytes()
            original_images = image_path.read_bytes()
            with patch.object(gen_spec, "scan_common_prefabs", return_value=common_prefabs or {}):
                spec, plan, review = gen_spec.build_spec(
                    root, "Assets/Exports/screen_root/Prefab/screen_root.prefab", "Assets/Exports/screen_root/Texture/",
                    "screen_root", {}, disable_common_texture_reuse=True, disable_common_prefab_reuse=True,
                )
            self.assertEqual(node_path.read_bytes(), original_nodes)
            self.assertEqual(image_path.read_bytes(), original_images)
            return spec, plan, review

    def test_real_spec_tree_names_follow_emitted_children_and_preserve_chinese_text(self):
        image, image_raw = self.image_export("1:3", (255, 0, 0, 255))
        nodes = [
            self.node("1:1", "[screen_root｜主页]", children=("1:2", "1:4", "1:5")),
            self.node("1:2", "[cat_group｜角色组]", children=("1:3",)),
            self.node("1:3", "[cat_header｜顶部白猫｜原图插画]", "RECTANGLE", fills=[{"type": "IMAGE"}]),
            self.node("1:4", "[empty_group｜空容器]"),
            self.node("1:5", "[title_text | 标题]", "TEXT", characters="欢迎来到猫咪小店", fontSize=24),
        ]
        spec, plan, _ = self.build(nodes, [image])
        self.assertEqual([node["name"] for node in spec["nodes"]],
                         ["[screen_root]", "[cat_group]", "cat_header", "empty_group", "title_text"])
        self.assertEqual(spec["nodes"][4]["text"], "欢迎来到猫咪小店")
        self.assertEqual(spec["images"][0]["fileName"], "cat_header.png")
        self.assertEqual(plan["images"][0]["imageHash"], "hash-1:3")
        self.assertEqual(plan["images"][0]["expectedMD5"], hashlib.md5(image_raw).hexdigest())
        self.assertEqual(plan["manifestProvenance"]["rootName"], "[screen_root｜主页]")

    def test_folded_nine_slice_is_a_leaf_even_though_figma_had_children(self):
        image, _ = self.image_export("2:2", (0, 255, 0, 255))
        nodes = [
            self.node("2:1", "[screen_root｜主页]", children=("2:2",)),
            self.node("2:2", "[button_bg｜按钮背景]", children=("2:3", "2:4")),
            self.node("2:3", "__slice_left", "RECTANGLE", bounds={"x": 0, "y": 0, "width": 2, "height": 10}),
            self.node("2:4", "__slice_right", "RECTANGLE", bounds={"x": 8, "y": 0, "width": 2, "height": 10}),
        ]
        spec, _, _ = self.build(nodes, [image])
        self.assertEqual(len(spec["nodes"]), 2)
        self.assertEqual(spec["nodes"][1]["childIndices"], [])
        self.assertEqual(spec["nodes"][1]["name"], "button_bg")
        self.assertEqual(spec["nodes"][1]["imageType"], "Sliced")

    def test_root_without_emitted_children_has_no_brackets(self):
        spec, _, _ = self.build([self.node("3:1", "[screen_root｜空根节点]")])
        self.assertEqual(spec["nodes"][0]["name"], "screen_root")
        self.assertEqual(spec["prefabName"], "screen_root")
        self.assertEqual(spec["prefabPath"], "Assets/Exports/screen_root/Prefab/screen_root.prefab")

    def test_image_instance_source_children_do_not_make_exported_image_a_container(self):
        image, raw = self.image_export("6:3", (1, 2, 3, 255))
        nodes = [self.node("6:1", "[screen_root｜页面]", children=("6:2",)),
                 self.node("6:2", "[cat_header｜顶部白猫]", "INSTANCE", children=("6:3",)),
                 self.node("6:3", "[source_image｜源图]", "RECTANGLE", fills=[{"type": "IMAGE"}])]
        spec, plan, _ = self.build(nodes, [image])
        self.assertEqual([node["name"] for node in spec["nodes"]], ["[screen_root]", "cat_header"])
        self.assertEqual(spec["nodes"][1]["childIndices"], [])
        self.assertEqual(spec["images"][0]["fileName"], "cat_header.png")
        self.assertEqual(plan["images"][0]["expectedMD5"], hashlib.md5(raw).hexdigest())

    def test_reused_prefab_keeps_reference_and_does_not_duplicate_source_children(self):
        nodes = [self.node("7:1", "[screen_root｜页面]", children=("7:2",)),
                 self.node("7:2", "[reused_card｜复用卡片]", "INSTANCE", children=("7:3",),
                           component={"componentName": "Common_Card"}),
                 self.node("7:3", "source_child")]
        spec, _, _ = self.build(nodes, common_prefabs={"Common_Card": "Assets/Common/Card.prefab"})
        instance = spec["nodes"][1]
        self.assertEqual(instance["name"], "reused_card")
        self.assertEqual(instance["type"], "PrefabInstance")
        self.assertEqual(instance["childIndices"], [])
        self.assertEqual(spec["prefabInstances"][0]["sourcePrefabPath"], "Assets/Common/Card.prefab")

    def test_component_variants_and_visual_nodes_use_actual_exported_children(self):
        image, image_raw = self.image_export("4:2", (0, 0, 255, 255))
        nodes = [
            self.node("4:1", "[card_on｜开启]", "INSTANCE", children=("4:2",), component={"componentSetName": "card_switch｜卡片切换"}),
            self.node("4:2", "[icon_leaf｜图标]", "RECTANGLE", fills=[{"type": "IMAGE"}]),
            self.node("4:3", "[card_off | 关闭]", "INSTANCE", component={"componentSetName": "card_switch｜卡片切换"}),
        ]
        builder = componentsets.ComponentSetSpecBuilder(nodes, [image], "Assets/Exports/card_switch/Texture/")
        spec, images = builder.build_component_spec("card_switch", [nodes[0], nodes[2]], "Assets/Exports/card_switch/Prefab/card_switch.prefab")
        self.assertEqual([node["name"] for node in spec["nodes"]],
                         ["[card_switch]", "[Variant_card_on]", "icon_leaf", "Variant_card_off"])
        self.assertEqual(spec["images"][0]["fileName"], "icon_leaf.png")
        self.assertEqual(images[0]["expectedMD5"], hashlib.md5(image_raw).hexdigest())

    def test_component_rewrite_matches_identifier_names_without_annotation(self):
        nodes = [
            self.node("5:1", "[card_on｜开启]", "INSTANCE", component={"componentSetName": "card_switch｜卡片切换"}),
            self.node("5:2", "[card_off | 关闭]", "INSTANCE", component={"componentSetName": "card_switch｜卡片切换"}),
        ]
        builder = componentsets.ComponentSetSpecBuilder(nodes, [], "Assets/Exports/Texture/")
        groups, _ = componentsets.find_component_groups(builder)
        spec = {"nodes": [{"name": "card_on", "type": "Image", "rect": {}, "childIndices": []},
                          {"name": "card_off", "type": "Panel", "rect": {}, "childIndices": []}]}
        rewritten, instances, errors = componentsets.rewrite_main_spec_with_component_sets(spec, groups, "Assets/Exports/Prefab")
        self.assertEqual(errors, [])
        self.assertEqual(len(instances), 2)
        self.assertEqual([node["name"] for node in rewritten["nodes"]], ["[card_on]", "[card_off]"])
        self.assertEqual([node["activeVariant"] for node in rewritten["nodes"]], ["Variant_card_on", "Variant_card_off"])


if __name__ == "__main__":
    unittest.main()
