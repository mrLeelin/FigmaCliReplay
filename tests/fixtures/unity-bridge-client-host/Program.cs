using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MagicWarrior.Editor.FigmaBridge;

/// <summary>
/// 出站客户端宿主：跑真实的 BridgeWebSocketTransport（client 模式）连真实中继。
/// 既可用 dotnet 运行，也可用 Unity 自带的 mono.exe 运行，从而覆盖两套运行时。
/// 用法：BridgeClientHost &lt;version&gt; &lt;projectPath&gt; &lt;bridgeToken&gt; &lt;relayUrl&gt;
/// </summary>
internal static class Program
{
    static async Task Main(string[] args)
    {
        var transport = new BridgeWebSocketTransport(args[0], args[1], args[2]);
        transport.StartRelayClient(args[3]);
        Console.WriteLine(JsonSerializer.Serialize(new { relayUrl = args[2], projectPath = args[1], version = args[0] }));
        Console.Out.Flush();
        await Task.Delay(Timeout.Infinite);
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
        internal static void Info(string message) => Console.Error.WriteLine(message);
        internal static void Warn(string message) => Console.Error.WriteLine(message);
        internal static void Error(string message) => Console.Error.WriteLine(message);
    }

    internal static class FigmaBridgeServer
    {
        internal static void EnqueueCommand(BridgeCommand command, BridgeWebSocketTransport transport)
        {
            command.Started?.Invoke();
            var body = JsonSerializer.Serialize(new { action = command.Action, operationId = command.OperationId, ok = true });
            command.Response.Complete(200, "application/json", System.Text.Encoding.UTF8.GetBytes(body));
        }
    }
}
