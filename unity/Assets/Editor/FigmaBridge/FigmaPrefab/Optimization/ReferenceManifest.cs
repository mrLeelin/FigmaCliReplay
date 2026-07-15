using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 参考文件加载清单，按导入场景定义最小必需文件集，避免上下文膨胀。
    /// 使用 static readonly 数组避免重复分配。
    /// </summary>
    public class ReferenceManifest
    {
        // ─────────────────────────────────────────────
        // 必需参考文件映射（按场景）
        // ─────────────────────────────────────────────

        /// <summary>
        /// NewPrefab 场景必需参考：JSON Spec 格式 + UGUI 导入约定
        /// </summary>
        private static readonly string[] NewPrefabReferences = new string[]
        {
            "json-spec-format.md",
            "figma-ugui-import-conventions.md"
        };

        /// <summary>
        /// SyncExisting 场景必需参考：JSON Spec 格式 + UGUI 导入约定 + 同步工作流
        /// </summary>
        private static readonly string[] SyncExistingReferences = new string[]
        {
            "json-spec-format.md",
            "figma-ugui-import-conventions.md",
            "sync-workflow.md"
        };

        /// <summary>
        /// ImageOnly 场景必需参考：仅 JSON Spec 格式（图片相关部分）
        /// </summary>
        private static readonly string[] ImageOnlyReferences = new string[]
        {
            "json-spec-format.md"
        };

        // ─────────────────────────────────────────────
        // 按需参考文件映射（按 Pitfall 触发条件）
        // ─────────────────────────────────────────────

        /// <summary>
        /// 九宫格节点触发时加载的 pitfall 段落
        /// </summary>
        private static readonly string[] NineSliceReferences = new string[]
        {
            "pitfalls-nine-slice.md"
        };

        /// <summary>
        /// TMP 材质标签触发时加载的 pitfall 段落
        /// </summary>
        private static readonly string[] TmpMaterialReferences = new string[]
        {
            "pitfalls-tmp-material.md"
        };

        /// <summary>
        /// 实例节点触发时加载的 pitfall 段落
        /// </summary>
        private static readonly string[] InstanceNodeReferences = new string[]
        {
            "pitfalls-instance-node.md"
        };

        /// <summary>
        /// 获取指定导入场景的必需参考文件列表。
        /// 返回的数组为 static readonly，调用方不应修改其内容。
        /// </summary>
        /// <param name="scenario">导入场景</param>
        /// <returns>该场景下必须加载的参考文件名数组</returns>
        public string[] GetMandatoryReferences(ImportScenario scenario)
        {
            switch (scenario)
            {
                case ImportScenario.NewPrefab:
                    return NewPrefabReferences;
                case ImportScenario.SyncExisting:
                    return SyncExistingReferences;
                case ImportScenario.ImageOnly:
                    return ImageOnlyReferences;
                default:
                    throw new ArgumentOutOfRangeException(
                        nameof(scenario),
                        scenario,
                        "未知的导入场景类型");
            }
        }

        /// <summary>
        /// 获取指定陷阱触发条件的按需参考文件。
        /// 仅在检测到对应条件时才加载，避免全量加载 pitfalls 文档。
        /// </summary>
        /// <param name="condition">陷阱触发条件</param>
        /// <returns>该条件下需要加载的 pitfall 参考文件名数组</returns>
        public string[] GetOnDemandReferences(PitfallCondition condition)
        {
            switch (condition)
            {
                case PitfallCondition.NineSliceNode:
                    return NineSliceReferences;
                case PitfallCondition.TmpMaterialTag:
                    return TmpMaterialReferences;
                case PitfallCondition.InstanceNode:
                    return InstanceNodeReferences;
                default:
                    throw new ArgumentOutOfRangeException(
                        nameof(condition),
                        condition,
                        "未知的陷阱触发条件");
            }
        }
    }
}
