using System.Collections.Generic;
using UnityEngine;
using ZLog = UnityEngine.Debug;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 分组规则执行器，在 Prefab 生成完成后、保存前执行分组操作。
    /// 保持世界位置不变、保持 sibling 渲染顺序。
    /// </summary>
    public static class GroupingRuleExecutor
    {
        /// <summary>
        /// 执行分组规则数组，返回统计信息。
        /// 对每条规则：创建分组父节点 → 重新设置子节点 parent → 保持世界位置和渲染顺序。
        /// </summary>
        /// <param name="root">Prefab 根节点的 RectTransform</param>
        /// <param name="rules">分组规则数组</param>
        /// <param name="allNodes">所有已创建的节点 RectTransform 列表（按 spec 中的索引顺序）</param>
        /// <returns>创建的分组节点数和重新设置父节点的子节点数</returns>
        public static (int groupingNodesCreated, int nodesReparented) Execute(
            RectTransform root,
            GroupingRule[] rules,
            List<RectTransform> allNodes)
        {
            // 空规则直接返回
            if (rules == null || rules.Length == 0)
                return (0, 0);

            if (root == null)
            {
                ZLog.LogWarning("[GroupingRuleExecutor] root 为 null，跳过分组执行。");
                return (0, 0);
            }

            int groupingNodesCreated = 0;
            int nodesReparented = 0;

            for (int i = 0; i < rules.Length; i++)
            {
                var rule = rules[i];
                if (rule == null)
                {
                    ZLog.LogWarning($"[GroupingRuleExecutor] rules[{i}] 为 null，已跳过。");
                    continue;
                }

                var (created, reparented) = ExecuteSingleRule(root, rule, allNodes, i);
                groupingNodesCreated += created;
                nodesReparented += reparented;
            }

            return (groupingNodesCreated, nodesReparented);
        }

        // ═══════════════════════════════════════════════════════
        // 私有方法
        // ═══════════════════════════════════════════════════════

        /// <summary>
        /// 执行单条分组规则：创建父节点、重设子节点 parent、保持空间不变量。
        /// </summary>
        private static (int created, int reparented) ExecuteSingleRule(
            RectTransform root,
            GroupingRule rule,
            List<RectTransform> allNodes,
            int ruleIndex)
        {
            if (rule.childNodeIndices == null || rule.childNodeIndices.Length == 0)
            {
                ZLog.LogWarning($"[GroupingRuleExecutor] rules[{ruleIndex}] childNodeIndices 为空，已跳过。");
                return (0, 0);
            }

            // 收集有效子节点及其原始 sibling index
            var validChildren = CollectValidChildren(rule, allNodes, ruleIndex);
            if (validChildren.Count == 0)
                return (0, 0);

            // 确定插入位置：使用第一个子节点的最小 sibling index，保持渲染顺序
            int insertSiblingIndex = GetMinSiblingIndex(validChildren);

            // 创建分组父节点
            var groupNode = CreateGroupNode(rule, root);

            // 将分组节点插入到正确的 sibling 位置
            groupNode.SetSiblingIndex(insertSiblingIndex);

            // 重设子节点 parent，保持世界位置不变
            int reparented = ReparentChildren(validChildren, groupNode);

            return (1, reparented);
        }

        /// <summary>
        /// 收集有效的子节点 RectTransform 及其原始 sibling index。
        /// 无效索引（越界或 null）会被跳过并记录警告。
        /// </summary>
        private static List<(RectTransform rect, int siblingIndex)> CollectValidChildren(
            GroupingRule rule,
            List<RectTransform> allNodes,
            int ruleIndex)
        {
            var result = new List<(RectTransform, int)>(rule.childNodeIndices.Length);

            for (int i = 0; i < rule.childNodeIndices.Length; i++)
            {
                int nodeIndex = rule.childNodeIndices[i];

                // 越界检查
                if (nodeIndex < 0 || nodeIndex >= allNodes.Count)
                {
                    ZLog.LogWarning(
                        $"[GroupingRuleExecutor] rules[{ruleIndex}].childNodeIndices[{i}] = {nodeIndex} " +
                        $"超出范围 [0, {allNodes.Count - 1}]，已跳过。");
                    continue;
                }

                var childRect = allNodes[nodeIndex];
                if (childRect == null)
                {
                    ZLog.LogWarning(
                        $"[GroupingRuleExecutor] allNodes[{nodeIndex}] 为 null，已跳过。");
                    continue;
                }

                result.Add((childRect, childRect.GetSiblingIndex()));
            }

            return result;
        }

        /// <summary>
        /// 获取子节点列表中最小的 sibling index，用于确定分组节点的插入位置。
        /// </summary>
        private static int GetMinSiblingIndex(List<(RectTransform rect, int siblingIndex)> children)
        {
            int min = int.MaxValue;
            for (int i = 0; i < children.Count; i++)
            {
                if (children[i].siblingIndex < min)
                    min = children[i].siblingIndex;
            }
            return min;
        }

        /// <summary>
        /// 创建分组父节点 GameObject，设置 RectTransform 属性。
        /// anchors 设为中心 (0.5, 0.5) 以匹配坐标系统。
        /// </summary>
        private static RectTransform CreateGroupNode(GroupingRule rule, RectTransform root)
        {
            var go = new GameObject(rule.parentName ?? "[UnnamedGroup]");
            var rectTransform = go.AddComponent<RectTransform>();

            // 先设置 parent（worldPositionStays = false，因为我们手动设置位置）
            rectTransform.SetParent(root, false);

            // 设置 anchors 为中心
            rectTransform.anchorMin = new Vector2(0.5f, 0.5f);
            rectTransform.anchorMax = new Vector2(0.5f, 0.5f);
            rectTransform.pivot = new Vector2(0.5f, 0.5f);

            // 从 parentRect 设置位置和尺寸
            rectTransform.anchoredPosition = new Vector2(rule.parentRect.x, rule.parentRect.y);
            rectTransform.sizeDelta = new Vector2(rule.parentRect.w, rule.parentRect.h);

            return rectTransform;
        }

        /// <summary>
        /// 将子节点重新设置到分组父节点下，保持世界位置不变。
        /// 按原始 sibling index 升序排列子节点，确保渲染顺序一致。
        /// </summary>
        private static int ReparentChildren(
            List<(RectTransform rect, int siblingIndex)> children,
            RectTransform groupNode)
        {
            // 按原始 sibling index 排序，保持渲染顺序
            children.Sort((a, b) => a.siblingIndex.CompareTo(b.siblingIndex));

            // 获取分组节点的世界 anchoredPosition（用于补偿计算）
            var groupWorldPos = GetWorldAnchoredPosition(groupNode);

            int reparented = 0;

            for (int i = 0; i < children.Count; i++)
            {
                var childRect = children[i].rect;

                // 记录子节点重设 parent 前的世界 anchoredPosition
                var childWorldPos = GetWorldAnchoredPosition(childRect);

                // 重设 parent（worldPositionStays = false，手动补偿位置）
                childRect.SetParent(groupNode, false);

                // 计算新的 anchoredPosition 以保持世界位置不变
                // newAnchoredPos = oldWorldAnchoredPos - groupNodeWorldAnchoredPos
                childRect.anchoredPosition = childWorldPos - groupWorldPos;

                reparented++;
            }

            return reparented;
        }

        /// <summary>
        /// 计算 RectTransform 相对于根节点的世界 anchoredPosition。
        /// 通过递归累加父级链的 anchoredPosition 得到。
        /// 假设所有节点 anchors 均为中心 (0.5, 0.5)。
        /// </summary>
        private static Vector2 GetWorldAnchoredPosition(RectTransform rect)
        {
            var worldPos = Vector2.zero;
            var current = rect;

            // 从当前节点向上遍历，累加所有父级的 anchoredPosition
            // 停止条件：到达根节点（无 parent 或 parent 无 RectTransform）
            while (current != null)
            {
                worldPos += current.anchoredPosition;
                var parentTransform = current.parent;
                if (parentTransform == null)
                    break;
                current = parentTransform as RectTransform;
            }

            return worldPos;
        }
    }
}
