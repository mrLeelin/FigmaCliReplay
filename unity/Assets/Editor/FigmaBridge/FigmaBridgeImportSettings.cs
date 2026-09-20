using System.IO;
using TMPro;
using UnityEditor;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    public static class FigmaBridgeImportSettings
    {
        [System.Serializable] private class Data { public string commonFontAsset; public string relayToken; }
        private static string FilePath => Path.Combine(Application.dataPath, "..", "ProjectSettings", "FigmaBridgeImportSettings.json");
        private static Data Load() => File.Exists(FilePath) ? JsonUtility.FromJson<Data>(File.ReadAllText(FilePath)) : new Data();
        public static string FontPath => Load()?.commonFontAsset ?? string.Empty;
        public static string RelayToken => Load()?.relayToken ?? string.Empty;
        public static string MaterialPath => Path.ChangeExtension(FontPath, ".mat").Replace("\\", "/");
        public static string MaterialDirectory => Path.GetDirectoryName(FontPath)?.Replace("\\", "/") ?? "Assets";
        public static TMP_FontAsset Font => AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(FontPath);
        public static void SetFont(TMP_FontAsset font)
        {
            var path = AssetDatabase.GetAssetPath(font);
            if (!string.IsNullOrEmpty(path)) File.WriteAllText(FilePath, JsonUtility.ToJson(new Data { commonFontAsset = path, relayToken = RelayToken }, true));
        }

        public static void SetRelayToken(string token)
        {
            File.WriteAllText(FilePath, JsonUtility.ToJson(new Data { commonFontAsset = FontPath, relayToken = token ?? string.Empty }, true));
        }
    }
}
