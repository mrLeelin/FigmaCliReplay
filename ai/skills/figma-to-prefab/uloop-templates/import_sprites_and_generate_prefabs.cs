var imageDir = {{IMAGE_DIR_JSON}};
var specPaths = new string[] { {{SPEC_PATHS_CSHARP}} };

UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceUpdate);
if (!UnityEditor.AssetDatabase.IsValidFolder(imageDir))
{
    throw new System.Exception("Image directory does not exist in AssetDatabase: " + imageDir);
}

var pngGuids = UnityEditor.AssetDatabase.FindAssets("t:Texture2D", new[] { imageDir });
var reimportedPngCount = 0;
foreach (var guid in pngGuids)
{
    var assetPath = UnityEditor.AssetDatabase.GUIDToAssetPath(guid);
    if (!assetPath.EndsWith(".png", System.StringComparison.OrdinalIgnoreCase)) continue;
    var importer = UnityEditor.AssetImporter.GetAtPath(assetPath) as UnityEditor.TextureImporter;
    if (importer == null) throw new System.Exception("TextureImporter missing: " + assetPath);
    var changed = false;
    if (importer.textureType != UnityEditor.TextureImporterType.Sprite) { importer.textureType = UnityEditor.TextureImporterType.Sprite; changed = true; }
    if (importer.spriteImportMode != UnityEditor.SpriteImportMode.Single) { importer.spriteImportMode = UnityEditor.SpriteImportMode.Single; changed = true; }
    if (importer.mipmapEnabled) { importer.mipmapEnabled = false; changed = true; }
    if (!importer.alphaIsTransparency) { importer.alphaIsTransparency = true; changed = true; }
    if (changed) { importer.SaveAndReimport(); reimportedPngCount++; }
}

System.Type generatorType = null;
foreach (var asm in System.AppDomain.CurrentDomain.GetAssemblies())
{
    generatorType = asm.GetType("MagicWarrior.Editor.FigmaBridge.PrefabImport.FigmaPrefabGenerator");
    if (generatorType != null) break;
}
if (generatorType == null) throw new System.Exception("FigmaPrefabGenerator type not found.");
var generateMethod = generatorType.GetMethod("Generate", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static, null, new[] { typeof(string) }, null);
if (generateMethod == null) throw new System.Exception("FigmaPrefabGenerator.Generate(string) method not found.");
foreach (var specPath in specPaths)
{
    try { generateMethod.Invoke(null, new object[] { specPath }); }
    catch (System.Reflection.TargetInvocationException ex) { throw ex.InnerException ?? ex; }
}
UnityEditor.AssetDatabase.Refresh(UnityEditor.ImportAssetOptions.ForceUpdate);
return "Imported " + reimportedPngCount + " Sprite textures and generated " + specPaths.Length + " Prefab specs.";
