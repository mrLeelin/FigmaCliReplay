return;
  }
  const canvas = context.package && context.package.canvas ? context.package.canvas : {};
  const width = positiveOr(canvas.width, 0);
  const height = positiveOr(canvas.height, 0);
  if (width <= 0 || height <= 0) {
    return;
  }
  if (Math.abs(positiveOr(rootFrame.width, 0) - width) < 0.5 &&
    Math.abs(positiveOr(rootFrame.height, 0) - height) < 0.5) {
    rootFrame.clipsContent = true;
  }
}

function resolveImportBoundsRootOffset(rootRect, visualBounds) {
  const visualX = numericOr(visualBounds && visualBounds.x, 0);
  const visualY = numericOr(visualBounds && visualBounds.y, 0);
  return {
    x: -visualX,
    y: -visualY
  };
}

/** 鍒ゆ柇瀵煎叆鍖呮槸鍚﹂渶瑕佸灞傝瑙夊寘鍥寸洅銆?*/
function prefabNeedsImportBoundsWrapper(prefabPackage, writePlan) {
  const planRoot = writePlan && writePlan.root ? writePlan.root : {};
  if (planRoot.needsImportBoundsWrapper === true) {
    return true;
  }
  const rootRect = (prefabPackage.root || {}).rect || {};
  const visualBounds = prefabPackage.visualBounds || {};
  if (!rootRect || !visualBounds) {
    return false;
  }
  return numericOr(visualBounds.x, 0) < 0 ||
    numericOr(visualBounds.y, 0) < 0 ||
    positiveOr(visualBounds.width, 0) > positiveOr(rootRect.width, 0) ||
    positiveOr(visualBounds.height, 0) > positiveOr(rootRect.height, 0);
}

/** 閫掑綊鍒涘缓涓€涓?Unity 鑺傜偣瀵瑰簲鐨?Figma Frame锛屽苟鐢熸垚鍥剧墖銆佹枃瀛楀拰瀛愯妭鐐广€?*/
async function createPrefabUnityFrame(sourceNode, context, inheritedScale) {
  const geometryScale = resolvePrefabGeometryScale(inheritedScale);
  const frame = figma.createFrame();
  frame.name = String(sourceNode.name || "Unnamed");
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = !!((sourceNode.clip || {}).enabled);
  applyPrefabNodeGeometry(frame, sourceNode, geometryScale);
  applyPrefabNodeState(frame, sourceNode);
  markPrefabCreatedNode(frame, context);
  context.stats.frameCount += 1;
  if (sourceNode.id) {
    context.nodeByUnityId.set(String(sourceNode.id), frame);
  }
  writePrefabNodeMetadata(frame, sourceNode, context);

  await appendPrefabGeneratedLayers(frame, sourceNode, context);
  const childGeometryScale = resolvePrefabChildGeometryScale(geometryScale, sourceNode && sourceNode.rect ? sourceNode.rect : {});
  const children = Array.isArray(sourceNode.children) ? sourceNode.children : [];
  for (const child of children) {
    const childFrame = await createPrefabUnityFrame(child, context, childGeometryScale);
    frame.appendChild(childFrame);
    applyPrefabNodeGeometry(childFrame, child, childGeometryScale);
  }
  return frame;
}

/** 鎸?Unity RectTransform 杈撳嚭璁剧疆 Figma 鑺傜偣浣嶇疆鍜屽昂瀵搞€?*/
function applyPrefabNodeGeometry(figmaNode, sourceNode, inheritedScale) {
  const rect = sourceNode && sourceNode.rect ? sourceNode.rect : {};
  const geometryScale = resolvePrefabGeometryScale(inheritedScale);
  figmaNode.x = numericOr(rect.x, 0) * geometryScale.x;
  figmaNode.y = numericOr(rect.y, 0) * geometryScale.y;
  if ("resize" in figmaNode) {
    const size = resolvePrefabFigmaNodeSize(rect, geometryScale);
    figmaNode.resize(size.width, size.height);
  }
  applyPrefabNodeConstraints(figmaNode, sourceNode);
  applyPrefabRelativeTransform(figmaNode, rect);
}

function applyPrefabNodeConstraints(figmaNode, sourceNode) {
  if (!("constraints" in figmaNode)) {
    return;
  }
  const rectTransform = sourceNode && sourceNode.rectTransform ? sourceNode.rectTransform : {};
  const constraints = sourceNode && sourceNode.constraints ? sourceNode.constraints : rectTransform.constraints;
  if (!constraints) {
    return;
  }
  figmaNode.constraints = {
    horizontal: normalizePrefabConstraint(constraints.horizontal, "CENTER"),
    vertical: normalizePrefabConstraint(constraints.vertical, "CENTER")
  };
}

function normalizePrefabConstraint(value, fallback) {
  const normalized = String(value || fallback || "CENTER").toUpperCase();
  return ["MIN", "CENTER", "MAX", "STRETCH"].indexOf(normalized) >= 0 ? normalized : fallback;
}

// Unity 正向 Transform scale 在 Figma Frame 上不能稳定保留矩阵，写入时烘焙到尺寸和子树坐标。
function resolvePrefabFigmaNodeSize(rect, inheritedScale) {
  const geometryScale = resolvePrefabGeometryScale(inheritedScale);
  const width = positiveOr(rect && rect.width, 1);
  const height = positiveOr(rect && rect.height, 1);
  return {
    width: Math.max(0.01, width * geometryScale.x),
    height: Math.max(0.01, height * geometryScale.y)
  };
}

/** 解析当前节点相对父节点应烘焙的祖先缩放。 */
function resolvePrefabGeometryScale(inheritedScale) {
  if (!inheritedScale) {
    return { x: 1, y: 1 };
  }
  return {
    x: Math.abs(numericOr(inheritedScale.x, 1)),
    y: Math.abs(numericOr(inheritedScale.y, 1))
  };
}

function resolvePrefabChildGeometryScale(parentScale, rect) {
  const currentScaleX = Math.abs(numericOr(rect && rect.scaleX, 1));
  const currentScaleY = Math.abs(numericOr(rect && rect.scaleY, 1));
  return {
    x: numericOr(parentScale && parentScale.x, 1) * currentScaleX,
    y: numericOr(parentScale && parentScale.y, 1) * currentScaleY
  };
}

/** 鍐欏叆鏃嬭浆鎴栫炕杞煩闃碉紝閬垮厤浣跨敤涓嶅畬鏁寸殑 node.rotation 琛ㄨ揪銆?*/
function applyPrefabRelativeTransform(figmaNode, rect) {
  const rotation = numericOr(rect.rotationZ, 0);
  const scaleX = numericOr(rect.scaleX, 1);
  const scaleY = numericOr(rect.scaleY, 1);
  const transformScaleX = scaleX < 0 ? -1 : 1;
  const transformScaleY = scaleY < 0 ? -1 : 1;
  if (Math.abs(rotation) < 0.001 && transformScaleX === 1 && transformScaleY === 1) {
    return;
  }
  const radians = -rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const width = positiveOr(figmaNode.width, positiveOr(rect.width, 0));
  const height = positiveOr(figmaNode.height, positiveOr(rect.height, 0));
  const x = numericOr(figmaNode.x, 0);
  const y = numericOr(figmaNode.y, 0);
  const cx = width / 2;
  const cy = height / 2;
  const pivotX = x + cx;
  const pivotY = y + cy;
  const a = cos * transformScaleX;
  const b = sin * transformScaleY;
  const c = -sin * transformScaleX;
  const d = cos * transformScaleY;
  const tx = pivotX - a * cx - b * cy;
  const ty = pivotY - c * cx - d * cy;
  figmaNode.relativeTransform = [
    [a, b, tx],
    [c, d, ty]
  ];
}

/** 搴旂敤 Unity active 鐘舵€侊紝淇濈暀闅愯棌鑺傜偣渚夸簬瀹℃煡鍜屽洖鍐欍€?*/
function applyPrefabNodeState(figmaNode, sourceNode) {
  figmaNode.visible = sourceNode.active !== false;
  figmaNode.opacity = resolvePrefabNodeOpacity(sourceNode);
}

function resolvePrefabNodeOpacity(sourceNode) {
  if (sourceNode && sourceNode.active === false) {
    return 0.38;
  }
  const canvasGroup = sourceNode && sourceNode.canvasGroup;
  if (canvasGroup && canvasGroup.alpha !== undefined && canvasGroup.alpha !== null) {
    return clampPrefab01(canvasGroup.alpha);
  }
  return 1;
}

/** 杩藉姞 Unity 鑺傜偣涓婄殑鍥剧墖銆佹枃瀛楀拰涓嶆敮鎸佺粍浠舵爣璁板眰銆?*/
async function appendPrefabGeneratedLayers(frame, sourceNode, context) {
  if (sourceNode.active === false) {
    return;
  }
  if (sourceNode.image) {
    await appendPrefabImageLayers(frame, sourceNode, context);
  }
  if (sourceNode.text) {
    await appendPrefabTextLayers(frame, sourceNode, context);
  }
  recordPrefabUnsupportedComponents(sourceNode, context);
}

/** 杩藉姞鍥剧墖鎴栦節瀹垏鐗囩敓鎴愬眰銆?*/
async function appendPrefabImageLayers(frame, sourceNode, context) {
  const image = sourceNode.image || {};

  // 缂哄け Sprite锛堣繍琛屾椂鍔ㄦ€佽祴鍊硷級: 鍒涘缓鍗犱綅鐭╁舰锛屼笉灏濊瘯涓婁紶鍥剧墖
  if (image.missingSprite) {
    const placeholder = figma.createRectangle();
    placeholder.name = "__missing_sprite";
    frame.appendChild(placeholder);
    placeholder.x = 0;
    placeholder.y = 0;
    placeholder.resize(positiveOr(frame.width, 1), positiveOr(frame.height, 1));
    placeholder.strokes = [];
    placeholder.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 0.3 }];
    markPrefabCreatedNode(placeholder, context);
    writePrefabPluginData(placeholder, {
      missingSprite: true,
      spriteGuid: image.guid || "",
      nodeRole: "missingSpritePlaceholder"
    });
    return;
  }

  if (String(image.mode || "").toLowerCase() === "nine-slice" && Array.isArray(image.slices) && image.slices.length > 0) {
    await appendPrefabNineSliceLayers(frame, sourceNode, context);
    return;
  }

  const hash = await getPrefabImageHash(image.asset || image.guid, sourceNode, context);
  if (!hash) {
    appendPrefabMissingImageMarker(frame, sourceNode, context);
    return;
  }

  const rect = figma.createRectangle();
  rect.name = "__image";
  frame.appendChild(rect);
  const imageRect = resolvePrefabImageLayerRect(frame, image);
  rect.x = imageRect.x;
  rect.y = imageRect.y;
  rect.resize(positiveOr(imageRect.width, 1), positiveOr(imageRect.height, 1));
  rect.strokes = [];
  const imageOpacity = prefabImageOpacity(image);
  rect.fills = [buildPrefabSimpleImageFill(hash, image, imageOpacity)];
  markPrefabCreatedNode(rect, context);
  writePrefabImageMetadata(rect, image, sourceNode);
  context.imageLayerVisualReports.push(validatePrefabImageLayerVisual(rect, image, sourceNode, "__image", imageOpacity, {
    geometry: imageRect,
    scaleMode: normalizePrefabUvRect(image && image.uvRect) ? "CROP" : "FILL",
    imageTransform: normalizePrefabUvRect(image && image.uvRect) ? buildPrefabUvCropTransform(normalizePrefabUvRect(image.uvRect)) : null
  }));
  context.stats.imageCount += 1;
}

function buildPrefabSimpleImageFill(hash, image, imageOpacity) {
  const uvRect = normalizePrefabUvRect(image && image.uvRect);
  if (uvRect) {
    return {
      type: "IMAGE",
      scaleMode: "CROP",
      imageHash: hash,
      imageTransform: buildPrefabUvCropTransform(uvRect),
      opacity: imageOpacity
    };
  }
  return {
    type: "IMAGE",
    scaleMode: "FILL",
    imageHash: hash,
    opacity: imageOpacity
  };
}

function resolvePrefabImageLayerRect(frame, image) {
  const frameWidth = positiveOr(frame && frame.width, 1);
  const frameHeight = positiveOr(frame && frame.height, 1);
  if (!(image && image.preserveAspect === true)) {
    return { x: 0, y: 0, width: frameWidth, height: frameHeight };
  }
  const pixelSize = image.pixelSize || image.sourceImage || {};
  const imageWidth = positiveOr(pixelSize.width, frameWidth);
  const imageHeight = positiveOr(pixelSize.height, frameHeight);
  const imageAspect = imageWidth / positiveOr(imageHeight, 1);
  const frameAspect = frameWidth / positiveOr(frameHeight, 1);
  if (!isFinite(imageAspect) || imageAspect <= 0 || !isFinite(frameAspect) || frameAspect <= 0) {
    return { x: 0, y: 0, width: frameWidth, height: frameHeight };
  }
  if (imageAspect > frameAspect) {
    const height = frameWidth / imageAspect;
    return { x: 0, y: (frameHeight - height) / 2, width: frameWidth, height };
  }
  const width = frameHeight * imageAspect;
  return { x: (frameWidth - width) / 2, y: 0, width, height: frameHeight };
}

function normalizePrefabUvRect(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const uv = {
    x: numericOr(value.x, 0),
    y: numericOr(value.y, 0),
    width: numericOr(value.width, 1),
    height: numericOr(value.height, 1)
  };
  if (prefabNumberApproximatelyEqual(uv.x, 0) &&
    prefabNumberApproximatelyEqual(uv.y, 0) &&
    prefabNumberApproximatelyEqual(uv.width, 1) &&
    prefabNumberApproximatelyEqual(uv.height, 1)) {
    return null;
  }
  return uv;
}

function buildPrefabUvCropTransform(uvRect) {
  const transform = [
    [positiveOr(uvRect.width, 1), 0, numericOr(uvRect.x, 0)],
    [0, positiveOr(uvRect.height, 1), numericOr(uvRect.y, 0)]
  ];
  assertTransformInRange(transform, "prefab-to-figma rawimage uv");
  return transform;
}

/** 杩藉姞涔濆鍒囩墖锛屽苟鍦ㄧ埗鑺傜偣 fills[0] 淇濈暀涓嶅彲瑙佹簮鍥俱€?*/
async function appendPrefabNineSliceLayers(frame, sourceNode, context) {
  const image = sourceNode.image || {};
  const hash = await getPrefabImageHash(image.asset || image.guid || ((image.sourceImage || {}).spriteGuid), sourceNode, context);
  if (!hash) {
    appendPrefabMissingImageMarker(frame, sourceNode, context);
    return;
  }

  frame.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: hash, opacity: 0 }];
  writePrefabImageMetadata(frame, image, sourceNode);
  writePrefabPluginData(frame, {
    sourceImageFillIndex: "0",
    nodeRole: "nineSliceParent"
  });

  const sourceSize = image.sourceImage || image.pixelSize || {};
  const imageWidth = positiveOr(sourceSize.width, positiveOr((image.pixelSize || {}).width, frame.width));
  const imageHeight = positiveOr(sourceSize.height, positiveOr((image.pixelSize || {}).height, frame.height));
  const slices = image.slices || [];
  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = String(slice.name || "__slice_center");
    frame.appendChild(sliceNode);
    const target = prefabRectObject(slice.target);
    sliceNode.x = target.x;
    sliceNode.y = target.y;
    sliceNode.resize(positiveOr(target.width, 1), positiveOr(target.height, 1));
    sliceNode.strokes = [];
    sliceNode.fills = [{
      type: "IMAGE",
      scaleMode: "CROP",
      imageHash: hash,
      imageTransform: buildPrefabCropTransform(slice.source, imageWidth, imageHeight),
      opacity: prefabImageOpacity(image)
    }];
    sliceNode.constraints = inferSliceConstraints(sliceNode, frame);
    markPrefabCreatedNode(sliceNode, context);
    writePrefabPluginData(sliceNode, {
      nodeRole: "slice",
      sourceRect: JSON.stringify(prefabRectObject(slice.source)),
      sourceImageFillIndex: "0",
      unityNodeId: sourceNode.id || ""
    });
    context.imageLayerVisualReports.push(validatePrefabImageLayerVisual(sliceNode, image, sourceNode, String(slice.name || "__slice_center"), prefabImageOpacity(image), {
      geometry: target,
      scaleMode: "CROP",
      imageTransform: buildPrefabCropTransform(slice.source, imageWidth, imageHeight)
    }));
    context.stats.sliceCount += 1;
  }
  context.stats.nineSliceCount += 1;
  context.nineSliceReports.push({
    nodePath: sourceNode.path || sourceNode.name || "",
    nodeId: frame.id,
    sliceCount: slices.length,
    hasSourceFill: true,
    pass: slices.length > 0
  });
}

/** 鍒涘缓鍥剧墖 CROP 鐭╅樀锛岀洿鎺ユ秷璐硅剼鏈鍒掍腑鐨?source rect銆?*/
function buildPrefabCropTransform(sourceRect, imageWidth, imageHeight) {
  const source = prefabRectObject(sourceRect);
  const transform = [
    [positiveOr(source.width, 1) / positiveOr(imageWidth, 1), 0, numericOr(source.x, 0) / positiveOr(imageWidth, 1)],
    [0, positiveOr(source.height, 1) / positiveOr(imageHeight, 1), numericOr(source.y, 0) / positiveOr(imageHeight, 1)]
  ];
  assertTransformInRange(transform, "prefab-to-figma slice");
  return transform;
}

/** 鑾峰彇鎴栧垱寤哄浘鐗?hash锛屽悓涓€璧勬簮鍦ㄥ崟涓换鍔″唴鍙垱寤轰竴娆°€?*/
async function getPrefabImageHash(assetId, sourceNode, context) {
  const key = String(assetId || "");
