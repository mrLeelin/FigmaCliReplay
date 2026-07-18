using System;
using System.Collections.Generic;
using TMPro;
using UnityEditor;
using UnityEngine;
using ZLog = MagicWarrior.Editor.FigmaBridge.BridgeLogger;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 快速路径修改器，使用 PrefabUtility 直接修改 Prefab 属性，
    /// 跳过完整的重新生成流程。
    /// 适用于 CanUseFastPath = true 的增量同步场景。
    /// </summary>
    public static class FastPathPatcher
    {
        /// <summary>
        /// 应用快速路径修改到指定 Prefab
        /// </summary>
        /// <param name="prefabPath">Prefab 资产路径</param>
        /// <param name="changeScopeResult">变更范围检测结果</param>
        /// <param name="newNodes">新的节点数据</param>
        /// <returns>是否成功应用所有修改</returns>
        public static bool Apply(
            string prefabPath,
            ChangeScopeResult changeScopeResult,
            NodeCompareSpec[] newNodes)
        {
            // 参数校验
            if (string.IsNullOrEmpty(prefabPath))
            {
                ZLog.LogWarning("[FastPathPatcher] prefabPath 为空，无法执行快速路径修改");
                return false;
            }

            if (changeScopeResult == null || changeScopeResult.Diffs == null || changeScopeResult.Diffs.Count == 0)
            {
                ZLog.LogWarning("[FastPathPatcher] changeScopeResult 为空或无差异，跳过修改");
                return true;
            }

            // 加载 Prefab 内容
            GameObject prefabRoot = PrefabUtility.LoadPrefabContents(prefabPath);
            if (prefabRoot == null)
            {
                ZLog.LogError($"[FastPathPatcher] 无法加载 Prefab: {prefabPath}");
                return false;
            }

            bool allSuccess = true;
            try
            {
                allSuccess = ApplyDiffs(prefabRoot, changeScopeResult.Diffs, newNodes);

                // 仅在全部成功时保存 Prefab
                if (allSuccess)
                {
                    PrefabUtility.SaveAsPrefabAsset(prefabRoot, prefabPath);
                }
            }
            catch (Exception ex)
            {
                ZLog.LogError($"[FastPathPatcher] 应用修改时发生异常: {ex.Message}");
                allSuccess = false;
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(prefabRoot);
            }

            return allSuccess;
        }

        /// <summary>
        /// 遍历所有差异并应用修改
        /// </summary>
        private static bool ApplyDiffs(GameObject prefabRoot, List<NodeDiff> diffs, NodeCompareSpec[] newNodes)
        {
            bool allSuccess = true;

            for (int i = 0; i < diffs.Count; i++)
            {
                var diff = diffs[i];
                if (diff == null) continue;

                // 通过节点名称查找目标 GameObject
                Transform target = FindChildByName(prefabRoot.transform, diff.NodeName);
                if (target == null)
                {
                    ZLog.LogWarning($"[FastPathPatcher] 未找到节点: {diff.NodeName}，跳过该修改");
                    allSuccess = false;
                    continue;
                }

                bool success = ApplySingleDiff(target, diff, newNodes);
                if (!success)
                {
                    allSuccess = false;
                }
            }

            return allSuccess;
        }

        /// <summary>
        /// 根据变更类型分发到对应的修改方法
        /// </summary>
        private static bool ApplySingleDiff(Transform target, NodeDiff diff, NodeCompareSpec[] newNodes)
        {
            switch (diff.ChangeType)
            {
                case "position":
                    return ApplyPositionChange(target, diff, newNodes);
                case "size":
                    return ApplySizeChange(target, diff, newNodes);
                case "text":
                    return ApplyTextChange(target, diff);
                case "fontSize":
                    return ApplyFontSizeChange(target, diff);
                case "color":
                    return ApplyColorChange(target, diff);
                default:
                    ZLog.LogWarning($"[FastPathPatcher] 不支持的变更类型: {diff.ChangeType}，节点: {diff.NodeName}");
                    return false;
            }
        }

        /// <summary>
        /// 应用位置变更：修改 RectTransform.anchoredPosition
        /// </summary>
        private static bool ApplyPositionChange(Transform target, NodeDiff diff, NodeCompareSpec[] newNodes)
        {
            var rectTransform = target as RectTransform;
            if (rectTransform == null)
            {
                ZLog.LogWarning($"[FastPathPatcher] 节点 {diff.NodeName} 没有 RectTransform 组件");
                return false;
            }

            // 优先从 newNodes 获取新坐标并通过 CoordinateTransformer 转换
            if (newNodes != null && diff.NodeIndex >= 0 && diff.NodeIndex < newNodes.Length)
            {
                var node = newNodes[diff.NodeIndex];
                float parentW = 0f;
                float parentH = 0f;
                var parentRect = rectTransform.parent as RectTransform;
                if (parentRect != null)
                {
                    parentW = parentRect.sizeDelta.x;
                    parentH = parentRect.sizeDelta.y;
                }

                var spec = CoordinateTransformer.Transform(node.x, node.y, node.w, node.h, parentW, parentH);
                rectTransform.anchoredPosition = new Vector2(spec.x, spec.y);
                return true;
            }

            // 回退：从 NewValue 解析坐标（格式："(x, y)"）
            if (TryParseVector2(diff.NewValue, out var newPos))
            {
                rectTransform.anchoredPosition = newPos;
                return true;
            }

            ZLog.LogWarning($"[FastPathPatcher] 无法解析位置值: {diff.NewValue}，节点: {diff.NodeName}");
            return false;
        }

        /// <summary>
        /// 应用尺寸变更：修改 RectTransform.sizeDelta
        /// </summary>
        private static bool ApplySizeChange(Transform target, NodeDiff diff, NodeCompareSpec[] newNodes)
        {
            var rectTransform = target as RectTransform;
            if (rectTransform == null)
            {
                ZLog.LogWarning($"[FastPathPatcher] 节点 {diff.NodeName} 没有 RectTransform 组件");
                return false;
            }

            // 优先从 newNodes 获取新尺寸
            if (newNodes != null && diff.NodeIndex >= 0 && diff.NodeIndex < newNodes.Length)
            {
                var node = newNodes[diff.NodeIndex];
                rectTransform.sizeDelta = new Vector2(node.w, node.h);
                return true;
            }

            // 回退：从 NewValue 解析尺寸（格式："(w, h)"）
            if (TryParseVector2(diff.NewValue, out var newSize))
            {
                rectTransform.sizeDelta = newSize;
                return true;
            }

            ZLog.LogWarning($"[FastPathPatcher] 无法解析尺寸值: {diff.NewValue}，节点: {diff.NodeName}");
            return false;
        }

        /// <summary>
        /// 应用文本内容变更：修改 TextMeshProUGUI.text
        /// </summary>
        private static bool ApplyTextChange(Transform target, NodeDiff diff)
        {
            var tmp = target.GetComponent<TextMeshProUGUI>();
            if (tmp == null)
            {
                ZLog.LogWarning($"[FastPathPatcher] 节点 {diff.NodeName} 没有 TextMeshProUGUI 组件");
                return false;
            }

            tmp.text = diff.NewValue ?? string.Empty;
            return true;
        }

        /// <summary>
        /// 应用字体大小变更：修改 TextMeshProUGUI.fontSize
        /// </summary>
        private static bool ApplyFontSizeChange(Transform target, NodeDiff diff)
        {
            var tmp = target.GetComponent<TextMeshProUGUI>();
            if (tmp == null)
            {
                ZLog.LogWarning($"[FastPathPatcher] 节点 {diff.NodeName} 没有 TextMeshProUGUI 组件");
                return false;
            }

            if (float.TryParse(diff.NewValue, out float newFontSize))
            {
                tmp.fontSize = newFontSize;
                return true;
            }

            ZLog.LogWarning($"[FastPathPatcher] 无法解析字体大小: {diff.NewValue}，节点: {diff.NodeName}");
            return false;
        }

        /// <summary>
        /// 应用颜色变更：修改 TextMeshProUGUI.color（解析十六进制字符串）
        /// </summary>
        private static bool ApplyColorChange(Transform target, NodeDiff diff)
        {
            var tmp = target.GetComponent<TextMeshProUGUI>();
            if (tmp == null)
            {
                ZLog.LogWarning($"[FastPathPatcher] 节点 {diff.NodeName} 没有 TextMeshProUGUI 组件");
                return false;
            }

            if (TryParseHexColor(diff.NewValue, out Color newColor))
            {
                tmp.color = newColor;
                return true;
            }

            ZLog.LogWarning($"[FastPathPatcher] 无法解析颜色值: {diff.NewValue}，节点: {diff.NodeName}");
            return false;
        }

        /// <summary>
        /// 递归查找子节点（按名称匹配，深度优先）
        /// </summary>
        private static Transform FindChildByName(Transform parent, string name)
        {
            if (string.IsNullOrEmpty(name)) return null;

            // 先尝试 Transform.Find（支持路径格式如 "Parent/Child"）
            var direct = parent.Find(name);
            if (direct != null) return direct;

            // 递归深度优先搜索
            return FindChildRecursive(parent, name);
        }

        /// <summary>
        /// 递归搜索子节点（深度优先）
        /// </summary>
        private static Transform FindChildRecursive(Transform parent, string name)
        {
            int childCount = parent.childCount;
            for (int i = 0; i < childCount; i++)
            {
                var child = parent.GetChild(i);
                if (string.Equals(child.name, name, StringComparison.Ordinal))
                {
                    return child;
                }

                var found = FindChildRecursive(child, name);
                if (found != null) return found;
            }

            return null;
        }

        /// <summary>
        /// 解析十六进制颜色字符串为 Color。
        /// 支持格式：#RRGGBB、#RRGGBBAA、RRGGBB、RRGGBBAA
        /// </summary>
        private static bool TryParseHexColor(string hexString, out Color color)
        {
            color = Color.white;
            if (string.IsNullOrEmpty(hexString)) return false;

            // ColorUtility.TryParseHtmlString 需要 # 前缀
            string normalized = hexString[0] == '#' ? hexString : "#" + hexString;
            return ColorUtility.TryParseHtmlString(normalized, out color);
        }

        /// <summary>
        /// 解析 "(x, y)" 格式的字符串为 Vector2
        /// </summary>
        private static bool TryParseVector2(string value, out Vector2 result)
        {
            result = Vector2.zero;
            if (string.IsNullOrEmpty(value)) return false;

            // 移除括号和空格
            string trimmed = value.Trim('(', ')', ' ');
            int commaIndex = trimmed.IndexOf(',');
            if (commaIndex < 0) return false;

            string xStr = trimmed.Substring(0, commaIndex).Trim();
            string yStr = trimmed.Substring(commaIndex + 1).Trim();

            if (float.TryParse(xStr, out float x) && float.TryParse(yStr, out float y))
            {
                result = new Vector2(x, y);
                return true;
            }

            return false;
        }
    }
}
