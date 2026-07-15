using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using ZLog = UnityEngine.Debug;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 批量 AssetDatabase 操作封装，减少 Import 回调和 Refresh 次数。
    /// 使用 IDisposable 模式确保 StopAssetEditing 始终被调用。
    /// 
    /// 用法示例：
    /// <code>
    /// using (var batch = new BatchedAssetOperations())
    /// {
    ///     batch.BeginBatch();
    ///     batch.SetSpriteBorders(borderList);
    ///     var prefab = batch.GetCachedPrefab("Assets/Prefabs/MyPrefab.prefab");
    ///     batch.EndBatch();
    /// }
    /// </code>
    /// </summary>
    public class BatchedAssetOperations : IDisposable
    {
        /// <summary>Prefab 资产缓存，避免重复 LoadAssetAtPath</summary>
        private readonly Dictionary<string, GameObject> _prefabCache = new Dictionary<string, GameObject>();

        /// <summary>当前是否处于批量编辑模式</summary>
        private bool _isEditing;

        /// <summary>是否已释放</summary>
        private bool _disposed;

        /// <summary>批量操作期间应用的 border 数量统计</summary>
        public int AppliedBorderCount { get; private set; }

        /// <summary>Prefab 缓存命中次数</summary>
        public int PrefabCacheHitCount { get; private set; }

        /// <summary>Prefab 缓存未命中次数（实际加载次数）</summary>
        public int PrefabCacheMissCount { get; private set; }

        /// <summary>
        /// 开始批量编辑模式，抑制逐资产导入回调。
        /// 调用后 Unity 不会在每次资产修改时触发 Import，
        /// 直到 EndBatch 或 Dispose 被调用。
        /// </summary>
        public void BeginBatch()
        {
            if (_isEditing)
            {
                ZLog.LogWarning("[BatchedAssetOperations] BeginBatch 重复调用，已忽略。");
                return;
            }

            AssetDatabase.StartAssetEditing();
            _isEditing = true;
        }

        /// <summary>
        /// 结束批量编辑模式并执行单次 Refresh。
        /// 确保所有挂起的资产修改被统一处理。
        /// </summary>
        public void EndBatch()
        {
            if (!_isEditing)
            {
                ZLog.LogWarning("[BatchedAssetOperations] EndBatch 在未开始批量编辑时调用，已忽略。");
                return;
            }

            try
            {
                AssetDatabase.StopAssetEditing();
            }
            finally
            {
                _isEditing = false;
            }

            // 单次 Refresh 处理所有挂起的资产变更
            AssetDatabase.Refresh();
        }

        /// <summary>
        /// 批量设置 TextureImporter 的 sprite border。
        /// 所有修改完成后才调用单次 Refresh，避免逐张图片触发导入。
        /// </summary>
        /// <param name="borders">待设置的资产路径和 border 值列表</param>
        public void SetSpriteBorders(List<(string assetPath, Vector4 border)> borders)
        {
            if (borders == null || borders.Count == 0)
                return;

            // 如果已在外部批量编辑中，直接逐个应用（Refresh 由外部 EndBatch 统一处理）
            if (_isEditing)
            {
                foreach (var (assetPath, border) in borders)
                {
                    ApplySingleSpriteBorder(assetPath, border);
                }
                return;
            }

            // 未在批量编辑中，自行包裹 StartAssetEditing/StopAssetEditing
            AssetDatabase.StartAssetEditing();
            try
            {
                foreach (var (assetPath, border) in borders)
                {
                    ApplySingleSpriteBorder(assetPath, border);
                }
            }
            finally
            {
                AssetDatabase.StopAssetEditing();
                // 所有 border 修改完成后单次 Refresh
                AssetDatabase.Refresh();
            }
        }

        /// <summary>
        /// 获取缓存的 Prefab 资产，避免重复加载。
        /// 首次访问时调用 AssetDatabase.LoadAssetAtPath，后续直接返回缓存。
        /// </summary>
        /// <param name="assetPath">Prefab 资产路径（如 Assets/Prefabs/MyPrefab.prefab）</param>
        /// <returns>加载的 Prefab GameObject，路径无效或加载失败时返回 null</returns>
        public GameObject GetCachedPrefab(string assetPath)
        {
            if (string.IsNullOrEmpty(assetPath))
            {
                ZLog.LogWarning("[BatchedAssetOperations] GetCachedPrefab 收到空路径。");
                return null;
            }

            // 缓存命中
            if (_prefabCache.TryGetValue(assetPath, out var cached))
            {
                PrefabCacheHitCount++;
                return cached;
            }

            // 缓存未命中，执行实际加载
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null)
            {
                ZLog.LogWarning($"[BatchedAssetOperations] 无法加载 Prefab: {assetPath}");
                PrefabCacheMissCount++;
                return null;
            }

            _prefabCache[assetPath] = prefab;
            PrefabCacheMissCount++;
            return prefab;
        }

        /// <summary>
        /// 获取当前 Prefab 缓存中的唯一路径数量。
        /// </summary>
        public int CachedPrefabCount => _prefabCache.Count;

        /// <summary>
        /// 清除 Prefab 缓存。
        /// 通常在批量操作完成后调用以释放引用。
        /// </summary>
        public void ClearPrefabCache()
        {
            _prefabCache.Clear();
        }

        /// <summary>
        /// IDisposable 实现，确保 StopAssetEditing 被调用，
        /// 防止因异常导致 AssetDatabase 锁定。
        /// </summary>
        public void Dispose()
        {
            if (_disposed)
                return;

            _disposed = true;

            if (_isEditing)
            {
                try
                {
                    AssetDatabase.StopAssetEditing();
                }
                catch (Exception ex)
                {
                    ZLog.LogError($"[BatchedAssetOperations] Dispose 时 StopAssetEditing 失败: {ex.Message}");
                }
                finally
                {
                    _isEditing = false;
                }
            }
        }

        // ═══════════════════════════════════════════════════════
        // 私有方法
        // ═══════════════════════════════════════════════════════

        /// <summary>
        /// 对单个资产应用 sprite border 设置。
        /// 使用 ImportAsset + ForceUpdate 标记资产需要重新导入，
        /// 实际导入延迟到 StopAssetEditing 或 Refresh 时执行。
        /// </summary>
        private void ApplySingleSpriteBorder(string assetPath, Vector4 border)
        {
            if (string.IsNullOrEmpty(assetPath))
            {
                ZLog.LogWarning("[BatchedAssetOperations] ApplySingleSpriteBorder 收到空路径，已跳过。");
                return;
            }

            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null)
            {
                ZLog.LogWarning($"[BatchedAssetOperations] 无法获取 TextureImporter: {assetPath}");
                return;
            }

            // 确保纹理类型为 Sprite
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.alphaIsTransparency = true;

            // 设置九宫格 border（left, bottom, right, top）
            importer.spriteBorder = border;

            // 标记资产需要重新导入（不立即执行，等待批量完成后统一处理）
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);

            AppliedBorderCount++;
        }
    }
}
