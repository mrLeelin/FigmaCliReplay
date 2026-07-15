using System;
using System.Collections.Generic;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 变更范围检测器，对比新旧 Figma 节点状态确定变更类型。
    /// 用于增量同步时判断是否可以走快速路径。
    /// </summary>
    public static class ChangeScopeDetector
    {
        /// <summary>
        /// 变更类别标志位，用于内部追踪检测到的变更类型
        /// </summary>
        [Flags]
        private enum ChangeCategory
        {
            None = 0,
            Layout = 1 << 0,
            Text = 1 << 1,
            Image = 1 << 2
        }

        /// <summary>
        /// 对比新旧节点列表，确定变更范围。
        /// 单次遍历完成所有对比，不使用 LINQ。
        /// </summary>
        /// <param name="oldNodes">旧节点数组</param>
        /// <param name="newNodes">新节点数组</param>
        /// <returns>变更范围检测结果</returns>
        public static ChangeScopeResult Detect(NodeCompareSpec[] oldNodes, NodeCompareSpec[] newNodes)
        {
            var result = new ChangeScopeResult();

            // 空数组处理
            if (oldNodes == null) oldNodes = Array.Empty<NodeCompareSpec>();
            if (newNodes == null) newNodes = Array.Empty<NodeCompareSpec>();

            // 新数组更长意味着有新增节点，直接标记为 Mixed
            bool hasAddedNodes = newNodes.Length > oldNodes.Length;

            // 取较短长度进行逐节点对比
            int compareCount = Math.Min(oldNodes.Length, newNodes.Length);
            ChangeCategory aggregatedCategories = ChangeCategory.None;

            // 单次遍历对比所有节点
            for (int i = 0; i < compareCount; i++)
            {
                CompareNode(i, oldNodes[i], newNodes[i], result.Diffs, ref aggregatedCategories);
            }

            // 计算受影响节点数
            result.AffectedNodeCount = CountAffectedNodes(result.Diffs);

            // 如果有新增节点，追加到受影响计数并标记为 Mixed
            if (hasAddedNodes)
            {
                int addedCount = newNodes.Length - oldNodes.Length;
                result.AffectedNodeCount += addedCount;
                result.Scope = ChangeScope.Mixed;
            }
            else
            {
                result.Scope = DetermineScope(aggregatedCategories);
            }

            return result;
        }

        /// <summary>
        /// 对比单个节点的新旧状态，将差异添加到 diffs 列表
        /// </summary>
        private static void CompareNode(
            int index,
            NodeCompareSpec oldNode,
            NodeCompareSpec newNode,
            List<NodeDiff> diffs,
            ref ChangeCategory categories)
        {
            string nodeName = newNode.name ?? oldNode.name ?? string.Empty;

            // 对比布局属性：x, y, w, h
            CompareLayoutFields(index, nodeName, oldNode, newNode, diffs, ref categories);

            // 对比文本属性：text, fontSize, color
            CompareTextFields(index, nodeName, oldNode, newNode, diffs, ref categories);

            // 对比图片属性：imageId
            CompareImageFields(index, nodeName, oldNode, newNode, diffs, ref categories);
        }

        /// <summary>
        /// 对比布局相关字段（x, y, w, h）
        /// </summary>
        private static void CompareLayoutFields(
            int index,
            string nodeName,
            NodeCompareSpec oldNode,
            NodeCompareSpec newNode,
            List<NodeDiff> diffs,
            ref ChangeCategory categories)
        {
            // 使用浮点数容差比较，避免精度问题
            const float epsilon = 0.001f;

            if (Math.Abs(oldNode.x - newNode.x) > epsilon || Math.Abs(oldNode.y - newNode.y) > epsilon)
            {
                categories |= ChangeCategory.Layout;
                diffs.Add(new NodeDiff
                {
                    NodeIndex = index,
                    NodeName = nodeName,
                    ChangeType = "position",
                    OldValue = FormatPosition(oldNode.x, oldNode.y),
                    NewValue = FormatPosition(newNode.x, newNode.y)
                });
            }

            if (Math.Abs(oldNode.w - newNode.w) > epsilon || Math.Abs(oldNode.h - newNode.h) > epsilon)
            {
                categories |= ChangeCategory.Layout;
                diffs.Add(new NodeDiff
                {
                    NodeIndex = index,
                    NodeName = nodeName,
                    ChangeType = "size",
                    OldValue = FormatSize(oldNode.w, oldNode.h),
                    NewValue = FormatSize(newNode.w, newNode.h)
                });
            }
        }

        /// <summary>
        /// 对比文本相关字段（text, fontSize, color）
        /// </summary>
        private static void CompareTextFields(
            int index,
            string nodeName,
            NodeCompareSpec oldNode,
            NodeCompareSpec newNode,
            List<NodeDiff> diffs,
            ref ChangeCategory categories)
        {
            if (!StringEquals(oldNode.text, newNode.text))
            {
                categories |= ChangeCategory.Text;
                diffs.Add(new NodeDiff
                {
                    NodeIndex = index,
                    NodeName = nodeName,
                    ChangeType = "text",
                    OldValue = oldNode.text ?? string.Empty,
                    NewValue = newNode.text ?? string.Empty
                });
            }

            const float epsilon = 0.001f;
            if (Math.Abs(oldNode.fontSize - newNode.fontSize) > epsilon)
            {
                categories |= ChangeCategory.Text;
                diffs.Add(new NodeDiff
                {
                    NodeIndex = index,
                    NodeName = nodeName,
                    ChangeType = "fontSize",
                    OldValue = oldNode.fontSize.ToString("F1"),
                    NewValue = newNode.fontSize.ToString("F1")
                });
            }

            if (!StringEquals(oldNode.color, newNode.color))
            {
                categories |= ChangeCategory.Text;
                diffs.Add(new NodeDiff
                {
                    NodeIndex = index,
                    NodeName = nodeName,
                    ChangeType = "color",
                    OldValue = oldNode.color ?? string.Empty,
                    NewValue = newNode.color ?? string.Empty
                });
            }
        }

        /// <summary>
        /// 对比图片相关字段（imageId）
        /// </summary>
        private static void CompareImageFields(
            int index,
            string nodeName,
            NodeCompareSpec oldNode,
            NodeCompareSpec newNode,
            List<NodeDiff> diffs,
            ref ChangeCategory categories)
        {
            if (!StringEquals(oldNode.imageId, newNode.imageId))
            {
                categories |= ChangeCategory.Image;
                diffs.Add(new NodeDiff
                {
                    NodeIndex = index,
                    NodeName = nodeName,
                    ChangeType = "imageId",
                    OldValue = oldNode.imageId ?? string.Empty,
                    NewValue = newNode.imageId ?? string.Empty
                });
            }
        }

        /// <summary>
        /// 根据聚合的变更类别确定最终的变更范围
        /// </summary>
        private static ChangeScope DetermineScope(ChangeCategory categories)
        {
            // 无变更时默认返回 LayoutOnly（空变更集）
            if (categories == ChangeCategory.None)
                return ChangeScope.LayoutOnly;

            // 检查是否有多个类别同时存在
            int categoryCount = 0;
            if ((categories & ChangeCategory.Layout) != 0) categoryCount++;
            if ((categories & ChangeCategory.Text) != 0) categoryCount++;
            if ((categories & ChangeCategory.Image) != 0) categoryCount++;

            if (categoryCount > 1)
                return ChangeScope.Mixed;

            // 单一类别
            if ((categories & ChangeCategory.Layout) != 0)
                return ChangeScope.LayoutOnly;
            if ((categories & ChangeCategory.Text) != 0)
                return ChangeScope.TextOnly;

            return ChangeScope.ImageOnly;
        }

        /// <summary>
        /// 统计受影响的唯一节点数量（同一节点可能有多个 diff 条目）
        /// </summary>
        private static int CountAffectedNodes(List<NodeDiff> diffs)
        {
            if (diffs.Count == 0) return 0;

            // 使用 HashSet 去重节点索引
            var uniqueIndices = new HashSet<int>();
            for (int i = 0; i < diffs.Count; i++)
            {
                uniqueIndices.Add(diffs[i].NodeIndex);
            }
            return uniqueIndices.Count;
        }

        /// <summary>
        /// 空安全的字符串比较
        /// </summary>
        private static bool StringEquals(string a, string b)
        {
            // 将 null 和空字符串视为相同
            bool aEmpty = string.IsNullOrEmpty(a);
            bool bEmpty = string.IsNullOrEmpty(b);
            if (aEmpty && bEmpty) return true;
            if (aEmpty || bEmpty) return false;
            return string.Equals(a, b, StringComparison.Ordinal);
        }

        /// <summary>
        /// 格式化位置值为字符串
        /// </summary>
        private static string FormatPosition(float x, float y)
        {
            return string.Concat("(", x.ToString("F1"), ", ", y.ToString("F1"), ")");
        }

        /// <summary>
        /// 格式化尺寸值为字符串
        /// </summary>
        private static string FormatSize(float w, float h)
        {
            return string.Concat("(", w.ToString("F1"), ", ", h.ToString("F1"), ")");
        }
    }
}
