using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 图片条目，记录相对路径和磁盘绝对路径，供后续 HTTP 端点返回图片字节使用。
    /// </summary>
    public struct ImageEntry
    {
        /// <summary>相对路径，例如 "assets/ui_bg_00.png"</summary>
        public string relativePath;

        /// <summary>磁盘绝对路径，用于读取原始图片文件</summary>
        public string absolutePath;
    }

    /// <summary>
    /// 将 Python 解析器输出的 prefab-to-figma.json 转换为 LKS Figma 插件的导入格式。
    /// 转换规则：
    ///   - image.mode == "nine-slice" → imageType: "Sliced" + border
    ///   - image.mode == "simple"     → imageType: "Simple"
    ///   - text.fontColor (r,g,b 0-1) → "#RRGGBB"
    ///   - alignment 数值 → "center-middle" 等组合字符串
    ///   - assets[guid].assetPath 去掉 "JellybeanUnity/" 前缀 → sourceAssetPath
    ///   - 节点 kind 推断：有 image → "image"，有 text → "text"，否则 "frame"
    /// </summary>
    public static class PrefabToLksConverter
    {
        // ─────────────────────── 常量 ───────────────────────

        /// <summary>Unity 项目路径前缀，转换时需要去掉</summary>
        private const string UnityProjectPrefix = "JellybeanUnity/";

        // ─────────────────────── 公共接口 ───────────────────────

        /// <summary>
        /// 将 prefab-to-figma.json 内容转换为 LKS 插件可导入的 JSON 字符串，
        /// 同时收集所有引用到的图片条目。
        /// </summary>
        /// <param name="prefabToFigmaJson">Python 解析器输出的 JSON 字符串</param>
        /// <returns>lksJson: LKS 格式 JSON；images: 图片条目列表</returns>
        public static (string lksJson, List<ImageEntry> images) Convert(string prefabToFigmaJson)
        {
            if (string.IsNullOrEmpty(prefabToFigmaJson))
                throw new ArgumentException("输入 JSON 不能为空", nameof(prefabToFigmaJson));

            // 使用 Unity 内置 JSON 工具解析
            var source = JsonUtility.FromJson<SourceDocument>(prefabToFigmaJson);
            if (source == null || source.root == null)
                throw new InvalidOperationException("无法解析 prefab-to-figma.json 或缺少 root 节点");

            // 构建 assets 字典（guid → AssetInfo），JsonUtility 不支持 Dictionary 所以手动解析
            var assetsMap = BuildAssetsMap(prefabToFigmaJson);

            // 收集图片条目
            var images = new List<ImageEntry>();

            // 推导 prefab 名称
            string prefabName = source.root.name ?? "UnknownPrefab";

            // 递归转换节点树，拼接 LKS 格式 JSON
            var sb = new StringBuilder(4096);
            sb.Append("{");
            sb.Append("\"meta\":{");
            sb.AppendFormat("\"prefabName\":{0}", JsonString(prefabName));
            sb.Append("},");
            sb.Append("\"root\":");
            WriteNode(sb, source.root, assetsMap, images);
            sb.Append("}");

            return (sb.ToString(), images);
        }

        // ─────────────────────── 节点转换 ───────────────────────

        /// <summary>
        /// 递归写入单个节点的 LKS JSON 表示。
        /// </summary>
        private static void WriteNode(
            StringBuilder sb,
            SourceNode node,
            Dictionary<string, AssetInfo> assetsMap,
            List<ImageEntry> images)
        {
            sb.Append("{");

            // name
            sb.AppendFormat("\"name\":{0},", JsonString(node.name ?? ""));

            // kind：有 image → "image"，有 text → "text"，否则 "frame"
            string kind = InferKind(node);
            sb.AppendFormat("\"kind\":{0},", JsonString(kind));

            // rect
            WriteRect(sb, node.rect);
            sb.Append(",");

            // visible / activeSelf
            bool isActive = node.active;
            sb.AppendFormat("\"visible\":{0},", isActive ? "true" : "false");
            sb.AppendFormat("\"activeSelf\":{0}", isActive ? "true" : "false");

            if (node.prefabSource != null && node.prefabSource.isRoot)
            {
                WritePrefabSourceData(sb, node.prefabSource);
            }

            // image 数据
            if (node.image != null && !string.IsNullOrEmpty(node.image.asset))
            {
                sb.Append(",");
                WriteImageData(sb, node.image, assetsMap, images);
            }

            // text 数据
            if (node.text != null && node.text.content != null)
            {
                sb.Append(",");
                WriteTextData(sb, node.text);
            }

            // children
            sb.Append(",\"children\":[");
            if (node.children != null)
            {
                for (int i = 0; i < node.children.Count; i++)
                {
                    if (i > 0) sb.Append(",");
                    WriteNode(sb, node.children[i], assetsMap, images);
                }
            }
            sb.Append("]");

            sb.Append("}");
        }

        /// <summary>
        /// 推断节点类型：有 image → "image"，有 text → "text"，否则 "frame"。
        /// </summary>
        private static string InferKind(SourceNode node)
        {
            if (node.image != null && !string.IsNullOrEmpty(node.image.asset))
                return "image";
            if (node.text != null && node.text.content != null)
                return "text";
            return "frame";
        }

        // ─────────────────────── rect ───────────────────────

        /// <summary>
        /// 写入 rect 对象：{ x, y, width, height }。
        /// </summary>
        private static void WriteRect(StringBuilder sb, SourceRect rect)
        {
            sb.Append("\"rect\":{");
            if (rect != null)
            {
                sb.AppendFormat(CultureInfo.InvariantCulture,
                    "\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}",
                    rect.x, rect.y, rect.width, rect.height);
            }
            else
            {
                sb.Append("\"x\":0,\"y\":0,\"width\":0,\"height\":0");
            }
            sb.Append("}");
        }

        // ─────────────────────── image 转换 ───────────────────────

        /// <summary>
        /// 写入 image 数据块，包含 imageType、relativePath、sourceAssetPath、border、pixelSize 等。
        /// </summary>
        private static void WriteImageData(
            StringBuilder sb,
            SourceImage img,
            Dictionary<string, AssetInfo> assetsMap,
            List<ImageEntry> images)
        {
            // 确定 imageType
            string imageType = img.mode == "nine-slice" ? "Sliced" : "Simple";

            // 从 assets 字典查找资源信息
            string guid = img.asset ?? img.guid ?? "";
            assetsMap.TryGetValue(guid, out var assetInfo);

            // sourceAssetPath：去掉 "JellybeanUnity/" 前缀
            string rawAssetPath = assetInfo.assetPath ?? "";
            string sourceAssetPath = StripUnityPrefix(rawAssetPath);

            // relativePath = "assets/" + 文件名
            string fileName = Path.GetFileName(sourceAssetPath);
            string relativePath = string.IsNullOrEmpty(fileName) ? "" : "assets/" + fileName;

            // 收集图片条目
            if (!string.IsNullOrEmpty(relativePath) && !string.IsNullOrEmpty(rawAssetPath))
            {
                string repoRoot = FindRepoRoot();
                string absolutePath = string.IsNullOrEmpty(repoRoot)
                    ? rawAssetPath
                    : Path.GetFullPath(Path.Combine(repoRoot, rawAssetPath));

                images.Add(new ImageEntry
                {
                    relativePath = relativePath,
                    absolutePath = absolutePath
                });
            }

            // 像素尺寸
            int pixelWidth = img.pixelSize != null ? img.pixelSize.width : (assetInfo.width > 0 ? assetInfo.width : 0);
            int pixelHeight = img.pixelSize != null ? img.pixelSize.height : (assetInfo.height > 0 ? assetInfo.height : 0);

            // pixelsPerUnit
            float pixelsPerUnit = assetInfo.pixelsToUnits > 0 ? assetInfo.pixelsToUnits : 100f;

            sb.Append("\"image\":{");
            sb.AppendFormat("\"imageType\":{0},", JsonString(imageType));
            sb.AppendFormat("\"relativePath\":{0},", JsonString(relativePath));
            sb.AppendFormat("\"sourceAssetPath\":{0},", JsonString(sourceAssetPath));
            sb.AppendFormat("\"sourceAssetGuid\":{0},", JsonString(guid));
            sb.AppendFormat("\"assetRef\":{0},", JsonString(relativePath));

            // border（九宫格边距）
            WriteBorder(sb, img, assetInfo);
            sb.Append(",");

            sb.AppendFormat("\"pixelWidth\":{0},", pixelWidth);
            sb.AppendFormat("\"pixelHeight\":{0},", pixelHeight);
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"pixelsPerUnit\":{0}", pixelsPerUnit);
            WriteSlicesData(sb, img.slices);
            WriteSourceImageData(sb, img.sourceImage);
            sb.Append("}");
        }

        /// <summary>
        /// 写入嵌套 Prefab 源信息，供 Figma 插件复用本地通用组件。
        /// </summary>
        private static void WritePrefabSourceData(StringBuilder sb, SourcePrefabSource prefabSource)
        {
            sb.Append(",\"isPrefabInstanceRoot\":true");
            sb.AppendFormat(",\"sourcePrefabGuid\":{0}", JsonString(prefabSource.guid ?? ""));
            sb.AppendFormat(",\"sourcePrefabPath\":{0}", JsonString(prefabSource.path ?? ""));
            sb.AppendFormat(",\"sourcePrefabName\":{0}", JsonString(prefabSource.name ?? ""));
            sb.Append(",\"prefabSource\":{");
            sb.AppendFormat("\"guid\":{0},", JsonString(prefabSource.guid ?? ""));
            sb.AppendFormat("\"path\":{0},", JsonString(prefabSource.path ?? ""));
            sb.AppendFormat("\"name\":{0},", JsonString(prefabSource.name ?? ""));
            sb.AppendFormat("\"isRoot\":{0}", prefabSource.isRoot ? "true" : "false");
            sb.Append("}");
        }

        /// <summary>
        /// 透传 C# 导出器生成的精确九宫格切片。
        /// </summary>
        private static void WriteSlicesData(StringBuilder sb, List<SourceSlice> slices)
        {
            if (slices == null || slices.Count == 0)
            {
                return;
            }

            sb.Append(",\"slices\":[");
            for (int i = 0; i < slices.Count; i++)
            {
                if (i > 0) sb.Append(",");
                var slice = slices[i];
                sb.Append("{");
                sb.AppendFormat("\"name\":{0},", JsonString(slice.name ?? ""));
                WriteRectTuple(sb, "target", slice.target);
                sb.Append(",");
                WriteRectTuple(sb, "source", slice.source);
                sb.Append("}");
            }
            sb.Append("]");
        }

        /// <summary>
        /// 透传九宫格源图元数据。
        /// </summary>
        private static void WriteSourceImageData(StringBuilder sb, SourceImageMetadata sourceImage)
        {
            if (sourceImage == null)
            {
                return;
            }

            sb.Append(",\"sourceImage\":{");
            sb.AppendFormat("\"width\":{0},", sourceImage.width);
            sb.AppendFormat("\"height\":{0},", sourceImage.height);
            sb.AppendFormat("\"spriteGuid\":{0},", JsonString(sourceImage.spriteGuid ?? ""));
            sb.AppendFormat("\"assetPath\":{0}", JsonString(StripUnityPrefix(sourceImage.assetPath ?? "")));
            sb.Append("}");
        }

        /// <summary>
        /// 写入切片矩形对象。
        /// </summary>
        private static void WriteRectTuple(StringBuilder sb, string name, SourceRectTuple rect)
        {
            sb.AppendFormat("\"{0}\":{{", name);
            if (rect != null)
            {
                sb.AppendFormat(CultureInfo.InvariantCulture,
                    "\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}",
                    rect.x, rect.y, rect.width, rect.height);
            }
            else
            {
                sb.Append("\"x\":0,\"y\":0,\"width\":0,\"height\":0");
            }
            sb.Append("}");
        }

        /// <summary>
        /// 写入九宫格边距：borderLeft / borderRight / borderTop / borderBottom。
        /// 仅在 nine-slice 模式下有实际值，simple 模式全部为 0。
        /// </summary>
        private static void WriteBorder(StringBuilder sb, SourceImage img, AssetInfo assetInfo)
        {
            float left = 0, right = 0, top = 0, bottom = 0;

            if (img.mode == "nine-slice")
            {
                // 优先使用 image 节点自带的 border
                if (img.border != null)
                {
                    left = img.border.left;
                    right = img.border.right;
                    top = img.border.top;
                    bottom = img.border.bottom;
                }
                // 回退到 assets 字典中的 border
                else if (assetInfo.border != null)
                {
                    left = assetInfo.border.left;
                    right = assetInfo.border.right;
                    top = assetInfo.border.top;
                    bottom = assetInfo.border.bottom;
                }
            }

            sb.AppendFormat(CultureInfo.InvariantCulture,
                "\"borderLeft\":{0},\"borderRight\":{1},\"borderTop\":{2},\"borderBottom\":{3}",
                left, right, top, bottom);
        }

        // ─────────────────────── text 转换 ───────────────────────

        /// <summary>
        /// 写入 text 数据块，包含 content、fontSize、color、alignment。
        /// </summary>
        private static void WriteTextData(StringBuilder sb, SourceText txt)
        {
            sb.Append("\"text\":{");
            sb.AppendFormat("\"content\":{0},", JsonString(txt.content ?? ""));
            sb.AppendFormat(CultureInfo.InvariantCulture, "\"fontSize\":{0},", txt.fontSize);

            // fontColor → hex 字符串（优先使用 fontColor，回退到 color）
            string hexColor = FontColorToHex(txt.fontColor ?? txt.color);
            sb.AppendFormat("\"color\":{0},", JsonString(hexColor));

            // alignment 组合
            string alignment = BuildAlignmentString(txt.alignment);
            sb.AppendFormat("\"alignment\":{0}", JsonString(alignment));

            sb.Append("}");
        }

        /// <summary>
        /// 将 fontColor (r,g,b 0-1) 转换为 "#RRGGBB" 十六进制字符串。
        /// </summary>
        private static string FontColorToHex(SourceColor color)
        {
            if (color == null)
                return "#FFFFFF";

            int r = Mathf.Clamp(Mathf.RoundToInt(color.r * 255f), 0, 255);
            int g = Mathf.Clamp(Mathf.RoundToInt(color.g * 255f), 0, 255);
            int b = Mathf.Clamp(Mathf.RoundToInt(color.b * 255f), 0, 255);

            return $"#{r:X2}{g:X2}{b:X2}";
        }

        /// <summary>
        /// 将 alignment 数值组合为 "center-middle" 等字符串。
        /// horizontal: 1=left, 2=center, 4=right
        /// vertical:   256=top, 512=middle, 1024=bottom
        /// </summary>
        private static string BuildAlignmentString(SourceAlignment alignment)
        {
            if (alignment == null)
                return "center-middle";

            string h;
            switch (alignment.horizontal)
            {
                case 1:  h = "left";   break;
                case 4:  h = "right";  break;
                default: h = "center"; break; // 2 或其他默认居中
            }

            string v;
            switch (alignment.vertical)
            {
                case 256:  v = "top";    break;
                case 1024: v = "bottom"; break;
                default:   v = "middle"; break; // 512 或其他默认居中
            }

            return $"{h}-{v}";
        }

        // ─────────────────────── 工具方法 ───────────────────────

        /// <summary>
        /// 去掉路径中的 "JellybeanUnity/" 前缀。
        /// </summary>
        private static string StripUnityPrefix(string path)
        {
            if (string.IsNullOrEmpty(path))
                return path;

            if (path.StartsWith(UnityProjectPrefix, StringComparison.Ordinal))
                return path.Substring(UnityProjectPrefix.Length);

            return path;
        }

        /// <summary>
        /// 查找仓库根目录（包含 JellybeanUnity 的上级目录）。
        /// </summary>
        private static string FindRepoRoot()
        {
            // Application.dataPath = ".../JellybeanUnity/Assets"
            string dataPath = Application.dataPath;
            if (string.IsNullOrEmpty(dataPath))
                return "";

            // 向上两级：Assets → JellybeanUnity → 仓库根
            string unityRoot = Path.GetDirectoryName(dataPath);
            if (string.IsNullOrEmpty(unityRoot))
                return "";

            string repoRoot = Path.GetDirectoryName(unityRoot);
            return repoRoot ?? "";
        }

        /// <summary>
        /// 将字符串转义为 JSON 安全格式（带双引号）。
        /// </summary>
        private static string JsonString(string value)
        {
            if (value == null) return "\"\"";

            var sb = new StringBuilder(value.Length + 8);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n");  break;
                    case '\r': sb.Append("\\r");  break;
                    case '\t': sb.Append("\\t");  break;
                    default:
                        if (c < 0x20)
                            sb.AppendFormat("\\u{0:X4}", (int)c);
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        // ─────────────────────── assets 字典解析 ───────────────────────

        /// <summary>
        /// 手动解析 JSON 中的 "assets" 字典。
        /// JsonUtility 不支持 Dictionary，因此使用简单的字符串查找方式提取。
        /// </summary>
        private static Dictionary<string, AssetInfo> BuildAssetsMap(string json)
        {
            var map = new Dictionary<string, AssetInfo>();

            int assetsIdx = json.IndexOf("\"assets\"", StringComparison.Ordinal);
            if (assetsIdx < 0)
                return map;

            int braceStart = json.IndexOf('{', assetsIdx + 8);
            if (braceStart < 0)
                return map;

            int braceEnd = FindMatchingBrace(json, braceStart);
            if (braceEnd < 0)
                return map;

            string assetsBlock = json.Substring(braceStart + 1, braceEnd - braceStart - 1);

            // 逐个解析 guid 条目
            int pos = 0;
            while (pos < assetsBlock.Length)
            {
                int keyStart = assetsBlock.IndexOf('"', pos);
                if (keyStart < 0) break;
                int keyEnd = assetsBlock.IndexOf('"', keyStart + 1);
                if (keyEnd < 0) break;

                string guid = assetsBlock.Substring(keyStart + 1, keyEnd - keyStart - 1);

                int entryBraceStart = assetsBlock.IndexOf('{', keyEnd);
                if (entryBraceStart < 0) break;
                int entryBraceEnd = FindMatchingBrace(assetsBlock, entryBraceStart);
                if (entryBraceEnd < 0) break;

                string entryJson = assetsBlock.Substring(entryBraceStart, entryBraceEnd - entryBraceStart + 1);
                map[guid] = ParseAssetInfo(entryJson);

                pos = entryBraceEnd + 1;
            }

            return map;
        }

        /// <summary>
        /// 从 JSON 对象字符串中解析单个 AssetInfo。
        /// </summary>
        private static AssetInfo ParseAssetInfo(string json)
        {
            var info = new AssetInfo
            {
                assetPath = ExtractJsonStringValue(json, "assetPath"),
                width = ExtractJsonIntValue(json, "\"width\""),
                height = ExtractJsonIntValue(json, "\"height\""),
                pixelsToUnits = ExtractJsonFloatValue(json, "\"pixelsToUnits\"")
            };

            // 解析 border 子对象
            int borderIdx = json.IndexOf("\"border\"", StringComparison.Ordinal);
            if (borderIdx >= 0)
            {
                int bStart = json.IndexOf('{', borderIdx);
                if (bStart >= 0)
                {
                    int bEnd = FindMatchingBrace(json, bStart);
                    if (bEnd >= 0)
                    {
                        string borderJson = json.Substring(bStart, bEnd - bStart + 1);
                        info.border = new SourceBorder
                        {
                            left = ExtractJsonFloatValue(borderJson, "\"left\""),
                            right = ExtractJsonFloatValue(borderJson, "\"right\""),
                            top = ExtractJsonFloatValue(borderJson, "\"top\""),
                            bottom = ExtractJsonFloatValue(borderJson, "\"bottom\"")
                        };
                    }
                }
            }

            return info;
        }

        /// <summary>
        /// 从 JSON 中提取指定 key 的字符串值。
        /// </summary>
        private static string ExtractJsonStringValue(string json, string key)
        {
            string pattern = "\"" + key + "\"";
            int idx = json.IndexOf(pattern, StringComparison.Ordinal);
            if (idx < 0) return "";

            int colonIdx = json.IndexOf(':', idx + pattern.Length);
            if (colonIdx < 0) return "";

            int valStart = json.IndexOf('"', colonIdx + 1);
            if (valStart < 0) return "";

            // 找到值的结束引号（处理转义）
            int valEnd = valStart + 1;
            while (valEnd < json.Length)
            {
                if (json[valEnd] == '\\') { valEnd += 2; continue; }
                if (json[valEnd] == '"') break;
                valEnd++;
            }

            return json.Substring(valStart + 1, valEnd - valStart - 1);
        }

        /// <summary>
        /// 从 JSON 中提取指定 key 后面的整数值。
        /// </summary>
        private static int ExtractJsonIntValue(string json, string keyWithQuotes)
        {
            int idx = json.IndexOf(keyWithQuotes, StringComparison.Ordinal);
            if (idx < 0) return 0;

            int colonIdx = json.IndexOf(':', idx + keyWithQuotes.Length);
            if (colonIdx < 0) return 0;

            int numStart = colonIdx + 1;
            while (numStart < json.Length && json[numStart] == ' ') numStart++;

            int numEnd = numStart;
            while (numEnd < json.Length && (char.IsDigit(json[numEnd]) || json[numEnd] == '-'))
                numEnd++;

            if (numEnd > numStart &&
                int.TryParse(json.Substring(numStart, numEnd - numStart),
                    NumberStyles.Integer, CultureInfo.InvariantCulture, out int result))
                return result;

            return 0;
        }

        /// <summary>
        /// 从 JSON 中提取指定 key 后面的浮点数值。
        /// </summary>
        private static float ExtractJsonFloatValue(string json, string keyWithQuotes)
        {
            int idx = json.IndexOf(keyWithQuotes, StringComparison.Ordinal);
            if (idx < 0) return 0f;

            int colonIdx = json.IndexOf(':', idx + keyWithQuotes.Length);
            if (colonIdx < 0) return 0f;

            int numStart = colonIdx + 1;
            while (numStart < json.Length && json[numStart] == ' ') numStart++;

            int numEnd = numStart;
            while (numEnd < json.Length &&
                   (char.IsDigit(json[numEnd]) || json[numEnd] == '.' || json[numEnd] == '-'))
                numEnd++;

            if (numEnd > numStart &&
                float.TryParse(json.Substring(numStart, numEnd - numStart),
                    NumberStyles.Float, CultureInfo.InvariantCulture, out float result))
                return result;

            return 0f;
        }

        /// <summary>
        /// 查找与指定位置的 '{' 匹配的 '}' 位置。
        /// </summary>
        private static int FindMatchingBrace(string json, int openPos)
        {
            int depth = 0;
            bool inString = false;

            for (int i = openPos; i < json.Length; i++)
            {
                char c = json[i];

                if (inString)
                {
                    if (c == '\\') { i++; continue; }
                    if (c == '"') inString = false;
                    continue;
                }

                switch (c)
                {
                    case '"': inString = true; break;
                    case '{': depth++; break;
                    case '}':
                        depth--;
                        if (depth == 0) return i;
                        break;
                }
            }

            return -1;
        }

        // ─────────────────────── 数据模型（JsonUtility 反序列化用） ───────────────────────

        /// <summary>Python 解析器输出的顶层文档结构</summary>
        [Serializable]
        private class SourceDocument
        {
            public int version;
            public string prefabPath;
            public SourceCanvas canvas;
            public SourceNode root;
        }

        /// <summary>画布尺寸</summary>
        [Serializable]
        private class SourceCanvas
        {
            public float width;
            public float height;
        }

        /// <summary>节点</summary>
        [Serializable]
        private class SourceNode
        {
            public string id;
            public string name;
            public string path;
            public bool active = true;
            public SourceRect rect;
            public List<SourceNode> children;
            public SourceImage image;
            public SourceText text;
            public SourcePrefabSource prefabSource;
        }

        /// <summary>矩形区域</summary>
        [Serializable]
        private class SourceRect
        {
            public float x;
            public float y;
            public float width;
            public float height;
        }

        /// <summary>图片信息</summary>
        [Serializable]
        private class SourceImage
        {
            public string guid;
            public string asset;
            public string mode;
            public string imageType;
            public SourcePixelSize pixelSize;
            public SourceBorder border;
            public List<SourceSlice> slices;
            public SourceImageMetadata sourceImage;
        }

        /// <summary>嵌套 Prefab 源信息</summary>
        [Serializable]
        private class SourcePrefabSource
        {
            public string guid;
            public string path;
            public string name;
            public bool isRoot;
        }

        /// <summary>九宫格切片信息</summary>
        [Serializable]
        private class SourceSlice
        {
            public string name;
            public SourceRectTuple target;
            public SourceRectTuple source;
        }

        /// <summary>切片矩形</summary>
        [Serializable]
        private class SourceRectTuple
        {
            public float x;
            public float y;
            public float width;
            public float height;
        }

        /// <summary>九宫格源图元数据</summary>
        [Serializable]
        private class SourceImageMetadata
        {
            public int width;
            public int height;
            public string spriteGuid;
            public string assetPath;
        }

        /// <summary>像素尺寸</summary>
        [Serializable]
        private class SourcePixelSize
        {
            public int width;
            public int height;
        }

        /// <summary>文本信息</summary>
        [Serializable]
        private class SourceText
        {
            public string content;
            public float fontSize;
            public SourceColor color;
            public SourceColor fontColor;
            public SourceAlignment alignment;
        }

        /// <summary>颜色（r,g,b,a 范围 0-1）</summary>
        [Serializable]
        private class SourceColor
        {
            public float r;
            public float g;
            public float b;
            public float a = 1f;
        }

        /// <summary>对齐方式</summary>
        [Serializable]
        private class SourceAlignment
        {
            public int horizontal;
            public int vertical;
        }

        /// <summary>九宫格边距</summary>
        [Serializable]
        private class SourceBorder
        {
            public float left;
            public float right;
            public float top;
            public float bottom;
        }

        /// <summary>资源信息（从 assets 字典手动解析）</summary>
        private struct AssetInfo
        {
            public string assetPath;
            public int width;
            public int height;
            public float pixelsToUnits;
            public SourceBorder border;
        }
    }
}
