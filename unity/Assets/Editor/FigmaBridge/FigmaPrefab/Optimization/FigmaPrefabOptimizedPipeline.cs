namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 优化后的 Figma-to-Prefab 统一流水线入口。
    /// 连接所有优化组件，提供新建导入和增量同步两条路径。
    ///
    /// 新建导入流程：
    ///   GetReferences → CacheMcpResponse → TransformCoordinates
    ///   → GenerateDownloadScript → ValidateBeforeExecution → (外部: 生成 Prefab)
    ///
    /// 增量同步流程：
    ///   DetectChangeScope → if CanUseFastPath → ApplyFastPath, else → 完整流水线
    /// </summary>
    public class FigmaPrefabOptimizedPipeline
    {
        // ═══════════════════════════════════════════════════════════
        // 组件实例
        // ═══════════════════════════════════════════════════════════

        /// <summary>MCP 响应缓存组件</summary>
        private readonly McpResponseCache _mcpCache;

        /// <summary>参考文件加载清单组件</summary>
        private readonly ReferenceManifest _referenceManifest;

        /// <summary>图片下载流水线组件</summary>
        private readonly ImageDownloadPipeline _downloadPipeline;

        // ═══════════════════════════════════════════════════════════
        // 构造函数
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 初始化统一流水线，创建所有内部组件实例
        /// </summary>
        public FigmaPrefabOptimizedPipeline()
        {
            _mcpCache = new McpResponseCache();
            _referenceManifest = new ReferenceManifest();
            _downloadPipeline = new ImageDownloadPipeline();
        }

        // ═══════════════════════════════════════════════════════════
        // 阶段一：参考文件加载
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 获取指定导入场景的必需参考文件列表。
        /// 委托给 ReferenceManifest 组件。
        /// </summary>
        /// <param name="scenario">导入场景（NewPrefab / SyncExisting / ImageOnly）</param>
        /// <returns>该场景下必须加载的参考文件名数组</returns>
        public string[] GetReferences(ImportScenario scenario)
        {
            return _referenceManifest.GetMandatoryReferences(scenario);
        }

        /// <summary>
        /// 获取按需参考文件（检测到 pitfall 条件时加载）。
        /// 委托给 ReferenceManifest 组件。
        /// </summary>
        /// <param name="condition">陷阱触发条件</param>
        /// <returns>该条件下需要加载的 pitfall 参考文件名数组</returns>
        public string[] GetOnDemandReferences(PitfallCondition condition)
        {
            return _referenceManifest.GetOnDemandReferences(condition);
        }

        // ═══════════════════════════════════════════════════════════
        // 阶段一：MCP 响应缓存
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 缓存 MCP 响应，避免同一会话内重复查询相同节点。
        /// 委托给 McpResponseCache 组件。
        /// </summary>
        /// <param name="nodeId">Figma 节点 ID</param>
        /// <param name="callType">调用类型（design_context / metadata / screenshot）</param>
        /// <param name="response">要缓存的响应对象</param>
        public void CacheMcpResponse(string nodeId, string callType, object response)
        {
            _mcpCache.Set(nodeId, callType, response);
        }

        /// <summary>
        /// 获取缓存的 MCP 响应，未命中返回 null。
        /// 委托给 McpResponseCache 组件。
        /// </summary>
        /// <typeparam name="T">期望的响应类型</typeparam>
        /// <param name="nodeId">Figma 节点 ID</param>
        /// <param name="callType">调用类型（design_context / metadata / screenshot）</param>
        /// <returns>缓存的响应对象，未命中或类型不匹配时返回 null</returns>
        public T GetCachedMcpResponse<T>(string nodeId, string callType) where T : class
        {
            return _mcpCache.Get<T>(nodeId, callType);
        }

        // ═══════════════════════════════════════════════════════════
        // 阶段一：坐标转换
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 将 Figma 坐标转换为 Unity anchoredPosition。
        /// 委托给 CoordinateTransformer 静态组件。
        /// </summary>
        /// <param name="figmaX">Figma 节点本地 X 坐标</param>
        /// <param name="figmaY">Figma 节点本地 Y 坐标</param>
        /// <param name="w">节点宽度</param>
        /// <param name="h">节点高度</param>
        /// <param name="parentW">父节点宽度</param>
        /// <param name="parentH">父节点高度</param>
        /// <returns>包含 anchoredPosition 和 sizeDelta 的 RectSpec</returns>
        public RectSpec TransformCoordinates(
            float figmaX, float figmaY,
            float w, float h,
            float parentW, float parentH)
        {
            return CoordinateTransformer.Transform(figmaX, figmaY, w, h, parentW, parentH);
        }

        // ═══════════════════════════════════════════════════════════
        // 阶段二：图片下载
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 生成图片下载 PowerShell 脚本。
        /// 委托给 ImageDownloadPipeline 组件。
        /// 脚本支持：MD5 预检跳过、并发限制、失败重试、进度报告。
        /// </summary>
        /// <param name="plan">图片下载计划</param>
        /// <returns>完整的 PowerShell 脚本字符串</returns>
        public string GenerateDownloadScript(ImageDownloadPlan plan)
        {
            return _downloadPipeline.GenerateDownloadScript(plan);
        }

        // ═══════════════════════════════════════════════════════════
        // 阶段二：预验证
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 执行预验证，单次调用完成所有预检。
        /// 委托给 PreExecutionValidator 静态组件。
        /// 包含：Spec Lint、图片存在性、尺寸/MD5 校验、九宫格最小尺寸检查。
        /// </summary>
        /// <param name="specPath">JSON Spec 文件路径</param>
        /// <param name="downloadPlanPath">Download Plan 文件路径</param>
        /// <returns>合并的验证结果</returns>
        public ValidationResult ValidateBeforeExecution(string specPath, string downloadPlanPath)
        {
            return PreExecutionValidator.ValidateAll(specPath, downloadPlanPath);
        }

        // ═══════════════════════════════════════════════════════════
        // 增量同步：变更范围检测
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 检测变更范围，对比新旧 Figma 节点状态确定变更类型。
        /// 委托给 ChangeScopeDetector 静态组件。
        /// 用于增量同步时判断是否可以走快速路径。
        /// </summary>
        /// <param name="oldNodes">旧节点数组</param>
        /// <param name="newNodes">新节点数组</param>
        /// <returns>变更范围检测结果（含 CanUseFastPath 判定）</returns>
        public ChangeScopeResult DetectChangeScope(NodeCompareSpec[] oldNodes, NodeCompareSpec[] newNodes)
        {
            return ChangeScopeDetector.Detect(oldNodes, newNodes);
        }

        // ═══════════════════════════════════════════════════════════
        // 增量同步：快速路径
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 执行快速路径修改（增量同步用）。
        /// 委托给 FastPathPatcher 静态组件。
        /// 使用 PrefabUtility 直接修改 Prefab 属性，跳过完整重新生成。
        /// </summary>
        /// <param name="prefabPath">Prefab 资产路径</param>
        /// <param name="scopeResult">变更范围检测结果</param>
        /// <param name="newNodes">新的节点数据</param>
        /// <returns>是否成功应用所有修改</returns>
        public bool ApplyFastPath(string prefabPath, ChangeScopeResult scopeResult, NodeCompareSpec[] newNodes)
        {
            return FastPathPatcher.Apply(prefabPath, scopeResult, newNodes);
        }

        // ═══════════════════════════════════════════════════════════
        // 统计与工具方法
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 获取 MCP 缓存统计信息（命中/未命中计数）。
        /// 委托给 McpResponseCache 组件。
        /// </summary>
        /// <returns>缓存统计对象</returns>
        public CacheStats GetCacheStats()
        {
            return _mcpCache.GetStats();
        }

        /// <summary>
        /// 获取九宫格图片的最小下载尺寸。
        /// 委托给 ImageDownloadPipeline 静态方法。
        /// 最小尺寸 = 边框像素之和 + 2（确保中间至少有可拉伸区域）。
        /// </summary>
        /// <param name="left">左边框像素</param>
        /// <param name="right">右边框像素</param>
        /// <param name="top">上边框像素</param>
        /// <param name="bottom">下边框像素</param>
        /// <returns>最小宽度和高度的元组</returns>
        public static (int width, int height) GetNineSliceMinSize(
            int left, int right, int top, int bottom)
        {
            return ImageDownloadPipeline.GetNineSliceMinSize(left, right, top, bottom);
        }
    }
}
