using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// MCP 响应缓存统计，记录缓存命中和未命中次数
    /// </summary>
    [Serializable]
    public class CacheStats
    {
        /// <summary>缓存命中次数</summary>
        public int HitCount;

        /// <summary>缓存未命中次数</summary>
        public int MissCount;
    }
}
