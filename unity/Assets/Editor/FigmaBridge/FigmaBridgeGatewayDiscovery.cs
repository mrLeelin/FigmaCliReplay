using System;
using System.Diagnostics;
using System.IO;
using UnityEngine;
using ZLog = MagicWarrior.Editor.FigmaBridge.BridgeLogger;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>维护当前 Unity 项目的实际网关监听地址。</summary>
    internal static class FigmaBridgeGatewayDiscovery
    {
        private const int SchemaVersion = 1;

        [Serializable]
        private sealed class GatewayRecord
        {
            public int version;
            public string projectPath;
            public string gatewayUrl;
            public int processId;
            public string updatedAtUtc;
            public string bridgeToken;
        }

        private static string ProjectPath => NormalizePath(Path.Combine(Application.dataPath, ".."));
        private static string DiscoveryDirectory => Path.Combine(ProjectPath, "Library", "FigmaBridge", "gateways");
        private static string OwnedDiscoveryPath => Path.Combine(DiscoveryDirectory, Process.GetCurrentProcess().Id + ".json");

        internal static void Publish(string gatewayUrl, string bridgeToken = "")
        {
            string temporaryPath = string.Empty;
            try
            {
                string ownedDiscoveryPath = OwnedDiscoveryPath;
                temporaryPath = ownedDiscoveryPath + ".tmp";
                Directory.CreateDirectory(DiscoveryDirectory);
                var record = new GatewayRecord
                {
                    version = SchemaVersion,
                    projectPath = ProjectPath,
                    gatewayUrl = gatewayUrl ?? string.Empty,
                    bridgeToken = bridgeToken,
                    processId = Process.GetCurrentProcess().Id,
                    updatedAtUtc = DateTime.UtcNow.ToString("O")
                };
                File.WriteAllText(temporaryPath, JsonUtility.ToJson(record, true));
                if (File.Exists(ownedDiscoveryPath))
                    File.Replace(temporaryPath, ownedDiscoveryPath, null);
                else
                    File.Move(temporaryPath, ownedDiscoveryPath);
            }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] 写入网关发现配置失败：{ex.Message}");
            }
            finally
            {
                TryDeleteFile(temporaryPath);
            }
        }

        internal static void RemoveOwned(string gatewayUrl)
        {
            try
            {
                _ = gatewayUrl;
                TryDeleteFile(OwnedDiscoveryPath);
            }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] 清理网关发现配置失败：{ex.Message}");
            }
        }

        private static void TryDeleteFile(string filePath)
        {
            if (string.IsNullOrEmpty(filePath)) return;
            try
            {
                if (File.Exists(filePath)) File.Delete(filePath);
            }
            catch (Exception ex)
            {
                ZLog.LogWarning($"[FigmaBridge] 清理临时网关配置失败：{ex.Message}");
            }
        }

        private static string NormalizePath(string value)
        {
            return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
    }
}
