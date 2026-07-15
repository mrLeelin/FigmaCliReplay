using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 导入场景枚举，定义不同的 Figma 到 Prefab 导入模式
    /// </summary>
    [Serializable]
    public enum ImportScenario
    {
        /// <summary>新建 Prefab</summary>
        NewPrefab,

        /// <summary>同步已有 Prefab</summary>
        SyncExisting,

        /// <summary>仅图片导入</summary>
        ImageOnly
    }
}
