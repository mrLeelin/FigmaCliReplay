using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 验证问题项，描述单个验证失败的详细信息
    /// </summary>
    [Serializable]
    public class ValidationIssue
    {
        /// <summary>
        /// 问题分类：SpecLint / ImageMissing / SizeMismatch / MD5Mismatch / NineSliceSize
        /// </summary>
        public string Category;

        /// <summary>
        /// 严重级别：Error / Warning
        /// </summary>
        public string Severity;

        /// <summary>问题描述信息</summary>
        public string Message;

        /// <summary>受影响的项目（文件名、节点名等）</summary>
        public string AffectedItem;
    }
}
