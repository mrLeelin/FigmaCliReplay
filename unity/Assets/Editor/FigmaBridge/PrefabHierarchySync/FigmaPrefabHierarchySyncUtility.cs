using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Figma 插件采集的层级文档，用于确定性同步 Unity Prefab。
    /// </summary>
    [Serializable]
    public sealed class FigmaPrefabHierarchyDocument
    {
        public int version;
        public string fileKey;
        public string pageId;
        public string pageName;
        public FigmaPrefabHierarchyNode root;
    }

    /// <summary>
    /// Figma 层级节点，仅包含层级、几何和字号，不包含资源替换信息。
    /// </summary>
    [Serializable]
    public sealed class FigmaPrefabHierarchyNode
    {
        public string id;
        public string name;
        public string type;
        public string path;
        public string structuralPath;
        public string syncBoundaryKind;
        public string sourcePrefabGuid;
        public string sourcePrefabPath;
        public string nodeRole;
        public bool allowCreateChildren = true;
        public bool allowDeleteChildren = true;
        public bool allowReparent = true;
        public int siblingIndex;
        public int figmaSiblingIndex;
        public bool hasOrderBaseline;
        public int orderBaselineSiblingIndex;
        public bool hasGeometryBaseline;
        public bool geometryChangedFromBaseline;
        public bool visible = true;
        public float x;
        public float y;
        public float absoluteX;
        public float absoluteY;
        public float width;
        public float height;
        public float rotation;
        public FigmaPrefabHierarchyConstraints constraints;
        public float fontSize;
        public bool hasText;
        public bool hasImage;
        public FigmaPrefabHierarchyImage image;
        public bool childrenComplete = true;
        public List<FigmaPrefabHierarchyNode> children;
    }

    [Serializable]
    public sealed class FigmaPrefabHierarchyConstraints
    {
        public string horizontal;
        public string vertical;
    }

    /// <summary>
    /// Figma 层级同步中可选携带的 PNG 图片数据。
    /// </summary>
    [Serializable]
    public sealed class FigmaPrefabHierarchyImage
    {
        public string nodeId;
        public string nodeName;
        public string nodePath;
        public string imageHash;
        public string fileName;
        public string base64;
        public string mode;
        public string spriteGuid;
        public string spritePath;
        public string assetPath;
    }

    /// <summary>
    /// Prefab 层级同步结果，供 Figma 面板展示。
    /// </summary>
    public sealed class FigmaPrefabHierarchySyncResult
    {
        public bool ok;
        public bool dryRun;
        public string prefabPath;
        public string backupPath;
        public FigmaPrefabHierarchySyncSummary summary = new FigmaPrefabHierarchySyncSummary();
        public readonly List<string> warnings = new List<string>();
        public readonly List<string> errors = new List<string>();
        public readonly List<string> created = new List<string>();
        public readonly List<string> deleted = new List<string>();
        public readonly List<string> moved = new List<string>();
        public readonly List<string> rectChanged = new List<string>();
        public readonly List<string> fontSizeChanged = new List<string>();
        public readonly List<string> imageChanged = new List<string>();
        public readonly List<string> skipped = new List<string>();

        /// <summary>
        /// 将同步结果序列化为面板可读取的 JSON。
        /// </summary>
        public string ToJson()
        {
            var sb = new StringBuilder(512);
            sb.Append("{");
            sb.AppendFormat("\"ok\":{0},", ok ? "true" : "false");
            sb.AppendFormat("\"dryRun\":{0},", dryRun ? "true" : "false");
            sb.AppendFormat("\"prefabPath\":\"{0}\",", Escape(prefabPath));
            sb.AppendFormat("\"backupPath\":\"{0}\",", Escape(backupPath));
            sb.Append("\"summary\":{");
            sb.AppendFormat("\"matched\":{0},", summary.matched);
            sb.AppendFormat("\"created\":{0},", summary.created);
            sb.AppendFormat("\"deleted\":{0},", summary.deleted);
            sb.AppendFormat("\"moved\":{0},", summary.moved);
            sb.AppendFormat("\"rectChanged\":{0},", summary.rectChanged);
            sb.AppendFormat("\"fontSizeChanged\":{0},", summary.fontSizeChanged);
            sb.AppendFormat("\"imageChanged\":{0}", summary.imageChanged);
            sb.Append("},");
            AppendArray(sb, "warnings", warnings);
            sb.Append(",");
            AppendArray(sb, "errors", errors);
            sb.Append(",");
            AppendArray(sb, "created", created);
            sb.Append(",");
            AppendArray(sb, "deleted", deleted);
            sb.Append(",");
            AppendArray(sb, "moved", moved);
            sb.Append(",");
            AppendArray(sb, "rectChanged", rectChanged);
            sb.Append(",");
            AppendArray(sb, "fontSizeChanged", fontSizeChanged);
            sb.Append(",");
            AppendArray(sb, "imageChanged", imageChanged);
            sb.Append(",");
            AppendArray(sb, "skipped", skipped);
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// 追加字符串数组字段。
        /// </summary>
        private static void AppendArray(StringBuilder sb, string fieldName, List<string> values)
        {
            sb.AppendFormat("\"{0}\":[", fieldName);
            for (int i = 0; i < values.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(",");
                }

                sb.AppendFormat("\"{0}\"", Escape(values[i]));
            }

            sb.Append("]");
        }

        /// <summary>
        /// 转义 JSON 字符串值。
        /// </summary>
        private static string Escape(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
        }
    }

    /// <summary>
    /// Prefab 层级同步统计信息。
    /// </summary>
    public sealed class FigmaPrefabHierarchySyncSummary
    {
        public int matched;
        public int created;
        public int deleted;
        public int moved;
        public int rectChanged;
        public int fontSizeChanged;
        public int imageChanged;
    }

    /// <summary>
    /// 将 Figma 层级确定性同步到当前选中的 Unity Prefab。
    /// </summary>
    public static class FigmaPrefabHierarchySyncUtility
    {
        private const float GeometryEpsilon = 0.01f;
        private const string BoundaryRootAsset = "RootAsset";
        private const string BoundaryNormalNode = "NormalNode";
        private const string BoundaryNestedPrefab = "NestedPrefabBoundary";
        private const string BoundaryNestedPrefabInternal = "NestedPrefabInternalOverride";

        /// <summary>
        /// 加载指定 Prefab，并按 Figma 层级执行同步后保存。
        /// </summary>
        public static FigmaPrefabHierarchySyncResult SyncSelectedPrefab(
            string prefabPath,
            FigmaPrefabHierarchyDocument document,
            bool syncImages,
            string imageTargetFolder,
            bool createBackup,
            bool dryRun)
        {
            var result = new FigmaPrefabHierarchySyncResult
            {
                dryRun = dryRun,
                prefabPath = prefabPath
            };

            ValidateInput(prefabPath, document, syncImages, imageTargetFolder, dryRun);
            GameObject prefabRoot = null;
            try
            {
                prefabRoot = PrefabUtility.LoadPrefabContents(prefabPath);
                var imageContext = syncImages
                    ? new ImageSyncContext(imageTargetFolder, dryRun, result)
                    : null;
                SyncLoadedPrefab(prefabRoot, document.root, imageContext, result);
                if (!dryRun && result.errors.Count == 0 && HasChanges(result))
                {
                    if (createBackup)
                    {
                        result.backupPath = BackupPrefab(prefabPath);
                    }
                    PrefabUtility.SaveAsPrefabAsset(prefabRoot, prefabPath);
                    AssetDatabase.ImportAsset(prefabPath, ImportAssetOptions.ForceUpdate);
                    if (imageContext != null && imageContext.ImportedAny)
                    {
                        AssetDatabase.Refresh();
                    }
                }

                result.ok = result.errors.Count == 0;
            }
            finally
            {
                if (prefabRoot != null)
                {
                    PrefabUtility.UnloadPrefabContents(prefabRoot);
                }
            }

            return result;
        }

        /// <summary>
        /// 校验同步输入，避免错误资源或空层级进入写入流程。
        /// </summary>
        private static void ValidateInput(
            string prefabPath,
            FigmaPrefabHierarchyDocument document,
            bool syncImages,
            string imageTargetFolder,
            bool dryRun)
        {
            if (string.IsNullOrEmpty(prefabPath)
                || !prefabPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("目标不是 Prefab 资源：" + prefabPath);
            }

            if (document == null || document.root == null)
            {
                throw new ArgumentException("Figma 层级数据为空");
            }

            if (AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath) == null)
            {
                throw new ArgumentException("目标 Prefab 不存在，层级同步只允许同步已有 Prefab：" + prefabPath);
            }

            if (syncImages && !dryRun)
            {
                if (string.IsNullOrEmpty(imageTargetFolder)
                    || !IsAssetsPath(imageTargetFolder)
                    || !AssetDatabase.IsValidFolder(imageTargetFolder))
                {
                    throw new ArgumentException("同步图片资源需要有效的 Assets 目标文件夹：" + imageTargetFolder);
                }
            }
        }

        /// <summary>
        /// 对已加载的 Prefab 根对象执行层级同步。
        /// </summary>
        private static void SyncLoadedPrefab(
            GameObject prefabRoot,
            FigmaPrefabHierarchyNode figmaRoot,
            ImageSyncContext imageContext,
            FigmaPrefabHierarchySyncResult result)
        {
            if (prefabRoot == null)
            {
                throw new ArgumentNullException(nameof(prefabRoot));
            }

            var rootRect = EnsureRectTransform(prefabRoot);
            if (!NamesEqual(prefabRoot.name, figmaRoot.name))
            {
                result.errors.Add($"根节点名称不一致，停止同步：Unity={prefabRoot.name}，Figma={figmaRoot.name}");
                return;
            }

            result.summary.matched++;
            ApplyFigmaBinding(rootRect.gameObject, figmaRoot);
            ApplyRootNodeState(rootRect, figmaRoot, result);
            ApplyFontSize(prefabRoot, figmaRoot, result);
            ApplyImage(prefabRoot, figmaRoot, imageContext, false, result);
            var figmaNodeIds = BuildFigmaNodeIdSet(figmaRoot);
            var movableNodesById = BuildReusableNodeIdMap(rootRect, result);
            var movableNodesByName = BuildReusableNodeNameMap(rootRect, result);
            var usedNodes = new HashSet<RectTransform>();
            var desiredChildrenByParent = new Dictionary<RectTransform, HashSet<RectTransform>>();
            var completeChildrenParents = new HashSet<RectTransform>();
            SyncChildren(
                rootRect,
                figmaRoot,
                movableNodesById,
                movableNodesByName,
                usedNodes,
                desiredChildrenByParent,
                completeChildrenParents,
                imageContext,
                false,
                result);
            DeleteExtraChildrenRecursive(rootRect, desiredChildrenByParent, completeChildrenParents, figmaNodeIds, false, result);
        }

        /// <summary>
        /// 判断本轮同步是否存在会写入 Prefab 或资源的实际变更。
        /// </summary>
        private static bool HasChanges(FigmaPrefabHierarchySyncResult result)
        {
            return result.summary.created > 0
                || result.summary.deleted > 0
                || result.summary.moved > 0
                || result.summary.rectChanged > 0
                || result.summary.fontSizeChanged > 0
                || result.summary.imageChanged > 0;
        }

        /// <summary>
        /// 在应用修改前复制 Prefab 作为回滚备份。
        /// </summary>
        private static string BackupPrefab(string prefabPath)
        {
            string prefabFolder = NormalizeUnityPath(Path.GetDirectoryName(prefabPath) ?? "Assets");
            string backupFolder = NormalizeUnityPath(Path.Combine(prefabFolder, "__FigmaBridgeBackup"));
            if (!AssetDatabase.IsValidFolder(backupFolder))
            {
                string guid = AssetDatabase.CreateFolder(prefabFolder, "__FigmaBridgeBackup");
                if (string.IsNullOrEmpty(guid) && !AssetDatabase.IsValidFolder(backupFolder))
                {
                    throw new IOException("创建 Prefab 备份目录失败：" + backupFolder);
                }
            }

            string prefabName = Path.GetFileNameWithoutExtension(prefabPath);
            string timestamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            string backupPath = NormalizeUnityPath(Path.Combine(backupFolder, $"{prefabName}_{timestamp}.prefab"));
            backupPath = AssetDatabase.GenerateUniqueAssetPath(backupPath);
            if (!AssetDatabase.CopyAsset(prefabPath, backupPath))
            {
                throw new IOException("复制 Prefab 备份失败：" + backupPath);
            }

            AssetDatabase.ImportAsset(backupPath, ImportAssetOptions.ForceUpdate);
            return backupPath;
        }

        /// <summary>
        /// 同步指定父节点的直接子节点集合，包含新建、删除、移动和顺序调整。
        /// </summary>
        private static void SyncChildren(
            RectTransform parent,
            FigmaPrefabHierarchyNode figmaParent,
            Dictionary<string, Queue<RectTransform>> movableNodesById,
            Dictionary<string, Queue<RectTransform>> movableNodesByName,
            HashSet<RectTransform> usedNodes,
            Dictionary<RectTransform, HashSet<RectTransform>> desiredChildrenByParent,
            HashSet<RectTransform> completeChildrenParents,
            ImageSyncContext imageContext,
            bool structureLocked,
            FigmaPrefabHierarchySyncResult result)
        {
            var desiredChildren = figmaParent.children ?? new List<FigmaPrefabHierarchyNode>();
            var existingById = BuildExistingChildrenIdMap(parent);
            var existingByName = BuildExistingChildrenNameMap(parent);
            var desiredRects = new HashSet<RectTransform>();
            var desiredOrder = new List<RectTransform>(desiredChildren.Count);
            bool currentStructureLocked = structureLocked || IsNestedPrefabBoundary(figmaParent);
            bool parentAllowsStructuralSync = !currentStructureLocked && AllowsStructuralSync(figmaParent);
            bool hasOrderChanged = false;
            desiredChildrenByParent[parent] = desiredRects;
            if (AllowsDeleteChildren(figmaParent))
            {
                completeChildrenParents.Add(parent);
            }

            for (int i = 0; i < desiredChildren.Count; i++)
            {
                var figmaChild = desiredChildren[i];
                string childName = SanitizeName(figmaChild.name, $"Node_{i}");

                RectTransform childRect;
                bool isNewNode = false;
                bool childAllowsReparent = parentAllowsStructuralSync && AllowsReparent(figmaChild);
                bool childAllowsCreate = parentAllowsStructuralSync && AllowsCreateChildUnder(figmaParent, figmaChild);
                if (TryTakeSameParentChildById(existingById, figmaChild.id, out childRect))
                {
                    usedNodes.Add(childRect);
                    result.summary.matched++;
                }
                else if (CanFallbackToSameParentName(figmaChild) && TryTakeSameParentChildByName(existingByName, childName, out childRect))
                {
                    usedNodes.Add(childRect);
                    result.summary.matched++;
                }
                else if (childAllowsReparent && TryTakeMovableNodeById(movableNodesById, usedNodes, figmaChild.id, parent, result, out childRect))
                {
                    result.summary.moved++;
                    result.summary.matched++;
                }
                else if (childAllowsReparent && CanFallbackToGlobalName(figmaChild) && TryTakeMovableNodeByName(movableNodesByName, usedNodes, childName, parent, result, out childRect))
                {
                    result.summary.moved++;
                    result.summary.matched++;
                }
                else if (childAllowsCreate)
                {
                    childRect = CreateChildNode(parent, figmaChild, imageContext, result);
                    isNewNode = true;
                    usedNodes.Add(childRect);
                    result.summary.created++;
                    result.created.Add(GetTransformPath(childRect));
                }
                else if (TryApplyNestedInternalProxyGeometry(parent, figmaParent, figmaChild, result))
                {
                    continue;
                }
                else
                {
                    string label = $"{BuildNodeLabel(figmaChild)}: 未找到稳定绑定，当前同步边界不允许新建或跨 Prefab 内部重建节点";
                    result.warnings.Add(label);
                    result.skipped.Add(label);
                    continue;
                }

                desiredRects.Add(childRect);
                desiredOrder.Add(childRect);
                if (HasFigmaOrderChanged(figmaChild))
                {
                    hasOrderChanged = true;
                }
                ApplyFigmaBinding(childRect.gameObject, figmaChild);
                if (isNewNode)
                {
                    ApplyNewNodeRect(childRect, figmaChild, parent, false, result);
                }
                else
                {
                    ApplyExistingNodeState(childRect, figmaChild, result);
                }

                ApplyFontSize(childRect.gameObject, figmaChild, result);
                ApplyImage(childRect.gameObject, figmaChild, imageContext, isNewNode, result);
                if (ShouldSyncChildren(figmaChild))
                {
                    SyncChildren(
                        childRect,
                        figmaChild,
                        movableNodesById,
                        movableNodesByName,
                        usedNodes,
                        desiredChildrenByParent,
                        completeChildrenParents,
                        imageContext,
                        currentStructureLocked,
                        result);
                }
            }

            if (hasOrderChanged && parentAllowsStructuralSync)
            {
                ApplyRelativeSiblingOrder(parent, desiredOrder, result);
            }
        }

        /// <summary>
        /// 建立同步根下可复用节点的全局名称索引，用于跨父级移动时保留原组件和引用。
        /// </summary>
        private static Dictionary<string, RectTransform> BuildMovableNodeMap(
            RectTransform root,
            FigmaPrefabHierarchySyncResult result)
        {
            var map = new Dictionary<string, RectTransform>(StringComparer.Ordinal);
            var duplicated = new HashSet<string>(StringComparer.Ordinal);
            CollectMovableNodes(root, map, duplicated);
            foreach (string name in duplicated)
            {
                result.warnings.Add($"存在重名 Unity 节点，跨父级移动不会自动复用：{name}");
                map.Remove(name);
            }

            return map;
        }

        /// <summary>
        /// 递归收集同步根下的 RectTransform 节点；根节点自身不参与跨父级移动。
        /// </summary>
        private static void CollectMovableNodes(
            RectTransform current,
            Dictionary<string, RectTransform> map,
            HashSet<string> duplicated)
        {
            for (int i = 0; i < current.childCount; i++)
            {
                if (!(current.GetChild(i) is RectTransform child))
                {
                    continue;
                }

                if (map.ContainsKey(child.name))
                {
                    duplicated.Add(child.name);
                }
                else if (!duplicated.Contains(child.name))
                {
                    map.Add(child.name, child);
                }

                CollectMovableNodes(child, map, duplicated);
            }
        }

        /// <summary>
        /// 从全局可移动节点表中取出同名节点，并移动到新的父节点下。
        /// </summary>
        private static bool TryTakeMovableNodeById(
            Dictionary<string, Queue<RectTransform>> movableNodes,
            HashSet<RectTransform> usedNodes,
            string figmaNodeId,
            RectTransform targetParent,
            FigmaPrefabHierarchySyncResult result,
            out RectTransform childRect)
        {
            if (string.IsNullOrEmpty(figmaNodeId))
            {
                childRect = null;
                return false;
            }

            return TryTakeMovableNode(movableNodes, usedNodes, figmaNodeId, targetParent, result, out childRect);
        }

        private static bool TryTakeMovableNodeByName(
            Dictionary<string, Queue<RectTransform>> movableNodes,
            HashSet<RectTransform> usedNodes,
            string childName,
            RectTransform targetParent,
            FigmaPrefabHierarchySyncResult result,
            out RectTransform childRect)
        {
            return TryTakeMovableNode(movableNodes, usedNodes, childName, targetParent, result, out childRect);
        }

        private static bool TryTakeMovableNode(
            Dictionary<string, Queue<RectTransform>> movableNodes,
            HashSet<RectTransform> usedNodes,
            string key,
            RectTransform targetParent,
            FigmaPrefabHierarchySyncResult result,
            out RectTransform childRect)
        {
            Queue<RectTransform> queue;
            if (string.IsNullOrEmpty(key) || !movableNodes.TryGetValue(key, out queue))
            {
                childRect = null;
                return false;
            }

            while (queue.Count > 0)
            {
                childRect = queue.Dequeue();
                if (childRect == null || usedNodes.Contains(childRect))
                {
                    continue;
                }

                if (childRect == targetParent || IsAncestorOf(childRect, targetParent))
                {
                    result.skipped.Add($"{GetTransformPath(childRect)}: skip moving ancestor node");
                    continue;
                }

                usedNodes.Add(childRect);
                string oldPath = GetTransformPath(childRect);
                childRect.SetParent(targetParent, false);
                result.moved.Add($"{oldPath} -> {GetTransformPath(childRect)}");
                return true;
            }

            movableNodes.Remove(key);
            childRect = null;
            return false;
        }

        /// <summary>
        /// 建立当前父节点直接子级的名称索引；重名时只使用第一个并保留警告。
        /// </summary>
        private static Dictionary<string, Queue<RectTransform>> BuildExistingChildrenIdMap(RectTransform parent)
        {
            var map = new Dictionary<string, Queue<RectTransform>>(StringComparer.Ordinal);
            for (int i = 0; i < parent.childCount; i++)
            {
                if (parent.GetChild(i) is RectTransform child)
                {
                    AddNodeByFigmaId(map, child, null);
                }
            }

            return map;
        }

        private static Dictionary<string, Queue<RectTransform>> BuildExistingChildrenNameMap(RectTransform parent)
        {
            var map = new Dictionary<string, Queue<RectTransform>>(StringComparer.Ordinal);
            for (int i = 0; i < parent.childCount; i++)
            {
                if (!(parent.GetChild(i) is RectTransform child))
                {
                    continue;
                }

                if (HasFigmaBinding(child))
                {
                    continue;
                }

                Queue<RectTransform> queue;
                if (!map.TryGetValue(child.name, out queue))
                {
                    queue = new Queue<RectTransform>();
                    map.Add(child.name, queue);
                }

                queue.Enqueue(child);
            }

            return map;
        }

        /// <summary>
        /// 从同父级候选队列中按名称取出一个节点，支持同名兄弟节点顺序匹配。
        /// </summary>
        /// <summary>
        /// 建立 Figma 全局节点名称集合，删除 Unity 节点前用它确认节点是否真的不存在。
        /// </summary>
        private static HashSet<string> BuildFigmaNodeIdSet(FigmaPrefabHierarchyNode root)
        {
            var ids = new HashSet<string>(StringComparer.Ordinal);
            CollectFigmaNodeIds(root, ids);
            return ids;
        }

        /// <summary>
        /// 递归收集 Figma 节点名称，名称统一走同步时的清理规则。
        /// </summary>
        private static void CollectFigmaNodeIds(FigmaPrefabHierarchyNode node, HashSet<string> ids)
        {
            if (node == null)
            {
                return;
            }

            if (!string.IsNullOrEmpty(node.id))
            {
                ids.Add(node.id);
            }

            var children = node.children;
            if (children == null)
            {
                return;
            }

            for (int i = 0; i < children.Count; i++)
            {
                CollectFigmaNodeIds(children[i], ids);
            }
        }

        /// <summary>
        /// 建立同步根下可复用节点的全局名称索引；同名节点按遍历顺序入队，优先复用旧组件和引用。
        /// </summary>
        private static Dictionary<string, Queue<RectTransform>> BuildReusableNodeIdMap(
            RectTransform root,
            FigmaPrefabHierarchySyncResult result)
        {
            var map = new Dictionary<string, Queue<RectTransform>>(StringComparer.Ordinal);
            var duplicated = new HashSet<string>(StringComparer.Ordinal);
            CollectReusableNodesById(root, map, duplicated);
            foreach (string id in duplicated)
            {
                result.warnings.Add($"存在重复 Figma 绑定 ID，将按层级遍历顺序复用：{id}");
            }

            return map;
        }

        private static Dictionary<string, Queue<RectTransform>> BuildReusableNodeNameMap(
            RectTransform root,
            FigmaPrefabHierarchySyncResult result)
        {
            var map = new Dictionary<string, Queue<RectTransform>>(StringComparer.Ordinal);
            var duplicated = new HashSet<string>(StringComparer.Ordinal);
            CollectReusableNodesByName(root, map, duplicated);
            foreach (string name in duplicated)
            {
                result.warnings.Add($"存在重名 Unity 节点，将按层级遍历顺序复用：{name}");
            }

            return map;
        }

        private static void CollectReusableNodesById(
            RectTransform current,
            Dictionary<string, Queue<RectTransform>> map,
            HashSet<string> duplicated)
        {
            for (int i = 0; i < current.childCount; i++)
            {
                if (current.GetChild(i) is RectTransform child)
                {
                    AddNodeByFigmaId(map, child, duplicated);
                    if (HasNestedPrefabBoundaryBinding(child))
                    {
                        continue;
                    }

                    CollectReusableNodesById(child, map, duplicated);
                }
            }
        }

        /// <summary>
        /// 递归收集同步根下的 RectTransform 节点；根节点自身不参与跨父级移动。
        /// </summary>
        private static void CollectReusableNodesByName(
            RectTransform current,
            Dictionary<string, Queue<RectTransform>> map,
            HashSet<string> duplicated)
        {
            for (int i = 0; i < current.childCount; i++)
            {
                if (!(current.GetChild(i) is RectTransform child))
                {
                    continue;
                }

                if (HasFigmaBinding(child))
                {
                    continue;
                }

                if (HasNestedPrefabBoundaryBinding(child))
                {
                    continue;
                }

                Queue<RectTransform> queue;
                if (!map.TryGetValue(child.name, out queue))
                {
                    queue = new Queue<RectTransform>();
                    map.Add(child.name, queue);
                }
                else
                {
                    duplicated.Add(child.name);
                }

                queue.Enqueue(child);
                CollectReusableNodesByName(child, map, duplicated);
            }
        }

        private static void AddNodeByFigmaId(
            Dictionary<string, Queue<RectTransform>> map,
            RectTransform child,
            HashSet<string> duplicated)
        {
            var binding = child.GetComponent<FigmaPrefabNodeBinding>();
            if (binding == null || string.IsNullOrEmpty(binding.FigmaNodeId))
            {
                return;
            }

            Queue<RectTransform> queue;
            if (!map.TryGetValue(binding.FigmaNodeId, out queue))
            {
                queue = new Queue<RectTransform>();
                map.Add(binding.FigmaNodeId, queue);
            }
            else if (duplicated != null)
            {
                duplicated.Add(binding.FigmaNodeId);
            }

            queue.Enqueue(child);
        }

        private static bool HasFigmaBinding(RectTransform child)
        {
            var binding = child != null ? child.GetComponent<FigmaPrefabNodeBinding>() : null;
            return binding != null && !string.IsNullOrEmpty(binding.FigmaNodeId);
        }

        private static bool HasNestedPrefabBoundaryBinding(RectTransform child)
        {
            var binding = child != null ? child.GetComponent<FigmaPrefabNodeBinding>() : null;
            if (binding == null)
            {
                return false;
            }

            return string.Equals(binding.SyncBoundaryKind, BoundaryNestedPrefab, StringComparison.Ordinal)
                || string.Equals(binding.SyncBoundaryKind, BoundaryNestedPrefabInternal, StringComparison.Ordinal);
        }

        private static bool HasFigmaOrderChanged(FigmaPrefabHierarchyNode figmaNode)
        {
            return figmaNode != null
                && figmaNode.hasOrderBaseline
                && figmaNode.figmaSiblingIndex != figmaNode.orderBaselineSiblingIndex;
        }

        private static bool AllowsStructuralSync(FigmaPrefabHierarchyNode figmaNode)
        {
            return figmaNode != null
                && IsFullSyncBoundary(figmaNode)
                && figmaNode.childrenComplete;
        }

        private static bool AllowsCreateChildUnder(FigmaPrefabHierarchyNode figmaParent, FigmaPrefabHierarchyNode figmaChild)
        {
            return figmaParent != null
                && figmaChild != null
                && AllowsStructuralSync(figmaParent)
                && figmaParent.allowCreateChildren
                && IsFullSyncBoundary(figmaChild);
        }

        private static bool AllowsDeleteChildren(FigmaPrefabHierarchyNode figmaNode)
        {
            return figmaNode != null
                && figmaNode.allowDeleteChildren
                && AllowsStructuralSync(figmaNode);
        }

        private static bool AllowsReparent(FigmaPrefabHierarchyNode figmaNode)
        {
            return figmaNode != null
                && figmaNode.allowReparent
                && IsFullSyncBoundary(figmaNode);
        }

        private static bool ShouldSyncChildren(FigmaPrefabHierarchyNode figmaNode)
        {
            return AllowsStructuralSync(figmaNode)
                || IsNestedPrefabInternalBoundary(figmaNode);
        }

        private static bool CanFallbackToGlobalName(FigmaPrefabHierarchyNode figmaNode)
        {
            return figmaNode != null
                && IsFullSyncBoundary(figmaNode)
                && string.IsNullOrEmpty(figmaNode.sourcePrefabGuid)
                && string.IsNullOrEmpty(figmaNode.sourcePrefabPath);
        }

        private static bool CanFallbackToSameParentName(FigmaPrefabHierarchyNode figmaNode)
        {
            return figmaNode != null
                && (IsFullSyncBoundary(figmaNode)
                    || IsNestedPrefabBoundary(figmaNode)
                    || IsNestedPrefabInternalBoundary(figmaNode));
        }

        private static bool IsFullSyncBoundary(FigmaPrefabHierarchyNode figmaNode)
        {
            string kind = GetBoundaryKind(figmaNode);
            return string.Equals(kind, BoundaryNormalNode, StringComparison.Ordinal)
                || string.Equals(kind, BoundaryRootAsset, StringComparison.Ordinal);
        }

        private static bool IsNestedPrefabBoundary(FigmaPrefabHierarchyNode figmaNode)
        {
            string kind = GetBoundaryKind(figmaNode);
            return string.Equals(kind, BoundaryNestedPrefab, StringComparison.Ordinal)
                || string.Equals(kind, BoundaryNestedPrefabInternal, StringComparison.Ordinal);
        }

        private static bool IsNestedPrefabInternalBoundary(FigmaPrefabHierarchyNode figmaNode)
        {
            return string.Equals(GetBoundaryKind(figmaNode), BoundaryNestedPrefabInternal, StringComparison.Ordinal);
        }

        private static string GetBoundaryKind(FigmaPrefabHierarchyNode figmaNode)
        {
            if (figmaNode == null)
            {
                return BoundaryNormalNode;
            }

            return string.IsNullOrEmpty(figmaNode.syncBoundaryKind)
                ? BoundaryNormalNode
                : figmaNode.syncBoundaryKind;
        }

        /// <summary>
        /// 判断 candidate 是否是 target 的祖先，用于避免形成 Transform 循环。
        /// </summary>
        private static bool IsAncestorOf(Transform candidate, Transform target)
        {
            Transform current = target;
            while (current != null)
            {
                if (current == candidate)
                {
                    return true;
                }

                current = current.parent;
            }

            return false;
        }

        private static bool TryTakeSameParentChildById(
            Dictionary<string, Queue<RectTransform>> existingById,
            string figmaNodeId,
            out RectTransform childRect)
        {
            if (string.IsNullOrEmpty(figmaNodeId))
            {
                childRect = null;
                return false;
            }

            return TryTakeQueuedNode(existingById, figmaNodeId, out childRect);
        }

        private static bool TryTakeSameParentChildByName(
            Dictionary<string, Queue<RectTransform>> existingByName,
            string childName,
            out RectTransform childRect)
        {
            return TryTakeQueuedNode(existingByName, childName, out childRect);
        }

        private static bool TryTakeQueuedNode(
            Dictionary<string, Queue<RectTransform>> map,
            string key,
            out RectTransform childRect)
        {
            Queue<RectTransform> queue;
            if (string.IsNullOrEmpty(key) || !map.TryGetValue(key, out queue) || queue.Count == 0)
            {
                childRect = null;
                return false;
            }

            childRect = queue.Dequeue();
            return childRect != null;
        }

        /// <summary>
        /// 嵌套 Prefab 内部不允许改层级；当 Figma 多了一层视觉包装时，仅把子节点几何投影到 Unity 现有同名兄弟节点。
        /// </summary>
        private static bool TryApplyNestedInternalProxyGeometry(
            RectTransform parent,
            FigmaPrefabHierarchyNode figmaParent,
            FigmaPrefabHierarchyNode figmaChild,
            FigmaPrefabHierarchySyncResult result)
        {
            if (parent == null
                || parent.parent == null
                || figmaParent == null
                || figmaChild == null
                || !IsNestedPrefabInternalBoundary(figmaParent)
                || !IsNestedPrefabInternalBoundary(figmaChild)
                || !figmaChild.hasGeometryBaseline
                || !figmaChild.geometryChangedFromBaseline)
            {
                return false;
            }

            string childName = SanitizeName(figmaChild.name, string.Empty);
            if (string.IsNullOrEmpty(childName))
            {
                return false;
            }

            var ancestor = parent.parent as RectTransform;
            if (ancestor == null)
            {
                return false;
            }

            RectTransform candidate = null;
            for (int i = 0; i < ancestor.childCount; i++)
            {
                var sibling = ancestor.GetChild(i) as RectTransform;
                if (sibling == null || sibling == parent || sibling.name != childName)
                {
                    continue;
                }

                candidate = sibling;
                break;
            }

            if (candidate == null)
            {
                return false;
            }

            var projectedNode = new FigmaPrefabHierarchyNode
            {
                id = figmaChild.id,
                name = figmaChild.name,
                path = figmaChild.path,
                width = figmaChild.width,
                height = figmaChild.height,
                rotation = figmaChild.rotation,
                constraints = figmaChild.constraints,
                visible = figmaChild.visible,
                x = figmaParent.x + figmaChild.x,
                y = figmaParent.y + figmaChild.y
            };

            bool changed = ApplyNodeRect(candidate, projectedNode, ancestor, false);
            if (candidate.gameObject.activeSelf != figmaChild.visible)
            {
                candidate.gameObject.SetActive(figmaChild.visible);
                changed = true;
            }

            if (changed)
            {
                result.summary.rectChanged++;
                result.rectChanged.Add($"{BuildNodeLabel(figmaChild)} -> {GetTransformPath(candidate)}");
            }

            return true;
        }

        /// <summary>
        /// 创建 Figma 中存在但 Unity 当前父节点下不存在的 RectTransform 节点。
        /// </summary>
        private static RectTransform CreateChildNode(
            RectTransform parent,
            FigmaPrefabHierarchyNode figmaNode,
            ImageSyncContext imageContext,
            FigmaPrefabHierarchySyncResult result)
        {
            var go = new GameObject(SanitizeName(figmaNode.name, "Node"), typeof(RectTransform));
            go.layer = parent.gameObject.layer;
            if (figmaNode.hasImage && imageContext != null)
            {
                go.AddComponent<Image>();
            }
            else if (figmaNode.hasImage)
            {
                string label = $"{BuildNodeLabel(figmaNode)}: Figma has image but image sync is disabled, new node has no Sprite";
                result.warnings.Add(label);
                result.skipped.Add(label);
            }

            var rectTransform = go.GetComponent<RectTransform>();
            rectTransform.SetParent(parent, false);
            return rectTransform;
        }

        /// <summary>
        /// 确保 Unity 节点记录对应的 Figma 节点 ID，后续同步可按 ID 复用和删除。
        /// </summary>
        private static void ApplyFigmaBinding(GameObject gameObject, FigmaPrefabHierarchyNode figmaNode)
        {
            if (gameObject == null || figmaNode == null)
            {
                return;
            }

            var binding = gameObject.GetComponent<FigmaPrefabNodeBinding >();            if (binding == null)
            {
                binding = gameObject.AddComponent<FigmaPrefabNodeBinding>();
            }

            binding.SetFigmaNode(
                figmaNode.id,
                figmaNode.path,
                figmaNode.name,
                figmaNode.structuralPath,
                figmaNode.sourcePrefabGuid,
                figmaNode.sourcePrefabPath,
                GetBoundaryKind(figmaNode));
        }

        /// <summary>
        /// 删除 Unity 中存在但 Figma 当前父节点下不存在的直接子节点。
        /// </summary>
        private static void DeleteExtraChildren(
            RectTransform parent,
            HashSet<RectTransform> desiredChildren,
            HashSet<string> figmaNodeIds,
            FigmaPrefabHierarchySyncResult result)
        {
            for (int i = parent.childCount - 1; i >= 0; i--)
            {
                var child = parent.GetChild(i) as RectTransform;
                if (child != null && desiredChildren.Contains(child))
                {
                    continue;
                }

                if (!IsRemovedFigmaManagedNode(child, figmaNodeIds))
                {
                    string skippedPath = GetTransformPath(child);
                    string label = $"{skippedPath}: 未发现已删除的 Figma 绑定，保留 Unity 手工节点";
                    result.warnings.Add(label);
                    result.skipped.Add(label);
                    continue;
                }

                string deletedPath = GetTransformPath(child);
                UnityEngine.Object.DestroyImmediate(parent.GetChild(i).gameObject);
                result.summary.deleted++;
                result.deleted.Add(deletedPath);
            }
        }

        /// <summary>
        /// 在所有节点移动完成后，自底向上删除最终不属于 Figma 层级的多余子节点。
        /// </summary>
        private static void DeleteExtraChildrenRecursive(
            RectTransform parent,
            Dictionary<RectTransform, HashSet<RectTransform>> desiredChildrenByParent,
            HashSet<RectTransform> completeChildrenParents,
            HashSet<string> figmaNodeIds,
            bool structureLocked,
            FigmaPrefabHierarchySyncResult result)
        {
            bool currentStructureLocked = structureLocked || HasNestedPrefabBoundaryBinding(parent);
            for (int i = parent.childCount - 1; i >= 0; i--)
            {
                if (parent.GetChild(i) is RectTransform child)
                {
                    DeleteExtraChildrenRecursive(child, desiredChildrenByParent, completeChildrenParents, figmaNodeIds, currentStructureLocked, result);
                }
            }

            HashSet<RectTransform> desiredChildren;
            if (!currentStructureLocked
                && completeChildrenParents.Contains(parent)
                && desiredChildrenByParent.TryGetValue(parent, out desiredChildren))
            {
                DeleteExtraChildren(parent, desiredChildren, figmaNodeIds, result);
            }
        }

        /// <summary>
        /// 判断 Unity 子树中是否仍有名称存在于 Figma 全局节点集合。
        /// </summary>
        private static bool IsRemovedFigmaManagedNode(RectTransform root, HashSet<string> figmaNodeIds)
        {
            if (root == null)
            {
                return false;
            }

            var binding = root.GetComponent<FigmaPrefabNodeBinding>();
            if (binding != null && !string.IsNullOrEmpty(binding.FigmaNodeId))
            {
                return figmaNodeIds == null || !figmaNodeIds.Contains(binding.FigmaNodeId);
            }

            return false;
        }

        /// <summary>
        /// 只同步本轮 Figma 层级中参与匹配的兄弟节点相对顺序，避免未导出/被过滤节点造成绝对 siblingIndex 误报。
        /// </summary>
        private static void ApplyRelativeSiblingOrder(
            RectTransform parent,
            List<RectTransform> desiredOrder,
            FigmaPrefabHierarchySyncResult result)
        {
            if (parent == null || desiredOrder == null || desiredOrder.Count <= 1)
            {
                return;
            }

            var uniqueDesired = new List<RectTransform>(desiredOrder.Count);
            var seen = new HashSet<RectTransform>();
            for (int i = 0; i < desiredOrder.Count; i++)
            {
                var child = desiredOrder[i];
                if (child == null || child.parent != parent || !seen.Add(child))
                {
                    continue;
                }

                uniqueDesired.Add(child);
            }

            if (uniqueDesired.Count <= 1)
            {
                return;
            }

            var currentOrder = new List<RectTransform>(uniqueDesired);
            currentOrder.Sort((a, b) => a.GetSiblingIndex().CompareTo(b.GetSiblingIndex()));
            if (SequenceEqual(currentOrder, uniqueDesired))
            {
                return;
            }

            var slots = new List<int>(currentOrder.Count);
            for (int i = 0; i < currentOrder.Count; i++)
            {
                slots.Add(currentOrder[i].GetSiblingIndex());
            }

            slots.Sort();
            var changes = new List<string>();
            for (int i = 0; i < uniqueDesired.Count; i++)
            {
                var child = uniqueDesired[i];
                int desiredIndex = slots[i];
                if (child.GetSiblingIndex() == desiredIndex)
                {
                    continue;
                }

                int oldIndex = child.GetSiblingIndex();
                child.SetSiblingIndex(desiredIndex);
                changes.Add($"{GetTransformPath(child)} siblingIndex {oldIndex} -> {desiredIndex}");
            }

            if (changes.Count == 0)
            {
                return;
            }

            result.summary.moved += changes.Count;
            result.moved.AddRange(changes);
        }

        private static bool SequenceEqual(List<RectTransform> left, List<RectTransform> right)
        {
            if (left == null || right == null || left.Count != right.Count)
            {
                return false;
            }

            for (int i = 0; i < left.Count; i++)
            {
                if (left[i] != right[i])
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// 应用 RectTransform 坐标、尺寸和旋转；不写入图片、字体或材质引用。
        /// </summary>
        private static void ApplyNewNodeRect(
            RectTransform rectTransform,
            FigmaPrefabHierarchyNode figmaNode,
            RectTransform parent,
            bool isRoot,
            FigmaPrefabHierarchySyncResult result)
        {
            bool changed = ApplyNodeRect(rectTransform, figmaNode, parent, isRoot);
            if (rectTransform.gameObject.activeSelf != figmaNode.visible)
            {
                rectTransform.gameObject.SetActive(figmaNode.visible);
                changed = true;
            }

            if (changed)
            {
                result.summary.rectChanged++;
                result.rectChanged.Add(BuildNodeLabel(figmaNode));
            }
        }

        /// <summary>
        /// 已存在节点只在 Figma 几何相对基线变化后同步坐标，避免导入时布局差异造成误报。
        /// </summary>
        private static void ApplyExistingNodeState(
            RectTransform rectTransform,
            FigmaPrefabHierarchyNode figmaNode,
            FigmaPrefabHierarchySyncResult result)
        {
            bool changed = false;
            if (figmaNode.hasGeometryBaseline && figmaNode.geometryChangedFromBaseline)
            {
                changed |= ApplyNodeRect(rectTransform, figmaNode, rectTransform.parent as RectTransform, false);
            }

            if (rectTransform.gameObject.activeSelf != figmaNode.visible)
            {
                rectTransform.gameObject.SetActive(figmaNode.visible);
                changed = true;
            }

            if (changed)
            {
                result.summary.rectChanged++;
                result.rectChanged.Add(BuildNodeLabel(figmaNode));
            }
        }

        /// <summary>
        /// 根节点代表 Prefab 资产本身；Figma 画布坐标不应回写为 Prefab 根 RectTransform 坐标。
        /// </summary>
        private static void ApplyRootNodeState(
            RectTransform rectTransform,
            FigmaPrefabHierarchyNode figmaNode,
            FigmaPrefabHierarchySyncResult result)
        {
            if (rectTransform.gameObject.activeSelf == figmaNode.visible)
            {
                return;
            }

            rectTransform.gameObject.SetActive(figmaNode.visible);
            result.summary.rectChanged++;
            result.rectChanged.Add($"{BuildNodeLabel(figmaNode)}: activeSelf");
        }

        private static bool ApplyNodeRect(
            RectTransform rectTransform,
            FigmaPrefabHierarchyNode figmaNode,
            RectTransform parent,
            bool isRoot)
        {
            Vector2 targetSize = new Vector2(Mathf.Max(0f, figmaNode.width), Mathf.Max(0f, figmaNode.height));
            Vector2 targetAnchorMin = ResolveAnchorMin(figmaNode.constraints);
            Vector2 targetAnchorMax = ResolveAnchorMax(figmaNode.constraints, targetAnchorMin);
            Vector2 targetPivot = new Vector2(0.5f, 0.5f);
            Vector2 targetAnchored = isRoot
                ? Vector2.zero
                : FigmaLocalToAnchoredPosition(figmaNode, parent, targetAnchorMin, targetAnchorMax, targetPivot);
            Vector3 targetEuler = new Vector3(0f, 0f, -figmaNode.rotation);

            bool changed = false;
            changed |= SetVector2IfDifferent(() => rectTransform.anchorMin, v => rectTransform.anchorMin = v, targetAnchorMin);
            changed |= SetVector2IfDifferent(() => rectTransform.anchorMax, v => rectTransform.anchorMax = v, targetAnchorMax);
            changed |= SetVector2IfDifferent(() => rectTransform.pivot, v => rectTransform.pivot = v, targetPivot);
            changed |= SetVector2IfDifferent(() => rectTransform.sizeDelta, v => rectTransform.sizeDelta = v, ResolveSizeDelta(figmaNode, parent, targetAnchorMin, targetAnchorMax, targetSize));
            changed |= SetVector2IfDifferent(() => rectTransform.anchoredPosition, v => rectTransform.anchoredPosition = v, targetAnchored);
            if (!Approximately(rectTransform.localEulerAngles.z, targetEuler.z))
            {
                rectTransform.localEulerAngles = targetEuler;
                changed = true;
            }

            return changed;
        }

        /// <summary>
        /// 将 Figma 父内左上角坐标转换为中心锚点 RectTransform 的 anchoredPosition。
        /// </summary>
        private static Vector2 FigmaLocalToAnchoredPosition(
            FigmaPrefabHierarchyNode figmaNode,
            RectTransform parent,
            Vector2 anchorMin,
            Vector2 anchorMax,
            Vector2 pivot)
        {
            float parentWidth = parent != null ? parent.rect.width : 0f;
            float parentHeight = parent != null ? parent.rect.height : 0f;
            float spanWidth = (anchorMax.x - anchorMin.x) * parentWidth;
            float spanHeight = (anchorMax.y - anchorMin.y) * parentHeight;
            float pivotX = figmaNode.x + figmaNode.width * pivot.x;
            float pivotY = parentHeight - figmaNode.y - figmaNode.height * (1f - pivot.y);
            float x = pivotX - anchorMin.x * parentWidth - spanWidth * pivot.x;
            float y = pivotY - anchorMin.y * parentHeight - spanHeight * pivot.y;
            return new Vector2(x, y);
        }

        private static Vector2 ResolveSizeDelta(
            FigmaPrefabHierarchyNode figmaNode,
            RectTransform parent,
            Vector2 anchorMin,
            Vector2 anchorMax,
            Vector2 targetSize)
        {
            float parentWidth = parent != null ? parent.rect.width : 0f;
            float parentHeight = parent != null ? parent.rect.height : 0f;
            return new Vector2(
                targetSize.x - (anchorMax.x - anchorMin.x) * parentWidth,
                targetSize.y - (anchorMax.y - anchorMin.y) * parentHeight);
        }

        private static Vector2 ResolveAnchorMin(FigmaPrefabHierarchyConstraints constraints)
        {
            return new Vector2(
                ResolveHorizontalAnchor(constraints != null ? constraints.horizontal : null, true),
                ResolveVerticalAnchor(constraints != null ? constraints.vertical : null, true));
        }

        private static Vector2 ResolveAnchorMax(FigmaPrefabHierarchyConstraints constraints, Vector2 anchorMin)
        {
            return new Vector2(
                ResolveHorizontalAnchor(constraints != null ? constraints.horizontal : null, false),
                ResolveVerticalAnchor(constraints != null ? constraints.vertical : null, false));
        }

        private static float ResolveHorizontalAnchor(string value, bool min)
        {
            switch (NormalizeConstraint(value))
            {
                case "MIN": return 0f;
                case "MAX": return 1f;
                case "STRETCH": return min ? 0f : 1f;
                default: return 0.5f;
            }
        }

        private static float ResolveVerticalAnchor(string value, bool min)
        {
            switch (NormalizeConstraint(value))
            {
                case "MIN": return 1f;
                case "MAX": return 0f;
                case "STRETCH": return min ? 0f : 1f;
                default: return 0.5f;
            }
        }

        private static string NormalizeConstraint(string value)
        {
            return string.IsNullOrEmpty(value) ? "CENTER" : value.Trim().ToUpperInvariant();
        }

        /// <summary>
        /// 若目标是文本节点，只同步字号，不替换 FontAsset 或材质。
        /// </summary>
        private static void ApplyFontSize(
            GameObject gameObject,
            FigmaPrefabHierarchyNode figmaNode,
            FigmaPrefabHierarchySyncResult result)
        {
            if (!figmaNode.hasText || figmaNode.fontSize <= 0f)
            {
                return;
            }

            var text = gameObject.GetComponent<TMP_Text>();
            if (text == null)
            {
                text = gameObject.GetComponentInChildren<TMP_Text>(true);
            }

            if (text == null || Approximately(text.fontSize, figmaNode.fontSize))
            {
                return;
            }

            text.fontSize = figmaNode.fontSize;
            result.summary.fontSizeChanged++;
            result.fontSizeChanged.Add(BuildNodeLabel(figmaNode));
        }

        /// <summary>
        /// 若开启图片同步且节点已有 Image 组件，则导入 PNG 并替换 Sprite；不修改材质或其它组件。
        /// </summary>
        private static void ApplyImage(
            GameObject gameObject,
            FigmaPrefabHierarchyNode figmaNode,
            ImageSyncContext imageContext,
            bool isNewNode,
            FigmaPrefabHierarchySyncResult result)
        {
            if (IsNestedPrefabBoundary(figmaNode))
            {
                return;
            }

            if (imageContext == null || !figmaNode.hasImage || figmaNode.image == null)
            {
                return;
            }

            var image = gameObject.GetComponent<Image>();
            if (image == null)
            {
                string label = $"{BuildNodeLabel(figmaNode)}: Figma 有图片，但 Unity 节点没有 Image 组件，已跳过 Sprite 替换";
                result.warnings.Add(label);
                result.skipped.Add(label);
                return;
            }

            if (!isNewNode)
            {
                string label = $"{BuildNodeLabel(figmaNode)}: existing Image.sprite kept";
                result.skipped.Add(label);
                return;
            }

            if (imageContext.DryRun)
            {
                result.summary.imageChanged++;
                result.imageChanged.Add(BuildNodeLabel(figmaNode));
                return;
            }

            Sprite sprite = imageContext.GetOrImportSprite(figmaNode.image, result);
            if (sprite == null)
            {
                return;
            }

            if (image.sprite == sprite)
            {
                return;
            }

            image.sprite = sprite;
            result.summary.imageChanged++;
            result.imageChanged.Add(BuildNodeLabel(figmaNode));
        }

        /// <summary>
        /// 构建错误提示中的 Figma 节点标签。
        /// </summary>
        private static string BuildNodeLabel(FigmaPrefabHierarchyNode figmaNode)
        {
            if (figmaNode == null)
            {
                return "空节点";
            }

            return !string.IsNullOrEmpty(figmaNode.path)
                ? figmaNode.path
                : string.IsNullOrEmpty(figmaNode.name) ? "未命名节点" : figmaNode.name;
        }

        /// <summary>
        /// 构建 Transform 在 Prefab 内的层级路径。
        /// </summary>
        private static string GetTransformPath(Transform transform)
        {
            if (transform == null)
            {
                return string.Empty;
            }

            var names = new Stack<string>();
            Transform current = transform;
            while (current != null)
            {
                names.Push(current.name);
                current = current.parent;
            }

            return string.Join("/", names.ToArray());
        }

        /// <summary>
        /// 确保目标对象带有 RectTransform。
        /// </summary>
        private static RectTransform EnsureRectTransform(GameObject gameObject)
        {
            var rectTransform = gameObject.GetComponent<RectTransform>();
            if (rectTransform != null)
            {
                return rectTransform;
            }

            return gameObject.AddComponent<RectTransform>();
        }

        /// <summary>
        /// 设置 Vector2 属性，仅在数值确实变化时写入。
        /// </summary>
        private static bool SetVector2IfDifferent(Func<Vector2> getter, Action<Vector2> setter, Vector2 value)
        {
            if (Approximately(getter(), value))
            {
                return false;
            }

            setter(value);
            return true;
        }

        /// <summary>
        /// 比较两个 Vector2 是否在可忽略误差内。
        /// </summary>
        private static bool Approximately(Vector2 left, Vector2 right)
        {
            return Approximately(left.x, right.x) && Approximately(left.y, right.y);
        }

        /// <summary>
        /// 比较两个浮点值是否在可忽略误差内。
        /// </summary>
        private static bool Approximately(float left, float right)
        {
            return Mathf.Abs(left - right) <= GeometryEpsilon;
        }

        /// <summary>
        /// 清理节点名称，避免空名导致路径匹配失败。
        /// </summary>
        private static string SanitizeName(string value, string fallback)
        {
            string name = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
            return string.IsNullOrEmpty(name) ? fallback : name;
        }

        /// <summary>
        /// 比较节点名是否完全一致。
        /// </summary>
        private static bool NamesEqual(string left, string right)
        {
            return string.Equals(left ?? string.Empty, right ?? string.Empty, StringComparison.Ordinal);
        }

        /// <summary>
        /// 图片同步上下文，缓存同一 Figma 图片的导入结果，避免重复写盘和导入。
        /// </summary>
        private sealed class ImageSyncContext
        {
            private readonly string _targetFolder;
            private readonly bool _dryRun;
            private readonly Dictionary<string, Sprite> _spriteCache = new Dictionary<string, Sprite>(StringComparer.Ordinal);
            private readonly HashSet<string> _reservedAssetPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            public bool ImportedAny { get; private set; }
            public bool DryRun => _dryRun;

            /// <summary>
            /// 创建图片同步上下文。
            /// </summary>
            public ImageSyncContext(string targetFolder, bool dryRun, FigmaPrefabHierarchySyncResult result)
            {
                _targetFolder = NormalizeUnityPath(targetFolder);
                _dryRun = dryRun;
                result.warnings.Add($"图片同步目标目录：{_targetFolder}");
            }

            /// <summary>
            /// 获取或导入 Figma 图片对应的 Sprite。
            /// </summary>
            public Sprite GetOrImportSprite(FigmaPrefabHierarchyImage image, FigmaPrefabHierarchySyncResult result)
            {
                string cacheKey = BuildImageCacheKey(image);
                Sprite cached;
                if (_spriteCache.TryGetValue(cacheKey, out cached))
                {
                    return cached;
                }

                try
                {
                    Sprite sprite = ImportSprite(image, result);
                    _spriteCache[cacheKey] = sprite;
                    return sprite;
                }
                catch (Exception ex)
                {
                    result.errors.Add($"{BuildImageLabel(image)}: {ex.Message}");
                    _spriteCache[cacheKey] = null;
                    return null;
                }
            }

            /// <summary>
            /// 将 Base64 PNG 写入目标目录并加载为 Sprite。
            /// </summary>
            private Sprite ImportSprite(FigmaPrefabHierarchyImage image, FigmaPrefabHierarchySyncResult result)
            {
                Sprite existingSprite = LoadExistingSprite(image, result);
                if (existingSprite != null)
                {
                    return existingSprite;
                }

                if (image == null || string.IsNullOrEmpty(image.base64))
                {
                    throw new ArgumentException("图片数据为空");
                }

                byte[] bytes = Convert.FromBase64String(image.base64);
                if (bytes.Length == 0)
                {
                    throw new ArgumentException("图片字节为空");
                }

                string fileName = SanitizeImageFileName(image.fileName, BuildImageLabel(image));
                string assetPath = MakeAvailableImageAssetPath(_targetFolder, fileName, false, _reservedAssetPaths);
                string absolutePath = AssetPathToAbsolutePath(assetPath);
                File.WriteAllBytes(absolutePath, bytes);
                _reservedAssetPaths.Add(assetPath);
                ImportedAny = true;

                AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);
                ConfigureTextureAsSprite(assetPath, result);
                Sprite sprite = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
                if (sprite == null)
                {
                    throw new InvalidOperationException("导入后无法加载 Sprite：" + assetPath);
                }

                return sprite;
            }

            /// <summary>
            /// 优先复用 Prefab 导入 Figma 时记录的 Unity Sprite。
            /// </summary>
            private static Sprite LoadExistingSprite(FigmaPrefabHierarchyImage image, FigmaPrefabHierarchySyncResult result)
            {
                if (image == null)
                {
                    return null;
                }

                string guid = (image.spriteGuid ?? string.Empty).Trim();
                if (!string.IsNullOrEmpty(guid))
                {
                    string guidPath = NormalizeUnityPath(AssetDatabase.GUIDToAssetPath(guid));
                    Sprite guidSprite = LoadSpriteAtPath(guidPath);
                    if (guidSprite != null)
                    {
                        return guidSprite;
                    }

                    result.warnings.Add($"{BuildImageLabel(image)}: spriteGuid not found or is not Sprite, fallback to exported PNG: {guid}");
                }

                Sprite pathSprite = LoadSpriteAtPath(image.spritePath);
                if (pathSprite != null)
                {
                    return pathSprite;
                }

                if (!string.IsNullOrEmpty(image.spritePath))
                {
                    result.warnings.Add($"{BuildImageLabel(image)}: spritePath not found or is not Sprite, fallback to exported PNG: {image.spritePath}");
                }

                Sprite assetPathSprite = LoadSpriteAtPath(image.assetPath);
                if (assetPathSprite != null)
                {
                    return assetPathSprite;
                }

                if (!string.IsNullOrEmpty(image.assetPath))
                {
                    result.warnings.Add($"{BuildImageLabel(image)}: assetPath not found or is not Sprite, fallback to exported PNG: {image.assetPath}");
                }

                return null;
            }

            private static Sprite LoadSpriteAtPath(string assetPath)
            {
                string normalizedPath = NormalizeUnityPath(assetPath);
                if (string.IsNullOrEmpty(normalizedPath) || !IsAssetsPath(normalizedPath))
                {
                    return null;
                }

                return AssetDatabase.LoadAssetAtPath<Sprite>(normalizedPath);
            }

            /// <summary>
            /// 为图片构建缓存键，优先使用 Unity Sprite 引用。
            /// </summary>
            private static string BuildImageCacheKey(FigmaPrefabHierarchyImage image)
            {
                if (image == null)
                {
                    return string.Empty;
                }

                if (!string.IsNullOrEmpty(image.spriteGuid))
                {
                    return "guid:" + image.spriteGuid;
                }

                if (!string.IsNullOrEmpty(image.spritePath))
                {
                    return "path:" + NormalizeUnityPath(image.spritePath);
                }

                if (!string.IsNullOrEmpty(image.assetPath))
                {
                    return "path:" + NormalizeUnityPath(image.assetPath);
                }

                if (!string.IsNullOrEmpty(image.imageHash))
                {
                    return image.imageHash;
                }

                return !string.IsNullOrEmpty(image.nodeId)
                    ? image.nodeId
                    : BuildImageLabel(image);
            }

            /// <summary>
            /// 构建图片错误提示标签。
            /// </summary>
            private static string BuildImageLabel(FigmaPrefabHierarchyImage image)
            {
                if (image == null)
                {
                    return "空图片";
                }

                if (!string.IsNullOrEmpty(image.nodePath))
                {
                    return image.nodePath;
                }

                return !string.IsNullOrEmpty(image.nodeName) ? image.nodeName : image.fileName;
            }
        }

        /// <summary>
        /// 将导入的 PNG 配置为 UI 可用的单图 Sprite。
        /// </summary>
        private static void ConfigureTextureAsSprite(string assetPath, FigmaPrefabHierarchySyncResult result)
        {
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null)
            {
                result.errors.Add($"{assetPath}: 无法获取 TextureImporter");
                return;
            }

            bool changed = false;
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

            if (changed)
            {
                importer.SaveAndReimport();
            }
        }

        /// <summary>
        /// 清理 Figma 传入的文件名，并统一补齐 PNG 扩展名。
        /// </summary>
        private static string SanitizeImageFileName(string fileName, string fallbackName)
        {
            string rawName = string.IsNullOrEmpty(fileName) ? fallbackName : fileName;
            rawName = Path.GetFileName(rawName);
            if (string.IsNullOrEmpty(rawName))
            {
                rawName = "FigmaImage";
            }

            string baseName = Path.GetFileNameWithoutExtension(rawName);
            if (string.IsNullOrEmpty(baseName))
            {
                baseName = "FigmaImage";
            }

            foreach (char invalidChar in Path.GetInvalidFileNameChars())
            {
                baseName = baseName.Replace(invalidChar, '_');
            }

            baseName = baseName.Trim();
            return string.IsNullOrEmpty(baseName) ? "FigmaImage.png" : baseName + ".png";
        }

        /// <summary>
        /// 生成目标图片资源路径；同一批次内同名资源会按序号错开，避免互相覆盖。
        /// </summary>
        private static string MakeAvailableImageAssetPath(
            string targetFolder,
            string fileName,
            bool overwrite,
            HashSet<string> reservedAssetPaths)
        {
            string baseName = Path.GetFileNameWithoutExtension(fileName);
            string extension = Path.GetExtension(fileName);
            if (string.IsNullOrEmpty(extension))
            {
                extension = ".png";
            }

            string assetPath = NormalizeUnityPath(Path.Combine(targetFolder, baseName + extension));
            if (!IsAssetPathReserved(assetPath, reservedAssetPaths)
                && (overwrite || !File.Exists(AssetPathToAbsolutePath(assetPath))))
            {
                return assetPath;
            }

            for (int i = 1; i < 10000; i++)
            {
                string candidate = NormalizeUnityPath(Path.Combine(targetFolder, $"{baseName}_{i:00}{extension}"));
                if (!IsAssetPathReserved(candidate, reservedAssetPaths)
                    && (overwrite || !File.Exists(AssetPathToAbsolutePath(candidate))))
                {
                    return candidate;
                }
            }

            throw new IOException("无法生成可用图片路径：" + fileName);
        }

        /// <summary>
        /// 判断资源路径是否已在本批次占用。
        /// </summary>
        private static bool IsAssetPathReserved(string assetPath, HashSet<string> reservedAssetPaths)
        {
            return reservedAssetPaths != null && reservedAssetPaths.Contains(assetPath);
        }

        /// <summary>
        /// 判断路径是否位于 Unity Assets 目录下。
        /// </summary>
        private static bool IsAssetsPath(string assetPath)
        {
            return assetPath == "Assets" || assetPath.StartsWith("Assets/", StringComparison.Ordinal);
        }

        /// <summary>
        /// 将 Unity Assets 路径转换为绝对文件路径。
        /// </summary>
        private static string AssetPathToAbsolutePath(string assetPath)
        {
            string projectRoot = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            return Path.GetFullPath(Path.Combine(projectRoot, NormalizeUnityPath(assetPath)));
        }

        /// <summary>
        /// 统一 Unity 资源路径分隔符。
        /// </summary>
        private static string NormalizeUnityPath(string path)
        {
            return string.IsNullOrEmpty(path) ? string.Empty : path.Replace('\\', '/');
        }
    }
}
