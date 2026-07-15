using System;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 图片下载计划，定义所有需要下载的图片清单
    /// 由阶段一 AI 分析生成，阶段二执行器消费
    /// </summary>
    [Serializable]
    public class ImageDownloadPlan
    {
        /// <summary>需要下载的图片列表</summary>
        public ImageDownloadItem[] images;
    }

    /// <summary>
    /// 单张图片的下载描述，包含来源、目标路径和校验信息
    /// </summary>
    [Serializable]
    public class ImageDownloadItem
    {
        /// <summary>图片唯一标识（如 img_0）</summary>
        public string imageId;

        /// <summary>Figma 节点 ID</summary>
        public string figmaNodeId;

        /// <summary>Figma 图片哈希</summary>
        public string imageHash;

        /// <summary>下载 URL</summary>
        public string downloadUrl;

        /// <summary>目标资产路径（相对于 Unity 项目根目录）</summary>
        public string targetAssetPath;

        /// <summary>期望的图片尺寸</summary>
        public ImageVector2 expectedSize;

        /// <summary>期望的文件 MD5 校验值</summary>
        public string expectedMD5;

        /// <summary>九宫格边框信息（仅九宫格图片有值，普通图片为 null）</summary>
        public BorderSpec border;
    }

    /// <summary>
    /// 九宫格边框规格，定义四边的像素值
    /// </summary>
    [Serializable]
    public class BorderSpec
    {
        /// <summary>左边框像素</summary>
        public int l;

        /// <summary>下边框像素</summary>
        public int b;

        /// <summary>右边框像素</summary>
        public int r;

        /// <summary>上边框像素</summary>
        public int t;
    }

    /// <summary>
    /// 二维尺寸规格，用于图片下载计划中的尺寸描述
    /// </summary>
    [Serializable]
    public class ImageVector2
    {
        /// <summary>X 值（宽度）</summary>
        public float x;

        /// <summary>Y 值（高度）</summary>
        public float y;
    }
}
