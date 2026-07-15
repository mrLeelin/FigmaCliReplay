using System.Text;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 负责生成 Prefab 到 Figma 导出报告。
    /// </summary>
    public static class PrefabToFigmaReportWriter
    {
        /// <summary>
        /// 按 Python parser 的 report.md 结构生成 Markdown 报告。
        /// </summary>
        public static string BuildReport(PrefabToFigmaPackage package)
        {
            var stats = package.stats ?? new PrefabToFigmaStats();
            var canvas = package.canvas ?? new PrefabToFigmaCanvas();
            var sb = new StringBuilder(2048);
            sb.AppendLine("# Prefab To Figma Report");
            sb.AppendLine();
            sb.AppendLine($"- Prefab: `{package.prefabPath}`");
            sb.AppendLine($"- Canvas: `{canvas.width}x{canvas.height}`");
            sb.AppendLine($"- Visual bounds: `{FormatBounds(package.visualBounds)}`");
            sb.AppendLine($"- Nodes: `{stats.nodeCount}`");
            sb.AppendLine($"- Images: `{stats.imageCount}`");
            sb.AppendLine($"- Texts: `{stats.textCount}`");
            sb.AppendLine($"- Nine-slice: `{stats.nineSliceCount}`");
            sb.AppendLine($"- Clip nodes: `{stats.clipCount}`");
            sb.AppendLine($"- Prefab instances: `{stats.prefabInstanceCount}`");
            sb.AppendLine($"- Unsupported: `{stats.unsupportedCount}`");
            sb.AppendLine();
            AppendList(sb, "Warnings", package.warnings);
            AppendList(sb, "Fatal Errors", package.fatalErrors);
            return sb.ToString();
        }

        /// <summary>
        /// 写入报告中的列表章节，空列表输出 None。
        /// </summary>
        private static void AppendList(StringBuilder sb, string title, System.Collections.Generic.List<string> values)
        {
            sb.AppendLine("## " + title);
            sb.AppendLine();
            if (values != null && values.Count > 0)
            {
                for (int i = 0; i < values.Count; i++)
                {
                    sb.AppendLine("- " + values[i]);
                }
            }
            else
            {
                sb.AppendLine("- None");
            }

            sb.AppendLine();
        }

        /// <summary>
        /// 格式化视觉包围盒，便于人工阅读。
        /// </summary>
        private static string FormatBounds(PrefabToFigmaVisualBounds bounds)
        {
            if (bounds == null)
            {
                return "None";
            }

            return $"{bounds.x},{bounds.y} {bounds.width}x{bounds.height}";
        }
    }
}
