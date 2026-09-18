using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MagicWarrior.Editor.FigmaBridge;

internal static class Program
{
    static async Task Main(string[] args)
    {
        int port;
        do
        {
            var reservation = new TcpListener(IPAddress.Loopback, 0);
            reservation.Start();
            port = ((IPEndPoint)reservation.LocalEndpoint).Port;
            reservation.Stop();
        } while (port == 32130 || port == 32131);
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        using var transport = new BridgeWebSocketTransport(args[0], args[1]);
        Console.WriteLine(JsonSerializer.Serialize(new { port, token = transport.Token }));
        while (true) _ = transport.Accept(await listener.GetContextAsync());
    }
}

// Only Unity services are substituted; the transport and response classes are production source.
namespace UnityEngine
{
    public enum RuntimePlatform { WindowsEditor, LinuxEditor }
    public static class Application
    {
        public static RuntimePlatform platform => OperatingSystem.IsWindows() ? RuntimePlatform.WindowsEditor : RuntimePlatform.LinuxEditor;
    }
    public static class JsonUtility
    {
        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions { IncludeFields = true };
        public static T FromJson<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
        public static string ToJson(object value) => JsonSerializer.Serialize(value, value.GetType(), Options);
    }
}

namespace MagicWarrior.Editor.FigmaBridge
{
    internal static class BridgeLogger
    {
        internal static void Warn(string message) => Console.Error.WriteLine(message);
    }
    internal static class FigmaBridgeServer
    {
        private static int _executions;
        internal static void EnqueueCommand(BridgeCommand command, BridgeWebSocketTransport transport = null)
        {
            _ = Task.Run(async () =>
            {
                if (command.Action != "/health") await Task.Delay(150);
                command.Started?.Invoke();
                int count = Interlocked.Increment(ref _executions);
                if (command.Action != "/health") await Task.Delay(150);
                command.Response.Complete(200, "application/json", Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
                {
                    count, action = command.Action, body = command.Body, limit = command.Query["limit"], operationId = command.OperationId
                })));
            });
        }
    }
}
