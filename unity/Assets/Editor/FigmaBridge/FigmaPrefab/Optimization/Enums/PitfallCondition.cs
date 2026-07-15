using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 陷阱触发条件枚举，用于按需加载对应的参考文件段落
    /// </summary>
    [Serializable]
    public enum PitfallCondition
    {
        /// <summary>九宫格节点，需加载九宫格相关 pitfall 文档</summary>
        NineSliceNode,

        /// <summary>TMP 材质标签，需加载 TMP 材质相关 pitfall 文档</summary>
        TmpMaterialTag,

        /// <summary>实例节点，需加载实例节点相关 pitfall 文档</summary>
        InstanceNode
    }
}
