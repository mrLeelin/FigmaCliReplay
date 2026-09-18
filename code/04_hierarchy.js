if (!key) {
    addPrefabBlockingError(context, "missingImageAssetId", "Image node is missing asset/guid, cannot create IMAGE fill.", {
      nodePath: sourceNode.path || sourceNode.name || ""
    });
    context.stats.missingAssetCount += 1;
    return "";
  }
  if (context.imageHashes.has(key)) {
    return context.imageHashes.get(key);
  }
  const asset = context.assetBytes.get(key);
  if (!asset || !asset.bytes || asset.bytes.length === 0) {
    addPrefabBlockingError(context, "missingImageAssetBytes", "Relay did not receive image bytes, cannot write Figma image.", {
      assetId: key,
      nodePath: sourceNode.path || sourceNode.name || ""
    });
    context.stats.missingAssetCount += 1;
    return "";
  }
  const image = figma.createImage(asset.bytes);
  context.imageHashes.set(key, image.hash);
  context.imageHashReports.push({
    assetId: key,
    imageHash: image.hash,
    hashLength: String(image.hash || "").length,
    pass: String(image.hash || "").length === 40
  });
  return image.hash;
}

/** 鍥剧墖缂哄け鏃跺垱寤烘樉寮忔爣璁帮紝閬垮厤闈欓粯绌虹櫧銆?*/
function appendPrefabMissingImageMarker(frame, sourceNode, context) {
  const marker = figma.createRectangle();
  marker.name = "__unsupported";
  frame.appendChild(marker);
  marker.x = 0;
  marker.y = 0;
  marker.resize(positiveOr(frame.width, 1), positiveOr(frame.height, 1));
  marker.fills = [solidPaintFromManifest({ r: 1, g: 0.25, b: 0.25 }, 0.18)];
  marker.strokes = [solidPaintFromManifest({ r: 1, g: 0, b: 0 }, 0.7)];
  marker.strokeWeight = 1;
  markPrefabCreatedNode(marker, context);
  writePrefabPluginData(marker, {
    nodeRole: "missingImage",
    unityNodePath: sourceNode.path || sourceNode.name || ""
  });
  context.stats.unsupportedCount += 1;
}

/** 杩藉姞 TMP/TextMeshPro 鏂囨湰灞傚拰 Underlay 妯℃嫙灞傘€?*/
async function appendPrefabTextLayers(frame, sourceNode, context) {
  const textData = sourceNode.text || {};
  const fontName = await loadPrefabTextFont(textData, context);
  const underlay = ((textData.effects || {}).underlay) || null;
  if (underlay) {
    const underlayNode = await createPrefabTextNode(frame, sourceNode, textData, fontName, "__text_underlay", underlay, context);
    writePrefabPluginData(underlayNode, {
      nodeRole: "textUnderlay",
      shadowModel: "duplicated_underlay_text"
    });
    context.stats.underlayTextCount += 1;
  }
  const textLayerName = String(textData.figmaTextLayerName || "__text");
  const textNode = await createPrefabTextNode(frame, sourceNode, textData, fontName, textLayerName, null, context);
  writePrefabTextMetadata(textNode, textData, sourceNode, fontName);
  context.stats.textCount += 1;

  if (textData.materialTag) {
    context.stats.tmpMaterialTextCount += 1;
    context.tmpMaterialReports.push(validatePrefabTmpMetadata(textNode, textData, sourceNode));
  }
  const outline = ((textData.effects || {}).outline) || null;
  if (outline && numericOr(outline.width, 0) > 0) {
    context.stats.outlineTextCount += 1;
    context.outlineReports.push({
      nodePath: sourceNode.path || sourceNode.name || "",
      textNodeId: textNode.id,
      pass: Array.isArray(textNode.strokes) && textNode.strokes.length > 0 && numericOr(textNode.strokeWeight, 0) > 0
    });
  }
}

/** 鍒涘缓鍗曚釜鏂囨湰鑺傜偣锛屼富鏂囨湰鍜?underlay 鍏辩敤鍚屼竴濂楀嚑浣曡绠椼€?*/
async function createPrefabTextNode(frame, sourceNode, textData, fontName, layerName, underlay, context) {
  const textNode = figma.createText();
  textNode.name = layerName;
  frame.appendChild(textNode);
  textNode.fontName = fontName;
  textNode.characters = String(textData.content || "");
  const resolvedFontSize = estimatePrefabFontSize(textData, frame);
  textNode.fontSize = resolvedFontSize.size;
  textNode.lineHeight = { unit: "AUTO" };
  const alignH = mapPrefabTextAlignHorizontal((textData.alignment || {}).horizontal);
  const alignV = mapPrefabTextAlignVertical((textData.alignment || {}).vertical);
  textNode.textAlignHorizontal = alignH;
  textNode.textAlignVertical = alignV;
  if (isPrefabTextWrappingEnabled(textData) === false) {
    textNode.textAutoResize = "WIDTH_AND_HEIGHT";
    positionPrefabAutoWidthText(textNode, frame, alignH, alignV, underlay);
  } else {
    textNode.textAutoResize = "NONE";
    textNode.resize(positiveOr(frame.width, 1), positiveOr(frame.height, 1));
    positionPrefabFixedText(textNode, underlay);
  }
  textNode.fills = [prefabSolidPaint(underlay && underlay.color ? underlay.color : (textData.fontColor || textData.color), { r: 0, g: 0, b: 0, a: 1 })];
  applyPrefabTextOutline(textNode, textData, underlay);
  markPrefabCreatedNode(textNode, context);
  writePrefabPluginData(textNode, {
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    generatedLayerName: layerName,
    unityFontSize: String(textData.fontSize || ""),
    figmaFontSize: String(resolvedFontSize.size || ""),
    fontSizeMode: resolvedFontSize.mode || ""
  });
  return textNode;
}

/** 鍒ゆ柇 TMP 鏂囨湰鏄惁鍚敤鑷姩鎹㈣锛屽吋瀹?Unity 6000 鐨?TextWrappingMode銆?*/
function isPrefabTextWrappingEnabled(textData) {
  const options = textData.options || {};
  if (options.wordWrapping === true) return true;
  if (options.wordWrapping === false) return false;
  const mode = numericOr(options.textWrappingMode, -1);
  if (mode === 0 || mode === 3) return false;
  if (mode === 1 || mode === 2) return true;
  return true;
}

/** 涓嶆崲琛屾枃鏈娇鐢ㄨ嚜鍔ㄥ搴︼紝鍐嶆寜 Unity 瀵归綈鏂瑰紡鏀惧洖鍘熸枃鏈鍣ㄣ€?*/
function positionPrefabAutoWidthText(textNode, frame, alignH, alignV, underlay) {
  const fontSize = Math.max(1, numericOr(textNode.fontSize, 16));
  const offsetX = numericOr(underlay && underlay.offsetX, 0) * fontSize * 0.3;
  const offsetY = -numericOr(underlay && underlay.offsetY, 0) * fontSize * 0.3;
  let x = 0;
  if (alignH === "CENTER") {
    x = (positiveOr(frame.width, 1) - positiveOr(textNode.width, 1)) / 2;
  } else if (alignH === "RIGHT") {
    x = positiveOr(frame.width, 1) - positiveOr(textNode.width, 1);
  }
  let y = 0;
  if (alignV === "CENTER") {
    y = (positiveOr(frame.height, 1) - positiveOr(textNode.height, 1)) / 2;
  } else if (alignV === "BOTTOM") {
    y = positiveOr(frame.height, 1) - positiveOr(textNode.height, 1);
  }
  textNode.x = x + offsetX;
  textNode.y = y + offsetY;
}

/** 鍥哄畾妗嗘枃鏈繚鎸佸師瀹瑰櫒灏哄锛屼粎搴旂敤 TMP underlay 鍋忕Щ銆?*/
function positionPrefabFixedText(textNode, underlay) {
  const fontSize = Math.max(1, numericOr(textNode.fontSize, 16));
  textNode.x = numericOr(underlay && underlay.offsetX, 0) * fontSize * 0.3;
  textNode.y = -numericOr(underlay && underlay.offsetY, 0) * fontSize * 0.3;
}

/** 妫€娴?Figma 鏂囦欢涓洰鏍囬〉闈㈢殑涓绘祦瀛椾綋锛屼緵鍒涘缓鏂囨湰鑺傜偣鏃朵紭鍏堜娇鐢ㄣ€?
 *
 *  妫€娴嬩紭鍏堢骇锛堥€愮骇闄嶇骇锛夛細
 *   1. 鍏ㄦ枃浠跺凡鏈?`__text` / `__text_underlay` 灞備腑鏈€澶氱殑瀛椾綋锛堜箣鍓嶅鍏ョ敤鐨勫瓧浣擄級
 *   2. 褰撳墠椤甸潰瀛楃鏈€涓板瘜鐨?TEXT 鑺傜偣瀛椾綋
 *   3. 褰撳墠椤甸潰鍑虹幇娆℃暟鏈€澶氱殑瀛椾綋
 *   4. 鍏ㄦ枃浠跺嚭鐜版鏁版渶澶氱殑瀛椾綋
 */
/** Update imported text node fonts through Relay. */
async function handleChangeTextFonts(message) {
  try {
    const job = message.job || {};
    const fontFamily = String(job.fontFamily || "");
    const fontStyle = String(job.fontStyle || "Regular");
    const selector = String(job.selector || "");
    if (!fontFamily) {
      figma.ui.postMessage({ type: "CHANGE_TEXT_FONTS_RESULT", requestId: message.requestId, result: { status: "error", errors: ["missing fontFamily"] } });
      return;
    }
    if (!selector) {
      figma.ui.postMessage({ type: "CHANGE_TEXT_FONTS_RESULT", requestId: message.requestId, result: { status: "error", errors: ["missing selector"] } });
      return;
    }
    await figma.loadFontAsync({ family: fontFamily, style: fontStyle });
    const allTextNodes = await collectTextNodesUnderSelector(selector);
    if (allTextNodes.length === 0) {
      figma.ui.postMessage({ type: "CHANGE_TEXT_FONTS_RESULT", requestId: message.requestId, result: { status: "completed", changed: 0, warning: "no text nodes found under " + selector } });
      return;
    }
    for (const tn of allTextNodes) {
      tn.fontName = { family: fontFamily, style: fontStyle };
      tn.setSharedPluginData("prefab_to_figma", "fontFallback", "true");
      tn.setSharedPluginData("prefab_to_figma", "figmaFontFamily", fontFamily + " " + fontStyle);
    }
    figma.ui.postMessage({
      type: "CHANGE_TEXT_FONTS_RESULT",
      requestId: message.requestId,
      result: { status: "completed", changed: allTextNodes.length, fontFamily, fontStyle }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "CHANGE_TEXT_FONTS_RESULT",
      requestId: message.requestId,
      result: { status: "error", errors: [error instanceof Error ? error.message : String(error)] }
    });
  }
}


/** 鏀堕泦鎸囧畾瀵煎叆鏍硅妭鐐逛笅鐨勬枃鏈妭鐐癸紝閬垮厤鍐欐鍏蜂綋鐣岄潰鍚嶇О銆?*/
async function collectTextNodesUnderSelector(selector) {
  const originalPage = figma.currentPage;
  const allTextNodes = [];
  try {
    for (const page of figma.root.children) {
      await figma.setCurrentPageAsync(page);
      page.findAll(n => {
        if (n.name === selector || n.name.startsWith(selector)) {
          if ("findAll" in n) {
            n.findAll(c => {
              if (c.type === "TEXT") allTextNodes.push(c);
              return false;
            });
          }
        }
        return false;
      });
    }
  } finally {
    if (originalPage && figma.currentPage !== originalPage) {
      await figma.setCurrentPageAsync(originalPage);
    }
  }
  return allTextNodes;
}


async function detectPrefabFileFont(context) {
  try {
    const originalPage = figma.currentPage;
    const currentStats = collectPrefabFontStatsForPage(figma.currentPage);
    const currentChoice = choosePrefabFileFont(currentStats);
    if (currentChoice) {
      context.fileFont = currentChoice.font;
      context.fileFontCount = currentChoice.count;
      return;
    }

    const globalStats = createPrefabFontStats();
    try {
      for (const page of figma.root.children) {
        if (page === originalPage) continue;
        await figma.setCurrentPageAsync(page);
        mergePrefabFontStats(globalStats, collectPrefabFontStatsForPage(page));
      }
    } finally {
      if (originalPage && figma.currentPage !== originalPage) {
        await figma.setCurrentPageAsync(originalPage);
      }
    }
    mergePrefabFontStats(globalStats, currentStats);
    const globalChoice = choosePrefabFileFont(globalStats);
    if (!globalChoice) return;
    context.fileFont = globalChoice.font;
    context.fileFontCount = globalChoice.count;
  } catch (e) {
    context.warnings.push(`鏂囦欢瀛椾綋妫€娴嬭烦杩囷細${e.message}`);
  }
}


/** 鍒涘缓瀛椾綋缁熻瀹瑰櫒銆?*/
function createPrefabFontStats() {
  return { totalTextNodes: 0, importTextFonts: {}, fontCounts: {}, bestTextFont: null, bestTextLen: 0 };
}

/** 缁熻鍗曚釜椤甸潰鍐呯殑鏂囨湰瀛椾綋銆?*/
function collectPrefabFontStatsForPage(page) {
  const stats = createPrefabFontStats();
  page.findAll(n => {
    if (n.type !== "TEXT") return false;
    stats.totalTextNodes++;
    const fn = n.fontName;
    if (!fn || !fn.family) return false;
    const key = `${fn.family}:${fn.style}`;
    const len = n.characters.length;
    stats.fontCounts[key] = (stats.fontCounts[key] || 0) + 1;
    if (len > stats.bestTextLen) {
      stats.bestTextLen = len;
      stats.bestTextFont = fn;
    }
    const parentName = n.parent ? n.parent.name : "";
    if (parentName === "__text" || parentName === "__text_underlay") {
      stats.importTextFonts[key] = (stats.importTextFonts[key] || 0) + 1;
    }
    return false;
  });
  return stats;
}

/** 鍚堝苟瀛椾綋缁熻缁撴灉銆?*/
function mergePrefabFontStats(target, source) {
  target.totalTextNodes += source.totalTextNodes || 0;
  mergeCountMap(target.importTextFonts, source.importTextFonts);
  mergeCountMap(target.fontCounts, source.fontCounts);
  if ((source.bestTextLen || 0) > target.bestTextLen) {
    target.bestTextLen = source.bestTextLen;
    target.bestTextFont = source.bestTextFont;
  }
}

/** 鍚堝苟璁℃暟瀛楀吀銆?*/
function mergeCountMap(target, source) {
  for (const [key, count] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + count;
  }
}

/** 鎸変紭鍏堢骇閫夋嫨瀵煎叆鏂囨湰搴斾娇鐢ㄧ殑鏂囦欢瀛椾綋銆?*/
function choosePrefabFileFont(stats) {
  if (!stats || stats.totalTextNodes === 0) return null;
  const importChoice = chooseMostCommonPrefabFont(stats.importTextFonts);
  if (importChoice) return importChoice;
  if (stats.bestTextFont) {
    const key = `${stats.bestTextFont.family}:${stats.bestTextFont.style}`;
    return { font: stats.bestTextFont, count: stats.fontCounts[key] || 0 };
  }
  return chooseMostCommonPrefabFont(stats.fontCounts);
}

/** 浠庤鏁板瓧鍏镐腑閫夊嚭鐜版鏁版渶澶氱殑瀛椾綋銆?*/
function chooseMostCommonPrefabFont(counts) {
  let maxCount = 0;
  let bestKey = null;
  for (const [key, count] of Object.entries(counts || {})) {
    if (count > maxCount) {
      maxCount = count;
      bestKey = key;
    }
  }
  if (!bestKey) return null;
  const parts = bestKey.split(":");
  return { font: { family: parts[0], style: parts[1] || "Regular" }, count: maxCount };
}

/** 鍔犺浇鏂囨湰瀛椾綋锛氫紭鍏堜娇鐢ㄦ枃浠跺唴宸叉湁瀛椾綋椋庢牸锛屽叾娆′娇鐢?Inter 鍏滃簳銆?*/
async function loadPrefabTextFont(textData, context) {
  const style = numericOr((textData.options || {}).fontStyle, 0) & 1 ? "Bold" : "Regular";
  const candidates = [];

  appendPrefabUnityGameFontCandidates(candidates, textData, style);

  // 优先使用当前 Figma 文件已存在字体，避免不存在的 TMP 字体候选长时间阻塞 loadFontAsync。
  if (context.fileFont) {
    candidates.push(context.fileFont);
  }
  if (context.fileFont && context.fileFont.style !== "Regular") {
    candidates.push({ family: context.fileFont.family, style: "Regular" });
  }

  // 1. 瑙ｆ瀽鍣ㄦ寜 TMP 鏉愯川鍚嶇粰鍑虹殑 Figma 瀛椾綋鍊欓€夛紝浼樺厛澶勭悊涓枃瀛椾綋鍚嶃€?
  const parserCandidates = ((textData.sharedMaterial || {}).figmaFontCandidates || []);
  if (Array.isArray(parserCandidates)) {
    for (const family of parserCandidates) {
      appendPrefabFontCandidate(candidates, family, style);
    }
  }
  appendPrefabMaterialFontCandidates(candidates, textData, style);
  // 2. TMP 婧愬瓧浣撳鏃忓悕锛堜粠 .asset 鐨?m_SourceFontFileGUID 瑙ｆ瀽锛屼綔涓鸿ˉ鍏呭€欓€夛級
  var sourceFontFamily = (textData.sharedMaterial || {}).sourceFontFamily || "";
  if (sourceFontFamily) {
    appendPrefabFontCandidate(candidates, sourceFontFamily, style);
  }
  // 5. TMP 鏉愯川鍚嶏紙Unity TMP Font Asset 鍚嶇О锛屽厹搴曪級
  var matName = (textData.sharedMaterial || {}).name || "";
  if (matName) {
    appendPrefabFontCandidate(candidates, matName, style);
  }
  // 6. Inter 鍏滃簳
  candidates.push({ family: "Inter", style: style });
  candidates.push({ family: "Inter", style: "Regular" });

  for (const fontName of candidates) {
    const key = `${fontName.family}/${fontName.style}`;
    if (context.fontCache.has(key)) {
      return context.fontCache.get(key);
    }
    try {
      await promiseWithTimeout(figma.loadFontAsync(fontName), 2500, `font load timeout: ${key}`);
      context.fontCache.set(key, fontName);
      // 璁板綍闈?fileFont 瀛椾綋锛堝 sourceFontFamily锛夛紝渚涢獙璇佹斁琛?
      if (!context.fileFont || fontName.family !== context.fileFont.family) {
        context.allowedFontFamilies[key] = true;
      }
      return fontName;
    } catch (error) {
      context.warnings.push(`瀛椾綋鍔犺浇澶辫触锛屽皾璇曚笅涓€涓€欓€夛細${key}`);
    }
  }
  throw new Error("prefab-to-figma could not load any candidate font.");
}

/** 杩藉姞瀛椾綋鍊欓€夊強鍏?Regular 鍙樹綋锛岄伩鍏嶉噸澶嶅皾璇曘€?*/
function appendPrefabFontCandidate(candidates, family, style) {
  const normalized = String(family || "").trim();
  if (!normalized) return;
  appendUniquePrefabFontCandidate(candidates, { family: normalized, style: style });
  if (style !== "Regular") {
    appendUniquePrefabFontCandidate(candidates, { family: normalized, style: "Regular" });
  }
}

/** Unity 常用游戏字在 Figma 不可用时，优先映射到文件里存在的近似粗圆字体。 */
function appendPrefabUnityGameFontCandidates(candidates, textData, style) {
  const sharedMaterial = textData.sharedMaterial || {};
  const names = [
    sharedMaterial.sourceFontFamily || "",
    sharedMaterial.name || "",
    textData.materialTag || ""
  ].join(" ").toLowerCase();
  if (names.indexOf("grobold") >= 0 || names.indexOf("commonfont") >= 0) {
    appendUniquePrefabFontCandidate(candidates, { family: "Lilita One", style: "Regular" });
  }
}

/** 杩藉姞鍘婚噸鍚庣殑鍗曚釜瀛椾綋鍊欓€夈€?*/
function appendUniquePrefabFontCandidate(candidates, fontName) {
  for (const item of candidates) {
    if (item.family === fontName.family && item.style === fontName.style) {
      return;
    }
  }
  candidates.push(fontName);
}

/** 浠?TMP 鏉愯川鍚嶆帹鏂?Figma 瀛椾綋鍊欓€夛紝浼樺厛閬垮厤涓枃钀藉埌鎷変竵瑁呴グ瀛椾綋銆?*/
function appendPrefabMaterialFontCandidates(candidates, textData, style) {
  const sharedMaterial = textData.sharedMaterial || {};
  const names = [textData.materialTag || "", sharedMaterial.name || ""];
  for (const name of names) {
    const compact = String(name || "").replace(/[\s_-]+/g, "");
    if (compact.indexOf("NotoSansSC") >= 0 || compact.indexOf("NotoSansCJKSC") >= 0) {
      appendPrefabFontCandidate(candidates, "Noto Sans SC", style);
      appendPrefabFontCandidate(candidates, "Noto Sans CJK SC", style);
      appendPrefabFontCandidate(candidates, "Source Han Sans SC", style);
      appendPrefabFontCandidate(candidates, "Microsoft YaHei", style);
    }
  }
}

/** 浼扮畻 Figma 瀛楀彿锛孉utoSize 鏃堕檺鍒跺湪 min/max 鍐呫€?*/
function estimatePrefabFontSize(textData, frame) {
  const baseSize = positiveOr(textData.fontSize, 16);
  const autoSize = textData.autoSize || {};
  if (autoSize.enabled !== true) {
    return { size: baseSize, mode: "fixed" };
  }
  const minSize = positiveOr(autoSize.min, Math.min(baseSize, 1));
  const maxSize = positiveOr(autoSize.max, baseSize);
  const clampedBase = Math.max(minSize, Math.min(baseSize, maxSize));
  if (isPrefabTextWrappingEnabled(textData) === false) {
    return { size: clampedBase, mode: "autosize_nowrap_unity_size" };
  }
  const contentLength = Math.max(1, String(textData.content || "").length);
  const widthLimit = positiveOr(frame.width, 1) / Math.max(1, contentLength * 0.6);
  return {
    size: Math.max(minSize, Math.min(clampedBase, widthLimit)),
    mode: "autosize_width_limited"
  };
}

/** 搴旂敤 TMP 鎻忚竟锛沀nderlay 灞備娇鐢ㄨ嚜韬鑹诧紝涓嶉噸澶嶄富鎻忚竟銆?*/
function applyPrefabTextOutline(textNode, textData, underlay) {
  if (underlay) {
    textNode.strokes = [];
    return;
  }
  const outline = ((textData.effects || {}).outline) || null;
  if (!outline || numericOr(outline.width, 0) <= 0) {
    textNode.strokes = [];
    return;
  }
  textNode.strokes = [prefabSolidPaint(outline.color || textData.outlineColor, { r: 0, g: 0, b: 0, a: 1 })];
  textNode.strokeWeight = resolvePrefabTextStrokeWeight(outline, textNode);
  textNode.strokeAlign = "OUTSIDE";
}

/** TMP SDF 描边比 Figma Stroke 更厚，按 Unity 截图经验放大到可见的 2-4px 区间。 */
function resolvePrefabTextStrokeWeight(outline, textNode) {
  const width = numericOr(outline && outline.width, 0);
  const fontSize = positiveOr(textNode && textNode.fontSize, 16);
  if (width <= 0) {
    return 0;
  }
  const estimated = width * fontSize * 0.5;
  return Math.max(2, Math.min(4, estimated));
}

/** 鎶?TMP 姘村钩瀵归綈鏋氫妇鏄犲皠鍒?Figma銆?*/
function mapPrefabTextAlignHorizontal(value) {
  const number = numericOr(value, 2);
  if (number === 1) return "LEFT";
  if (number === 4) return "RIGHT";
  if (number === 8 || number === 16) return "JUSTIFIED";
  return "CENTER";
}

/** 鎶?TMP 鍨傜洿瀵归綈鏋氫妇鏄犲皠鍒?Figma銆?*/
function mapPrefabTextAlignVertical(value) {
  const number = numericOr(value, 512);
  if (number === 256 || number === 8192) return "TOP";
  if (number === 1024) return "BOTTOM";
  return "CENTER";
}

function recordPrefabUnsupportedComponents(sourceNode, context) {
  if (!Array.isArray(sourceNode.unsupported) || sourceNode.unsupported.length <= 0) {
    return;
  }
  context.stats.unsupportedCount += 1;
  context.warnings.push(`${sourceNode.path || sourceNode.name}: unsupported components recorded for report-only downgrade.`);
}

/** 鏍规嵁鐢ㄦ埛閫夋嫨鍐冲畾鏄惁鎶婇《灞傚鍏ヨ妭鐐硅浆涓?Component銆?*/
async function applyPrefabComponentMode(topLevelNode, context) {
  const mode = String(context.job.componentMode || context.plan.componentMode || "component").toLowerCase();
  const requested = mode !== "frame" && mode !== "none";
  if (!requested) {
    return { requested: false, created: false, node: topLevelNode };
  }
  if (!topLevelNode || topLevelNode.type !== "FRAME") {
    addPrefabBlockingError(context, "componentModeUnsupportedNode", "Component mode requires the top-level node to be a FRAME.", {
      nodeId: topLevelNode && topLevelNode.id,
      nodeType: topLevelNode && topLevelNode.type
    });
    return { requested: true, created: false, node: topLevelNode };
  }
  try {
    const shouldClipContent = "clipsContent" in topLevelNode ? !!topLevelNode.clipsContent : false;
    const component = figma.createComponentFromNode(topLevelNode);
    if ("clipsContent" in component) {
      component.clipsContent = shouldClipContent;
    }
    markPrefabMutatedNode(component, context);
    writePrefabPluginData(component, {
      nodeRole: "prefabComponent",
      componentMode: "component",
      prefabGuid: String(context.package.prefabGuid || "")
    });
    refreshPrefabUnityNodeMapFromFigmaRoot(component, context);
    return { requested: true, created: true, node: component, nodeId: component.id };
  } catch (error) {
    addPrefabBlockingError(context, "componentModeFailed", "Figma top-level component conversion failed; original frame was kept.", {
      reason: error instanceof Error ? error.message : String(error)
    });
    return { requested: true, created: false, node: topLevelNode };
  }
}

function refreshPrefabUnityNodeMapFromFigmaRoot(root, context) {
  const refreshed = new Map();
  const sourceIds = new Set(((context.package && context.package.nodes) || []).map((node) => String(node && node.id || "")).filter(Boolean));
  const visit = (node) => {
    if (!node || typeof node.getSharedPluginData !== "function") {
      return;
    }
    const unityNodeId = node.getSharedPluginData(PrefabToFigmaNamespace, "unityNodeId");
    if (unityNodeId && sourceIds.has(String(unityNodeId)) && isPrefabUnityContainerNode(node)) {
      refreshed.set(String(unityNodeId), node);
    }
  };
  visit(root);
  if (root && "findAll" in root) {
    root.findAll((node) => {
      visit(node);
      return false;
    });
  }
  if (refreshed.size > 0) {
    context.nodeByUnityId = refreshed;
  }
}

function isPrefabUnityContainerNode(node) {
  return !!(node && (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE"));
}

/** 鍐欏叆 Unity 鑺傜偣鍏冩暟鎹紝渚涘洖鍐欏拰瀹℃煡浣跨敤銆?*/
function writePrefabNodeMetadata(figmaNode, sourceNode, context) {
  const unity = sourceNode.unity || {};
  const canvasGroup = sourceNode.canvasGroup || {};
  writePrefabPluginData(figmaNode, {
    importKind: "prefab-to-figma",
    prefabPath: context.package.prefabPath || "",
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    unityName: sourceNode.name || "",
    gameObjectId: unity.gameObjectId || "",
    rectTransformId: unity.rectTransformId || "",
    parentRectId: unity.parentRectId || "",
    active: sourceNode.active !== false ? "true" : "false",
    canvasGroupAlpha: canvasGroup.alpha !== undefined ? String(canvasGroup.alpha) : "",
    canvasGroupInteractable: canvasGroup.interactable !== undefined ? String(canvasGroup.interactable) : "",
    canvasGroupBlocksRaycasts: canvasGroup.blocksRaycasts !== undefined ? String(canvasGroup.blocksRaycasts) : "",
    canvasGroupIgnoreParentGroups: canvasGroup.ignoreParentGroups !== undefined ? String(canvasGroup.ignoreParentGroups) : "",
    rect: sourceNode.rect || {}
  });
}

/** 鍐欏叆鍥剧墖鑺傜偣鍏冩暟鎹紝淇濈暀 Unity Sprite 淇℃伅銆?*/
function writePrefabImageMetadata(figmaNode, image, sourceNode) {
  const sourceImage = image.sourceImage || {};
  const pixelSize = image.pixelSize || {};
  const border = image.border || {};
  const color = image.color || {};
  writePrefabPluginData(figmaNode, {
    nodeRole: image.mode === "nine-slice" ? "nineSlice" : "image",
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    spriteGuid: image.guid || sourceImage.spriteGuid || image.asset || "",
    spritePath: sourceImage.assetPath || image.assetPath || "",
    imageGuid: image.guid || image.asset || "",
    imageType: image.imageType || "",
    spriteBorder: `${numericOr(border.left, 0)},${numericOr(border.bottom, 0)},${numericOr(border.right, 0)},${numericOr(border.top, 0)}`,
    originalPixelSize: `${numericOr(sourceImage.width, numericOr(pixelSize.width, 0))}x${numericOr(sourceImage.height, numericOr(pixelSize.height, 0))}`,
    unityImageColor: image.color || "",
    unityImageAlpha: color && color.a !== undefined ? String(color.a) : "1",
    unityImageTintUnsupported: prefabImageHasRgbTint(image) ? "true" : "false",
    preserveAspect: image.preserveAspect === true ? "true" : "false",
    uvRect: image.uvRect || ""
  });
}

function prefabImageOpacity(image) {
  return clampPrefab01(firstDefined(image && image.color && image.color.a, 1));
}

function prefabImageHasRgbTint(image) {
  const color = image && image.color;
  if (!color || typeof color !== "object") {
    return false;
  }
  return !prefabNumberApproximatelyEqual(firstDefined(color.r, 1), 1) ||
    !prefabNumberApproximatelyEqual(firstDefined(color.g, 1), 1) ||
    !prefabNumberApproximatelyEqual(firstDefined(color.b, 1), 1);
}

function validatePrefabImageLayerVisual(figmaNode, image, sourceNode, layerName, expectedOpacity, expectedVisual) {
  const fills = Array.isArray(figmaNode && figmaNode.fills) ? figmaNode.fills : [];
  const imageFill = fills.find((fill) => fill && fill.type === "IMAGE");
  const actualOpacity = imageFill ? numericOr(firstDefined(imageFill.opacity, 1), 1) : null;
  const expected = clampPrefab01(expectedOpacity);
  const visual = expectedVisual || {};
  const expectedScaleMode = visual.scaleMode || (normalizePrefabUvRect(image && image.uvRect) ? "CROP" : "FILL");
  const actualScaleMode = imageFill ? String(imageFill.scaleMode || "") : "";
  const expectedTransform = visual.imageTransform || (expectedScaleMode === "CROP" ? buildPrefabUvCropTransform(normalizePrefabUvRect(image.uvRect)) : null);
  const actualTransform = imageFill && imageFill.imageTransform ? imageFill.imageTransform : null;
  const expectedGeometry = visual.geometry || null;
  const actualGeometry = figmaNode ? {
    x: numericOr(figmaNode.x, 0),
    y: numericOr(figmaNode.y, 0),
    width: positiveOr(figmaNode.width, 0),
    height: positiveOr(figmaNode.height, 0)
  } : null;
  const opacityPass = !!imageFill && prefabNumberApproximatelyEqual(actualOpacity, expected);
  const scaleModePass = !!imageFill && actualScaleMode === expectedScaleMode;
  const transformPass = !expectedTransform || prefabTransformApproximatelyEqual(actualTransform || [], expectedTransform);
  const geometryPass = !expectedGeometry || prefabRectApproximatelyEqual(actualGeometry || {}, expectedGeometry);
  const pass = opacityPass && scaleModePass && transformPass && geometryPass;
  return {
    pass,
    reason: pass ? "" : "image_visual_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    nodePath: sourceNode.path || sourceNode.name || "",
    figmaNodeId: figmaNode && figmaNode.id || "",
    layerName,
    expected: { opacity: expected, scaleMode: expectedScaleMode, imageTransform: expectedTransform, geometry: expectedGeometry },
    actual: { opacity: actualOpacity, scaleMode: actualScaleMode, imageTransform: actualTransform, geometry: actualGeometry },
    tintUnsupported: prefabImageHasRgbTint(image)
  };
}

function clampPrefab01(value) {
  const number = numericOr(value, 1);
  return Math.max(0, Math.min(1, number));
}

/** 鍐欏叆 TMP 鏉愯川鍜屽瓧浣撻檷绾у厓鏁版嵁銆?*/
function writePrefabTextMetadata(textNode, textData, sourceNode, fontName) {
  const sharedMaterial = textData.sharedMaterial || {};
  const existingUnityFontSize = textNode.getSharedPluginData(PrefabToFigmaNamespace, "unityFontSize");
  const figmaFontSize = textNode.getSharedPluginData(PrefabToFigmaNamespace, "figmaFontSize");
  const fontSizeMode = textNode.getSharedPluginData(PrefabToFigmaNamespace, "fontSizeMode");
  writePrefabPluginData(textNode, {
    nodeRole: "text",
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    tmpMaterialTag: textData.materialTag || "",
    tmpMaterialName: sharedMaterial.name || "",
    tmpMaterialGuid: sharedMaterial.guid || "",
    fontFallback: "true",
    figmaFontFamily: fontName.family,
    figmaFontStyle: fontName.style,
    unityFontSize: existingUnityFontSize || String(textData.fontSize || ""),
    figmaFontSize: figmaFontSize || String(textNode.fontSize || ""),
    fontSizeMode: fontSizeMode || ""
  });
}

/** 鏍￠獙 TMP 鏉愯川鍏冩暟鎹槸鍚﹀啓鍏ュ埌鏂囨湰鑺傜偣銆?*/
function validatePrefabTmpMetadata(textNode, textData, sourceNode) {
  const sharedMaterial = textData.sharedMaterial || {};
  const report = {
    nodePath: sourceNode.path || sourceNode.name || "",
    textNodeId: textNode.id,
    layerName: textNode.name,
    tmpMaterialTag: textNode.getSharedPluginData(PrefabToFigmaNamespace, "tmpMaterialTag"),
    tmpMaterialName: textNode.getSharedPluginData(PrefabToFigmaNamespace, "tmpMaterialName"),
    tmpMaterialGuid: textNode.getSharedPluginData(PrefabToFigmaNamespace, "tmpMaterialGuid")
  };
  report.pass = report.tmpMaterialTag === String(textData.materialTag || "") &&
    report.tmpMaterialName === String(sharedMaterial.name || "") &&
    report.tmpMaterialGuid === String(sharedMaterial.guid || "");
  return report;
}

/** 鍐欏叆 SharedPluginData锛岄伩鍏嶆櫘閫?pluginData 鐨勬彃浠舵竻鍗曢殧绂汇€?*/
function writePrefabPluginData(node, values) {
  if (!node || typeof node.setSharedPluginData !== "function") {
    return;
  }
  for (const key of Object.keys(values || {})) {
    node.setSharedPluginData(PrefabToFigmaNamespace, key, serializePrefabMetadataValue(values[key]));
  }
}

/** 搴忓垪鍖栧厓鏁版嵁鍊硷紝瀵硅薄缁熶竴杞?JSON 瀛楃涓层€?*/
function serializePrefabMetadataValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** 璁板綍鏂板缓鑺傜偣 ID锛屼究浜?Python 渚у鏍告姤鍛婅惤鐩樸€?*/
function markPrefabCreatedNode(node, context) {
  if (node && node.id) {
    context.createdNodeIds.push(node.id);
  }
}

/** 璁板綍琚粍浠跺寲绛夋搷浣滄浛鎹㈡垨鍙樻洿鐨勮妭鐐?ID銆?*/
function resolvePrefabInstanceParent(instanceOverride, topLevelNode, context) {
  const parentRectId = String((instanceOverride || {}).parentRectId || "");
  const resolvedParent = parentRectId && context && context.nodeByUnityId
    ? context.nodeByUnityId.get(parentRectId)
    : null;
  const parent = resolvedParent || topLevelNode;
  return {
    node: parent,
    parentRectId,
    parentResolved: !parentRectId || !!resolvedParent,
    parentFallbackToTopLevel: !!parentRectId && !resolvedParent,
    parentNodeId: parent && parent.id || "",
    parentNodeName: parent && parent.name || "",
    parentNodeType: parent && parent.type || ""
  };
}

function registerPrefabInstanceStrippedRectAliases(node, item, context, report) {
  const ids = Array.isArray(item && item.strippedRectTransformIds)
    ? item.strippedRectTransformIds.map((id) => String(id || "")).filter(Boolean)
    : [];
  if (!node || !context || !context.nodeByUnityId || ids.length === 0) {
    return [];
  }
  const uniqueIds = [];
  for (const id of ids) {
    if (uniqueIds.indexOf(id) < 0) {
      uniqueIds.push(id);
      context.nodeByUnityId.set(id, node);
    }
  }
  writePrefabPluginData(node, {
    strippedRectTransformIds: uniqueIds
  });
  if (report) {
    report.strippedRectTransformIds = uniqueIds;
    report.registeredParentAliasCount = uniqueIds.length;
  }
  return uniqueIds;
}

function buildPrefabInstanceParentIdSet(prefabInstances) {
  const ids = new Set();
  for (const item of prefabInstances || []) {
    const parentRectId = String(((item || {}).instanceOverride || {}).parentRectId || "");
    if (parentRectId) {
      ids.add(parentRectId);
    }
  }
  return ids;
}

function prefabInstanceNeedsChildContainer(item, prefabParentIds) {
  if (!item || !prefabParentIds) {
    return false;
  }
  const ids = Array.isArray(item.strippedRectTransformIds) ? item.strippedRectTransformIds : [];
  return ids.some((id) => prefabParentIds.has(String(id || "")));
}

function createPrefabInstanceContainerFrame(parent, instanceOverride, component) {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  frame.name = String((instanceOverride || {}).name || (component && component.name) || "PrefabInstance");
  frame.clipsContent = false;
  frame.fills = [];
  frame.strokes = [];
  return frame;
}

function fitPrefabComponentInstanceInContainer(instance, container) {
  if (!instance || !container) {
    return;
  }
  instance.x = 0;
  instance.y = 0;
  if ("resize" in instance) {
    instance.resize(positiveOr(container.width, instance.width || 1), positiveOr(container.height, instance.height || 1));
  }
  if ("constraints" in instance) {
    instance.constraints = { horizontal: "SCALE", vertical: "SCALE" };
  }
}

function markPrefabMutatedNode(node, context) {
  if (node && node.id) {
    context.mutatedNodeIds.push(node.id);
  }
}

/** 杩藉姞缁撴瀯鍖栭樆濉為敊璇紝渚?LLM 鍙鏍告姤鍛娿€?*/
function addPrefabBlockingError(context, code, message, details) {
  context.blockingErrors.push({
    code,
    message,
    details: Array.isArray(details) ? details : [details || {}]
  });
}

/** 鎶?Unity 棰滆壊瀵硅薄杞崲涓?Figma SOLID paint銆?*/
function prefabSolidPaint(color, fallback) {
  const source = color && typeof color === "object" ? color : fallback;
  return solidPaintFromManifest(source || { r: 0, g: 0, b: 0 }, firstDefined(source && source.a, 1));
}

/** 鍏煎 {x,y,width,height} 鍜?[x,y,w,h] 涓ょ rect銆?*/
function prefabRectObject(value) {
  if (Array.isArray(value)) {
    return {
      x: numericOr(value[0], 0),
      y: numericOr(value[1], 0),
      width: positiveOr(value[2], 1),
      height: positiveOr(value[3], 1)
    };
  }
  const rect = value || {};
  return {
    x: numericOr(rect.x, 0),
    y: numericOr(rect.y, 0),
    width: positiveOr(rect.width, 1),
    height: positiveOr(rect.height, 1)
  };
}

/** Export top-level imported node screenshot as Relay verification evidence. */
async function exportPrefabWriteScreenshot(root, context) {
  if (!context || !context.screenshotPolicy || context.screenshotPolicy.export !== true) {
    context.warnings.push("Prefab 写入阶段已跳过 Relay 截图导出，避免大节点导出阻塞；请使用 Figma 截图工具做最终视觉验收。");
    return null;
  }
  try {
    return await exportRootScreenshot(root, context);
  } catch (error) {
    context.warnings.push(`Prefab screenshot export failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 鐢熸垚鍐欏叆鍚庣殑缁熶竴楠岃瘉缁撴灉锛屽苟鎶婄‖闂ㄧ澶辫触杩藉姞鍒?blockingErrors銆?*/
function validatePrefabWriteResult(topLevelNode, context, componentResult, screenshot) {
  validatePrefabUnityNodeReadback(context);
  const expectedNodeCount = (context.package.nodes || []).length;
  const checks = {
    nodeCount: makePrefabCheck(
      context.nodeByUnityId.size === expectedNodeCount,
      { expected: expectedNodeCount, actual: context.nodeByUnityId.size },
      context.nodeByUnityId.size === expectedNodeCount ? [] : [{ expected: expectedNodeCount, actual: context.nodeByUnityId.size }]
    ),
    imageFillHashLength: makePrefabCheck(
      context.imageHashReports.every((item) => item.pass) && context.stats.missingAssetCount === 0,
      { imageHashCount: context.imageHashReports.length, missingAssetCount: context.stats.missingAssetCount },
      context.imageHashReports.filter((item) => !item.pass)
    ),
    imageLayerVisual: makePrefabCheck(
      context.imageLayerVisualReports.every((item) => item.pass),
      { imageLayerCount: context.imageLayerVisualReports.length },
      context.imageLayerVisualReports.filter((item) => !item.pass)
    ),
    tmpMaterialPluginData: makePrefabCheck(
      context.tmpMaterialReports.every((item) => item.pass),
      { tmpMaterialTextCount: context.tmpMaterialReports.length },
      context.tmpMaterialReports.filter((item) => !item.pass)
    ),
    textOutlineStroke: makePrefabCheck(
      context.outlineReports.every((item) => item.pass),
      { outlineTextCount: context.outlineReports.length },
      context.outlineReports.filter((item) => !item.pass)
    ),
    nineSliceSourceImageMetadata: makePrefabCheck(
      context.nineSliceReports.every((item) => item.pass),
      { nineSliceCount: context.nineSliceReports.length },
      context.nineSliceReports.filter((item) => !item.pass)
    ),
    unityNodeGeometry: validatePrefabUnityNodeGeometry(context),
    unityNodeOrder: validatePrefabUnityNodeOrder(context),
    unityNodeState: validatePrefabUnityNodeState(context),
    prefabInstanceNodeType: validatePrefabInstances(context),
    prefabInstanceGeometry: validatePrefabInstanceGeometry(context),
    componentModeResult: makePrefabCheck(
      !componentResult || !componentResult.requested || componentResult.created === true,
      { requested: !!(componentResult && componentResult.requested), created: !!(componentResult && componentResult.created), nodeId: componentResult && componentResult.nodeId || topLevelNode.id },
      componentResult && componentResult.requested && !componentResult.created ? [{ reason: "component_not_created" }] : []
    ),
    screenshotAcceptance: makePrefabCheck(
      true,
      { screenshotExported: !!screenshot, skipped: !screenshot },
      []
    ),
    fontConsistency: validatePrefabFontConsistency(topLevelNode, context)
  };
  context.checks = checks;
  for (const checkName of Object.keys(checks)) {
    if (!checks[checkName].pass) {
      addPrefabBlockingError(context, checkName, `${checkName} 楠岃瘉澶辫触`, checks[checkName].details || []);
    }
  }
  return {
    allPass: Object.keys(checks).every((key) => checks[key].pass),
    checkCount: Object.keys(checks).length,
    failedChecks: Object.keys(checks).filter((key) => !checks[key].pass)
  };
}

/** Verify every Unity frame read back from Figma so ordinary layout drift is blocking. */
function validatePrefabUnityNodeReadback(context) {
  context.unityNodeGeometryReports = [];
  context.unityNodeOrderReports = [];
  context.unityNodeStateReports = [];
  const nodes = (context.package && Array.isArray(context.package.nodes)) ? context.package.nodes : [];
  const nodeById = new Map();
  for (const node of nodes) {
    if (node && node.id) {
      nodeById.set(String(node.id), node);
    }
  }
  context.expectedGeometryScaleByUnityId = buildPrefabExpectedGeometryScaleMap(context.package && context.package.root);
  const rootId = context.package && context.package.root && context.package.root.id ? String(context.package.root.id) : "";
  for (const sourceNode of nodes) {
    if (!sourceNode || !sourceNode.id) {
      continue;
    }
    const sourceId = String(sourceNode.id);
    const figmaNode = context.nodeByUnityId.get(sourceId);
    context.unityNodeGeometryReports.push(buildPrefabUnityNodeGeometryReport(figmaNode, sourceNode, context, sourceId === rootId));
    context.unityNodeStateReports.push(buildPrefabUnityNodeStateReport(figmaNode, sourceNode, context, sourceId === rootId));
    const children = getPrefabSourceChildIds(sourceNode);
    if (children.length > 0) {
      context.unityNodeOrderReports.push(buildPrefabUnityNodeOrderReport(figmaNode, sourceNode, nodeById));
    }
  }
}

function buildPrefabExpectedGeometryScaleMap(rootNode) {
  const map = new Map();
  const visit = (sourceNode, inheritedScale) => {
    if (!sourceNode || !sourceNode.id) {
      return;
    }
    const geometryScale = resolvePrefabGeometryScale(inheritedScale);
    map.set(String(sourceNode.id), geometryScale);
    const childGeometryScale = resolvePrefabChildGeometryScale(geometryScale, sourceNode && sourceNode.rect ? sourceNode.rect : {});
    const children = Array.isArray(sourceNode.children) ? sourceNode.children : [];
    for (const child of children) {
      visit(child, childGeometryScale);
    }
  };
  visit(rootNode, { x: 1, y: 1 });
  return map;
}

function buildPrefabUnityNodeGeometryReport(figmaNode, sourceNode, context, isRoot) {
  const rect = sourceNode.rect || {};
  const expectedScale = resolvePrefabExpectedGeometryScale(sourceNode, context);
  const expected = {
    x: numericOr(rect.x, 0) * expectedScale.x,
    y: numericOr(rect.y, 0) * expectedScale.y,
    width: Math.max(0.01, positiveOr(rect.width, 1) * expectedScale.x),
    height: Math.max(0.01, positiveOr(rect.height, 1) * expectedScale.y)
  };
  if (!figmaNode) {
    return {
      pass: false,
      reason: "figma_node_missing",
      unityNodeId: String(sourceNode.id || ""),
      nodePath: sourceNode.path || sourceNode.name || "",
      expected,
      actual: null
    };
  }
  const expectedPosition = resolvePrefabExpectedReadbackPosition(sourceNode, context, expected, isRoot);
  expected.x = expectedPosition.x;
  expected.y = expectedPosition.y;
  const expectedTransform = buildPrefabExpectedRelativeTransform(rect, expected.x, expected.y, expected.width, expected.height);
  if (expectedTransform) {
    const actualTransform = figmaNode.relativeTransform || [];
    const actual = {
      width: positiveOr(figmaNode.width, 0),
      height: positiveOr(figmaNode.height, 0),
      relativeTransform: actualTransform
    };
    const pass = prefabNumberApproximatelyEqual(actual.width, expected.width) &&
      prefabNumberApproximatelyEqual(actual.height, expected.height) &&
      prefabTransformApproximatelyEqual(actualTransform, expectedTransform);
    return {
      pass,
      reason: pass ? "" : "transform_mismatch",
      unityNodeId: String(sourceNode.id || ""),
      figmaNodeId: figmaNode.id,
      nodePath: sourceNode.path || sourceNode.name || "",
      expected: { width: expected.width, height: expected.height, relativeTransform: expectedTransform },
      actual
    };
  }
  const actual = {
    x: expectedPosition.skipPosition ? expected.x : numericOr(figmaNode.x, 0),
    y: expectedPosition.skipPosition ? expected.y : numericOr(figmaNode.y, 0),
    width: positiveOr(figmaNode.width, 0),
    height: positiveOr(figmaNode.height, 0)
  };
  expected.x = expectedPosition.x;
  expected.y = expectedPosition.y;
  const pass = prefabRectApproximatelyEqual(actual, expected);
  return {
    pass,
    reason: pass ? "" : "rect_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    figmaNodeId: figmaNode.id,
    nodePath: sourceNode.path || sourceNode.name || "",
    expected,
    actual
  };
}

function resolvePrefabExpectedGeometryScale(sourceNode, context) {
  const unityNodeId = String(sourceNode && sourceNode.id || "");
  const map = context && context.expectedGeometryScaleByUnityId;
  if (unityNodeId && map && typeof map.get === "function") {
    return resolvePrefabGeometryScale(map.get(unityNodeId));
  }
  return { x: 1, y: 1 };
}

function resolvePrefabExpectedReadbackPosition(sourceNode, context, expected, isRoot) {
  if (!isRoot) {
    return { x: expected.x, y: expected.y, skipPosition: false };
  }
  if (prefabNeedsImportBoundsWrapper(context.package, context.plan)) {
    const rootOffset = resolveImportBoundsRootOffset(sourceNode.rect || {}, context.package.visualBounds || {});
    return { x: rootOffset.x, y: rootOffset.y, skipPosition: false };
  }
  return { x: expected.x, y: expected.y, skipPosition: true };
}

function buildPrefabExpectedRelativeTransform(rect, x, y, width, height) {
  const rotation = numericOr(rect && rect.rotationZ, 0);
  const scaleX = numericOr(rect && rect.scaleX, 1);
  const scaleY = numericOr(rect && rect.scaleY, 1);
  const transformScaleX = scaleX < 0 ? -1 : 1;
  const transformScaleY = scaleY < 0 ? -1 : 1;
  if (Math.abs(rotation) < 0.001 && transformScaleX === 1 && transformScaleY === 1) {
    return null;
  }
  const radians = -rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = width / 2;
  const cy = height / 2;
  const pivotX = x + cx;
  const pivotY = y + cy;
  const a = cos * transformScaleX;
  const b = sin * transformScaleY;
  const c = -sin * transformScaleX;
  const d = cos * transformScaleY;
  return [
    [a, b, pivotX - a * cx - b * cy],
    [c, d, pivotY - c * cx - d * cy]
  ];
}

function buildPrefabUnityNodeStateReport(figmaNode, sourceNode, context, isRoot) {
  const expectedVisible = sourceNode.active !== false;
  const expectedOpacity = resolvePrefabNodeOpacity(sourceNode);
  const expectedClipsContent = !!((sourceNode.clip || {}).enabled) ||
    shouldExpectPrefabRootViewportClip(sourceNode, context, isRoot);
  if (!figmaNode) {
    return {
      pass: false,
      reason: "figma_node_missing",
      unityNodeId: String(sourceNode.id || ""),
      nodePath: sourceNode.path || sourceNode.name || ""
    };
  }
  const actualVisible = figmaNode.visible !== false;
  const actualOpacity = numericOr(figmaNode.opacity, 1);
  const actualClipsContent = "clipsContent" in figmaNode ? !!figmaNode.clipsContent : false;
  const pass = actualVisible === expectedVisible &&
    prefabNumberApproximatelyEqual(actualOpacity, expectedOpacity) &&
    actualClipsContent === expectedClipsContent;
  return {
    pass,
    reason: pass ? "" : "state_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    figmaNodeId: figmaNode.id,
    nodePath: sourceNode.path || sourceNode.name || "",
    expected: { visible: expectedVisible, opacity: expectedOpacity, clipsContent: expectedClipsContent },
    actual: { visible: actualVisible, opacity: actualOpacity, clipsContent: actualClipsContent }
  };
}

function shouldExpectPrefabRootViewportClip(sourceNode, context, isRoot) {
  if (!isRoot || !context || context.isCreatingNestedPrefabComponent === true) {
    return false;
  }
  const canvas = context.package && context.package.canvas ? context.package.canvas : {};
  const rect = sourceNode && sourceNode.rect ? sourceNode.rect : {};
  const canvasWidth = positiveOr(canvas.width, 0);
  const canvasHeight = positiveOr(canvas.height, 0);
  const rectWidth = positiveOr(rect.width, 0);
  const rectHeight = positiveOr(rect.height, 0);
  if (canvasWidth <= 0 || canvasHeight <= 0 || rectWidth <= 0 || rectHeight <= 0) {
    return false;
  }
  return Math.abs(rectWidth - canvasWidth) < 0.5 && Math.abs(rectHeight - canvasHeight) < 0.5;
}

function buildPrefabUnityNodeOrderReport(figmaNode, sourceNode, nodeById) {
  const expected = getPrefabSourceChildIds(sourceNode).filter((childId) => nodeById.has(String(childId)));
  if (!figmaNode || !Array.isArray(figmaNode.children)) {
    return {
      pass: false,
      reason: "figma_node_missing_or_not_container",
      unityNodeId: String(sourceNode.id || ""),
      nodePath: sourceNode.path || sourceNode.name || "",
      expected,
      actual: []
    };
  }
  const actual = [];
  for (const childNode of figmaNode.children) {
    if (!childNode || typeof childNode.getSharedPluginData !== "function" || !isPrefabUnityContainerNode(childNode)) {
      continue;
    }
    const childUnityId = childNode.getSharedPluginData(PrefabToFigmaNamespace, "unityNodeId");
    if (!childUnityId || String(childUnityId) === String(sourceNode.id || "") || !nodeById.has(String(childUnityId))) {
      continue;
    }
    actual.push(String(childUnityId));
  }
  const pass = arraysEqual(expected, actual);
  return {
    pass,
    reason: pass ? "" : "child_order_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    figmaNodeId: figmaNode.id,
    nodePath: sourceNode.path || sourceNode.name || "",
    expected,
    actual
  };
}

function getPrefabSourceChildIds(sourceNode) {
  const unityChildren = sourceNode && sourceNode.unity && Array.isArray(sourceNode.unity.children) ? sourceNode.unity.children : null;
  if (unityChildren) {
    return unityChildren.map((childId) => String(childId || "")).filter(Boolean);
  }
  return (sourceNode && Array.isArray(sourceNode.children) ? sourceNode.children : [])
    .map((child) => String(child && child.id || ""))
    .filter(Boolean);
}

function validatePrefabUnityNodeGeometry(context) {
  const reports = context.unityNodeGeometryReports || [];
  const mismatches = reports.filter((item) => !item.pass);
  return makePrefabCheck(
    reports.length === ((context.package.nodes || []).length) && mismatches.length === 0,
    { checkedCount: reports.length, mismatchCount: mismatches.length },
    mismatches
  );
}

function validatePrefabUnityNodeOrder(context) {
  const reports = context.unityNodeOrderReports || [];
  const mismatches = reports.filter((item) => !item.pass);
  return makePrefabCheck(
    mismatches.length === 0,
    { checkedParentCount: reports.length, mismatchCount: mismatches.length },
    mismatches
  );
}

function validatePrefabUnityNodeState(context) {
  const reports = context.unityNodeStateReports || [];
  const mismatches = reports.filter((item) => !item.pass);
  return makePrefabCheck(
    reports.length === ((context.package.nodes || []).length) && mismatches.length === 0,
    { checkedCount: reports.length, mismatchCount: mismatches.length },
    mismatches
  );
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) {
      return false;
    }
  }
  return true;
}

/** PrefabInstance 鍒濈増鍙仛纭棬绂侊紝涓嶇敤 Frame 鍗犱綅浼 Instance銆?*/
function validatePrefabInstances(context) {
  const prefabInstances = getPlannedPrefabInstances(context);
  if (!Array.isArray(prefabInstances) || prefabInstances.length === 0) {
    const skippedCount = (context.plan.operations && Array.isArray(context.plan.operations.skippedPrefabInstances))
      ? context.plan.operations.skippedPrefabInstances.length
      : 0;
    return makePrefabCheck(true, { prefabInstanceCount: 0, instanceCount: 0, autoCreatedComponentCount: 0, skippedPrefabInstanceCount: skippedCount }, []);
  }
  const reports = context.prefabInstanceReports || [];
  const instanceCount = reports.filter((item) => item.instanceNodeType === "INSTANCE").length;
  const frameCount = reports.filter((item) => item.instanceNodeType === "FRAME" && item.renderMode === "frame").length;
  const missingPlaceholderCount = reports.filter((item) => item.instanceNodeType === "FRAME" && item.renderMode === "missing").length;
  const autoCreatedComponentCount = (context.nestedComponentReports || []).filter((item) => item.pass).length;
  const pass = reports.length === prefabInstances.length && reports.every((item) => item.pass);
  return makePrefabCheck(
    pass,
    { prefabInstanceCount: prefabInstances.length, instanceCount, frameCount, missingPlaceholderCount, autoCreatedComponentCount },
    reports.concat(context.nestedComponentReports || [])
  );
}

/** Verify prefab instance read-back geometry so layout drift cannot pass as long as node type is INSTANCE. */
function validatePrefabInstanceGeometry(context) {
  const planned = getPlannedPrefabInstances(context);
  const reports = context.prefabInstanceGeometryReports || [];
  if (!Array.isArray(planned) || planned.length === 0) {
    return makePrefabCheck(true, { prefabInstanceCount: 0, checkedCount: 0, mismatchCount: 0 }, []);
  }
  const mainInstanceIds = new Set((context.prefabInstanceReports || [])
    .map((item) => String(item && item.instanceNodeId || ""))
    .filter(Boolean));
  const mainReports = reports.filter((item) => mainInstanceIds.has(String(item && item.instanceNodeId || "")));
  const mismatchReports = mainReports.filter((item) => !item.pass);
  const missingCount = Math.max(0, planned.length - mainReports.length);
  return makePrefabCheck(
    mainReports.length >= planned.length && missingCount === 0 && mismatchReports.length === 0,
    {
      prefabInstanceCount: planned.length,
      checkedCount: mainReports.length,
      nestedCheckedCount: Math.max(0, reports.length - mainReports.length),
      mismatchCount: mismatchReports.length,
      missingCount
    },
    mismatchReports
  );
}

/** 妫€鏌ュ鍏ユ枃鏈妭鐐圭殑瀛椾綋涓庢枃浠舵娴嬪埌鐨勫亸濂藉瓧浣撲竴鑷淬€?
    濡傛灉鏂囨湰鑺傜偣浣跨敤浜?JSON 涓殑 sourceFontFamily锛堝 GROBOLD锛夛紝瑙嗕负鍚堟硶锛屼笉鏍囪涓?mismatch銆?*/
function validatePrefabFontConsistency(topLevelNode, context) {
  if (!context.fileFont) {
    return makePrefabCheck(true, { reason: "no_file_font_detected" }, []);
  }
  const textNodes = [];
  if ("findAll" in topLevelNode) {
    topLevelNode.findAll(n => {
      if (n.type === "TEXT" && !hasPrefabAncestorType(n, "INSTANCE", topLevelNode)) {
        textNodes.push(n);
      }
      return false;
    });
  }
  if (textNodes.length === 0) {
    return makePrefabCheck(true, { reason: "no_text_nodes", detectedFont: context.fileFont }, []);
  }
  // 鏀堕泦鎵€鏈?sourceFontFamily 浣滀负鍚堟硶瀛椾綋锛堜粠 context 涓凡浣跨敤鐨勫瓧浣撹褰曪級
  var allowedFamilies = context.allowedFontFamilies || {};
  var hasAllowed = Object.keys(allowedFamilies).length > 0;
  const mismatches = [];
  for (var i = 0; i < textNodes.length; i++) {
    var tn = textNodes[i];
    var fn = tn.fontName;
    if (!fn) continue;
    var isFileFont = (fn.family === context.fileFont.family && fn.style === context.fileFont.style);
    var isAllowedFont = hasAllowed && allowedFamilies[fn.family + "/" + fn.style];
    if (!isFileFont && !isAllowedFont) {
      mismatches.push({ nodeId: tn.id, nodeName: tn.parent.name || "", font: fn.family + " " + fn.style, expected: context.fileFont.family + " " + context.fileFont.style });
    }
  }
  const pass = mismatches.length === 0 && textNodes.length > 0;
  return makePrefabCheck(pass, { textNodeCount: textNodes.length, detectedFont: context.fileFont, mismatchCount: mismatches.length }, mismatches);
}

/** 判断节点祖先链中是否存在指定类型，用于跳过复用组件内部文本。 */
function hasPrefabAncestorType(node, type, stopNode) {
  var current = node && node.parent ? node.parent : null;
  while (current && current !== stopNode) {
    if (current.type === type) {
      return true;
    }
    current = current.parent || null;
  }
  return false;
}

/** 鏋勫缓宓屽 Prefab 鍙鐢ㄧ粍浠跺€欓€夊悕銆?*/
/** 涓哄祵濂?Prefab 鍒涘缓鐪熷疄 Figma Instance锛岀姝㈢敤 Frame 鍗犱綅浼銆?*/
async function appendPrefabInstanceNodes(topLevelNode, context) {
  const prefabInstances = getPlannedPrefabInstances(context);
  if (!Array.isArray(prefabInstances) || prefabInstances.length === 0) {
    context.prefabInstanceReports = [];
    context.stats.prefabInstanceCount = 0;
    return;
  }
  const reports = [];
  const prefabParentIds = buildPrefabInstanceParentIdSet(prefabInstances);
  for (const item of prefabInstances) {
    const sourcePrefab = item.sourcePrefab || {};
    const candidates = buildPrefabInstanceCandidateNames(sourcePrefab);
    const variantKey = buildPrefabInstanceVariantKey(item);
    const renderMode = resolvePrefabInstanceRenderMode(item, context);
    const instanceOverride = item.instanceOverride || {};
    const parentResolution = resolvePrefabInstanceParent(instanceOverride, topLevelNode, context);
    const parent = parentResolution.node;
    const report = {
      sourceGuid: sourcePrefab.guid || "",
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      candidates,
      renderMode,
      parentRectId: parentResolution.parentRectId,
      parentResolved: parentResolution.parentResolved,
      parentFallbackToTopLevel: parentResolution.parentFallbackToTopLevel,
      parentNodeId: parentResolution.parentNodeId,
      parentNodeName: parentResolution.parentNodeName,
      parentNodeType: parentResolution.parentNodeType,
      pass: false
    };
    if (renderMode === "missing") {
      const placeholder = createMissingNestedPrefabPlaceholder(sourcePrefab, parent, instanceOverride, context, item);
      report.instanceNodeId = placeholder ? placeholder.id : "";
      report.instanceNodeName = placeholder ? placeholder.name : "";
      report.instanceNodeType = placeholder ? placeholder.type : "";
      registerPrefabInstanceStrippedRectAliases(placeholder, item, context, report);
      report.geometry = placeholder ? applyPrefabInstanceGeometry(placeholder, parent, instanceOverride, placeholder, sourcePrefab, context, variantKey) || {} : {};
      if (placeholder) {
        context.prefabInstanceGeometryReports.push(buildPrefabInstanceGeometryReport(placeholder, instanceOverride, report.geometry, report));
      }
      report.missingNestedPrefab = true;
      report.missingReason = String(item.missingReason || "source_prefab_asset_not_found");
      report.pass = !!placeholder && placeholder.type === "FRAME" && report.parentResolved === true;
      report.reason = report.pass ? "missing_nested_prefab_placeholder_created" : (report.parentResolved ? "missing_nested_prefab_placeholder_not_created" : "parent_rect_not_resolved");
      reports.push(report);
      continue;
    }
    if (renderMode === "frame") {
      const frame = await createNestedPrefabFrameInstance(sourcePrefab, parent, instanceOverride, context, variantKey);
      report.instanceNodeId = frame ? frame.id : "";
      report.instanceNodeName = frame ? frame.name : "";
      report.instanceNodeType = frame ? frame.type : "";
      registerPrefabInstanceStrippedRectAliases(frame, item, context, report);
      report.geometry = frame ? applyPrefabInstanceGeometry(frame, parent, instanceOverride, frame, sourcePrefab, context, variantKey) || {} : {};
      if (frame) {
        context.prefabInstanceGeometryReports.push(buildPrefabInstanceGeometryReport(frame, instanceOverride, report.geometry, report));
      }
      report.pass = !!frame && frame.type === "FRAME" && report.parentResolved === true;
      report.reason = report.pass ? "" : (report.parentResolved ? "nested_prefab_frame_not_created" : "parent_rect_not_resolved");
      reports.push(report);
      continue;
    }
    const component = await resolvePrefabInstanceComponent(sourcePrefab, candidates, context, variantKey);
    report.matchedComponentId = component ? component.id : "";
    report.matchedComponentName = component ? component.name : "";
    if (!component || (component.type !== "COMPONENT" && component.type !== "COMPONENT_SET")) {
      report.reason = "matched_component_not_found";
      reports.push(report);
      continue;
    }
    const sourceComponent = component.type === "COMPONENT_SET" && component.defaultVariant ? component.defaultVariant : component;
    const instance = sourceComponent.createInstance();
    const needsChildContainer = prefabInstanceNeedsChildContainer(item, prefabParentIds);
    let prefabNode = instance;
    let geometryReport = null;
    if (needsChildContainer) {
      prefabNode = createPrefabInstanceContainerFrame(parent, instanceOverride, component);
      geometryReport = applyPrefabInstanceGeometry(prefabNode, parent, instanceOverride, sourceComponent, sourcePrefab, context, variantKey);
      instance.name = `${prefabNode.name}__Component`;
      prefabNode.appendChild(instance);
      fitPrefabComponentInstanceInContainer(instance, prefabNode);
      writePrefabPluginData(instance, {
        nodeRole: "prefabInstanceComponent",
        sourcePrefabGuid: sourcePrefab.guid || "",
        sourcePrefabPath: sourcePrefab.assetPath || "",
        sourcePrefabFileId: sourcePrefab.fileID || ""
      });
    } else {
      parent.appendChild(instance);
      instance.name = String(instanceOverride.name || component.name || "PrefabInstance");
      geometryReport = applyPrefabInstanceGeometry(instance, parent, instanceOverride, sourceComponent, sourcePrefab, context, variantKey);
    }
    writePrefabPluginData(prefabNode, {
      nodeRole: "prefabInstance",
      sourcePrefabGuid: sourcePrefab.guid || "",
      sourcePrefabPath: sourcePrefab.assetPath || "",
      sourcePrefabFileId: sourcePrefab.fileID || "",
      parentRectId: String(instanceOverride.parentRectId || ""),
      sourceRectFileId: String(instanceOverride.sourceRectFileId || ""),
      usesChildContainer: needsChildContainer ? "true" : "false"
    });
    markPrefabCreatedNode(prefabNode, context);
    if (needsChildContainer) {
      markPrefabCreatedNode(instance, context);
      report.innerInstanceNodeId = instance.id;
      report.innerInstanceNodeName = instance.name;
      report.innerInstanceNodeType = instance.type;
    }
    report.instanceNodeId = prefabNode.id;
    report.instanceNodeName = prefabNode.name;
    report.instanceNodeType = prefabNode.type;
    report.usesChildContainer = needsChildContainer;
    registerPrefabInstanceStrippedRectAliases(prefabNode, item, context, report);
    report.geometry = geometryReport || {};
    context.prefabInstanceGeometryReports.push(buildPrefabInstanceGeometryReport(prefabNode, instanceOverride, report.geometry, report));
    report.pass = (needsChildContainer ? prefabNode.type === "FRAME" : prefabNode.type === "INSTANCE") && report.parentResolved === true;
    report.reason = report.pass ? "" : (report.parentResolved ? (needsChildContainer ? "created_container_is_not_frame" : "created_node_is_not_instance") : "parent_rect_not_resolved");
    reports.push(report);
  }
  context.prefabInstanceReports = reports;
  context.stats.prefabInstanceCount = reports.length;
}

function buildPrefabInstanceGeometryReport(node, instanceOverride, geometryReport, instanceReport) {
  const expected = resolvePrefabInstanceExpectedGeometry(instanceOverride, geometryReport);
  const actual = {
    x: numericOr(node && node.x, 0),
    y: numericOr(node && node.y, 0),
    width: positiveOr(node && node.width, 0),
    height: positiveOr(node && node.height, 0)
  };
  const deltas = {
    x: Math.abs(actual.x - expected.x),
    y: Math.abs(actual.y - expected.y),
    width: Math.abs(actual.width - expected.width),
    height: Math.abs(actual.height - expected.height)
  };
  const tolerance = 0.5;
  const parentResolved = instanceReport ? instanceReport.parentResolved === true : true;
  const pass = parentResolved && deltas.x <= tolerance && deltas.y <= tolerance &&
    deltas.width <= tolerance && deltas.height <= tolerance;
  return {
    sourceGuid: instanceReport && instanceReport.sourceGuid || "",
    sourcePrefabAssetPath: instanceReport && instanceReport.sourcePrefabAssetPath || "",
    instanceNodeId: node && node.id || "",
    instanceNodeName: node && node.name || "",
    instanceNodeType: node && node.type || "",
    parentRectId: instanceReport && instanceReport.parentRectId || "",
    parentResolved,
    parentFallbackToTopLevel: instanceReport ? instanceReport.parentFallbackToTopLevel === true : false,
    parentNodeId: instanceReport && instanceReport.parentNodeId || "",
    parentNodeName: instanceReport && instanceReport.parentNodeName || "",
    parentNodeType: instanceReport && instanceReport.parentNodeType || "",
    mode: String((geometryReport || {}).mode || ""),
    pass,
    tolerance,
    expected,
    actual,
    deltas
  };
}

function resolvePrefabInstanceExpectedGeometry(instanceOverride, geometryReport) {
  const geometry = geometryReport || {};
  if (geometry.mode && typeof geometry.x !== "undefined" && typeof geometry.y !== "undefined") {
    return {
      x: numericOr(geometry.x, 0),
      y: numericOr(geometry.y, 0),
      width: positiveOr(geometry.width, 1),
      height: positiveOr(geometry.height, 1)
    };
  }
  const rect = (instanceOverride && instanceOverride.rect) || {};
  return {
    x: numericOr(rect.x, 0),
    y: numericOr(rect.y, 0),
    width: positiveOr(rect.width, 1),
    height: positiveOr(rect.height, 1)
  };
}

function normalizeNestedPrefabComponentMode(value) {
  const mode = String(value || "");
  if (mode === "commonOnly" || mode === "none") {
    return mode;
  }
  return "all";
}

function getPlannedPrefabInstances(context) {
  const operations = context.plan && context.plan.operations ? context.plan.operations : {};
  const writes = Array.isArray(operations.prefabInstanceWrites) ? operations.prefabInstanceWrites : null;
  if (writes) {
    return writes.map((item) => ({
      fileId: item.fileId || "",
      sourcePrefab: item.sourcePrefab || {
        guid: item.sourceGuid || "",
        assetPath: item.sourcePrefabAssetPath || "",
        assetExists: item.sourcePrefabAssetExists
      },
      hasModification: !!item.hasModification,
      instanceOverride: item.instanceOverride || {},
      strippedRectTransformIds: item.strippedRectTransformIds || [],
      renderMode: item.renderMode || "",
      missingNestedPrefab: item.missingNestedPrefab === true,
      missingReason: item.missingReason || "",
      requiredAction: item.requiredAction || ""
    }));
  }
  const prefabInstances = context.package.prefabInstances || [];
  if (!Array.isArray(prefabInstances)) {
    return [];
  }
  if (context.nestedPrefabComponentMode === "none") {
    return [];
  }
  if (context.nestedPrefabComponentMode !== "commonOnly") {
    return prefabInstances;
  }
  return prefabInstances.filter((item) => isCommonPrefabInstance(item));
}

function resolvePrefabInstanceRenderMode(item, context) {
  if ((item || {}).missingNestedPrefab === true || String((item || {}).renderMode || "") === "missing") {
    return "missing";
  }
  if (String((item || {}).renderMode || "") === "frame") {
    return "frame";
  }
  if (context.nestedPrefabComponentMode === "none") {
    return "frame";
  }
  if (context.nestedPrefabComponentMode === "commonOnly" && !isCommonPrefabInstance(item)) {
    return "frame";
  }
  return "component";
}

function isCommonPrefabInstance(item) {
  const sourcePrefab = item && item.sourcePrefab ? item.sourcePrefab : {};
  const instanceOverride = item && item.instanceOverride ? item.instanceOverride : {};
  const names = [
    sourcePrefab.name || "",
    prefabBaseName(sourcePrefab.assetPath || ""),
    instanceOverride.name || ""
  ];
  return names.some((name) => isHierarchySourceCommonPrefabName(name));
}

function isHierarchySourceCommonPrefabName(name) {
  const normalized = String(name || "").trim().replace(/^\[|\]$/g, "");
  return /^(Common_|Common-|CommonPrefab_|Common_Prefab_|KaTong|KaTone)/.test(normalized);
}

function prefabBaseName(assetPath) {
  const fileName = String(assetPath || "").split(/[\\/]/).pop() || "";
  return fileName.replace(/\.prefab$/i, "");
}

/** 查找或自动创建嵌套 Prefab 对应的 Figma Component。 */
async function resolvePrefabInstanceComponent(sourcePrefab, candidates, context, variantKey) {
  const guid = String(sourcePrefab.guid || "").toLowerCase();
  const cacheKey = variantKey || guid;
  if (cacheKey && context.prefabComponentByGuid.has(cacheKey)) {
    return context.prefabComponentByGuid.get(cacheKey);
  }
  const nestedPackage = findNestedPrefabPackage(context.package, guid, String(sourcePrefab.assetPath || ""), variantKey);
  const expectedSignature = buildNestedPrefabComponentSignature(nestedPackage);
  // 先在全文件（含资源库 page）搜索已有 Component，优先复用而不是自建。
  // 命中的资源库手工组件没有 auto 标记，prefabComponentMatchesSignature 会直接判匹配。
  const allComponents = figma.root.findAll((node) => node.type === "COMPONENT" || node.type === "COMPONENT_SET");
  let component = findPrefabComponentByCandidates(allComponents, candidates, guid, expectedSignature);
  if (component && shouldRecreateAutoNestedPrefabComponent(component, expectedSignature)) {
    // 仅当命中的是旧的自动组件且几何签名不符时才丢弃重建；手工/资源库组件不受影响。
    reportIgnoredAutoNestedPrefabComponent(component, sourcePrefab, context);
    component = null;
  }
  // 文件内没有可复用组件时，才用导出包内嵌的子 Prefab package 自动创建。
  if (!component && nestedPackage && nestedPackage.root) {
    component = await createNestedPrefabComponent(sourcePrefab, context, variantKey);
  }
  if (!component) {
    component = await createNestedPrefabComponent(sourcePrefab, context, variantKey);
  }
  if (cacheKey && component) {
    context.prefabComponentByGuid.set(cacheKey, component);
  }
  return component;
}

/** 当前实例有复杂 override 时，生成与导出端一致的实例专用 package key。 */
function buildPrefabInstanceVariantKey(item) {
  const sourceGuid = String(((item || {}).sourcePrefab || {}).guid || "").toLowerCase();
  const override = (item || {}).instanceOverride || {};
  if (!sourceGuid || override.hasComplexOverride !== true) {
    return "";
  }
  return `${sourceGuid}__override_${String((item || {}).fileId || "")}`;
}

/** 生成当前嵌套 Prefab 的组件几何签名，用于避免复用旧导入遗留组件。 */
function buildNestedPrefabComponentSignature(nestedPackage) {
  if (!nestedPackage || !nestedPackage.root) {
    return null;
  }
  const rootRect = ((nestedPackage.root || {}).rect) || {};
  const visualBounds = nestedPackage.visualBounds || {};
  const needsWrapper = prefabNeedsImportBoundsWrapper(nestedPackage, {});
  return {
    rootRect,
    visualBounds,
    needsWrapper,
    rootOffset: needsWrapper ? resolveImportBoundsRootOffset(rootRect, visualBounds) : { x: 0, y: 0 }
  };
}

function shouldRecreateAutoNestedPrefabComponent(component, expectedSignature) {
  if (!component || !expectedSignature) {
    return false;
  }
  const mode = component.getSharedPluginData(PrefabToFigmaNamespace, "componentMode");
  if (mode !== "auto-created-nested-component") {
    return false;
  }
  return !prefabComponentMatchesSignature(component, expectedSignature);
}

function reportIgnoredAutoNestedPrefabComponent(component, sourcePrefab, context) {
  context.nestedComponentReports.push({
    sourceGuid: String(sourcePrefab.guid || "").toLowerCase(),
    sourcePrefabAssetPath: sourcePrefab.assetPath || "",
    componentId: component.id,
    componentName: component.name,
    pass: true,
    reason: "ignored_stale_auto_component"
  });
}

/** 褰撴枃浠跺唴娌℃湁鐜版垚缁勪欢鏃讹紝浣跨敤瀵煎嚭鍖呭唴宓岀殑瀛?Prefab package 鑷姩鍒涘缓 Component銆?*/
async function createNestedPrefabComponent(sourcePrefab, context, variantKey) {
  const guid = String(sourcePrefab.guid || "").toLowerCase();
  const cycleKey = String(variantKey || guid || "");
  if (cycleKey && context.creatingNestedPrefabGuids && context.creatingNestedPrefabGuids.has(cycleKey)) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "nested_prefab_cycle_guard"
    });
    return null;
  }
  if (numericOr(context.nestedPrefabComponentDepth, 0) >= 3) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "nested_prefab_depth_limit"
    });
    return null;
  }
  const nestedPackage = findNestedPrefabPackage(context.package, guid, String(sourcePrefab.assetPath || ""), variantKey);
  if (!nestedPackage || !nestedPackage.root) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "missing_nested_package"
    });
    return null;
  }

  const originalPackage = context.package;
  const originalPlan = context.plan;
  const originalIsCreatingNestedPrefabComponent = context.isCreatingNestedPrefabComponent === true;
  const originalDepth = numericOr(context.nestedPrefabComponentDepth, 0);
  const previousIds = new Map(context.nodeByUnityId);
  context.package = nestedPackage;
  context.isCreatingNestedPrefabComponent = true;
  context.nestedPrefabComponentDepth = originalDepth + 1;
  if (cycleKey && context.creatingNestedPrefabGuids) {
    context.creatingNestedPrefabGuids.add(cycleKey);
  }
  context.plan = {
    root: {
      needsImportBoundsWrapper: prefabNeedsImportBoundsWrapper(nestedPackage, {})
    }
  };

  let frame = null;
  try {
    frame = await createNestedPrefabComponentFrame(context);
    if (!frame || frame.type !== "FRAME") {
      throw new Error(`nested prefab root is not FRAME: ${frame && frame.type}`);
    }
    placeAutoNestedPrefabFrame(frame, context);
    if (Array.isArray(nestedPackage.prefabInstances) && nestedPackage.prefabInstances.length > 0) {
      await promiseWithTimeout(appendPrefabInstanceNodes(frame, context), 30000, "nested appendPrefabInstanceNodes timeout");
    }
    const componentName = resolveNestedPrefabComponentName(sourcePrefab, nestedPackage, frame.name);
    const component = figma.createComponentFromNode(frame);
    component.name = variantKey ? `${componentName}__${String(variantKey).split("__override_").pop()}` : componentName;
    const nestedRootRect = ((nestedPackage.root || {}).rect) || {};
    const nestedVisualBounds = nestedPackage.visualBounds || {};
    const nestedNeedsWrapper = prefabNeedsImportBoundsWrapper(nestedPackage, {});
    const nestedRootOffset = nestedNeedsWrapper ? resolveImportBoundsRootOffset(nestedRootRect, nestedVisualBounds) : { x: 0, y: 0 };
    markPrefabMutatedNode(component, context);
    writePrefabPluginData(component, {
      nodeRole: "prefabComponent",
      componentMode: "auto-created-nested-component",
      prefabGuid: String(nestedPackage.prefabGuid || guid),
      prefabPath: String(nestedPackage.prefabPath || sourcePrefab.assetPath || ""),
      prefabVariantKey: String(variantKey || nestedPackage.prefabVariantKey || ""),
      nestedRootRect,
      nestedVisualBounds,
      nestedNeedsWrapper,
      nestedRootOffset
    });
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      componentId: component.id,
      componentName: component.name,
      pass: true,
      reason: "created_component_then_instance"
    });
    return component;
  } catch (error) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: error instanceof Error ? error.message : String(error)
    });
    if (frame && typeof frame.remove === "function") {
      frame.remove();
    }
    return null;
  } finally {
    context.package = originalPackage;
    context.plan = originalPlan;
    context.isCreatingNestedPrefabComponent = originalIsCreatingNestedPrefabComponent;
    context.nestedPrefabComponentDepth = originalDepth;
    if (cycleKey && context.creatingNestedPrefabGuids) {
      context.creatingNestedPrefabGuids.delete(cycleKey);
    }
    context.nodeByUnityId = previousIds;
  }
}

/** 自动创建嵌套 Prefab 组件时使用 Unity root 作为组件根，避免 ImportBounds 外框改变实例槽位对齐。 */
async function createNestedPrefabComponentFrame(context) {
  const rootSource = context && context.package ? (context.package.root || {}) : {};
  const frame = await createPrefabUnityFrame(rootSource, context);
  frame.clipsContent = false;
  const parent = context && context.importPage ? context.importPage : figma.currentPage;
  parent.appendChild(frame);
  return frame;
}

async function createNestedPrefabFrameInstance(sourcePrefab, parent, instanceOverride, context, variantKey) {
  const guid = String(sourcePrefab.guid || "").toLowerCase();
  const nestedPackage = findNestedPrefabPackage(context.package, guid, String(sourcePrefab.assetPath || ""), variantKey);
  if (!nestedPackage || !nestedPackage.root) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "missing_nested_package_for_frame"
    });
    return null;
  }

  const originalPackage = context.package;
  const originalPlan = context.plan;
  const originalIsCreatingNestedPrefabComponent = context.isCreatingNestedPrefabComponent === true;
  const originalDepth = numericOr(context.nestedPrefabComponentDepth, 0);
  const previousIds = new Map(context.nodeByUnityId);
  context.package = nestedPackage;
  context.isCreatingNestedPrefabComponent = false;
  context.nestedPrefabComponentDepth = originalDepth + 1;
  context.plan = {
    root: {
      needsImportBoundsWrapper: prefabNeedsImportBoundsWrapper(nestedPackage, {})
    }
  };

  let frame = null;
  try {
    frame = await createNestedPrefabComponentFrame(context);
    if (!frame || frame.type !== "FRAME") {
      throw new Error(`nested prefab frame is not FRAME: ${frame && frame.type}`);
    }
    parent.appendChild(frame);
    frame.name = String(instanceOverride.name || resolveNestedPrefabComponentName(sourcePrefab, nestedPackage, frame.name));
    if (Array.isArray(nestedPackage.prefabInstances) && nestedPackage.prefabInstances.length > 0) {
      await promiseWithTimeout(appendPrefabInstanceNodes(frame, context), 30000, "nested frame appendPrefabInstanceNodes timeout");
    }
    writePrefabPluginData(frame, {
      nodeRole: "prefabInstanceFrame",
      sourcePrefabGuid: String(nestedPackage.prefabGuid || guid),
      sourcePrefabPath: String(nestedPackage.prefabPath || sourcePrefab.assetPath || ""),
      sourcePrefabFileId: sourcePrefab.fileID || "",
      parentRectId: String(instanceOverride.parentRectId || ""),
      sourceRectFileId: String(instanceOverride.sourceRectFileId || ""),
      renderMode: "frame"
    });
    markPrefabCreatedNode(frame, context);
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      nodeId: frame.id,
      nodeName: frame.name,
      pass: true,
      reason: "created_nested_prefab_frame"
    });
    return frame;
  } catch (error) {
    if (frame && typeof frame.remove === "function") {
      frame.remove();
    }
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "create_nested_prefab_frame_failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  } finally {
    context.package = originalPackage;
    context.plan = originalPlan;
    context.isCreatingNestedPrefabComponent = originalIsCreatingNestedPrefabComponent;
    context.nestedPrefabComponentDepth = originalDepth;
    context.nodeByUnityId = previousIds;
  }
}

function createMissingNestedPrefabPlaceholder(sourcePrefab, parent, instanceOverride, context, item) {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  frame.name = String(instanceOverride.name || (sourcePrefab && sourcePrefab.name) || "MissingNestedPrefab");
  frame.clipsContent = true;
  frame.fills = [{
    type: "SOLID",
    color: { r: 0.62, g: 0.1, b: 0.1 },
    opacity: 0.18
  }];
  frame.strokes = [{
    type: "SOLID",
    color: { r: 0.86, g: 0.17, b: 0.17 },
    opacity: 0.9
  }];
  frame.strokeWeight = 1;
  frame.dashPattern = [6, 4];
  writePrefabPluginData(frame, {
    nodeRole: "missingNestedPrefabPlaceholder",
    sourcePrefabGuid: sourcePrefab && sourcePrefab.guid || "",
    sourcePrefabPath: sourcePrefab && sourcePrefab.assetPath || "",
    sourcePrefabFileId: sourcePrefab && sourcePrefab.fileID || "",
    missingReason: String((item || {}).missingReason || "source_prefab_asset_not_found"),
    requiredAction: String((item || {}).requiredAction || "create_missing_nested_prefab_placeholder"),
    parentRectId: String(instanceOverride.parentRectId || ""),
    sourceRectFileId: String(instanceOverride.sourceRectFileId || ""),
    renderMode: "missing"
  });
  markPrefabCreatedNode(frame, context);
  return frame;
}

/** 自动创建的子 Prefab 组件放到页面空位，避免和正式导入根节点在 (0,0) 重叠污染截图。 */
function placeAutoNestedPrefabFrame(frame, context) {
  if (!frame || !context || !context.importPage) {
    return;
  }
  const width = positiveOr(frame.width, 1);
  const height = positiveOr(frame.height, 1);
  const placement = resolveAutoNestedPrefabPlacement(context.importPage, context, width, height);
  frame.x = placement.x;
  frame.y = placement.y;
}

/** 为自动创建的子组件按批次横向排布，优先放在主导入节点右侧。 */
function resolveAutoNestedPrefabPlacement(page, context, width, height) {
  const margin = 80;
  const topLevel = context.currentTopLevelNode;
  const startX = topLevel && "x" in topLevel && "width" in topLevel
    ? numericOr(topLevel.x, 0) + positiveOr(topLevel.width, 0) + margin
    : 0;
  const startY = topLevel && "y" in topLevel ? numericOr(topLevel.y, 0) : 0;
  const index = positiveOr(context.autoNestedComponentPlacementCount, 0);
  context.autoNestedComponentPlacementCount = index + 1;

  const columns = 3;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = startX + column * (positiveOr(width, 1) + margin);
  const y = startY + row * (positiveOr(height, 1) + margin);
  if (!prefabPagePositionOverlaps(page.children || [], x, y, width, height)) {
    return { x, y };
  }
  return resolvePrefabPageFreePosition(page, width, height, x, y);
}

/** Prefab 写入任务较大时 UI 回包可能丢失，主线程先直接回传结果作为兜底。 */
async function postPrefabWriteResultDirectly(message, result) {
  const job = message && message.job ? message.job : {};
  const relayUrl = String(job.relayUrl || job.bridgeUrl || "").replace(/\/+$/, "");
  const requestId = String(message && message.requestId || "");
  if (!relayUrl || !requestId) {
    return;
  }
  try {
    await promiseWithTimeout(fetch(`${relayUrl}/figma/result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Figma-Relay-Internal": "plugin-runtime"
      },
      body: JSON.stringify({ requestId, result })
    }), 5000, "Prefab result direct post timeout");
  } catch (error) {
    pluginLogger.warn("Prefab 结果直接回传失败", { error: error && error.message ? error.message : String(error) });
  }
}

/** 浠庝富鍖呴€掑綊鏌ユ壘鎸囧畾 GUID 鎴栬矾寰勭殑宓屽 Prefab package銆?*/
function findNestedPrefabPackage(prefabPackage, guid, assetPath, variantKey) {
  const nested = prefabPackage && prefabPackage.nestedPrefabPackages;
  const normalizedGuid = String(guid || "").toLowerCase();
  const normalizedPath = normalizePrefabPath(assetPath);
  const normalizedVariantKey = String(variantKey || "").toLowerCase();
  if (!nested) {
    return null;
  }
  if (normalizedVariantKey && !Array.isArray(nested) && nested[normalizedVariantKey]) {
    return nested[normalizedVariantKey];
  }
  const values = Array.isArray(nested) ? nested : Object.values(nested);
  for (const item of values) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemVariantKey = String(item.prefabVariantKey || "").toLowerCase();
    if (normalizedVariantKey && itemVariantKey === normalizedVariantKey) {
      return item;
    }
  }
  for (const item of values) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemGuid = String(item.prefabGuid || "").toLowerCase();
    const itemPath = normalizePrefabPath(item.prefabPath || "");
    if (!normalizedVariantKey && ((normalizedGuid && itemGuid === normalizedGuid) || (normalizedPath && itemPath === normalizedPath))) {
      return item;
    }
    const found = findNestedPrefabPackage(item, normalizedGuid, normalizedPath, normalizedVariantKey);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizePrefabPath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

/** 瑙ｆ瀽鑷姩鍒涘缓鐨勫祵濂?Prefab 缁勪欢鍚嶏紝閬垮厤鎶?__ImportBounds 鍖呭洿灞傛毚闇茬粰鐢ㄦ埛銆?*/
function resolveNestedPrefabComponentName(sourcePrefab, nestedPackage, fallbackName) {
  const rootName = String(((nestedPackage || {}).root || {}).name || "").trim();
  if (rootName) {
    return rootName;
  }
  const sourceName = String((sourcePrefab || {}).name || "").trim();
  if (sourceName && !sourceName.endsWith("__ImportBounds")) {
    return sourceName;
  }
  const assetPath = String((sourcePrefab || {}).assetPath || "").trim();
  const fileName = assetPath.split(/[\\/]/).pop() || "";
  const baseName = fileName.replace(/\.prefab$/i, "").trim();
  if (baseName) {
    return baseName;
  }
  return String(fallbackName || "NestedPrefab").replace(/__ImportBounds$/i, "");
}

/** 鎸?PrefabInstance RectTransform override 璁剧疆 Instance 鐨勪綅缃拰灏哄銆?*/
function applyPrefabInstanceGeometry(instance, parent, instanceOverride, component, sourcePrefab, context, variantKey) {
  const explicitRect = instanceOverride.rect || {};
  let rect = explicitRect.width || explicitRect.height ? explicitRect : null;
  if (!rect && instanceOverride.rectTransform) {
    rect = resolvePrefabInstanceRect(instanceOverride.rectTransform, positiveOr(parent.width, 1), positiveOr(parent.height, 1));
  }
  if (!rect) {
    return { mode: "missing_rect" };
  }
  applyPrefabInstanceConstraints(instance, instanceOverride);
  const nestedRect = prefabInstanceHasExplicitRect(instanceOverride)
    ? null
    : resolveNestedPrefabInstanceRect(rect, component, instanceOverride, sourcePrefab, context, variantKey);
  if (nestedRect) {
    instance.x = numericOr(nestedRect.x, 0);
    instance.y = numericOr(nestedRect.y, 0);
    if ("resize" in instance) {
      instance.resize(positiveOr(nestedRect.width, instance.width || 1), positiveOr(nestedRect.height, instance.height || 1));
    }
    return nestedRect.report;
  }
  // 鍒ゆ柇鏄惁涓?stretch-to-fill锛堝瓙鑺傜偣濉弧鐖惰妭鐐癸級锛歳ect 灏哄绛変簬鐖惰妭鐐瑰昂瀵?  // 鑻ョ粍浠堕粯璁ゅ昂瀵歌繙灏忎簬鐖惰妭鐐癸紙濡傚簳閮ㄦ爮锛夛紝涓?resize锛屽彧瀹氫綅鍒扮埗鑺傜偣搴曢儴
  // 判断是否为 stretch-to-fill（子节点填满父节点）
  // 使用相对容差：max(0.5px, 父节点尺寸 * 0.001)
  const relTolerance = 0.001; // 0.1% of parent dimension
  const absTolerance = 0.5;   // absolute minimum for small parents
  const tolX = Math.max(absTolerance, (parent.width || 0) * relTolerance);
  const tolY = Math.max(absTolerance, (parent.height || 0) * relTolerance);
  const isStretchFill = (
    Math.abs(numericOr(rect.x, 0)) < tolX &&
    Math.abs(numericOr(rect.y, 0)) < tolY &&
    Math.abs(rect.width - (parent.width || 0)) < tolX &&
    Math.abs(rect.height - (parent.height || 0)) < tolY
  );
  if (isStretchFill) {
    var instanceW = positiveOr(instance.width, 1);
    var instanceH = positiveOr(instance.height, 1);
    // 缁勪欢榛樿灏哄杩滃皬浜庣埗鑺傜偣 鈫?瑙嗚鍐呭鍥哄畾锛屼笉 resize 楂樺害锛岃创搴曞榻愶紝瀹藉害濉弧鐖惰妭鐐?
    if (instanceH > 0 && instanceH < parent.height * 0.5) {
      instance.x = 0;
      instance.y = Math.max(0, parent.height - instanceH);
      if (instanceW !== parent.width) {
        instance.resize(parent.width, instanceH);
      }
      return { mode: "stretch_fill_keep_visual_height", x: instance.x, y: instance.y, width: instance.width, height: instance.height };
    }
    instance.x = 0;
    instance.y = 0;
    instance.resize(parent.width, parent.height);
    return { mode: "stretch_fill", x: instance.x, y: instance.y, width: instance.width, height: instance.height };
  }
  instance.x = numericOr(rect.x, 0);
  instance.y = numericOr(rect.y, 0);
  if ("resize" in instance) {
    instance.resize(positiveOr(rect.width, instance.width || 1), positiveOr(rect.height, instance.height || 1));
  }
  return { mode: "rect", x: instance.x, y: instance.y, width: instance.width, height: instance.height };
}

function prefabInstanceHasExplicitRect(instanceOverride) {
  const rect = instanceOverride && instanceOverride.rect ? instanceOverride.rect : {};
  return !!(rect.width || rect.height);
}

function applyPrefabInstanceConstraints(instance, instanceOverride) {
  if (!("constraints" in instance)) {
    return;
  }
  const constraints = instanceOverride && instanceOverride.constraints
    ? instanceOverride.constraints
    : rectTransformConstraintsToFigma(instanceOverride && instanceOverride.rectTransform);
  if (!constraints) {
    return;
  }
  instance.constraints = {
    horizontal: normalizePrefabHierarchyConstraint(constraints.horizontal, "CENTER"),
    vertical: normalizePrefabHierarchyConstraint(constraints.vertical, "CENTER")
  };
}

function rectTransformConstraintsToFigma(rectTransform) {
  if (!rectTransform) {
    return null;
  }
  const anchorMin = readPrefabVec2(rectTransform.m_AnchorMin, 0.5, 0.5);
  const anchorMax = readPrefabVec2(rectTransform.m_AnchorMax, anchorMin.x, anchorMin.y);
  return {
    horizontal: unityAnchorAxisToFigmaConstraint(anchorMin.x, anchorMax.x, false),
    vertical: unityAnchorAxisToFigmaConstraint(anchorMin.y, anchorMax.y, true)
  };
}

function unityAnchorAxisToFigmaConstraint(minValue, maxValue, isVertical) {
  if (prefabNumberApproximatelyEqual(minValue, 0) && prefabNumberApproximatelyEqual(maxValue, 1)) {
    return "STRETCH";
  }
  const center = (numericOr(minValue, 0.5) + numericOr(maxValue, 0.5)) * 0.5;
  if (isVertical) {
    if (prefabNumberApproximatelyEqual(center, 1)) return "MIN";
    if (prefabNumberApproximatelyEqual(center, 0)) return "MAX";
  } else {
    if (prefabNumberApproximatelyEqual(center, 0)) return "MIN";
    if (prefabNumberApproximatelyEqual(center, 1)) return "MAX";
  }
  return "CENTER";
}

function normalizePrefabHierarchyConstraint(value, fallback) {
  const normalized = String(value || fallback || "CENTER").toUpperCase();
  return ["MIN", "CENTER", "MAX", "STRETCH"].indexOf(normalized) >= 0 ? normalized : fallback;
}

/** 鑷姩鍒涘缓鐨勫瓙 Prefab 缁勪欢鑻ユ湁 ImportBounds wrapper锛岄渶瑕佺敤 wrapper 鍙嶅悜瀵归綈 Unity 鏍?Rect銆?*/
function resolveNestedPrefabInstanceRect(rect, component, instanceOverride, sourcePrefab, context, variantKey) {
  const bounds = resolveNestedPrefabBounds(component, sourcePrefab, context, variantKey);
  if (!bounds || !bounds.needsWrapper || !bounds.componentUsesWrapper) {
    return null;
  }
  const rootRect = bounds.rootRect;
  const visualBounds = bounds.visualBounds;
  const rootOffset = resolveNestedPrefabPlacementOffset(bounds, rect, instanceOverride);
  const rootWidth = positiveOr(rootRect.width, positiveOr(rect.width, component.width || 1));
  const rootHeight = positiveOr(rootRect.height, positiveOr(rect.height, component.height || 1));
  const scaleX = positiveOr(rect.width, rootWidth) / rootWidth;
  const scaleY = positiveOr(rect.height, rootHeight) / rootHeight;
  const visualX = numericOr(visualBounds.x, 0);
  const visualY = numericOr(visualBounds.y, 0);
  const visualWidth = positiveOr(visualBounds.width, positiveOr(rootWidth, component.width || 1));
  const visualHeight = positiveOr(visualBounds.height, positiveOr(rootHeight, component.height || 1));
  const x = numericOr(rect.x, 0) + visualX * scaleX;
  const y = numericOr(rect.y, 0) + visualY * scaleY;
  const width = visualWidth * scaleX;
  const height = visualHeight * scaleY;
  return {
    x,
    y,
    width,
    height,
    report: {
      mode: rootOffset.mode || "import_bounds_root_aligned",
      source: bounds.source,
      layoutResolvedType: String(((instanceOverride || {}).layoutResolved || {}).type || ""),
      slotRect: rect,
      rootRect,
      visualBounds,
      rootOffset,
      rawRootOffset: bounds.rootOffset,
      rootScale: { x: scaleX, y: scaleY },
      x,
      y,
      width,
      height
    }
  };
}

// 布局系统已经把子 Prefab 放入槽位时，按可视包围盒溢出量对齐，避免 wrapper 左边界替代 Unity 槽位。
function resolveNestedPrefabPlacementOffset(bounds, rect, instanceOverride) {
  const layoutType = String((((instanceOverride || {}).layoutResolved || {}).type) || "");
  if (layoutType === "HorizontalLayoutGroup" || layoutType === "VerticalLayoutGroup" || layoutType === "GridLayoutGroup") {
    const rootOffset = bounds.rootOffset || { x: 0, y: 0 };
    return {
      x: numericOr(rootOffset.x, 0),
      y: numericOr(rootOffset.y, 0),
      mode: "import_bounds_layout_root_aligned"
    };
  }
  const rootOffset = bounds.rootOffset || { x: 0, y: 0 };
  return {
    x: numericOr(rootOffset.x, 0),
    y: numericOr(rootOffset.y, 0),
    mode: "import_bounds_root_aligned"
  };
}

function resolveNestedPrefabBounds(component, sourcePrefab, context, variantKey) {
  const guid = String((sourcePrefab || {}).guid || "").toLowerCase();
  const assetPath = String((sourcePrefab || {}).assetPath || "");
  const nestedPackage = findNestedPrefabPackage(context && context.package, guid, assetPath, variantKey);
  if (nestedPackage && nestedPackage.root) {
    const rootRect = ((nestedPackage.root || {}).rect) || {};
    const visualBounds = nestedPackage.visualBounds || {};
    const needsWrapper = prefabNeedsImportBoundsWrapper(nestedPackage, {});
    return buildNestedPrefabBounds(component, rootRect, visualBounds, needsWrapper, "nested_package");
  }
  if (component && typeof component.getSharedPluginData === "function") {
    const rootRect = readPrefabSharedJson(component, "nestedRootRect");
    const visualBounds = readPrefabSharedJson(component, "nestedVisualBounds");
    const needsWrapper = readPrefabSharedBool(component, "nestedNeedsWrapper");
    if (Object.keys(rootRect).length > 0 && Object.keys(visualBounds).length > 0) {
      return buildNestedPrefabBounds(component, rootRect, visualBounds, needsWrapper, "component_plugin_data");
    }
  }
  return null;
}

function buildNestedPrefabBounds(component, rootRect, visualBounds, needsWrapper, source) {
  const rootOffset = needsWrapper ? resolveImportBoundsRootOffset(rootRect, visualBounds) : { x: 0, y: 0 };
  const componentUsesWrapper = componentLooksLikeImportBoundsWrapper(component, rootRect, visualBounds);
  return {
    rootRect,
    visualBounds,
    rootOffset,
    needsWrapper,
    componentUsesWrapper,
    source
  };
}

function componentLooksLikeImportBoundsWrapper(component, rootRect, visualBounds) {
  if (!component) {
    return false;
  }
  const name = String(component.name || "");
  if (name.endsWith("__ImportBounds")) {
    return true;
  }
  const visualWidth = positiveOr(visualBounds.width, 0);
  const visualHeight = positiveOr(visualBounds.height, 0);
  const rootWidth = positiveOr(rootRect.width, 0);
  const rootHeight = positiveOr(rootRect.height, 0);
  const componentWidth = positiveOr(component.width, 0);
  const componentHeight = positiveOr(component.height, 0);
  if (visualWidth > 0 && visualHeight > 0 &&
    Math.abs(componentWidth - visualWidth) < 0.5 &&
    Math.abs(componentHeight - visualHeight) < 0.5) {
    return true;
  }
  return rootWidth > 0 && rootHeight > 0 &&
    (Math.abs(componentWidth - rootWidth) >= 0.5 || Math.abs(componentHeight - rootHeight) >= 0.5);
}
/** 璇诲彇 SharedPluginData 涓殑 JSON 鍏冩暟鎹€?*/
function readPrefabSharedJson(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return {};
  }
  const raw = node.getSharedPluginData(PrefabToFigmaNamespace, key);
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    return {};
  }
}

/** 璇诲彇 SharedPluginData 涓殑甯冨皵鍏冩暟鎹€?*/
function readPrefabSharedBool(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return false;
  }
  const raw = node.getSharedPluginData(PrefabToFigmaNamespace, key);
  return raw === "true" || raw === "1";
}

/** 澶嶅埢 Unity RectTransform 鍒?Figma 宸︿笂鍧愭爣鐨勮浆鎹紝鐢ㄤ簬宓屽 PrefabInstance銆?*/
function resolvePrefabInstanceRect(fields, parentWidth, parentHeight) {
  const anchorMin = readPrefabVec2(fields.m_AnchorMin, 0.5, 0.5);
  const anchorMax = readPrefabVec2(fields.m_AnchorMax, anchorMin.x, anchorMin.y);
  const sizeDelta = readPrefabVec2(fields.m_SizeDelta, 0, 0);
  const pivot = readPrefabVec2(fields.m_Pivot, 0.5, 0.5);
  const anchoredPosition = readPrefabVec2(fields.m_AnchoredPosition, 0, 0);
  const localScale = readPrefabVec2(fields.m_LocalScale, 1, 1);
  const spanWidth = (anchorMax.x - anchorMin.x) * parentWidth;
  const spanHeight = (anchorMax.y - anchorMin.y) * parentHeight;
  const baseWidth = spanWidth + sizeDelta.x;
  const baseHeight = spanHeight + sizeDelta.y;
  const pivotX = anchorMin.x * parentWidth + spanWidth * pivot.x + anchoredPosition.x;
  const pivotY = anchorMin.y * parentHeight + spanHeight * pivot.y + anchoredPosition.y;
  const left = pivotX - pivot.x * baseWidth * localScale.x;
  const right = pivotX + (1 - pivot.x) * baseWidth * localScale.x;
  const bottom = pivotY - pivot.y * baseHeight * localScale.y;
  const top = pivotY + (1 - pivot.y) * baseHeight * localScale.y;
  return {
    x: Math.min(left, right),
    y: parentHeight - Math.max(bottom, top),
    width: Math.abs(right - left),
    height: Math.abs(top - bottom)
  };
}

/** 璇诲彇 PrefabInstance override 涓殑浜岀淮鍚戦噺銆?*/
function readPrefabVec2(value, fallbackX, fallbackY) {
  const source = value && typeof value === "object" ? value : {};
  return {
    x: numericOr(source.x, fallbackX),
    y: numericOr(source.y, fallbackY)
  };
}

function buildPrefabInstanceCandidateNames(sourcePrefab) {
  const names = [];
  const assetPath = String(sourcePrefab.assetPath || "");
  const fileName = assetPath.split(/[\\/]/).pop() || "";
  const baseName = fileName.replace(/\.prefab$/i, "");
  for (const name of [sourcePrefab.name, baseName, `${baseName}__ImportBounds`]) {
    if (name && names.indexOf(name) < 0) {
      names.push(String(name));
    }
  }
  return names;
}

/** 鍦ㄥ叏鏂囦欢鑼冨洿鍐呮寜鍊欓€夊悕鎴栧叡浜厓鏁版嵁 GUID 鏌ユ壘 Component銆?*/
function findPrefabComponentByCandidates(components, candidates, sourceGuid, expectedSignature) {
  const guid = String(sourceGuid || "").toLowerCase();
  const guidMatches = [];
  for (const component of components) {
    const storedGuid = component.getSharedPluginData(PrefabToFigmaNamespace, "prefabGuid") ||
      component.getSharedPluginData(PrefabToFigmaNamespace, "spriteGuid");
    if (guid && String(storedGuid || "").toLowerCase() === guid) {
      guidMatches.push(component);
    }
  }
  const guidMatch = selectPrefabComponentMatch(guidMatches, expectedSignature);
  if (guidMatch) {
    return guidMatch;
  }
  const nameMatches = [];
  for (const component of components) {
    if (candidates.indexOf(component.name) >= 0) {
      nameMatches.push(component);
    }
  }
  return selectPrefabComponentMatch(nameMatches, expectedSignature);
}

/** 按当前几何签名选择组件；旧的自动组件签名不一致时跳过并强制重建。 */
function selectPrefabComponentMatch(matches, expectedSignature) {
  if (!matches || matches.length === 0) {
    return null;
  }
  if (!expectedSignature) {
    return matches[0];
  }
  for (const component of matches) {
    if (prefabComponentMatchesSignature(component, expectedSignature)) {
      return component;
    }
  }
  const nonAuto = matches.find((component) =>
    component.getSharedPluginData(PrefabToFigmaNamespace, "componentMode") !== "auto-created-nested-component"
  );
  return nonAuto || null;
}

/** 比较自动组件的 rootRect、visualBounds 和 rootOffset，防止复用旧公式生成的组件。 */
function prefabComponentMatchesSignature(component, expectedSignature) {
  if (!component || !expectedSignature) {
    return false;
  }
  const mode = component.getSharedPluginData(PrefabToFigmaNamespace, "componentMode");
  if (mode !== "auto-created-nested-component") {
    return true;
  }
  const actualRootRect = readPrefabSharedJson(component, "nestedRootRect");
  const actualVisualBounds = readPrefabSharedJson(component, "nestedVisualBounds");
  const actualRootOffset = readPrefabSharedJson(component, "nestedRootOffset");
  const actualNeedsWrapper = readPrefabSharedBool(component, "nestedNeedsWrapper");
  return actualNeedsWrapper === !!expectedSignature.needsWrapper &&
    prefabRectApproximatelyEqual(actualRootRect, expectedSignature.rootRect) &&
    prefabRectApproximatelyEqual(actualVisualBounds, expectedSignature.visualBounds) &&
    prefabPointApproximatelyEqual(actualRootOffset, expectedSignature.rootOffset);
}

function prefabRectApproximatelyEqual(a, b) {
  return prefabNumberApproximatelyEqual(a && a.x, b && b.x) &&
    prefabNumberApproximatelyEqual(a && a.y, b && b.y) &&
    prefabNumberApproximatelyEqual(a && a.width, b && b.width) &&
    prefabNumberApproximatelyEqual(a && a.height, b && b.height);
}

function prefabPointApproximatelyEqual(a, b) {
  return prefabNumberApproximatelyEqual(a && a.x, b && b.x) &&
    prefabNumberApproximatelyEqual(a && a.y, b && b.y);
}

function prefabTransformApproximatelyEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) {
    return false;
  }
  for (let row = 0; row < 2; row++) {
    if (!Array.isArray(a[row]) || !Array.isArray(b[row]) || a[row].length !== 3 || b[row].length !== 3) {
      return false;
    }
    for (let col = 0; col < 3; col++) {
      if (!prefabNumberApproximatelyEqual(a[row][col], b[row][col])) {
        return false;
      }
    }
  }
  return true;
}

function prefabNumberApproximatelyEqual(a, b) {
  return Math.abs(numericOr(a, 0) - numericOr(b, 0)) < 0.01;
}

/** 鍒涘缓缁熶竴瀹℃牳 check 瀵硅薄銆?*/
function makePrefabCheck(pass, summary, details) {
  return {
    pass: !!pass,
    summary: summary || {},
    details: Array.isArray(details) ? details : []
  };
}

/** 鏍规嵁闃诲閿欒鍜岀‖闂ㄧ缁撴灉鍐冲畾鏈€缁堢姸鎬併€?*/
function buildPrefabWriteStatus(context) {
  if (context.blockingErrors.length > 0) {
    return "completed_with_errors";
  }
  return "completed";
}

/** 瀵煎嚭鎸囧畾 Figma 鑺傜偣锛屼緵 Unity Prefab 鐢熸垚娴佺▼绂荤嚎娑堣垂銆?*/
async function exportFigmaToPrefabJob(job) {
  const target = job && job.target ? job.target : {};
  const nodeId = target && target.nodeId ? String(target.nodeId) : "";
  if (!nodeId) {
    throw new Error("FIGMA_TO_PREFAB_EXPORT missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  await setCurrentPageForNode(root);

  const warnings = [];
  const rootBounds = getNodeBounds(root);
  const nodeRecords = [];
  const imageRequests = [];
  await collectFigmaPrefabNodes(root, root, rootBounds, nodeRecords, imageRequests, warnings);

  const imageExportManifest = await exportFigmaPrefabImages(imageRequests, warnings);
  const imageHealthErrors = validateImageExports(imageExportManifest.exports || []);
  applyImageValidationErrors(imageExportManifest.exports || [], imageHealthErrors);
  imageExportManifest.healthSummary = summarizeImageHealth(imageExportManifest.exports || []);
  const blockingErrors = [
    ...imageHealthErrors,
    ...validateFigmaPrefabSlicedExports(imageExportManifest.exports || [])
  ];
  const requestExport = job && job.request && job.request.export ? job.request.export : {};
  const manifestExport = job && job.manifest && job.manifest.export ? job.manifest.export : {};
  const includeScreenshot = requestExport.includeScreenshot !== false
    && manifestExport.includeScreenshot !== false
    && job.includeScreenshot !== false
    && job.exportScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const figmaNodeManifest = {
    schemaVersion: 1,
    source: "figma-relay",
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootNodeId: root.id,
    rootName: root.name,
    rootBounds: boundsToManifest(rootBounds),
    nodes: nodeRecords
  };

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name,
    createdCount: nodeRecords.length,
    figmaNodeManifest,
    imageExportManifest,
    screenshot,
    warnings,
    blockingErrors,
    errors: []
  };
}

/** 递归收集 Figma 节点树，并转换为相对父节点的数据记录。 */
async function collectFigmaPrefabNodes(node, root, rootBounds, output, imageRequests, warnings, parentId, parentBounds) {
  if (!node || node.removed || node.visible === false || isCleanupRecoveryNode(node)) {
    return;
  }

  const bounds = getNodeBounds(node);
  // 使用 parentBounds 计算相对坐标（而非 rootBounds），确保 Unity 导入时 Y 轴正确
  const refBounds = parentBounds || rootBounds;
  const record = {
    id: node.id,
    parentId: parentId || "",
    name: node.name || "",
    type: node.type,
    path: buildNodePath(node, root),
    visible: node.visible !== false,
    opacity: typeof node.opacity === "number" ? node.opacity : 1,
    bounds: boundsToManifest(bounds),
    relativeBounds: boundsToRelativeManifest(bounds, refBounds),
    fills: serializePaints(node.fills),
    strokes: serializePaints(node.strokes),
    effects: node.type === "TEXT" ? serializeEffects(node.effects) : [],
    constraints: readFigmaPrefabConstraints(node),
    strokeWeight: node.type === "TEXT" ? readFigmaStrokeWeight(node) : 0,
    cornerRadius: typeof node.cornerRadius === "number" ? node.cornerRadius : 0,
    characters: node.type === "TEXT" ? String(node.characters || "") : "",
    fontSize: readFigmaFontSize(node),
    textAlignHorizontal: node.type === "TEXT" ? String(node.textAlignHorizontal || "") : "",
    textAlignVertical: node.type === "TEXT" ? String(node.textAlignVertical || "") : "",
    childIds: []
  };
  const componentInfo = await buildFigmaPrefabComponentInfo(node, warnings);
  if (componentInfo && componentInfo.source) {
    record.component = componentInfo;
  }
  output.push(record);

  const nineSliceInfo = buildFigmaPrefabNineSliceInfo(node);
  if (nineSliceInfo) {
    record.imageType = "Sliced";
    record.border = nineSliceInfo.border;
    record.nineSlice = {
      border: nineSliceInfo.border,
      sliceKind: nineSliceInfo.sliceKind,
      sliceCount: nineSliceInfo.sliceCount,
      minSize: nineSliceInfo.minSize,
      sourceVisibleSize: nineSliceInfo.sourceVisibleSize
    };
  }

  const imageHash = findFirstImageHash(node, !!nineSliceInfo);
  if (imageHash) {
    const request = {
      id: `img_${imageRequests.length}`,
      nodeId: node.id,
      nodePath: record.path,
      source: "imageHash",
      imageHash
    };
    if (nineSliceInfo) {
      Object.assign(request, {
        imageType: "Sliced",
        sliceKind: nineSliceInfo.sliceKind,
        border: nineSliceInfo.border,
        expectedMinSize: nineSliceInfo.minSize,
        sourceVisibleSize: nineSliceInfo.sourceVisibleSize,
        sliceCount: nineSliceInfo.sliceCount
      });
    }
    imageRequests.push(request);
  } else if (nineSliceInfo) {
    const childHash = findNineSliceSourceHash(node);
    if (childHash) {
      warnings.push(`Nine-slice source fallback to slice child: ${record.path || node.id}`);
      imageRequests.push({
        id: `img_${imageRequests.length}`,
        nodeId: node.id,
        nodePath: record.path,
        source: "imageHash",
        imageHash: childHash,
        sourceReason: "sliceFillFallback",
        imageType: "Sliced",
        sliceKind: nineSliceInfo.sliceKind,
        border: nineSliceInfo.border,
        expectedMinSize: nineSliceInfo.minSize,
        sourceVisibleSize: nineSliceInfo.sourceVisibleSize,
        sliceCount: nineSliceInfo.sliceCount
      });
    }
  } else if (shouldExportNodeAsImage(node)) {
    imageRequests.push({
      id: `img_${imageRequests.length}`,
      nodeId: node.id,
      nodePath: record.path,
      source: "nodeExport"
    });
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && child.visible !== false && !isCleanupRecoveryNode(child)) {
        record.childIds.push(child.id);
        // 传递当前节点 bounds 作为子节点的 parentBounds
        await collectFigmaPrefabNodes(child, root, rootBounds, output, imageRequests, warnings, node.id, bounds);
      }
    }
  }
}

/** 读取 Figma 原生组件身份，供 Unity 导入时判断本地 ComponentSet。 */
async function buildFigmaPrefabComponentInfo(node, warnings) {
  const info = {
    isComponentSet: node && node.type === "COMPONENT_SET",
    isComponent: node && node.type === "COMPONENT",
    isInstance: node && node.type === "INSTANCE",
    componentSetId: "",
    componentSetName: "",
    componentId: "",
    componentName: "",
    variantProperties: {},
    mainComponentId: "",
    mainComponentName: "",
    mainComponentSetId: "",
    mainComponentSetName: "",
    source: ""
  };

  if (!node) {
    return info;
  }

  if (node.type === "COMPONENT_SET") {
    info.componentSetId = node.id;
    info.componentSetName = node.name || "";
    info.source = "component_set";
    return info;
  }

  if (node.type === "COMPONENT") {
    info.componentId = node.id;
    info.componentName = node.name || "";
    info.variantProperties = clonePlainObject(node.variantProperties);
    if (node.parent && node.parent.type === "COMPONENT_SET") {
      info.componentSetId = node.parent.id;
      info.componentSetName = node.parent.name || "";
    }
    info.source = "component";
    return info;
  }

  if (node.type !== "INSTANCE") {
    return info;
  }

  info.source = "instance";
  try {
    const mainComponent = typeof node.getMainComponentAsync === "function"
      ? await node.getMainComponentAsync()
      : (node.mainComponent || null);
    if (!mainComponent) {
      return info;
    }
    info.mainComponentId = mainComponent.id || "";
    info.mainComponentName = mainComponent.name || "";
    info.componentId = mainComponent.id || "";
    info.componentName = mainComponent.name || "";
    info.variantProperties = clonePlainObject(mainComponent.variantProperties);
    if (mainComponent.parent && mainComponent.parent.type === "COMPONENT_SET") {
      info.mainComponentSetId = mainComponent.parent.id;
      info.mainComponentSetName = mainComponent.parent.name || "";
      info.componentSetId = mainComponent.parent.id;
      info.componentSetName = mainComponent.parent.name || "";
    }
  } catch (error) {
    warnings.push(`Component metadata failed for ${node.name || node.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return info;
}

/** 复制可 JSON 序列化的普通对象，避免 Figma 代理对象污染 manifest。 */
function clonePlainObject(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result = {};
  for (const key of Object.keys(value)) {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      result[key] = "";
    } else {
      result[key] = String(raw);
    }
  }
  return result;
}

/** 导出图片资源；优先使用 imageHash 原图，必要时导出节点 PNG。 */
async function exportFigmaPrefabImages(imageRequests, warnings) {
  const exports = [];
  const seenHash = {};
  for (const request of imageRequests) {
    try {
      if (request.source === "imageHash" && request.imageHash) {
        const exportKey = buildFigmaPrefabImageExportKey(request);
        if (seenHash[exportKey]) {
          exports.push(Object.assign({}, request, {
            duplicateOf: seenHash[exportKey],
            byteLength: 0,
            base64: "",
            health: createImageHealth("repaired", "duplicateReused", { sourceExportId: seenHash[exportKey] })
          }));
          continue;
        }
        const image = figma.getImageByHash(request.imageHash);
        if (!image) {
          warnings.push(`Image hash not found: ${request.imageHash}`);
          exports.push(Object.assign({}, request, { width: 0, height: 0, byteLength: 0, base64: "", health: createImageHealth("blocked", "imageHashNotFound") }));
          continue;
        }
        const size = await image.getSizeAsync();
        const exportResult = request.imageType === "Sliced"
          ? await exportMinimumNineSliceImage(request, size, warnings)
          : await exportImageAtFrameSize(request, image, size, warnings);
        seenHash[exportKey] = request.id;
        exports.push(Object.assign({}, request, {
          mimeType: "image/png",
          width: exportResult.width || 0,
          height: exportResult.height || 0,
          byteLength: exportResult.bytes.length,
          base64: bytesToBase64(exportResult.bytes),
          health: createImageHealth(exportResult.fallbackReason ? "repaired" : "healthy", exportResult.fallbackReason || "exported", {
            originalWidth: exportResult.originalWidth,
            originalHeight: exportResult.originalHeight
          })
        }));
        continue;
      }

      const node = await figma.getNodeByIdAsync(request.nodeId).catch(() => null);
      if (!node || !("exportAsync" in node)) {
        warnings.push(`Node cannot export PNG: ${request.nodePath || request.nodeId}`);
        exports.push(Object.assign({}, request, { width: 0, height: 0, byteLength: 0, base64: "", health: createImageHealth("blocked", "nodeCannotExport") }));
        continue;
      }
      const bounds = getNodeBounds(node);
      // contentOnly+SCALE×1 防止投影/描边外扩使 PNG 尺寸超出节点帧尺寸
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 }, contentsOnly: true });
      exports.push(Object.assign({}, request, {
        mimeType: "image/png",
        width: Math.round(bounds.width || 0),
        height: Math.round(bounds.height || 0),
        byteLength: bytes.length,
        base64: bytesToBase64(bytes),
        health: createImageHealth("healthy", "exported")
      }));
    } catch (error) {
      warnings.push(`PNG export failed for ${request.nodePath || request.nodeId}: ${error instanceof Error ? error.message : String(error)}`);
      exports.push(Object.assign({}, request, { width: 0, height: 0, byteLength: 0, base64: "", health: createImageHealth("blocked", "exportFailed") }));
    }
  }

  return {
    schemaVersion: 1,
    exports,
    healthSummary: summarizeImageHealth(exports)
  };
}

/** 构建图片去重键，九宫图需要把边框与最小尺寸纳入键。 */

function buildFigmaPrefabImageExportKey(request) {
  if (!request || request.imageType !== "Sliced") {
    return String(request && request.imageHash || "");
  }
  const border = request.border || {};
  const minSize = request.expectedMinSize || {};
  const visibleSize = request.sourceVisibleSize || {};
  return [
    request.imageHash || "",
    "sliced",
    request.sliceKind || "9slice",
    border.left || 0,
    border.bottom || 0,
    border.right || 0,
    border.top || 0,
    minSize.width || 0,
    minSize.height || 0,
    visibleSize.width || 0,
    visibleSize.height || 0
  ].join(":");
}

// 导出 Unity 九宫 Sprite 的最小 PNG，避免把 Figma 可见拉伸大图写入工程。
async function exportMinimumNineSliceImage(request, imageSize, warnings) {
  const border = request.border || {};
  const left = Math.max(0, Math.round(positiveOr(border.left, 0)));
  const right = Math.max(0, Math.round(positiveOr(border.right, 0)));
  const top = Math.max(0, Math.round(positiveOr(border.top, 0)));
  const bottom = Math.max(0, Math.round(positiveOr(border.bottom, 0)));
  const sliceKind = normalizeFigmaPrefabSliceKind(request.sliceKind, border);
  const targetSize = buildFigmaPrefabNineSliceTargetSize(request, border, sliceKind);
  const width = targetSize.width;
  const height = targetSize.height;
  const sourceSize = imageSize || {};
  const sourceWidth = Math.max(width, positiveOr(sourceSize.width, width));
  const sourceHeight = Math.max(height, positiveOr(sourceSize.height, height));

  const frame = figma.createFrame();
  frame.name = `__tmp_min_nine_${safeFileName(request.nodeId || request.id)}`;
  frame.resize(width, height);
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = true;
  frame.x = -100000;
  frame.y = -100000;
  figma.currentPage.appendChild(frame);

  const columns = buildFigmaPrefabNineSliceColumns(sliceKind, width, sourceWidth, left, right);
  const rows = buildFigmaPrefabNineSliceRows(sliceKind, height, sourceHeight, top, bottom);

  try {
    for (const column of columns) {
      for (const row of rows) {
        if (column.targetSize <= 0 || row.targetSize <= 0 || column.sourceSize <= 0 || row.sourceSize <= 0) {
          continue;
        }
        const rect = figma.createRectangle();
        rect.name = "__min_slice";
        frame.appendChild(rect);
        rect.x = column.targetStart;
        rect.y = row.targetStart;
        rect.resize(column.targetSize, row.targetSize);
        rect.strokes = [];
        rect.fills = [{
          type: "IMAGE",
          scaleMode: "CROP",
          imageHash: request.imageHash,
          imageTransform: [
            [column.sourceSize / sourceWidth, 0, column.sourceStart / sourceWidth],
            [0, row.sourceSize / sourceHeight, row.sourceStart / sourceHeight]
          ]
        }];
      }
    }
    const bytes = await frame.exportAsync({ format: "PNG" });
    return { width, height, bytes };
  } catch (error) {
    warnings.push(`PNG export failed for ${request.nodePath || request.nodeId}: ${error instanceof Error ? error.message : String(error)}`);
    const image = figma.getImageByHash(request.imageHash);
    return { width: imageSize.width || 0, height: imageSize.height || 0, bytes: await image.getBytesAsync() };
  } finally {
    frame.remove();
  }
}

function normalizeFigmaPrefabSliceKind(sliceKind, border) {
  const value = String(sliceKind || "").toLowerCase();
  if (value === "h3slice" || value === "h3-slice") {
    return "h3slice";
  }
  if (value === "v3slice" || value === "v3-slice") {
    return "v3slice";
  }
  const hasHorizontalBorder = border && border.left > 0 && border.right > 0;
  const hasVerticalBorder = border && border.top > 0 && border.bottom > 0;
  if (hasHorizontalBorder && !hasVerticalBorder) {
    return "h3slice";
  }
  if (!hasHorizontalBorder && hasVerticalBorder) {
    return "v3slice";
  }
  return "9slice";
}

function buildFigmaPrefabNineSliceTargetSize(request, border, sliceKind) {
  const visibleSize = request.sourceVisibleSize || {};
  const minWidth = Math.max(1, Math.round(positiveOr(border.left, 0) + positiveOr(border.right, 0) + 2));
  const minHeight = Math.max(1, Math.round(positiveOr(border.top, 0) + positiveOr(border.bottom, 0) + 2));
  if (sliceKind === "h3slice") {
    return {
      width: minWidth,
      height: Math.max(1, Math.round(positiveOr(visibleSize.height, minHeight)))
    };
  }
  if (sliceKind === "v3slice") {
    return {
      width: Math.max(1, Math.round(positiveOr(visibleSize.width, minWidth))),
      height: minHeight
    };
  }
  return {
    width: minWidth,
    height: minHeight
  };
}

function buildFigmaPrefabNineSliceColumns(sliceKind, targetWidth, sourceWidth, left, right) {
  if (sliceKind === "v3slice") {
    return [{ targetStart: 0, targetSize: targetWidth, sourceStart: 0, sourceSize: sourceWidth }];
  }
  return [
    { targetStart: 0, targetSize: left, sourceStart: 0, sourceSize: left },
    { targetStart: left, targetSize: 2, sourceStart: left, sourceSize: Math.max(1, sourceWidth - left - right) },
    { targetStart: left + 2, targetSize: right, sourceStart: Math.max(0, sourceWidth - right), sourceSize: right }
  ];
}

function buildFigmaPrefabNineSliceRows(sliceKind, targetHeight, sourceHeight, top, bottom) {
  if (sliceKind === "h3slice") {
    return [{ targetStart: 0, targetSize: targetHeight, sourceStart: 0, sourceSize: sourceHeight }];
  }
  return [
    { targetStart: 0, targetSize: top, sourceStart: 0, sourceSize: top },
    { targetStart: top, targetSize: 2, sourceStart: top, sourceSize: Math.max(1, sourceHeight - top - bottom) },
    { targetStart: top + 2, targetSize: bottom, sourceStart: Math.max(0, sourceHeight - bottom), sourceSize: bottom }
  ];
}

function validateFigmaPrefabSlicedExports(exports) {
  const errors = [];
  for (const item of exports || []) {
    if (!item || item.imageType !== "Sliced" || item.duplicateOf) {
      continue;
    }
    const border = item.border || {};
    const sliceKind = normalizeFigmaPrefabSliceKind(item.sliceKind, border);
    const expected = buildFigmaPrefabNineSliceTargetSize(item, border, sliceKind);
    const actualWidth = Math.round(positiveOr(item.width, 0));
    const actualHeight = Math.round(positiveOr(item.height, 0));
    if (actualWidth !== expected.width || actualHeight !== expected.height) {
      errors.push({
        code: "slicedExportSizeMismatch",
        nodeId: item.nodeId || "",
        nodePath: item.nodePath || "",
        sliceKind,
        expectedSize: `${expected.width}x${expected.height}`,
        actualSize: `${actualWidth}x${actualHeight}`
      });
    }
  }
  return errors;
}

/** 导出图片节点在其自身帧尺寸下的渲染结果，而非源图原生分辨率。 */
// 按帧尺寸导出图片；contentOnly + SCALE×1 防止投影/描边外扩导致 PNG > 帧尺寸。
async function exportImageAtFrameSize(request, sourceImage, sourceSize, warnings) {
  let fallbackReason = "frameExportFailed";
  let originalWidth = 0;
  let originalHeight = 0;
  try {
    const node = await figma.getNodeByIdAsync(request.nodeId);
    originalWidth = Number(node && node.width) || 0;
    originalHeight = Number(node && node.height) || 0;
    if (node && "exportAsync" in node && node.width >= 1 && node.height >= 1) {
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 }, contentsOnly: true });
      return { width: Math.round(node.width), height: Math.round(node.height), bytes };
    }
    if (node && originalWidth > 0 && originalHeight > 0) fallbackReason = "tinyFrameFallback";
  } catch (e) {
    warnings.push(`Frame-size export failed for ${request.nodePath || request.nodeId}, falling back to source native.`);
  }
  const sourceBytes = await sourceImage.getBytesAsync();
  return {
    width: sourceSize.width || 0,
    height: sourceSize.height || 0,
    bytes: sourceBytes,
    fallbackReason,
    originalWidth,
    originalHeight
  };
}

async function exportNodePngScreenshot(node) {
  if (!node || !("exportAsync" in node)) {
    return null;
  }
  const bounds = getNodeBounds(node);
  const bytes = await node.exportAsync({ format: "PNG" });
  return {
    fileName: `${safeFileName(node.name || "figma_node")}_${node.id.replace(":", "_")}.png`,
    mimeType: "image/png",
    width: Math.round(bounds.width || 0),
    height: Math.round(bounds.height || 0),
    byteLength: bytes.length,
    base64: bytesToBase64(bytes)
  };
}

/** 判断节点是否需要作为整图导出。 */
function shouldExportNodeAsImage(node) {
  if (!node || node.type === "TEXT" || node.type === "PAGE") {
    return false;
  }
  const hasChildren = "children" in node && Array.isArray(node.children) && node.children.length > 0;
  const hasVisiblePaint = hasRenderablePaint(node.fills) || hasRenderablePaint(node.strokes);
  return !hasChildren && hasVisiblePaint && hasPositiveBounds(node);
}

/** 读取节点边界，兼容 absoluteBoundingBox 缺失的节点。 */
function getNodeBounds(node) {
  const bounds = node && node.absoluteBoundingBox ? node.absoluteBoundingBox : null;
  return {
    x: bounds ? bounds.x : 0,
    y: bounds ? bounds.y : 0,
    width: bounds ? bounds.width : (node && node.width ? node.width : 0),
    height: bounds ? bounds.height : (node && node.height ? node.height : 0)
  };
}

function boundsToManifest(bounds) {
  return {
    x: roundNumber(bounds.x),
    y: roundNumber(bounds.y),
    width: roundNumber(bounds.width),
    height: roundNumber(bounds.height)
  };
}

function readFigmaPrefabConstraints(node) {
  if (!node || !("constraints" in node) || !node.constraints) {
    return { horizontal: "CENTER", vertical: "CENTER" };
  }
  return {
    horizontal: normalizePrefabHierarchyConstraint(node.constraints.horizontal, "CENTER"),
    vertical: normalizePrefabHierarchyConstraint(node.constraints.vertical, "CENTER")
  };
}

function boundsToRelativeManifest(bounds, rootBounds) {
  return {
    x: roundNumber(bounds.x - rootBounds.x),
    y: roundNumber(bounds.y - rootBounds.y),
    width: roundNumber(bounds.width),
    height: roundNumber(bounds.height)
  };
}

function buildNodePath(node, root) {
  const names = [];
  let current = node;
  while (current && current.id !== root.id) {
    names.unshift(current.name || current.id);
    current = current.parent;
  }
  names.unshift(root.name || root.id);
  return names.join("/");
}

function readFigmaFontSize(node) {
  if (!node || node.type !== "TEXT" || typeof node.fontSize !== "number") {
    return 0;
  }
  return node.fontSize;
}

/** 读取文本描边粗细，供 Unity TMP 材质近似还原描边。 */
function readFigmaStrokeWeight(node) {
  if (!node || node.type !== "TEXT" || typeof node.strokeWeight !== "number") {
    return 0;
  }
  return roundNumber(node.strokeWeight);
}

/** 构建层级整理错误结果，保持 Relay 返回结构稳定。 */
function buildHierarchyCleanupErrorResult(error, stage) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "error",
    allPass: false,
    blockingErrors: [{
      code: "hierarchyCleanupPluginException",
      message: `Figma 层级整理 ${stage} 阶段发生异常。`,
      details: { error: message }
    }],
    warnings: [],
    summary: {},
    checks: {},
    artifacts: {},
    errors: [message]
  };
}

/** 执行层级整理只读分析，不修改 Figma 文档。 */
async function analyzeFigmaHierarchyCleanupJob(job) {
  const target = job && job.target ? job.target : {};
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_CLEANUP_ANALYZE missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const includeHidden = !!options.includeHidden;
  const includeScreenshot = options.includeScreenshot !== false;
  const maxDepth = positiveOr(options.maxDepth, 8);
  const rootBounds = getNodeBounds(root);
  const directChildren = collectHierarchyDirectChildren(root, rootBounds, includeHidden);
  const nodes = [];
  collectHierarchyCleanupNodes(root, root, rootBounds, nodes, includeHidden, maxDepth, 0, "");
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const topLevelGroups = collectHierarchyTopLevelGroups(root);

  return {
    status: "completed",
    allPass: true,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootBounds: boundsToManifest(rootBounds),
    directChildCount: directChildren.length,
    directChildren,
    nodes,
    topLevelGroups,
    screenshot,
    blockingErrors: [],
    warnings: [],
    summary: {
      rootNodeId: root.id,
      rootName: root.name || "",
      directChildCount: directChildren.length,
      nodeCount: nodes.length,
      topLevelGroupCount: topLevelGroups.length
    },
    checks: {
      rootHasChildren: { pass: directChildren.length > 0 },
      screenshotExported: { pass: !!screenshot || !includeScreenshot }
    },
    artifacts: {
      analyzedAt: new Date().toISOString()
    }
  };
}

/** Analyze repeat-like hierarchy candidates without modifying the Figma document. */
async function handleFigmaHierarchyRepeatClusterAnalyze(message) {
  try {
    const result = await analyzeFigmaHierarchyRepeatClusterJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE_RESULT",
      requestId: message.requestId,
      result: buildHierarchyCleanupErrorResult(error, "repeatClusterAnalyze")
    });
  }
}

async function analyzeFigmaHierarchyRepeatClusterJob(job) {
  const target = job && job.target ? job.target : {};
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const includeHidden = !!options.includeHidden;
  const maxDepth = positiveOr(options.maxDepth, 4);
  const confidenceThreshold = Math.max(0, Math.min(1, numericOr(options.confidenceThreshold, 0.85)));
  const rootBounds = getNodeBounds(root);
  const records = [];
  collectHierarchyRepeatClusterRecords(root, root, rootBounds, records, includeHidden, maxDepth, 0);
  const childRecords = records.filter((record) => record.id !== root.id);
  const result = detectHierarchyRepeatCluster(childRecords, {
    confidenceThreshold,
    expectedXCount: positiveOr(options.expectedXCount, 7),
    expectedYCount: positiveOr(options.expectedYCount, 5)
  });

  return {
    status: result.status === "auto" ? "completed" : "rejected",
    allPass: result.status === "auto",
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootBounds: boundsToManifest(rootBounds),
    nodeCount: childRecords.length,
    clusterType: result.clusterType,
    confidence: result.confidence,
    groups: result.groups,
    nodeAssignments: result.nodeAssignments,
    rejectReasons: result.rejectReasons,
    candidates: result.candidates,
    usedSignals: result.usedSignals,
    ignoredSignals: result.ignoredSignals,
    warnings: [],
    blockingErrors: result.status === "auto" ? [] : result.rejectReasons,
    summary: {
      rootNodeId: root.id,
      rootName: root.name || "",
      nodeCount: childRecords.length,
      clusterType: result.clusterType,
      confidence: result.confidence,
      groupCount: result.groups.length,
      ignoredSignals: result.ignoredSignals
    },
    checks: {
      highConfidence: { pass: result.status === "auto", threshold: confidenceThreshold, actual: result.confidence },
      noNameSignals: { pass: true, ignoredSignals: result.ignoredSignals },
      readOnly: { pass: true }
    },
    artifacts: {
      analyzedAt: new Date().toISOString()
    }
  };
}

function collectHierarchyRepeatClusterRecords(node, root, rootBounds, output, includeHidden, maxDepth, depth) {
  if (!node || (!includeHidden && node.visible === false)) {
    return;
  }
  const bounds = getNodeBounds(node);
  output.push({
    id: node.id,
    type: node.type || "",
    x: bounds.x - rootBounds.x,
    y: bounds.y - rootBounds.y,
    width: bounds.width,
    height: bounds.height,
    visible: node.visible !== false,
    opacity: numericOr(node.opacity, 1),
    childCount: "children" in node && Array.isArray(node.children) ? node.children.length : 0,
    isNineSliceLike: isHierarchyNineSliceLikeNode(node),
    depth
  });
  if (!("children" in node) || depth >= maxDepth) {
    return;
  }
  for (const child of node.children || []) {
    collectHierarchyRepeatClusterRecords(child, root, rootBounds, output, includeHidden, maxDepth, depth + 1);
  }
}

function detectHierarchyRepeatCluster(nodes, options) {
  const confidenceThreshold = numericOr(options && options.confidenceThreshold, 0.85);
  const candidates = [
    detectHierarchyAxisRepeatCluster(nodes, "x", positiveOr(options && options.expectedXCount, 7), confidenceThreshold),
    detectHierarchyAxisRepeatCluster(nodes, "y", positiveOr(options && options.expectedYCount, 5), confidenceThreshold),
    detectHierarchyProgressRepeatCluster(nodes, confidenceThreshold)
  ];
  const autoCandidates = candidates
    .filter((candidate) => candidate.status === "auto")
    .sort((left, right) => right.confidence - left.confidence);
  if (autoCandidates.length === 0) {
    const rejected = buildHierarchyRepeatRejected("noHighConfidenceCandidate", 0, { candidates: candidates.map(summarizeHierarchyRepeatCandidate) });
    rejected.candidates = candidates.map(summarizeHierarchyRepeatCandidate);
    return rejected;
  }
  if (autoCandidates.length > 1 && Math.abs(autoCandidates[0].confidence - autoCandidates[1].confidence) < 0.03) {
    const rejected = buildHierarchyRepeatRejected("ambiguousCandidates", autoCandidates[0].confidence, { candidates: candidates.map(summarizeHierarchyRepeatCandidate) });
    rejected.candidates = candidates.map(summarizeHierarchyRepeatCandidate);
    return rejected;
  }
  autoCandidates[0].candidates = candidates.map(summarizeHierarchyRepeatCandidate);
  return autoCandidates[0];
}

function detectHierarchyAxisRepeatCluster(nodes, axis, expectedCount, confidenceThreshold) {
  const usable = filterHierarchyRepeatUsableNodes(nodes);
  const anchors = usable
    .filter((node) => {
      if (node.isNineSliceLike) {
        return axis === "y" ? node.width >= 300 && node.height >= 100 : node.width >= 80 && node.height >= 100;
      }
      if (node.type !== "FRAME" && node.type !== "RECTANGLE") {
        return false;
      }
      const nodeArea = Math.max(0, node.width) * Math.max(0, node.height);
      return axis === "x"
        ? nodeArea >= 10000 && node.height >= 100
        : nodeArea >= 30000 && node.width >= 300;
    })
    .sort((left, right) => axis === "x" ? left.x - right.x : left.y - right.y);
  const directAnchors = anchors.filter((node) => numericOr(node.depth, 0) === 1);
  const selectedAnchors = (directAnchors.length >= expectedCount ? directAnchors : anchors)
    .slice(0, expectedCount)
    .sort((left, right) => axis === "x" ? left.x - right.x : left.y - right.y);
  if (selectedAnchors.length < expectedCount) {
    return buildHierarchyRepeatRejected("anchorCount", 0, { axis, expectedCount, actualCount: selectedAnchors.length });
  }

  const selected = selectedAnchors;
  const gaps = [];
  for (let index = 1; index < selected.length; index += 1) {
    gaps.push(axis === "x" ? selected[index].x - selected[index - 1].x : selected[index].y - selected[index - 1].y);
  }
  const step = hierarchyMedian(gaps);
  if (step < 20) {
    return buildHierarchyRepeatRejected("axisCollapsed", 0, { axis, step, expectedCount });
  }
  const maxGapDelta = gaps.reduce((max, gap) => Math.max(max, Math.abs(gap - step)), 0);
  const confidence = Math.max(0, 1 - maxGapDelta / Math.max(1, step));
  if (confidence < confidenceThreshold) {
    return buildHierarchyRepeatRejected("lowConfidence", confidence, { axis, step, maxGapDelta, threshold: confidenceThreshold });
  }

  const assignments = {};
  for (const node of usable) {
    const nodeCenter = hierarchyCenter(node);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    selected.forEach((anchor, index) => {
      const anchorCenter = hierarchyCenter(anchor);
      const distance = axis === "x" ? Math.abs(nodeCenter.x - anchorCenter.x) : Math.abs(nodeCenter.y - anchorCenter.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    assignments[node.id] = `${axis}_group_${bestIndex + 1}`;
  }
  return buildHierarchyRepeatAuto(axis === "x" ? "horizontal-list" : "vertical-list", confidence, assignments, selected.map((anchor, index) => ({
    key: `${axis}_group_${index + 1}`,
    anchorNodeId: anchor.id
  })), ["mainAxisGapStability"]);
}

function detectHierarchyProgressRepeatCluster(nodes, confidenceThreshold) {
  const usable = filterHierarchyRepeatUsableNodes(nodes);
  const assignments = {};
  for (const track of usable.filter((node) => node.width > 500 && node.height < 100)) {
    assignments[track.id] = "track";
  }
  const markers = usable
    .filter((node) => node.width <= 25 && node.height >= 40 && node.height <= 75)
    .sort((left, right) => left.x - right.x);
  if (markers.length < 4) {
    return buildHierarchyRepeatRejected("markerCount", 0, { expectedCount: 4, actualCount: markers.length });
  }
  const slots = markers.slice(0, 4).map((marker, index) => ({ key: `slot_${index + 1}`, x: hierarchyCenter(marker).x }));
  const gaps = slots.slice(1).map((slot, index) => slot.x - slots[index].x);
  const step = hierarchyMedian(gaps);
  const maxGapDelta = gaps.reduce((max, gap) => Math.max(max, Math.abs(gap - step)), 0);
  const confidence = Math.max(0, 1 - maxGapDelta / Math.max(1, step));
  if (confidence < confidenceThreshold) {
    return buildHierarchyRepeatRejected("lowConfidence", confidence, { step, maxGapDelta, threshold: confidenceThreshold });
  }
  const minX = Math.min.apply(null, usable.map((node) => node.x));
  const maxX = Math.max.apply(null, usable.map((node) => node.x + node.width));
  for (const node of usable) {
    if (assignments[node.id]) {
      continue;
    }
    const nodeCenter = hierarchyCenter(node);
    if (nodeCenter.x < minX + 130) {
      assignments[node.id] = "start";
    } else if (nodeCenter.x > maxX - 120) {
      assignments[node.id] = "final";
    } else {
      let best = slots[0];
      for (const slot of slots) {
        if (Math.abs(nodeCenter.x - slot.x) < Math.abs(nodeCenter.x - best.x)) {
          best = slot;
        }
      }
      assignments[node.id] = best.key;
    }
  }
  return buildHierarchyRepeatAuto("progress", confidence, assignments, [
    { key: "track" },
    { key: "start" },
    ...slots.map((slot) => ({ key: slot.key })),
    { key: "final" }
  ], ["markerGapStability", "edgeSlots"]);
}

function buildHierarchyRepeatAuto(clusterType, confidence, assignments, groupSeeds, extraSignals) {
  const groups = groupSeeds
    .map((seed) => {
      const nodeIds = Object.keys(assignments).filter((nodeId) => assignments[nodeId] === seed.key);
      return Object.assign({}, seed, { nodeIds });
    })
    .filter((group) => group.nodeIds.length > 0);
  return {
    status: "auto",
    clusterType,
    confidence,
    groups,
    nodeAssignments: assignments,
    rejectReasons: [],
    usedSignals: ["type", "x", "y", "width", "height", "visible", "opacity", "childCount", "isNineSliceLike"].concat(extraSignals || []),
    ignoredSignals: ["name", "path", "characters"]
  };
}

function buildHierarchyRepeatRejected(reason, confidence, details) {
  return {
    status: "rejected",
    clusterType: "unknown",
    confidence,
    groups: [],
    nodeAssignments: {},
    rejectReasons: [{ reason, details }],
    usedSignals: ["type", "x", "y", "width", "height", "visible", "opacity", "childCount", "isNineSliceLike"],
    ignoredSignals: ["name", "path", "characters"],
    candidates: []
  };
}

function summarizeHierarchyRepeatCandidate(candidate) {
  return {
    status: candidate.status,
    clusterType: candidate.clusterType,
    confidence: numericOr(candidate.confidence, 0),
    rejectReasons: candidate.rejectReasons || []
  };
}

function filterHierarchyRepeatUsableNodes(nodes) {
  return (nodes || []).filter((node) => node && node.id && node.visible !== false && numericOr(node.opacity, 1) > 0 && numericOr(node.width, 0) > 0 && numericOr(node.height, 0) > 0);
}

function hierarchyCenter(node) {
  return {
    x: numericOr(node.x, 0) + numericOr(node.width, 0) / 2,
    y: numericOr(node.y, 0) + numericOr(node.height, 0) / 2
  };
}

function hierarchyMedian(values) {
  const sorted = (values || []).slice().sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.floor(sorted.length / 2)];
}

function isHierarchyNineSliceLikeNode(node) {
  if (!node || !("children" in node)) {
    return false;
  }
  const children = Array.from(node.children || []);
  if (children.length !== 3 && children.length !== 9) {
    return false;
  }
  return children.every((child) => String(child && child.name || "").indexOf("__slice_") === 0);
}

/** Export only a target node PNG screenshot. */
async function exportFigmaNodeScreenshotJob(job) {
  const target = job && job.target ? job.target : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_EXPORT_NODE_SCREENSHOT missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }

  await setCurrentPageForNode(root);
  const rootBounds = getNodeBounds(root);
  const screenshot = await exportNodePngScreenshot(root);

  return {
    status: screenshot ? "completed" : "blocked",
    allPass: !!screenshot,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootBounds: boundsToManifest(rootBounds),
    screenshot,
    blockingErrors: screenshot ? [] : [{
      code: "screenshotExported",
      message: "PNG screenshot export returned empty data."
    }],
    warnings: [],
    summary: {
      rootNodeId: root.id,
      rootName: root.name || "",
      screenshotByteLength: screenshot ? screenshot.byteLength : 0
    },
    checks: {
      screenshotExported: { pass: !!screenshot }
    },
    artifacts: {
      exportedAt: new Date().toISOString()
    },
    errors: []
  };
}

/** 执行确认后的层级整理计划。 */
async function applyFigmaHierarchyCleanupJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || (plan.target && plan.target.nodeId) || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_CLEANUP_APPLY missing target.nodeId");
  }
  if (!Array.isArray(plan.groups) || plan.groups.length === 0) {
    throw new Error("FIGMA_HIERARCHY_CLEANUP_APPLY missing plan.groups");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  if (isHierarchyAutoLayoutNode(root)) {
    return buildHierarchyCleanupBlockedResult(root, [], [{
      code: "rootAutoLayoutUnsupported",
      message: "目标根节点启用了 Auto Layout，自动层级整理可能改变布局，已阻止写入。",
      details: { layoutMode: root.layoutMode }
    }]);
  }
  // Run all zero-write preflight checks before backup clone or grouping.
  const beforeBounds = getNodeBounds(root);
  const beforeChildren = collectHierarchyDirectChildren(root, beforeBounds, true);
  const beforeChildIds = beforeChildren.map((child) => child.id);
  const validationErrors = validateHierarchyCleanupPlan(plan, beforeChildren, {
    rootNodeId: root.id,
    targetNodeId: nodeId
  });
  validationErrors.push(...buildHierarchyPlanSemanticBlockingErrors(plan, beforeChildren, root.name || ""));
  if (validationErrors.length > 0) {
    return buildHierarchyCleanupBlockedResult(root, beforeChildren, validationErrors);
  }
  const resolvedPlanNodes = await resolveHierarchyCleanupPlanChildNodes(root, plan, beforeChildren);
  if (resolvedPlanNodes.errors.length > 0) {
    return buildHierarchyCleanupBlockedResult(root, beforeChildren, resolvedPlanNodes.errors);
  }

  // 如果 plan 指定了 createBackup，先复制整个根节点作为隐藏备份
  const backupInfo = {};
  if (plan.createBackup) {
    try {
      const page = findContainingPage(root) || figma.currentPage;
      const clone = root.clone();
      page.appendChild(clone);
      clone.x = root.x + root.width + 100;
      clone.y = root.y;
      clone.visible = false;
      clone.name = `[Backup]${root.name || ""}`;
      backupInfo.cloneId = clone.id;
      backupInfo.cloneName = clone.name;
      backupInfo.success = true;
    } catch (error) {
      backupInfo.success = false;
      backupInfo.error = error instanceof Error ? error.message : String(error);
    }
  }
  const beforeBoundsById = {};
  const beforeChildrenById = {};
  for (const child of beforeChildren) {
    beforeBoundsById[child.id] = child.bounds;
    beforeChildrenById[child.id] = child;
  }

  const createdGroups = [];
  const movedNodeIds = [];
  for (const groupPlan of plan.groups) {
    const groupNode = createHierarchyCleanupGroup(root, groupPlan, beforeChildren);
    createdGroups.push({
      id: groupNode.id,
      name: groupNode.name,
      childCount: Array.isArray(groupPlan.childNodeIds) ? groupPlan.childNodeIds.length : 0
    });
    const childIds = groupPlan.childNodeIds || [];
    for (const childId of childIds) {
      const child = resolvedPlanNodes.nodesById[String(childId)];
      const beforeRecord = beforeChildrenById[String(childId)];
      if (!child || !beforeRecord || !("appendChild" in groupNode)) {
        throw new Error(`Hierarchy cleanup internal error: unresolved child ${childId}`);
      }
      groupNode.appendChild(child);
      preserveHierarchyChildAbsoluteBounds(child, groupNode, beforeRecord.bounds);
      movedNodeIds.push(child.id);
    }
    // 如果 groupPlan 指定了 renameChildren，移动后重命名对应子节点
    if (groupPlan.renameChildren) {
      for (const [childId, newName] of Object.entries(groupPlan.renameChildren)) {
        if (!childId || !newName) continue;
        const child = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
        if (child) {
          child.name = String(newName);
        }
      }
    }
  }

  const afterBounds = getNodeBounds(root);
  const originalNodesAfter = await collectHierarchyOriginalNodesAfter(plan, beforeBoundsById);
  const topLevelGroups = collectHierarchyTopLevelGroups(root);
  const driftNodes = collectHierarchyBoundsDrift(originalNodesAfter, beforeBoundsById, 0.01);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    rootPositionStable: {
      pass: Math.abs(beforeBounds.x - afterBounds.x) <= 0.01 && Math.abs(beforeBounds.y - afterBounds.y) <= 0.01,
      before: { x: beforeBounds.x, y: beforeBounds.y },
      after: { x: afterBounds.x, y: afterBounds.y },
      driftX: Math.round((beforeBounds.x - afterBounds.x) * 100) / 100,
      driftY: Math.round((beforeBounds.y - afterBounds.y) * 100) / 100
    },
    allOriginalChildrenAssignedOnce: {
      pass: movedNodeIds.length === beforeChildIds.length && uniqueStrings(movedNodeIds).length === beforeChildIds.length,
      movedCount: movedNodeIds.length,
      expected: beforeChildIds.length
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    topLevelGroupsMatchPlan: {
      pass: topLevelGroups.map((item) => item.name).join("|") === plan.groups.map((item) => String(item.name || "")).join("|"),
      actual: topLevelGroups.map((item) => item.name),
      expected: plan.groups.map((item) => String(item.name || ""))
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const semanticErrors = buildHierarchyLiveSemanticBlockingErrors(root, { mode: "cleanupApply", plan });
  if (semanticErrors.length > 0) {
    checks.semanticHierarchyRules = {
      pass: false,
      errors: semanticErrors
    };
  }
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks).concat(semanticErrors);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    rootBounds: boundsToManifest(afterBounds),
    originalNodesAfter,
    topLevelGroups,
    screenshot,
    backupInfo,
    blockingErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      afterDirectChildCount: topLevelGroups.length,
      createdGroups: createdGroups.length,
      movedOriginalNodes: movedNodeIds.length
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildIds
      },
      after: {
        rootBounds: boundsToManifest(afterBounds)
      },
      plan,
      createdGroups,
      backupInfo,
      mutatedNodeIds: movedNodeIds
    },
    errors: []
  };
}

/** 执行根节点直接子节点重排，专用于修正视觉栈层级。 */
/** Create a nested wrapper chain and move current direct children to the deepest wrapper. */
async function wrapFigmaHierarchyChainJob(job) {
  const target = job && job.target ? job.target : {};
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_WRAP_CHAIN missing target.nodeId");
  }
  const wrapperChain = normalizeHierarchyWrapperChain(job.wrapperChain || (job.plan && job.plan.wrapperChain));
  if (wrapperChain.length < 2) {
    throw new Error("FIGMA_HIERARCHY_WRAP_CHAIN requires wrapperChain with at least two names");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const wrapperSemanticErrors = buildHierarchyWrapperChainSemanticBlockingErrors(root, wrapperChain);
  if (wrapperSemanticErrors.length > 0) {
    return buildHierarchyCleanupBlockedResult(root, [], wrapperSemanticErrors);
  }
  if (isHierarchyAutoLayoutNode(root)) {
    return buildHierarchyCleanupBlockedResult(root, [], [{
      code: "rootAutoLayoutUnsupported",
      message: "Wrapper chain target uses Auto Layout and was not modified.",
      details: { layoutMode: root.layoutMode }
    }]);
  }

  const beforeBounds = getNodeBounds(root);
  const beforeChildren = collectHierarchyDirectChildren(root, beforeBounds, true);
  if (beforeChildren.length === 0) {
    return buildHierarchyCleanupBlockedResult(root, beforeChildren, [{
      code: "emptyWrapperRoot",
      message: "Wrapper chain target has no direct children.",
      details: { rootNodeId: root.id, rootName: root.name || "" }
    }]);
  }

  const beforeChildIds = beforeChildren.map((child) => child.id);
  const beforeBoundsById = {};
  const beforeChildrenById = {};
  for (const child of beforeChildren) {
    beforeBoundsById[child.id] = child.bounds;
    beforeChildrenById[child.id] = child;
  }

  const createdGroups = [];
  let parent = root;
  for (let index = 1; index < wrapperChain.length; index++) {
    const name = wrapperChain[index];
    const groupNode = index === 1
      ? createHierarchyCleanupGroup(parent, { name, childNodeIds: beforeChildIds }, beforeChildren)
      : createFullSizeHierarchyWrapper(parent, name);
    createdGroups.push({
      id: groupNode.id,
      name: groupNode.name,
      parentId: parent.id,
      index: index - 1,
      bounds: boundsToManifest(getNodeBounds(groupNode))
    });
    parent = groupNode;
  }

  const deepestGroup = parent;
  const movedNodeIds = [];
  for (const childId of beforeChildIds) {
    const child = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
    const beforeRecord = beforeChildrenById[String(childId)];
    if (!child || !beforeRecord || child.parent !== root) {
      throw new Error(`Hierarchy wrap-chain internal error: unresolved direct child ${childId}`);
    }
    deepestGroup.appendChild(child);
    preserveHierarchyChildAbsoluteBounds(child, deepestGroup, beforeRecord.bounds);
    movedNodeIds.push(child.id);
  }

  const afterBounds = getNodeBounds(root);
  const originalNodesAfter = await collectHierarchyWrapChainOriginalNodesAfter(beforeChildIds, beforeBoundsById);
  const topLevelGroups = collectHierarchyTopLevelGroups(root);
  const driftNodes = collectHierarchyBoundsDrift(originalNodesAfter, beforeBoundsById, 0.01);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const expectedTopLevelName = wrapperChain[1];
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    rootPositionStable: {
      pass: Math.abs(beforeBounds.x - afterBounds.x) <= 0.01 && Math.abs(beforeBounds.y - afterBounds.y) <= 0.01,
      before: { x: beforeBounds.x, y: beforeBounds.y },
      after: { x: afterBounds.x, y: afterBounds.y }
    },
    allOriginalChildrenAssignedOnce: {
      pass: movedNodeIds.length === beforeChildIds.length && uniqueStrings(movedNodeIds).length === beforeChildIds.length,
      movedCount: movedNodeIds.length,
      expected: beforeChildIds.length
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    topLevelChainMatchesPlan: {
      pass: topLevelGroups.length === 1 && topLevelGroups[0].name === expectedTopLevelName,
      actual: topLevelGroups.map((item) => item.name),
      expected: [expectedTopLevelName]
    },
    wrapperChainCreated: {
      pass: createdGroups.length === wrapperChain.length - 1 && createdGroups.map((item) => item.name).join("|") === wrapperChain.slice(1).join("|"),
      actual: createdGroups.map((item) => item.name),
      expected: wrapperChain.slice(1)
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const semanticErrors = buildHierarchyLiveSemanticBlockingErrors(root, { mode: "wrapChain", wrapperChain });
  if (semanticErrors.length > 0) {
    checks.semanticHierarchyRules = {
      pass: false,
      errors: semanticErrors
    };
  }
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks).concat(semanticErrors);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    rootBounds: boundsToManifest(afterBounds),
    originalNodesAfter,
    topLevelGroups,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      afterDirectChildCount: topLevelGroups.length,
      createdGroups: createdGroups.length,
      movedOriginalNodes: movedNodeIds.length,
      deepestGroupId: deepestGroup.id,
      deepestGroupName: deepestGroup.name || ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildIds
      },
      after: {
        rootBounds: boundsToManifest(afterBounds)
      },
      wrapperChain,
      createdGroups,
      deepestGroupId: deepestGroup.id,
      deepestGroupName: deepestGroup.name || "",
      mutatedNodeIds: movedNodeIds
    },
    errors: []
  };
}

function normalizeHierarchyWrapperChain(value) {
  const raw = Array.isArray(value) ? value : String(value || "").replace(/\//g, ">").split(">");
  const names = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    if (!text) {
      continue;
    }
    names.push(text.startsWith("[") && text.endsWith("]") ? text : `[${text.replace(/^\[|\]$/g, "")}]`);
  }
  return names;
}

function createFullSizeHierarchyWrapper(parent, name) {
  const frame = figma.createFrame();
  frame.name = String(name || "[Group]");
  frame.x = 0;
  frame.y = 0;
  frame.resize(Math.max(parent.width || 0.01, 0.01), Math.max(parent.height || 0.01, 0.01));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  parent.appendChild(frame);
  return frame;
}

function normalizeHierarchySemanticName(value) {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/[\s_\-\[\]]+/g, "");
}

function isHierarchyListLikeName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("tasklist") >= 0 || name.indexOf("listroot") >= 0 || name === "list" || name.endsWith("list");
}

function isHierarchyItemName(value) {
  const name = normalizeHierarchySemanticName(value);
  return /^item\d*/.test(name) || /^taskitem\d*/.test(name) || /^rewarditem\d*/.test(name);
}

function isHierarchyScrollViewName(value) {
  return normalizeHierarchySemanticName(value) === "scrollview";
}

function isHierarchyViewportName(value) {
  return normalizeHierarchySemanticName(value) === "viewport";
}

function isHierarchyContentName(value) {
  return normalizeHierarchySemanticName(value) === "content";
}

function isHierarchyProgressTrackName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name === "progresstrack" || name === "progressbar";
}

function isHierarchyRewardSlotName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("rewardslot") >= 0 || name.indexOf("milestone") >= 0;
}

function isHierarchyMarkerName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("jdtbig3") >= 0 || name.indexOf("marker") >= 0 || name.indexOf("tick") >= 0;
}

function isHierarchyTrackOnlyName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("slice") >= 0 || name.indexOf("jiugong") >= 0 || name.indexOf("track") >= 0 || name.indexOf("fill") >= 0 || name.indexOf("jdtbig1") >= 0 || name.indexOf("jdtbig2") >= 0;
}

function buildHierarchyPlanSemanticBlockingErrors(plan, beforeChildren, rootName) {
  const errors = [];
  const groups = Array.isArray(plan && plan.groups) ? plan.groups : [];
  const childNameById = {};
  for (const child of beforeChildren || []) {
    if (child && child.id) {
      childNameById[String(child.id)] = String(child.name || "");
    }
  }
  const groupNames = groups.map((group) => String(group && group.name || ""));
  const hasItemGroups = groupNames.some(isHierarchyItemName);
  const listLike = isHierarchyListLikeName(rootName) || groupNames.some(isHierarchyListLikeName);
  const hasScrollView = groupNames.some(isHierarchyScrollViewName);
  const hasViewport = groupNames.some(isHierarchyViewportName);
  const hasContent = groupNames.some(isHierarchyContentName);
  const targetIsContentChain = isHierarchyContentName(rootName) || isHierarchyViewportName(rootName) || isHierarchyScrollViewName(rootName);
  if (listLike && hasItemGroups && !targetIsContentChain && !(hasScrollView && hasViewport && hasContent)) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List-like cleanup plans with item groups must include [ScrollView] > [Viewport] > [Content].",
      details: {
        rootName: String(rootName || ""),
        groupNames,
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]"
      }
    });
  }

  for (const group of groups) {
    const groupName = String(group && group.name || "");
    if (!isHierarchyProgressTrackName(groupName)) {
      continue;
    }
    const badChildren = [];
    for (const childId of group.childNodeIds || []) {
      const childName = childNameById[String(childId)] || String(childId);
      if (isHierarchyMarkerName(childName) && !isHierarchyTrackOnlyName(childName)) {
        badChildren.push({ nodeId: String(childId), name: childName });
      }
    }
    if (badChildren.length > 0 && groupNames.some(isHierarchyRewardSlotName)) {
      errors.push({
        code: "progressMarkerNotInRewardSlot",
        message: "Progress marker nodes must be owned by [RewardSlot_*] or [Milestone_*], not [ProgressTrack].",
        details: {
          groupName,
          badChildren,
          requiredStructure: "Move marker/tick/jdtbig3 nodes into matching [RewardSlot_*] or [Milestone_*]; keep [ProgressTrack] for track/fill/slice nodes only."
        }
      });
    }
  }
  return errors;
}

function buildHierarchyWrapperChainSemanticBlockingErrors(root, wrapperChain) {
  const errors = [];
  const rootName = root && root.name ? root.name : "";
  if (isHierarchyListLikeName(rootName)) {
    const hasScrollChainNames = wrapperChain.some(isHierarchyScrollViewName) && wrapperChain.some(isHierarchyViewportName) && wrapperChain.some(isHierarchyContentName);
    if (hasScrollChainNames && !isHierarchyScrollViewName(wrapperChain[1])) {
      errors.push({
        code: "scrollViewChainMissing",
        message: "Wrapper chain for a list-like target must create [ScrollView] as the first child under the target.",
        details: {
          rootName,
          wrapperChain,
          requiredWrapperChain: "[ListRoot] > [ScrollView] > [Viewport] > [Content]",
          note: "The first wrapperChain entry is treated as the current root label; the plugin creates entries from index 1."
        }
      });
    }
  }
  return errors;
}

function buildHierarchyLiveSemanticBlockingErrors(root, context) {
  const errors = [];
  errors.push(...buildHierarchyLiveListBlockingErrors(root, context));
  errors.push(...buildHierarchyLiveProgressMarkerBlockingErrors(root, context));
  return errors;
}

function buildHierarchyLiveListBlockingErrors(root, context) {
  const errors = [];
  if (!root || !("children" in root)) {
    return errors;
  }
  const rootName = root.name || "";
  const directChildren = Array.from(root.children || []);
  const rootListLike = isHierarchyListLikeName(rootName);
  const directItemChildren = directChildren.filter((child) => isHierarchyItemName(child.name || ""));
  const scroll = directChildren.find((child) => isHierarchyScrollViewName(child.name || ""));
  const viewport = scroll && "children" in scroll ? Array.from(scroll.children || []).find((child) => isHierarchyViewportName(child.name || "")) : null;
  const content = viewport && "children" in viewport ? Array.from(viewport.children || []).find((child) => isHierarchyContentName(child.name || "")) : null;
  const misplacedItems = [];
  collectHierarchySemanticNodes(root, (node) => {
    if (node === root || !isHierarchyItemName(node.name || "")) {
      return;
    }
    const parentName = node.parent ? node.parent.name || "" : "";
    if (!isHierarchyContentName(parentName)) {
      misplacedItems.push({
        nodeId: node.id,
        name: node.name || "",
        parentId: node.parent ? node.parent.id : "",
        parentName
      });
    }
  });

  if (rootListLike && directItemChildren.length > 0) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List item groups must be under [ScrollView] > [Viewport] > [Content], not directly under the list root.",
      details: {
        rootNodeId: root.id,
        rootName,
        directItemNames: directItemChildren.map((child) => child.name || ""),
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]",
        context
      }
    });
  } else if (rootListLike && content && misplacedItems.length > 0) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List item groups must be direct children of [Content].",
      details: {
        rootNodeId: root.id,
        rootName,
        misplacedItems,
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]",
        context
      }
    });
  } else if (rootListLike && (scroll || directChildren.some((child) => isHierarchyViewportName(child.name || "") || isHierarchyContentName(child.name || ""))) && (!scroll || !viewport || !content)) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List-like hierarchy has a partial ScrollView chain.",
      details: {
        rootNodeId: root.id,
        rootName,
        hasScrollView: !!scroll,
        hasViewport: !!viewport,
        hasContent: !!content,
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]",
        context
      }
    });
  }
  return errors;
}

function buildHierarchyLiveProgressMarkerBlockingErrors(root, context) {
  const errors = [];
  const progressNodes = [];
  const rewardNodes = [];
  collectHierarchySemanticNodes(root, (node) => {
    if (isHierarchyProgressTrackName(node.name || "")) {
      progressNodes.push(node);
    }
    if (isHierarchyRewardSlotName(node.name || "")) {
      rewardNodes.push(node);
    }
  });
  if (rewardNodes.length === 0) {
    return errors;
  }
  for (const progressNode of progressNodes) {
    if (!progressNode || !("children" in progressNode)) {
      continue;
    }
    const badChildren = Array.from(progressNode.children || [])
      .filter((child) => isHierarchyMarkerName(child.name || "") && !isHierarchyTrackOnlyName(child.name || ""))
      .map((child) => ({ nodeId: child.id, name: child.name || "" }));
    if (badChildren.length > 0) {
      errors.push({
        code: "progressMarkerNotInRewardSlot",
        message: "Progress marker nodes must be owned by [RewardSlot_*] or [Milestone_*], not [ProgressTrack].",
        details: {
          progressNodeId: progressNode.id,
          progressName: progressNode.name || "",
          badChildren,
          rewardCandidates: rewardNodes.map((node) => ({ nodeId: node.id, name: node.name || "" })),
          requiredStructure: "Move marker/tick/jdtbig3 nodes into matching [RewardSlot_*] or [Milestone_*]; keep [ProgressTrack] for track/fill/slice nodes only.",
          context
        }
      });
    }
  }
  return errors;
}

function collectHierarchySemanticNodes(node, visitor) {
  if (!node) {
    return;
  }
  visitor(node);
  if (!("children" in node)) {
    return;
  }
  for (const child of node.children || []) {
    collectHierarchySemanticNodes(child, visitor);
  }
}

async function collectHierarchyWrapChainOriginalNodesAfter(childIds, beforeBoundsById) {
  const output = [];
  const rootBounds = { x: 0, y: 0, width: 0, height: 0 };
  for (const childId of childIds || []) {
    const node = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
    if (!node) {
      continue;
    }
    output.push(buildHierarchyNodeRecord(node, node, rootBounds, node.parent ? node.parent.id : "", 0));
    output[output.length - 1].beforeBounds = beforeBoundsById[String(childId)] || null;
  }
  return output;
}

/** Execute explicit hierarchy operations sequentially without extra MCP round-trips. */
async function applyFigmaHierarchyBatchJob(job) {
  const rawSteps = Array.isArray(job.steps) ? job.steps : (job.plan && Array.isArray(job.plan.steps) ? job.plan.steps : []);
  if (rawSteps.length === 0) {
    throw new Error("FIGMA_HIERARCHY_BATCH_APPLY requires steps");
  }
  const refs = {};
  const stepSummaries = [];
  const blockingErrors = [];
  const warnings = [];
  const errors = [];
  const startedAt = Date.now();
  let finalScreenshot = null;
  let rootNodeId = "";
  let rootName = "";
  let completedSteps = 0;

  for (let index = 0; index < rawSteps.length; index++) {
    const step = rawSteps[index] || {};
    const stepStartedAt = Date.now();
    const stepType = normalizeHierarchyBatchStepType(step.type || step.kind);
    if (!stepType) {
      blockingErrors.push({
        code: "unsupportedBatchStepType",
        message: "Unsupported hierarchy batch step type.",
        details: { index, type: String(step.type || step.kind || "") }
      });
      break;
    }

    let result = null;
    try {
      const stepJob = buildHierarchyBatchStepJob(step, refs, job.options || {});
      if (stepType === "cleanupApply") {
        result = await applyFigmaHierarchyCleanupJob(stepJob);
      } else if (stepType === "wrapChain") {
        result = await wrapFigmaHierarchyChainJob(stepJob);
      } else if (stepType === "reorderChildren") {
        result = await reorderFigmaHierarchyChildrenJob(stepJob);
      } else if (stepType === "screenshot") {
        result = await exportFigmaNodeScreenshotJob(stepJob);
      }
    } catch (error) {
      result = buildHierarchyCleanupErrorResult(error, stepType);
    }

    if (result && result.rootNodeId) {
      rootNodeId = String(result.rootNodeId || "");
      rootName = String(result.rootName || "");
    }
    registerHierarchyBatchRefs(refs, step, result);
    const stepDurationMs = Date.now() - stepStartedAt;
    const summary = compactHierarchyBatchStepResult(index, step, stepType, result, stepDurationMs);
    stepSummaries.push(summary);
    if (Array.isArray(result && result.warnings)) {
      warnings.push(...result.warnings.map((item) => Object.assign({ stepIndex: index }, item)));
    }
    if (Array.isArray(result && result.errors)) {
      errors.push(...result.errors.map((item) => ({ stepIndex: index, message: String(item) })));
    }
    if (result && result.screenshot) {
      finalScreenshot = result.screenshot;
    }

    const stepBlocking = Array.isArray(result && result.blockingErrors) ? result.blockingErrors : [];
    if (!result || result.status !== "completed" || result.allPass === false || stepBlocking.length > 0) {
      blockingErrors.push({
        code: "batchStepFailed",
        message: "Hierarchy batch stopped because a step did not complete cleanly.",
        details: {
          index,
          name: String(step.name || step.id || ""),
          type: stepType,
          status: result ? result.status : "missing-result",
          allPass: result ? result.allPass : false,
          blockingErrors: stepBlocking
        }
      });
      break;
    }
    completedSteps += 1;
  }

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId,
    rootName,
    screenshot: finalScreenshot,
    blockingErrors,
    warnings,
    summary: {
      totalSteps: rawSteps.length,
      completedSteps,
      durationMs: Date.now() - startedAt,
      stepSummaries
    },
    checks: {
      allStepsCompleted: {
        pass: blockingErrors.length === 0,
        completedSteps,
        expectedSteps: rawSteps.length
      },
      finalScreenshotExported: {
        pass: !!finalScreenshot || rawSteps.every((step) => normalizeHierarchyBatchStepType(step && (step.type || step.kind)) !== "screenshot")
      }
    },
    artifacts: {
      refs,
      steps: stepSummaries,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString()
    },
    errors
  };
}

function normalizeHierarchyBatchStepType(value) {
  const text = String(value || "").trim();
  if (["cleanupApply", "cleanup", "apply", "FIGMA_HIERARCHY_CLEANUP_APPLY"].includes(text)) {
    return "cleanupApply";
  }
  if (["wrapChain", "wrap", "FIGMA_HIERARCHY_WRAP_CHAIN"].includes(text)) {
    return "wrapChain";
  }
  if (["reorderChildren", "reorder", "FIGMA_HIERARCHY_REORDER_CHILDREN"].includes(text)) {
    return "reorderChildren";
  }
  if (["screenshot", "exportScreenshot", "FIGMA_EXPORT_NODE_SCREENSHOT"].includes(text)) {
    return "screenshot";
  }
  return "";
}

function buildHierarchyBatchStepJob(step, refs, batchOptions) {
  const stepJob = {};
  const target = step.target || {};
  stepJob.target = resolveHierarchyBatchTarget(target, refs);
  if (step.plan) {
    stepJob.plan = Object.assign({}, step.plan);
    const planTarget = stepJob.plan && typeof stepJob.plan.target === "object" && stepJob.plan.target
      ? Object.assign({}, stepJob.plan.target)
      : {};
    if (!String(planTarget.nodeId || "").trim() && stepJob.target && stepJob.target.nodeId) {
      planTarget.nodeId = stepJob.target.nodeId;
    }
    stepJob.plan.target = planTarget;
  }
  if (step.wrapperChain) {
    stepJob.wrapperChain = step.wrapperChain;
  }
  const stepOptions = Object.assign({}, step.options || {});
  if (normalizeHierarchyBatchStepType(step.type || step.kind) !== "screenshot" && batchOptions.includeIntermediateScreenshots !== true) {
    stepOptions.includeScreenshot = false;
  }
  stepJob.options = stepOptions;
  return stepJob;
}

function resolveHierarchyBatchTarget(target, refs) {
  const nodeId = String(target.nodeId || "");
  if (nodeId) {
    return { nodeId };
  }
  const refName = String(target.ref || target.nodeRef || target.targetRef || "");
  if (refName && refs[refName]) {
    return { nodeId: refs[refName] };
  }
  throw new Error(`Hierarchy batch target could not be resolved: ${refName || "missing nodeId/ref"}`);
}

function registerHierarchyBatchRefs(refs, step, result) {
  if (!result) {
    return;
  }
  const rootId = String(result.rootNodeId || "");
  const rootName = String(result.rootName || "");
  if (rootId && rootName) {
    refs[rootName] = rootId;
  }
  if (step.saveRootAs && rootId) {
    refs[String(step.saveRootAs)] = rootId;
  }
  const artifacts = result.artifacts || {};
  const createdGroups = Array.isArray(artifacts.createdGroups) ? artifacts.createdGroups : [];
  for (const group of createdGroups) {
    if (!group || !group.id || !group.name) {
      continue;
    }
    refs[String(group.name)] = String(group.id);
  }
  const deepestGroupId = String(artifacts.deepestGroupId || (result.summary && result.summary.deepestGroupId) || "");
  const deepestGroupName = String(artifacts.deepestGroupName || (result.summary && result.summary.deepestGroupName) || "");
  if (deepestGroupId && deepestGroupName) {
    refs[deepestGroupName] = deepestGroupId;
  }
  if (step.saveDeepestAs && deepestGroupId) {
    refs[String(step.saveDeepestAs)] = deepestGroupId;
  }
  if (step.id && rootId) {
    refs[String(step.id)] = rootId;
  }
}

function compactHierarchyBatchStepResult(index, step, stepType, result, durationMs) {
  const artifacts = result && result.artifacts ? result.artifacts : {};
  return {
    index,
    id: String(step.id || ""),
    name: String(step.name || ""),
    type: stepType,
    status: result ? result.status : "missing-result",
    allPass: !!(result && result.allPass),
    rootNodeId: result ? String(result.rootNodeId || "") : "",
    rootName: result ? String(result.rootName || "") : "",
    durationMs,
    summary: result && result.summary ? result.summary : {},
    checks: result && result.checks ? result.checks : {},
    createdGroups: Array.isArray(artifacts.createdGroups) ? artifacts.createdGroups : [],
    deepestGroupId: String(artifacts.deepestGroupId || ""),
    deepestGroupName: String(artifacts.deepestGroupName || ""),
    screenshot: result && result.screenshot ? result.screenshot : null,
    blockingErrors: Array.isArray(result && result.blockingErrors) ? result.blockingErrors : [],
    warningCount: Array.isArray(result && result.warnings) ? result.warnings.length : 0,
    errorCount: Array.isArray(result && result.errors) ? result.errors.length : 0
  };
}

async function reorderFigmaHierarchyChildrenJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || (plan.target && plan.target.nodeId) || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_REORDER_CHILDREN missing target.nodeId");
  }
  if (!Array.isArray(plan.childNodeIds) || plan.childNodeIds.length === 0) {
    throw new Error("FIGMA_HIERARCHY_REORDER_CHILDREN missing plan.childNodeIds");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const beforeBounds = getNodeBounds(root);
  const beforeChildren = collectHierarchyDirectChildren(root, beforeBounds, true);
  const beforeChildIds = beforeChildren.map((child) => child.id);
  const requestedIds = plan.childNodeIds.map((childId) => String(childId || ""));
  const validationErrors = validateHierarchyReorderPlan(requestedIds, beforeChildIds);
  if (validationErrors.length > 0) {
    return buildHierarchyReorderBlockedResult(root, beforeChildren, validationErrors);
  }

  const beforeBoundsById = {};
  for (const child of beforeChildren) {
    beforeBoundsById[child.id] = child.bounds;
  }

  const reorderedNodeIds = [];
  for (let index = 0; index < requestedIds.length; index++) {
    const child = await figma.getNodeByIdAsync(requestedIds[index]).catch(() => null);
    if (!child || child.parent !== root) {
      continue;
    }
    root.insertChild(index, child);
    reorderedNodeIds.push(child.id);
  }

  const afterBounds = getNodeBounds(root);
  const afterChildren = collectHierarchyDirectChildren(root, afterBounds, true);
  const driftNodes = collectHierarchyReorderBoundsDrift(afterChildren, beforeBoundsById, 0.01);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const afterIds = afterChildren.map((child) => child.id);
  const afterNames = afterChildren.map((child) => child.name);
  const expectedNames = requestedIds.map((childId) => {
    const beforeRecord = beforeChildren.find((child) => child.id === childId);
    return beforeRecord ? beforeRecord.name : "";
  });
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    childSetPreserved: {
      pass: afterIds.length === beforeChildIds.length && uniqueStrings(afterIds).length === beforeChildIds.length && requestedIds.join("|") === afterIds.join("|"),
      before: beforeChildIds,
      expected: requestedIds,
      after: afterIds
    },
    orderMatchesPlan: {
      pass: requestedIds.join("|") === afterIds.join("|"),
      expectedNames,
      actualNames: afterNames
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren,
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      afterDirectChildCount: afterChildren.length,
      reorderedChildren: reorderedNodeIds.length,
      order: afterNames
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildIds
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterIds
      },
      plan,
      mutatedNodeIds: reorderedNodeIds
    },
    errors: []
