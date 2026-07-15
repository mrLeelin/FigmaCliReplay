using System;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;
using ZLog = UnityEngine.Debug;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Prefab 到 Figma 中间 JSON 的 C# 导出入口。
    /// </summary>
    public static class PrefabToFigmaExporter
    {
        /// <summary>中间 JSON 文件名。</summary>
        public const string JsonFileName = "prefab-to-figma.json";

        /// <summary>导出报告文件名。</summary>
        public const string ReportFileName = "report.md";

        /// <summary>
        /// 导出指定 Prefab，并把 prefab-to-figma.json 与 report.md 写入输出目录。
        /// </summary>
        public static bool TryExport(
            string repoRoot,
            string prefabPath,
            string outputDir,
            out string jsonPath,
            out string error)
        {
            jsonPath = Path.Combine(outputDir, JsonFileName);
            error = string.Empty;

            if (!ValidateInput(prefabPath, outputDir, out error))
            {
                return false;
            }

            GameObject prefabRoot = null;
            try
            {
                Directory.CreateDirectory(outputDir);
                prefabRoot = PrefabUtility.LoadPrefabContents(prefabPath);
                var package = BuildPackage(repoRoot, prefabPath, prefabRoot);
                WritePackage(package, outputDir);
                return package.fatalErrors.Count == 0;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                ZLog.LogError($"[PrefabToFigma] C# 导出异常：{ex}");
                return false;
            }
            finally
            {
                if (prefabRoot != null)
                {
                    PrefabUtility.UnloadPrefabContents(prefabRoot);
                }
            }
        }

        /// <summary>
        /// 校验导出入参，避免对非 Prefab 资源执行导出。
        /// </summary>
        private static bool ValidateInput(string prefabPath, string outputDir, out string error)
        {
            if (string.IsNullOrEmpty(prefabPath))
            {
                error = "Prefab 路径不能为空";
                return false;
            }

            if (!prefabPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                error = $"目标不是 Prefab：{prefabPath}";
                return false;
            }

            if (string.IsNullOrEmpty(outputDir))
            {
                error = "输出目录不能为空";
                return false;
            }

            error = string.Empty;
            return true;
        }

        /// <summary>
        /// 从加载后的 Prefab 根对象构建完整中间包。
        /// </summary>
        private static PrefabToFigmaPackage BuildPackage(string repoRoot, string prefabPath, GameObject prefabRoot)
        {
            var package = new PrefabToFigmaPackage
            {
                prefabPath = NormalizePrefabPath(prefabPath),
                canvas = BuildCanvas(prefabRoot),
                visualBounds = new PrefabToFigmaVisualBounds(),
                stats = new PrefabToFigmaStats()
            };

            var rootRect = prefabRoot != null ? prefabRoot.GetComponent<RectTransform>() : null;
            if (rootRect == null)
            {
                package.fatalErrors.Add("No root RectTransform parsed from Prefab");
                package.root = new PrefabToFigmaNode
                {
                    id = "0",
                    name = prefabRoot != null ? prefabRoot.name : "UnknownPrefab",
                    path = prefabRoot != null ? prefabRoot.name : "UnknownPrefab",
                    active = prefabRoot == null || prefabRoot.activeSelf,
                    rect = new PrefabToFigmaRect(),
                    unity = new PrefabToFigmaUnityData()
                };
                return package;
            }

            PrefabToFigmaNodeBuilder.Build(prefabRoot, rootRect, package, repoRoot);
            return package;
        }

        /// <summary>
        /// 根据根 RectTransform 自动推导画布尺寸。
        /// </summary>
        private static PrefabToFigmaCanvas BuildCanvas(GameObject prefabRoot)
        {
            var rootRect = prefabRoot != null ? prefabRoot.GetComponent<RectTransform>() : null;
            if (rootRect == null)
            {
                return new PrefabToFigmaCanvas();
            }

            var scale = rootRect.localScale;
            var size = rootRect.sizeDelta;
            return new PrefabToFigmaCanvas
            {
                width = Mathf.Abs(size.x * scale.x),
                height = Mathf.Abs(size.y * scale.y)
            };
        }

        /// <summary>
        /// 输出与 Python parser 兼容的仓库相对 Prefab 路径。
        /// </summary>
        private static string NormalizePrefabPath(string prefabPath)
        {
            if (prefabPath.StartsWith("Assets/", StringComparison.Ordinal))
            {
                return "JellybeanUnity/" + prefabPath;
            }

            return prefabPath.Replace('\\', '/');
        }

        /// <summary>
        /// 写出 JSON 和 Markdown 报告。
        /// </summary>
        private static void WritePackage(PrefabToFigmaPackage package, string outputDir)
        {
            var json = PrefabToFigmaJsonWriter.ToJson(package);
            var report = PrefabToFigmaReportWriter.BuildReport(package);
            File.WriteAllText(Path.Combine(outputDir, JsonFileName), json, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(outputDir, ReportFileName), report, new UTF8Encoding(false));
        }
    }
}
