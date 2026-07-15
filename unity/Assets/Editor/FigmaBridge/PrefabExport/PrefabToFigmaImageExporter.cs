using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// 负责从 Image / RawImage / 自定义图片组件导出图片与九宫格数据。
    /// </summary>
    public static class PrefabToFigmaImageExporter
    {
        /// <summary>
        /// 尝试从当前节点导出图片组件数据。
        /// </summary>
        public static bool TryExport(
            GameObject gameObject,
            PrefabToFigmaNode node,
            PrefabToFigmaPackage package,
            string repoRoot)
        {
            var image = gameObject.GetComponent<Image>();
            if (image != null)
            {
                return TryExportImage(image, node, package, repoRoot);
            }

            var rawImage = gameObject.GetComponent<RawImage>();
            if (rawImage != null)
            {
                return TryExportRawImage(rawImage, node, package, repoRoot);
            }

            var reflectiveImage = FindReflectiveImageComponent(gameObject);
            if (reflectiveImage != null)
            {
                return TryExportReflectiveImage(reflectiveImage, node, package, repoRoot);
            }

            return false;
        }

        /// <summary>
        /// 判断组件是否为未继承 Image 但可静态读取 Sprite 的图片类。
        /// </summary>
        public static bool IsReflectiveImageComponent(Component component)
        {
            if (component == null)
            {
                return false;
            }

            var typeName = component.GetType().FullName ?? component.GetType().Name;
            return typeName.Contains("SlicedFilledImage") ||
                   typeName.Contains("CustomImage") ||
                   ReadSprite(component) != null;
        }

        /// <summary>
        /// 导出 UnityEngine.UI.Image 或其子类，例如项目自定义 CustomImage。
        /// </summary>
        private static bool TryExportImage(
            Image image,
            PrefabToFigmaNode node,
            PrefabToFigmaPackage package,
            string repoRoot)
        {
            var sprite = image.sprite;
            var componentType = image.GetType().FullName ?? image.GetType().Name;
            if (sprite == null)
            {
                package.warnings.Add($"Image component has no sprite guid on {node.path}");
                node.image = new PrefabToFigmaImage
                {
                    componentType = componentType,
                    imageType = image.type.ToString(),
                    mode = "placeholder",
                    fillAmount = image.fillAmount,
                    fillCenter = image.fillCenter
                };
                return true;
            }

            var asset = BuildSpriteAsset(sprite, repoRoot, package);
            if (asset == null)
            {
                package.warnings.Add($"Sprite asset does not exist on {node.path}: {sprite.name}");
                return false;
            }

            var assetKey = asset.guid.ToLowerInvariant();
            package.assets[assetKey] = asset;
            node.image = new PrefabToFigmaImage
            {
                componentType = componentType,
                guid = assetKey,
                imageType = image.type.ToString(),
                mode = "simple",
                fillAmount = image.fillAmount,
                fillCenter = image.fillCenter,
                asset = assetKey,
                pixelSize = new PrefabToFigmaPixelSize { width = asset.width, height = asset.height },
                border = asset.border
            };

            ApplyImageMode(image, node, package, asset);
            return true;
        }

        /// <summary>
        /// 根据 Image.Type 处理九宫格、填充和不支持模式。
        /// </summary>
        private static void ApplyImageMode(
            Image image,
            PrefabToFigmaNode node,
            PrefabToFigmaPackage package,
            PrefabToFigmaAsset asset)
        {
            if (image.type == Image.Type.Sliced)
            {
                ApplySlicedMode(node, package, asset);
                return;
            }

            if (image.type == Image.Type.Filled && !Mathf.Approximately(image.fillAmount, 1f))
            {
                package.warnings.Add($"{node.path}: Filled image downgraded to simple because fillAmount={image.fillAmount}");
                return;
            }

            if (image.type == Image.Type.Tiled)
            {
                node.image.mode = "unsupported";
                package.warnings.Add($"{node.path}: Tiled image is unsupported in C# exporter");
            }
        }

        /// <summary>
        /// 导出 RawImage 纹理引用。
        /// </summary>
        private static bool TryExportRawImage(
            RawImage rawImage,
            PrefabToFigmaNode node,
            PrefabToFigmaPackage package,
            string repoRoot)
        {
            var texture = rawImage.texture;
            if (texture == null)
            {
                package.warnings.Add($"RawImage component has no texture on {node.path}");
                return false;
            }

            var assetPath = AssetDatabase.GetAssetPath(texture);
            if (string.IsNullOrEmpty(assetPath))
            {
                package.warnings.Add($"RawImage texture path cannot be resolved on {node.path}: {texture.name}");
                return false;
            }

            var guid = AssetDatabase.AssetPathToGUID(assetPath).ToLowerInvariant();
            var asset = new PrefabToFigmaAsset
            {
                guid = guid,
                assetPath = NormalizeAssetPath(assetPath),
                metaPath = NormalizeAssetPath(assetPath + ".meta"),
                width = texture.width,
                height = texture.height,
                border = new PrefabToFigmaBorder(),
                pixelsToUnits = 100f
            };

            package.assets[guid] = asset;
            node.image = new PrefabToFigmaImage
            {
                componentType = rawImage.GetType().FullName ?? rawImage.GetType().Name,
                guid = guid,
                imageType = "Simple",
                mode = "simple",
                fillAmount = 1f,
                fillCenter = true,
                asset = guid,
                pixelSize = new PrefabToFigmaPixelSize { width = asset.width, height = asset.height },
                border = asset.border
            };
            return true;
        }

        /// <summary>
        /// 通过反射导出 SlicedFilledImage 等非 Image 继承链的项目自定义图片组件。
        /// </summary>
        private static bool TryExportReflectiveImage(
            Component component,
            PrefabToFigmaNode node,
            PrefabToFigmaPackage package,
            string repoRoot)
        {
            var sprite = ReadSprite(component);
            var componentType = component.GetType().FullName ?? component.GetType().Name;
            if (sprite == null)
            {
                return false;
            }

            var asset = BuildSpriteAsset(sprite, repoRoot, package);
            if (asset == null)
            {
                package.warnings.Add($"Sprite asset does not exist on {node.path}: {sprite.name}");
                return false;
            }

            var fillAmount = ReadFloat(component, 1f, "fillAmount", "FillAmount", "m_FillAmount");
            var fillCenter = ReadBool(component, true, "fillCenter", "FillCenter", "m_FillCenter");
            var imageType = componentType.Contains("SlicedFilledImage") ? "Sliced" : "Simple";
            var assetKey = asset.guid.ToLowerInvariant();
            package.assets[assetKey] = asset;
            node.image = new PrefabToFigmaImage
            {
                componentType = componentType,
                guid = assetKey,
                imageType = imageType,
                mode = "simple",
                fillAmount = fillAmount,
                fillCenter = fillCenter,
                asset = assetKey,
                pixelSize = new PrefabToFigmaPixelSize { width = asset.width, height = asset.height },
                border = asset.border
            };

            if (imageType == "Sliced" && Mathf.Approximately(fillAmount, 1f))
            {
                ApplySlicedMode(node, package, asset);
            }
            else if (imageType == "Sliced")
            {
                package.warnings.Add(
                    $"{node.path}: SlicedFilledImage downgraded to simple because fillAmount={fillAmount}");
            }

            return true;
        }

        /// <summary>
        /// 按 Sprite 边框生成九宫格切片，边框无效时写入降级 warning。
        /// </summary>
        private static void ApplySlicedMode(
            PrefabToFigmaNode node,
            PrefabToFigmaPackage package,
            PrefabToFigmaAsset asset)
        {
            if (!PrefabToFigmaNineSliceExporter.HasBorder(asset.border))
            {
                package.warnings.Add($"{node.path}: Sliced image has no usable sprite border");
                return;
            }

            node.image.mode = "nine-slice";
            node.image.slices = PrefabToFigmaNineSliceExporter.BuildSlices(
                node.rect.width,
                node.rect.height,
                asset.width,
                asset.height,
                asset.border,
                package.warnings);
            node.image.sourceImage = new PrefabToFigmaSourceImage
            {
                width = asset.width,
                height = asset.height,
                spriteGuid = asset.guid.ToLowerInvariant(),
                assetPath = asset.assetPath
            };
        }

        /// <summary>
        /// 从 Sprite 构建资源字典项。
        /// </summary>
        private static PrefabToFigmaAsset BuildSpriteAsset(
            Sprite sprite,
            string repoRoot,
            PrefabToFigmaPackage package)
        {
            var assetPath = AssetDatabase.GetAssetPath(sprite);
            if (string.IsNullOrEmpty(assetPath))
            {
                return null;
            }

            var guid = AssetDatabase.AssetPathToGUID(assetPath);
            var texture = sprite.texture;
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            var pixelsPerUnit = sprite.pixelsPerUnit > 0f ? sprite.pixelsPerUnit : 100f;
            if (importer != null && importer.spritePixelsPerUnit > 0f)
            {
                pixelsPerUnit = importer.spritePixelsPerUnit;
            }

            WarnIfSourceOutsideRepo(assetPath, repoRoot, package);
            return new PrefabToFigmaAsset
            {
                guid = guid,
                assetPath = NormalizeAssetPath(assetPath),
                metaPath = NormalizeAssetPath(assetPath + ".meta"),
                width = texture != null ? texture.width : Mathf.RoundToInt(sprite.rect.width),
                height = texture != null ? texture.height : Mathf.RoundToInt(sprite.rect.height),
                border = new PrefabToFigmaBorder
                {
                    left = sprite.border.x,
                    bottom = sprite.border.y,
                    right = sprite.border.z,
                    top = sprite.border.w
                },
                pixelsToUnits = pixelsPerUnit
            };
        }

        /// <summary>
        /// 查找项目自定义图片组件，避免依赖具体运行时类型。
        /// </summary>
        private static Component FindReflectiveImageComponent(GameObject gameObject)
        {
            var components = gameObject.GetComponents<Component>();
            for (int i = 0; i < components.Length; i++)
            {
                if (IsReflectiveImageComponent(components[i]))
                {
                    return components[i];
                }
            }

            return null;
        }

        /// <summary>
        /// 从组件字段或属性读取 Sprite。
        /// </summary>
        private static Sprite ReadSprite(Component component)
        {
            return ReadMember<Sprite>(component, "sprite", "Sprite", "m_Sprite");
        }

        /// <summary>
        /// 从组件字段或属性读取浮点值。
        /// </summary>
        private static float ReadFloat(Component component, float defaultValue, params string[] names)
        {
            var value = ReadMember<object>(component, names);
            if (value is float floatValue) return floatValue;
            if (value is double doubleValue) return (float)doubleValue;
            if (value is int intValue) return intValue;
            return defaultValue;
        }

        /// <summary>
        /// 从组件字段或属性读取布尔值。
        /// </summary>
        private static bool ReadBool(Component component, bool defaultValue, params string[] names)
        {
            var value = ReadMember<object>(component, names);
            return value is bool boolValue ? boolValue : defaultValue;
        }

        /// <summary>
        /// 通过反射按候选名称读取成员值。
        /// </summary>
        private static T ReadMember<T>(Component component, params string[] names)
        {
            const BindingFlags Flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var type = component.GetType();
            for (int i = 0; i < names.Length; i++)
            {
                var property = type.GetProperty(names[i], Flags);
                if (property != null && typeof(T).IsAssignableFrom(property.PropertyType))
                {
                    return (T)property.GetValue(component);
                }

                var field = type.GetField(names[i], Flags);
                if (field != null && typeof(T).IsAssignableFrom(field.FieldType))
                {
                    return (T)field.GetValue(component);
                }

                if (typeof(T) == typeof(object))
                {
                    if (property != null) return (T)property.GetValue(component);
                    if (field != null) return (T)field.GetValue(component);
                }
            }

            return default;
        }

        /// <summary>
        /// 输出与 Python parser 一致的仓库相对资源路径。
        /// </summary>
        private static string NormalizeAssetPath(string assetPath)
        {
            if (assetPath.StartsWith("Assets/", StringComparison.Ordinal))
            {
                return "JellybeanUnity/" + assetPath;
            }

            return assetPath.Replace('\\', '/');
        }

        /// <summary>
        /// 当资源路径不在仓库常规 Assets 下时追加提示，避免插件后续无法解析图片。
        /// </summary>
        private static void WarnIfSourceOutsideRepo(
            string assetPath,
            string repoRoot,
            PrefabToFigmaPackage package)
        {
            if (!assetPath.StartsWith("Assets/", StringComparison.Ordinal))
            {
                package.warnings.Add($"Sprite asset path is outside Unity Assets: {assetPath}");
            }
        }
    }
}
