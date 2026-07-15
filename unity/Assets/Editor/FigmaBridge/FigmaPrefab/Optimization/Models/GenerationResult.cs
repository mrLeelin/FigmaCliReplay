using System;
using System.Collections.Generic;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// Prefab 生成结果，包含节点统计、后处理验证和错误信息
    /// </summary>
    [Serializable]
    public class GenerationResult
    {
        // ─── 节点统计 ───

        /// <summary>总节点数</summary>
        public int NodeCount;

        /// <summary>图片节点数</summary>
        public int ImageCount;

        /// <summary>文本节点数</summary>
        public int TextCount;

        /// <summary>Prefab 实例节点数</summary>
        public int PrefabInstanceCount;

        // ─── 后处理验证统计 ───

        /// <summary>已应用 CommonFont 的文本数量</summary>
        public int CommonFontAppliedCount;

        /// <summary>已启用 AutoSize 的文本数量</summary>
        public int AutoSizeTrueCount;

        /// <summary>AutoSize 未启用的残留数量（阻塞失败）</summary>
        public int AutoSizeFalseResidueCount;

        /// <summary>已关闭 RaycastTarget 的 Image 数量</summary>
        public int RaycastTargetFalseCount;

        /// <summary>RaycastTarget 仍为 true 的残留数量（阻塞失败）</summary>
        public int RaycastTargetTrueResidueCount;

        // ─── 分组统计 ───

        /// <summary>创建的分组父节点数量</summary>
        public int GroupingNodesCreated;

        /// <summary>被重新设置父节点的子节点数量</summary>
        public int NodesReparented;

        // ─── 错误与警告 ───

        /// <summary>错误列表</summary>
        public List<string> Errors = new List<string>();

        /// <summary>警告列表</summary>
        public List<string> Warnings = new List<string>();

        /// <summary>是否存在阻塞失败（AutoSize=false 或 RaycastTarget=true 残留）</summary>
        public bool HasBlockingFailure;
    }
}
