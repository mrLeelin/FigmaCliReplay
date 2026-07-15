using System;
using System.Collections.Generic;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 验证结果，包含所有预检验证的合并结果
    /// </summary>
    [Serializable]
    public class ValidationResult
    {
        /// <summary>是否所有验证均通过</summary>
        public bool AllPassed;

        /// <summary>验证问题列表</summary>
        public List<ValidationIssue> Issues = new List<ValidationIssue>();
    }
}
