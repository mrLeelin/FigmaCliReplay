var specPath = ".tmp/prefab_spec.json";
var specFullPath = System.IO.Path.Combine(UnityEngine.Application.dataPath, "..", specPath);
var path = "";
if (System.IO.File.Exists(specFullPath))
{
    try
    {
        var specJson = System.IO.File.ReadAllText(specFullPath, System.Text.Encoding.UTF8);
        var spec = Newtonsoft.Json.Linq.JObject.Parse(specJson);
        path = (string)spec["prefabPath"] ?? path;
    }
    catch {}
}

if (string.IsNullOrEmpty(path))
{
    return "Prefab path missing in " + specPath;
}

var root = UnityEditor.PrefabUtility.LoadPrefabContents(path);
if (root == null)
{
    return "Prefab not found: " + path;
}

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

var images = root.GetComponentsInChildren<UnityEngine.UI.Image>(true);
foreach (var img in images)
{
    if (ShouldSkipCommon(img.transform))
    {
        skippedCommon++;
        continue;
    }

    if (img.raycastTarget)
    {
        img.raycastTarget = false;
        fixedCount++;
    }
}

var tmps = root.GetComponentsInChildren<TMPro.TextMeshProUGUI>(true);
foreach (var tmp in tmps)
{
    if (ShouldSkipCommon(tmp.transform))
    {
        skippedCommon++;
        continue;
    }

    if (tmp.raycastTarget)
    {
        tmp.raycastTarget = false;
        fixedCount++;
    }
}

UnityEditor.PrefabUtility.SaveAsPrefabAsset(root, path);
UnityEditor.PrefabUtility.UnloadPrefabContents(root);
return $"Fixed {fixedCount} non-common components: raycastTarget=false (Image={images.Length}, TMP={tmps.Length}, skippedCommon={skippedCommon})";
