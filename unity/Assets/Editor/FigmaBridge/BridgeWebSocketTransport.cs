using System;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Unity Bridge 的传输层：Unity 主动连中继的 /unity，一条长连接，断线退避重连。
    ///
    /// 旧形态（本地 TcpListener + 中继按发现文件拨入）已删除：
    /// 它需要发现文件、端口级联、令牌分发，还会在域重载后留下占着旧令牌的监听器。
    /// 出站形态没有本地端口，也就不需要这些。
    /// </summary>
    internal sealed class BridgeWebSocketTransport : IDisposable
    {
        [Serializable] private sealed class Request
        {
            public string type;
            public string role;
            public int protocolVersion;
            public string clientVersion;
            public string bridgeToken;
            public string projectPath;
            public string requestId;
            public string operationId;
            public string action;
            public string body;
            public string query;
        }

        [Serializable] private sealed class Reply
        {
            public string type;
            public string requestId;
            public string status;
            public string serverVersion;
            public string clientVersion;
            public string bridgeToken;
            public string role;
            public string[] capabilities;
            public int protocolVersion = 1;
            public string projectPath;
            public int statusCode;
            public string body;
            public string error;
        }

        private sealed class Record
        {
            internal string Identity;
            internal Reply Reply;
            internal bool ReadOnly;
        }

        private readonly string _version;
        private readonly string _projectPath;
        private readonly string _bridgeToken;
        private readonly bool _windows;
        private readonly object _sync = new object();
        private readonly Dictionary<string, Record> _records = new Dictionary<string, Record>();
        private readonly HashSet<WebSocket> _sockets = new HashSet<WebSocket>();
        private readonly CancellationTokenSource _stop = new CancellationTokenSource();
        private volatile bool _relayClientRegistered;
        private volatile bool _relayClientStarted;

        internal BridgeWebSocketTransport(string version, string projectPath, string bridgeToken)
        {
            _version = version;
            _bridgeToken = bridgeToken ?? string.Empty;
            _windows = Application.platform == RuntimePlatform.WindowsEditor;
            _projectPath = Path.GetFullPath(projectPath).TrimEnd('/', '\\');
        }

        /// <summary>出站会话是否已在中继侧完成注册（供窗口与状态判断使用）。</summary>
        internal bool RelayClientRegistered => _relayClientRegistered;

        /// <summary>开始出站连接（幂等：重复调用不会起第二条连接）。</summary>
        internal void StartRelayClient(string relayUrl)
        {
            if (string.IsNullOrWhiteSpace(relayUrl) || _relayClientStarted) return;
            _relayClientStarted = true;
            _ = Task.Run(() => RunRelayClient(relayUrl));
        }

        private async Task RunRelayClient(string relayUrl)
        {
            int backoffMs = 1000;
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    using (var socket = new ClientWebSocket())
                    {
                        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
                        await socket.ConnectAsync(new Uri(relayUrl), _stop.Token);
                        var sendLock = new SemaphoreSlim(1, 1);
                        lock (_sync) _sockets.Add(socket);
                        try
                        {
                            await Send(socket, sendLock, new Reply
                            {
                                type = "bridge.register",
                                role = "unity",
                                protocolVersion = 1,
                                clientVersion = _version,
                                bridgeToken = _bridgeToken,
                                projectPath = _projectPath,
                                capabilities = new[] { "unity.command" }
                            });
                            using (var handshake = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
                            {
                                handshake.CancelAfter(5000);
                                var ack = JsonUtility.FromJson<Reply>(await Receive(socket, handshake.Token));
                                if (ack != null && ack.type == "bridge.error")
                                    throw new InvalidOperationException(string.IsNullOrEmpty(ack.error) ? "Relay rejected the Unity Bridge session." : ack.error);
                                if (ack == null || ack.type != "bridge.registered" || ack.protocolVersion != 1
                                    || ack.serverVersion != _version || !SameProject(ack.projectPath))
                                    throw new InvalidOperationException("Relay handshake version or project mismatch");
                            }
                            backoffMs = 1000;
                            _relayClientRegistered = true;
                            BridgeLogger.Info("[FigmaBridge] Unity 已出站连接 Relay：" + relayUrl);
                            var heartbeat = RunHeartbeat(socket, sendLock);
                            try { await ProcessRequests(socket, sendLock); }
                            finally { _ = heartbeat; }
                        }
                        finally
                        {
                            _relayClientRegistered = false;
                            lock (_sync) _sockets.Remove(socket);
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    if (_stop.IsCancellationRequested) return;
                }
                catch (WebSocketException ex)
                {
                    // 对端正常关闭/网络断开都走这里：这是可恢复的既有情况，不当错误上报。
                    if (!_stop.IsCancellationRequested) BridgeLogger.Info("[FigmaBridge] Relay 连接已断开：" + ex.Message);
                }
                catch (Exception ex)
                {
                    if (!_stop.IsCancellationRequested) BridgeLogger.Warn("[FigmaBridge] Relay 出站连接失败：" + ex.Message);
                }
                if (_stop.IsCancellationRequested) return;
                try { await Task.Delay(backoffMs, _stop.Token); }
                catch (OperationCanceledException) { return; }
                backoffMs = Math.Min(30000, backoffMs * 2);
            }
        }

        private async Task RunHeartbeat(WebSocket socket, SemaphoreSlim sendLock)
        {
            try
            {
                while (!_stop.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    await Task.Delay(5000, _stop.Token);
                    if (socket.State != WebSocketState.Open) return;
                    await Send(socket, sendLock, new Reply { type = "bridge.heartbeat" });
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception) { /* 心跳失败由命令循环与重连兜底 */ }
        }

        private async Task ProcessRequests(WebSocket socket, SemaphoreSlim sendLock)
        {
            while (socket.State == WebSocketState.Open && !_stop.IsCancellationRequested)
            {
                var request = JsonUtility.FromJson<Request>(await Receive(socket, _stop.Token));
                if (request == null || string.IsNullOrEmpty(request.requestId) || request.requestId.Length > 128)
                    throw new InvalidOperationException("Invalid request identity");
                if (request.type == "bridge.get")
                {
                    Reply snapshot;
                    lock (_sync) snapshot = _records.TryGetValue(request.requestId, out var found)
                        ? found.Reply : new Reply { type = "bridge.response", requestId = request.requestId, status = "unknown", error = "Do not replay an unknown write" };
                    await Send(socket, sendLock, snapshot);
                    continue;
                }
                if (request.type != "bridge.request" || !AllowedAction(request.action)) throw new InvalidOperationException("Unsupported Unity action");
                string identity = request.action + "\n" + request.body + "\n" + request.query;
                Record record;
                bool created = false;
                lock (_sync)
                {
                    if (_records.TryGetValue(request.requestId, out record))
                    {
                        if (record.Identity != identity) throw new InvalidOperationException("Request identity conflict");
                    }
                    else
                    {
                        if (_records.Count >= 1000)
                        {
                            string removable = null;
                            foreach (var entry in _records)
                            {
                                if (entry.Value.ReadOnly && (entry.Value.Reply.status == "completed" || entry.Value.Reply.status == "failed"))
                                { removable = entry.Key; break; }
                            }
                            if (removable != null) _records.Remove(removable);
                        }
                        if (_records.Count >= 1000) throw new InvalidOperationException("Unity task capacity reached");
                        record = new Record { Identity = identity, ReadOnly = IsReadOnly(request.action), Reply = new Reply { type = "bridge.response", requestId = request.requestId, status = "queued" } };
                        _records.Add(request.requestId, record);
                        created = true;
                    }
                }
                await Send(socket, sendLock, record.Reply);
                if (!created) continue;
                var command = new BridgeCommand { Action = "/" + request.action.Substring("unity.".Length), Method = "POST",
                    Body = request.body ?? "{}", OperationId = request.operationId ?? request.requestId };
                command.Started = () => { lock (_sync) record.Reply = new Reply { type = "bridge.response", requestId = request.requestId, status = "running" }; };
                foreach (string pair in (request.query ?? "").Split('&'))
                {
                    if (pair.Length == 0) continue;
                    string[] parts = pair.Split(new[] { '=' }, 2);
                    command.Query.Add(Uri.UnescapeDataString(parts[0]), parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "");
                }
                command.Response = new BridgeCommandResponse((code, contentType, bytes) =>
                {
                    var reply = new Reply { type = "bridge.response", requestId = request.requestId,
                        status = code < 400 ? "completed" : "failed", statusCode = code, body = Encoding.UTF8.GetString(bytes) };
                    lock (_sync) record.Reply = reply;
                    _ = Send(socket, sendLock, reply);
                });
                FigmaBridgeServer.EnqueueCommand(command, this);
            }
        }

        private bool SameProject(string project)
        {
            if (string.IsNullOrWhiteSpace(project)) return false;
            return string.Equals(Path.GetFullPath(project).TrimEnd('/', '\\'), _projectPath,
                _windows ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
        }

        private static bool AllowedAction(string action)
        {
            switch (action)
            {
                case "unity.health": case "unity.ping": case "unity.selected-folder": case "unity.export-selected": case "unity.resolve-image":
                case "unity.pull-latest": case "unity.import-selected-images": case "unity.sync-selected-text-style":
                case "unity.sync-prefab-hierarchy": case "unity.prefab-import-canvas": case "unity.figma-to-prefab-import": case "unity.logs": return true;
                default: return false;
            }
        }

        private static bool IsReadOnly(string action)
        {
            return action == "unity.health" || action == "unity.ping" || action == "unity.selected-folder" || action == "unity.logs";
        }

        private async Task Send(WebSocket socket, SemaphoreSlim gate, Reply reply)
        {
            try
            {
                await gate.WaitAsync(_stop.Token);
                try
                {
                    if (socket.State != WebSocketState.Open) return;
                    byte[] bytes = Encoding.UTF8.GetBytes(JsonUtility.ToJson(reply));
                    await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _stop.Token);
                }
                finally { gate.Release(); }
            }
            catch (Exception ex) { if (!_stop.IsCancellationRequested) BridgeLogger.Warn("Unity result retained after send failure: " + ex.Message); }
        }

        private static async Task<string> Receive(WebSocket socket, CancellationToken token)
        {
            using (var stream = new MemoryStream())
            {
                byte[] buffer = new byte[8192];
                WebSocketReceiveResult part;
                do
                {
                    part = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (part.MessageType == WebSocketMessageType.Close)
                    {
                        // 对端正常关闭：安静收尾，不当异常上报。
                        try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); }
                        catch { /* 对端可能已断开 */ }
                        throw new OperationCanceledException("peer closed the WebSocket");
                    }
                    if (part.MessageType != WebSocketMessageType.Text) throw new InvalidOperationException("Text frames required");
                    stream.Write(buffer, 0, part.Count);
                    if (stream.Length > 16 * 1024 * 1024) throw new InvalidOperationException("Request exceeds 16 MiB");
                } while (!part.EndOfMessage);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }

        public void Dispose()
        {
            _stop.Cancel();
            lock (_sync) foreach (var socket in _sockets) socket.Abort();
        }
    }
}
