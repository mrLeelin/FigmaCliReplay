using System.Collections.Generic;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 负责把 Unity Sprite border 转换为 Figma 九宫格切片数据。
    /// </summary>
    public static class PrefabToFigmaNineSliceExporter
    {
        /// <summary>
        /// 判断 Sprite border 是否包含有效九宫格边距。
        /// </summary>
        public static bool HasBorder(PrefabToFigmaBorder border)
        {
            return border != null && (border.left > 0f || border.right > 0f || border.top > 0f || border.bottom > 0f);
        }

        /// <summary>
        /// 根据目标尺寸、源图尺寸和边距生成九宫切片。
        /// </summary>
        public static List<PrefabToFigmaSlice> BuildSlices(
            float width,
            float height,
            float imageWidth,
            float imageHeight,
            PrefabToFigmaBorder border,
            List<string> warnings)
        {
            var left = Mathf.Max(border.left, 0f);
            var right = Mathf.Max(border.right, 0f);
            var top = Mathf.Max(border.top, 0f);
            var bottom = Mathf.Max(border.bottom, 0f);

            CompressPair(ref left, ref right, width, "nine-slice horizontal border compressed", warnings);
            CompressPair(ref top, ref bottom, height, "nine-slice vertical border compressed", warnings);

            var targetCenterWidth = width - left - right;
            var targetCenterHeight = height - top - bottom;
            var sourceCenterWidth = imageWidth - border.left - border.right;
            var sourceCenterHeight = imageHeight - border.top - border.bottom;

            var columns = new[]
            {
                new SliceAxis("left", left, 0f, border.left, 0f),
                new SliceAxis("", targetCenterWidth, left, sourceCenterWidth, border.left),
                new SliceAxis("right", right, width - right, border.right, imageWidth - border.right)
            };
            var rows = new[]
            {
                new SliceAxis("top", top, 0f, border.top, 0f),
                new SliceAxis("", targetCenterHeight, top, sourceCenterHeight, border.top),
                new SliceAxis("bottom", bottom, height - bottom, border.bottom, imageHeight - border.bottom)
            };

            var slices = new List<PrefabToFigmaSlice>(9);
            for (var rowIndex = 0; rowIndex < rows.Length; rowIndex++)
            {
                for (var columnIndex = 0; columnIndex < columns.Length; columnIndex++)
                {
                    var row = rows[rowIndex];
                    var column = columns[columnIndex];
                    if (row.size <= 0f || column.size <= 0f)
                    {
                        continue;
                    }

                    slices.Add(new PrefabToFigmaSlice
                    {
                        name = BuildSliceName(row.name, column.name),
                        target = new PrefabToFigmaRectTuple
                        {
                            x = column.targetOffset,
                            y = row.targetOffset,
                            width = column.size,
                            height = row.size
                        },
                        source = new PrefabToFigmaRectTuple
                        {
                            x = column.sourceOffset,
                            y = row.sourceOffset,
                            width = column.sourceSize,
                            height = row.sourceSize
                        }
                    });
                }
            }

            return slices;
        }

        /// <summary>
        /// 当两侧边距超过可用长度时按比例压缩，避免生成负尺寸切片。
        /// </summary>
        private static void CompressPair(ref float first, ref float second, float limit, string warning, List<string> warnings)
        {
            var total = first + second;
            if (total <= limit || total <= 0f)
            {
                return;
            }

            var scale = Mathf.Max(limit, 0f) / total;
            first *= scale;
            second *= scale;
            warnings.Add(warning);
        }

        /// <summary>
        /// 生成与 Python parser 兼容的切片名称。
        /// </summary>
        private static string BuildSliceName(string row, string column)
        {
            if (!string.IsNullOrEmpty(row) && !string.IsNullOrEmpty(column))
            {
                return "__slice_" + row + "_" + column;
            }

            if (!string.IsNullOrEmpty(row))
            {
                return "__slice_" + row;
            }

            if (!string.IsNullOrEmpty(column))
            {
                return "__slice_" + column;
            }

            return "__slice_center";
        }

        private readonly struct SliceAxis
        {
            public readonly string name;
            public readonly float size;
            public readonly float targetOffset;
            public readonly float sourceSize;
            public readonly float sourceOffset;

            public SliceAxis(string name, float size, float targetOffset, float sourceSize, float sourceOffset)
            {
                this.name = name;
                this.size = size;
                this.targetOffset = targetOffset;
                this.sourceSize = sourceSize;
                this.sourceOffset = sourceOffset;
            }
        }
    }
}
