using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 变更范围枚举，用于增量同步时确定变更类型
    /// </summary>
    [Serializable]
    public enum ChangeScope
    {
        /// <summary>仅位置/尺寸变化</summary>
        LayoutOnly,

        /// <summary>仅文本内容变化</summary>
        TextOnly,

        /// <summary>仅图片变化</summary>
        ImageOnly,

        /// <summary>混合变化（多类变更同时存在）</summary>
        Mixed
    }
}
