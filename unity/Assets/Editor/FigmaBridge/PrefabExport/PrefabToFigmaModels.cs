using System;
using System.Collections.Generic;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Prefab 导出到 Figma 的中间包，字段保持兼容 prefab-to-figma.json。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaPackage
    {
        public int version = 1;
        public string prefabPath;
        public PrefabToFigmaCanvas canvas;
        public PrefabToFigmaNode root;
        public readonly List<PrefabToFigmaNode> nodes = new List<PrefabToFigmaNode>();
        public readonly Dictionary<string, PrefabToFigmaAsset> assets = new Dictionary<string, PrefabToFigmaAsset>();
        public readonly List<PrefabToFigmaPrefabInstance> prefabInstances = new List<PrefabToFigmaPrefabInstance>();
        public PrefabToFigmaVisualBounds visualBounds = new PrefabToFigmaVisualBounds();
        public readonly List<string> warnings = new List<string>();
        public readonly List<string> fatalErrors = new List<string>();
        public PrefabToFigmaStats stats = new PrefabToFigmaStats();
    }

    /// <summary>
    /// 导出画布尺寸。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaCanvas
    {
        public float width;
        public float height;
    }

    /// <summary>
    /// Unity 节点导出数据。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaNode
    {
        public string id;
        public string name;
        public string path;
        public bool active;
        public PrefabToFigmaRect rect;
        public PrefabToFigmaUnityData unity;
        public readonly List<PrefabToFigmaNode> children = new List<PrefabToFigmaNode>();
        public PrefabToFigmaImage image;
        public PrefabToFigmaText text;
        public PrefabToFigmaClip clip;
        public PrefabToFigmaPrefabSource prefabSource;
        public List<string> unsupported;
    }

    /// <summary>
    /// 节点矩形，使用 Figma 左上角坐标。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaRect
    {
        public float x;
        public float y;
        public float width;
        public float height;
        public float rotationZ;
        public float? scaleX;
        public float? scaleY;
    }

    /// <summary>
    /// Unity 对象引用信息。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaUnityData
    {
        public string gameObjectId;
        public string rectTransformId;
        public string parentRectId;
        public readonly List<string> children = new List<string>();
    }

    /// <summary>
    /// 图片组件导出数据。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaImage
    {
        public string componentType;
        public string guid;
        public string imageType;
        public string mode = "simple";
        public float fillAmount = 1f;
        public bool fillCenter = true;
        public string asset;
        public PrefabToFigmaPixelSize pixelSize;
        public PrefabToFigmaBorder border;
        public List<PrefabToFigmaSlice> slices;
        public PrefabToFigmaSourceImage sourceImage;
    }

    /// <summary>
    /// 源图片资源信息。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaAsset
    {
        public string guid;
        public string assetPath;
        public string metaPath;
        public int width;
        public int height;
        public PrefabToFigmaBorder border;
        public float pixelsToUnits;
    }

    /// <summary>
    /// 图片像素尺寸。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaPixelSize
    {
        public int width;
        public int height;
    }

    /// <summary>
    /// Unity Sprite 九宫格边距。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaBorder
    {
        public float left;
        public float bottom;
        public float right;
        public float top;
    }

    /// <summary>
    /// 九宫格切片数据。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaSlice
    {
        public string name;
        public PrefabToFigmaRectTuple target;
        public PrefabToFigmaRectTuple source;
    }

    /// <summary>
    /// 切片矩形，不包含旋转。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaRectTuple
    {
        public float x;
        public float y;
        public float width;
        public float height;
    }

    /// <summary>
    /// 九宫格父节点隐藏源图元数据。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaSourceImage
    {
        public int width;
        public int height;
        public string spriteGuid;
        public string assetPath;
    }

    /// <summary>
    /// 文本组件导出数据。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaText
    {
        public string componentType;
        public string content;
        public float fontSize;
        public PrefabToFigmaColor color;
        public PrefabToFigmaColor fontColor;
        public PrefabToFigmaColor outlineColor;
        public PrefabToFigmaMaterialRef sharedMaterial;
        public PrefabToFigmaAutoSize autoSize;
        public PrefabToFigmaAlignment alignment;
        public PrefabToFigmaTextOptions options;
    }

    /// <summary>
    /// 颜色数据，范围与 Unity Color 一致。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaColor
    {
        public float r;
        public float g;
        public float b;
        public float a;
    }

    /// <summary>
    /// TMP 材质引用。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaMaterialRef
    {
        public string guid;
        public long fileID;
    }

    /// <summary>
    /// TMP 自动字号信息。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaAutoSize
    {
        public bool enabled;
        public float min;
        public float max;
    }

    /// <summary>
    /// 文本对齐信息。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaAlignment
    {
        public int horizontal;
        public int vertical;
        public int legacy;
    }

    /// <summary>
    /// 文本渲染选项。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaTextOptions
    {
        public int fontStyle;
        public bool wordWrapping;
        public int overflowMode;
        public bool richText;
    }

    /// <summary>
    /// 裁剪组件信息。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaClip
    {
        public bool enabled;
        public string componentType;
    }

    /// <summary>
    /// PrefabInstance 摘要，C# 导出器默认读取展开后的实际层级。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaPrefabInstance
    {
        public string fileId;
        public PrefabToFigmaUnityRef sourcePrefab;
        public string sourcePrefabPath;
    }

    /// <summary>
    /// 嵌套 Prefab 根节点的源 Prefab 元数据。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaPrefabSource
    {
        public string guid;
        public string path;
        public string name;
        public bool isRoot;
    }

    /// <summary>
    /// Unity 序列化引用字段。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaUnityRef
    {
        public string fileID;
        public string guid;
        public int type;
    }

    /// <summary>
    /// 导出视觉包围盒。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaVisualBounds
    {
        public float x;
        public float y;
        public float width;
        public float height;
    }

    /// <summary>
    /// 导出统计信息。
    /// </summary>
    [Serializable]
    public class PrefabToFigmaStats
    {
        public int nodeCount;
        public int imageCount;
        public int textCount;
        public int nineSliceCount;
        public int clipCount;
        public int prefabInstanceCount;
        public int unsupportedCount;
    }
}
