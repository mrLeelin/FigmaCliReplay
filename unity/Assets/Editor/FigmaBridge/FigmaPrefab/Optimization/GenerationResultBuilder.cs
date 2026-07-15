using System;
using System.Collections.Generic;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 生成结果构建器，在 Prefab 生成过程中累积统计信息，
    /// 最终构建 GenerationResult 对象。
    /// 
    /// 设计原则：
    /// - 热路径（RecordNode）仅做简单计数器自增，无分配
    /// - 阻塞失败在 Build 时自动检测并写入 Errors
    /// 
    /// 用法示例：
    /// <code>
    /// var builder = new GenerationResultBuilder();
    /// builder.RecordNode("image");
    /// builder.RecordNode("text");
    /// builder.RecordPostProcessing(6, 6, 0, 8, 0);
    /// builder.RecordGrouping(2, 6);
    /// var result = builder.Build();
    /// </code>
    /// </summary>
    public class GenerationResultBuilder
    {
        // ─── 节点计数器 ───

        private int _nodeCount;
        private int _imageCount;
        private int _textCount;
        private int _prefabInstanceCount;

        // ─── 后处理统计 ───

        private int _commonFontAppliedCount;
        private int _autoSizeTrueCount;
        private int _autoSizeFalseResidueCount;
        private int _raycastTargetFalseCount;
        private int _raycastTargetTrueResidueCount;

        // ─── 分组统计 ───

        private int _groupingNodesCreated;
        private int _nodesReparented;

        // ─── 错误与警告 ───

        private readonly List<string> _errors = new List<string>();
        private readonly List<string> _warnings = new List<string>();

        /// <summary>
        /// 记录一个节点被创建。
        /// 根据 nodeType 递增对应计数器，同时递增总节点数。
        /// 热路径方法，仅做整数自增，无堆分配。
        /// </summary>
        /// <param name="nodeType">节点类型：image / text / prefabInstance / container</param>
        public void RecordNode(string nodeType)
        {
            _nodeCount++;

            switch (nodeType)
            {
                case "image":
                    _imageCount++;
                    break;
                case "text":
                    _textCount++;
                    break;
                case "prefabInstance":
                    _prefabInstanceCount++;
                    break;
                // container 和其他类型仅计入总数
            }
        }

        /// <summary>
        /// 记录后处理结果统计。
        /// 在内联后处理完成后调用，设置各项验证计数。
        /// </summary>
        /// <param name="commonFontApplied">已应用 CommonFont 的文本数量</param>
        /// <param name="autoSizeTrue">已启用 AutoSize 的文本数量</param>
        /// <param name="autoSizeFalseResidue">AutoSize 未启用的残留数量</param>
        /// <param name="raycastTargetFalse">已关闭 RaycastTarget 的 Image 数量</param>
        /// <param name="raycastTargetTrueResidue">RaycastTarget 仍为 true 的残留数量</param>
        public void RecordPostProcessing(
            int commonFontApplied,
            int autoSizeTrue,
            int autoSizeFalseResidue,
            int raycastTargetFalse,
            int raycastTargetTrueResidue)
        {
            _commonFontAppliedCount = commonFontApplied;
            _autoSizeTrueCount = autoSizeTrue;
            _autoSizeFalseResidueCount = autoSizeFalseResidue;
            _raycastTargetFalseCount = raycastTargetFalse;
            _raycastTargetTrueResidueCount = raycastTargetTrueResidue;
        }

        /// <summary>
        /// 记录分组操作结果。
        /// 在分组规则执行完成后调用。
        /// </summary>
        /// <param name="nodesCreated">创建的分组父节点数量</param>
        /// <param name="nodesReparented">被重新设置父节点的子节点数量</param>
        public void RecordGrouping(int nodesCreated, int nodesReparented)
        {
            _groupingNodesCreated = nodesCreated;
            _nodesReparented = nodesReparented;
        }

        /// <summary>
        /// 添加错误信息。
        /// 错误表示生成过程中的严重问题。
        /// </summary>
        /// <param name="error">错误描述</param>
        public void AddError(string error)
        {
            if (!string.IsNullOrEmpty(error))
            {
                _errors.Add(error);
            }
        }

        /// <summary>
        /// 添加警告信息。
        /// 警告表示非阻塞性问题，生成可继续。
        /// </summary>
        /// <param name="warning">警告描述</param>
        public void AddWarning(string warning)
        {
            if (!string.IsNullOrEmpty(warning))
            {
                _warnings.Add(warning);
            }
        }

        /// <summary>
        /// 构建最终结果，自动检测阻塞失败。
        /// 
        /// 阻塞失败条件：
        /// - AutoSizeFalseResidueCount > 0（文本未启用自动尺寸）
        /// - RaycastTargetTrueResidueCount > 0（Image 未关闭射线检测）
        /// 
        /// 检测到阻塞失败时，自动将失败详情追加到 Errors 列表。
        /// </summary>
        /// <returns>包含完整统计和验证信息的 GenerationResult</returns>
        public GenerationResult Build()
        {
            var result = new GenerationResult
            {
                // 节点统计
                NodeCount = _nodeCount,
                ImageCount = _imageCount,
                TextCount = _textCount,
                PrefabInstanceCount = _prefabInstanceCount,

                // 后处理验证统计
                CommonFontAppliedCount = _commonFontAppliedCount,
                AutoSizeTrueCount = _autoSizeTrueCount,
                AutoSizeFalseResidueCount = _autoSizeFalseResidueCount,
                RaycastTargetFalseCount = _raycastTargetFalseCount,
                RaycastTargetTrueResidueCount = _raycastTargetTrueResidueCount,

                // 分组统计
                GroupingNodesCreated = _groupingNodesCreated,
                NodesReparented = _nodesReparented,
            };

            // 复制已收集的错误和警告
            result.Errors.AddRange(_errors);
            result.Warnings.AddRange(_warnings);

            // 阻塞失败检测
            DetectBlockingFailures(result);

            return result;
        }

        // ═══════════════════════════════════════════════════════
        // 私有方法
        // ═══════════════════════════════════════════════════════

        /// <summary>
        /// 检测阻塞失败条件并标记结果。
        /// AutoSize=false 残留或 RaycastTarget=true 残留视为阻塞失败，
        /// 必须在执行结果中明确标记，不得作为 warning 交付。
        /// </summary>
        private void DetectBlockingFailures(GenerationResult result)
        {
            bool hasBlocking = false;

            if (result.AutoSizeFalseResidueCount > 0)
            {
                hasBlocking = true;
                result.Errors.Add(
                    $"[阻塞失败] 检测到 {result.AutoSizeFalseResidueCount} 个 TextMeshProUGUI 的 enableAutoSizing=false 残留");
            }

            if (result.RaycastTargetTrueResidueCount > 0)
            {
                hasBlocking = true;
                result.Errors.Add(
                    $"[阻塞失败] 检测到 {result.RaycastTargetTrueResidueCount} 个 Image 的 raycastTarget=true 残留");
            }

            result.HasBlockingFailure = hasBlocking;
        }
    }
}
