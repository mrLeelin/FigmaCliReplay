using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 负责遍历 UGUI RectTransform 树并生成导出节点。
    /// </summary>
    public static class PrefabToFigmaNodeBuilder
    {
        /// <summary>
        /// 构建 Prefab 节点树、扁平节点列表、统计信息和视觉包围盒。
        /// </summary>
        public static void Build(
            GameObject prefabRoot,
            RectTransform rootRect,
            PrefabToFigmaPackage package,
            string repoRoot)
        {
            var prefabInstanceKeys = new HashSet<string>();
            var prefabSourcesByRootId = new Dictionary<string, PrefabToFigmaPrefabSource>();
            CollectPrefabInstances(prefabRoot, package, prefabInstanceKeys, prefabSourcesByRootId);

            package.root = ExportNode(
                rootRect,
                null,
                string.Empty,
                package.canvas.width,
                package.canvas.height,
                package,
                prefabSourcesByRootId,
                repoRoot,
                true);

            CalculateVisualBounds(package);
            NormalizeEmptyRootBounds(package);
            CalculateVisualBounds(package);
            package.stats.nodeCount = package.nodes.Count;
            package.stats.prefabInstanceCount = package.prefabInstances.Count;

            if (package.prefabInstances.Count > 0)
            {
                package.warnings.Add(
                    $"PrefabInstance documents detected: {package.prefabInstances.Count}; " +
                    "C# exporter reads the loaded hierarchy and records source prefab metadata.");
            }
        }

        /// <summary>
        /// 递归导出一个 RectTransform 节点。
        /// </summary>
        private static PrefabToFigmaNode ExportNode(
            RectTransform rectTransform,
            RectTransform parentRect,
            string parentPath,
            float parentWidth,
            float parentHeight,
            PrefabToFigmaPackage package,
            Dictionary<string, PrefabToFigmaPrefabSource> prefabSourcesByRootId,
            string repoRoot,
            bool isRoot)
        {
            var node = CreateBaseNode(rectTransform, parentRect, parentPath, parentWidth, parentHeight, isRoot);
            AttachPrefabSource(rectTransform.gameObject, node, prefabSourcesByRootId);
            AttachComponentData(rectTransform.gameObject, node, package, repoRoot);

            package.nodes.Add(node);
            var childRects = GetChildRectTransforms(rectTransform);
            for (int i = 0; i < childRects.Count; i++)
            {
                var childNode = ExportNode(
                    childRects[i],
                    rectTransform,
                    node.path,
                    Mathf.Max(node.rect.width, 0f),
                    Mathf.Max(node.rect.height, 0f),
                    package,
                    prefabSourcesByRootId,
                    repoRoot,
                    false);
                node.children.Add(childNode);
                node.unity.children.Add(childNode.id);
            }

            return node;
        }

        /// <summary>
        /// 创建基础节点数据，包含路径、显隐、RectTransform 和 Unity 引用信息。
        /// </summary>
        private static PrefabToFigmaNode CreateBaseNode(
            RectTransform rectTransform,
            RectTransform parentRect,
            string parentPath,
            float parentWidth,
            float parentHeight,
            bool isRoot)
        {
            var nodePath = string.IsNullOrEmpty(parentPath)
                ? rectTransform.name
                : parentPath + "/" + rectTransform.name;

            return new PrefabToFigmaNode
            {
                id = BuildObjectId(rectTransform),
                name = rectTransform.name,
                path = nodePath,
                active = rectTransform.gameObject.activeSelf,
                rect = isRoot
                    ? BuildRootRect(rectTransform)
                    : ResolveRect(rectTransform, parentWidth, parentHeight),
                unity = new PrefabToFigmaUnityData
                {
                    gameObjectId = BuildObjectId(rectTransform.gameObject),
                    rectTransformId = BuildObjectId(rectTransform),
                    parentRectId = parentRect != null ? BuildObjectId(parentRect) : string.Empty
                }
            };
        }

        /// <summary>
        /// 给嵌套 Prefab 根节点挂载源 Prefab 元数据，供 Figma 插件查找本地通用组件。
        /// </summary>
        private static void AttachPrefabSource(
            GameObject gameObject,
            PrefabToFigmaNode node,
            Dictionary<string, PrefabToFigmaPrefabSource> prefabSourcesByRootId)
        {
            if (gameObject == null || prefabSourcesByRootId == null)
            {
                return;
            }

            if (prefabSourcesByRootId.TryGetValue(BuildObjectId(gameObject), out var prefabSource))
            {
                node.prefabSource = prefabSource;
            }
        }

        /// <summary>
        /// 根节点固定输出到画布原点，尺寸使用根 RectTransform 当前尺寸。
        /// </summary>
        private static PrefabToFigmaRect BuildRootRect(RectTransform rectTransform)
        {
            var size = rectTransform.sizeDelta;
            var scale = rectTransform.localScale;
            return new PrefabToFigmaRect
            {
                x = 0f,
                y = 0f,
                width = Mathf.Abs(size.x * scale.x),
                height = Mathf.Abs(size.y * scale.y),
                rotationZ = NormalizeAngle(rectTransform.localEulerAngles.z),
                scaleX = !Mathf.Approximately(scale.x, 1f) ? scale.x : (float?)null,
                scaleY = !Mathf.Approximately(scale.y, 1f) ? scale.y : (float?)null
            };
        }

        /// <summary>
        /// 按 Python rect_transform.py 公式解析子节点左上角矩形。
        /// </summary>
        private static PrefabToFigmaRect ResolveRect(RectTransform rectTransform, float parentWidth, float parentHeight)
        {
            var anchorMin = rectTransform.anchorMin;
            var anchorMax = rectTransform.anchorMax;
            var sizeDelta = rectTransform.sizeDelta;
            var pivot = rectTransform.pivot;
            var anchoredPosition = rectTransform.anchoredPosition;
            var scale = rectTransform.localScale;

            var spanWidth = (anchorMax.x - anchorMin.x) * parentWidth;
            var spanHeight = (anchorMax.y - anchorMin.y) * parentHeight;
            var baseWidth = spanWidth + sizeDelta.x;
            var baseHeight = spanHeight + sizeDelta.y;
            var pivotX = anchorMin.x * parentWidth + spanWidth * pivot.x + anchoredPosition.x;
            var pivotY = anchorMin.y * parentHeight + spanHeight * pivot.y + anchoredPosition.y;

            var left = pivotX - pivot.x * baseWidth * scale.x;
            var right = pivotX + (1f - pivot.x) * baseWidth * scale.x;
            var bottom = pivotY - pivot.y * baseHeight * scale.y;
            var top = pivotY + (1f - pivot.y) * baseHeight * scale.y;

            var rect = new PrefabToFigmaRect
            {
                x = Mathf.Min(left, right),
                y = parentHeight - Mathf.Max(bottom, top),
                width = Mathf.Abs(right - left),
                height = Mathf.Abs(top - bottom),
                rotationZ = NormalizeAngle(rectTransform.localEulerAngles.z)
            };

            if (!Mathf.Approximately(scale.x, 1f)) rect.scaleX = scale.x;
            if (!Mathf.Approximately(scale.y, 1f)) rect.scaleY = scale.y;
            return rect;
        }

        /// <summary>
        /// 把 Unity 角度规范化为 -180 到 180 区间，减少 JSON 噪声。
        /// </summary>
        private static float NormalizeAngle(float angle)
        {
            var normalized = Mathf.Repeat(angle + 180f, 360f) - 180f;
            return Mathf.Approximately(normalized, 0f) ? 0f : normalized;
        }

        /// <summary>
        /// 挂载图片、文本、裁剪和不支持组件数据。
        /// </summary>
        private static void AttachComponentData(
            GameObject gameObject,
            PrefabToFigmaNode node,
            PrefabToFigmaPackage package,
            string repoRoot)
        {
            if (PrefabToFigmaImageExporter.TryExport(gameObject, node, package, repoRoot))
            {
                package.stats.imageCount++;
                if (node.image != null && node.image.mode == "nine-slice")
                {
                    package.stats.nineSliceCount++;
                }
            }

            if (PrefabToFigmaTextExporter.TryExport(gameObject, node))
            {
                package.stats.textCount++;
            }

            AttachClipData(gameObject, node, package);
            AttachUnsupportedData(gameObject, node, package);
        }

        /// <summary>
        /// 导出 Mask / RectMask2D 裁剪信息。
        /// </summary>
        private static void AttachClipData(GameObject gameObject, PrefabToFigmaNode node, PrefabToFigmaPackage package)
        {
            var mask = gameObject.GetComponent<Mask>();
            if (mask != null && mask.enabled)
            {
                node.clip = new PrefabToFigmaClip { enabled = true, componentType = mask.GetType().FullName };
                package.stats.clipCount++;
                return;
            }

            var rectMask = gameObject.GetComponent<RectMask2D>();
            if (rectMask != null && rectMask.enabled)
            {
                node.clip = new PrefabToFigmaClip { enabled = true, componentType = rectMask.GetType().FullName };
                package.stats.clipCount++;
            }
        }

        /// <summary>
        /// 标记当前 C# 导出器无法静态还原的组件。
        /// </summary>
        private static void AttachUnsupportedData(GameObject gameObject, PrefabToFigmaNode node, PrefabToFigmaPackage package)
        {
            var components = gameObject.GetComponents<Component>();
            for (int i = 0; i < components.Length; i++)
            {
                var component = components[i];
                if (component == null || IsSupportedComponent(component))
                {
                    continue;
                }

                var typeName = component.GetType().FullName ?? component.GetType().Name;
                if (ShouldReportUnsupported(component, typeName))
                {
                    node.unsupported ??= new List<string>();
                    node.unsupported.Add(typeName);
                }
            }

            if (node.unsupported != null && node.unsupported.Count > 0)
            {
                package.stats.unsupportedCount += node.unsupported.Count;
                package.warnings.Add($"Unsupported components on {node.path}: {string.Join(", ", node.unsupported)}");
            }
        }

        /// <summary>
        /// 判断组件是否已由导出器处理或无需导出。
        /// </summary>
        private static bool IsSupportedComponent(Component component)
        {
            return component is RectTransform ||
                   component is CanvasRenderer ||
                   component is Image ||
                   component is RawImage ||
                   component is Text ||
                   component is Mask ||
                   component is RectMask2D ||
                   PrefabToFigmaImageExporter.IsReflectiveImageComponent(component) ||
                   PrefabToFigmaTextExporter.IsTmpText(component);
        }

        /// <summary>
        /// 判断组件是否需要写入不支持报告。
        /// </summary>
        private static bool ShouldReportUnsupported(Component component, string typeName)
        {
            if (component is Behaviour behaviour && !behaviour.enabled)
            {
                return false;
            }

            return component is MonoBehaviour ||
                   typeName.Contains("Animator") ||
                   typeName.Contains("LayoutGroup") ||
                   typeName.Contains("ContentSizeFitter") ||
                   typeName.Contains("Particle") ||
                   typeName.Contains("MMF_Player");
        }

        /// <summary>
        /// 获取直接子级 RectTransform，保持 Unity Hierarchy 原始顺序。
        /// </summary>
        private static List<RectTransform> GetChildRectTransforms(RectTransform parent)
        {
            var children = new List<RectTransform>(parent.childCount);
            for (int i = 0; i < parent.childCount; i++)
            {
                if (parent.GetChild(i) is RectTransform childRect)
                {
                    children.Add(childRect);
                }
            }

            return children;
        }

        /// <summary>
        /// 收集嵌套 PrefabInstance 源信息，避免重复记录同一个实例根。
        /// </summary>
        private static void CollectPrefabInstances(
            GameObject root,
            PrefabToFigmaPackage package,
            HashSet<string> keys,
            Dictionary<string, PrefabToFigmaPrefabSource> prefabSourcesByRootId)
        {
            var transforms = root.GetComponentsInChildren<Transform>(true);
            for (int i = 0; i < transforms.Length; i++)
            {
                var instanceRoot = PrefabUtility.GetNearestPrefabInstanceRoot(transforms[i].gameObject);
                if (instanceRoot == null || instanceRoot == root)
                {
                    continue;
                }

                var sourcePath = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(instanceRoot);
                var key = BuildObjectId(instanceRoot);
                if (string.IsNullOrEmpty(sourcePath) || !keys.Add(key))
                {
                    continue;
                }

                var sourceGuid = AssetDatabase.AssetPathToGUID(sourcePath);
                prefabSourcesByRootId[key] = new PrefabToFigmaPrefabSource
                {
                    guid = sourceGuid,
                    path = sourcePath,
                    name = System.IO.Path.GetFileNameWithoutExtension(sourcePath),
                    isRoot = true
                };

                package.prefabInstances.Add(new PrefabToFigmaPrefabInstance
                {
                    fileId = key,
                    sourcePrefab = new PrefabToFigmaUnityRef
                    {
                        fileID = "100100000",
                        guid = sourceGuid,
                        type = 3
                    },
                    sourcePrefabPath = sourcePath
                });
            }
        }

        /// <summary>
        /// 根 RectTransform 尺寸为 0 时，用子节点视觉包围盒回填画布，避免导入 Figma 后根 Frame 不可见。
        /// </summary>
        private static void NormalizeEmptyRootBounds(PrefabToFigmaPackage package)
        {
            var root = package.root;
            var bounds = package.visualBounds;
            if (root == null || root.rect == null || bounds == null)
            {
                return;
            }

            if (root.rect.width > 0f && root.rect.height > 0f)
            {
                return;
            }

            if (bounds.width <= 0f || bounds.height <= 0f)
            {
                return;
            }

            for (int i = 0; i < root.children.Count; i++)
            {
                OffsetNode(root.children[i], -bounds.x, -bounds.y);
            }

            root.rect.width = bounds.width;
            root.rect.height = bounds.height;
            package.canvas.width = bounds.width;
            package.canvas.height = bounds.height;
            package.warnings.Add(
                $"{root.path}: root RectTransform size is zero; canvas normalized to visual bounds.");
        }

        /// <summary>
        /// 平移根节点的直接子节点坐标，用于把空根节点的子树移动到新画布原点。
        /// </summary>
        private static void OffsetNode(PrefabToFigmaNode node, float offsetX, float offsetY)
        {
            node.rect.x += offsetX;
            node.rect.y += offsetY;
        }

        /// <summary>
        /// 计算包含子节点外溢的视觉包围盒。
        /// </summary>
        private static void CalculateVisualBounds(PrefabToFigmaPackage package)
        {
            var root = package.root;
            if (root == null || root.rect == null)
            {
                package.visualBounds = new PrefabToFigmaVisualBounds();
                return;
            }

            var minX = 0f;
            var minY = 0f;
            var maxX = root.rect.width;
            var maxY = root.rect.height;

            for (int i = 0; i < root.children.Count; i++)
            {
                VisitBounds(root.children[i], 0f, 0f, ref minX, ref minY, ref maxX, ref maxY);
            }

            package.visualBounds = new PrefabToFigmaVisualBounds
            {
                x = minX,
                y = minY,
                width = maxX - minX,
                height = maxY - minY
            };
        }

        /// <summary>
        /// 递归合并节点和子节点矩形到视觉包围盒。
        /// </summary>
        private static void VisitBounds(
            PrefabToFigmaNode node,
            float offsetX,
            float offsetY,
            ref float minX,
            ref float minY,
            ref float maxX,
            ref float maxY)
        {
            var nodeX = offsetX + node.rect.x;
            var nodeY = offsetY + node.rect.y;
            minX = Mathf.Min(minX, nodeX);
            minY = Mathf.Min(minY, nodeY);
            maxX = Mathf.Max(maxX, nodeX + node.rect.width);
            maxY = Mathf.Max(maxY, nodeY + node.rect.height);

            for (int i = 0; i < node.children.Count; i++)
            {
                VisitBounds(node.children[i], nodeX, nodeY, ref minX, ref minY, ref maxX, ref maxY);
            }
        }

        /// <summary>
        /// 生成导出节点 ID，优先使用 Unity 全局对象 ID。
        /// </summary>
        private static string BuildObjectId(UnityEngine.Object obj)
        {
            if (obj == null)
            {
                return "0";
            }

            var globalId = GlobalObjectId.GetGlobalObjectIdSlow(obj).ToString();
            if (!string.IsNullOrEmpty(globalId) && globalId != "GlobalObjectId_V1-0-00000000000000000000000000000000-0-0")
            {
                return globalId;
            }

            return obj.GetInstanceID().ToString(CultureInfo.InvariantCulture);
        }
    }
}
