var importPlanPath = ".tmp/roslyn_import_plan.txt";
var projectRoot = "";
var importPlanDiskPath = System.IO.Path.Combine(UnityEngine.Application.dataPath, "..", importPlanPath.Replace("/", System.IO.Path.DirectorySeparatorChar.ToString()));
if (System.IO.File.Exists(importPlanDiskPath))
{
    foreach (var rawLine in System.IO.File.ReadAllLines(importPlanDiskPath))
    {
        var line = rawLine.Trim();
        if (line.StartsWith("projectRoot=", System.StringComparison.Ordinal))
        {
            projectRoot = line.Substring("projectRoot=".Length).Trim();
            break;
        }
    }
}
if (string.IsNullOrWhiteSpace(projectRoot))
{
    projectRoot = System.IO.Path.GetDirectoryName(UnityEngine.Application.dataPath);
}
if (string.IsNullOrWhiteSpace(projectRoot))
{
    throw new System.Exception("Unable to resolve Unity project root from Application.dataPath.");
}

System.Func<string, string> normalizeProjectPath = rawPath =>
{
    if (string.IsNullOrWhiteSpace(rawPath))
    {
        return rawPath;
    }

    var normalized = rawPath.Replace("\\", "/").Trim();
    var segments = normalized.Split('/');
    if (System.Array.Exists(segments, segment => segment == "." || segment == ".."))
    {
        throw new System.Exception("Project path cannot contain traversal segments: " + rawPath);
    }

    var firstSlash = normalized.IndexOf('/');
    if (!normalized.StartsWith("Assets/", System.StringComparison.OrdinalIgnoreCase) &&
        firstSlash > 0 &&
        normalized.Substring(firstSlash + 1).StartsWith("Assets/", System.StringComparison.OrdinalIgnoreCase))
    {
        normalized = normalized.Substring(firstSlash + 1);
    }

    return normalized;
};

System.Func<string, string> toDiskPath = rawPath =>
{
    var normalized = normalizeProjectPath(rawPath);
    if (System.IO.Path.IsPathRooted(normalized))
    {
        return normalized;
    }

    return System.IO.Path.Combine(projectRoot, normalized);
};

var planDiskPath = toDiskPath(importPlanPath);
if (!System.IO.File.Exists(planDiskPath))
{
    throw new System.Exception("Roslyn import plan does not exist: " + planDiskPath);
}

var imageDir = string.Empty;
var specPathList = new System.Collections.Generic.List<string>();
foreach (var rawLine in System.IO.File.ReadAllLines(planDiskPath))
{
    var line = rawLine.Trim();
    if (line.Length == 0 || line.StartsWith("#", System.StringComparison.Ordinal))
    {
        continue;
    }

    var splitIndex = line.IndexOf('=');
    if (splitIndex <= 0)
    {
        throw new System.Exception("Invalid import plan line: " + line);
    }

    var key = line.Substring(0, splitIndex).Trim();
    var value = line.Substring(splitIndex + 1).Trim();
    if (key == "imageDir")
    {
        imageDir = value;
    }
    else if (key == "specPath")
    {
        specPathList.Add(value);
    }
}

if (string.IsNullOrWhiteSpace(imageDir) || !imageDir.Replace("\\", "/").StartsWith("Assets/", System.StringComparison.Ordinal))
{
    throw new System.Exception("Invalid imageDir in import plan: " + imageDir);
}

if (specPathList.Count == 0)
{
    throw new System.Exception("No specPath entries found in import plan: " + planDiskPath);
}

var specPaths = specPathList.ToArray();
foreach (var specPath in specPaths)
{
    var diskPath = toDiskPath(specPath);
    if (!System.IO.File.Exists(diskPath))
    {
        throw new System.Exception("Spec file does not exist: " + specPath + " -> " + diskPath);
    }
}

UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceUpdate);

if (!UnityEditor.AssetDatabase.IsValidFolder(imageDir))
{
    throw new System.Exception("Image directory does not exist in AssetDatabase: " + imageDir);
}

var pngGuids = UnityEditor.AssetDatabase.FindAssets("t:Texture2D", new[] { imageDir });
var pngPaths = new System.Collections.Generic.List<string>();
foreach (var guid in pngGuids)
{
    var assetPath = UnityEditor.AssetDatabase.GUIDToAssetPath(guid);
    if (!assetPath.EndsWith(".png", System.StringComparison.OrdinalIgnoreCase))
    {
        continue;
    }

    pngPaths.Add(assetPath);
}

var reimportedPngCount = 0;
var skippedPngCount = 0;
foreach (var path in pngPaths)
{
    var importer = UnityEditor.AssetImporter.GetAtPath(path) as UnityEditor.TextureImporter;
    if (importer == null)
    {
        throw new System.Exception("TextureImporter missing: " + path);
    }

    var changed = false;
    if (importer.textureType != UnityEditor.TextureImporterType.Sprite)
    {
        importer.textureType = UnityEditor.TextureImporterType.Sprite;
        changed = true;
    }
    if (importer.spriteImportMode != UnityEditor.SpriteImportMode.Single)
    {
        importer.spriteImportMode = UnityEditor.SpriteImportMode.Single;
        changed = true;
    }
    if (importer.mipmapEnabled)
    {
        importer.mipmapEnabled = false;
        changed = true;
    }
    if (!importer.alphaIsTransparency)
    {
        importer.alphaIsTransparency = true;
        changed = true;
    }

    if (changed)
    {
        importer.SaveAndReimport();
        reimportedPngCount++;
    }
    else
    {
        skippedPngCount++;
    }
}

System.Type generatorType = null;
foreach (var asm in System.AppDomain.CurrentDomain.GetAssemblies())
{
    generatorType = asm.GetType("MagicWarrior.Editor.FigmaBridge.PrefabImport.FigmaPrefabGenerator");
    if (generatorType != null)
    {
        break;
    }
}

if (generatorType == null)
{
    throw new System.Exception("FigmaPrefabGenerator type not found in loaded editor assemblies.");
}

var generateMethod = generatorType.GetMethod(
    "Generate",
    System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static,
    null,
    new[] { typeof(string) },
    null);

if (generateMethod == null)
{
    throw new System.Exception("FigmaPrefabGenerator.Generate(string) method not found.");
}

foreach (var specPath in specPaths)
{
    try
    {
        generateMethod.Invoke(null, new object[] { normalizeProjectPath(specPath) });
    }
    catch (System.Reflection.TargetInvocationException ex)
    {
        throw ex.InnerException ?? ex;
    }
}

UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceUpdate);
return "Checked " + pngPaths.Count + " PNGs as Sprite (reimported " + reimportedPngCount + ", skipped " + skippedPngCount + ") and generated " + specPaths.Length + " prefab specs from " + importPlanPath;
