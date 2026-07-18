using System.IO;
using UnityEditor;
using UnityEngine;
using TMPro;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Figma Bridge 编辑器控制面板。
    /// 提供服务器状态显示、Prefab 选择、Push 操作和日志查看功能。
    /// </summary>
    public class FigmaBridgeWindow : EditorWindow
    {
        // ─────────────────────── 常量 ───────────────────────

        /// <summary>窗口标题</summary>
        private const string WindowTitle = "Figma Bridge";

        /// <summary>状态圆点的尺寸</summary>
        private const float DotSize = 10f;

        /// <summary>EditorPrefs 存储 Figma URL 的 key</summary>
        private const string PrefsFigmaUrlKey = "FigmaBridge_FigmaFileUrl";

        /// <summary>Kiro prompt 文件输出目录（相对于仓库根）</summary>
        private const string TriggerOutputDir = ".kiro/triggers/figma-bridge";

        /// <summary>端口输入框的最小显示宽度</summary>
        private const float PortFieldMinWidth = 80f;

        // ─────────────────────── 状态 ───────────────────────

        /// <summary>日志滚动位置</summary>
        private Vector2 _logScrollPos;

        /// <summary>缓存的状态圆点纹理（绿色）</summary>
        private Texture2D _greenDot;

        /// <summary>缓存的状态圆点纹理（红色）</summary>
        private Texture2D _redDot;

        /// <summary>Figma 文件 URL 输入值</summary>
        private string _figmaFileUrl = "";

        /// <summary>服务器首选监听端口输入值</summary>
        private int _serverPort = FigmaBridgeServer.DefaultPort;
        private TMP_FontAsset _importFont;

        /// <summary>最近一次推送的 Prefab 名称</summary>
        private string _lastPushPrefabName = "";

        /// <summary>最近一次推送的时间</summary>
        private string _lastPushTime = "";

        // ─────────────────────── 菜单入口 ───────────────────────

        /// <summary>
        /// 通过菜单 Tools/Figma Bridge 打开窗口。
        /// </summary>
        [MenuItem("Tools/Figma Bridge")]
        private static void Open()
        {
            var window = GetWindow<FigmaBridgeWindow>(WindowTitle);
            window.minSize = new Vector2(320, 400);
            window.Show();
        }

        // ─────────────────────── 生命周期 ───────────────────────

        /// <summary>
        /// 窗口启用时订阅日志变更事件。
        /// </summary>
        private void OnEnable()
        {
            BridgeLogger.OnChanged += OnLogChanged;
            _figmaFileUrl = EditorPrefs.GetString(PrefsFigmaUrlKey, "");
            _serverPort = FigmaBridgeServer.PreferredPort;
            _importFont = FigmaBridgeImportSettings.Font;
        }

        /// <summary>
        /// 窗口禁用时取消订阅。
        /// </summary>
        private void OnDisable()
        {
            BridgeLogger.OnChanged -= OnLogChanged;
            DestroyDotTextures();
        }

        /// <summary>
        /// 日志变更时刷新窗口。
        /// </summary>
        private void OnLogChanged()
        {
            Repaint();
        }

        // ─────────────────────── UI 绘制 ───────────────────────

        /// <summary>
        /// 绘制窗口 GUI。
        /// </summary>
        private void OnGUI()
        {
            EnsureDotTextures();

            DrawHeader();
            EditorGUILayout.Space(4);
            DrawFigmaUrlConfig();
            EditorGUILayout.Space(4);
            EditorGUILayout.LabelField("Unity 导入字体", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            _importFont = (TMP_FontAsset)EditorGUILayout.ObjectField("点击选择字体", _importFont, typeof(TMP_FontAsset), false);
            if (EditorGUI.EndChangeCheck() && _importFont != null) FigmaBridgeImportSettings.SetFont(_importFont);
            EditorGUILayout.Space(4);
            DrawServerPortConfig();
            EditorGUILayout.Space(4);
            DrawConnectionStatus();
            EditorGUILayout.Space(4);
            DrawPrefabInfo();
            EditorGUILayout.Space(4);
            DrawServerControls();
            EditorGUILayout.Space(4);
            DrawPushButton();
            EditorGUILayout.Space(4);
            DrawLastPushInfo();
            EditorGUILayout.Space(8);
            DrawLogArea();
        }

        /// <summary>
        /// 绘制标题区域。
        /// </summary>
        private void DrawHeader()
        {
            EditorGUILayout.LabelField("Figma Bridge", EditorStyles.boldLabel);
            EditorGUILayout.LabelField(
                "Unity ↔ Figma 插件桥接工具",
                EditorStyles.miniLabel);
        }

        /// <summary>
        /// 绘制 Figma 文件 URL 配置区域。
        /// </summary>
        private void DrawFigmaUrlConfig()
        {
            EditorGUILayout.LabelField("Figma 文件 URL", EditorStyles.boldLabel);

            EditorGUI.BeginChangeCheck();
            _figmaFileUrl = EditorGUILayout.TextField(_figmaFileUrl);
            if (EditorGUI.EndChangeCheck())
            {
                EditorPrefs.SetString(PrefsFigmaUrlKey, _figmaFileUrl);
            }

            if (string.IsNullOrEmpty(_figmaFileUrl))
            {
                EditorGUILayout.HelpBox(
                    "建议配置 Figma 文件 URL 以加速推送流程",
                    MessageType.Info);
            }
        }

        /// <summary>
        /// 绘制 FigmaBridge 服务器端口配置，允许用户避开本机端口冲突。
        /// </summary>
        private void DrawServerPortConfig()
        {
            EditorGUILayout.LabelField("Unity 网关端口", EditorStyles.boldLabel);
            EditorGUI.BeginDisabledGroup(FigmaBridgeServer.IsRunning);
            EditorGUILayout.BeginHorizontal();

            EditorGUI.BeginChangeCheck();
            _serverPort = EditorGUILayout.IntField(_serverPort, GUILayout.MinWidth(PortFieldMinWidth));
            if (EditorGUI.EndChangeCheck())
            {
                _serverPort = Mathf.Clamp(
                    _serverPort,
                    FigmaBridgeServer.DefaultPort,
                    FigmaBridgeServer.MaxPort);
                FigmaBridgeServer.PreferredPort = _serverPort;
            }

            EditorGUILayout.LabelField(
                $"可用范围：{FigmaBridgeServer.DefaultPort}-{FigmaBridgeServer.MaxPort}",
                EditorStyles.miniLabel);

            EditorGUILayout.EndHorizontal();
            EditorGUI.EndDisabledGroup();

            if (FigmaBridgeServer.IsRunning)
            {
                EditorGUILayout.HelpBox(
                    $"服务器运行中，实际地址：{FigmaBridgeServer.CurrentGatewayUrl}",
                    MessageType.Info);
            }
            else
            {
                EditorGUILayout.HelpBox(
                    "如端口被占用，启动时会自动尝试后续端口。",
                    MessageType.None);
            }
        }

        /// <summary>
        /// 绘制连接状态行：绿色/红色圆点 + 状态文字。
        /// </summary>
        private void DrawConnectionStatus()
        {
            bool isRunning = FigmaBridgeServer.IsRunning;

            EditorGUILayout.BeginHorizontal();

            // 状态圆点
            Texture2D dot = isRunning ? _greenDot : _redDot;
            GUILayout.Label(
                new GUIContent(dot),
                GUILayout.Width(DotSize + 4),
                GUILayout.Height(DotSize + 4));

            // 状态文字
            string statusText = isRunning ? $"已连接 ({FigmaBridgeServer.CurrentGatewayUrl})" : "未连接";
            EditorGUILayout.LabelField(statusText);

            EditorGUILayout.EndHorizontal();
        }

        /// <summary>
        /// 绘制当前选中 Prefab 信息。
        /// </summary>
        private void DrawPrefabInfo()
        {
            EditorGUILayout.LabelField("当前 Prefab", EditorStyles.boldLabel);

            var selected = Selection.activeObject;
            string prefabPath = null;

            if (selected != null)
            {
                string assetPath = AssetDatabase.GetAssetPath(selected);
                if (!string.IsNullOrEmpty(assetPath) &&
                    assetPath.EndsWith(".prefab", System.StringComparison.OrdinalIgnoreCase))
                {
                    prefabPath = assetPath;
                }
            }

            if (!string.IsNullOrEmpty(prefabPath))
            {
                string prefabName = Path.GetFileNameWithoutExtension(prefabPath);
                EditorGUILayout.LabelField("名称", prefabName);
                EditorGUILayout.LabelField("路径", prefabPath, EditorStyles.wordWrappedMiniLabel);
            }
            else
            {
                EditorGUILayout.HelpBox(
                    "请在 Project 窗口中选中一个 Prefab 资源。",
                    MessageType.Info);
            }
        }

        /// <summary>
        /// 绘制服务器启动/停止控制按钮。
        /// </summary>
        private void DrawServerControls()
        {
            EditorGUILayout.LabelField("服务器控制", EditorStyles.boldLabel);

            EditorGUILayout.BeginHorizontal();

            bool isRunning = FigmaBridgeServer.IsRunning;

            // 启动按钮
            EditorGUI.BeginDisabledGroup(isRunning);
            if (GUILayout.Button("启动服务器"))
            {
                FigmaBridgeServer.Start();
            }
            EditorGUI.EndDisabledGroup();

            // 停止按钮
            EditorGUI.BeginDisabledGroup(!isRunning);
            if (GUILayout.Button("停止服务器"))
            {
                FigmaBridgeServer.Stop();
            }
            EditorGUI.EndDisabledGroup();

            EditorGUILayout.EndHorizontal();
        }

        /// <summary>
        /// 绘制 "Push to Figma" 按钮。
        /// </summary>
        private void DrawPushButton()
        {
            bool hasPrefab = HasSelectedPrefab();

            EditorGUI.BeginDisabledGroup(!hasPrefab);

            if (GUILayout.Button("Push to Figma", GUILayout.Height(32)))
            {
                ExecutePush();
            }

            EditorGUI.EndDisabledGroup();

            if (!hasPrefab)
            {
                EditorGUILayout.HelpBox("请先选中一个 Prefab。", MessageType.Warning);
            }
        }

        /// <summary>
        /// 绘制最近一次推送信息。
        /// </summary>
        private void DrawLastPushInfo()
        {
            if (!string.IsNullOrEmpty(_lastPushPrefabName))
            {
                EditorGUILayout.LabelField("最近推送", _lastPushPrefabName);
                EditorGUILayout.LabelField("推送时间", _lastPushTime);
            }
        }

        /// <summary>
        /// 绘制日志滚动区域（最近 20 条）。
        /// </summary>
        private void DrawLogArea()
        {
            EditorGUILayout.LabelField("日志", EditorStyles.boldLabel);

            _logScrollPos = EditorGUILayout.BeginScrollView(
                _logScrollPos,
                GUILayout.ExpandHeight(true));

            var logs = BridgeLogger.DisplayLogs;
            if (logs.Count == 0)
            {
                EditorGUILayout.LabelField("暂无日志。", EditorStyles.miniLabel);
            }
            else
            {
                // 从最新到最旧显示
                for (int i = logs.Count - 1; i >= 0; i--)
                {
                    EditorGUILayout.LabelField(logs[i], EditorStyles.wordWrappedMiniLabel);
                }
            }

            EditorGUILayout.EndScrollView();

            // 清空日志按钮
            if (GUILayout.Button("清空日志", EditorStyles.miniButton))
            {
                BridgeLogger.Clear();
                Repaint();
            }
        }

        // ─────────────────────── 操作方法 ───────────────────────

        /// <summary>
        /// 执行 Push 操作：生成 Kiro prompt 文件触发 AI agent 执行 prefab-to-figma skill。
        /// </summary>
        private void ExecutePush()
        {
            var selected = Selection.activeObject;
            if (selected == null) return;

            string prefabPath = AssetDatabase.GetAssetPath(selected);
            if (string.IsNullOrEmpty(prefabPath)) return;

            string prefabName = Path.GetFileNameWithoutExtension(prefabPath);
            string prefabRepoPath = GetRepoPrefabPath(prefabPath);

            string filePath = GenerateKiroPromptFile(prefabRepoPath, prefabName, _figmaFileUrl);

            if (filePath != null)
            {
                _lastPushPrefabName = prefabName;
                _lastPushTime = System.DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

                FigmaBridgeServer.AddLog(
                    $"[Window] 已生成 AI 推送指令：{prefabName}，文件：{filePath}");
                BridgeLogger.Info($"[FigmaBridge Window] 已生成 Kiro prompt 文件：{filePath}");

                EditorUtility.DisplayDialog(
                    "Figma Bridge",
                    $"已生成 {prefabName} 的 AI 推送指令。\n" +
                    "请在 Kiro 中确认执行 prefab-to-figma skill。",
                    "确定");
            }
            else
            {
                FigmaBridgeServer.AddLog($"[Window] 推送失败：{prefabName}");
                BridgeLogger.Error($"[FigmaBridge Window] 推送失败：{prefabName}");
            }
        }

        // ─────────────────────── 工具方法 ───────────────────────

        /// <summary>
        /// 将 Unity 资源路径转换为跨进程使用的 Assets 路径。
        /// </summary>
        /// <param name="assetPath">Unity 资源路径，如 Assets/MagicWarrior/...</param>
        /// <returns>Unity 资源路径，如 Assets/MagicWarrior/...</returns>
        private static string GetRepoPrefabPath(string assetPath)
        {
            return (assetPath ?? "").Replace('\\', '/');
        }

        /// <summary>
        /// 生成 Kiro prompt 文件并写入到触发器目录。
        /// </summary>
        /// <param name="prefabRepoPath">Prefab 仓库相对路径</param>
        /// <param name="prefabName">Prefab 名称（不含扩展名）</param>
        /// <param name="figmaUrl">Figma 文件 URL（可为空）</param>
        /// <returns>生成的文件完整路径，失败返回 null</returns>
        private static string GenerateKiroPromptFile(
            string prefabRepoPath, string prefabName, string figmaUrl)
        {
            try
            {
                string unityProjectRoot = FindUnityProjectRoot();
                string outputDir = Path.Combine(unityProjectRoot, TriggerOutputDir);
                Directory.CreateDirectory(outputDir);

                string timestamp = System.DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                string fileName = $"push-{prefabName}-{timestamp}.md";
                string filePath = Path.Combine(outputDir, fileName);

                string figmaUrlValue = string.IsNullOrEmpty(figmaUrl)
                    ? "未指定，需要 AI agent 询问用户"
                    : figmaUrl;

                string isoTime = System.DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");

                string content =
                    "# Figma Bridge Push 指令\n" +
                    "\n" +
                    "## 参数\n" +
                    "\n" +
                    $"- **Skill**: prefab-to-figma\n" +
                    $"- **Prefab 路径**: {prefabRepoPath}\n" +
                    "- **Canvas 尺寸**: auto\n" +
                    $"- **Figma 文件 URL**: {figmaUrlValue}\n" +
                    $"- **推送时间**: {isoTime}\n" +
                    "\n" +
                    "## 执行说明\n" +
                    "\n" +
                    "请使用 prefab-to-figma skill 将上述 Prefab 导入到 Figma 文件中。\n";

                File.WriteAllText(filePath, content, System.Text.Encoding.UTF8);
                return filePath;
            }
            catch (System.Exception ex)
            {
                FigmaBridgeServer.AddLog($"[Window] 推送失败：{ex.Message}");
                BridgeLogger.Error($"[FigmaBridge Window] 推送失败：{ex.Message}", ex);
                return null;
            }
        }

        /// <summary>
        /// 检查当前是否选中了 Prefab。
        /// </summary>
        private static bool HasSelectedPrefab()
        {
            var selected = Selection.activeObject;
            if (selected == null) return false;

            string path = AssetDatabase.GetAssetPath(selected);
            return !string.IsNullOrEmpty(path) &&
                   path.EndsWith(".prefab", System.StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// 查找当前 Unity 项目根目录。
        /// </summary>
        private static string FindUnityProjectRoot()
        {
            string dataPath = Application.dataPath;
            string unityRoot = Path.GetDirectoryName(dataPath);
            return unityRoot ?? dataPath;
        }

        /// <summary>
        /// 确保状态圆点纹理已创建。
        /// </summary>
        private void EnsureDotTextures()
        {
            if (_greenDot == null)
                _greenDot = CreateDotTexture(new Color(0.2f, 0.8f, 0.2f));
            if (_redDot == null)
                _redDot = CreateDotTexture(new Color(0.8f, 0.2f, 0.2f));
        }

        /// <summary>
        /// 创建指定颜色的小圆点纹理（4x4 像素）。
        /// </summary>
        private static Texture2D CreateDotTexture(Color color)
        {
            var tex = new Texture2D(4, 4, TextureFormat.RGBA32, false);
            var pixels = new Color[16];
            for (int i = 0; i < 16; i++)
                pixels[i] = color;
            tex.SetPixels(pixels);
            tex.Apply();
            tex.hideFlags = HideFlags.DontSave;
            return tex;
        }

        /// <summary>
        /// 销毁缓存的纹理资源。
        /// </summary>
        private void DestroyDotTextures()
        {
            if (_greenDot != null) { DestroyImmediate(_greenDot); _greenDot = null; }
            if (_redDot != null) { DestroyImmediate(_redDot); _redDot = null; }
        }
    }
}
