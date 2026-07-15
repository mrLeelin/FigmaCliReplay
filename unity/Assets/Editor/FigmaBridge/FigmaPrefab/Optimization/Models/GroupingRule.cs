using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 分组规则，定义语义分组的父节点和子节点关系
    /// 用于在 JSON Spec 中内联指定分组操作
    /// </summary>
    [Serializable]
    public class GroupingRule
    {
        /// <summary>分组父节点名称</summary>
        public string parentName;

        /// <summary>父节点的矩形规格（位置和尺寸）</summary>
        public RectSpec parentRect;

        /// <summary>需要归入该分组的子节点索引数组</summary>
        public int[] childNodeIndices;

        /// <summary>分组依据说明（如坐标重叠、命名模式等）</summary>
        public string evidence;
    }
}
