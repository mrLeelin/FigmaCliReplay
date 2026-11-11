import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import auto_componentset_specs  # noqa: E402
import gen_spec  # noqa: E402
from text_outline import (  # noqa: E402
    cached_font_sdf_metrics,
    compute_text_outline,
    load_font_sdf_metrics,
    normalize_stroke_align,
    stroke_align_signature_token,
)


def stroked_text(stroke_align=None, stroke_weight=4, effects=None):
    node = {
        "type": "TEXT",
        "strokes": [{"type": "SOLID", "visible": True, "color": {"r": 0.427, "g": 0.082, "b": 0.082}}],
        "strokeWeight": stroke_weight,
        "effects": effects or [],
    }
    if stroke_align is not None:
        node["strokeAlign"] = stroke_align
    return node


def write_unity_project(root: Path, point_size="58", padding="10", configured=True):
    """构造最小 Unity 工程：导入设置 + 与真实 TMP 字体资产同格式的 YAML 片段。"""
    (root / "ProjectSettings").mkdir(parents=True)
    asset = "Assets/Font/CommonFont.asset"
    settings = {"commonFontAsset": asset if configured else ""}
    (root / "ProjectSettings" / "FigmaBridgeImportSettings.json").write_text(json.dumps(settings), encoding="utf-8")
    (root / "Assets" / "Font").mkdir(parents=True)
    (root / asset).write_text(
        "MonoBehaviour:\n"
        "  m_Name: CommonFont\n"
        "  m_fontInfo:\n"
        "    m_PointSize: 12\n"
        "  m_FaceInfo:\n"
        "    m_FamilyName: GROBOLD\n"
        f"    m_PointSize: {point_size}\n"
        "    m_Scale: 1\n"
        f"  m_AtlasPadding: {padding}\n"
        "  m_FontWeightTable:\n"
        "  - regularTypeface: {fileID: 0}\n"
        "    PointSize: 0\n",
        encoding="utf-8",
    )


class CacheResetTestCase(unittest.TestCase):
    def setUp(self):
        cached_font_sdf_metrics.cache_clear()


class TextOutlineMathTests(CacheResetTestCase):
    def test_outside_stroke_keeps_glyph_face_and_matches_calibration(self):
        # 342,553,552：4px 外描边、字号 42 → 网格实验最优约 0.27~0.30
        self.assertEqual(compute_text_outline(4, 42, "OUTSIDE"), (0.28, 0.28))
        # 122/50：4px 外描边、字号 35 → 网格实验最优约 0.30~0.33
        self.assertEqual(compute_text_outline(4, 35, "OUTSIDE"), (0.33, 0.33))

    def test_center_and_inside_strokes_share_width_and_move_face_dilate(self):
        self.assertEqual(compute_text_outline(4, 42, "CENTER"), (0.28, 0.0))
        self.assertEqual(compute_text_outline(4, 42, "INSIDE"), (0.28, -0.28))

    def test_missing_alignment_keeps_legacy_formula(self):
        self.assertEqual(compute_text_outline(2, 50, ""), (0.09, 0.045))
        self.assertEqual(compute_text_outline(4, 35, None), (0.27, 0.135))

    def test_custom_font_metrics_change_width(self):
        metrics = {"pointSize": 90.0, "padding": 9.0}
        self.assertEqual(compute_text_outline(4, 40, "OUTSIDE", metrics), (0.5, 0.5))

    def test_width_is_clamped_and_invalid_input_returns_zero(self):
        self.assertEqual(compute_text_outline(40, 10, "OUTSIDE"), (1.0, 1.0))
        self.assertEqual(compute_text_outline(0, 42, "OUTSIDE"), (0.0, 0.0))
        self.assertEqual(compute_text_outline(4, 0, "OUTSIDE"), (0.0, 0.0))

    def test_alignment_normalization_and_signature_token(self):
        self.assertEqual(normalize_stroke_align("outside"), "OUTSIDE")
        self.assertEqual(normalize_stroke_align("MIXED"), "")
        self.assertEqual(stroke_align_signature_token("OUTSIDE"), "_a_out")
        self.assertEqual(stroke_align_signature_token("CENTER"), "_a_ctr")
        self.assertEqual(stroke_align_signature_token("INSIDE"), "_a_in")
        self.assertEqual(stroke_align_signature_token(""), "")


class FontMetricsTests(CacheResetTestCase):
    def test_reads_point_size_and_padding_from_configured_font_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            write_unity_project(Path(directory), point_size="90", padding="9")
            metrics = load_font_sdf_metrics(directory)
        self.assertEqual((metrics["pointSize"], metrics["padding"], metrics["source"]), (90.0, 9.0, "fontAsset"))
        self.assertEqual(metrics["fontAssetPath"], "Assets/Font/CommonFont.asset")

    def test_zero_metrics_fall_back_and_cache_returns_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            write_unity_project(Path(directory), point_size="0", padding="10")
            first = cached_font_sdf_metrics(directory)
            first["pointSize"] = 999
            second = cached_font_sdf_metrics(directory)
        self.assertEqual((second["pointSize"], second["source"]), (58.0, "default"))

    def test_falls_back_to_common_font_defaults_with_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = load_font_sdf_metrics(directory)
            write_unity_project(Path(directory), configured=False)
            unconfigured = load_font_sdf_metrics(directory)
        for metrics in (missing, unconfigured, load_font_sdf_metrics("")):
            self.assertEqual((metrics["pointSize"], metrics["padding"], metrics["source"]), (58.0, 10.0, "default"))
            self.assertTrue(metrics["reason"])


class GenSpecTextMaterialTests(CacheResetTestCase):
    def test_outside_stroke_material_carries_alignment_and_face_dilate(self):
        material = gen_spec.build_text_material_spec(stroked_text("OUTSIDE"), 42, {"pointSize": 58.0, "padding": 10.0})
        self.assertEqual(material["strokeAlign"], "OUTSIDE")
        self.assertEqual(material["outlineWidth"], 0.28)
        self.assertEqual(material["faceDilate"], 0.28)
        self.assertEqual(material["signature"], "o_6d1515ff_w_028_a_out_u_none_x_100_y_100_s_000_d_000")
        self.assertEqual(material["materialName"], "CommonFont_figma_" + material["signature"])

    def test_center_and_inside_materials_use_distinct_signatures(self):
        metrics = {"pointSize": 58.0, "padding": 10.0}
        center = gen_spec.build_text_material_spec(stroked_text("CENTER"), 42, metrics)
        inside = gen_spec.build_text_material_spec(stroked_text("INSIDE"), 42, metrics)
        self.assertEqual((center["faceDilate"], inside["faceDilate"]), (0.0, -0.28))
        self.assertIn("_w_028_a_ctr_", center["signature"])
        self.assertIn("_w_028_a_in_", inside["signature"])

    def test_tiny_aligned_stroke_drops_outline_and_alignment(self):
        shadow = [{"type": "DROP_SHADOW", "visible": True, "color": {"r": 0, "g": 0, "b": 0, "a": 1},
                   "offset": {"x": 0, "y": 3}, "radius": 0, "spread": 0}]
        self.assertEqual(compute_text_outline(0.01, 200, "OUTSIDE"), (0.0, 0.0))
        material = gen_spec.build_text_material_spec(stroked_text("OUTSIDE", 0.01, shadow), 200)
        self.assertFalse(material["hasOutline"])
        self.assertEqual((material["strokeAlign"], material["outlineWidth"], material["faceDilate"]), ("", 0.0, 0.0))
        self.assertNotIn("_a_", material["signature"])

    def test_legacy_manifest_without_alignment_keeps_old_signature(self):
        material = gen_spec.build_text_material_spec(stroked_text(), 35)
        self.assertEqual(material["strokeAlign"], "")
        self.assertEqual(material["outlineWidth"], 0.27)
        self.assertEqual(material["faceDilate"], 0.135)
        self.assertEqual(material["signature"], "o_6d1515ff_w_027_u_none_x_100_y_100_s_000_d_000")

    def test_shadow_only_text_has_no_alignment_token(self):
        shadow = [{"type": "DROP_SHADOW", "visible": True, "color": {"r": 0.56, "g": 0.01, "b": 0.01, "a": 1},
                   "offset": {"x": 0, "y": 3}, "radius": 0, "spread": 0}]
        node = stroked_text("OUTSIDE", stroke_weight=0, effects=shadow)
        material = gen_spec.build_text_material_spec(node, 50)
        self.assertFalse(material["hasOutline"])
        self.assertEqual((material["strokeAlign"], material["faceDilate"]), ("", 0.0))
        self.assertNotIn("_a_", material["signature"])

    def test_gen_spec_reads_font_metrics_from_unity_project(self):
        with tempfile.TemporaryDirectory() as directory:
            write_unity_project(Path(directory), point_size="90", padding="9")
            with patch.object(gen_spec, "UNITY_PROJECT", Path(directory)):
                material = gen_spec.build_text_material_spec(stroked_text("OUTSIDE"), 40)
        self.assertEqual((material["outlineWidth"], material["faceDilate"]), (0.5, 0.5))

    def test_audit_report_lists_alignment_and_warns_on_default_metrics(self):
        dedup = {"textMaterials": {"o_x_w_028_a_out": {"count": 1, "materialName": "m", "strokeAlign": "OUTSIDE",
                                                         "hasOutline": True}}}
        spec = {"nodes": [{"type": "Root", "childIndices": []}], "images": []}
        with tempfile.TemporaryDirectory() as directory, patch.object(gen_spec, "UNITY_PROJECT", Path(directory)):
            audit = gen_spec.build_audit_report(spec, {"images": []}, {}, [], dedup, {}, {})
        self.assertEqual(audit["summary"]["textOutlineFontMetrics"]["source"], "default")
        codes = [warning["code"] for warning in audit["warnings"]]
        self.assertIn("textOutlineFontMetricsFallback", codes)


class ComponentSetTextMaterialTests(CacheResetTestCase):
    def test_componentset_outline_matches_gen_spec(self):
        with tempfile.TemporaryDirectory() as directory:
            write_unity_project(Path(directory))
            with patch.dict(os.environ, {"FIGMA_UNITY_PROJECT": directory}), \
                    patch.object(gen_spec, "UNITY_PROJECT", Path(directory)):
                component = auto_componentset_specs.build_text_material_spec(stroked_text("OUTSIDE"), 35)
                main = gen_spec.build_text_material_spec(stroked_text("OUTSIDE"), 35)
        for key in ("outlineWidth", "faceDilate", "strokeAlign"):
            self.assertEqual(component[key], main[key], key)
        self.assertIn("_a_out_", component["signature"])

    def test_componentset_without_project_uses_default_metrics(self):
        env = {k: v for k, v in os.environ.items() if k != "FIGMA_UNITY_PROJECT"}
        with patch.dict(os.environ, env, clear=True):
            component = auto_componentset_specs.build_text_material_spec(stroked_text("OUTSIDE"), 42)
        self.assertEqual(component["signature"], "o_6d1515ff_w_028_a_out_u_none_x_100_y_100_s_000_d_000")
        self.assertEqual(component["faceDilate"], 0.28)

    def test_componentset_legacy_signature_is_unchanged(self):
        component = auto_componentset_specs.build_text_material_spec(stroked_text(), 35)
        self.assertEqual(component["signature"], "o_6d1515ff_w_027_u_none_x_100_y_100_s_000_d_000")
        self.assertEqual(component["faceDilate"], 0.135)


if __name__ == "__main__":
    unittest.main()
