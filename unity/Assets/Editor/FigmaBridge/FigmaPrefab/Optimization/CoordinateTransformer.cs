using UnityEngine;
using ZLog = UnityEngine.Debug;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// Figma 坐标到 Unity anchoredPosition 的纯函数转换器
    /// </summary>
    public static class CoordinateTransformer
    {
        /// <summary>
        /// 将 Figma 本地坐标转换为 Unity anchoredPosition，返回 RectSpec
        /// 公式：
        ///   figmaCenterX = figmaLocalX + width / 2
        ///   figmaCenterY = figmaLocalY + height / 2
        ///   rect.x = figmaCenterX - parentW / 2
        ///   rect.y = -(figmaCenterY - parentH / 2)
        /// </summary>
        /// <param name="figmaLocalX">Figma 节点本地 X 坐标</param>
        /// <param name="figmaLocalY">Figma 节点本地 Y 坐标</param>
        /// <param name="width">节点宽度</param>
        /// <param name="height">节点高度</param>
        /// <param name="parentWidth">父节点宽度</param>
        /// <param name="parentHeight">父节点高度</param>
        /// <returns>包含 anchoredPosition 和 sizeDelta 的 RectSpec</returns>
        public static RectSpec Transform(
            float figmaLocalX, float figmaLocalY,
            float width, float height,
            float parentWidth, float parentHeight)
        {
            // 输入验证：负尺寸时记录警告并使用 0 作为默认值
            if (width < 0f)
            {
                ZLog.LogWarning($"[CoordinateTransformer] width 为负值 ({width})，已修正为 0");
                width = 0f;
            }

            if (height < 0f)
            {
                ZLog.LogWarning($"[CoordinateTransformer] height 为负值 ({height})，已修正为 0");
                height = 0f;
            }

            // 计算 Figma 节点中心点
            float figmaCenterX = figmaLocalX + width / 2f;
            float figmaCenterY = figmaLocalY + height / 2f;

            // 转换为 Unity anchoredPosition（中心锚点偏移）
            float rectX = figmaCenterX - parentWidth / 2f;
            float rectY = -(figmaCenterY - parentHeight / 2f);

            return new RectSpec
            {
                x = rectX,
                y = rectY,
                w = width,
                h = height
            };
        }
    }
}
