using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 节点规格（用于变更范围检测的轻量对比模型）
    /// </summary>
    [Serializable]
    public class NodeCompareSpec
    {
        /// <summary>节点名称</summary>
        public string name;

        /// <summary>X 坐标</summary>
        public float x;

        /// <summary>Y 坐标</summary>
        public float y;

        /// <summary>宽度</summary>
        public float w;

        /// <summary>高度</summary>
        public float h;

        /// <summary>文本内容</summary>
        public string text;

        /// <summary>字体大小</summary>
        public float fontSize;

        /// <summary>颜色值（十六进制字符串）</summary>
        public string color;

        /// <summary>图片资源 ID</summary>
        public string imageId;
    }
}
