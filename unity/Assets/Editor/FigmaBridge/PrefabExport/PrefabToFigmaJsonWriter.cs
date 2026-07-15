using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 将 C# 导出数据写成 prefab-to-figma.json 兼容格式。
    /// </summary>
    public static class PrefabToFigmaJsonWriter
    {
        /// <summary>
        /// 序列化完整导出包。
        /// </summary>
        public static string ToJson(PrefabToFigmaPackage package)
        {
            var sb = new StringBuilder(32768);
            sb.Append("{");
            WriteProperty(sb, "version", package.version, false);
            WriteProperty(sb, "prefabPath", package.prefabPath, true);
            WriteCanvas(sb, package.canvas);
            WriteNodeProperty(sb, "root", package.root);
            WriteNodes(sb, package.nodes);
            WriteAssets(sb, package.assets);
            WritePrefabInstances(sb, package.prefabInstances);
            WriteVisualBounds(sb, package.visualBounds);
            WriteStringArrayProperty(sb, "warnings", package.warnings);
            WriteStringArrayProperty(sb, "fatalErrors", package.fatalErrors);
            WriteStats(sb, package.stats);
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// 写入节点对象。
        /// </summary>
        private static void WriteNode(StringBuilder sb, PrefabToFigmaNode node, bool includeChildrenObjects)
        {
            if (node == null)
            {
                sb.Append("{}");
                return;
            }

            sb.Append("{");
            WriteProperty(sb, "id", node.id, false);
            WriteProperty(sb, "name", node.name, true);
            WriteProperty(sb, "path", node.path, true);
            WriteProperty(sb, "active", node.active, true);
            WriteRectProperty(sb, "rect", node.rect);
            WriteUnityProperty(sb, node.unity);

            sb.Append(",\"children\":[");
            for (int i = 0; i < node.children.Count; i++)
            {
                if (i > 0) sb.Append(",");
                if (includeChildrenObjects)
                    WriteNode(sb, node.children[i], true);
                else
                    WriteStringValue(sb, node.children[i].id);
            }
            sb.Append("]");

            if (node.image != null)
                WriteImageProperty(sb, node.image);
            if (node.text != null)
                WriteTextProperty(sb, node.text);
            if (node.clip != null)
                WriteClipProperty(sb, node.clip);
            if (node.prefabSource != null)
                WritePrefabSourceProperty(sb, node.prefabSource);
            if (node.unsupported != null && node.unsupported.Count > 0)
                WriteStringArrayProperty(sb, "unsupported", node.unsupported);

            sb.Append("}");
        }

        /// <summary>
        /// 写入画布字段。
        /// </summary>
        private static void WriteCanvas(StringBuilder sb, PrefabToFigmaCanvas canvas)
        {
            sb.Append(",\"canvas\":{");
            WriteProperty(sb, "width", canvas != null ? canvas.width : 0f, false);
            WriteProperty(sb, "height", canvas != null ? canvas.height : 0f, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入根节点字段。
        /// </summary>
        private static void WriteNodeProperty(StringBuilder sb, string name, PrefabToFigmaNode node)
        {
            sb.Append(",");
            WriteStringValue(sb, name);
            sb.Append(":");
            WriteNode(sb, node, true);
        }

        /// <summary>
        /// 写入扁平节点列表。
        /// </summary>
        private static void WriteNodes(StringBuilder sb, List<PrefabToFigmaNode> nodes)
        {
            sb.Append(",\"nodes\":[");
            for (int i = 0; i < nodes.Count; i++)
            {
                if (i > 0) sb.Append(",");
                WriteNode(sb, nodes[i], false);
            }
            sb.Append("]");
        }

        /// <summary>
        /// 写入资源字典。
        /// </summary>
        private static void WriteAssets(StringBuilder sb, Dictionary<string, PrefabToFigmaAsset> assets)
        {
            sb.Append(",\"assets\":{");
            var index = 0;
            foreach (var pair in assets)
            {
                if (index++ > 0) sb.Append(",");
                WriteStringValue(sb, pair.Key);
                sb.Append(":");
                WriteAsset(sb, pair.Value);
            }
            sb.Append("}");
        }

        /// <summary>
        /// 写入资源对象。
        /// </summary>
        private static void WriteAsset(StringBuilder sb, PrefabToFigmaAsset asset)
        {
            sb.Append("{");
            WriteProperty(sb, "guid", asset.guid, false);
            WriteProperty(sb, "assetPath", asset.assetPath, true);
            WriteProperty(sb, "metaPath", asset.metaPath, true);
            WriteProperty(sb, "width", asset.width, true);
            WriteProperty(sb, "height", asset.height, true);
            WriteBorderProperty(sb, "border", asset.border);
            WriteProperty(sb, "pixelsToUnits", asset.pixelsToUnits, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入 PrefabInstance 列表。
        /// </summary>
        private static void WritePrefabInstances(StringBuilder sb, List<PrefabToFigmaPrefabInstance> instances)
        {
            sb.Append(",\"prefabInstances\":[");
            for (int i = 0; i < instances.Count; i++)
            {
                if (i > 0) sb.Append(",");
                var item = instances[i];
                sb.Append("{");
                WriteProperty(sb, "fileId", item.fileId, false);
                WriteUnityRefProperty(sb, "sourcePrefab", item.sourcePrefab);
                if (!string.IsNullOrEmpty(item.sourcePrefabPath))
                    WriteProperty(sb, "sourcePrefabPath", item.sourcePrefabPath, true);
                sb.Append("}");
            }
            sb.Append("]");
        }

        /// <summary>
        /// 写入视觉包围盒。
        /// </summary>
        private static void WriteVisualBounds(StringBuilder sb, PrefabToFigmaVisualBounds bounds)
        {
            sb.Append(",\"visualBounds\":{");
            WriteProperty(sb, "x", bounds.x, false);
            WriteProperty(sb, "y", bounds.y, true);
            WriteProperty(sb, "width", bounds.width, true);
            WriteProperty(sb, "height", bounds.height, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入统计信息。
        /// </summary>
        private static void WriteStats(StringBuilder sb, PrefabToFigmaStats stats)
        {
            sb.Append(",\"stats\":{");
            WriteProperty(sb, "nodeCount", stats.nodeCount, false);
            WriteProperty(sb, "imageCount", stats.imageCount, true);
            WriteProperty(sb, "textCount", stats.textCount, true);
            WriteProperty(sb, "nineSliceCount", stats.nineSliceCount, true);
            WriteProperty(sb, "clipCount", stats.clipCount, true);
            WriteProperty(sb, "prefabInstanceCount", stats.prefabInstanceCount, true);
            WriteProperty(sb, "unsupportedCount", stats.unsupportedCount, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入图片字段。
        /// </summary>
        private static void WriteImageProperty(StringBuilder sb, PrefabToFigmaImage image)
        {
            sb.Append(",\"image\":{");
            WriteProperty(sb, "componentType", image.componentType, false);
            WriteProperty(sb, "guid", image.guid, true);
            WriteProperty(sb, "imageType", image.imageType, true);
            WriteProperty(sb, "mode", image.mode, true);
            WriteProperty(sb, "fillAmount", image.fillAmount, true);
            WriteProperty(sb, "fillCenter", image.fillCenter, true);
            if (!string.IsNullOrEmpty(image.asset)) WriteProperty(sb, "asset", image.asset, true);
            if (image.pixelSize != null) WritePixelSizeProperty(sb, image.pixelSize);
            if (image.border != null) WriteBorderProperty(sb, "border", image.border);
            if (image.slices != null && image.slices.Count > 0) WriteSlicesProperty(sb, image.slices);
            if (image.sourceImage != null) WriteSourceImageProperty(sb, image.sourceImage);
            sb.Append("}");
        }

        /// <summary>
        /// 写入文本字段。
        /// </summary>
        private static void WriteTextProperty(StringBuilder sb, PrefabToFigmaText text)
        {
            sb.Append(",\"text\":{");
            WriteProperty(sb, "componentType", text.componentType, false);
            WriteProperty(sb, "content", text.content ?? string.Empty, true);
            WriteProperty(sb, "fontSize", text.fontSize, true);
            WriteColorProperty(sb, "color", text.color);
            if (text.fontColor != null) WriteColorProperty(sb, "fontColor", text.fontColor);
            if (text.outlineColor != null) WriteColorProperty(sb, "outlineColor", text.outlineColor);
            if (text.sharedMaterial != null) WriteMaterialProperty(sb, text.sharedMaterial);
            if (text.autoSize != null) WriteAutoSizeProperty(sb, text.autoSize);
            if (text.alignment != null) WriteAlignmentProperty(sb, text.alignment);
            if (text.options != null) WriteTextOptionsProperty(sb, text.options);
            sb.Append("}");
        }

        /// <summary>
        /// 写入裁剪字段。
        /// </summary>
        private static void WriteClipProperty(StringBuilder sb, PrefabToFigmaClip clip)
        {
            sb.Append(",\"clip\":{");
            WriteProperty(sb, "enabled", clip.enabled, false);
            WriteProperty(sb, "componentType", clip.componentType, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入嵌套 Prefab 源元数据字段。
        /// </summary>
        private static void WritePrefabSourceProperty(StringBuilder sb, PrefabToFigmaPrefabSource prefabSource)
        {
            sb.Append(",\"prefabSource\":{");
            WriteProperty(sb, "guid", prefabSource.guid, false);
            WriteProperty(sb, "path", prefabSource.path, true);
            WriteProperty(sb, "name", prefabSource.name, true);
            WriteProperty(sb, "isRoot", prefabSource.isRoot, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入图片像素尺寸字段。
        /// </summary>
        private static void WritePixelSizeProperty(StringBuilder sb, PrefabToFigmaPixelSize pixelSize)
        {
            sb.Append(",\"pixelSize\":{");
            WriteProperty(sb, "width", pixelSize.width, false);
            WriteProperty(sb, "height", pixelSize.height, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入 Sprite 九宫格边距字段。
        /// </summary>
        private static void WriteBorderProperty(StringBuilder sb, string propertyName, PrefabToFigmaBorder border)
        {
            sb.Append(",");
            WriteStringValue(sb, propertyName);
            sb.Append(":{");
            WriteProperty(sb, "left", border.left, false);
            WriteProperty(sb, "bottom", border.bottom, true);
            WriteProperty(sb, "right", border.right, true);
            WriteProperty(sb, "top", border.top, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入九宫格切片数组字段。
        /// </summary>
        private static void WriteSlicesProperty(StringBuilder sb, List<PrefabToFigmaSlice> slices)
        {
            sb.Append(",\"slices\":[");
            for (int i = 0; i < slices.Count; i++)
            {
                if (i > 0) sb.Append(",");
                var slice = slices[i];
                sb.Append("{");
                WriteProperty(sb, "name", slice.name, false);
                WriteRectTupleProperty(sb, "target", slice.target);
                WriteRectTupleProperty(sb, "source", slice.source);
                sb.Append("}");
            }
            sb.Append("]");
        }

        /// <summary>
        /// 写入九宫格源图元数据字段。
        /// </summary>
        private static void WriteSourceImageProperty(StringBuilder sb, PrefabToFigmaSourceImage sourceImage)
        {
            sb.Append(",\"sourceImage\":{");
            WriteProperty(sb, "width", sourceImage.width, false);
            WriteProperty(sb, "height", sourceImage.height, true);
            WriteProperty(sb, "spriteGuid", sourceImage.spriteGuid, true);
            WriteProperty(sb, "assetPath", sourceImage.assetPath, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入颜色对象字段。
        /// </summary>
        private static void WriteColorProperty(StringBuilder sb, string propertyName, PrefabToFigmaColor color)
        {
            if (color == null) return;
            sb.Append(",");
            WriteStringValue(sb, propertyName);
            sb.Append(":{");
            WriteProperty(sb, "r", color.r, false);
            WriteProperty(sb, "g", color.g, true);
            WriteProperty(sb, "b", color.b, true);
            WriteProperty(sb, "a", color.a, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入 TMP 共享材质引用字段。
        /// </summary>
        private static void WriteMaterialProperty(StringBuilder sb, PrefabToFigmaMaterialRef materialRef)
        {
            sb.Append(",\"sharedMaterial\":{");
            WriteProperty(sb, "guid", materialRef.guid, false);
            WriteProperty(sb, "fileID", materialRef.fileID, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入 TMP 自动字号字段。
        /// </summary>
        private static void WriteAutoSizeProperty(StringBuilder sb, PrefabToFigmaAutoSize autoSize)
        {
            sb.Append(",\"autoSize\":{");
            WriteProperty(sb, "enabled", autoSize.enabled, false);
            WriteProperty(sb, "min", autoSize.min, true);
            WriteProperty(sb, "max", autoSize.max, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入文本对齐字段。
        /// </summary>
        private static void WriteAlignmentProperty(StringBuilder sb, PrefabToFigmaAlignment alignment)
        {
            sb.Append(",\"alignment\":{");
            WriteProperty(sb, "horizontal", alignment.horizontal, false);
            WriteProperty(sb, "vertical", alignment.vertical, true);
            WriteProperty(sb, "legacy", alignment.legacy, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入文本渲染选项字段。
        /// </summary>
        private static void WriteTextOptionsProperty(StringBuilder sb, PrefabToFigmaTextOptions options)
        {
            sb.Append(",\"options\":{");
            WriteProperty(sb, "fontStyle", options.fontStyle, false);
            WriteProperty(sb, "wordWrapping", options.wordWrapping, true);
            WriteProperty(sb, "overflowMode", options.overflowMode, true);
            WriteProperty(sb, "richText", options.richText, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入节点 RectTransform 矩形字段。
        /// </summary>
        private static void WriteRectProperty(StringBuilder sb, string propertyName, PrefabToFigmaRect rect)
        {
            sb.Append(",");
            WriteStringValue(sb, propertyName);
            sb.Append(":{");
            WriteProperty(sb, "x", rect.x, false);
            WriteProperty(sb, "y", rect.y, true);
            WriteProperty(sb, "width", rect.width, true);
            WriteProperty(sb, "height", rect.height, true);
            WriteProperty(sb, "rotationZ", rect.rotationZ, true);
            if (rect.scaleX.HasValue) WriteProperty(sb, "scaleX", rect.scaleX.Value, true);
            if (rect.scaleY.HasValue) WriteProperty(sb, "scaleY", rect.scaleY.Value, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入不含旋转信息的切片矩形字段。
        /// </summary>
        private static void WriteRectTupleProperty(StringBuilder sb, string propertyName, PrefabToFigmaRectTuple rect)
        {
            sb.Append(",");
            WriteStringValue(sb, propertyName);
            sb.Append(":{");
            WriteProperty(sb, "x", rect.x, false);
            WriteProperty(sb, "y", rect.y, true);
            WriteProperty(sb, "width", rect.width, true);
            WriteProperty(sb, "height", rect.height, true);
            sb.Append("}");
        }

        /// <summary>
        /// 写入 Unity 节点引用字段。
        /// </summary>
        private static void WriteUnityProperty(StringBuilder sb, PrefabToFigmaUnityData unity)
        {
            sb.Append(",\"unity\":{");
            WriteProperty(sb, "gameObjectId", unity.gameObjectId, false);
            WriteProperty(sb, "rectTransformId", unity.rectTransformId, true);
            WriteProperty(sb, "parentRectId", unity.parentRectId, true);
            WriteStringArrayProperty(sb, "children", unity.children);
            sb.Append("}");
        }

        /// <summary>
        /// 写入 Unity 序列化引用对象。
        /// </summary>
        private static void WriteUnityRefProperty(StringBuilder sb, string propertyName, PrefabToFigmaUnityRef reference)
        {
            sb.Append(",");
            WriteStringValue(sb, propertyName);
            sb.Append(":{");
            if (reference != null)
            {
                WriteProperty(sb, "fileID", reference.fileID, false);
                WriteProperty(sb, "guid", reference.guid, true);
                WriteProperty(sb, "type", reference.type, true);
            }
            sb.Append("}");
        }

        /// <summary>
        /// 写入字符串数组属性。
        /// </summary>
        private static void WriteStringArrayProperty(StringBuilder sb, string name, List<string> values)
        {
            sb.Append(",");
            WriteStringValue(sb, name);
            sb.Append(":");
            WriteStringArray(sb, values);
        }

        /// <summary>
        /// 写入字符串数组值。
        /// </summary>
        private static void WriteStringArray(StringBuilder sb, List<string> values)
        {
            sb.Append("[");
            if (values != null)
            {
                for (int i = 0; i < values.Count; i++)
                {
                    if (i > 0) sb.Append(",");
                    WriteStringValue(sb, values[i]);
                }
            }
            sb.Append("]");
        }

        /// <summary>
        /// 写入字符串属性。
        /// </summary>
        private static void WriteProperty(StringBuilder sb, string name, string value, bool comma)
        {
            if (comma) sb.Append(",");
            WriteStringValue(sb, name);
            sb.Append(":");
            WriteStringValue(sb, value ?? string.Empty);
        }

        /// <summary>
        /// 写入整数属性。
        /// </summary>
        private static void WriteProperty(StringBuilder sb, string name, int value, bool comma)
        {
            if (comma) sb.Append(",");
            WriteStringValue(sb, name);
            sb.Append(":");
            sb.Append(value.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// 写入长整数属性。
        /// </summary>
        private static void WriteProperty(StringBuilder sb, string name, long value, bool comma)
        {
            if (comma) sb.Append(",");
            WriteStringValue(sb, name);
            sb.Append(":");
            sb.Append(value.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// 写入浮点属性，自动压缩小数位。
        /// </summary>
        private static void WriteProperty(StringBuilder sb, string name, float value, bool comma)
        {
            if (comma) sb.Append(",");
            WriteStringValue(sb, name);
            sb.Append(":");
            sb.Append(Round(value).ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// 写入布尔属性。
        /// </summary>
        private static void WriteProperty(StringBuilder sb, string name, bool value, bool comma)
        {
            if (comma) sb.Append(",");
            WriteStringValue(sb, name);
            sb.Append(":");
            sb.Append(value ? "true" : "false");
        }

        /// <summary>
        /// 对浮点数做稳定四舍五入。
        /// </summary>
        private static float Round(float value)
        {
            return (float)Math.Round(value, 3, MidpointRounding.AwayFromZero);
        }

        /// <summary>
        /// 写入 JSON 字符串值并转义特殊字符。
        /// </summary>
        private static void WriteStringValue(StringBuilder sb, string value)
        {
            sb.Append('"');
            if (!string.IsNullOrEmpty(value))
            {
                for (int i = 0; i < value.Length; i++)
                {
                    var c = value[i];
                    switch (c)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        default:
                            if (c < 32) sb.AppendFormat("\\u{0:X4}", (int)c);
                            else sb.Append(c);
                            break;
                    }
                }
            }
            sb.Append('"');
        }
    }
}
