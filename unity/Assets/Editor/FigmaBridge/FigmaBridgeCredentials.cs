using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>按 Unity 工程保存当前系统用户的 Relay 凭据。</summary>
    internal static class FigmaBridgeCredentials
    {
        // POSIX 0600：仅文件所有者可读写。
        private const uint OwnerReadWrite = 0x180;

        [DllImport("libc", EntryPoint = "chmod")]
        private static extern int ChangeFileMode(string path, uint mode);

        internal static string GetTokenPath(string projectPath)
        {
            bool windows = Application.platform == RuntimePlatform.WindowsEditor;
            string localAppData = windows ? Environment.GetEnvironmentVariable("LOCALAPPDATA") : null;
            string directory = string.IsNullOrEmpty(localAppData)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".figma-relay")
                : Path.Combine(localAppData, "FigmaRelay");

            // 保持与 Relay 安装器的项目路径归一化及哈希一致。
            string projectKey = Path.GetFullPath(projectPath);
            if (windows) projectKey = projectKey.Replace('\\', '/').ToLowerInvariant();
            using (var sha = SHA256.Create())
            {
                string id = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(projectKey)))
                    .Replace("-", string.Empty).ToLowerInvariant();
                return Path.Combine(directory, "unity-bridge", id + ".token");
            }
        }

        internal static string ReadToken(string tokenPath)
        {
            try
            {
                using (var file = new FileStream(tokenPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
                using (var reader = new StreamReader(file, Encoding.UTF8))
                    return reader.ReadToEnd();
            }
            catch (FileNotFoundException) { return string.Empty; }
            catch (DirectoryNotFoundException) { return string.Empty; }
        }

        internal static void WriteToken(string tokenPath, string token)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(tokenPath));
            string temporaryPath = tokenPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var file = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write))
                {
                    if (Application.platform != RuntimePlatform.WindowsEditor
                        && ChangeFileMode(temporaryPath, OwnerReadWrite) != 0)
                        throw new IOException("Could not protect the local Bridge credential file.");
                    using (var writer = new StreamWriter(file, new UTF8Encoding(false)))
                        writer.Write(token);
                }
                if (File.Exists(tokenPath)) File.Replace(temporaryPath, tokenPath, null);
                else File.Move(temporaryPath, tokenPath);
            }
            finally
            {
                File.Delete(temporaryPath);
            }
        }
    }
}
