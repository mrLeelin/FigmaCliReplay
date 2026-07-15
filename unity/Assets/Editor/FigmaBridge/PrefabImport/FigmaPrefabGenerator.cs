using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using ZLog = UnityEngine.Debug;
using UnityEngine.Networking;
using UnityEngine.UI;
using TMPro;

namespace MagicWarrior.Editor.FigmaBridge.PrefabImport
{
    // ═══════════════════════════════════════════════════════════
    // JSON 反序列化模型 — 与 AI 生成的 prefab_spec.json 对应
    // ═══════════════════════════════════════════════════════════

    /// <summary>Prefab 规格文件的根对象</summary>
    [Serializable]
    public class PrefabSpec
    {
        public string prefabName;
        public string prefabPath;
        public Vector2Spec rootSize;
        public ImageSpec[] images;
        public PrefabInstanceRef[] prefabInstances;
        public NodeSpec[] nodes;

        /// <summary>分组规则（可选，JSON 中缺失时默认 null）</summary>
        public GroupingRule[] groupingRules;
    }

    /// <summary>分组规则定义，描述语义分组的父节点和子节点关系</summary>
    [Serializable]
    public class GroupingRule
    {
        /// <summary>分组父节点名称</summary>
        public string parentName;
        /// <summary>分组父节点的位置尺寸</summary>
        public RectSpec parentRect;
        /// <summary>子节点在 nodes 数组中的索引列表</summary>
        public int[] childNodeIndices;
        /// <summary>分组依据说明（如坐标重叠、命名模式等）</summary>
        public string evidence;
    }

    /// <summary>二维向量（用于尺寸和边框）</summary>
    [Serializable]
    public class Vector2Spec
    {
        public float x;
        public float y;
    }

    /// <summary>四维向量（用于 spriteBorder: left/bottom/right/top）</summary>
    [Serializable]
    public class Vector4Spec
    {
        public float l;
        public float b;
        public float r;
        public float t;
    }

    /// <summary>图片资源描述</summary>
    [Serializable]
    public class ImageSpec
    {
        public string id;
        public string fileName;
        public string targetDir;
        public string spriteSettingJson; // JSON 字符串，在运行时解析
    }

    /// <summary>Sprite 导入设置</summary>
    [Serializable]
    public class SpriteSettingSpec
    {
        public Vector2Spec pivot;
        public Vector4Spec border;
    }

    /// <summary>嵌套 Prefab 引用</summary>
    [Serializable]
    public class PrefabInstanceRef
    {
        public string id;
        public string figmaName;
        public string sourcePrefabPath;
    }

    /// <summary>层级节点</summary>
    [Serializable]
    public class NodeSpec
    {
        public string name;
        public string type; // Root, Panel, Image, Text, PrefabInstance
        public RectSpec rect;
        public RectTransformSpec rectTransform;

        // Image 专用
        public string imageId;
        public string imageType; // Simple, Sliced
        public ColorSpec color;

        // Text 专用
        public string text;
        public int fontSize;
        public string alignment;
        public AutoSizeSpec autoSize;
        public TextMaterialSpec textMaterial;

        // PrefabInstance 专用
        public string prefabId;
        public string activeVariant;

        // 层级 — 子节点在 nodes 数组中的索引
        public int[] childIndices;
    }

    /// <summary>位置尺寸（已转换为 Unity anchoredPosition + sizeDelta）</summary>
    [Serializable]
    public class RectSpec
    {
        public float x;
        public float y;
        public float w;
        public float h;
    }

    /// <summary>Unity RectTransform anchor/pivot metadata converted from Figma Constraints.</summary>
    [Serializable]
    public class RectTransformSpec
    {
        public Vector2Spec anchorMin;
        public Vector2Spec anchorMax;
        public Vector2Spec pivot;
    }

    /// <summary>RGBA 颜色</summary>
    [Serializable]
    public class ColorSpec
    {
        public float r;
        public float g;
        public float b;
        public float a = 1f;
    }

    /// <summary>TMP 自动字号设置</summary>
    [Serializable]
    public class AutoSizeSpec
    {
        public float min;
        public float max;
    }

    /// <summary>文本 TMP 材质需求，用于近似还原 Figma 字体描边和投影</summary>
    [Serializable]
    public class TextMaterialSpec
    {
        public bool enabled;
        public string signature;
        public string materialName;
        public ColorSpec outlineColor;
        public float outlineWidth;
        public ColorSpec underlayColor;
        public float underlayOffsetX;
        public float underlayOffsetY;
        public float underlaySoftness;
        public float underlayDilate;
        public bool hasOutline;
        public bool hasUnderlay;
        public float sourceStrokeWeight;
    }

    // ═══════════════════════════════════════════════════════════
    // 主生成器
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// Figma → Unity Prefab 生成器。
    /// 通过 uLoop MCP ExecuteDynamicCode 调用 Generate 入口方法。
    /// </summary>
    public static class FigmaPrefabGenerator
    {
        /// <summary>
        /// 入口方法 — 读取 JSON Spec 并生成 Prefab。
        /// 调用方式（ExecuteDynamicCode）: FigmaPrefabGenerator.Generate(".tmp/prefab_spec.json")
        /// </summary>
        public static void Generate(string specJsonPath)
        {
            // 0. 解析路径
            string projectRoot = Path.GetDirectoryName(Application.dataPath)
                ?? Directory.GetCurrentDirectory();
            string fullJsonPath = Path.Combine(projectRoot, specJsonPath);

            if (!File.Exists(fullJsonPath))
            {
                ZLog.LogError($"[FigmaPrefabGenerator] Spec file not found: {fullJsonPath}");
                return;
            }

            string json = File.ReadAllText(fullJsonPath);
            if (string.IsNullOrWhiteSpace(json))
            {
                ZLog.LogError("[FigmaPrefabGenerator] Spec file is empty.");
                return;
            }

            // 1. 反序列化
            PrefabSpec spec;
            try
            {
                spec = JsonUtility.FromJson<PrefabSpec>(json);
            }
            catch (Exception ex)
            {
                ZLog.LogError($"[FigmaPrefabGenerator] Failed to deserialize spec JSON: {ex.Message}");
                return;
            }

            if (spec == null || spec.nodes == null || spec.nodes.Length == 0)
            {
                ZLog.LogError("[FigmaPrefabGenerator] Spec is null or has no nodes.");
                return;
            }

            var context = new GeneratorContext
            {
                Spec = spec,
                ProjectRoot = projectRoot,
                ImageIdToPath = new Dictionary<string, string>(),
                PrefabIdToPath = new Dictionary<string, string>(),
                ImageIdToGuid = new Dictionary<string, string>(),
                TextMaterialCache = new Dictionary<string, Material>()
            };

            // 2. 下载图片资源
            if (spec.images != null && spec.images.Length > 0)
            {
                EditorUtility.DisplayProgressBar("FigmaPrefabGenerator", "Downloading images...", 0.2f);
                DownloadImages(spec.images, context);
            }

            // 3. Refresh AssetDatabase（让 Unity 识别新图片并生成 .meta）
            AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
            EditorUtility.DisplayProgressBar("FigmaPrefabGenerator", "Refreshing assets...", 0.5f);

            // 4. 读取图片 GUID
            ResolveImageGuids(context);

            // 5. 验证 PrefabInstance 引用
            if (spec.prefabInstances != null)
            {
                foreach (var p in spec.prefabInstances)
                {
                    if (string.IsNullOrEmpty(p.sourcePrefabPath))
                    {
                        ZLog.LogWarning($"[FigmaPrefabGenerator] PrefabInstance '{p.id}' has empty source path.");
                        continue;
                    }
                    context.PrefabIdToPath[p.id] = p.sourcePrefabPath;
                }
            }

            // 6. 创建根节点
            EditorUtility.DisplayProgressBar("FigmaPrefabGenerator", "Building hierarchy...", 0.7f);
            NodeSpec rootNode = spec.nodes[0];
            if (rootNode.type != "Root")
            {
                ZLog.LogError("[FigmaPrefabGenerator] First node must be type 'Root'.");
                return;
            }

            var rootGo = BuildNodeTree(rootNode, null, spec, context);

            // 7. 应用分组规则（如果 JSON Spec 中定义了 groupingRules）
            if (spec.groupingRules != null && spec.groupingRules.Length > 0)
            {
                EditorUtility.DisplayProgressBar("FigmaPrefabGenerator", "Applying grouping rules...", 0.75f);
                ApplyGroupingRules(rootGo.transform, spec);
            }

            // 8. 强制后处理：CommonFont + AutoSize + RaycastTarget
            EditorUtility.DisplayProgressBar("FigmaPrefabGenerator", "Post-processing...", 0.8f);
            ApplyPostProcessing(rootGo);

            // 9. 确保目标目录存在
            string prefabDir = Path.GetDirectoryName(spec.prefabPath);
            if (!string.IsNullOrEmpty(prefabDir) && !Directory.Exists(prefabDir))
            {
                Directory.CreateDirectory(prefabDir);
            }

            // 10. 保存 Prefab
            EditorUtility.DisplayProgressBar("FigmaPrefabGenerator", "Saving prefab...", 0.9f);
            GameObject savedPrefab = PrefabUtility.SaveAsPrefabAsset(rootGo, spec.prefabPath);

            // 11. 清理临时 GameObject
            UnityEngine.Object.DestroyImmediate(rootGo);

            EditorUtility.ClearProgressBar();

            if (savedPrefab != null)
            {
                ZLog.Log($"[FigmaPrefabGenerator] Prefab created: {spec.prefabPath}");
                ZLog.Log($"[FigmaPrefabGenerator] Nodes: {spec.nodes.Length}, Images: {spec.images?.Length ?? 0}");
                LogPostProcessingReport(savedPrefab);
            }
            else
            {
                ZLog.LogError("[FigmaPrefabGenerator] Failed to save prefab.");
            }
        }

        // ═══════════════════════════════════════════════════════
        // 图片下载
        // ═══════════════════════════════════════════════════════

        private static void DownloadImages(ImageSpec[] images, GeneratorContext context)
        {
            foreach (var img in images)
            {
                if (string.IsNullOrEmpty(img.id))
                {
                    ZLog.LogWarning("[FigmaPrefabGenerator] Skipping image with empty id.");
                    continue;
                }

                string targetDir = img.targetDir;
                if (string.IsNullOrEmpty(targetDir))
                {
                    ZLog.LogWarning($"[FigmaPrefabGenerator] Image '{img.id}' has no targetDir, using Assets/");
                    targetDir = "Assets/";
                }

                string targetDirFull = Path.Combine(context.ProjectRoot, targetDir);
                if (!Directory.Exists(targetDirFull))
                {
                    Directory.CreateDirectory(targetDirFull);
                }

                string fileName = img.fileName;
                if (string.IsNullOrEmpty(fileName))
                {
                    fileName = $"{img.id}.png";
                }

                string targetPath = Path.Combine(targetDir, fileName);
                string targetPathFull = Path.Combine(context.ProjectRoot, targetPath);
                context.ImageIdToPath[img.id] = targetPath;

                // 解析图片下载 URL 信息 — 需要从外部提供
                // 注意: 图片的实际下载由 AI 侧用 PowerShell 并行完成，
                // 这里处理图片已存在的情况（重新导入时 Refresh 后识别）

                if (File.Exists(targetPathFull))
                {
                    ZLog.Log($"[FigmaPrefabGenerator] Image '{img.id}' already at: {targetPath}");
                }
                else
                {
                    ZLog.LogWarning($"[FigmaPrefabGenerator] Image '{img.id}' not found at {targetPath}. "
                        + "Expected to be downloaded by AI side before this step.");
                }

                // 处理 spriteSetting（JSON 字符串 → 解析后设置 .meta 关键字段）
                if (!string.IsNullOrEmpty(img.spriteSettingJson))
                {
                    try
                    {
                        var setting = JsonUtility.FromJson<SpriteSettingSpec>(img.spriteSettingJson);
                        if (setting != null && setting.border != null)
                        {
                            ApplySpriteBorderAfterImport(targetPath, setting);
                        }
                    }
                    catch (Exception ex)
                    {
                        ZLog.LogWarning($"[FigmaPrefabGenerator] Failed to parse spriteSetting for '{img.id}': {ex.Message}");
                    }
                }
            }
        }

        /// <summary>
        /// 通过 TextureImporter 设置 spriteBorder 和 pivot。
        /// 在 AssetDatabase.Refresh 之后调用才能获取到正确的 Importer。
        /// </summary>
        private static void ApplySpriteBorderAfterImport(string assetPath, SpriteSettingSpec setting)
        {
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null)
            {
                ZLog.LogWarning($"[FigmaPrefabGenerator] Cannot get TextureImporter for: {assetPath}");
                return;
            }

            var changed = false;
            if (importer.textureType != TextureImporterType.Sprite)
            {
                importer.textureType = TextureImporterType.Sprite;
                changed = true;
            }
            if (importer.spriteImportMode != SpriteImportMode.Single)
            {
                importer.spriteImportMode = SpriteImportMode.Single;
                changed = true;
            }
            if (!importer.alphaIsTransparency)
            {
                importer.alphaIsTransparency = true;
                changed = true;
            }
            if (importer.mipmapEnabled)
            {
                importer.mipmapEnabled = false;
                changed = true;
            }

            var border = setting.border;
            if (border != null)
            {
                var spriteBorder = new Vector4(border.l, border.b, border.r, border.t);
                if (importer.spriteBorder != spriteBorder)
                {
                    importer.spriteBorder = spriteBorder;
                    changed = true;
                }
            }

            var pivot = setting.pivot;
            if (pivot != null)
            {
                var spritePivot = new Vector2(pivot.x, pivot.y);
                if (importer.spritePivot != spritePivot)
                {
                    importer.spritePivot = spritePivot;
                    changed = true;
                }
            }
            else
            {
                var spritePivot = new Vector2(0.5f, 0.5f);
                if (importer.spritePivot != spritePivot)
                {
                    importer.spritePivot = spritePivot;
                    changed = true;
                }
            }

            if (changed)
            {
                importer.SaveAndReimport();
                ZLog.Log($"[FigmaPrefabGenerator] Applied sprite settings to: {assetPath} (border={importer.spriteBorder})");
            }
            else
            {
                ZLog.Log($"[FigmaPrefabGenerator] Sprite settings already up to date: {assetPath}");
            }
        }

        // ═══════════════════════════════════════════════════════
        // Asset GUID 解析
        // ═══════════════════════════════════════════════════════

        private static void ResolveImageGuids(GeneratorContext context)
        {
            foreach (var kv in context.ImageIdToPath)
            {
                string guid = AssetDatabase.AssetPathToGUID(kv.Value);
                if (!string.IsNullOrEmpty(guid))
                {
                    context.ImageIdToGuid[kv.Key] = guid;
                    ZLog.Log($"[FigmaPrefabGenerator] Image '{kv.Key}' -> GUID: {guid}");
                }
                else
                {
                    ZLog.LogWarning($"[FigmaPrefabGenerator] Cannot resolve GUID for image '{kv.Key}' at path: {kv.Value}");
                }
            }
        }

        // ═══════════════════════════════════════════════════════
        // 节点树递归构建
        // ═══════════════════════════════════════════════════════

        private static GameObject BuildNodeTree(NodeSpec node, Transform parent,
            PrefabSpec spec, GeneratorContext context)
        {
            GameObject go = CreateGameObject(node, spec, context);
            if (go == null) return null;

            if (parent != null)
            {
                go.transform.SetParent(parent, false);
            }

            SetRectTransform(go, node);

            // 递归构建子节点
            if (node.childIndices != null)
            {
                foreach (int childIndex in node.childIndices)
                {
                    if (childIndex >= 0 && childIndex < spec.nodes.Length)
                    {
                        BuildNodeTree(spec.nodes[childIndex], go.transform, spec, context);
                    }
                }
            }

            return go;
        }

        private static GameObject CreateGameObject(NodeSpec node, PrefabSpec spec,
            GeneratorContext context)
        {
            GameObject go;

            switch (node.type)
            {
                case "Root":
                case "Panel":
                    go = new GameObject(node.name, typeof(RectTransform));
                    break;

                case "Image":
                    go = CreateImageNode(node, spec, context);
                    break;

                case "Text":
                    go = CreateTextNode(node, context);
                    break;

                case "PrefabInstance":
                    go = CreatePrefabInstanceNode(node, context);
                    break;

                default:
                    ZLog.LogWarning($"[FigmaPrefabGenerator] Unknown node type: '{node.type}', creating empty Panel.");
                    go = new GameObject(node.name, typeof(RectTransform));
                    break;
            }

            // 设置层级（UI 层）
            go.layer = LayerMask.NameToLayer("UI");

            return go;
        }

        // ═══════════════════════════════════════════════════════
        // 各类型节点创建
        // ═══════════════════════════════════════════════════════

        private static GameObject CreateImageNode(NodeSpec node, PrefabSpec spec,
            GeneratorContext context)
        {
            var go = new GameObject(node.name, typeof(RectTransform));

            // 使用项目自定义 CustomImage（LFramework.Runtime 程序集），回退到 UnityEngine.UI.Image
            Type imageType = Type.GetType("LFramework.Runtime.CustomImage, LFramework.Runtime")
                ?? typeof(Image);
            go.AddComponent(imageType);

            // 设置 Sprite 引用
            if (!string.IsNullOrEmpty(node.imageId) &&
                context.ImageIdToGuid.TryGetValue(node.imageId, out string guid))
            {
                string spritePath = AssetDatabase.GUIDToAssetPath(guid);
                var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(spritePath);
                if (sprite != null)
                {
                    // 通过 SerializedObject 设置 m_Sprite
                    var comp = go.GetComponent(imageType);
                    var so = new SerializedObject(comp);
                    var spriteProp = so.FindProperty("m_Sprite");
                    if (spriteProp != null)
                    {
                        spriteProp.objectReferenceValue = sprite;
                        so.ApplyModifiedProperties();
                    }
                }
                else
                {
                    ZLog.LogWarning($"[FigmaPrefabGenerator] Cannot load sprite at: {spritePath}");
                }

                // 设置 Image Type（Sliced/Simple）
                var comp2 = go.GetComponent(imageType);
                var so2 = new SerializedObject(comp2);
                var typeProp = so2.FindProperty("m_Type");
                if (typeProp != null && !string.IsNullOrEmpty(node.imageType))
                {
                    if (node.imageType == "Sliced")
                        typeProp.intValue = 1; // Image.Type.Sliced
                    else
                        typeProp.intValue = 0; // Image.Type.Simple
                    so2.ApplyModifiedProperties();
                }
            }

            // 设置颜色
            if (node.color != null)
            {
                var comp = go.GetComponent(imageType);
                var so = new SerializedObject(comp);
                var colorProp = so.FindProperty("m_Color");
                if (colorProp != null)
                {
                    colorProp.colorValue = new Color(node.color.r, node.color.g,
                        node.color.b, node.color.a);
                    so.ApplyModifiedProperties();
                }
            }

            return go;
        }

        private static GameObject CreateTextNode(NodeSpec node, GeneratorContext context)
        {
            var go = new GameObject(node.name, typeof(RectTransform));
            go.AddComponent<TextMeshProUGUI>();

            var tmp = go.GetComponent<TextMeshProUGUI>();
            if (tmp == null) return go;

            // 文字内容
            if (node.text != null)
            {
                tmp.text = node.text;
            }

            // 字号
            if (node.fontSize > 0)
            {
                tmp.fontSize = node.fontSize;
            }

            // 颜色（写入 m_fontColor，非 m_Color）
            if (node.color != null)
            {
                tmp.color = new Color(node.color.r, node.color.g, node.color.b, node.color.a);
            }

            // 对齐
            if (!string.IsNullOrEmpty(node.alignment))
            {
                tmp.alignment = ParseAlignment(node.alignment);
            }

            // AutoSize
            if (node.autoSize != null)
            {
                tmp.enableAutoSizing = true;
                tmp.fontSizeMin = node.autoSize.min;
                tmp.fontSizeMax = node.autoSize.max;
            }
            else
            {
                tmp.enableAutoSizing = false;
            }

            // 默认设置
            tmp.textWrappingMode = TextWrappingModes.NoWrap;
            tmp.overflowMode = TextOverflowModes.Overflow;
            ApplyTextMaterial(tmp, node.textMaterial, context);

            return go;
        }

        private static GameObject CreatePrefabInstanceNode(NodeSpec node, GeneratorContext context)
        {
            if (string.IsNullOrEmpty(node.prefabId) ||
                !context.PrefabIdToPath.TryGetValue(node.prefabId, out string sourcePath))
            {
                ZLog.LogWarning($"[FigmaPrefabGenerator] PrefabInstance '{node.name}' has no valid prefabId reference, creating empty panel.");
                return new GameObject(node.name, typeof(RectTransform));
            }

            var sourcePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath);
            if (sourcePrefab == null)
            {
                ZLog.LogWarning($"[FigmaPrefabGenerator] Cannot load source prefab at: {sourcePath}, creating empty panel for '{node.name}'.");
                return new GameObject(node.name, typeof(RectTransform));
            }

            // 使用 PrefabUtility.InstantiatePrefab 创建 PrefabInstance
            var go = (GameObject)PrefabUtility.InstantiatePrefab(sourcePrefab);
            go.name = node.name;
            ApplyPrefabInstanceVariant(go, node.activeVariant);

            return go;
        }

        /// <summary>
        /// 应用 feature-local ComponentSet 的激活变体，只启用指定 Variant 子节点。
        /// </summary>
        private static void ApplyPrefabInstanceVariant(GameObject go, string activeVariant)
        {
            if (go == null || string.IsNullOrEmpty(activeVariant))
            {
                return;
            }

            string targetName = activeVariant.StartsWith("[", StringComparison.Ordinal)
                ? activeVariant
                : $"[{activeVariant}]";
            var children = go.transform.Cast<Transform>()
                .Where(child => child.name.StartsWith("[Variant_", StringComparison.Ordinal))
                .ToArray();
            if (children.Length == 0)
            {
                ZLog.LogWarning($"[FigmaPrefabGenerator] PrefabInstance '{go.name}' activeVariant='{activeVariant}' but no Variant children found.");
                return;
            }

            bool matched = false;
            foreach (var child in children)
            {
                bool active = string.Equals(child.name, targetName, StringComparison.Ordinal);
                child.gameObject.SetActive(active);
                matched |= active;
            }

            if (!matched)
            {
                ZLog.LogWarning($"[FigmaPrefabGenerator] PrefabInstance '{go.name}' activeVariant='{activeVariant}' not found.");
            }
        }

        // ═══════════════════════════════════════════════════════
        // RectTransform 设置（所有节点共用）
        // ═══════════════════════════════════════════════════════

        private static void SetRectTransform(GameObject go, NodeSpec node)
        {
            if (node.rect == null) return;

            var rt = go.GetComponent<RectTransform>();
            if (rt == null) return;

            rt.anchorMin = ReadVector2(node.rectTransform?.anchorMin, new Vector2(0.5f, 0.5f));
            rt.anchorMax = ReadVector2(node.rectTransform?.anchorMax, rt.anchorMin);
            rt.pivot = ReadVector2(node.rectTransform?.pivot, new Vector2(0.5f, 0.5f));

            // anchoredPosition 已由 AI 在 JSON 中完成转换
            rt.anchoredPosition = new Vector2(node.rect.x, node.rect.y);
            rt.sizeDelta = new Vector2(node.rect.w, node.rect.h);

            rt.localScale = Vector3.one;
            rt.localRotation = Quaternion.identity;
        }

        private static Vector2 ReadVector2(Vector2Spec spec, Vector2 fallback)
        {
            return spec == null ? fallback : new Vector2(spec.x, spec.y);
        }

        // ═══════════════════════════════════════════════════════
        // 辅助方法
        // ═══════════════════════════════════════════════════════

        private static TextAlignmentOptions ParseAlignment(string alignment)
        {
            switch (alignment)
            {
                case "Left": return TextAlignmentOptions.Left;
                case "Center": return TextAlignmentOptions.Center;
                case "Right": return TextAlignmentOptions.Right;
                case "TopLeft": return TextAlignmentOptions.TopLeft;
                case "Top": return TextAlignmentOptions.Top;
                case "TopRight": return TextAlignmentOptions.TopRight;
                case "BottomLeft": return TextAlignmentOptions.BottomLeft;
                case "Bottom": return TextAlignmentOptions.Bottom;
                case "BottomRight": return TextAlignmentOptions.BottomRight;
                default: return TextAlignmentOptions.Center;
            }
        }

        // ═══════════════════════════════════════════════════════
        // 分组规则应用
        // ═══════════════════════════════════════════════════════

        /// <summary>
        /// 根据 JSON Spec 中的 groupingRules 创建分组节点并移动子节点。
        /// 保持子节点世界位置不变（分组节点 anchoredPosition=0,0）。
        /// </summary>
        private static void ApplyGroupingRules(Transform root, PrefabSpec spec)
        {
            if (spec.groupingRules == null) return;

            for (int ruleIdx = 0; ruleIdx < spec.groupingRules.Length; ruleIdx++)
            {
                var rule = spec.groupingRules[ruleIdx];
                if (string.IsNullOrEmpty(rule.parentName) || rule.childNodeIndices == null || rule.childNodeIndices.Length == 0)
                    continue;

                // 创建分组空节点
                var groupGo = new GameObject(rule.parentName);
                var groupRt = groupGo.AddComponent<RectTransform>();
                groupGo.transform.SetParent(root, false);
                groupRt.anchoredPosition = Vector2.zero;
                groupRt.sizeDelta = Vector2.zero;
                groupRt.anchorMin = new Vector2(0.5f, 0.5f);
                groupRt.anchorMax = new Vector2(0.5f, 0.5f);
                groupRt.pivot = new Vector2(0.5f, 0.5f);

                // 如果有 parentRect，设置分组节点位置尺寸
                if (rule.parentRect != null)
                {
                    groupRt.anchoredPosition = new Vector2(rule.parentRect.x, rule.parentRect.y);
                    groupRt.sizeDelta = new Vector2(rule.parentRect.w, rule.parentRect.h);
                }

                // 收集子节点（按原 sibling 顺序）
                var children = new List<Transform>();
                foreach (int nodeIdx in rule.childNodeIndices)
                {
                    if (nodeIdx < 0 || nodeIdx >= spec.nodes.Length) continue;
                    string nodeName = spec.nodes[nodeIdx].name;
                    var child = root.Find(nodeName);
                    if (child != null) children.Add(child);
                }

                // 找到第一个子节点的 sibling index，把分组节点插入该位置
                if (children.Count > 0)
                {
                    int minSibling = int.MaxValue;
                    foreach (var c in children)
                    {
                        if (c.GetSiblingIndex() < minSibling)
                            minSibling = c.GetSiblingIndex();
                    }
                    groupGo.transform.SetSiblingIndex(minSibling);
                }

                // 移动子节点到分组
                foreach (var child in children)
                {
                    child.SetParent(groupGo.transform, false);
                }

                ZLog.Log($"[FigmaPrefabGenerator] Group '{rule.parentName}' created with {children.Count} children. Evidence: {rule.evidence ?? "N/A"}");
            }
        }

        // ═══════════════════════════════════════════════════════
        // 强制后处理
        // ═══════════════════════════════════════════════════════

        private const float MATERIAL_FLOAT_TOLERANCE = 0.015f;
        private const float MATERIAL_COLOR_TOLERANCE = 0.015f;

        /// <summary>
        /// 根据文本材质需求绑定 TMP 材质；相同描边/投影签名在同次导入中只解析一次。
        /// </summary>
        private static void ApplyTextMaterial(TextMeshProUGUI tmp, TextMaterialSpec materialSpec, GeneratorContext context)
        {
            if (tmp == null || materialSpec == null || !materialSpec.enabled)
            {
                return;
            }

            string signature = string.IsNullOrEmpty(materialSpec.signature)
                ? BuildTextMaterialSignature(materialSpec)
                : materialSpec.signature;
            if (string.IsNullOrEmpty(signature))
            {
                return;
            }

            if (!context.TextMaterialCache.TryGetValue(signature, out var material))
            {
                material = FindOrCreateTextMaterial(materialSpec, signature);
                context.TextMaterialCache[signature] = material;
            }

            if (material != null)
            {
                tmp.fontSharedMaterial = material;
            }
        }

        /// <summary>
        /// 优先复用现有近似 TMP 材质，找不到时基于 CommonFont.mat 创建新材质。
        /// </summary>
        private static Material FindOrCreateTextMaterial(TextMaterialSpec materialSpec, string signature)
        {
            Material existing = FindApproximateTextMaterial(materialSpec);
            if (existing != null)
            {
                ZLog.Log($"[FigmaPrefabGenerator] 复用 TMP 材质: {AssetDatabase.GetAssetPath(existing)}");
                return existing;
            }

            Material baseMaterial = AssetDatabase.LoadAssetAtPath<Material>(FigmaBridgeImportSettings.MaterialPath);
            if (baseMaterial == null)
            {
                ZLog.LogWarning($"[FigmaPrefabGenerator] Cannot create text material, base material missing: {FigmaBridgeImportSettings.MaterialPath}");
                return null;
            }

            EnsureAssetDirectory(FigmaBridgeImportSettings.MaterialDirectory);
            string materialName = string.IsNullOrEmpty(materialSpec.materialName)
                ? $"CommonFont_figma_{signature}"
                : materialSpec.materialName;
            string materialPath = AssetDatabase.GenerateUniqueAssetPath($"{FigmaBridgeImportSettings.MaterialDirectory}/{SanitizeAssetName(materialName)}.mat");
            var material = new Material(baseMaterial)
            {
                name = Path.GetFileNameWithoutExtension(materialPath)
            };
            ApplyMaterialProperties(material, materialSpec);
            AssetDatabase.CreateAsset(material, materialPath);
            AssetDatabase.SaveAssets();
            ZLog.Log($"[FigmaPrefabGenerator] 新建 TMP 材质: {materialPath}");
            return AssetDatabase.LoadAssetAtPath<Material>(materialPath);
        }

        /// <summary>
        /// 扫描现有 CommonFont 材质，近似匹配描边和投影参数以避免材质重复生成。
        /// </summary>
        private static Material FindApproximateTextMaterial(TextMaterialSpec materialSpec)
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
                if (material == null)
                {
                    continue;
                }

                if (IsMaterialApproximateMatch(material, materialSpec))
                {
                    return material;
                }
            }

            return null;
        }

        /// <summary>
        /// 判断现有材质是否与 Figma 描边/投影需求近似一致。
        /// </summary>
        private static bool IsMaterialApproximateMatch(Material material, TextMaterialSpec spec)
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

        /// <summary>获取已存在的 TMP 材质搜索目录，避免 AssetDatabase 扫描不存在路径。</summary>
        private static string[] GetExistingMaterialSearchFolders()
        {
            string[] candidateFolders =
            {
                "Assets/MagicWarrior/_Resources/Font/Package",
                "Assets/_Resources/Sharders/Font"
            };
            return candidateFolders.Where(AssetDatabase.IsValidFolder).ToArray();
        }

        /// <summary>
        /// 将 Figma 近似参数写入 TMP 材质属性。
        /// </summary>
        private static void ApplyMaterialProperties(Material material, TextMaterialSpec spec)
        {
            if (material == null)
            {
                return;
            }

            SetMaterialFloat(material, "_OutlineWidth", spec.hasOutline ? spec.outlineWidth : 0f);
            SetMaterialFloat(material, "_FaceDilate", spec.hasOutline ? spec.outlineWidth * 0.5f : 0f);
            SetMaterialColor(material, "_OutlineColor", spec.hasOutline ? ToColor(spec.outlineColor) : Color.black);
            SetMaterialFloat(material, "_UnderlayOffsetX", spec.hasUnderlay ? spec.underlayOffsetX : 0f);
            SetMaterialFloat(material, "_UnderlayOffsetY", spec.hasUnderlay ? spec.underlayOffsetY : 0f);
            SetMaterialFloat(material, "_UnderlaySoftness", spec.hasUnderlay ? spec.underlaySoftness : 0f);
            SetMaterialFloat(material, "_UnderlayDilate", spec.hasUnderlay ? spec.underlayDilate : 0f);
            SetMaterialColor(material, "_UnderlayColor", spec.hasUnderlay ? ToColor(spec.underlayColor) : Color.black);

            SetKeyword(material, "OUTLINE_ON", spec.hasOutline && spec.outlineWidth > 0.001f);
            SetKeyword(material, "UNDERLAY_ON", spec.hasUnderlay);
        }

        /// <summary>按 Spec 参数构建兜底签名，防止旧 Spec 未写 signature。</summary>
        private static string BuildTextMaterialSignature(TextMaterialSpec spec)
        {
            if (spec == null || (!spec.hasOutline && !spec.hasUnderlay))
            {
                return string.Empty;
            }

            string outline = spec.hasOutline ? ColorUtility.ToHtmlStringRGBA(ToColor(spec.outlineColor)) : "none";
            string underlay = spec.hasUnderlay ? ColorUtility.ToHtmlStringRGBA(ToColor(spec.underlayColor)) : "none";
            return $"o_{outline}_w_{Mathf.RoundToInt(spec.outlineWidth * 100):000}_u_{underlay}"
                + $"_x_{Mathf.RoundToInt((spec.underlayOffsetX + 1f) * 100f):000}"
                + $"_y_{Mathf.RoundToInt((spec.underlayOffsetY + 1f) * 100f):000}"
                + $"_s_{Mathf.RoundToInt(spec.underlaySoftness * 100f):000}"
                + $"_d_{Mathf.RoundToInt(spec.underlayDilate * 100f):000}";
        }

        /// <summary>创建 Unity 资源目录，逐级创建可避免 AssetDatabase 目录缺失。</summary>
        private static void EnsureAssetDirectory(string assetDirectory)
        {
            if (AssetDatabase.IsValidFolder(assetDirectory))
            {
                return;
            }

            string[] parts = assetDirectory.Split('/');
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

        /// <summary>清理材质文件名中的非法字符，确保可作为 Unity 资源路径。</summary>
        private static string SanitizeAssetName(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return "CommonFont_figma_material";
            }

            char[] invalid = Path.GetInvalidFileNameChars();
            string cleaned = new string(name.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray());
            return cleaned.Length > 120 ? cleaned.Substring(0, 120) : cleaned;
        }

        private static bool MaterialFloatApprox(Material material, string property, float expected)
        {
            if (!material.HasProperty(property))
            {
                return Mathf.Abs(expected) <= MATERIAL_FLOAT_TOLERANCE;
            }
            return Mathf.Abs(material.GetFloat(property) - expected) <= MATERIAL_FLOAT_TOLERANCE;
        }

        private static bool MaterialColorApprox(Material material, string property, Color expected)
        {
            if (!material.HasProperty(property))
            {
                return expected.maxColorComponent <= MATERIAL_COLOR_TOLERANCE && expected.a <= MATERIAL_COLOR_TOLERANCE;
            }

            Color actual = material.GetColor(property);
            return Mathf.Abs(actual.r - expected.r) <= MATERIAL_COLOR_TOLERANCE
                && Mathf.Abs(actual.g - expected.g) <= MATERIAL_COLOR_TOLERANCE
                && Mathf.Abs(actual.b - expected.b) <= MATERIAL_COLOR_TOLERANCE
                && Mathf.Abs(actual.a - expected.a) <= MATERIAL_COLOR_TOLERANCE;
        }

        private static void SetMaterialFloat(Material material, string property, float value)
        {
            if (material.HasProperty(property))
            {
                material.SetFloat(property, value);
            }
        }

        private static void SetMaterialColor(Material material, string property, Color value)
        {
            if (material.HasProperty(property))
            {
                material.SetColor(property, value);
            }
        }

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

        private static Color ToColor(ColorSpec color)
        {
            if (color == null)
            {
                return Color.black;
            }

            return new Color(color.r, color.g, color.b, color.a);
        }

        /// <summary>
        /// 统一后处理：
        /// 1. 所有 TextMeshProUGUI 绑定 CommonFont，并在缺少专用材质时绑定 CommonFont.mat
        /// 2. 所有 Image 组件 RaycastTarget=false
        /// </summary>
        private static void ApplyPostProcessing(GameObject root)
        {
            var commonFont = FigmaBridgeImportSettings.Font;
            var commonMat = AssetDatabase.LoadAssetAtPath<Material>(FigmaBridgeImportSettings.MaterialPath);

            if (commonFont == null)
                ZLog.LogWarning($"[FigmaPrefabGenerator] CommonFont not found at: {FigmaBridgeImportSettings.FontPath}");
            if (commonMat == null)
                ZLog.LogWarning($"[FigmaPrefabGenerator] CommonFont.mat not found at: {FigmaBridgeImportSettings.MaterialPath}");

            // TMP 后处理
            var tmps = root.GetComponentsInChildren<TextMeshProUGUI>(true);
            foreach (var tmp in tmps)
            {
                Material customMaterial = ShouldPreserveTextMaterial(tmp.fontSharedMaterial, commonMat)
                    ? tmp.fontSharedMaterial
                    : null;
                if (commonFont != null) tmp.font = commonFont;
                if (customMaterial != null)
                {
                    tmp.fontSharedMaterial = customMaterial;
                }
                else if (commonMat != null)
                {
                    tmp.fontSharedMaterial = commonMat;
                }

                // 🛠️ 字体绑定后强制关闭 AutoSize，防止 TMP 内部重设 enableAutoSizing=true
                tmp.enableAutoSizing = false;
            }

            // Image RaycastTarget 后处理
            var graphics = root.GetComponentsInChildren<Graphic>(true);
            foreach (var g in graphics)
            {
                if (g is Image) g.raycastTarget = false;
            }

            ApplyScrollViewPostProcessing(root);
        }

        private static void ApplyScrollViewPostProcessing(GameObject root)
        {
            var transforms = root.GetComponentsInChildren<RectTransform>(true);
            foreach (var scrollView in transforms)
            {
                if (!string.Equals(scrollView.name, "[ScrollView]", StringComparison.Ordinal))
                {
                    continue;
                }

                var viewport = FindDirectChild(scrollView, "[Viewport]");
                var content = viewport != null ? FindDirectChild(viewport, "[Content]") : null;
                if (viewport == null || content == null)
                {
                    continue;
                }

                EnsureScrollContentArea(viewport);

                var rectMask = viewport.GetComponent<RectMask2D>();
                if (rectMask == null)
                {
                    rectMask = viewport.gameObject.AddComponent<RectMask2D>();
                }

                var scrollRect = scrollView.GetComponent<ScrollRect>();
                if (scrollRect == null)
                {
                    scrollRect = scrollView.gameObject.AddComponent<ScrollRect>();
                }

                scrollRect.viewport = viewport;
                scrollRect.content = content;
                scrollRect.horizontal = false;
                scrollRect.vertical = true;
                scrollRect.movementType = ScrollRect.MovementType.Clamped;
                scrollRect.inertia = false;
            }
        }

        private static void EnsureScrollContentArea(RectTransform viewport)
        {
            var contentArea = FindDirectChild(viewport, "[ScrollContentArea]");
            if (contentArea == null)
            {
                var contentAreaGo = new GameObject("[ScrollContentArea]", typeof(RectTransform));
                contentArea = contentAreaGo.GetComponent<RectTransform>();
                contentArea.SetParent(viewport, false);
                contentArea.SetAsFirstSibling();
            }

            contentArea.anchorMin = Vector2.zero;
            contentArea.anchorMax = Vector2.one;
            contentArea.pivot = new Vector2(0.5f, 0.5f);
            contentArea.offsetMin = Vector2.zero;
            contentArea.offsetMax = Vector2.zero;
            contentArea.anchoredPosition = Vector2.zero;
            contentArea.sizeDelta = Vector2.zero;
            contentArea.localScale = Vector3.one;
            contentArea.localRotation = Quaternion.identity;
        }

        private static RectTransform FindDirectChild(RectTransform parent, string childName)
        {
            foreach (Transform child in parent)
            {
                if (string.Equals(child.name, childName, StringComparison.Ordinal))
                {
                    return child as RectTransform;
                }
            }
            return null;
        }

        /// <summary>判断 TMP 当前材质是否是已绑定的 CommonFont 系列描边/投影材质。</summary>
        private static bool ShouldPreserveTextMaterial(Material material, Material commonMat)
        {
            if (material == null)
            {
                return false;
            }

            if (commonMat != null && material == commonMat)
            {
                return false;
            }

            return material.name.StartsWith("CommonFont_", StringComparison.Ordinal);
        }

        /// <summary>输出后处理验证报告到 Console</summary>
        private static void LogPostProcessingReport(GameObject prefab)
        {
            var tmps = prefab.GetComponentsInChildren<TextMeshProUGUI>(true);
            int tmpTotal = tmps.Length, fontOk = 0, matOk = 0, customMat = 0, autoSizeOk = 0;
            foreach (var tmp in tmps)
            {
                if (tmp.font != null && tmp.font.name == "CommonFont") fontOk++;
                if (tmp.fontSharedMaterial != null && tmp.fontSharedMaterial.name == "CommonFont") matOk++;
                if (tmp.fontSharedMaterial != null && tmp.fontSharedMaterial.name != "CommonFont") customMat++;
                if (tmp.enableAutoSizing) autoSizeOk++;
            }

            var images = prefab.GetComponentsInChildren<Image>(true);
            int imgTotal = images.Length, rayOff = 0;
            foreach (var img in images)
            {
                if (!img.raycastTarget) rayOff++;
            }

            ZLog.Log($"[FigmaPrefabGenerator] 后处理报告: TMP={tmpTotal} (Font={fontOk}, CommonMat={matOk}, CustomMat={customMat}, AutoSize={autoSizeOk}), Image={imgTotal} (RaycastOff={rayOff})");
        }

        // ═══════════════════════════════════════════════════════
        // 上下文
        // ═══════════════════════════════════════════════════════

        private class GeneratorContext
        {
            public PrefabSpec Spec;
            public string ProjectRoot;
            public Dictionary<string, string> ImageIdToPath;
            public Dictionary<string, string> PrefabIdToPath;
            public Dictionary<string, string> ImageIdToGuid;
            public Dictionary<string, Material> TextMaterialCache;
        }
    }
}
