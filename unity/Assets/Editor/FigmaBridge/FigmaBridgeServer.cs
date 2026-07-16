using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using ZLog = UnityEngine.Debug;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Figma Bridge HTTP 服务器。
    /// 监听 localhost:32129，为 LKS Figma 插件提供远程网关接口。
    /// 使用 [InitializeOnLoad] 在编辑器启动时自动初始化。
    /// </summary>
    [InitializeOnLoad]
    public static class FigmaBridgeServer
    {
        // ─────────────────────── 常量 ───────────────────────

        /// <summary>默认监听端口</summary>
        internal const int DefaultPort = 32129;

        /// <summary>自动避让时允许尝试的最大端口</summary>
        internal const int MaxPort = 32135;

        /// <summary>EditorPrefs 存储首选监听端口的 key</summary>
        private const string PrefsPortKey = "FigmaBridge_ServerPort";

        /// <summary>监听地址主机名</summary>
        private const string ListenHost = "localhost";

        /// <summary>服务器版本号</summary>
        // BEGIN_RELEASE_VERSION
        private const string Version = "0.1.37";
        // END_RELEASE_VERSION

        /// <summary>临时输出目录前缀（相对于仓库根目录）</summary>
        private const string TmpOutputPrefix = ".tmp/prefab-to-figma/";

        /// <summary>日志最大条数</summary>
        internal const int MaxLogCount = 20;

        private const string ImageImportTargetModeFolder = "folder";
        private const string ImageImportTargetModeReplace = "replaceImage";

        // ─────────────────────── 状态 ───────────────────────

        private static HttpListener _listener;
        private static bool _running;
        private static int _currentPort;

        /// <summary>待处理的请求队列（后台线程写入，主线程消费）</summary>
        private static readonly Queue<HttpListenerContext> PendingContexts =
            new Queue<HttpListenerContext>();

        private static readonly object QueueLock = new object();

        /// <summary>最近一次推送的文档 JSON（LKS 格式）</summary>
        private static string _latestDocumentJson;

        /// <summary>最近一次推送的图片列表</summary>
        private static List<ImageEntry> _latestImages;

        /// <summary>最近一次推送的 token</summary>
        internal static string LatestPushToken { get; private set; } = "";

        /// <summary>最近一次推送的资源数量</summary>
        private static int _latestAssetCount;

        // （previewBase64 / canvas 字段已移除，不再需要预览缓存和相关方法）

        /// <summary>服务器是否正在运行</summary>
        public static bool IsRunning => _running;

        /// <summary>当前实际监听端口，未启动时返回首选端口</summary>
        internal static int CurrentPort => _running ? _currentPort : PreferredPort;

        /// <summary>当前实际监听地址，供窗口和 Figma 插件配置使用</summary>
        internal static string CurrentGatewayUrl => BuildGatewayUrl(CurrentPort);

        /// <summary>用户首选监听端口，会持久化到 EditorPrefs</summary>
        internal static int PreferredPort
        {
            get => SanitizePort(EditorPrefs.GetInt(PrefsPortKey, DefaultPort));
            set => EditorPrefs.SetInt(PrefsPortKey, SanitizePort(value));
        }

        /// <summary>日志列表，供 FigmaBridgeWindow 读取</summary>
        internal static readonly List<string> Logs = new List<string>();

        /// <summary>日志变更回调，供 Window 刷新 UI</summary>
        internal static event Action OnLogChanged;

        // ─────────────────────── 生命周期 ───────────────────────

        /// <summary>
        /// 静态构造函数，编辑器加载时自动调用。
        /// </summary>
        static FigmaBridgeServer()
        {
            // 延迟到下一帧启动，避免在静态构造中做过多初始化
            EditorApplication.delayCall += TryStart;
        }

        /// <summary>
        /// 启动 HTTP 服务器。
        /// </summary>
        public static void Start()
        {
            if (_running) return;

            int preferredPort = PreferredPort;
            string lastError = "";

            for (int port = preferredPort; port <= MaxPort; port++)
            {
                if (TryStartOnPort(port, out lastError))
                    return;
            }

            AddLog($"[FigmaBridge] 启动失败：端口 {preferredPort}-{MaxPort} 均不可用。最后错误：{lastError}");
            ZLog.LogError($"[FigmaBridge] 启动失败：端口 {preferredPort}-{MaxPort} 均不可用。最后错误：{lastError}");
        }

        /// <summary>
        /// 尝试在指定端口启动 HTTP 服务器，失败时释放 listener 并返回错误信息。
        /// </summary>
        private static bool TryStartOnPort(int port, out string error)
        {
            string listenPrefix = BuildListenPrefix(port);

            try
            {
                _listener = new HttpListener();
                _listener.Prefixes.Add(listenPrefix);
                _listener.Start();
                _running = true;
                _currentPort = port;

                // 注册主线程 Update 回调
                EditorApplication.update -= ProcessPendingRequests;
                EditorApplication.update += ProcessPendingRequests;

                // 开始异步接收请求
                BeginAccept();

                AddLog($"[FigmaBridge] 服务器已启动，监听 {listenPrefix}");
                if (port != PreferredPort)
                    AddLog($"[FigmaBridge] 首选端口被占用，已自动切换到 {port}");
                FigmaBridgeGatewayDiscovery.Publish(CurrentGatewayUrl);

                error = "";
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                _running = false;
                _currentPort = 0;

                try
                {
                    _listener?.Close();
                }
                catch
                {
                    // 关闭失败只影响清理，不影响继续尝试下一个端口
                }

                _listener = null;
                AddLog($"[FigmaBridge] 端口 {port} 不可用：{ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// 停止 HTTP 服务器。
        /// </summary>
        public static void Stop()
        {
            if (!_running) return;

            FigmaBridgeGatewayDiscovery.RemoveOwned(CurrentGatewayUrl);
            _running = false;
            EditorApplication.update -= ProcessPendingRequests;

            try
            {
                _listener?.Stop();
                _listener?.Close();
            }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] 停止时出错：{ex.Message}");
            }

            _listener = null;
            _currentPort = 0;
            AddLog("[FigmaBridge] 服务器已停止");
        }

        /// <summary>
        /// 按允许范围修正端口，避免非法端口导致服务器无法启动。
        /// </summary>
        private static int SanitizePort(int port)
        {
            if (port < DefaultPort) return DefaultPort;
            if (port > MaxPort) return MaxPort;
            return port;
        }

        /// <summary>
        /// 构建供 Figma 插件访问的网关地址。
        /// </summary>
        private static string BuildGatewayUrl(int port)
        {
            return $"http://{ListenHost}:{SanitizePort(port)}";
        }

        /// <summary>
        /// 构建 HttpListener 使用的监听前缀，末尾必须包含斜杠。
        /// </summary>
        private static string BuildListenPrefix(int port)
        {
            return $"{BuildGatewayUrl(port)}/";
        }

        /// <summary>
        /// 尝试启动服务器（静默失败）。
        /// </summary>
        private static void TryStart()
        {
            try { Start(); }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] 自动启动失败：{ex.Message}");
            }
        }

        // ─────────────────────── 异步接收 ───────────────────────

        /// <summary>
        /// 开始异步等待下一个 HTTP 请求。
        /// </summary>
        private static void BeginAccept()
        {
            if (!_running || _listener == null) return;

            try
            {
                _listener.BeginGetContext(OnContextReceived, null);
            }
            catch (ObjectDisposedException) { /* 服务器已关闭 */ }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] BeginGetContext 失败：{ex.Message}");
            }
        }

        /// <summary>
        /// 后台线程回调：收到请求后放入队列，由主线程处理。
        /// /ping 路径直接在后台线程响应，不经过 EditorApplication.update，避免抢夺焦点。
        /// </summary>
        private static void OnContextReceived(IAsyncResult ar)
        {
            HttpListenerContext ctx = null;
            try
            {
                if (_listener != null && _listener.IsListening)
                    ctx = _listener.EndGetContext(ar);
            }
            catch (ObjectDisposedException) { return; }
            catch (HttpListenerException) { return; }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] EndGetContext 失败：{ex.Message}");
            }

            if (ctx != null)
            {
                string path = ctx.Request.Url.AbsolutePath.TrimEnd('/');
                if (path == "/ping")
                {
                    // /ping 直接在后台线程响应，不进入主线程队列，避免 Unity 抢夺焦点
                    RespondJson(ctx.Response, 200, "{\"connected\":true}");
                }
                else
                {
                    lock (QueueLock)
                    {
                        PendingContexts.Enqueue(ctx);
                    }
                }
            }

            // 继续接收下一个请求
            BeginAccept();
        }

        // ─────────────────────── 主线程处理 ───────────────────────

        /// <summary>
        /// EditorApplication.update 回调，在主线程中处理排队的 HTTP 请求。
        /// 每帧最多处理 4 个请求，避免卡顿。
        /// </summary>
        private static void ProcessPendingRequests()
        {
            int processed = 0;
            while (processed < 4)
            {
                HttpListenerContext ctx;
                lock (QueueLock)
                {
                    if (PendingContexts.Count == 0) break;
                    ctx = PendingContexts.Dequeue();
                }

                try
                {
                    DispatchRequest(ctx);
                }
                catch (Exception ex)
                {
                    ZLog.LogError($"[FigmaBridge] 处理请求异常：{ex}");
                    TryRespondError(ctx, 500, ex.Message);
                }

                processed++;
            }
        }

        /// <summary>
        /// 根据请求路径和方法分发到对应的处理函数。
        /// </summary>
        private static void DispatchRequest(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var resp = ctx.Response;

            // 所有响应都加 CORS 头
            SetCorsHeaders(resp);

            // OPTIONS 预检请求
            if (req.HttpMethod == "OPTIONS")
            {
                resp.StatusCode = 204;
                resp.Close();
                return;
            }

            string path = req.Url.AbsolutePath.TrimEnd('/');

            switch (path)
            {
                case "/health":
                case "/ping":
                    HandleHealth(ctx);
                    break;
                case "/selected-folder":
                    HandleSelectedFolder(ctx);
                    break;
                case "/export-selected":
                    HandleExportSelected(ctx);
                    break;
                case "/pull-latest":
                    HandlePullLatest(ctx);
                    break;
                case "/resolve-image":
                    HandleResolveImage(ctx);
                    break;
                case "/import-selected-images":
                    HandleImportSelectedImages(ctx);
                    break;
                case "/sync-selected-text-style":
                    HandleSyncSelectedTextStyle(ctx);
                    break;
                case "/sync-prefab-hierarchy":
                    HandleSyncPrefabHierarchy(ctx);
                    break;
                case "/prefab-import-canvas":
                    HandlePrefabImportCanvas(ctx);
                    break;
                default:
                    RespondJson(resp, 404, "{\"error\":\"未知端点\"}");
                    break;
            }
        }

        // ─────────────────────── API 端点 ───────────────────────

        /// <summary>
        /// GET /health → 返回连接状态和项目信息。
        /// </summary>
        private static void HandleHealth(HttpListenerContext ctx)
        {
            List<string> currentPrefabPaths = GetSelectedPrefabPaths();
            List<string> currentPrefabNames = GetSelectedPrefabNames(currentPrefabPaths);
            string currentPrefabPath = currentPrefabPaths.Count > 0 ? currentPrefabPaths[0] : "";
            string currentPrefab = currentPrefabNames.Count > 0 ? currentPrefabNames[0] : "";
            ImageImportTarget imageTarget = ResolveImageImportTarget();
            string selectedFolder = imageTarget.targetFolder;
            var textTarget = GetSelectedTextStyleTargetInfo();
            string projectPath = Path.GetDirectoryName(Application.dataPath) ?? "";
            string projectName = Path.GetFileName(projectPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            var sb = new StringBuilder(512);
            sb.Append("{");
            sb.Append("\"connected\":true,");
            sb.AppendFormat("\"version\":\"{0}\",", EscapeJsonValue(Version));
            sb.AppendFormat("\"projectName\":\"{0}\",", EscapeJsonValue(projectName));
            sb.AppendFormat("\"projectPath\":\"{0}\",", EscapeJsonValue(projectPath));
            sb.AppendFormat("\"currentPrefabName\":\"{0}\",", EscapeJsonValue(currentPrefab));
            sb.AppendFormat("\"currentPrefabPath\":\"{0}\",", EscapeJsonValue(currentPrefabPath));
            AppendJsonArray(sb, "currentPrefabNames", currentPrefabNames);
            sb.Append(",");
            AppendJsonArray(sb, "currentPrefabPaths", currentPrefabPaths);
            sb.Append(",");
            AppendJsonArray(sb, "selectedPrefabPaths", currentPrefabPaths);
            sb.Append(",");
            AppendJsonArray(sb, "prefabPaths", currentPrefabPaths);
            sb.Append(",");
            sb.AppendFormat("\"selectedFolder\":\"{0}\",", EscapeJsonValue(selectedFolder));
            sb.AppendFormat("\"imageTargetMode\":\"{0}\",", EscapeJsonValue(imageTarget.mode));
            sb.AppendFormat("\"replaceAssetPath\":\"{0}\",", EscapeJsonValue(imageTarget.replaceAssetPath));
            sb.AppendFormat("\"imageTargetDisplay\":\"{0}\",", EscapeJsonValue(BuildImageTargetDisplay(imageTarget)));
            sb.AppendFormat("\"selectedTextTargetName\":\"{0}\",", EscapeJsonValue(textTarget.name));
            sb.AppendFormat("\"selectedTextTargetType\":\"{0}\",", EscapeJsonValue(textTarget.type));
            sb.AppendFormat("\"latestPushToken\":\"{0}\"", EscapeJsonValue(LatestPushToken));
            sb.Append("}");
            string json = sb.ToString();
            RespondJson(ctx.Response, 200, json);
        }

        /// <summary>
        /// GET /selected-folder → 返回 Project 窗口当前选中的 Assets 文件夹路径。
        /// </summary>
        private static void HandleSelectedFolder(HttpListenerContext ctx)
        {
            ImageImportTarget imageTarget = ResolveImageImportTarget();
            if (!imageTarget.ok)
            {
                RespondJson(ctx.Response, 400,
                    $"{{\"ok\":false,\"error\":\"{EscapeJsonValue(imageTarget.error)}\"}}");
                return;
            }

            string json = "{" +
                "\"ok\":true," +
                $"\"selectedFolder\":\"{EscapeJsonValue(imageTarget.targetFolder)}\"," +
                $"\"imageTargetMode\":\"{EscapeJsonValue(imageTarget.mode)}\"," +
                $"\"replaceAssetPath\":\"{EscapeJsonValue(imageTarget.replaceAssetPath)}\"," +
                $"\"imageTargetDisplay\":\"{EscapeJsonValue(BuildImageTargetDisplay(imageTarget))}\"" +
                "}";
            AddLog($"[FigmaBridge] 当前图片导入目标：mode={imageTarget.mode}, folder={imageTarget.targetFolder}, replace={imageTarget.replaceAssetPath}");
            RespondJson(ctx.Response, 200, json);
        }

        /// <summary>
        /// POST /export-selected → 解析当前选中 Prefab 并返回 LKS 格式文档。
        /// </summary>
        private static void HandleExportSelected(HttpListenerContext ctx)
        {
            // 获取当前选中的 Prefab 路径
            string prefabPath = GetSelectedPrefabPath();
            if (string.IsNullOrEmpty(prefabPath))
            {
                RespondJson(ctx.Response, 400,
                    "{\"error\":\"请在 Unity 中选中一个 Prefab 资源\"}");
                return;
            }

            AddLog($"[FigmaBridge] 开始导出 Prefab：{prefabPath}");

            string prefabName = Path.GetFileNameWithoutExtension(prefabPath);
            string unityProjectRoot = FindUnityProjectRoot();
            string outputDir = Path.Combine(unityProjectRoot, TmpOutputPrefix + prefabName);

            string parserError;
            if (!RunCSharpExporter(unityProjectRoot, prefabPath, outputDir, out parserError))
            {
                AddLog($"[FigmaBridge] C# 导出失败：{parserError}");
                RespondJson(ctx.Response, 500,
                    "{\"error\":\"C# Prefab 导出失败：" + EscapeJsonValue(parserError) + "\"}");
                return;
            }

            // 读取解析器输出的 JSON
            string jsonPath = Path.Combine(outputDir, "prefab-to-figma.json");
            if (!File.Exists(jsonPath))
            {
                RespondJson(ctx.Response, 500,
                    "{\"error\":\"解析器未生成 prefab-to-figma.json\"}");
                return;
            }

            string sourceJson = File.ReadAllText(jsonPath, Encoding.UTF8);

            // 转换为 LKS 格式
            var (lksJson, images) = PrefabToLksConverter.Convert(sourceJson);

            // 缓存最新推送
            _latestDocumentJson = lksJson;
            _latestImages = images;
            _latestAssetCount = images.Count;
            LatestPushToken = GeneratePushToken();

            // 构建响应
            string responseJson = "{" +
                $"\"document\":{lksJson}," +
                $"\"pushToken\":\"{EscapeJsonValue(LatestPushToken)}\"," +
                $"\"assetCount\":{_latestAssetCount}" +
                "}";

            RespondJson(ctx.Response, 200, responseJson);
            AddLog($"[FigmaBridge] 导出完成：{prefabName}，资源 {_latestAssetCount} 个，Token={LatestPushToken}");
        }

        /// <summary>
        /// GET /pull-latest?afterToken=xxx → 如果有新推送返回文档，否则 204。
        /// </summary>
        private static void HandlePullLatest(HttpListenerContext ctx)
        {
            string afterToken = ctx.Request.QueryString["afterToken"] ?? "";

            // 没有缓存的文档，或 token 相同表示没有新推送
            if (string.IsNullOrEmpty(_latestDocumentJson) || afterToken == LatestPushToken)
            {
                ctx.Response.StatusCode = 204;
                SetCorsHeaders(ctx.Response);
                ctx.Response.Close();
                return;
            }

            string responseJson = "{" +
                $"\"document\":{_latestDocumentJson}," +
                $"\"pushToken\":\"{EscapeJsonValue(LatestPushToken)}\"," +
                $"\"assetCount\":{_latestAssetCount}" +
                "}";

            RespondJson(ctx.Response, 200, responseJson);
        }

        /// <summary>
        /// POST /resolve-image → 根据请求中的路径返回图片原始字节。
        /// 请求体格式：{"path":"assets/ui_bg_00.png"} 或 {"sourceAssetPath":"Assets/..."}
        /// </summary>
        private static void HandleResolveImage(HttpListenerContext ctx)
        {
            // 读取请求体
            string body;
            using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            {
                body = reader.ReadToEnd();
            }

            // 简单提取 path 和 sourceAssetPath
            string requestedPath = ExtractSimpleJsonValue(body, "path");
            string sourceAssetPath = ExtractSimpleJsonValue(body, "sourceAssetPath");

            // 尝试从缓存的图片列表中查找
            string absolutePath = ResolveImageAbsolutePath(requestedPath, sourceAssetPath);

            if (string.IsNullOrEmpty(absolutePath) || !File.Exists(absolutePath))
            {
                RespondJson(ctx.Response, 404,
                    "{\"error\":\"图片文件未找到\"}");
                return;
            }

            // 返回图片原始字节
            try
            {
                byte[] imageBytes = File.ReadAllBytes(absolutePath);
                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = GuessMimeType(absolutePath);
                ctx.Response.ContentLength64 = imageBytes.Length;
                ctx.Response.OutputStream.Write(imageBytes, 0, imageBytes.Length);
                ctx.Response.Close();
            }
            catch (Exception ex)
            {
                RespondJson(ctx.Response, 500,
                    $"{{\"error\":\"读取图片失败：{EscapeJsonValue(ex.Message)}\"}}");
            }
        }

        /// <summary>
        /// POST /import-selected-images → 将 Figma 当前选区导出的图片写入 Unity 当前选中的文件夹。
        /// </summary>
        private static void HandleImportSelectedImages(HttpListenerContext ctx)
        {
            string body = ReadRequestBody(ctx);
            ImportImagesRequest request = ParseImportImagesRequest(body);
            if (request == null || request.images == null || request.images.Count == 0)
            {
                RespondJson(ctx.Response, 400, "{\"error\":\"没有收到可导入的 Figma 图片\"}");
                return;
            }

            ImageImportTarget imageTarget = ResolveImageImportTarget();
            if (!imageTarget.ok)
            {
                RespondJson(ctx.Response, 400,
                    $"{{\"error\":\"{EscapeJsonValue(imageTarget.error)}\"}}");
                return;
            }

            var importedPaths = new List<string>(request.images.Count);
            var errors = new List<string>();
            ImportFigmaImagesToTarget(request, imageTarget, importedPaths, errors);

            bool ok = importedPaths.Count > 0 && errors.Count == 0;
            string responseJson = BuildImportImagesResponse(imageTarget, importedPaths, errors, ok);
            RespondJson(ctx.Response, 200, responseJson);

            if (errors.Count > 0)
            {
                AddLog($"[FigmaBridge] Figma 图片导入完成但存在错误：成功 {importedPaths.Count}，错误 {errors.Count}");
            }
            else
            {
                AddLog($"[FigmaBridge] Figma 图片导入完成：{importedPaths.Count} 张，目标 {BuildImageTargetDisplay(imageTarget)}");
            }
        }

        /// <summary>
        /// POST /sync-selected-text-style → 将 Figma 当前文本样式同步到 Unity 当前选中的 TMP 文本或材质。
        /// </summary>
        private static void HandleSyncSelectedTextStyle(HttpListenerContext ctx)
        {
            string body = ReadRequestBody(ctx);
            TextStyleSyncRequest request = ParseTextStyleSyncRequest(body);
            if (request == null || request.style == null)
            {
                RespondJson(ctx.Response, 400, "{\"ok\":false,\"error\":\"没有收到可同步的 Figma 文本样式\"}");
                return;
            }

            try
            {
                var options = new TextStyleSyncOptions
                {
                    syncColor = request.syncColor,
                    syncFontSize = request.syncFontSize
                };
                TextStyleSyncResult result = FigmaTextStyleSyncUtility.SyncToCurrentSelection(request.style, options);
                RespondJson(ctx.Response, 200, BuildTextStyleSyncResponse(result));
                AddLog($"[FigmaBridge] 字体样式同步完成：Figma={request.style.nodeName}，Unity={result.targetName}，材质={result.materialPath}");
            }
            catch (Exception ex)
            {
                RespondJson(ctx.Response, 400,
                    $"{{\"ok\":false,\"error\":\"{EscapeJsonValue(ex.Message)}\"}}");
                AddLog($"[FigmaBridge] 字体样式同步失败：{ex.Message}");
            }
        }

        /// <summary>
        /// 按 Figma 单选根节点同步当前选中 Prefab 的层级、坐标、尺寸和字号。
        /// </summary>
        private static void HandleSyncPrefabHierarchy(HttpListenerContext ctx)
        {
            string body = ReadRequestBody(ctx);
            FigmaPrefabHierarchySyncRequest request = ParsePrefabHierarchySyncRequest(body);
            if (request == null || request.hierarchy == null || request.hierarchy.root == null)
            {
                RespondJson(ctx.Response, 400, "{\"ok\":false,\"error\":\"没有收到可同步的 Figma 层级数据\"}");
                return;
            }

            string prefabPath = NormalizeUnityPath(request.prefabPath);
            if (string.IsNullOrEmpty(prefabPath))
            {
                prefabPath = GetSelectedPrefabPath();
            }

            if (string.IsNullOrEmpty(prefabPath))
            {
                RespondJson(ctx.Response, 400, "{\"ok\":false,\"error\":\"请先在 Unity Project 中选择一个 Prefab 资源\"}");
                return;
            }

            try
            {
                FigmaPrefabHierarchySyncResult result =
                    FigmaPrefabHierarchySyncUtility.SyncSelectedPrefab(
                        prefabPath,
                        request.hierarchy,
                        request.syncImages,
                        request.imageTargetFolder,
                        request.createBackup,
                        request.dryRun);
                RespondJson(ctx.Response, 200, result.ToJson());
                AddLog($"[FigmaBridge] Prefab 层级同步{(request.dryRun ? "预览" : "应用")}完成：{prefabPath}，新建 {result.summary.created}，删除 {result.summary.deleted}，移动 {result.summary.moved}");
            }
            catch (Exception ex)
            {
                RespondJson(ctx.Response, 400,
                    $"{{\"ok\":false,\"prefabPath\":\"{EscapeJsonValue(prefabPath)}\",\"error\":\"{EscapeJsonValue(ex.Message)}\",\"errors\":[\"{EscapeJsonValue(ex.Message)}\"]}}");
                AddLog($"[FigmaBridge] Prefab 层级同步失败：{ex.Message}");
            }
        }

        /// <summary>
        /// GET /prefab-import-canvas → 返回当前选中 Prefab 导入 Figma 时应使用的 Canvas 尺寸。
        /// POST /prefab-import-canvas → 按请求中的 prefabPaths 返回对应 Canvas 尺寸。
        /// </summary>
        private static void HandlePrefabImportCanvas(HttpListenerContext ctx)
        {
            List<string> prefabPaths = ctx.Request.HttpMethod == "POST"
                ? ParsePrefabImportCanvasRequest(ReadRequestBody(ctx))
                : GetSelectedPrefabPaths();
            if (prefabPaths.Count == 0)
            {
                RespondJson(ctx.Response, 400, "{\"ok\":false,\"error\":\"请提供 prefabPaths，或先在 Unity Project 中选择一个 Prefab 资源\"}");
                return;
            }

            var items = new List<PrefabImportCanvasInfo>();
            foreach (string prefabPath in prefabPaths)
            {
                items.Add(ResolvePrefabImportCanvas(prefabPath));
            }

            RespondJson(ctx.Response, 200, BuildPrefabImportCanvasResponse(items));
        }

        private static string ReadRequestBody(HttpListenerContext ctx)
        {
            using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        /// <summary>
        /// 解析 Figma 图片导入请求，解析失败时返回 null。
        /// </summary>
        private static ImportImagesRequest ParseImportImagesRequest(string body)
        {
            if (string.IsNullOrEmpty(body))
            {
                return null;
            }

            try
            {
                return JsonUtility.FromJson<ImportImagesRequest>(body);
            }
            catch (Exception ex)
            {
                AddLog($"[FigmaBridge] 解析图片导入请求失败：{ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// 解析 Figma 文本样式同步请求，解析失败时返回 null。
        /// </summary>
        private static TextStyleSyncRequest ParseTextStyleSyncRequest(string body)
        {
            if (string.IsNullOrEmpty(body))
            {
                return null;
            }

            try
            {
                return JsonUtility.FromJson<TextStyleSyncRequest>(body);
            }
            catch (Exception ex)
            {
                AddLog($"[FigmaBridge] 解析字体样式同步请求失败：{ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// 解析 Figma 层级同步请求，解析失败时返回 null。
        /// </summary>
        private static FigmaPrefabHierarchySyncRequest ParsePrefabHierarchySyncRequest(string body)
        {
            if (string.IsNullOrEmpty(body))
            {
                return null;
            }

            try
            {
                return JsonUtility.FromJson<FigmaPrefabHierarchySyncRequest>(body);
            }
            catch (Exception ex)
            {
                AddLog($"[FigmaBridge] 解析 Prefab 层级同步请求失败：{ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// 解析按路径读取 Prefab 导入 Canvas 的请求。
        /// </summary>
        private static List<string> ParsePrefabImportCanvasRequest(string body)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(body))
            {
                return result;
            }

            try
            {
                PrefabImportCanvasRequest request = JsonUtility.FromJson<PrefabImportCanvasRequest>(body);
                if (request?.prefabPaths == null)
                {
                    return result;
                }

                var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string rawPath in request.prefabPaths)
                {
                    string prefabPath = NormalizeUnityPrefabAssetPath(rawPath);
                    if (string.IsNullOrEmpty(prefabPath)
                        || !prefabPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    if (visited.Add(prefabPath))
                    {
                        result.Add(prefabPath);
                    }
                }
            }
            catch (Exception ex)
            {
                AddLog($"[FigmaBridge] 解析 Prefab Canvas 请求失败：{ex.Message}");
            }

            return result;
        }

        private static void ImportFigmaImagesToTarget(
            ImportImagesRequest request,
            ImageImportTarget target,
            List<string> importedPaths,
            List<string> errors)
        {
            if (target.mode == ImageImportTargetModeReplace)
            {
                ImportFigmaImageByReplacingSelectedTexture(request, target, importedPaths, errors);
                return;
            }

            ImportFigmaImagesToFolder(request, target.targetFolder, importedPaths, errors);
        }

        /// <summary>
        /// 用单张 Figma 图片直接覆盖 Unity 当前选中的图片资源。
        /// </summary>
        private static void ImportFigmaImageByReplacingSelectedTexture(
            ImportImagesRequest request,
            ImageImportTarget target,
            List<string> importedPaths,
            List<string> errors)
        {
            if (request.images.Count != 1)
            {
                errors.Add($"当前选中图片资源时只能导出 1 张普通图片，当前收到 {request.images.Count} 张。");
                return;
            }

            ImportImageItem item = request.images[0];
            string label = BuildImportImageLabel(item);
            try
            {
                if (string.IsNullOrEmpty(item?.base64))
                {
                    errors.Add($"{label}: 图片数据为空");
                    return;
                }

                byte[] bytes = Convert.FromBase64String(item.base64);
                if (bytes.Length == 0)
                {
                    errors.Add($"{label}: 图片字节为空");
                    return;
                }

                string absolutePath = AssetPathToAbsolutePath(target.replaceAssetPath);
                File.WriteAllBytes(absolutePath, bytes);
                importedPaths.Add(target.replaceAssetPath);

                AssetDatabase.ImportAsset(target.replaceAssetPath, ImportAssetOptions.ForceUpdate);
                ConfigureImportedTextureAsSprite(target.replaceAssetPath, errors);
                AssetDatabase.Refresh();
            }
            catch (Exception ex)
            {
                errors.Add($"{label}: {ex.Message}");
            }
        }

        /// <summary>
        /// 批量写入 Figma 图片文件，并在写入后触发 Unity 资源导入。
        /// </summary>
        private static void ImportFigmaImagesToFolder(
            ImportImagesRequest request,
            string targetFolder,
            List<string> importedPaths,
            List<string> errors)
        {
            var reservedAssetPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            bool assetEditing = false;
            try
            {
                AssetDatabase.StartAssetEditing();
                assetEditing = true;

                for (int i = 0; i < request.images.Count; i++)
                {
                    ImportSingleFigmaImage(request.images[i], targetFolder, request.overwrite, reservedAssetPaths, importedPaths, errors);
                }
            }
            finally
            {
                if (assetEditing)
                {
                    AssetDatabase.StopAssetEditing();
                }
            }

            for (int i = 0; i < importedPaths.Count; i++)
            {
                AssetDatabase.ImportAsset(importedPaths[i], ImportAssetOptions.ForceUpdate);
                ConfigureImportedTextureAsSprite(importedPaths[i], errors);
            }

            if (importedPaths.Count > 0)
            {
                AssetDatabase.Refresh();
            }
        }

        /// <summary>
        /// 写入单张 Figma 图片，失败时记录错误并继续处理后续图片。
        /// </summary>
        private static void ImportSingleFigmaImage(
            ImportImageItem item,
            string targetFolder,
            bool overwrite,
            HashSet<string> reservedAssetPaths,
            List<string> importedPaths,
            List<string> errors)
        {
            if (item == null)
            {
                errors.Add("空图片条目");
                return;
            }

            string label = BuildImportImageLabel(item);
            try
            {
                if (string.IsNullOrEmpty(item.base64))
                {
                    errors.Add($"{label}: 图片数据为空");
                    return;
                }

                byte[] bytes = Convert.FromBase64String(item.base64);
                if (bytes.Length == 0)
                {
                    errors.Add($"{label}: 图片字节为空");
                    return;
                }

                string fileName = SanitizeImageFileName(item.fileName, label);
                string assetPath = MakeAvailableImageAssetPath(targetFolder, fileName, overwrite, reservedAssetPaths);
                string absolutePath = AssetPathToAbsolutePath(assetPath);
                File.WriteAllBytes(absolutePath, bytes);
                reservedAssetPaths?.Add(assetPath);
                importedPaths.Add(assetPath);
            }
            catch (Exception ex)
            {
                errors.Add($"{label}: {ex.Message}");
            }
        }

        /// <summary>
        /// 构建图片导入错误提示中的来源标签。
        /// </summary>
        private static string BuildImportImageLabel(ImportImageItem item)
        {
            if (item == null)
            {
                return "空图片条目";
            }

            return !string.IsNullOrEmpty(item.nodePath)
                ? item.nodePath
                : string.IsNullOrEmpty(item.nodeName) ? item.fileName : item.nodeName;
        }

        /// <summary>
        /// 将新导入的 Figma PNG 配置为 Unity UI 可直接使用的单图 Sprite。
        /// </summary>
        private static void ConfigureImportedTextureAsSprite(string assetPath, List<string> errors)
        {
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null)
            {
                errors.Add($"{assetPath}: 无法获取 TextureImporter");
                return;
            }

            bool changed = false;
            if (importer.textureType != TextureImporterType.Sprite)
            {
                importer.textureType = TextureImporterType.Sprite;
                changed = true;
            }

            if (importer.spriteImportMode != SpriteImportMode.Single)
            {
                importer.spriteImportMode = SpriteImportMode.Single;
                changed = true;
            }

            if (!importer.alphaIsTransparency)
            {
                importer.alphaIsTransparency = true;
                changed = true;
            }

            if (importer.mipmapEnabled)
            {
                importer.mipmapEnabled = false;
                changed = true;
            }

            if (changed)
            {
                importer.SaveAndReimport();
            }
        }

        /// <summary>
        /// 获取 Unity Project 窗口当前选中的 Assets 文件夹路径。
        /// </summary>
        private static string GetSelectedFolderPath()
        {
            ImageImportTarget target = ResolveImageImportTarget();
            return target.ok ? target.targetFolder : null;
        }

        /// <summary>
        /// 解析 Unity 当前选择的图片导入目标：图片直接覆盖，文件夹导入，其他资源导入到所在文件夹。
        /// </summary>
        private static ImageImportTarget ResolveImageImportTarget()
        {
            var selected = Selection.activeObject;
            if (selected == null)
            {
                return ImageImportTarget.Error("请在 Unity Project 窗口中选中一个图片资源、Assets 文件夹或 Assets 下的资源");
            }

            string selectedPath = NormalizeUnityPath(AssetDatabase.GetAssetPath(selected));
            if (string.IsNullOrEmpty(selectedPath))
            {
                return ImageImportTarget.Error("当前选中对象不是 Assets 下的资源");
            }

            if (AssetDatabase.IsValidFolder(selectedPath))
            {
                return ImageImportTarget.Folder(selectedPath);
            }

            if (!IsAssetsPath(selectedPath))
            {
                return ImageImportTarget.Error($"当前选中对象不在 Assets 目录下：{selectedPath}");
            }

            if (IsImageAssetSelection(selected, selectedPath))
            {
                string folder = NormalizeUnityPath(Path.GetDirectoryName(selectedPath) ?? "Assets");
                return ImageImportTarget.Replace(selectedPath, folder);
            }

            string targetFolder = NormalizeUnityPath(Path.GetDirectoryName(selectedPath) ?? "");
            if (IsAssetsPath(targetFolder))
            {
                return ImageImportTarget.Folder(targetFolder);
            }

            return ImageImportTarget.Error($"无法解析当前资源所在文件夹：{selectedPath}");
        }

        /// <summary>
        /// 判断 Unity 资源路径是否位于 Assets 下。
        /// </summary>
        private static bool IsAssetsPath(string assetPath)
        {
            return assetPath == "Assets" || assetPath.StartsWith("Assets/", StringComparison.Ordinal);
        }

        /// <summary>
        /// 判断当前选择是否为可直接覆盖的图片资源。
        /// </summary>
        private static bool IsImageAssetSelection(UnityEngine.Object selected, string assetPath)
        {
            if (selected == null || string.IsNullOrEmpty(assetPath))
            {
                return false;
            }

            string extension = Path.GetExtension(assetPath).ToLowerInvariant();
            bool imageExtension = extension == ".png"
                || extension == ".jpg"
                || extension == ".jpeg"
                || extension == ".webp"
                || extension == ".tga";
            return imageExtension && (selected is Texture2D || selected is Sprite);
        }

        /// <summary>
        /// 构建 Figma UI 展示用的图片导入目标描述。
        /// </summary>
        private static string BuildImageTargetDisplay(ImageImportTarget target)
        {
            if (target == null || !target.ok)
            {
                return target?.error ?? string.Empty;
            }

            if (target.mode == ImageImportTargetModeReplace)
            {
                return $"替换图片：{target.replaceAssetPath}";
            }

            return $"导入文件夹：{target.targetFolder}";
        }

        /// <summary>
        /// 获取 Unity 当前选中的字体同步目标名称，用于 Figma 面板实时展示。
        /// </summary>
        private static (string name, string type) GetSelectedTextStyleTargetInfo()
        {
            UnityEngine.Object activeObject = Selection.activeObject;
            GameObject activeGameObject = Selection.activeGameObject;

            if (activeGameObject != null)
            {
                var tmp = activeGameObject.GetComponent<TMPro.TMP_Text>();
                if (tmp == null)
                {
                    tmp = activeGameObject.GetComponentInChildren<TMPro.TMP_Text>(true);
                }

                if (tmp != null)
                {
                    return (tmp.gameObject.name, tmp.GetType().Name);
                }
            }

            if (activeObject is Material material)
            {
                return (material.name, "Material");
            }

            if (activeObject is TMPro.TMP_FontAsset fontAsset)
            {
                return (fontAsset.name, "TMP_FontAsset");
            }

            return (string.Empty, string.Empty);
        }

        /// <summary>
        /// 清理 Figma 传入的文件名，并统一补齐 PNG 扩展名。
        /// </summary>
        private static string SanitizeImageFileName(string fileName, string fallbackName)
        {
            string rawName = string.IsNullOrEmpty(fileName) ? fallbackName : fileName;
            rawName = Path.GetFileName(rawName);
            if (string.IsNullOrEmpty(rawName))
            {
                rawName = "FigmaImage";
            }

            string baseName = Path.GetFileNameWithoutExtension(rawName);
            if (string.IsNullOrEmpty(baseName))
            {
                baseName = "FigmaImage";
            }

            foreach (char invalidChar in Path.GetInvalidFileNameChars())
            {
                baseName = baseName.Replace(invalidChar, '_');
            }

            baseName = baseName.Trim();
            if (string.IsNullOrEmpty(baseName))
            {
                baseName = "FigmaImage";
            }

            return baseName + ".png";
        }

        /// <summary>
        /// 生成不会误覆盖现有文件的 Unity 资源路径。
        /// </summary>
        private static string MakeAvailableImageAssetPath(
            string targetFolder,
            string fileName,
            bool overwrite,
            HashSet<string> reservedAssetPaths)
        {
            string baseName = Path.GetFileNameWithoutExtension(fileName);
            string extension = Path.GetExtension(fileName);
            if (string.IsNullOrEmpty(extension))
            {
                extension = ".png";
            }

            string assetPath = NormalizeUnityPath(Path.Combine(targetFolder, baseName + extension));
            if (!IsAssetPathReserved(assetPath, reservedAssetPaths)
                && (overwrite || !File.Exists(AssetPathToAbsolutePath(assetPath))))
            {
                return assetPath;
            }

            for (int i = 1; i < 10000; i++)
            {
                string candidate = NormalizeUnityPath(Path.Combine(targetFolder, $"{baseName}_{i:00}{extension}"));
                if (!IsAssetPathReserved(candidate, reservedAssetPaths)
                    && !File.Exists(AssetPathToAbsolutePath(candidate)))
                {
                    return candidate;
                }
            }

            throw new IOException($"无法生成唯一文件名：{fileName}");
        }

        /// <summary>
        /// 判断目标路径是否已被当前批次占用，避免同批多图清洗成同名时互相覆盖。
        /// </summary>
        private static bool IsAssetPathReserved(string assetPath, HashSet<string> reservedAssetPaths)
        {
            return reservedAssetPaths != null && reservedAssetPaths.Contains(assetPath);
        }

        /// <summary>
        /// 将 Unity 资源路径转换为磁盘绝对路径，并确保仍位于 Assets 目录下。
        /// </summary>
        private static string AssetPathToAbsolutePath(string assetPath)
        {
            string unityRoot = Path.GetDirectoryName(Application.dataPath);
            string absolutePath = Path.GetFullPath(Path.Combine(unityRoot ?? "", assetPath));
            string assetsRoot = Path.GetFullPath(Application.dataPath);

            if (!absolutePath.StartsWith(assetsRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException($"目标路径不在 Assets 目录下：{assetPath}");
            }

            return absolutePath;
        }

        /// <summary>
        /// 将系统路径分隔符统一为 Unity 资源路径分隔符。
        /// </summary>
        private static string NormalizeUnityPath(string path)
        {
            return (path ?? "").Replace('\\', '/');
        }

        /// <summary>
        /// 将仓库相对或 Unity 资源路径归一化为 AssetDatabase 可读取的 Assets 路径。
        /// </summary>
        private static string NormalizeUnityPrefabAssetPath(string path)
        {
            string normalized = NormalizeUnityPath(path).Trim();
            if (string.IsNullOrEmpty(normalized))
            {
                return "";
            }

            if (Path.IsPathRooted(normalized) || normalized.StartsWith("/", StringComparison.Ordinal))
            {
                return "";
            }

            string[] segments = normalized.Split('/');
            for (int i = 0; i < segments.Length; i++)
            {
                if (string.IsNullOrEmpty(segments[i]) || segments[i] == "." || segments[i] == "..")
                {
                    return "";
                }
            }

            int firstSlash = normalized.IndexOf('/');
            if (!normalized.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) &&
                firstSlash > 0 &&
                normalized.Substring(firstSlash + 1).StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
            {
                normalized = normalized.Substring(firstSlash + 1);
            }

            if (!normalized.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
            {
                return "";
            }

            return normalized;
        }

        /// <summary>
        /// 构建图片导入结果 JSON，供 Figma 插件展示成功和错误明细。
        /// </summary>
        private static string BuildImportImagesResponse(
            ImageImportTarget target,
            List<string> importedPaths,
            List<string> errors,
            bool ok)
        {
            var sb = new StringBuilder(512);
            sb.Append("{");
            sb.AppendFormat("\"ok\":{0},", ok ? "true" : "false");
            sb.AppendFormat("\"targetFolder\":\"{0}\",", EscapeJsonValue(target?.targetFolder));
            sb.AppendFormat("\"targetMode\":\"{0}\",", EscapeJsonValue(target?.mode));
            sb.AppendFormat("\"replaceAssetPath\":\"{0}\",", EscapeJsonValue(target?.replaceAssetPath));
            sb.AppendFormat("\"targetDisplay\":\"{0}\",", EscapeJsonValue(BuildImageTargetDisplay(target)));
            sb.AppendFormat("\"importedCount\":{0},", importedPaths.Count);
            sb.AppendFormat("\"errorCount\":{0},", errors.Count);
            AppendJsonArray(sb, "imported", importedPaths);
            sb.Append(",");
            AppendJsonArray(sb, "errors", errors);
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// 构建字体样式同步结果 JSON，供 Figma 插件展示目标和材质路径。
        /// </summary>
        private static string BuildTextStyleSyncResponse(TextStyleSyncResult result)
        {
            var sb = new StringBuilder(256);
            sb.Append("{");
            sb.AppendFormat("\"ok\":{0},", result != null && result.ok ? "true" : "false");
            sb.AppendFormat("\"figmaNodeName\":\"{0}\",", EscapeJsonValue(result?.figmaNodeName));
            sb.AppendFormat("\"targetName\":\"{0}\",", EscapeJsonValue(result?.targetName));
            sb.AppendFormat("\"targetType\":\"{0}\",", EscapeJsonValue(result?.targetType));
            sb.AppendFormat("\"materialPath\":\"{0}\",", EscapeJsonValue(result?.materialPath));
            sb.AppendFormat("\"syncColor\":{0},", result == null || result.syncColor ? "true" : "false");
            sb.AppendFormat("\"syncFontSize\":{0},", result == null || result.syncFontSize ? "true" : "false");
            AppendJsonArray(sb, "warnings", result?.warnings ?? new List<string>());
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// 构建 Prefab 导入 Canvas 响应 JSON。
        /// </summary>
        private static string BuildPrefabImportCanvasResponse(List<PrefabImportCanvasInfo> items)
        {
            var sb = new StringBuilder(512);
            sb.Append("{\"ok\":true,\"items\":[");
            for (int i = 0; i < items.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(",");
                }

                PrefabImportCanvasInfo item = items[i];
                sb.Append("{");
                sb.AppendFormat("\"prefabPath\":\"{0}\",", EscapeJsonValue(item.prefabPath));
                sb.AppendFormat("\"canvas\":\"{0}\",", EscapeJsonValue(item.canvas));
                sb.AppendFormat("\"width\":{0},", FormatJsonNumber(item.width));
                sb.AppendFormat("\"height\":{0},", FormatJsonNumber(item.height));
                sb.AppendFormat("\"source\":\"{0}\",", EscapeJsonValue(item.source));
                sb.AppendFormat("\"warning\":\"{0}\"", EscapeJsonValue(item.warning));
                sb.Append("}");
            }

            sb.Append("]}");
            return sb.ToString();
        }

        /// <summary>
        /// 写入字符串数组 JSON 字段。
        /// </summary>
        private static void AppendJsonArray(StringBuilder sb, string fieldName, List<string> values)
        {
            sb.AppendFormat("\"{0}\":[", fieldName);
            for (int i = 0; i < values.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(",");
                }

                sb.AppendFormat("\"{0}\"", EscapeJsonValue(values[i]));
            }

            sb.Append("]");
        }

        // ─────────────────────── 图片路径解析 ───────────────────────

        /// <summary>
        /// 根据请求的路径信息，从缓存的图片列表或磁盘路径中解析出绝对路径。
        /// </summary>
        private static string ResolveImageAbsolutePath(string requestedPath, string sourceAssetPath)
        {
            // 优先从缓存的图片列表中匹配
            if (_latestImages != null && !string.IsNullOrEmpty(requestedPath))
            {
                for (int i = 0; i < _latestImages.Count; i++)
                {
                    if (_latestImages[i].relativePath == requestedPath)
                        return _latestImages[i].absolutePath;
                }
            }

            // 回退：尝试用 sourceAssetPath 拼接绝对路径
            if (!string.IsNullOrEmpty(sourceAssetPath))
            {
                string normalizedAssetPath = NormalizeUnityPrefabAssetPath(sourceAssetPath);
                if (!string.IsNullOrEmpty(normalizedAssetPath))
                {
                    try
                    {
                        string fullPath = AssetPathToAbsolutePath(normalizedAssetPath);
                        if (File.Exists(fullPath))
                            return fullPath;
                    }
                    catch (InvalidOperationException)
                    {
                        return null;
                    }
                }
            }

            return null;
        }

        // ─────────────────────── C# 导出器调用 ───────────────────────

        /// <summary>
        /// 使用 C# 导出器解析 Prefab，输出与 Python parser 兼容的中间 JSON。
        /// </summary>
        private static bool RunCSharpExporter(
            string repoRoot,
            string prefabPath,
            string outputDir,
            out string error)
        {
            AddLog("[FigmaBridge] 使用 C# PrefabToFigma 导出器");
            bool success = PrefabToFigmaExporter.TryExport(
                repoRoot,
                prefabPath,
                outputDir,
                out string jsonPath,
                out error);

            if (!success)
            {
                ZLog.LogWarning($"[FigmaBridge] C# 导出器失败：{error}");
                return false;
            }

            AddLog($"[FigmaBridge] C# 导出器已生成：{jsonPath}");
            return true;
        }

        // ─────────────────────── 工具方法 ───────────────────────

        /// <summary>
        /// 获取当前 Unity 编辑器中选中的 Prefab 资源路径。
        /// </summary>
        private static string GetSelectedPrefabPath()
        {
            List<string> paths = GetSelectedPrefabPaths();
            return paths.Count > 0 ? paths[0] : null;
        }

        /// <summary>
        /// 获取当前 Unity 编辑器中选中的所有 Prefab 资源路径，保持选择顺序并去重。
        /// </summary>
        private static List<string> GetSelectedPrefabPaths()
        {
            var paths = new List<string>();
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            UnityEngine.Object[] selectedObjects = Selection.objects;
            if (selectedObjects == null || selectedObjects.Length == 0)
            {
                return paths;
            }

            foreach (UnityEngine.Object selected in selectedObjects)
            {
                if (selected == null)
                {
                    continue;
                }

                string path = AssetDatabase.GetAssetPath(selected);
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }

                if (!path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (visited.Add(path))
                {
                    paths.Add(path);
                }
            }

            return paths;
        }

        /// <summary>
        /// 获取当前选中 Prefab 的名称（不含扩展名）。
        /// </summary>
        private static string GetSelectedPrefabName()
        {
            string path = GetSelectedPrefabPath();
            return string.IsNullOrEmpty(path) ? "" : Path.GetFileNameWithoutExtension(path);
        }

        /// <summary>
        /// 根据 Prefab 路径列表获取对应的资源名称列表。
        /// </summary>
        private static List<string> GetSelectedPrefabNames(List<string> prefabPaths)
        {
            var names = new List<string>();
            if (prefabPaths == null)
            {
                return names;
            }

            foreach (string path in prefabPaths)
            {
                if (string.IsNullOrEmpty(path))
                {
                    continue;
                }

                names.Add(Path.GetFileNameWithoutExtension(path));
            }

            return names;
        }

        /// <summary>
        /// 解析 Prefab 导入 Figma 时应使用的 Canvas 尺寸。
        /// </summary>
        private static PrefabImportCanvasInfo ResolvePrefabImportCanvas(string prefabPath)
        {
            string normalizedPath = NormalizeUnityPath(prefabPath ?? "");
            var result = new PrefabImportCanvasInfo
            {
                prefabPath = normalizedPath,
                canvas = "auto",
                source = "auto",
                warning = ""
            };

            GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(normalizedPath);
            if (prefabAsset == null)
            {
                result.warning = $"无法加载 Prefab：{normalizedPath}";
                return result;
            }

            RectTransform rootRect = prefabAsset.GetComponent<RectTransform>();
            if (rootRect == null)
            {
                result.warning = $"Prefab 根节点没有 RectTransform：{normalizedPath}";
                return result;
            }

            Vector2 size = rootRect.rect.size;
            string source = "rootRect";
            if (IsFullStretchZeroRect(rootRect))
            {
                size = GetCurrentGameViewSize();
                source = "gameView";
            }

            if (!HasPositiveSize(size))
            {
                size = rootRect.sizeDelta;
                source = "rootSizeDelta";
            }

            if (!HasPositiveSize(size))
            {
                result.warning = $"无法解析 Prefab 根节点导入尺寸：{normalizedPath}";
                return result;
            }

            result.width = size.x;
            result.height = size.y;
            result.canvas = $"{FormatJsonNumber(size.x)}x{FormatJsonNumber(size.y)}";
            result.source = source;
            return result;
        }

        /// <summary>
        /// 判断 RectTransform 是否为全屏拉伸且四边偏移为 0 的根节点布局。
        /// </summary>
        private static bool IsFullStretchZeroRect(RectTransform rect)
        {
            if (rect == null)
            {
                return false;
            }

            return Approximately(rect.anchorMin.x, 0f)
                && Approximately(rect.anchorMin.y, 0f)
                && Approximately(rect.anchorMax.x, 1f)
                && Approximately(rect.anchorMax.y, 1f)
                && Approximately(rect.anchoredPosition.x, 0f)
                && Approximately(rect.anchoredPosition.y, 0f)
                && Approximately(rect.sizeDelta.x, 0f)
                && Approximately(rect.sizeDelta.y, 0f);
        }

        /// <summary>
        /// 获取当前 GameView 尺寸，失败时回退到屏幕设置或常见横屏尺寸。
        /// </summary>
        private static Vector2 GetCurrentGameViewSize()
        {
            Vector2 gameViewSize = GetGameViewTargetSizeByReflection();
            if (HasPositiveSize(gameViewSize))
            {
                return gameViewSize;
            }

            int width = Screen.width;
            int height = Screen.height;
            if (width > 0 && height > 0)
            {
                return new Vector2(width, height);
            }

            return new Vector2(2160f, 1080f);
        }

        /// <summary>
        /// 通过 UnityEditor.GameView 反射读取当前目标渲染尺寸。
        /// </summary>
        private static Vector2 GetGameViewTargetSizeByReflection()
        {
            try
            {
                Type gameViewType = Type.GetType("UnityEditor.GameView,UnityEditor");
                if (gameViewType == null)
                {
                    return Vector2.zero;
                }

                var getMainGameView = gameViewType.GetMethod(
                    "GetMainGameView",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
                object gameView = getMainGameView?.Invoke(null, null);
                if (gameView == null)
                {
                    return Vector2.zero;
                }

                var targetSizeProperty = gameViewType.GetProperty(
                    "targetSize",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
                object targetSize = targetSizeProperty?.GetValue(gameView, null);
                return targetSize is Vector2 vector ? vector : Vector2.zero;
            }
            catch (Exception ex)
            {
                AddLog($"[FigmaBridge] 读取 GameView 尺寸失败：{ex.Message}");
                return Vector2.zero;
            }
        }

        /// <summary>
        /// 判断尺寸是否包含正宽高。
        /// </summary>
        private static bool HasPositiveSize(Vector2 size)
        {
            return size.x > 0f && size.y > 0f;
        }

        /// <summary>
        /// 浮点近似比较。
        /// </summary>
        private static bool Approximately(float a, float b)
        {
            return Mathf.Abs(a - b) <= 0.001f;
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
        /// 生成推送 token（基于时间戳）。
        /// </summary>
        private static string GeneratePushToken()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
        }

        /// <summary>
        /// 设置 CORS 响应头。
        /// </summary>
        private static void SetCorsHeaders(HttpListenerResponse resp)
        {
            resp.Headers.Set("Access-Control-Allow-Origin", "*");
            resp.Headers.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            resp.Headers.Set("Access-Control-Allow-Headers", "Content-Type");
        }

        /// <summary>
        /// 发送 JSON 响应。
        /// </summary>
        private static void RespondJson(HttpListenerResponse resp, int statusCode, string json)
        {
            try
            {
                byte[] buffer = Encoding.UTF8.GetBytes(json);
                resp.StatusCode = statusCode;
                resp.ContentType = "application/json; charset=utf-8";
                resp.ContentLength64 = buffer.Length;
                resp.OutputStream.Write(buffer, 0, buffer.Length);
                resp.Close();
            }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] 发送响应失败：{ex.Message}");
            }
        }

        /// <summary>
        /// 尝试发送错误响应（不抛出异常）。
        /// </summary>
        private static void TryRespondError(HttpListenerContext ctx, int statusCode, string message)
        {
            try
            {
                RespondJson(ctx.Response, statusCode,
                    $"{{\"error\":\"{EscapeJsonValue(message)}\"}}");
            }
            catch { /* 忽略发送失败 */ }
        }

        /// <summary>
        /// 转义 JSON 字符串中的特殊字符。
        /// </summary>
        private static string EscapeJsonValue(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
        }

        /// <summary>
        /// 格式化 JSON 数字，避免受本机小数点区域设置影响。
        /// </summary>
        private static string FormatJsonNumber(float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                return "0";
            }

            return value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// 从简单 JSON 对象中提取指定 key 的字符串值。
        /// </summary>
        private static string ExtractSimpleJsonValue(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return "";

            string pattern = "\"" + key + "\"";
            int idx = json.IndexOf(pattern, StringComparison.Ordinal);
            if (idx < 0) return "";

            int colonIdx = json.IndexOf(':', idx + pattern.Length);
            if (colonIdx < 0) return "";

            int valStart = json.IndexOf('"', colonIdx + 1);
            if (valStart < 0) return "";

            int valEnd = json.IndexOf('"', valStart + 1);
            if (valEnd < 0) return "";

            return json.Substring(valStart + 1, valEnd - valStart - 1);
        }

        /// <summary>
        /// 根据文件扩展名猜测 MIME 类型。
        /// </summary>
        private static string GuessMimeType(string filePath)
        {
            string ext = Path.GetExtension(filePath).ToLowerInvariant();
            switch (ext)
            {
                case ".png":  return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".gif":  return "image/gif";
                case ".webp": return "image/webp";
                case ".tga":  return "image/x-tga";
                default:      return "application/octet-stream";
            }
        }

        /// <summary>
        /// Figma 图片批量导入请求。
        /// </summary>
        [Serializable]
        private sealed class ImportImagesRequest
        {
            /// <summary>是否允许覆盖同名文件，默认 false。</summary>
            public bool overwrite;

            /// <summary>待写入 Unity 的图片列表。</summary>
            public List<ImportImageItem> images;
        }

        /// <summary>
        /// 单张 Figma 图片导入数据。
        /// </summary>
        [Serializable]
        private sealed class ImportImageItem
        {
            /// <summary>导入后的建议文件名。</summary>
            public string fileName;

            /// <summary>Figma 节点名称，用于错误提示。</summary>
            public string nodeName;

            /// <summary>Figma 节点 ID，用于问题定位。</summary>
            public string nodeId;

            /// <summary>Figma 节点路径，用于问题定位。</summary>
            public string nodePath;

            /// <summary>PNG 图片字节的 Base64 文本。</summary>
            public string base64;
        }

        /// <summary>
        /// 按 Prefab 路径读取导入 Canvas 的请求。
        /// </summary>
        [Serializable]
        private sealed class PrefabImportCanvasRequest
        {
            /// <summary>仓库相对路径或 Unity Assets 路径。</summary>
            public List<string> prefabPaths;
        }

        /// <summary>
        /// Prefab 导入 Figma 使用的 Canvas 尺寸信息。
        /// </summary>
        private sealed class PrefabImportCanvasInfo
        {
            /// <summary>Prefab 的 Unity 资源路径。</summary>
            public string prefabPath;

            /// <summary>传给 Python 导出器的 Canvas 字符串。</summary>
            public string canvas;

            /// <summary>Canvas 宽度。</summary>
            public float width;

            /// <summary>Canvas 高度。</summary>
            public float height;

            /// <summary>尺寸来源。</summary>
            public string source;

            /// <summary>无法解析时的提示。</summary>
            public string warning;
        }

        /// <summary>
        /// Figma 文本样式同步请求。
        /// </summary>
        [Serializable]
        private sealed class TextStyleSyncRequest
        {
            /// <summary>待同步的 Figma 文本样式数据。</summary>
            public FigmaTextStylePayload style;

            /// <summary>是否同步 TMP 文本颜色，默认 true。</summary>
            public bool syncColor = true;

            /// <summary>是否同步 TMP 文本字号，默认 true。</summary>
            public bool syncFontSize = true;
        }

        /// <summary>
        /// Figma 层级同步 HTTP 请求。
        /// </summary>
        [Serializable]
        private sealed class FigmaPrefabHierarchySyncRequest
        {
            /// <summary>目标 Prefab 的 Unity 资源路径。优先使用该稳定路径，避免执行时 Unity Selection 被其它窗口抢走。</summary>
            public string prefabPath;

            /// <summary>Figma 插件采集的层级数据。</summary>
            public FigmaPrefabHierarchyDocument hierarchy;

            /// <summary>是否同步 Figma 图片到匹配的 Unity Image.sprite。</summary>
            public bool syncImages;

            /// <summary>图片资源导入目标目录。</summary>
            public string imageTargetFolder;

            /// <summary>应用变更前是否生成 Prefab 备份。</summary>
            public bool createBackup;

            /// <summary>是否只预览变更，不保存 Prefab 或导入图片。</summary>
            public bool dryRun;
        }

        private sealed class ImageImportTarget
        {
            public bool ok;
            public string mode;
            public string targetFolder;
            public string replaceAssetPath;
            public string error;

            /// <summary>创建文件夹导入目标。</summary>
            public static ImageImportTarget Folder(string targetFolder)
            {
                return new ImageImportTarget
                {
                    ok = true,
                    mode = ImageImportTargetModeFolder,
                    targetFolder = targetFolder ?? string.Empty,
                    replaceAssetPath = string.Empty,
                    error = string.Empty
                };
            }

            /// <summary>创建图片覆盖目标。</summary>
            public static ImageImportTarget Replace(string replaceAssetPath, string targetFolder)
            {
                return new ImageImportTarget
                {
                    ok = true,
                    mode = ImageImportTargetModeReplace,
                    targetFolder = targetFolder ?? string.Empty,
                    replaceAssetPath = replaceAssetPath ?? string.Empty,
                    error = string.Empty
                };
            }

            /// <summary>创建解析失败结果。</summary>
            public static ImageImportTarget Error(string error)
            {
                return new ImageImportTarget
                {
                    ok = false,
                    mode = string.Empty,
                    targetFolder = string.Empty,
                    replaceAssetPath = string.Empty,
                    error = error ?? string.Empty
                };
            }
        }

        /// <summary>
        /// 添加日志条目，保持最多 MaxLogCount 条。
        /// </summary>
        internal static void AddLog(string message)
        {
            string timestamped = $"[{DateTime.Now:HH:mm:ss}] {message}";
            Logs.Add(timestamped);

            // 超出上限时移除最早的条目
            while (Logs.Count > MaxLogCount)
                Logs.RemoveAt(0);

            ZLog.Log(message);
            OnLogChanged?.Invoke();
        }
    }
}
