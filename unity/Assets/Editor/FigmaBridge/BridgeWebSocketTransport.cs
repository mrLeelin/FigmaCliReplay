using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    internal sealed class BridgeWebSocketTransport : IDisposable
    {
        [Serializable] private sealed class Request
        {
            public string type;
            public string role;
            public int protocolVersion;
            public string clientVersion;
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
        private readonly bool _windows;
        private readonly object _sync = new object();
        private readonly Dictionary<string, Record> _records = new Dictionary<string, Record>();
        private readonly HashSet<WebSocket> _sockets = new HashSet<WebSocket>();
        private readonly CancellationTokenSource _stop = new CancellationTokenSource();
        internal string Token { get; } = Guid.NewGuid().ToString("N");

        internal BridgeWebSocketTransport(string version, string projectPath)
        {
            _version = version;
            _windows = Application.platform == RuntimePlatform.WindowsEditor;
            _projectPath = Path.GetFullPath(projectPath).TrimEnd('/', '\\');
        }

        internal async Task Accept(HttpListenerContext context)
        {
            if (!context.Request.IsWebSocketRequest || !IPAddress.IsLoopback(context.Request.RemoteEndPoint.Address)
                || !string.IsNullOrEmpty(context.Request.Headers["Origin"])
                || context.Request.Headers["Authorization"] != "Bearer " + Token)
            {
                context.Response.StatusCode = 403;
                context.Response.Close();
                BridgeLogger.Warn("Unity WebSocket access rejected");
                return;
            }
            WebSocket socket = null;
            var sendLock = new SemaphoreSlim(1, 1);
            try
            {
                socket = (await context.AcceptWebSocketAsync(null)).WebSocket;
                lock (_sync) _sockets.Add(socket);
                using (var handshake = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
                {
                    handshake.CancelAfter(5000);
                    var hello = JsonUtility.FromJson<Request>(await Receive(socket, handshake.Token));
                    if (hello != null && hello.clientVersion != _version)
                    {
                        string error = "Unity Bridge version mismatch: expected " + _version;
                        await Send(socket, sendLock, new Reply { type = "bridge.error", error = error, serverVersion = _version });
                        throw new InvalidOperationException(error);
                    }
                    if (hello == null || hello.type != "bridge.hello" || hello.role != "relay" || hello.protocolVersion != 1
                        || hello.clientVersion != _version || !SameProject(hello.projectPath))
                        throw new InvalidOperationException("UPGRADE_REQUIRED or project identity mismatch");
                    await Send(socket, sendLock, new Reply { type = "bridge.ready", serverVersion = _version, projectPath = _projectPath });
                }
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
            catch (Exception ex)
            {
                if (!_stop.IsCancellationRequested) BridgeLogger.Warn("Unity WebSocket closed: " + ex.Message);
            }
            finally
            {
                if (socket != null) { lock (_sync) _sockets.Remove(socket); socket.Dispose(); }
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
