using TMPro;
using UnityEditor;
using UnityEngine;
using ZLog = MagicWarrior.Editor.FigmaBridge.BridgeLogger;
using UnityEngine.UI;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 内联后处理器，在节点创建时直接应用后处理设置，
    /// 消除独立的后处理 ExecuteDynamicCode 调用。
    /// 
    /// 支持的后处理操作：
    /// - TextMeshProUGUI：绑定 CommonFont + CommonFont 材质 + 启用 AutoSize
    /// - Image/CustomImage：关闭 RaycastTarget
    /// 
    /// 资产采用延迟加载 + 缓存策略，首次调用时加载，后续复用。
    /// </summary>
    public static class InlinePostProcessor
    {
        // ─── CommonFont 资产路径 ───

        /// <summary>CommonFont TMP_FontAsset 路径</summary>
        private const string CommonFontPath =
            "Assets/MagicWarrior/_Resources/Font/Package/CommonFont.asset";

        /// <summary>CommonFont 材质路径</summary>
        private const string CommonFontMatPath =
            "Assets/MagicWarrior/_Resources/Font/Package/CommonFont.mat";

        // ─── 缓存字段 ───

        /// <summary>缓存的 CommonFont 字体资产</summary>
        private static TMP_FontAsset _cachedFont;

        /// <summary>缓存的 CommonFont 材质</summary>
        private static Material _cachedMaterial;

        /// <summary>字体是否已尝试加载（避免重复加载失败资产）</summary>
        private static bool _fontLoadAttempted;

        /// <summary>材质是否已尝试加载</summary>
        private static bool _materialLoadAttempted;

        // ─── 统计计数器 ───

        private static PostProcessingStats _stats = new PostProcessingStats();

        // ═══════════════════════════════════════════════════════
        // 公共方法
        // ═══════════════════════════════════════════════════════

        /// <summary>
        /// 对 TextMeshProUGUI 组件应用内联后处理：
        /// - 绑定 CommonFont 字体
        /// - 绑定 CommonFont 材质
        /// - 启用 enableAutoSizing
        /// </summary>
        /// <param name="textComponent">目标 TextMeshProUGUI 组件</param>
        /// <returns>true 表示所有设置成功应用；false 表示存在失败项</returns>
        public static bool ApplyTextPostProcessing(TextMeshProUGUI textComponent)
        {
            if (textComponent == null)
            {
                ZLog.LogError("[InlinePostProcessor] ApplyTextPostProcessing 收到 null 组件。");
                return false;
            }

            bool allSuccess = true;

            // 绑定 CommonFont 字体和材质
            allSuccess &= ApplyCommonFont(textComponent);

            // 启用 AutoSize
            ApplyAutoSize(textComponent);

            return allSuccess;
        }

        /// <summary>
        /// 对 Image/CustomImage 组件应用内联后处理：
        /// - 关闭 raycastTarget
        /// </summary>
        /// <param name="imageComponent">目标 Image 组件（包括 CustomImage 等子类）</param>
        /// <returns>true 表示设置成功；false 表示组件为 null</returns>
        public static bool ApplyImagePostProcessing(Image imageComponent)
        {
            if (imageComponent == null)
            {
                ZLog.LogError("[InlinePostProcessor] ApplyImagePostProcessing 收到 null 组件。");
                return false;
            }

            ApplyRaycastTargetFalse(imageComponent);
            return true;
        }

        /// <summary>
        /// 获取当前后处理统计数据（用于 GenerationResult 报告）
        /// </summary>
        /// <returns>后处理统计快照</returns>
        public static PostProcessingStats GetStats()
        {
            return _stats;
        }

        /// <summary>
        /// 重置统计计数器。
        /// 应在每次新的 Prefab 生成任务开始前调用。
        /// </summary>
        public static void ResetStats()
        {
            _stats = new PostProcessingStats();
        }

        /// <summary>
        /// 重置缓存和统计。
        /// 用于完全清理状态（如测试场景或强制重新加载资产）。
        /// </summary>
        public static void ResetAll()
        {
            _cachedFont = null;
            _cachedMaterial = null;
            _fontLoadAttempted = false;
            _materialLoadAttempted = false;
            _stats = new PostProcessingStats();
        }

        // ═══════════════════════════════════════════════════════
        // 私有方法
        // ═══════════════════════════════════════════════════════

        /// <summary>
        /// 绑定 CommonFont 字体和材质到 TextMeshProUGUI 组件。
        /// 使用延迟加载 + 缓存策略，首次调用时加载资产。
        /// </summary>
        private static bool ApplyCommonFont(TextMeshProUGUI textComponent)
        {
            var font = GetCachedFont();
            if (font == null)
            {
                // 字体加载失败，记录残留
                _stats.AutoSizeFalseResidueCount++;
                return false;
            }

            // 绑定字体
            textComponent.font = font;

            // 绑定材质（可选，材质缺失不阻塞）
            var material = GetCachedMaterial();
            if (material != null)
            {
                textComponent.fontSharedMaterial = material;
            }
            else
            {
                ZLog.LogWarning(
                    $"[InlinePostProcessor] CommonFont.mat 未找到，文本 '{textComponent.name}' 使用默认材质。");
            }

            _stats.CommonFontAppliedCount++;
            return true;
        }

        /// <summary>
        /// 启用 TextMeshProUGUI 的 enableAutoSizing 并记录统计。
        /// </summary>
        private static void ApplyAutoSize(TextMeshProUGUI textComponent)
        {
            textComponent.enableAutoSizing = true;
            _stats.AutoSizeTrueCount++;
        }

        /// <summary>
        /// 关闭 Image 组件的 raycastTarget 并记录统计。
        /// </summary>
        private static void ApplyRaycastTargetFalse(Image imageComponent)
        {
            imageComponent.raycastTarget = false;
            _stats.RaycastTargetFalseCount++;
        }

        /// <summary>
        /// 获取缓存的 CommonFont 字体资产。
        /// 首次调用时通过 AssetDatabase 加载，后续直接返回缓存。
        /// </summary>
        private static TMP_FontAsset GetCachedFont()
        {
            // 已缓存且有效，直接返回
            if (_cachedFont != null)
                return _cachedFont;

            // 已尝试加载但失败，不再重复尝试
            if (_fontLoadAttempted)
                return null;

            _fontLoadAttempted = true;
            _cachedFont = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(CommonFontPath);

            if (_cachedFont == null)
            {
                ZLog.LogError(
                    $"[InlinePostProcessor] 无法加载 CommonFont.asset，路径: {CommonFontPath}。" +
                    "请确认资产存在且路径正确。");
            }

            return _cachedFont;
        }

        /// <summary>
        /// 获取缓存的 CommonFont 材质。
        /// 首次调用时通过 AssetDatabase 加载，后续直接返回缓存。
        /// </summary>
        private static Material GetCachedMaterial()
        {
            // 已缓存且有效，直接返回
            if (_cachedMaterial != null)
                return _cachedMaterial;

            // 已尝试加载但失败，不再重复尝试
            if (_materialLoadAttempted)
                return null;

            _materialLoadAttempted = true;
            _cachedMaterial = AssetDatabase.LoadAssetAtPath<Material>(CommonFontMatPath);

            if (_cachedMaterial == null)
            {
                ZLog.LogWarning(
                    $"[InlinePostProcessor] 无法加载 CommonFont.mat，路径: {CommonFontMatPath}。" +
                    "文本组件将使用字体默认材质。");
            }

            return _cachedMaterial;
        }
    }

    /// <summary>
    /// 后处理统计数据，用于 GenerationResult 报告。
    /// 记录各项后处理操作的执行次数和残留情况。
    /// </summary>
    public class PostProcessingStats
    {
        /// <summary>已成功应用 CommonFont 的文本数量</summary>
        public int CommonFontAppliedCount;

        /// <summary>已成功启用 AutoSize 的文本数量</summary>
        public int AutoSizeTrueCount;

        /// <summary>AutoSize 未能启用的残留数量（阻塞失败指标）</summary>
        public int AutoSizeFalseResidueCount;

        /// <summary>已成功关闭 RaycastTarget 的 Image 数量</summary>
        public int RaycastTargetFalseCount;

        /// <summary>RaycastTarget 仍为 true 的残留数量（阻塞失败指标）</summary>
        public int RaycastTargetTrueResidueCount;
    }
}
