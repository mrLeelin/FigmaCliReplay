using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 节点差异，描述新旧状态之间单个节点的变更
    /// </summary>
    [Serializable]
    public class NodeDiff
    {
        /// <summary>节点在 nodes 数组中的索引</summary>
        public int NodeIndex;

        /// <summary>节点名称</summary>
        public string NodeName;

        /// <summary>
        /// 变更类型：position / size / text / fontSize / color / imageId
        /// </summary>
        public string ChangeType;

        /// <summary>变更前的值</summary>
        public string OldValue;

        /// <summary>变更后的值</summary>
        public string NewValue;
    }
}
