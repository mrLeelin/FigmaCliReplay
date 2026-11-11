using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Figma 文本样式同步工具，用于把选中文本颜色、描边和投影近似应用到 Unity TMP 文本或材质球。
    /// </summary>
    internal static class FigmaTextStyleSyncUtility
    {
        /// <summary>未配置导入字体时的兼容路径。</summary>
        private const string DefaultCommonFontPath =
            "Assets/MagicWarrior/_Resources/Font/Package/CommonFont.asset";

        private const string NestedCommonFontPath =
            "Assets/MagicWarrior/_Resources/Font/Package/CommonFont/CommonFont.asset";

        /// <summary>
        /// 项目通用 TMP 字体资产路径。与 Prefab 生成器共用 ProjectSettings 配置，
        /// 以支持 CommonFont 放在 Package 子目录等项目布局。
        /// </summary>
        private static string CommonFontPath
        {
            get
            {
                string configuredPath = FigmaBridgeImportSettings.FontPath;
                if (!string.IsNullOrWhiteSpace(configuredPath))
                {
                    return configuredPath.Replace("\\", "/");
                }

                // Older projects used the flat path; current projects commonly keep
                // the font and its material in a CommonFont subdirectory.
                string[] candidates = { NestedCommonFontPath, DefaultCommonFontPath };
                foreach (string candidate in candidates)
                {
                    if (AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(candidate) != null)
                    {
                        return candidate;
                    }
                }

                return DefaultCommonFontPath;
            }
        }

        /// <summary>项目通用 TMP 字体材质路径。</summary>
        private static string CommonFontMatPath => Path.ChangeExtension(CommonFontPath, ".mat").Replace("\\", "/");

        /// <summary>Figma 专用 TMP 材质输出目录。</summary>
        private static string FigmaTextMaterialDir =>
            Path.GetDirectoryName(CommonFontPath)?.Replace("\\", "/") ?? "Assets/MagicWarrior/_Resources/Font/Package";

        /// <summary>TMP 材质浮点参数近似匹配误差。</summary>
        private const float MaterialFloatTolerance = 0.015f;

        /// <summary>TMP 材质颜色近似匹配误差。</summary>
        private const float MaterialColorTolerance = 0.015f;

        /// <summary>
        /// 将 Figma 文本样式同步到 Unity 当前选中的 TMP 文本对象或 TMP 材质球。
        /// </summary>
        public static TextStyleSyncResult SyncToCurrentSelection(FigmaTextStylePayload style, TextStyleSyncOptions options = null)
        {
            if (style == null)
            {
                throw new InvalidOperationException("没有收到 Figma 文本样式数据。");
            }

            if (style.fillColor == null)
            {
                throw new InvalidOperationException("Figma 文本样式缺少填充颜色。");
            }

            options ??= TextStyleSyncOptions.Default;
            CalibrateOutlineForFont(style.textMaterial, style.fontSize);
            var result = new TextStyleSyncResult
            {
                ok = true,
                figmaNodeName = style.nodeName ?? string.Empty,
                syncColor = options.syncColor,
                syncFontSize = options.syncFontSize,
                warnings = new List<string>()
            };

            UnityEngine.Object activeObject = Selection.activeObject;
            GameObject activeGameObject = Selection.activeGameObject;

            if (activeGameObject != null && TryGetSelectedTmpText(activeGameObject, out TMP_Text tmpText))
            {
                Material material = ResolveTextMaterial(style.textMaterial, result.warnings);
                ApplyToTmpText(tmpText, style, material, options, result);
                return result;
            }

            if (activeObject is Material selectedMaterial)
            {
                ApplyToMaterial(selectedMaterial, style.textMaterial, result);
                result.targetName = selectedMaterial.name;
                result.targetType = "Material";
                result.materialPath = AssetDatabase.GetAssetPath(selectedMaterial);
                if (options.syncColor)
                {
                    result.warnings.Add("Unity 当前选中的是材质球，颜色不会写入 TMP 文本组件。");
                }
                if (options.syncFontSize)
                {
                    result.warnings.Add("Unity 当前选中的是材质球，字号不会写入 TMP 文本组件。");
                }
                return result;
            }

            if (activeObject is TMP_FontAsset)
            {
                throw new InvalidOperationException("当前选中的是 TMP 字体资产。字体颜色属于 TMP 文本组件，请选中场景或 Prefab 中的 TMP 文本对象；如果只想同步描边材质，请选中 TMP 材质球。");
            }

            throw new InvalidOperationException("请在 Unity 中选中一个带 TMP_Text/TextMeshProUGUI 的 GameObject，或选中一个 TMP 材质球。");
        }

        /// <summary>
        /// 在选中 GameObject 上查找 TMP 文本组件，优先当前节点，其次查找子节点。
        /// </summary>
        private static bool TryGetSelectedTmpText(GameObject gameObject, out TMP_Text tmpText)
        {
            tmpText = gameObject.GetComponent<TMP_Text>();
            if (tmpText != null)
            {
                return true;
            }

            tmpText = gameObject.GetComponentInChildren<TMP_Text>(true);
            return tmpText != null;
        }

        /// <summary>
        /// 把颜色和 TMP 材质应用到目标文本组件。
        /// </summary>
        private static void ApplyToTmpText(
            TMP_Text tmpText,
            FigmaTextStylePayload style,
            Material material,
            TextStyleSyncOptions options,
            TextStyleSyncResult result)
        {
            Undo.RecordObject(tmpText, "同步 Figma 文本样式");
            if (options.syncColor)
            {
                tmpText.color = ToColor(style.fillColor);
            }

            if (options.syncFontSize)
            {
                if (style.fontSize > 0f)
                {
                    tmpText.fontSize = style.fontSize;
                }
                else
                {
                    result.warnings.Add("Figma 文本字号无效，已跳过字号同步。");
                }
            }

            var commonFont = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(CommonFontPath);
            if (commonFont != null)
            {
                tmpText.font = commonFont;
            }
            else
            {
                result.warnings.Add($"未找到 CommonFont 字体资产：{CommonFontPath}");
            }

            if (material != null)
            {
                tmpText.fontSharedMaterial = material;
                result.materialPath = AssetDatabase.GetAssetPath(material);
            }
            else
            {
                result.warnings.Add("没有可绑定的 TMP 材质，已只同步字体颜色。");
            }

            EditorUtility.SetDirty(tmpText);
            result.targetName = tmpText.gameObject.name;
            result.targetType = tmpText.GetType().Name;
        }

        /// <summary>
        /// 根据 Figma 材质需求复用、创建或回退 TMP 字体材质。
        /// </summary>
        private static Material ResolveTextMaterial(TextMaterialPayload materialSpec, List<string> warnings)
        {
            if (materialSpec == null || !materialSpec.enabled)
            {
                Material commonMaterial = AssetDatabase.LoadAssetAtPath<Material>(CommonFontMatPath);
                if (commonMaterial == null)
                {
                    warnings.Add($"未找到 CommonFont 材质：{CommonFontMatPath}");
                }

                return commonMaterial;
            }

            Material existing = FindApproximateTextMaterial(materialSpec);
            if (existing != null)
            {
                return existing;
            }

            Material baseMaterial = AssetDatabase.LoadAssetAtPath<Material>(CommonFontMatPath);
            if (baseMaterial == null)
            {
                warnings.Add($"无法创建 TMP 材质，缺少基础材质：{CommonFontMatPath}");
                return null;
            }

            EnsureAssetDirectory(FigmaTextMaterialDir);
            string signature = string.IsNullOrEmpty(materialSpec.signature)
                ? BuildTextMaterialSignature(materialSpec)
                : materialSpec.signature;
            string materialName = string.IsNullOrEmpty(materialSpec.materialName)
                ? $"CommonFont_figma_{signature}"
                : materialSpec.materialName;
            string materialPath = AssetDatabase.GenerateUniqueAssetPath(
                $"{FigmaTextMaterialDir}/{SanitizeAssetName(materialName)}.mat");
            var material = new Material(baseMaterial)
            {
                name = Path.GetFileNameWithoutExtension(materialPath)
            };
            ApplyMaterialProperties(material, materialSpec);
            AssetDatabase.CreateAsset(material, materialPath);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return AssetDatabase.LoadAssetAtPath<Material>(materialPath);
        }

        /// <summary>
        /// 直接覆盖选中材质球的 TMP 描边和投影参数。
        /// </summary>
        private static void ApplyToMaterial(
            Material material,
            TextMaterialPayload materialSpec,
            TextStyleSyncResult result)
        {
            if (material == null)
            {
                throw new InvalidOperationException("Unity 当前选中的材质为空。");
            }

            Undo.RecordObject(material, "同步 Figma TMP 材质");
            ApplyMaterialProperties(material, materialSpec);
            EditorUtility.SetDirty(material);
            AssetDatabase.SaveAssets();
        }

        /// <summary>
        /// 扫描现有 CommonFont 材质，近似匹配描边和投影参数以避免材质重复生成。
        /// </summary>
        private static Material FindApproximateTextMaterial(TextMaterialPayload materialSpec)
        {
            string[] searchFolders = GetExistingMaterialSearchFolders();
            if (searchFolders.Length == 0)
            {
                return null;
            }

            string[] guids = AssetDatabase.FindAssets("t:Material CommonFont", searchFolders);
            foreach (string guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                var material = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (material != null && IsMaterialApproximateMatch(material, materialSpec))
                {
                    return material;
                }
            }

            return null;
        }

        /// <summary>
        /// 判断现有材质是否与 Figma 描边/投影需求近似一致。
        /// </summary>
        private static bool IsMaterialApproximateMatch(Material material, TextMaterialPayload spec)
        {
            if (!spec.hasOutline && material.IsKeywordEnabled("OUTLINE_ON"))
            {
                return false;
            }

            if (!spec.hasUnderlay && material.IsKeywordEnabled("UNDERLAY_ON"))
            {
                return false;
            }

            if (spec.hasOutline && !material.IsKeywordEnabled("OUTLINE_ON"))
            {
                return false;
            }

            if (spec.hasUnderlay && !material.IsKeywordEnabled("UNDERLAY_ON"))
            {
                return false;
            }

            if (spec.hasOutline
                && (!MaterialFloatApprox(material, "_OutlineWidth", spec.outlineWidth)
                    || !MaterialColorApprox(material, "_OutlineColor", ToColor(spec.outlineColor))))
            {
                return false;
            }

            // 描边落点由 _FaceDilate 决定：同宽但按旧规则（宽度/2）生成的材质会把外描边画细，不能复用
            if (spec.hasOutline && HasStrokeAlign(spec)
                && !MaterialFloatApprox(material, "_FaceDilate", ResolveFaceDilate(spec)))
            {
                return false;
            }

            if (spec.hasUnderlay
                && (!MaterialFloatApprox(material, "_UnderlayOffsetX", spec.underlayOffsetX)
                    || !MaterialFloatApprox(material, "_UnderlayOffsetY", spec.underlayOffsetY)
                    || !MaterialFloatApprox(material, "_UnderlaySoftness", spec.underlaySoftness)
                    || !MaterialFloatApprox(material, "_UnderlayDilate", spec.underlayDilate)
                    || !MaterialColorApprox(material, "_UnderlayColor", ToColor(spec.underlayColor))))
            {
                return false;
            }

            return true;
        }

        /// <summary>
        /// 将 Figma 近似参数写入 TMP 材质属性。
        /// </summary>
        private static void ApplyMaterialProperties(Material material, TextMaterialPayload spec)
        {
            if (material == null)
            {
                return;
            }

            bool hasOutline = spec != null && spec.hasOutline && spec.outlineWidth > 0.001f;
            bool hasUnderlay = spec != null && spec.hasUnderlay;
            SetMaterialFloat(material, "_OutlineWidth", hasOutline ? spec.outlineWidth : 0f);
            SetMaterialFloat(material, "_FaceDilate", hasOutline ? ResolveFaceDilate(spec) : 0f);
            SetMaterialColor(material, "_OutlineColor", hasOutline ? ToColor(spec.outlineColor) : Color.black);
            SetMaterialFloat(material, "_UnderlayOffsetX", hasUnderlay ? spec.underlayOffsetX : 0f);
            SetMaterialFloat(material, "_UnderlayOffsetY", hasUnderlay ? spec.underlayOffsetY : 0f);
            SetMaterialFloat(material, "_UnderlaySoftness", hasUnderlay ? spec.underlaySoftness : 0f);
            SetMaterialFloat(material, "_UnderlayDilate", hasUnderlay ? spec.underlayDilate : 0f);
            SetMaterialColor(material, "_UnderlayColor", hasUnderlay ? ToColor(spec.underlayColor) : Color.black);
            SetKeyword(material, "OUTLINE_ON", hasOutline);
            SetKeyword(material, "UNDERLAY_ON", hasUnderlay);
        }

        /// <summary>
        /// 获取已存在的 TMP 材质搜索目录，避免 AssetDatabase 扫描不存在路径。
        /// </summary>
        private static string[] GetExistingMaterialSearchFolders()
        {
            string[] candidateFolders =
            {
                FigmaTextMaterialDir,
                // 保留旧目录，兼容尚未迁移材质的工程。
                "Assets/MagicWarrior/_Resources/Font/Package",
                "Assets/_Resources/Sharders/Font"
            };
            return candidateFolders
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Where(AssetDatabase.IsValidFolder)
                .ToArray();
        }

        /// <summary>
        /// 按 Spec 参数构建兜底签名，防止旧请求未写 signature。
        /// </summary>
        private static string BuildTextMaterialSignature(TextMaterialPayload spec)
        {
            if (spec == null || (!spec.hasOutline && !spec.hasUnderlay))
            {
                return string.Empty;
            }

            string outline = spec.hasOutline ? ColorUtility.ToHtmlStringRGBA(ToColor(spec.outlineColor)) : "none";
            string underlay = spec.hasUnderlay ? ColorUtility.ToHtmlStringRGBA(ToColor(spec.underlayColor)) : "none";
            return $"o_{outline}_w_{Mathf.RoundToInt(spec.outlineWidth * 100):000}{StrokeAlignSignatureToken(spec)}_u_{underlay}"
                + $"_x_{Mathf.RoundToInt((spec.underlayOffsetX + 1f) * 100f):000}"
                + $"_y_{Mathf.RoundToInt((spec.underlayOffsetY + 1f) * 100f):000}"
                + $"_s_{Mathf.RoundToInt(spec.underlaySoftness * 100f):000}"
                + $"_d_{Mathf.RoundToInt(spec.underlayDilate * 100f):000}";
        }

        /// <summary>请求是否携带 Figma 描边对齐（由新版插件发送）。</summary>
        private static bool HasStrokeAlign(TextMaterialPayload spec)
        {
            if (spec == null || string.IsNullOrEmpty(spec.strokeAlign))
            {
                return false;
            }
            // 只认规范值，未知值（如 MIXED）与 Python normalize_stroke_align 一致按旧规则处理
            string align = spec.strokeAlign.ToUpperInvariant();
            return align == "OUTSIDE" || align == "CENTER" || align == "INSIDE";
        }

        /// <summary>
        /// 计算 TMP _FaceDilate。TMP_SDF 描边以膨胀后的字形边缘为中心向两侧各画一半：
        /// 新请求直接使用 faceDilate（OUTSIDE = 宽度，字身不被描边侵蚀）；旧请求保持 outlineWidth/2。
        /// </summary>
        private static float ResolveFaceDilate(TextMaterialPayload spec)
        {
            if (spec == null || !spec.hasOutline)
            {
                return 0f;
            }
            return HasStrokeAlign(spec) ? Mathf.Clamp(spec.faceDilate, -1f, 1f) : spec.outlineWidth * 0.5f;
        }

        /// <summary>兜底签名中的对齐片段，与 Python text_outline 和 Prefab 生成器保持一致。</summary>
        private static string StrokeAlignSignatureToken(TextMaterialPayload spec)
        {
            if (!HasStrokeAlign(spec))
            {
                return string.Empty;
            }
            switch (spec.strokeAlign.ToUpperInvariant())
            {
                case "OUTSIDE": return "_a_out";
                case "CENTER": return "_a_ctr";
                case "INSIDE": return "_a_in";
                default: return string.Empty;
            }
        }

        /// <summary>
        /// 按 Unity 中真实 CommonFont 的 SDF 参数校正描边：OutlineWidth = 描边px × pointSize / (2 × padding × 字号)。
        /// Figma 插件只能按默认 58/10 估算；仅校正带 strokeAlign 的请求，旧请求保持原值。
        /// 字号取 Figma 字号：描边按 Figma 设计比例换算，与插件生成的材质名一致，材质也可能被不同字号的文本共用。
        /// </summary>
        private static void CalibrateOutlineForFont(TextMaterialPayload spec, float fontSize)
        {
            if (spec == null || !spec.enabled || !spec.hasOutline || !HasStrokeAlign(spec)
                || spec.sourceStrokeWeight <= 0f || fontSize <= 0f)
            {
                return;
            }

            var font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(CommonFontPath);
            float pointSize = font != null ? (float)font.faceInfo.pointSize : 0f;
            float padding = font != null ? font.atlasPadding : 0f;
            if (pointSize <= 0f || padding <= 0f)
            {
                BridgeLogger.Warn($"[FigmaTextStyleSync] 未读到 CommonFont SDF 参数，沿用插件估算的描边宽度 {spec.outlineWidth:0.##}：{CommonFontPath}",
                    operationName: "unity.text-style-sync");
                return;
            }

            float width = Mathf.Round(Mathf.Clamp01(spec.sourceStrokeWeight * pointSize / (2f * padding * fontSize)) * 100f) / 100f;
            if (width <= 0.01f)
            {
                // 与插件/Python 一致：换算后宽度过小视为无描边，只保留投影（若有）
                BridgeLogger.Info($"[FigmaTextStyleSync] 描边换算宽度 {width:0.##} 过小，按无描边处理（fontSize={fontSize}）",
                    operationName: "unity.text-style-sync");
                spec.hasOutline = false;
                spec.outlineWidth = 0f;
                spec.faceDilate = 0f;
                spec.strokeAlign = string.Empty;
                spec.enabled = spec.hasUnderlay;
                return;
            }

            if (Mathf.Abs(width - spec.outlineWidth) < 0.005f)
            {
                return;
            }

            // 宽度变化时同步改写签名与材质名里的宽度片段，避免材质名与实际参数不一致
            string oldToken = $"_w_{Mathf.RoundToInt(spec.outlineWidth * 100f):000}";
            string newToken = $"_w_{Mathf.RoundToInt(width * 100f):000}";
            float oldWidth = spec.outlineWidth;
            spec.outlineWidth = width;
            spec.faceDilate = spec.strokeAlign.ToUpperInvariant() == "OUTSIDE" ? width
                : spec.strokeAlign.ToUpperInvariant() == "INSIDE" ? -width : 0f;
            spec.signature = spec.signature?.Replace(oldToken, newToken);
            spec.materialName = spec.materialName?.Replace(oldToken, newToken);
            BridgeLogger.Info($"[FigmaTextStyleSync] 按字体 SDF 参数校正描边宽度 {oldWidth:0.##} -> {width:0.##}"
                + $"（pointSize={pointSize}, padding={padding}, fontSize={fontSize}, align={spec.strokeAlign}）",
                operationName: "unity.text-style-sync");
        }

        /// <summary>
        /// 创建 Unity 资源目录，逐级创建可避免 AssetDatabase 目录缺失。
        /// </summary>
        private static void EnsureAssetDirectory(string assetDirectory)
        {
            if (AssetDatabase.IsValidFolder(assetDirectory))
            {
                return;
            }

            string[] parts = assetDirectory.Split('/');
            if (parts.Length == 0 || parts[0] != "Assets")
            {
                throw new InvalidOperationException($"只允许在 Assets 下创建材质目录：{assetDirectory}");
            }

            string current = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                string next = $"{current}/{parts[i]}";
                if (!AssetDatabase.IsValidFolder(next))
                {
                    AssetDatabase.CreateFolder(current, parts[i]);
                }

                current = next;
            }
        }

        /// <summary>
        /// 清理资源名中的非法字符，避免创建材质失败。
        /// </summary>
        private static string SanitizeAssetName(string rawName)
        {
            string name = string.IsNullOrEmpty(rawName) ? "CommonFont_figma_text_style" : rawName;
            foreach (char invalidChar in Path.GetInvalidFileNameChars())
            {
                name = name.Replace(invalidChar, '_');
            }

            return name.Trim();
        }

        /// <summary>
        /// 判断材质浮点属性是否近似匹配。
        /// </summary>
        private static bool MaterialFloatApprox(Material material, string property, float expected)
        {
            if (!material.HasProperty(property))
            {
                return Mathf.Abs(expected) <= MaterialFloatTolerance;
            }

            return Mathf.Abs(material.GetFloat(property) - expected) <= MaterialFloatTolerance;
        }

        /// <summary>
        /// 判断材质颜色属性是否近似匹配。
        /// </summary>
        private static bool MaterialColorApprox(Material material, string property, Color expected)
        {
            if (!material.HasProperty(property))
            {
                return expected.maxColorComponent <= MaterialColorTolerance
                    && expected.a <= MaterialColorTolerance;
            }

            Color actual = material.GetColor(property);
            return Mathf.Abs(actual.r - expected.r) <= MaterialColorTolerance
                && Mathf.Abs(actual.g - expected.g) <= MaterialColorTolerance
                && Mathf.Abs(actual.b - expected.b) <= MaterialColorTolerance
                && Mathf.Abs(actual.a - expected.a) <= MaterialColorTolerance;
        }

        /// <summary>
        /// 安全写入材质浮点属性。
        /// </summary>
        private static void SetMaterialFloat(Material material, string property, float value)
        {
            if (material.HasProperty(property))
            {
                material.SetFloat(property, value);
            }
        }

        /// <summary>
        /// 安全写入材质颜色属性。
        /// </summary>
        private static void SetMaterialColor(Material material, string property, Color value)
        {
            if (material.HasProperty(property))
            {
                material.SetColor(property, value);
            }
        }

        /// <summary>
        /// 开关 TMP shader keyword。
        /// </summary>
        private static void SetKeyword(Material material, string keyword, bool enabled)
        {
            if (enabled)
            {
                material.EnableKeyword(keyword);
            }
            else
            {
                material.DisableKeyword(keyword);
            }
        }

        /// <summary>
        /// 将 Figma 0-1 RGBA 转换为 Unity Color。
        /// </summary>
        private static Color ToColor(ColorPayload color)
        {
            if (color == null)
            {
                return Color.black;
            }

            return new Color(
                Mathf.Clamp01(color.r),
                Mathf.Clamp01(color.g),
                Mathf.Clamp01(color.b),
                Mathf.Clamp01(color.a));
        }
    }

    /// <summary>
    /// Figma 文本样式同步结果，用于 HTTP JSON 响应。
    /// </summary>
    [Serializable]
    internal sealed class TextStyleSyncResult
    {
        public bool ok;
        public string figmaNodeName;
        public string targetName;
        public string targetType;
        public string materialPath;
        public bool syncColor;
        public bool syncFontSize;
        public List<string> warnings;
    }

    /// <summary>
    /// 字体样式同步选项，控制是否写入 TMP 文本颜色和字号。
    /// </summary>
    internal sealed class TextStyleSyncOptions
    {
        public bool syncColor = true;
        public bool syncFontSize = true;

        /// <summary>默认同步选项，兼容旧请求。</summary>
        public static TextStyleSyncOptions Default => new TextStyleSyncOptions();
    }

    /// <summary>
    /// Figma 文本样式同步请求中的文本样式数据。
    /// </summary>
    [Serializable]
    internal sealed class FigmaTextStylePayload
    {
        public string nodeId;
        public string nodeName;
        public string pageName;
        public float fontSize;
        public ColorPayload fillColor;
        public ColorPayload strokeColor;
        public float strokeWeight;
        public TextMaterialPayload textMaterial;
    }

    /// <summary>
    /// JSON 反序列化使用的 RGBA 颜色。
    /// </summary>
    [Serializable]
    internal sealed class ColorPayload
    {
        public float r;
        public float g;
        public float b;
        public float a = 1f;
    }

    /// <summary>
    /// Figma 文本描边和投影映射到 TMP 材质所需的参数。
    /// </summary>
    [Serializable]
    internal sealed class TextMaterialPayload
    {
        public bool enabled;
        public string signature;
        public string materialName;
        public ColorPayload outlineColor;
        public float outlineWidth;
        public ColorPayload underlayColor;
        public float underlayOffsetX;
        public float underlayOffsetY;
        public float underlaySoftness;
        public float underlayDilate;
        public bool hasOutline;
        public bool hasUnderlay;
        public float sourceStrokeWeight;
        /// <summary>Figma 描边对齐：OUTSIDE / CENTER / INSIDE；为空表示旧请求，FaceDilate 沿用 outlineWidth/2</summary>
        public string strokeAlign;
        /// <summary>TMP _FaceDilate 目标值（-1~1），仅 strokeAlign 非空时生效</summary>
        public float faceDilate;
    }
}
