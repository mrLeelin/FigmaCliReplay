using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 执行前合并验证器，单次调用完成所有预检：
    /// Spec Lint、图片存在性、尺寸/MD5 校验、九宫格最小尺寸检查
    /// </summary>
    public static class PreExecutionValidator
    {
        // ═══════════════════════════════════════════════════════════
        // 内部数据模型（用于反序列化 Download Plan JSON）
        // ═══════════════════════════════════════════════════════════

        [Serializable]
        private class DownloadPlan
        {
            public DownloadPlanImage[] images;
        }

        [Serializable]
        private class DownloadPlanImage
        {
            public string imageId;
            public string targetAssetPath;
            public Vector2Spec expectedSize;
            public string expectedMD5;
            public BorderSpec border;
        }

        [Serializable]
        private class Vector2Spec
        {
            public int x;
            public int y;
        }

        [Serializable]
        private class BorderSpec
        {
            public int l;
            public int b;
            public int r;
            public int t;
        }

        // ═══════════════════════════════════════════════════════════
        // 公开接口
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 执行所有预检并返回合并结果
        /// 包含：Spec Lint、图片存在性、尺寸/MD5、九宫格最小尺寸
        /// </summary>
        public static ValidationResult ValidateAll(string specPath, string downloadPlanPath)
        {
            var result = new ValidationResult
            {
                AllPassed = true,
                Issues = new List<ValidationIssue>()
            };

            // 1. Spec Lint 检查
            ValidateSpecLint(specPath, result);

            // 2-5. 基于 Download Plan 的检查（图片存在性、尺寸、MD5、九宫格）
            ValidateDownloadPlan(downloadPlanPath, result);

            // 汇总判定
            result.AllPassed = result.Issues.Count == 0;
            return result;
        }

        // ═══════════════════════════════════════════════════════════
        // 私有验证方法
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// Spec Lint 检查：验证 specPath 文件存在且为合法 JSON
        /// </summary>
        private static void ValidateSpecLint(string specPath, ValidationResult result)
        {
            if (string.IsNullOrEmpty(specPath))
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "SpecLint",
                    Severity = "Error",
                    Message = "Spec 路径为空",
                    AffectedItem = ""
                });
                return;
            }

            if (!File.Exists(specPath))
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "SpecLint",
                    Severity = "Error",
                    Message = $"Spec 文件不存在: {specPath}",
                    AffectedItem = specPath
                });
                return;
            }

            // 尝试解析 JSON 验证格式合法性
            try
            {
                string json = File.ReadAllText(specPath);
                JsonUtility.FromJson<object>(json);
            }
            catch (Exception ex)
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "SpecLint",
                    Severity = "Error",
                    Message = $"Spec JSON 解析失败: {ex.Message}",
                    AffectedItem = specPath
                });
            }
        }

        /// <summary>
        /// 验证 Download Plan：文件存在性 + 逐图检查
        /// </summary>
        private static void ValidateDownloadPlan(string downloadPlanPath, ValidationResult result)
        {
            if (string.IsNullOrEmpty(downloadPlanPath))
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "SpecLint",
                    Severity = "Error",
                    Message = "Download Plan 路径为空",
                    AffectedItem = ""
                });
                return;
            }

            if (!File.Exists(downloadPlanPath))
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "SpecLint",
                    Severity = "Error",
                    Message = $"Download Plan 文件不存在: {downloadPlanPath}",
                    AffectedItem = downloadPlanPath
                });
                return;
            }

            // 解析 Download Plan JSON
            DownloadPlan plan;
            try
            {
                string json = File.ReadAllText(downloadPlanPath);
                plan = JsonUtility.FromJson<DownloadPlan>(json);
            }
            catch (Exception ex)
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "SpecLint",
                    Severity = "Error",
                    Message = $"Download Plan JSON 解析失败: {ex.Message}",
                    AffectedItem = downloadPlanPath
                });
                return;
            }

            if (plan == null || plan.images == null || plan.images.Length == 0)
            {
                // 无图片需要验证，直接通过
                return;
            }

            // 逐图验证（每个文件只读取一次，同时完成 MD5 和尺寸检查）
            for (int i = 0; i < plan.images.Length; i++)
            {
                ValidateSingleImage(plan.images[i], result);
            }
        }

        /// <summary>
        /// 验证单张图片：存在性、尺寸、MD5、九宫格最小尺寸
        /// 性能优化：文件只读取一次，同时完成 MD5 和尺寸校验
        /// </summary>
        private static void ValidateSingleImage(DownloadPlanImage img, ValidationResult result)
        {
            string targetPath = img.targetAssetPath;
            string imageId = img.imageId ?? "unknown";

            // 图片文件存在性检查
            if (!File.Exists(targetPath))
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "ImageMissing",
                    Severity = "Error",
                    Message = $"图片文件不存在: {targetPath}",
                    AffectedItem = imageId
                });
                return;
            }

            // 读取文件字节（只读一次，用于 MD5 和尺寸检查）
            byte[] fileBytes;
            try
            {
                fileBytes = File.ReadAllBytes(targetPath);
            }
            catch (Exception ex)
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "ImageMissing",
                    Severity = "Error",
                    Message = $"无法读取图片文件: {ex.Message}",
                    AffectedItem = imageId
                });
                return;
            }

            // MD5 校验
            ValidateMD5(img, fileBytes, imageId, result);

            // 尺寸校验（通过 PNG 文件头读取实际尺寸）
            ValidateSize(img, fileBytes, imageId, result);

            // 九宫格最小尺寸检查
            ValidateNineSliceMinSize(img, fileBytes, imageId, result);
        }

        /// <summary>
        /// MD5 校验：计算文件 MD5 并与期望值比较
        /// </summary>
        private static void ValidateMD5(
            DownloadPlanImage img, byte[] fileBytes, string imageId, ValidationResult result)
        {
            if (string.IsNullOrEmpty(img.expectedMD5))
            {
                return;
            }

            string actualMD5 = ComputeMD5(fileBytes);
            if (!string.Equals(actualMD5, img.expectedMD5, StringComparison.OrdinalIgnoreCase))
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "MD5Mismatch",
                    Severity = "Warning",
                    Message = $"MD5 不匹配 - 期望: {img.expectedMD5}, 实际: {actualMD5}",
                    AffectedItem = imageId
                });
            }
        }

        /// <summary>
        /// 尺寸校验：从 PNG 文件头读取实际宽高，与期望尺寸比较
        /// </summary>
        private static void ValidateSize(
            DownloadPlanImage img, byte[] fileBytes, string imageId, ValidationResult result)
        {
            if (img.expectedSize == null || (img.expectedSize.x == 0 && img.expectedSize.y == 0))
            {
                return;
            }

            if (!TryGetPngDimensions(fileBytes, out int actualWidth, out int actualHeight))
            {
                return;
            }

            if (actualWidth != img.expectedSize.x || actualHeight != img.expectedSize.y)
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "SizeMismatch",
                    Severity = "Warning",
                    Message = $"尺寸不匹配 - 期望: {img.expectedSize.x}x{img.expectedSize.y}, 实际: {actualWidth}x{actualHeight}",
                    AffectedItem = imageId
                });
            }
        }

        /// <summary>
        /// 九宫格最小尺寸检查：有 border 的图片尺寸必须 >= (left+right+2) x (top+bottom+2)
        /// </summary>
        private static void ValidateNineSliceMinSize(
            DownloadPlanImage img, byte[] fileBytes, string imageId, ValidationResult result)
        {
            if (img.border == null)
            {
                return;
            }

            if (img.border.l == 0 && img.border.r == 0 && img.border.t == 0 && img.border.b == 0)
            {
                return;
            }

            if (!TryGetPngDimensions(fileBytes, out int actualWidth, out int actualHeight))
            {
                return;
            }

            int minWidth = img.border.l + img.border.r + 2;
            int minHeight = img.border.t + img.border.b + 2;

            if (actualWidth < minWidth || actualHeight < minHeight)
            {
                result.Issues.Add(new ValidationIssue
                {
                    Category = "NineSliceSize",
                    Severity = "Error",
                    Message = $"九宫格尺寸不足 - 最小要求: {minWidth}x{minHeight}, 实际: {actualWidth}x{actualHeight}",
                    AffectedItem = imageId
                });
            }
        }

        // ═══════════════════════════════════════════════════════════
        // 工具方法
        // ═══════════════════════════════════════════════════════════

        /// <summary>
        /// 计算字节数组的 MD5 哈希值（小写十六进制字符串）
        /// </summary>
        private static string ComputeMD5(byte[] data)
        {
            using (var md5 = MD5.Create())
            {
                byte[] hash = md5.ComputeHash(data);
                var sb = new System.Text.StringBuilder(32);
                for (int i = 0; i < hash.Length; i++)
                {
                    sb.Append(hash[i].ToString("x2"));
                }
                return sb.ToString();
            }
        }

        /// <summary>
        /// 从 PNG 文件头读取图片宽高
        /// PNG 格式：前 8 字节为签名，接下来是 IHDR chunk，
        /// 偏移 16-19 为宽度（大端），20-23 为高度（大端）
        /// </summary>
        private static bool TryGetPngDimensions(byte[] data, out int width, out int height)
        {
            width = 0;
            height = 0;

            // PNG 最小有效长度：8(签名) + 4(长度) + 4(类型) + 13(IHDR数据) + 4(CRC) = 33
            if (data == null || data.Length < 33)
            {
                return false;
            }

            // 验证 PNG 签名：137 80 78 71 13 10 26 10
            if (data[0] != 137 || data[1] != 80 || data[2] != 78 || data[3] != 71 ||
                data[4] != 13 || data[5] != 10 || data[6] != 26 || data[7] != 10)
            {
                return false;
            }

            // IHDR chunk 宽度在偏移 16-19（大端序）
            width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
            // IHDR chunk 高度在偏移 20-23（大端序）
            height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];

            return width > 0 && height > 0;
        }
    }
}
