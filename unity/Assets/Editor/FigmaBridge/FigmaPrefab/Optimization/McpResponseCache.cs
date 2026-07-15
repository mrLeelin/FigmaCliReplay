using System.Collections.Generic;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// MCP 响应缓存，避免同一会话内重复查询相同节点。
    /// 缓存键格式：{nodeId}_{callType}，callType 包括 design_context / metadata / screenshot。
    /// 生命周期为单次会话，不持久化。
    /// </summary>
    public class McpResponseCache
    {
        /// <summary>缓存存储，键为 nodeId_callType，值为响应对象</summary>
        private readonly Dictionary<string, object> _cache = new Dictionary<string, object>();

        /// <summary>缓存命中次数</summary>
        private int _hitCount;

        /// <summary>缓存未命中次数</summary>
        private int _missCount;

        /// <summary>
        /// 获取缓存的响应，未命中返回 null。
        /// 同时更新命中/未命中统计。
        /// </summary>
        /// <typeparam name="T">期望的响应类型</typeparam>
        /// <param name="nodeId">Figma 节点 ID</param>
        /// <param name="callType">调用类型（design_context / metadata / screenshot）</param>
        /// <returns>缓存的响应对象，未命中或类型不匹配时返回 null</returns>
        public T Get<T>(string nodeId, string callType) where T : class
        {
            var key = BuildKey(nodeId, callType);
            if (_cache.TryGetValue(key, out var value))
            {
                _hitCount++;
                return value as T;
            }

            _missCount++;
            return null;
        }

        /// <summary>
        /// 存储响应到缓存，覆盖已有条目。
        /// </summary>
        /// <param name="nodeId">Figma 节点 ID</param>
        /// <param name="callType">调用类型（design_context / metadata / screenshot）</param>
        /// <param name="response">要缓存的响应对象</param>
        public void Set(string nodeId, string callType, object response)
        {
            var key = BuildKey(nodeId, callType);
            _cache[key] = response;
        }

        /// <summary>
        /// 检查指定节点和调用类型是否已缓存。
        /// 不影响命中/未命中统计。
        /// </summary>
        /// <param name="nodeId">Figma 节点 ID</param>
        /// <param name="callType">调用类型（design_context / metadata / screenshot）</param>
        /// <returns>是否已缓存</returns>
        public bool Has(string nodeId, string callType)
        {
            var key = BuildKey(nodeId, callType);
            return _cache.ContainsKey(key);
        }

        /// <summary>
        /// 获取缓存统计信息（命中/未命中计数）。
        /// </summary>
        /// <returns>缓存统计对象</returns>
        public CacheStats GetStats()
        {
            return new CacheStats
            {
                HitCount = _hitCount,
                MissCount = _missCount
            };
        }

        /// <summary>
        /// 构建缓存键，格式为 {nodeId}_{callType}。
        /// </summary>
        private static string BuildKey(string nodeId, string callType)
        {
            return nodeId + "_" + callType;
        }
    }
}
