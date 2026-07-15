using System;
using System.Collections.Generic;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 变更范围检测结果，包含变更类型、影响节点数和差异列表
    /// </summary>
    [Serializable]
    public class ChangeScopeResult
    {
        /// <summary>变更范围类型</summary>
        public ChangeScope Scope;

        /// <summary>受影响的节点数量</summary>
        public int AffectedNodeCount;

        /// <summary>节点差异列表</summary>
        public List<NodeDiff> Diffs = new List<NodeDiff>();

        /// <summary>
        /// 是否可以使用快速路径（SerializedObject 直接修改）
        /// 条件：受影响节点少于 5 个且变更类型非 Mixed
        /// </summary>
        public bool CanUseFastPath => AffectedNodeCount < 5 && Scope != ChangeScope.Mixed;
    }
}
