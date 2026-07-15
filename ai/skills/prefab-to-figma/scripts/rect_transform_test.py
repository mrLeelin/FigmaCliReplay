"""rect_transform.py 单元测试，覆盖 16 种 RectTransform 场景。"""
from __future__ import annotations

import math
import pytest
from rect_transform import Rect, resolve_rect


# ============================================================================
# 测试用例 1: 居中锚点元素
# ============================================================================
class TestCenterAnchored:
    """测试 anchor 0.5,0.5 的居中元素。"""

    def test_center_in_200x200(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 200, 200).rounded()
        # 居中: x = (200-100)/2 = 50, y = 200 - (200-50)/2 = 200 - 75 = 125
        # 但 y 是从顶部算: y = 200 - max(bottom, top)
        # bottom = pivotY - pivot.y * baseHeight = 100 - 0.5*50 = 75
        # top = pivotY + (1-pivot.y) * baseHeight = 100 + 0.5*50 = 125
        # y = 200 - 125 = 75
        assert rect == Rect(50, 75, 100, 50, 0)

    def test_center_in_1080x1920(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 200, "y": 100},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 1080, 1920).rounded()
        # x = (1080-200)/2 = 440
        # y = 1920 - (1920-100)/2 = 1920 - 910 = 1010
        assert rect == Rect(440, 910, 200, 100, 0)


# ============================================================================
# 测试用例 2: 左上角锚点
# ============================================================================
class TestTopLeftAnchored:
    """测试 anchor 0,0 的左上角元素。"""

    def test_top_left(self):
        fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 0, "y": 0},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0, "y": 0},
            "m_AnchoredPosition": {"x": 10, "y": -10},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 1080, 1920).rounded()
        # pivotX = 0 + 0 + 10 = 10
        # pivotY = 0 + 0 + (-10) = -10
        # left = 10 - 0 = 10, right = 10 + 100 = 110
        # bottom = -10 - 0 = -10, top = -10 + 50 = 40
        # x = min(10, 110) = 10
        # y = 1920 - max(-10, 40) = 1920 - 40 = 1880
        assert rect == Rect(10, 1880, 100, 50, 0)


# ============================================================================
# 测试用例 3: 右下角锚点
# ============================================================================
class TestBottomRightAnchored:
    """测试 anchor 1,1 的右下角元素。"""

    def test_bottom_right(self):
        fields = {
            "m_AnchorMin": {"x": 1, "y": 1},
            "m_AnchorMax": {"x": 1, "y": 1},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 1, "y": 1},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 1080, 1920).rounded()
        # pivotX = 1080 + 0 = 1080
        # pivotY = 1920 + 0 = 1920
        # left = 1080 - 100 = 980, right = 1080
        # bottom = 1920 - 50 = 1870, top = 1920
        # x = 980, y = 1920 - 1920 = 0
        assert rect == Rect(980, 0, 100, 50, 0)


# ============================================================================
# 测试用例 4: 拉伸填充元素
# ============================================================================
class TestStretchFill:
    """测试 anchor 0,0 到 1,1 的拉伸填充元素。"""

    def test_stretch_fill(self):
        fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 1, "y": 1},
            "m_SizeDelta": {"x": 0, "y": 0},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 1080, 1920).rounded()
        assert rect == Rect(0, 0, 1080, 1920, 0)


# ============================================================================
# 测试用例 5: 部分拉伸（仅水平）
# ============================================================================
class TestPartialStretch:
    """测试仅水平拉伸的元素。"""

    def test_horizontal_stretch(self):
        fields = {
            "m_AnchorMin": {"x": 0, "y": 0.5},
            "m_AnchorMax": {"x": 1, "y": 0.5},
            "m_SizeDelta": {"x": 0, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 1080, 1920).rounded()
        # 水平拉伸: width = 1080
        # 垂直居中: y = 1920 - (1920 - 50)/2 = 1920 - 935 = 985
        assert rect == Rect(0, 935, 1080, 50, 0)


# ============================================================================
# 测试用例 6: 非零 Pivot 点
# ============================================================================
class TestNonZeroPivot:
    """测试非零 pivot 点的元素。"""

    def test_pivot_bottom_left(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0, "y": 0},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 200, 200).rounded()
        # pivotX = 100, pivotY = 100
        # left = 100 - 0 = 100, right = 100 + 100 = 200
        # bottom = 100 - 0 = 100, top = 100 + 50 = 150
        # x = 100, y = 200 - 150 = 50
        assert rect == Rect(100, 50, 100, 50, 0)


# ============================================================================
# 测试用例 7: 非零 anchoredPosition
# ============================================================================
class TestNonZeroAnchoredPosition:
    """测试带有偏移的元素。"""

    def test_with_offset(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 20, "y": -30},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 200, 200).rounded()
        # pivotX = 100 + 20 = 120
        # pivotY = 100 + (-30) = 70
        # left = 120 - 50 = 70, right = 120 + 50 = 170
        # bottom = 70 - 25 = 45, top = 70 + 25 = 95
        # x = 70, y = 200 - 95 = 105
        assert rect == Rect(70, 105, 100, 50, 0)


# ============================================================================
# 测试用例 8: 非均匀缩放
# ============================================================================
class TestNonUniformScale:
    """测试 scaleX != scaleY 的非均匀缩放。"""

    def test_non_uniform_scale(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 2, "y": 0.5, "z": 1},
        }
        rect = resolve_rect(fields, 200, 200).rounded()
        # baseWidth = 100, baseHeight = 50
        # scaledWidth = 100 * 2 = 200, scaledHeight = 50 * 0.5 = 25
        # left = 100 - 0.5*200 = 0, right = 100 + 0.5*200 = 200
        # bottom = 100 - 0.5*25 = 87.5, top = 100 + 0.5*25 = 112.5
        # x = 0, y = 200 - 112.5 = 87.5
        assert rect == Rect(0, 87.5, 200, 25, 0)


# ============================================================================
# 测试用例 9: 负缩放（翻转）
# ============================================================================
class TestNegativeScale:
    """测试负缩放导致的翻转。"""

    def test_negative_scale_x(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": -1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 200, 200).rounded()
        # left = 100 - 0.5*100*(-1) = 100 + 50 = 150
        # right = 100 + 0.5*100*(-1) = 100 - 50 = 50
        # x = min(150, 50) = 50, width = abs(50-150) = 100
        assert rect.x == 50
        assert rect.width == 100


# ============================================================================
# 测试用例 10: 旋转
# ============================================================================
class TestRotation:
    """测试带旋转的元素。"""

    def test_90_degree_rotation(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
            "m_LocalRotation": {"x": 0, "y": 0, "z": 0.7071068, "w": 0.7071068},
        }
        rect = resolve_rect(fields, 200, 200)
        # 90 度旋转不影响 x, y, width, height，只影响 rotation_z
        assert rect.x == pytest.approx(50, abs=1e-3)
        assert rect.y == pytest.approx(75, abs=1e-3)
        assert rect.width == pytest.approx(100, abs=1e-3)
        assert rect.height == pytest.approx(50, abs=1e-3)
        assert rect.rotation_z == pytest.approx(90, abs=1)


# ============================================================================
# 测试用例 11: 深层嵌套（3 层）
# ============================================================================
class TestDeepNesting:
    """测试 3 层嵌套的坐标传递。"""

    def test_three_level_nesting(self):
        # 第 1 层: 拉伸填充
        root_fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 1, "y": 1},
            "m_SizeDelta": {"x": 0, "y": 0},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        root_rect = resolve_rect(root_fields, 1080, 1920)

        # 第 2 层: 居中元素
        child_fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 200, "y": 100},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        child_rect = resolve_rect(child_fields, root_rect.width, root_rect.height)

        # 第 3 层: 左上角元素
        grandchild_fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 0, "y": 0},
            "m_SizeDelta": {"x": 50, "y": 50},
            "m_Pivot": {"x": 0, "y": 0},
            "m_AnchoredPosition": {"x": 10, "y": -10},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        grandchild_rect = resolve_rect(grandchild_fields, child_rect.width, child_rect.height)

        # 验证每层的尺寸正确传递
        assert root_rect.width == 1080
        assert root_rect.height == 1920
        assert child_rect.width == 200
        assert child_rect.height == 100
        assert grandchild_rect.width == 50
        assert grandchild_rect.height == 50


# ============================================================================
# 测试用例 12: 精度 - 应产生精确整数
# ============================================================================
class TestPrecisionInteger:
    """测试应产生精确整数的结果。"""

    def test_exact_integer_result(self):
        fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 0, "y": 0},
            "m_SizeDelta": {"x": 100, "y": 100},
            "m_Pivot": {"x": 0, "y": 0},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 100, 100).rounded()
        # 应该是精确整数
        assert rect.x == 0
        assert rect.y == 0
        assert rect.width == 100
        assert rect.height == 100


# ============================================================================
# 测试用例 13: 精度 - 已知分数结果
# ============================================================================
class TestPrecisionFractional:
    """测试已知分数结果的精度。"""

    def test_fractional_result(self):
        fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 0, "y": 0},
            "m_SizeDelta": {"x": 100, "y": 100},
            "m_Pivot": {"x": 0, "y": 0},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 300, 300).rounded()
        # 这个场景应该产生精确整数
        assert rect.width == 100
        assert rect.height == 100


# ============================================================================
# 测试用例 14: 边界情况 - 零尺寸父节点
# ============================================================================
class TestZeroSizeParent:
    """测试零尺寸父节点。"""

    def test_zero_size_parent(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 0, 0).rounded()
        # 父节点为 0 时，元素应位于原点
        assert rect.x == 0
        assert rect.y == 0
        assert rect.width == 100
        assert rect.height == 50


# ============================================================================
# 测试用例 15: 边界情况 - 极小父节点
# ============================================================================
class TestTinyParent:
    """测试极小父节点 (1x1)。"""

    def test_tiny_parent(self):
        fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 0, "y": 0},
            "m_SizeDelta": {"x": 10, "y": 10},
            "m_Pivot": {"x": 0, "y": 0},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 1, 1).rounded()
        assert rect.width == 10
        assert rect.height == 10


# ============================================================================
# 测试用例 16: 边界情况 - 极大父节点
# ============================================================================
class TestLargeParent:
    """测试极大父节点 (10000x10000)。"""

    def test_large_parent(self):
        fields = {
            "m_AnchorMin": {"x": 0.5, "y": 0.5},
            "m_AnchorMax": {"x": 0.5, "y": 0.5},
            "m_SizeDelta": {"x": 100, "y": 50},
            "m_Pivot": {"x": 0.5, "y": 0.5},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 10000, 10000).rounded()
        # x = (10000-100)/2 = 4950
        # y = 10000 - (10000-50)/2 = 10000 - 4975 = 5025
        assert rect == Rect(4950, 4975, 100, 50, 0)


# ============================================================================
# 精度验证测试
# ============================================================================
class TestPrecisionVerification:
    """验证精度提升到 6 位小数后的正确性。"""

    def test_six_decimal_precision(self):
        fields = {
            "m_AnchorMin": {"x": 0, "y": 0},
            "m_AnchorMax": {"x": 0, "y": 0},
            "m_SizeDelta": {"x": 100, "y": 100},
            "m_Pivot": {"x": 0, "y": 0},
            "m_AnchoredPosition": {"x": 0, "y": 0},
            "m_LocalScale": {"x": 1, "y": 1, "z": 1},
        }
        rect = resolve_rect(fields, 300, 300)
        rounded = rect.rounded()
        # 验证精度为 6 位小数
        assert rounded.x == round(rect.x, 6)
        assert rounded.y == round(rect.y, 6)
        assert rounded.width == round(rect.width, 6)
        assert rounded.height == round(rect.height, 6)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
