using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 记录 Prefab 节点与 Figma 节点的稳定绑定关系，供编辑器层级增量同步使用。
    /// </summary>
    public sealed class FigmaPrefabNodeBinding : MonoBehaviour
    {
        [SerializeField] private string figmaNodeId = string.Empty;
        [SerializeField] private string figmaNodePath = string.Empty;
        [SerializeField] private string figmaNodeName = string.Empty;
        [SerializeField] private string structuralPath = string.Empty;
        [SerializeField] private string sourcePrefabGuid = string.Empty;
        [SerializeField] private string sourcePrefabPath = string.Empty;
        [SerializeField] private string syncBoundaryKind = string.Empty;

        public string FigmaNodeId => figmaNodeId;
        public string FigmaNodePath => figmaNodePath;
        public string FigmaNodeName => figmaNodeName;
        public string StructuralPath => structuralPath;
        public string SourcePrefabGuid => sourcePrefabGuid;
        public string SourcePrefabPath => sourcePrefabPath;
        public string SyncBoundaryKind => syncBoundaryKind;

        /// <summary>
        /// 写入本节点对应的 Figma 节点信息。
        /// </summary>
        public void SetFigmaNode(string nodeId, string nodePath, string nodeName)
        {
            figmaNodeId = nodeId ?? string.Empty;
            figmaNodePath = nodePath ?? string.Empty;
            figmaNodeName = nodeName ?? string.Empty;
        }

        public void SetFigmaNode(
            string nodeId,
            string nodePath,
            string nodeName,
            string nodeStructuralPath,
            string nodeSourcePrefabGuid,
            string nodeSourcePrefabPath,
            string nodeSyncBoundaryKind)
        {
            SetFigmaNode(nodeId, nodePath, nodeName);
            structuralPath = nodeStructuralPath ?? string.Empty;
            sourcePrefabGuid = nodeSourcePrefabGuid ?? string.Empty;
            sourcePrefabPath = nodeSourcePrefabPath ?? string.Empty;
            syncBoundaryKind = nodeSyncBoundaryKind ?? string.Empty;
        }
    }
}
