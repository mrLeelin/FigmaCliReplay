var specPath = ".tmp/prefab_spec.json";
var specFullPath = System.IO.Path.Combine(UnityEngine.Application.dataPath, "..", specPath);
var prefabPath = "";
if (System.IO.File.Exists(specFullPath))
{
    try
    {
        var specJson = System.IO.File.ReadAllText(specFullPath, System.Text.Encoding.UTF8);
        var spec = Newtonsoft.Json.Linq.JObject.Parse(specJson);
        prefabPath = (string)spec["prefabPath"] ?? prefabPath;
    }
    catch {}
}

if (string.IsNullOrEmpty(prefabPath))
{
    return "Prefab path missing in " + specPath;
}

var root = UnityEditor.PrefabUtility.LoadPrefabContents(prefabPath);
if (root == null)
{
    return "Prefab not found: " + prefabPath;
}

// 跳过 Common 前缀或 PrefabInstance 内部的 TMP，只修复本次生成的新建文本
bool IsCommonName(string name)
{
    return name.StartsWith("Common_", System.StringComparison.Ordinal)
        || name.StartsWith("CommonTexture_", System.StringComparison.Ordinal)
        || name.StartsWith("Common_Texture_", System.StringComparison.Ordinal)
        || name.StartsWith("Common_Prefab_", System.StringComparison.Ordinal)
        || name.StartsWith("UI_Common_", System.StringComparison.Ordinal);
}

bool ShouldSkipCommon(UnityEngine.Transform transform)
{
    for (var cursor = transform; cursor != null; cursor = cursor.parent)
    {
        if (cursor != root.transform && UnityEditor.PrefabUtility.IsAnyPrefabInstanceRoot(cursor.gameObject))
        {
            return true;
        }

        var cleanName = cursor.name.Trim('[', ']');
        if (IsCommonName(cleanName))
        {
            return true;
        }
    }

    return false;
}

int fixedCount = 0;
int skippedCommon = 0;

var tmps = root.GetComponentsInChildren<TMPro.TextMeshProUGUI>(true);
foreach (var tmp in tmps)
{
    if (ShouldSkipCommon(tmp.transform))
    {
        skippedCommon++;
        continue;
    }

    if (tmp.enableAutoSizing)
    {
        tmp.enableAutoSizing = false;
        fixedCount++;
    }
}

UnityEditor.PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
UnityEditor.PrefabUtility.UnloadPrefabContents(root);
return $"Fixed {fixedCount} TMP components: enableAutoSizing=false (total TMP={tmps.Length}, skippedCommon={skippedCommon})";
