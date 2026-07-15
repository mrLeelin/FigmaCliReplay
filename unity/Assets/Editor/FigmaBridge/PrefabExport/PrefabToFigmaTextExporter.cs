using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 负责导出 TMP_Text 和 UnityEngine.UI.Text 的静态文本数据。
    /// </summary>
    public static class PrefabToFigmaTextExporter
    {
        /// <summary>
        /// 尝试从当前节点导出文本组件数据。
        /// </summary>
        public static bool TryExport(GameObject gameObject, PrefabToFigmaNode node)
        {
            var tmpText = gameObject.GetComponent<TMP_Text>();
            if (tmpText != null)
            {
                node.text = BuildTmpText(tmpText);
                return true;
            }

            var legacyText = gameObject.GetComponent<Text>();
            if (legacyText != null)
            {
                node.text = BuildLegacyText(legacyText);
                return true;
            }

            return false;
        }

        /// <summary>
        /// 判断组件是否为 TMP 文本，供节点导出器过滤已支持组件。
        /// </summary>
        public static bool IsTmpText(Component component)
        {
            return component is TMP_Text;
        }

        /// <summary>
        /// 构建 TextMeshProUGUI/TMP_Text 文本数据。
        /// </summary>
        private static PrefabToFigmaText BuildTmpText(TMP_Text tmpText)
        {
            var text = new PrefabToFigmaText
            {
                componentType = tmpText.GetType().FullName ?? tmpText.GetType().Name,
                content = tmpText.text ?? string.Empty,
                fontSize = tmpText.fontSize,
                color = ToColor(tmpText.color),
                fontColor = ToColor(tmpText.color),
                autoSize = new PrefabToFigmaAutoSize
                {
                    enabled = tmpText.enableAutoSizing,
                    min = tmpText.fontSizeMin,
                    max = tmpText.fontSizeMax
                },
                alignment = new PrefabToFigmaAlignment
                {
                    horizontal = (int)tmpText.horizontalAlignment,
                    vertical = (int)tmpText.verticalAlignment,
                    legacy = (int)tmpText.alignment
                },
                options = new PrefabToFigmaTextOptions
                {
                    fontStyle = (int)tmpText.fontStyle,
                    wordWrapping = tmpText.textWrappingMode != TextWrappingModes.NoWrap,
                    overflowMode = (int)tmpText.overflowMode,
                    richText = tmpText.richText
                }
            };

            text.sharedMaterial = BuildMaterialRef(tmpText.fontSharedMaterial);
            return text;
        }

        /// <summary>
        /// 构建 UnityEngine.UI.Text 文本数据。
        /// </summary>
        private static PrefabToFigmaText BuildLegacyText(Text legacyText)
        {
            return new PrefabToFigmaText
            {
                componentType = legacyText.GetType().FullName ?? legacyText.GetType().Name,
                content = legacyText.text ?? string.Empty,
                fontSize = legacyText.fontSize,
                color = ToColor(legacyText.color),
                fontColor = ToColor(legacyText.color),
                autoSize = new PrefabToFigmaAutoSize
                {
                    enabled = legacyText.resizeTextForBestFit,
                    min = legacyText.resizeTextMinSize,
                    max = legacyText.resizeTextMaxSize
                },
                alignment = BuildLegacyAlignment(legacyText.alignment),
                options = new PrefabToFigmaTextOptions
                {
                    fontStyle = (int)legacyText.fontStyle,
                    wordWrapping = legacyText.horizontalOverflow == HorizontalWrapMode.Wrap,
                    overflowMode = (int)legacyText.verticalOverflow,
                    richText = legacyText.supportRichText
                }
            };
        }

        /// <summary>
        /// 把旧版 TextAnchor 映射为 TMP 兼容的水平/垂直对齐数值。
        /// </summary>
        private static PrefabToFigmaAlignment BuildLegacyAlignment(TextAnchor anchor)
        {
            var horizontal = 2;
            var vertical = 512;
            switch (anchor)
            {
                case TextAnchor.UpperLeft:
                case TextAnchor.MiddleLeft:
                case TextAnchor.LowerLeft:
                    horizontal = 1;
                    break;
                case TextAnchor.UpperRight:
                case TextAnchor.MiddleRight:
                case TextAnchor.LowerRight:
                    horizontal = 4;
                    break;
            }

            switch (anchor)
            {
                case TextAnchor.UpperLeft:
                case TextAnchor.UpperCenter:
                case TextAnchor.UpperRight:
                    vertical = 256;
                    break;
                case TextAnchor.LowerLeft:
                case TextAnchor.LowerCenter:
                case TextAnchor.LowerRight:
                    vertical = 1024;
                    break;
            }

            return new PrefabToFigmaAlignment
            {
                horizontal = horizontal,
                vertical = vertical,
                legacy = (int)anchor
            };
        }

        /// <summary>
        /// 构建 TMP 共享材质引用，便于后续扩展解析描边或阴影。
        /// </summary>
        private static PrefabToFigmaMaterialRef BuildMaterialRef(Material material)
        {
            if (material == null)
            {
                return null;
            }

            if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(material, out string guid, out long fileId))
            {
                return new PrefabToFigmaMaterialRef
                {
                    guid = guid.ToLowerInvariant(),
                    fileID = fileId
                };
            }

            return null;
        }

        /// <summary>
        /// 转换 Unity Color 到中间 JSON 颜色结构。
        /// </summary>
        private static PrefabToFigmaColor ToColor(Color color)
        {
            return new PrefabToFigmaColor
            {
                r = color.r,
                g = color.g,
                b = color.b,
                a = color.a
            };
        }
    }
}
