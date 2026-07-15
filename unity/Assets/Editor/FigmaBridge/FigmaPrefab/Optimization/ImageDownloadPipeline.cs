using System.Text;

namespace MagicWarrior.Editor.FigmaPrefab.Optimization
{
    /// <summary>
    /// 图片下载流水线，负责生成 PowerShell 并行下载脚本
    /// 支持：MD5 预检跳过、并发限制、失败重试、进度报告
    /// </summary>
    public class ImageDownloadPipeline
    {
        /// <summary>最大并发下载数</summary>
        public int MaxConcurrency { get; } = 8;

        /// <summary>单张图片最大重试次数（不含首次尝试）</summary>
        public int MaxRetries { get; } = 2;

        /// <summary>
        /// 生成 PowerShell 并行下载脚本
        /// 脚本逻辑：MD5 预检跳过已存在文件、Start-ThreadJob 并发限制、失败重试、进度报告
        /// </summary>
        /// <param name="plan">图片下载计划</param>
        /// <returns>完整的 PowerShell 脚本字符串</returns>
        public string GenerateDownloadScript(ImageDownloadPlan plan)
        {
            if (plan == null || plan.images == null || plan.images.Length == 0)
            {
                return "Write-Host '没有需要下载的图片'";
            }

            var sb = new StringBuilder(4096);

            AppendScriptHeader(sb, plan);
            AppendImageTaskArray(sb, plan);
            AppendMd5Function(sb);
            AppendDownloadLogic(sb);
            AppendProgressReport(sb);

            return sb.ToString();
        }

        /// <summary>
        /// 计算九宫格图片的最小下载尺寸
        /// 最小尺寸 = 边框像素之和 + 2（确保中间至少有 1 像素可拉伸区域的两倍）
        /// </summary>
        /// <param name="left">左边框像素</param>
        /// <param name="right">右边框像素</param>
        /// <param name="top">上边框像素</param>
        /// <param name="bottom">下边框像素</param>
        /// <returns>最小宽度和高度的元组</returns>
        public static (int width, int height) GetNineSliceMinSize(
            int left, int right, int top, int bottom)
        {
            return (left + right + 2, top + bottom + 2);
        }

        /// <summary>
        /// 生成脚本头部：错误处理策略、统计变量初始化
        /// </summary>
        private void AppendScriptHeader(StringBuilder sb, ImageDownloadPlan plan)
        {
            sb.AppendLine("# 图片并行下载脚本 - 由 ImageDownloadPipeline 自动生成");
            sb.AppendLine("$ErrorActionPreference = 'Continue'");
            sb.AppendLine();
            sb.AppendLine("# 统计变量");
            sb.AppendLine("$totalCount = " + plan.images.Length);
            sb.AppendLine("$skippedCount = 0");
            sb.AppendLine("$downloadedCount = 0");
            sb.AppendLine("$failedCount = 0");
            sb.AppendLine("$maxRetries = " + MaxRetries);
            sb.AppendLine("$throttleLimit = " + MaxConcurrency);
            sb.AppendLine();
        }

        /// <summary>
        /// 生成图片任务数组定义，每个元素包含下载所需的全部信息
        /// </summary>
        private void AppendImageTaskArray(StringBuilder sb, ImageDownloadPlan plan)
        {
            sb.AppendLine("# 图片下载任务列表");
            sb.AppendLine("$downloadTasks = @(");

            for (int i = 0; i < plan.images.Length; i++)
            {
                var img = plan.images[i];
                sb.Append("    @{");
                sb.Append(" ImageId = '").Append(EscapePsString(img.imageId)).Append("';");
                sb.Append(" Url = '").Append(EscapePsString(img.downloadUrl)).Append("';");
                sb.Append(" TargetPath = '").Append(EscapePsString(img.targetAssetPath)).Append("';");
                sb.Append(" ExpectedMD5 = '").Append(EscapePsString(img.expectedMD5 ?? "")).Append("';");

                if (img.border != null)
                {
                    var (minW, minH) = GetNineSliceMinSize(img.border.l, img.border.r, img.border.t, img.border.b);
                    sb.Append(" IsNineSlice = $true;");
                    sb.Append(" MinWidth = ").Append(minW).Append(";");
                    sb.Append(" MinHeight = ").Append(minH);
                }
                else
                {
                    sb.Append(" IsNineSlice = $false");
                }

                sb.Append(" }");
                if (i < plan.images.Length - 1)
                    sb.AppendLine(",");
                else
                    sb.AppendLine();
            }

            sb.AppendLine(")");
            sb.AppendLine();
        }

        /// <summary>
        /// 生成 MD5 计算辅助函数
        /// </summary>
        private static void AppendMd5Function(StringBuilder sb)
        {
            sb.AppendLine("# MD5 计算函数");
            sb.AppendLine("function Get-FileMD5 {");
            sb.AppendLine("    param([string]$Path)");
            sb.AppendLine("    if (-not (Test-Path $Path)) { return '' }");
            sb.AppendLine("    $hash = Get-FileHash -Path $Path -Algorithm MD5");
            sb.AppendLine("    return $hash.Hash.ToLower()");
            sb.AppendLine("}");
            sb.AppendLine();
        }

        /// <summary>
        /// 生成核心下载逻辑：MD5 预检、Start-ThreadJob 并行下载、失败重试
        /// </summary>
        private static void AppendDownloadLogic(StringBuilder sb)
        {
            // MD5 预检：跳过已存在且校验匹配的文件
            sb.AppendLine("# MD5 预检：跳过已存在且 MD5 匹配的文件");
            sb.AppendLine("$needDownload = @()");
            sb.AppendLine("foreach ($task in $downloadTasks) {");
            sb.AppendLine("    if ($task.ExpectedMD5 -ne '' -and (Test-Path $task.TargetPath)) {");
            sb.AppendLine("        $currentMD5 = Get-FileMD5 -Path $task.TargetPath");
            sb.AppendLine("        if ($currentMD5 -eq $task.ExpectedMD5) {");
            sb.AppendLine("            $skippedCount++");
            sb.AppendLine("            continue");
            sb.AppendLine("        }");
            sb.AppendLine("    }");
            sb.AppendLine("    $needDownload += $task");
            sb.AppendLine("}");
            sb.AppendLine();

            // Start-ThreadJob 并行下载
            sb.AppendLine("# 使用 Start-ThreadJob 并行下载，限制并发数");
            sb.AppendLine("$jobs = @()");
            sb.AppendLine("foreach ($task in $needDownload) {");
            sb.AppendLine("    # 等待并发数降到限制以下");
            sb.AppendLine("    while (($jobs | Where-Object { $_.State -eq 'Running' }).Count -ge $throttleLimit) {");
            sb.AppendLine("        Start-Sleep -Milliseconds 100");
            sb.AppendLine("    }");
            sb.AppendLine("    $jobs += Start-ThreadJob -ScriptBlock {");
            sb.AppendLine("        param($t, $retries)");
            sb.AppendLine("        $dir = Split-Path -Parent $t.TargetPath");
            sb.AppendLine("        if (-not (Test-Path $dir)) {");
            sb.AppendLine("            New-Item -ItemType Directory -Path $dir -Force | Out-Null");
            sb.AppendLine("        }");
            sb.AppendLine("        for ($attempt = 0; $attempt -le $retries; $attempt++) {");
            sb.AppendLine("            try {");
            sb.AppendLine("                Invoke-WebRequest -Uri $t.Url -OutFile $t.TargetPath -UseBasicParsing");
            sb.AppendLine("                return @{ Success = $true; ImageId = $t.ImageId; Attempts = ($attempt + 1) }");
            sb.AppendLine("            } catch {");
            sb.AppendLine("                if ($attempt -eq $retries) {");
            sb.AppendLine("                    return @{ Success = $false; ImageId = $t.ImageId; Error = $_.Exception.Message; Attempts = ($attempt + 1) }");
            sb.AppendLine("                }");
            sb.AppendLine("                Start-Sleep -Milliseconds (500 * ($attempt + 1))");
            sb.AppendLine("            }");
            sb.AppendLine("        }");
            sb.AppendLine("    } -ArgumentList $task, $maxRetries");
            sb.AppendLine("}");
            sb.AppendLine();

            // 等待所有任务完成并收集结果
            sb.AppendLine("# 等待所有下载任务完成");
            sb.AppendLine("$results = $jobs | Wait-Job | Receive-Job");
            sb.AppendLine("$jobs | Remove-Job -Force");
            sb.AppendLine();

            // 统计下载结果
            sb.AppendLine("# 统计下载结果");
            sb.AppendLine("foreach ($r in $results) {");
            sb.AppendLine("    if ($r.Success) {");
            sb.AppendLine("        $downloadedCount++");
            sb.AppendLine("    } else {");
            sb.AppendLine("        $failedCount++");
            sb.AppendLine("        Write-Warning \"下载失败: $($r.ImageId) - $($r.Error)\"");
            sb.AppendLine("    }");
            sb.AppendLine("}");
            sb.AppendLine();
        }

        /// <summary>
        /// 生成进度报告和返回结果对象
        /// </summary>
        private static void AppendProgressReport(StringBuilder sb)
        {
            sb.AppendLine("# 输出最终进度报告");
            sb.AppendLine("Write-Host \"Downloaded $downloadedCount/$totalCount images, skipped $skippedCount\"");
            sb.AppendLine("if ($failedCount -gt 0) {");
            sb.AppendLine("    Write-Warning \"$failedCount 张图片下载失败\"");
            sb.AppendLine("}");
            sb.AppendLine();
            sb.AppendLine("# 返回结果对象");
            sb.AppendLine("@{");
            sb.AppendLine("    Total = $totalCount");
            sb.AppendLine("    Downloaded = $downloadedCount");
            sb.AppendLine("    Skipped = $skippedCount");
            sb.AppendLine("    Failed = $failedCount");
            sb.AppendLine("}");
        }

        /// <summary>
        /// 转义 PowerShell 单引号字符串中的特殊字符
        /// 单引号字符串中只需将单引号替换为两个单引号
        /// </summary>
        private static string EscapePsString(string input)
        {
            if (string.IsNullOrEmpty(input)) return "";
            return input.Replace("'", "''");
        }
    }
}
