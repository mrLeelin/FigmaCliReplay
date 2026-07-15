using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 矩形规格，表示 Unity 空间中的位置和尺寸
    /// x/y 为 anchoredPosition，w/h 为 sizeDelta
    /// </summary>
    [Serializable]
    public struct RectSpec
    {
        /// <summary>X 坐标（anchoredPosition.x）</summary>
        public float x;

        /// <summary>Y 坐标（anchoredPosition.y）</summary>
        public float y;

        /// <summary>宽度（sizeDelta.x）</summary>
        public float w;

        /// <summary>高度（sizeDelta.y）</summary>
        public float h;
    }
}
