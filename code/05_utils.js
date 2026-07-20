};
}

/** 创建 ComponentSet，并把目标容器中的重复子节点替换为对应变体实例。 */
async function createComponentSetVariantsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  if (isComponentSetSelectionSource(job, plan, target)) {
    return await createComponentSetVariantsFromSelectionJob(job, plan, target, options);
  }
  const nodeId = String(target.nodeId || (plan.target && plan.target.nodeId) || "");
  if (!nodeId) {
    throw new Error("FIGMA_CREATE_COMPONENT_SET_VARIANTS missing target.nodeId");
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
  const variants = normalizeComponentSetVariantPlans(plan.variants);
  const variantProperty = String(plan.variantProperty || "State").trim() || "State";
  const componentSetName = String(plan.componentSetName || "Item").trim() || "Item";
  const validationErrors = validateComponentSetVariantPlan(root, beforeChildren, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildComponentSetVariantsBlockedResult(root, beforeChildren, validationErrors);
  }

  // 检测变体来源节点是否在备份帧内（坐标污染风险）
  const csWarnings = [];
  for (const variant of variants) {
    const nodeId = String(variant.nodeId || "");
    if (!nodeId) continue;
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (node && node.parent && isBackupFrame(node.parent)) {
      csWarnings.push({
        code: "variantSourceInBackupFrame",
        message: `变体来源节点 "${variant.value || node.name}" (${nodeId}) 当前在备份帧 "${node.parent.name}" 中。ComponentSet 创建后 INSTANCE 内部子节点坐标可能偏移。建议先 restore 或 clone-node。`,
        details: { variantValue: variant.value, nodeId, parentName: node.parent.name }
      });
    }
  }

  const beforeNodeData = await collectComponentSetSourceNodeData(root, beforeChildren);
  const libraryFrame = createComponentSetLibraryFrame(root, componentSetName, beforeBounds, variants.length);
  const variantComponents = await createVariantComponentsInLibrary(libraryFrame, variants, beforeNodeData, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "componentSetVariants",
    sourceRootNodeId: root.id,
    variantProperty
  });

  const backupFrame = plan.createBackup === false
    ? null
    : createComponentSetBackupFrame(root, componentSetName, beforeBounds, libraryFrame);
  const variantComponentByValue = collectVariantComponentsByValue(componentSet, variantProperty);
  const replacement = plan.replaceOriginalsWithInstances === false
    ? { instances: [], movedSourceNodeIds: [] }
    : await replaceComponentSetSourcesWithInstances(root, beforeChildren, variants, beforeNodeData, variantComponentByValue, backupFrame, variantProperty);

  const afterBounds = getNodeBounds(root);
  const afterChildren = collectHierarchyDirectChildren(root, afterBounds, true);
  const driftNodes = collectComponentSetInstanceBoundsDrift(replacement.instances, beforeNodeData, 0.01);
  const variantNineSliceReports = buildVariantNineSliceReports(variants, beforeNodeData, variantComponentByValue, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === variants.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: variants.length
    },
    contentChildCountPreserved: {
      pass: afterChildren.length === beforeChildren.length,
      before: beforeChildren.length,
      after: afterChildren.length
    },
    contentChildrenAreInstances: {
      pass: afterChildren.every((child) => child.type === "INSTANCE"),
      actualTypes: afterChildren.map((child) => child.type)
    },
    contentOrderPreserved: {
      pass: afterChildren.map((child) => child.name).join("|") === beforeChildren.map((child) => child.name).join("|"),
      before: beforeChildren.map((child) => child.name),
      after: afterChildren.map((child) => child.name)
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    sourceNodesBackedUp: {
      pass: !!backupFrame && replacement.movedSourceNodeIds.length === beforeChildren.length,
      backupFrameId: backupFrame ? backupFrame.id : "",
      movedSourceNodeIds: replacement.movedSourceNodeIds,
      expectedCount: beforeChildren.length
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren,
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: csWarnings,
    summary: {
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      replacedInstanceCount: replacement.instances.length,
      backupFrameId: backupFrame ? backupFrame.id : ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildren.map((child) => child.id)
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterChildren.map((child) => child.id)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id,
      backupFrameId: backupFrame ? backupFrame.id : "",
      instanceMappings: replacement.instances
    },
    errors: []
  };
}

/** 判断 ComponentSet 创建任务是否来自用户当前手动选择。 */
function isComponentSetSelectionSource(job, plan, target) {
  const source = String((job && job.source) || (plan && plan.source) || (target && target.source) || "").trim();
  return source === "selection" || source === "current-selection" || source === "currentSelection";
}

/** 基于用户当前选择创建 ComponentSet，不依赖 Content 直接子节点完整覆盖规则。 */
async function createComponentSetVariantsFromSelectionJob(job, plan, target, options) {
  const selection = figma.currentPage.selection.slice();
  const variantProperty = String(plan.variantProperty || "State").trim() || "State";
  const componentSetName = String(plan.componentSetName || target.componentSetName || "ManualSelectionSet").trim() || "ManualSelectionSet";
  const variants = normalizeSelectionComponentSetVariantPlans(selection, plan.variants, variantProperty);
  const validationErrors = validateSelectionComponentSetVariantPlan(selection, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildSelectionComponentSetBlockedResult(selection, validationErrors);
  }

  const selectionRecords = collectSelectionComponentSetRecords(selection);
  const sourceNodeData = await collectManualComponentSetSourceNodeData(selectionRecords);
  const selectionBounds = unionBounds(selectionRecords.map((item) => item.bounds));
  const libraryFrame = createManualComponentSetLibraryFrame(selection[0], componentSetName, selectionBounds, selectionRecords.length);
  const variantComponents = await createVariantComponentsInLibrary(libraryFrame, variants, sourceNodeData, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "manualSelectionComponentSet",
    source: "selection",
    variantProperty
  });

  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(componentSet) : null;
  const variantNineSliceReports = buildVariantNineSliceReports(variants, sourceNodeData, collectVariantComponentsByValue(componentSet, variantProperty), variantProperty);
  const preservedSourceNodeIds = await collectExistingNodeIds(selectionRecords.map((record) => record.id));
  const checks = {
    selectionCountMatches: {
      pass: selectionRecords.length === variants.length,
      selectionCount: selectionRecords.length,
      variantPlanCount: variants.length
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === variants.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: variants.length
    },
    sourceNodesPreserved: {
      pass: preservedSourceNodeIds.length === selectionRecords.length,
      sourceNodeIds: selectionRecords.map((record) => record.id)
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  await setCurrentPageForNode(componentSet);
  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: componentSet.id,
    rootName: componentSet.name || "",
    nodeType: componentSet.type,
    rootBounds: boundsToManifest(getNodeBounds(componentSet)),
    beforeChildren: selectionRecords,
    afterChildren: collectHierarchyDirectChildren(componentSet, getNodeBounds(componentSet), true),
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selection",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      selectedNodeCount: selectionRecords.length,
      replacedInstanceCount: 0,
      backupFrameId: ""
    },
    checks,
    artifacts: {
      before: {
        selectedNodeIds: selectionRecords.map((record) => record.id),
        selectedNodeNames: selectionRecords.map((record) => record.name)
      },
      after: {
        componentSetId: componentSet.id,
        variantComponentIds: componentSet.children.map((child) => child.id)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id
    },
    errors: []
  };
}

/** 规范化 ComponentSet 变体计划，确保后续逻辑只处理字符串字段。 */
function normalizeComponentSetVariantPlans(rawVariants) {
  const output = [];
  for (const item of rawVariants || []) {
    if (!item) {
      continue;
    }
    const properties = {};
    if (item.properties && typeof item.properties === "object") {
      for (const key of Object.keys(item.properties)) {
        const normalizedKey = String(key || "").trim();
        const normalizedValue = String(item.properties[key] || "").trim();
        if (normalizedKey && normalizedValue) {
          properties[normalizedKey] = normalizedValue;
        }
      }
    }
    const fallbackValue = String(item.value || item.state || item.name || "").trim();
    output.push({
      nodeId: String(item.nodeId || "").trim(),
      value: fallbackValue,
      properties
    });
  }
  return output;
}

/** 根据当前选择和用户传入计划生成变体计划；未指定时按选择顺序生成 Variant1。 */
function normalizeSelectionComponentSetVariantPlans(selection, rawVariants, variantProperty) {
  const planned = normalizeComponentSetVariantPlans(rawVariants);
  const output = [];
  for (let index = 0; index < selection.length; index++) {
    const node = selection[index];
    const plan = planned[index] || {};
    const properties = plan.properties && Object.keys(plan.properties).length > 0
      ? plan.properties
      : {};
    output.push({
      nodeId: String(plan.nodeId || node.id || "").trim(),
      value: String(plan.value || `Variant${index + 1}`).trim(),
      properties
    });
  }
  return output;
}

/** 校验变体计划必须完整覆盖目标容器当前直接子节点。 */
function validateComponentSetVariantPlan(root, beforeChildren, variants, variantProperty) {
  const errors = [];
  if (isHierarchyAutoLayoutNode(root)) {
    errors.push({
      code: "rootAutoLayoutUnsupported",
      message: "目标 Content 启用了 Auto Layout，替换实例可能改变布局，已阻止写入。",
      details: { layoutMode: root.layoutMode }
    });
  }
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    errors.push({ code: "missingVariants", message: "缺少 ComponentSet 变体计划。", details: {} });
    return errors;
  }
  const beforeIds = beforeChildren.map((child) => child.id);
  const variantIds = variants.map((item) => item.nodeId);
  const propertySignatures = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicateIds = uniqueStrings(variantIds.filter((id, index) => variantIds.indexOf(id) !== index));
  const duplicateValues = uniqueStrings(propertySignatures.filter((value, index, array) => array.indexOf(value) !== index));
  const missing = beforeIds.filter((id) => variantIds.indexOf(id) < 0);
  const extra = variantIds.filter((id) => beforeIds.indexOf(id) < 0);
  const emptyValues = variants.filter((item) => !buildVariantPropertySignature(item, variantProperty)).map((item) => item.nodeId);
  const unsupportedTypes = beforeChildren.filter((child) => variantIds.indexOf(child.id) >= 0 && child.type !== "FRAME");
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateVariantNodeIds", message: "变体计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "变体计划中存在重复变体属性组合。", details: { values: duplicateValues } });
  }
  if (missing.length > 0 || extra.length > 0 || variants.length !== beforeChildren.length) {
    errors.push({
      code: "variantNodeSetMismatch",
      message: "变体计划必须完整覆盖 Content 当前直接子节点。",
      details: { missing, extra, expectedCount: beforeChildren.length, actualCount: variants.length }
    });
  }
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "变体属性值不能为空。", details: { nodeIds: emptyValues } });
  }
  if (unsupportedTypes.length > 0) {
    errors.push({
      code: "unsupportedVariantSourceType",
      message: "当前只允许把 FRAME 任务项抽象为 ComponentSet 变体。",
      details: unsupportedTypes.map((child) => ({ id: child.id, name: child.name, type: child.type }))
    });
  }
  return errors;
}

/** 校验手动选择创建 ComponentSet 的输入，避免选择为空或变体重复。 */
function validateSelectionComponentSetVariantPlan(selection, variants, variantProperty) {
  const errors = [];
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(selection) || selection.length < 2) {
    errors.push({ code: "selectionTooSmall", message: "至少需要选中 2 个节点才能创建 ComponentSet。", details: { selectionCount: selection ? selection.length : 0 } });
    return errors;
  }
  if (!Array.isArray(variants) || variants.length !== selection.length) {
    errors.push({ code: "variantSelectionCountMismatch", message: "变体计划数量必须等于当前选择节点数量。", details: { selectionCount: selection.length, variantCount: variants ? variants.length : 0 } });
  }
  const unsupportedTypes = [];
  for (const node of selection) {
    if (!isManualComponentSetSourceNode(node)) {
      unsupportedTypes.push({ id: node.id, name: node.name || "", type: node.type });
    }
  }
  if (unsupportedTypes.length > 0) {
    errors.push({ code: "unsupportedSelectionSourceType", message: "当前选择中存在不能直接转 Component 的节点。", details: unsupportedTypes });
  }
  const variantIds = variants.map((item) => item.nodeId);
  const propertySignatures = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicateIds = uniqueStrings(variantIds.filter((id, index) => variantIds.indexOf(id) !== index));
  const duplicateValues = uniqueStrings(propertySignatures.filter((value, index, array) => array.indexOf(value) !== index));
  const emptyValues = variants.filter((item) => !buildVariantPropertySignature(item, variantProperty)).map((item) => item.nodeId);
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateVariantNodeIds", message: "变体计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "变体计划中存在重复变体属性组合。", details: { values: duplicateValues } });
  }
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "变体属性值不能为空。", details: { nodeIds: emptyValues } });
  }
  return errors;
}

/** 判断节点是否适合作为手动 ComponentSet 的源节点。 */
function isManualComponentSetSourceNode(node) {
  return !!node && "clone" in node && "width" in node && "height" in node;
}

/** 创建 ComponentSet 阻塞结果，避免计划不合法时产生部分写入。 */
function buildComponentSetVariantsBlockedResult(root, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root.id,
    rootName: root.name || "",
    directChildren: beforeChildren,
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 创建手动选择 ComponentSet 的阻塞结果，不产生任何 Figma 写入。 */
function buildSelectionComponentSetBlockedResult(selection, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: "",
    rootName: "",
    directChildren: collectSelectionComponentSetRecords(selection || []),
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selection",
      selectedNodeCount: selection ? selection.length : 0,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 收集源节点几何、约束和九宫数量，供替换实例后校验视觉不漂移。 */
async function collectComponentSetSourceNodeData(root, beforeChildren) {
  const data = {};
  for (const record of beforeChildren) {
    const node = await figma.getNodeByIdAsync(record.id).catch(() => null);
    if (!node || node.parent !== root) {
      continue;
    }
    data[record.id] = {
      node,
      name: node.name || "",
      type: node.type,
      x: numericOr(node.x, 0),
      y: numericOr(node.y, 0),
      width: positiveOr(node.width, 1),
      height: positiveOr(node.height, 1),
      bounds: record.bounds,
      constraints: "constraints" in node ? cloneObject(node.constraints) : null,
      nineSliceCount: countHierarchyNineSliceLikeNodes(node)
    };
  }
  return data;
}

/** 收集手动选择节点的轻量记录，用于回显和验证源节点未丢失。 */
function collectSelectionComponentSetRecords(selection) {
  const records = [];
  for (let index = 0; index < selection.length; index++) {
    const node = selection[index];
    const bounds = getNodeBounds(node);
    records.push({
      id: node.id,
      parentId: node.parent ? node.parent.id : "",
      index,
      name: node.name || "",
      type: node.type,
      path: node.name || "",
      visible: "visible" in node ? node.visible !== false : true,
      opacity: "opacity" in node ? numericOr(node.opacity, 1) : 1,
      bounds: boundsToManifest(bounds),
      relativeBounds: boundsToManifest({ x: 0, y: 0, width: bounds.width, height: bounds.height }),
      childCount: "children" in node ? node.children.length : 0,
      isNineSliceLike: isHierarchyNineSliceLike(node)
    });
  }
  return records;
}

/** 收集手动选择源节点的几何和九宫数量，供创建变体验证使用。 */
async function collectManualComponentSetSourceNodeData(selectionRecords) {
  const data = {};
  for (const record of selectionRecords) {
    const node = await figma.getNodeByIdAsync(record.id).catch(() => null);
    if (!node) {
      continue;
    }
    data[record.id] = {
      node,
      name: node.name || "",
      type: node.type,
      x: numericOr(node.x, 0),
      y: numericOr(node.y, 0),
      width: positiveOr(node.width, 1),
      height: positiveOr(node.height, 1),
      bounds: record.bounds,
      constraints: "constraints" in node ? cloneObject(node.constraints) : null,
      nineSliceCount: countHierarchyNineSliceLikeNodes(node)
    };
  }
  return data;
}

/** 合并多个 bounds，作为手动选择组件库摆放参考。 */
function unionBounds(boundsList) {
  const valid = (boundsList || []).filter((item) => item && positiveOr(item.width, 0) > 0 && positiveOr(item.height, 0) > 0);
  if (valid.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  let left = valid[0].x;
  let top = valid[0].y;
  let right = valid[0].x + valid[0].width;
  let bottom = valid[0].y + valid[0].height;
  for (const bounds of valid.slice(1)) {
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 使用 async API 检查节点是否仍存在，兼容 dynamic-page。 */
async function collectExistingNodeIds(nodeIds) {
  const existing = [];
  for (const nodeId of nodeIds || []) {
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (node) {
      existing.push(nodeId);
    }
  }
  return existing;
}

/** 在当前页面创建组件库容器，放在目标 Content 右侧，避免影响原 UI 截图。 */
function createComponentSetLibraryFrame(root, componentSetName, rootBounds, variantCount) {
  const page = findContainingPage(root) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentLibrary_${componentSetName}]`);
  frame.x = rootBounds.x + rootBounds.width + 160;
  frame.y = rootBounds.y;
  frame.resize(Math.max(rootBounds.width + 80, 1), Math.max(variantCount * (rootBounds.height + 40), rootBounds.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);
  return frame;
}

/** 在手动选择区域右侧创建组件库容器，不移动用户选中的源节点。 */
function createManualComponentSetLibraryFrame(anchorNode, componentSetName, selectionBounds, variantCount) {
  const page = findContainingPage(anchorNode) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentLibrary_${componentSetName}]`);
  frame.x = numericOr(selectionBounds.x, 0) + positiveOr(selectionBounds.width, 1) + 160;
  frame.y = numericOr(selectionBounds.y, 0);
  frame.resize(Math.max(positiveOr(selectionBounds.width, 1) + 80, 1), Math.max(variantCount * (positiveOr(selectionBounds.height, 1) + 40), positiveOr(selectionBounds.height, 1), 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);
  return frame;
}

/** 基于显式节点组创建 ComponentSet，并将每组散节点替换成一个变体实例。 */
async function createComponentSetFromNodeGroupsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const rootId = String(target.nodeId || (plan.target && plan.target.nodeId) || "").trim();
  if (!rootId) {
    throw new Error("FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS missing target.nodeId");
  }
  const root = await figma.getNodeByIdAsync(rootId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${rootId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const beforeBounds = getNodeBounds(root);
  const componentSetName = String(plan.componentSetName || "ManualSelectionComponentSet").trim() || "ManualSelectionComponentSet";
  const variantProperty = String(plan.variantProperty || "Value").trim() || "Value";
  const groups = await collectNodeGroupSources(plan.groups || []);
  const validationErrors = validateComponentSetNodeGroupPlan(root, groups, variantProperty);
  if (validationErrors.length > 0) {
    return buildComponentSetNodeGroupBlockedResult(root, groups, validationErrors);
  }

  const libraryFrame = createComponentSetLibraryFrame(root, componentSetName, beforeBounds, groups.length);
  const variants = groups.map((group) => ({
    nodeId: group.id,
    value: group.value,
    properties: group.properties
  }));
  const variantComponents = await createVariantComponentsFromNodeGroups(libraryFrame, groups, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "componentSetFromNodeGroups",
    sourceRootNodeId: root.id,
    variantProperty
  });

  const backupFrame = plan.createBackup === false
    ? null
    : createComponentSetBackupFrame(root, componentSetName, beforeBounds, libraryFrame);
  const variantComponentByValue = collectVariantComponentsByValue(componentSet, variantProperty);
  const replacement = plan.replaceOriginalsWithInstances === false
    ? { instances: [], movedSourceNodeIds: [] }
    : await replaceNodeGroupsWithInstances(root, groups, variantComponentByValue, backupFrame, variantProperty);

  const afterBounds = getNodeBounds(root);
  const afterChildren = collectHierarchyDirectChildren(root, afterBounds, true);
  const driftNodes = collectNodeGroupInstanceBoundsDrift(replacement.instances, groups, 0.01);
  const variantNineSliceReports = buildNodeGroupVariantNineSliceReports(groups, variantComponentByValue, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === groups.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: groups.length
    },
    groupsReplacedWithInstances: {
      pass: replacement.instances.length === groups.length,
      replacedInstanceCount: replacement.instances.length,
      expectedCount: groups.length
    },
    sourceNodesBackedUp: {
      pass: !!backupFrame && replacement.movedSourceNodeIds.length === flattenNodeGroupIds(groups).length,
      backupFrameId: backupFrame ? backupFrame.id : "",
      movedSourceNodeIds: replacement.movedSourceNodeIds,
      expectedCount: flattenNodeGroupIds(groups).length
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren: groups.map((group) => serializeNodeGroupRecord(group)),
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "node-groups",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      replacedInstanceCount: replacement.instances.length,
      backupFrameId: backupFrame ? backupFrame.id : ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        groups: groups.map((group) => serializeNodeGroupRecord(group))
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterChildren.map((child) => child.id),
        directChildNames: afterChildren.map((child) => child.name)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id,
      backupFrameId: backupFrame ? backupFrame.id : "",
      instanceMappings: replacement.instances
    },
    errors: []
  };
}

/** 收集计划中的跨父级节点组，并记录每组节点的绝对边界。 */
async function collectNodeGroupSources(rawGroups) {
  const groups = [];
  for (let index = 0; index < (rawGroups || []).length; index++) {
    const raw = rawGroups[index] || {};
    const nodeIds = Array.isArray(raw.nodeIds) ? raw.nodeIds.map((id) => String(id || "").trim()).filter((id) => !!id) : [];
    const nodes = [];
    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
      if (node) {
        nodes.push(node);
      }
    }
    const records = nodes.map((node, nodeIndex) => buildNodeGroupChildRecord(node, nodeIndex));
    const bounds = unionBounds(records.map((record) => record.bounds));
    const value = String(raw.value || raw.name || `Variant${index + 1}`).trim();
    const properties = {};
    if (raw.properties && typeof raw.properties === "object") {
      for (const key of Object.keys(raw.properties)) {
        const normalizedKey = String(key || "").trim();
        const normalizedValue = String(raw.properties[key] || "").trim();
        if (normalizedKey && normalizedValue) {
          properties[normalizedKey] = normalizedValue;
        }
      }
    }
    groups.push({
      id: `nodeGroup:${index + 1}`,
      name: String(raw.name || `[Milestone_${index + 1}_${value}]`).trim(),
      value,
      properties,
      nodeIds,
      nodes,
      records,
      bounds
    });
  }
  return groups;
}

/** 构建节点组成员记录，保留父级、索引和绝对边界用于校验。 */
function buildNodeGroupChildRecord(node, index) {
  const bounds = getNodeBounds(node);
  return {
    id: node.id,
    parentId: node.parent ? node.parent.id : "",
    index,
    name: node.name || "",
    type: node.type,
    visible: "visible" in node ? node.visible !== false : true,
    opacity: "opacity" in node ? numericOr(node.opacity, 1) : 1,
    bounds: boundsToManifest(bounds),
    width: positiveOr(node.width, bounds.width),
    height: positiveOr(node.height, bounds.height),
    childCount: "children" in node ? node.children.length : 0,
    isNineSliceLike: isHierarchyNineSliceLike(node),
    nineSliceCount: countHierarchyNineSliceLikeNodes(node)
  };
}

/** 校验跨父级节点组计划，避免节点缺失、重复或变体属性冲突。 */
function validateComponentSetNodeGroupPlan(root, groups, variantProperty) {
  const errors = [];
  if (isHierarchyAutoLayoutNode(root)) {
    errors.push({
      code: "rootAutoLayoutUnsupported",
      message: "目标容器启用了 Auto Layout，替换实例可能改变布局，已阻止写入。",
      details: { rootId: root.id, layoutMode: root.layoutMode }
    });
  }
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(groups) || groups.length < 2) {
    errors.push({ code: "nodeGroupTooSmall", message: "至少需要 2 组节点才能创建 ComponentSet。", details: { groupCount: groups ? groups.length : 0 } });
    return errors;
  }
  const allIds = flattenNodeGroupIds(groups);
  const duplicateIds = uniqueStrings(allIds.filter((id, index) => allIds.indexOf(id) !== index));
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateNodeIds", message: "节点组计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  const missingGroups = groups.filter((group) => group.nodeIds.length === 0 || group.nodes.length !== group.nodeIds.length);
  if (missingGroups.length > 0) {
    errors.push({
      code: "nodeGroupMissingNodes",
      message: "节点组计划中存在找不到的节点。",
      details: missingGroups.map((group) => ({ name: group.name, expected: group.nodeIds, actual: group.nodes.map((node) => node.id) }))
    });
  }
  const unsupportedGroups = groups.filter((group) => group.nodes.some((node) => !isManualComponentSetSourceNode(node)));
  if (unsupportedGroups.length > 0) {
    errors.push({
      code: "unsupportedNodeGroupSourceType",
      message: "节点组中存在不能克隆为组件的节点。",
      details: unsupportedGroups.map((group) => ({ name: group.name, nodeIds: group.nodeIds }))
    });
  }
  const signatures = groups.map((group) => buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty));
  const duplicateValues = uniqueStrings(signatures.filter((value, index, array) => array.indexOf(value) !== index));
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "节点组变体属性组合重复。", details: { values: duplicateValues } });
  }
  const emptyValues = groups.filter((group, index) => !signatures[index]).map((group) => group.name);
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "节点组变体属性值不能为空。", details: { groups: emptyValues } });
  }
  return errors;
}

/** 创建节点组计划阻塞结果，不产生部分写入。 */
function buildComponentSetNodeGroupBlockedResult(root, groups, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root ? root.id : "",
    rootName: root ? root.name || "" : "",
    nodeType: root ? root.type : "",
    directChildren: (groups || []).map((group) => serializeNodeGroupRecord(group)),
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "node-groups",
      groupCount: groups ? groups.length : 0,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 将节点组克隆为 Frame 后转 Component，供 combineAsVariants 合并。 */
async function createVariantComponentsFromNodeGroups(libraryFrame, groups, variantProperty) {
  const components = [];
  const gap = 40;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const frame = createFrameFromNodeGroupClones(group, buildVariantComponentName({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty));
    libraryFrame.appendChild(frame);
    frame.x = 0;
    frame.y = index * (positiveOr(group.bounds.height, 1) + gap);
    safeResizeNode(frame, group.bounds.width, group.bounds.height);
    const component = figma.createComponentFromNode(frame);
    component.name = buildVariantComponentName({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty);
    component.x = 0;
    component.y = index * (positiveOr(group.bounds.height, 1) + gap);
    safeResizeNode(component, group.bounds.width, group.bounds.height);
    writePluginData(component, {
      generatedBy: "componentSetNodeGroupVariant",
      sourceNodeIds: group.nodeIds.join(","),
      variantProperty,
      variantValue: buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty)
    });
    components.push(component);
  }
  return components;
}

/** 克隆节点组为 Frame，保持组内各节点的相对位置。 */
function createFrameFromNodeGroupClones(group, frameName) {
  const frame = figma.createFrame();
  frame.name = `[VariantSource_${frameName}]`;
  frame.resize(Math.max(positiveOr(group.bounds.width, 1), 1), Math.max(positiveOr(group.bounds.height, 1), 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  for (const node of group.nodes) {
    const clone = node.clone();
    const bounds = getNodeBounds(node);
    frame.appendChild(clone);
    clone.x = numericOr(bounds.x, 0) - numericOr(group.bounds.x, 0);
    clone.y = numericOr(bounds.y, 0) - numericOr(group.bounds.y, 0);
    if ("constraints" in clone) {
      clone.constraints = { horizontal: "MIN", vertical: "MIN" };
    }
  }
  return frame;
}

/** 用变体实例替换跨父级散节点组，并将源节点移入隐藏备份。 */
async function replaceNodeGroupsWithInstances(root, groups, variantComponentByValue, backupFrame, variantProperty) {
  const instances = [];
  const movedSourceNodeIds = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const variantKey = buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty);
    const variantComponent = variantComponentByValue[variantKey];
    if (!variantComponent) {
      continue;
    }
    const instance = variantComponent.createInstance();
    root.appendChild(instance);
    instance.name = group.name;
    safeResizeNode(instance, group.bounds.width, group.bounds.height);
    instance.x = numericOr(group.bounds.x, 0) - numericOr(getNodeBounds(root).x, 0);
    instance.y = numericOr(group.bounds.y, 0) - numericOr(getNodeBounds(root).y, 0);
    instances.push({
      groupId: group.id,
      groupName: group.name,
      instanceId: instance.id,
      instanceName: instance.name,
      variantValue: variantKey,
      beforeBounds: boundsToManifest(group.bounds),
      afterBounds: boundsToManifest(getNodeBounds(instance))
    });
    for (let nodeIndex = 0; nodeIndex < group.nodes.length; nodeIndex++) {
      const node = group.nodes[nodeIndex];
      if (!node) {
        continue;
      }
      if (backupFrame) {
        backupFrame.appendChild(node);
        node.x = nodeIndex * (positiveOr(group.bounds.width, 1) + 20);
        node.y = index * (positiveOr(group.bounds.height, 1) + 20);
      } else {
        node.remove();
      }
      movedSourceNodeIds.push(node.id);
    }
  }
  return { instances, movedSourceNodeIds };
}

/** 检查节点组替换后的实例绝对边界是否保持。 */
function collectNodeGroupInstanceBoundsDrift(instances, groups, tolerance) {
  const groupById = {};
  for (const group of groups || []) {
    groupById[group.id] = group;
  }
  const driftNodes = [];
  for (const item of instances || []) {
    const group = groupById[item.groupId];
    if (!group) {
      continue;
    }
    const before = boundsToManifest(group.bounds);
    const after = item.afterBounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        groupId: item.groupId,
        name: item.groupName,
        instanceId: item.instanceId,
        variantValue: item.variantValue,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 校验节点组变体中的九宫节点数量不减少。 */
function buildNodeGroupVariantNineSliceReports(groups, variantComponentByValue, variantProperty) {
  const reports = [];
  for (const group of groups || []) {
    const variantKey = buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty);
    const component = variantComponentByValue[variantKey];
    const beforeCount = group.records.reduce((sum, record) => sum + numericOr(record.nineSliceCount, 0), 0);
    const afterCount = component ? countHierarchyNineSliceLikeNodes(component) : 0;
    reports.push({
      groupId: group.id,
      groupName: group.name,
      variantValue: variantKey,
      beforeCount,
      afterCount,
      pass: afterCount >= beforeCount
    });
  }
  return reports;
}

/** 生成节点组的变体属性，未显式传入时使用主变体属性。 */
function normalizeNodeGroupProperties(group, variantProperty) {
  const properties = {};
  const raw = group && group.properties ? group.properties : {};
  for (const key of Object.keys(raw)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(raw[key] || "").trim();
    if (normalizedKey && normalizedValue) {
      properties[normalizedKey] = normalizedValue;
    }
  }
  if (Object.keys(properties).length === 0 && group && group.value) {
    properties[variantProperty] = String(group.value);
  }
  return properties;
}

/** 展平所有节点组成员 id。 */
function flattenNodeGroupIds(groups) {
  const output = [];
  for (const group of groups || []) {
    for (const id of group.nodeIds || []) {
      output.push(id);
    }
  }
  return output;
}

/** 输出节点组轻量记录，供 JSON 验证和人工审查。 */
function serializeNodeGroupRecord(group) {
  return {
    id: group.id,
    name: group.name,
    value: group.value,
    properties: group.properties,
    nodeIds: group.nodeIds,
    bounds: boundsToManifest(group.bounds),
    children: group.records
  };
}

/** 基于当前选中节点的同父级同类节点重建 ComponentSet，并替换为对应变体实例。 */
async function rebuildComponentSetFromSiblingsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const selection = figma.currentPage.selection.slice();
  const variantProperty = String(plan.variantProperty || "State").trim() || "State";
  const componentSetName = String(plan.componentSetName || "Item").trim() || "Item";
  const selectedNode = selection.length === 1 ? selection[0] : null;
  const sourceParent = selectedNode && selectedNode.parent && "children" in selectedNode.parent ? selectedNode.parent : null;
  const beforeBounds = sourceParent ? getNodeBounds(sourceParent) : { x: 0, y: 0, width: 1, height: 1 };
  const siblingNodes = sourceParent ? selectSiblingVariantSourceNodes(sourceParent, selectedNode, plan) : [];
  const beforeChildren = collectSelectionComponentSetRecords(siblingNodes);
  const variants = buildSiblingComponentSetVariants(beforeChildren, plan, variantProperty);
  const validationErrors = validateRebuildSiblingComponentSetPlan(selection, selectedNode, sourceParent, beforeChildren, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildRebuildSiblingComponentSetBlockedResult(selectedNode, sourceParent, beforeChildren, validationErrors);
  }

  await setCurrentPageForNode(sourceParent);
  const beforeNodeData = await collectComponentSetSourceNodeData(sourceParent, beforeChildren);
  const libraryFrame = createComponentSetLibraryFrame(sourceParent, componentSetName, beforeBounds, variants.length);
  const variantComponents = await createVariantComponentsInLibrary(libraryFrame, variants, beforeNodeData, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "rebuildComponentSetFromSiblings",
    sourceRootNodeId: sourceParent.id,
    selectedNodeId: selectedNode.id,
    variantProperty
  });

  const backupFrame = plan.createBackup === false
    ? null
    : createComponentSetBackupFrame(sourceParent, componentSetName, beforeBounds, libraryFrame);
  const variantComponentByValue = collectVariantComponentsByValue(componentSet, variantProperty);
  const replacement = plan.replaceOriginalsWithInstances === false
    ? { instances: [], movedSourceNodeIds: [] }
    : await replaceComponentSetSourcesWithInstances(sourceParent, beforeChildren, variants, beforeNodeData, variantComponentByValue, backupFrame, variantProperty);

  const afterBounds = getNodeBounds(sourceParent);
  const afterChildren = collectHierarchyDirectChildren(sourceParent, afterBounds, true);
  const driftNodes = collectComponentSetInstanceBoundsDrift(replacement.instances, beforeNodeData, 0.01);
  const variantNineSliceReports = buildVariantNineSliceReports(variants, beforeNodeData, variantComponentByValue, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(sourceParent) : null;
  const checks = {
    parentSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === variants.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: variants.length
    },
    contentChildCountPreserved: {
      pass: afterChildren.length === beforeChildren.length,
      before: beforeChildren.length,
      after: afterChildren.length
    },
    contentChildrenAreInstances: {
      pass: afterChildren.every((child) => child.type === "INSTANCE"),
      actualTypes: afterChildren.map((child) => child.type)
    },
    contentOrderPreserved: {
      pass: afterChildren.map((child) => child.name).join("|") === beforeChildren.map((child) => child.name).join("|"),
      before: beforeChildren.map((child) => child.name),
      after: afterChildren.map((child) => child.name)
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    sourceNodesBackedUp: {
      pass: !!backupFrame && replacement.movedSourceNodeIds.length === beforeChildren.length,
      backupFrameId: backupFrame ? backupFrame.id : "",
      movedSourceNodeIds: replacement.movedSourceNodeIds,
      expectedCount: beforeChildren.length
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: sourceParent.id,
    rootName: sourceParent.name || "",
    nodeType: sourceParent.type,
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren,
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selected-siblings",
      selectedNodeId: selectedNode.id,
      selectedNodeName: selectedNode.name || "",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      replacedInstanceCount: replacement.instances.length,
      backupFrameId: backupFrame ? backupFrame.id : ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildren.map((child) => child.id),
        directChildNames: beforeChildren.map((child) => child.name)
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterChildren.map((child) => child.id),
        directChildNames: afterChildren.map((child) => child.name)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id,
      backupFrameId: backupFrame ? backupFrame.id : "",
      instanceMappings: replacement.instances
    },
    errors: []
  };
}

/** 选择当前节点同父级的变体来源节点，默认使用父级全部直接子节点。 */
function selectSiblingVariantSourceNodes(parent, selectedNode, plan) {
  const children = parent && "children" in parent ? parent.children.slice() : [];
  const explicitIds = plan && Array.isArray(plan.siblingNodeIds)
    ? plan.siblingNodeIds.map((id) => String(id || "").trim()).filter((id) => !!id)
    : [];
  if (explicitIds.length > 0) {
    const byId = {};
    for (const child of children) {
      byId[child.id] = child;
    }
    return explicitIds.map((id) => byId[id]).filter((node) => !!node);
  }
  const selectedSize = selectedNode ? { width: selectedNode.width, height: selectedNode.height } : null;
  return children.filter((child) => isSiblingVariantCandidate(child, selectedSize));
}

/** 判断同级节点是否适合作为本次重建的变体来源。 */
function isSiblingVariantCandidate(node, selectedSize) {
  if (!isManualComponentSetSourceNode(node)) {
    return false;
  }
  if (!selectedSize) {
    return true;
  }
  return Math.abs(positiveOr(node.width, 0) - positiveOr(selectedSize.width, 0)) <= 0.01 &&
    Math.abs(positiveOr(node.height, 0) - positiveOr(selectedSize.height, 0)) <= 0.01;
}

/** 根据同级节点名称推断变体属性，并保留节点顺序生成稳定计划。 */
function buildSiblingComponentSetVariants(beforeChildren, plan, variantProperty) {
  const planned = normalizeComponentSetVariantPlans(plan.variants);
  const plannedByNodeId = {};
  for (const item of planned) {
    if (item.nodeId) {
      plannedByNodeId[item.nodeId] = item;
    }
  }
  const output = [];
  for (let index = 0; index < beforeChildren.length; index++) {
    const record = beforeChildren[index];
    const explicit = plannedByNodeId[record.id] || planned[index] || {};
    const inferred = inferVariantValueFromSiblingName(record.name, index);
    const value = String(explicit.value || inferred.state || `Variant${index + 1}`).trim();
    const properties = explicit.properties && Object.keys(explicit.properties).length > 0
      ? explicit.properties
      : {};
    if (Object.keys(properties).length === 0) {
      properties[variantProperty] = value;
      if (inferred.index) {
        properties.Index = inferred.index;
      }
    }
    output.push({
      nodeId: record.id,
      value,
      properties
    });
  }
  return output;
}

/** 从类似 [Item_1_InProgress] 的节点名中推断序号和状态。 */
function inferVariantValueFromSiblingName(name, fallbackIndex) {
  const text = String(name || "");
  const match = text.match(/\[(?:[^\]_]+_)?(\d+)_([^\]]+)\]/);
  if (match) {
    return { index: match[1], state: match[2] };
  }
  const parts = text.replace(/^\[/, "").replace(/\]$/, "").split("_").filter((item) => !!item);
  if (parts.length >= 2) {
    const maybeIndex = parts.find((item) => /^\d+$/.test(item));
    const state = parts[parts.length - 1];
    return { index: maybeIndex || String(fallbackIndex + 1), state };
  }
  return { index: String(fallbackIndex + 1), state: `Variant${fallbackIndex + 1}` };
}

/** 校验同级重建计划，避免选区错误或同级集合不完整导致误替换。 */
function validateRebuildSiblingComponentSetPlan(selection, selectedNode, sourceParent, beforeChildren, variants, variantProperty) {
  const errors = [];
  if (!Array.isArray(selection) || selection.length !== 1) {
    errors.push({ code: "selectionCountInvalid", message: "同级重建 ComponentSet 需要且只需要选中 1 个模板节点。", details: { selectionCount: selection ? selection.length : 0 } });
  }
  if (!selectedNode) {
    errors.push({ code: "selectedNodeMissing", message: "未找到当前选中节点。", details: {} });
  }
  if (!sourceParent || !("children" in sourceParent)) {
    errors.push({ code: "parentMissing", message: "选中节点没有可处理的父级容器。", details: selectedNode ? { selectedNodeId: selectedNode.id } : {} });
  }
  if (sourceParent && isHierarchyAutoLayoutNode(sourceParent)) {
    errors.push({
      code: "parentAutoLayoutUnsupported",
      message: "父级容器启用了 Auto Layout，替换实例可能改变布局，已阻止写入。",
      details: { parentId: sourceParent.id, layoutMode: sourceParent.layoutMode }
    });
  }
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(beforeChildren) || beforeChildren.length < 2) {
    errors.push({ code: "siblingSourceTooSmall", message: "至少需要 2 个同父级来源节点才能重建 ComponentSet。", details: { sourceCount: beforeChildren ? beforeChildren.length : 0 } });
    return errors;
  }
  const unsupportedTypes = beforeChildren.filter((child) => !isManualComponentSetSourceRecord(child));
  if (unsupportedTypes.length > 0) {
    errors.push({
      code: "unsupportedSiblingSourceType",
      message: "同级来源中存在不能克隆为 Component 变体的节点。",
      details: unsupportedTypes.map((child) => ({ id: child.id, name: child.name, type: child.type }))
    });
  }
  const variantIds = variants.map((item) => item.nodeId);
  const propertySignatures = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicateIds = uniqueStrings(variantIds.filter((id, index) => variantIds.indexOf(id) !== index));
  const duplicateValues = uniqueStrings(propertySignatures.filter((value, index, array) => array.indexOf(value) !== index));
  const emptyValues = variants.filter((item) => !buildVariantPropertySignature(item, variantProperty)).map((item) => item.nodeId);
  if (variants.length !== beforeChildren.length) {
    errors.push({ code: "variantSiblingCountMismatch", message: "变体计划数量必须等于同级来源节点数量。", details: { siblingCount: beforeChildren.length, variantCount: variants.length } });
  }
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateVariantNodeIds", message: "变体计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "变体计划中存在重复变体属性组合。", details: { values: duplicateValues } });
  }
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "变体属性值不能为空。", details: { nodeIds: emptyValues } });
  }
  return errors;
}

/** 判断轻量节点记录是否可作为同级变体来源。 */
function isManualComponentSetSourceRecord(record) {
  return !!record && positiveOr(record.bounds && record.bounds.width, 0) > 0 && positiveOr(record.bounds && record.bounds.height, 0) > 0;
}

/** 同级重建阻塞时返回稳定结构，禁止产生部分 Figma 写入。 */
function buildRebuildSiblingComponentSetBlockedResult(selectedNode, sourceParent, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: sourceParent ? sourceParent.id : "",
    rootName: sourceParent ? sourceParent.name || "" : "",
    nodeType: sourceParent ? sourceParent.type : "",
    directChildren: beforeChildren || [],
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selected-siblings",
      selectedNodeId: selectedNode ? selectedNode.id : "",
      selectedNodeName: selectedNode ? selectedNode.name || "" : "",
      siblingCount: beforeChildren ? beforeChildren.length : 0,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 克隆当前选择节点，合成一个 Frame 后转为普通 Component。 */
async function createComponentFromSelectionJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const selection = figma.currentPage.selection.slice();
  const componentName = String(plan.componentName || job.componentName || "ManualSelectionComponent").trim() || "ManualSelectionComponent";
  const validationErrors = validateComponentFromSelectionPlan(selection);
  if (validationErrors.length > 0) {
    return buildComponentFromSelectionBlockedResult(selection, validationErrors);
  }

  const selectionRecords = collectSelectionComponentSetRecords(selection);
  const beforeBounds = unionBounds(selectionRecords.map((record) => record.bounds));
  const frame = createFrameFromSelectionClones(selection, componentName, beforeBounds);
  const component = figma.createComponentFromNode(frame);
  component.name = componentName;
  if ("clipsContent" in component) {
    component.clipsContent = false;
  }
  writePluginData(component, {
    generatedBy: "componentFromSelection",
    source: "selection-clone",
    sourceNodeIds: selectionRecords.map((record) => record.id).join(",")
  });

  const preservedSourceNodeIds = await collectExistingNodeIds(selectionRecords.map((record) => record.id));
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(component) : null;
  const componentBounds = getNodeBounds(component);
  const checks = {
    componentCreated: {
      pass: component.type === "COMPONENT",
      componentId: component.id,
      componentName: component.name
    },
    sourceSelectionCountPreserved: {
      pass: selectionRecords.length > 0 && component.children.length === selectionRecords.length,
      sourceSelectionCount: selectionRecords.length,
      componentChildCount: component.children.length
    },
    sourceNodesPreserved: {
      pass: preservedSourceNodeIds.length === selectionRecords.length,
      sourceNodeIds: selectionRecords.map((record) => record.id)
    },
    componentBoundsValid: {
      pass: positiveOr(componentBounds.width, 0) > 0 && positiveOr(componentBounds.height, 0) > 0,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(componentBounds)
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  await setCurrentPageForNode(component);
  figma.currentPage.selection = [component];
  figma.viewport.scrollAndZoomIntoView([component]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: component.id,
    rootName: component.name || "",
    nodeType: component.type,
    rootBounds: boundsToManifest(componentBounds),
    beforeChildren: selectionRecords,
    afterChildren: collectHierarchyDirectChildren(component, componentBounds, true),
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selection-clone",
      componentId: component.id,
      componentName: component.name,
      selectedNodeCount: selectionRecords.length,
      childCount: component.children.length
    },
    checks,
    artifacts: {
      before: {
        selectedNodeIds: selectionRecords.map((record) => record.id),
        selectedNodeNames: selectionRecords.map((record) => record.name)
      },
      after: {
        componentId: component.id,
        componentName: component.name,
        childNodeIds: component.children.map((child) => child.id)
      },
      plan
    },
    errors: []
  };
}

/** 校验手动选择生成普通 Component 的输入。 */
function validateComponentFromSelectionPlan(selection) {
  const errors = [];
  if (!Array.isArray(selection) || selection.length === 0) {
    errors.push({ code: "selectionEmpty", message: "当前没有选中任何节点，无法生成 Component。", details: {} });
    return errors;
  }
  const unsupportedTypes = [];
  for (const node of selection) {
    if (!isManualComponentSetSourceNode(node)) {
      unsupportedTypes.push({ id: node.id, name: node.name || "", type: node.type });
    }
  }
  if (unsupportedTypes.length > 0) {
    errors.push({ code: "unsupportedSelectionSourceType", message: "当前选择中存在不能克隆到 Component 的节点。", details: unsupportedTypes });
  }
  return errors;
}

/** 创建普通 Component 的阻塞结果，不写入 Figma。 */
function buildComponentFromSelectionBlockedResult(selection, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: "",
    rootName: "",
    nodeType: "",
    beforeChildren: collectSelectionComponentSetRecords(selection || []),
    afterChildren: [],
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selection-clone",
      selectedNodeCount: selection ? selection.length : 0,
      componentId: "",
      componentName: ""
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 克隆当前选择节点到一个新 Frame，保持源节点不动。 */
function createFrameFromSelectionClones(selection, componentName, selectionBounds) {
  const page = findContainingPage(selection[0]) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentSource_${componentName}]`);
  frame.x = numericOr(selectionBounds.x, 0) + positiveOr(selectionBounds.width, 1) + 160;
  frame.y = numericOr(selectionBounds.y, 0);
  frame.resize(Math.max(positiveOr(selectionBounds.width, 1), 1), Math.max(positiveOr(selectionBounds.height, 1), 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);

  for (const node of selection) {
    const clone = node.clone();
    const bounds = getNodeBounds(node);
    frame.appendChild(clone);
    clone.x = numericOr(bounds.x, 0) - numericOr(selectionBounds.x, 0);
    clone.y = numericOr(bounds.y, 0) - numericOr(selectionBounds.y, 0);
    if ("constraints" in clone) {
      clone.constraints = { horizontal: "MIN", vertical: "MIN" };
    }
  }
  return frame;
}

/** 将当前选择节点追加为已有 ComponentSet 的新变体。 */
async function addComponentSetVariantsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const componentSetId = String(target.componentSetId || (plan.target && plan.target.componentSetId) || plan.componentSetId || "").trim();
  if (!componentSetId) {
    throw new Error("FIGMA_ADD_COMPONENT_SET_VARIANTS missing target.componentSetId");
  }

  const componentSet = await figma.getNodeByIdAsync(componentSetId).catch(() => null);
  if (!componentSet) {
    throw new Error(`ComponentSet not found: ${componentSetId}`);
  }
  if (componentSet.type !== "COMPONENT_SET") {
    throw new Error(`Target node is not COMPONENT_SET: ${componentSet.type}`);
  }

  await setCurrentPageForNode(componentSet);
  const selection = figma.currentPage.selection.filter((node) => node.id !== componentSet.id);
  const variantProperty = String(plan.variantProperty || inferComponentSetPrimaryVariantProperty(componentSet) || "State").trim() || "State";
  const variants = normalizeSelectionComponentSetVariantPlans(selection, plan.variants, variantProperty);
  const validationErrors = validateAddComponentSetVariantPlan(componentSet, selection, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildAddComponentSetVariantsBlockedResult(componentSet, selection, validationErrors);
  }

  const beforeVariantCount = componentSet.children.length;
  const selectionRecords = collectSelectionComponentSetRecords(selection);
  const sourceNodeData = await collectManualComponentSetSourceNodeData(selectionRecords);
  const addedComponents = await appendVariantComponentsToComponentSet(componentSet, variants, sourceNodeData, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(componentSet) : null;
  const variantNineSliceReports = buildVariantNineSliceReports(variants, sourceNodeData, collectVariantComponentsByValue(componentSet, variantProperty), variantProperty);
  const preservedSourceNodeIds = await collectExistingNodeIds(selectionRecords.map((record) => record.id));
  const checks = {
    selectionCountMatches: {
      pass: selectionRecords.length === variants.length,
      selectionCount: selectionRecords.length,
      variantPlanCount: variants.length
    },
    componentSetVariantCountIncreased: {
      pass: componentSet.children.length === beforeVariantCount + variants.length,
      before: beforeVariantCount,
      after: componentSet.children.length,
      added: variants.length
    },
    sourceNodesPreserved: {
      pass: preservedSourceNodeIds.length === selectionRecords.length,
      sourceNodeIds: selectionRecords.map((record) => record.id)
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: componentSet.id,
    rootName: componentSet.name || "",
    nodeType: componentSet.type,
    rootBounds: boundsToManifest(getNodeBounds(componentSet)),
    beforeChildren: selectionRecords,
    afterChildren: collectHierarchyDirectChildren(componentSet, getNodeBounds(componentSet), true),
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selection",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      beforeVariantCount,
      addedVariantCount: addedComponents.length,
      variantCount: componentSet.children.length,
      selectedNodeCount: selectionRecords.length,
      replacedInstanceCount: 0
    },
    checks,
    artifacts: {
      before: {
        selectedNodeIds: selectionRecords.map((record) => record.id),
        selectedNodeNames: selectionRecords.map((record) => record.name),
        variantCount: beforeVariantCount
      },
      after: {
        componentSetId: componentSet.id,
        variantCount: componentSet.children.length,
        addedComponentIds: addedComponents.map((child) => child.id)
      },
      plan,
      componentSetId: componentSet.id
    },
    errors: []
  };
}

/** 推断 ComponentSet 的主要变体属性名。 */
function inferComponentSetPrimaryVariantProperty(componentSet) {
  if (!componentSet || componentSet.type !== "COMPONENT_SET") {
    return "";
  }
  for (const child of componentSet.children || []) {
    const props = child.variantProperties || {};
    const keys = Object.keys(props);
    if (keys.length > 0) {
      return keys[0];
    }
  }
  return "";
}

/** 校验追加变体计划，避免重复属性组合或选择不合法。 */
function validateAddComponentSetVariantPlan(componentSet, selection, variants, variantProperty) {
  const errors = validateSelectionComponentSetVariantPlan(selection, variants, variantProperty);
  const existingValues = [];
  for (const child of componentSet.children || []) {
    const key = buildVariantKeyFromComponent(child, variantProperty);
    if (key) {
      existingValues.push(key);
    }
  }
  const newValues = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicatedExisting = uniqueStrings(newValues.filter((value) => existingValues.indexOf(value) >= 0));
  if (duplicatedExisting.length > 0) {
    errors.push({ code: "variantValuesAlreadyExist", message: "已有 ComponentSet 中已存在相同变体属性组合。", details: { values: duplicatedExisting } });
  }
  return errors;
}

/** 创建追加变体的阻塞结果，不产生任何 Figma 写入。 */
function buildAddComponentSetVariantsBlockedResult(componentSet, selection, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: componentSet ? componentSet.id : "",
    rootName: componentSet ? componentSet.name || "" : "",
    nodeType: componentSet ? componentSet.type : "",
    directChildren: collectSelectionComponentSetRecords(selection || []),
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selection",
      selectedNodeCount: selection ? selection.length : 0,
      addedVariantCount: 0,
      variantCount: componentSet && componentSet.children ? componentSet.children.length : 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 将选择节点 clone 后转 Component，并追加进已有 ComponentSet。 */
async function appendVariantComponentsToComponentSet(componentSet, variants, sourceNodeData, variantProperty) {
  const components = [];
  const gap = 40;
  const currentCount = componentSet.children.length;
  const componentBounds = getNodeBounds(componentSet);
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    const source = sourceNodeData[variant.nodeId];
    if (!source || !source.node) {
      continue;
    }
    const clone = cloneComponentSourceAsFrame(source, buildVariantComponentName(variant, variantProperty));
    const page = findContainingPage(componentSet) || figma.currentPage;
    page.appendChild(clone);
    clone.x = numericOr(componentSet.x, componentBounds.x) + (currentCount + index) * (source.width + gap);
    clone.y = numericOr(componentSet.y, componentBounds.y);
    safeResizeNode(clone, source.width, source.height);
    const component = figma.createComponentFromNode(clone);
    component.name = buildVariantComponentName(variant, variantProperty);
    componentSet.appendChild(component);
    component.x = (currentCount + index) * (source.width + gap);
    component.y = 0;
    safeResizeNode(component, source.width, source.height);
    writePluginData(component, {
      generatedBy: "componentSetVariant",
      sourceNodeId: variant.nodeId,
      variantProperty,
      variantValue: buildVariantPropertySignature(variant, variantProperty)
    });
    components.push(component);
  }
  return components;
}

/** 创建隐藏备份容器，保存被替换前的原始任务项节点，便于人工回退。 */
function createComponentSetBackupFrame(root, componentSetName, rootBounds, libraryFrame) {
  const page = findContainingPage(root) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentSourceBackup_${componentSetName}]`);
  frame.x = numericOr(libraryFrame.x, rootBounds.x + rootBounds.width + 160);
  frame.y = numericOr(libraryFrame.y, rootBounds.y) + numericOr(libraryFrame.height, rootBounds.height) + 80;
  frame.resize(Math.max(rootBounds.width, 1), Math.max(rootBounds.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  frame.visible = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);
  return frame;
}

/** 克隆每个源任务项并转为 Component，之后交给 combineAsVariants 合并。 */
async function createVariantComponentsInLibrary(libraryFrame, variants, beforeNodeData, variantProperty) {
  const components = [];
  const gap = 40;
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    const source = beforeNodeData[variant.nodeId];
    if (!source || !source.node) {
      continue;
    }
    const clone = cloneComponentSourceAsFrame(source, buildVariantComponentName(variant, variantProperty));
    libraryFrame.appendChild(clone);
    clone.x = 0;
    clone.y = index * (source.height + gap);
    safeResizeNode(clone, source.width, source.height);
    const component = figma.createComponentFromNode(clone);
    component.name = buildVariantComponentName(variant, variantProperty);
    component.x = 0;
    component.y = index * (source.height + gap);
    safeResizeNode(component, source.width, source.height);
    writePluginData(component, {
      generatedBy: "componentSetVariant",
      sourceNodeId: variant.nodeId,
      variantProperty,
      variantValue: buildVariantPropertySignature(variant, variantProperty)
    });
    components.push(component);
  }
  return components;
}

/** 克隆源节点为可转 Component 的 Frame，兼容 TEXT、RECTANGLE 等叶子节点。 */
function cloneComponentSourceAsFrame(source, frameName) {
  const node = source.node;
  if (node && (
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET"
  )) {
    return node.clone();
  }

  const frame = figma.createFrame();
  frame.name = `[VariantSource_${frameName}]`;
  frame.resize(Math.max(source.width, 1), Math.max(source.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  const clone = node.clone();
  frame.appendChild(clone);
  clone.x = 0;
  clone.y = 0;
  if ("constraints" in clone) {
    clone.constraints = { horizontal: "MIN", vertical: "MIN" };
  }
  return frame;
}

/** 从 ComponentSet 子组件中按变体属性建立 value 到 Component 的映射。 */
function collectVariantComponentsByValue(componentSet, variantProperty) {
  const output = {};
  for (const child of componentSet.children || []) {
    if (child.type !== "COMPONENT") {
      continue;
    }
    const key = buildVariantKeyFromComponent(child, variantProperty);
    if (key) {
      output[key] = child;
    }
  }
  return output;
}

/** 生成 Figma 可识别的变体组件名，支持单属性和多属性。 */
function buildVariantComponentName(variant, variantProperty) {
  const properties = variant && variant.properties ? variant.properties : {};
  const keys = Object.keys(properties);
  if (keys.length > 0) {
    return keys.map((key) => `${key}=${properties[key]}`).join(", ");
  }
  return `${variantProperty}=${variant.value}`;
}

/** 为变体计划生成稳定签名，单属性与多属性都可用作查表 key。 */
function buildVariantPropertySignature(variant, variantProperty) {
  const properties = variant && variant.properties ? variant.properties : {};
  const keys = Object.keys(properties).sort();
  if (keys.length > 0) {
    return keys.map((key) => `${key}=${properties[key]}`).join("|");
  }
  const value = String(variant && variant.value || "").trim();
  return value ? `${variantProperty}=${value}` : "";
}

/** 从 Component 读取 Figma 变体属性并生成查表 key。 */
function buildVariantKeyFromComponent(component, variantProperty) {
  const props = component.variantProperties || {};
  const keys = Object.keys(props).sort();
  if (keys.length > 0) {
    return keys.map((key) => `${key}=${props[key]}`).join("|");
  }
  const fallbackValue = parseVariantValueFromName(component.name, variantProperty);
  return fallbackValue ? `${variantProperty}=${fallbackValue}` : "";
}

/** 从组件名中解析变体值，作为 variantProperties 不可读时的兜底。 */
function parseVariantValueFromName(name, variantProperty) {
  const prefix = `${variantProperty}=`;
  const parts = String(name || "").split(",");
  for (const part of parts) {
    const text = part.trim();
    if (text.indexOf(prefix) === 0) {
      return text.slice(prefix.length);
    }
  }
  return "";
}

/** 用对应变体实例替换 Content 直接子节点，并把源节点移动到隐藏备份容器。 */
async function replaceComponentSetSourcesWithInstances(root, beforeChildren, variants, beforeNodeData, variantComponentByValue, backupFrame, variantProperty) {
  const variantByNodeId = {};
  for (const variant of variants) {
    variantByNodeId[variant.nodeId] = variant;
  }
  const instances = [];
  for (const record of beforeChildren) {
    const variant = variantByNodeId[record.id];
    const source = beforeNodeData[record.id];
    const variantKey = variant ? buildVariantPropertySignature(variant, variantProperty) : "";
    const variantComponent = variant ? variantComponentByValue[variantKey] : null;
    if (!variant || !source || !variantComponent) {
      continue;
    }
    const instance = variantComponent.createInstance();
    root.appendChild(instance);
    instance.name = source.name;
    safeResizeNode(instance, source.width, source.height);
    instance.x = source.x;
    instance.y = source.y;
    if (source.constraints && "constraints" in instance) {
      instance.constraints = cloneObject(source.constraints);
    }
    instances.push({
      sourceNodeId: record.id,
      sourceName: source.name,
      instanceId: instance.id,
      instanceName: instance.name,
      variantValue: variantKey,
      beforeBounds: source.bounds,
      afterBounds: boundsToManifest(getNodeBounds(instance))
    });
  }

  const movedSourceNodeIds = [];
  for (let index = 0; index < beforeChildren.length; index++) {
    const record = beforeChildren[index];
    const source = beforeNodeData[record.id];
    if (!source || !source.node) {
      continue;
    }
    if (backupFrame) {
      backupFrame.appendChild(source.node);
      source.node.x = 0;
      source.node.y = index * (source.height + 12);
    } else {
      source.node.remove();
    }
    movedSourceNodeIds.push(record.id);
  }
  return { instances, movedSourceNodeIds };
}

/** 检查替换后的实例绝对 bounds 是否和源任务项一致。 */
function collectComponentSetInstanceBoundsDrift(instances, beforeNodeData, tolerance) {
  const driftNodes = [];
  for (const item of instances || []) {
    const source = beforeNodeData[item.sourceNodeId];
    if (!source) {
      continue;
    }
    const before = source.bounds;
    const after = item.afterBounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        sourceNodeId: item.sourceNodeId,
        instanceId: item.instanceId,
        name: item.sourceName,
        variantValue: item.variantValue,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 校验每个变体组件仍保留源任务项中的九宫相关节点数量。 */
function buildVariantNineSliceReports(variants, beforeNodeData, variantComponentByValue, variantProperty) {
  const reports = [];
  for (const variant of variants) {
    const variantKey = buildVariantPropertySignature(variant, variantProperty);
    const source = beforeNodeData[variant.nodeId];
    const component = variantComponentByValue[variantKey];
    const beforeCount = source ? source.nineSliceCount : 0;
    const afterCount = component ? countHierarchyNineSliceLikeNodes(component) : 0;
    reports.push({
      sourceNodeId: variant.nodeId,
      variantValue: variantKey,
      beforeCount,
      afterCount,
      pass: afterCount >= beforeCount
    });
  }
  return reports;
}

/** 统计节点树中疑似九宫或切片节点数量，防止抽组件时误 flatten。 */
function countHierarchyNineSliceLikeNodes(node) {
  let count = isHierarchyNineSliceLike(node) ? 1 : 0;
  if ("children" in node) {
    for (const child of node.children) {
      count += countHierarchyNineSliceLikeNodes(child);
    }
  }
  return count;
}

/** 安全调整节点尺寸，统一保护最小尺寸并兼容不可 resize 的节点。 */
function safeResizeNode(node, width, height) {
  if (node && "resize" in node) {
    node.resize(Math.max(positiveOr(width, 1), 0.01), Math.max(positiveOr(height, 1), 0.01));
  }
}

/** 在同一父节点下生成唯一名称，避免重复尝试时覆盖旧组件库。 */
function makeUniqueDirectChildName(parent, baseName) {
  const names = {};
  if (parent && "children" in parent) {
    for (const child of parent.children) {
      names[child.name || ""] = true;
    }
  }
  if (!names[baseName]) {
    return baseName;
  }
  for (let index = 2; index < 1000; index++) {
    const candidate = `${baseName}_${index}`;
    if (!names[candidate]) {
      return candidate;
    }
  }
  return `${baseName}_${Date.now()}`;
}

/** 收集根节点直接子节点的轻量信息。 */
function collectHierarchyDirectChildren(root, rootBounds, includeHidden) {
  const output = [];
  if (!root || !("children" in root)) {
    return output;
  }
  for (let index = 0; index < root.children.length; index++) {
    const child = root.children[index];
    if (!includeHidden && child.visible === false) {
      continue;
    }
    output.push(buildHierarchyNodeRecord(child, root, rootBounds, "", index));
  }
  return output;
}

function collectHierarchyPlanChildIds(plan) {
  const plannedIds = [];
  for (const group of plan.groups || []) {
    for (const childId of group.childNodeIds || []) {
      plannedIds.push(String(childId));
    }
  }
  return plannedIds;
}

function normalizeHierarchyBeforeChildIds(beforeChildrenOrIds) {
  const output = [];
  for (const item of beforeChildrenOrIds || []) {
    if (typeof item === "string") {
      output.push(item);
    } else if (item && typeof item === "object" && item.id) {
      output.push(String(item.id));
    }
  }
  return output;
}

/** 递归收集节点信息，供计划脚本做语义分组。 */
function collectHierarchyCleanupNodes(node, root, rootBounds, output, includeHidden, maxDepth, depth, parentId) {
  if (!node || (!includeHidden && node.visible === false) || depth > maxDepth) {
    return;
  }
  const index = node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : 0;
  output.push(buildHierarchyNodeRecord(node, root, rootBounds, parentId || "", index));
  if ("children" in node && depth < maxDepth) {
    for (const child of node.children) {
      collectHierarchyCleanupNodes(child, root, rootBounds, output, includeHidden, maxDepth, depth + 1, node.id);
    }
  }
}

/** 构建层级整理节点记录。 */
function buildHierarchyNodeRecord(node, root, rootBounds, parentId, index) {
  const bounds = getNodeBounds(node);
  const record = {
    id: node.id,
    parentId: parentId || (node.parent ? node.parent.id : ""),
    index,
    name: node.name || "",
    type: node.type,
    path: buildNodePath(node, root),
    visible: node.visible !== false,
    opacity: typeof node.opacity === "number" ? node.opacity : 1,
    bounds: boundsToManifest(bounds),
    relativeBounds: boundsToRelativeManifest(bounds, rootBounds),
    childCount: "children" in node && Array.isArray(node.children) ? node.children.length : 0,
    isNineSliceLike: isHierarchyNineSliceLike(node)
  };
  if (node.type === "TEXT") {
    record.characters = String(node.characters || "");
    record.fontSize = readFigmaFontSize(node);
  }
  return record;
}

/** 判断节点是否疑似九宫切片相关，计划和应用阶段都不应拆散。 */
function isHierarchyNineSliceLike(node) {
  const name = String((node && node.name) || "").toLowerCase();
  return name.indexOf("__slice") >= 0 || name.indexOf("jiugong") >= 0 || name.indexOf("nine-slice") >= 0 || name.indexOf("9slice") >= 0;
}

/** 判断节点是否启用了 Auto Layout；此类节点自动打组容易改变视觉布局。 */
function isHierarchyAutoLayoutNode(node) {
  return !!node && "layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE";
}

/** 收集当前顶层分组信息。 */
function collectHierarchyTopLevelGroups(root) {
  const output = [];
  if (!root || !("children" in root)) {
    return output;
  }
  for (let index = 0; index < root.children.length; index++) {
    const child = root.children[index];
    output.push({
      id: child.id,
      name: child.name || "",
      type: child.type,
      index,
      childCount: "children" in child && Array.isArray(child.children) ? child.children.length : 0,
      bounds: boundsToManifest(getNodeBounds(child))
    });
  }
  return output;
}

/** 校验整理计划节点集合必须和根直接子节点完全一致。 */
function validateHierarchyCleanupPlan(plan, beforeChildrenOrIds, context) {
  const errors = [];
  const beforeChildIds = normalizeHierarchyBeforeChildIds(beforeChildrenOrIds);
  const planTarget = plan && plan.target ? plan.target : {};
  const planTargetNodeId = String(planTarget.nodeId || "");
  const rootNodeId = context && context.rootNodeId ? String(context.rootNodeId) : "";
  const jobTargetNodeId = context && context.targetNodeId ? String(context.targetNodeId) : "";
  if (!planTargetNodeId) {
    errors.push({
      code: "missingPlanTargetNodeId",
      message: "Hierarchy cleanup plan is missing target.nodeId.",
      details: {}
    });
  }
  if (planTargetNodeId && rootNodeId && planTargetNodeId !== rootNodeId) {
    errors.push({
      code: "planTargetRootMismatch",
      message: "Hierarchy cleanup plan target.nodeId must match the current root node.",
      details: { planTargetNodeId, rootNodeId }
    });
  }
  if (planTargetNodeId && jobTargetNodeId && planTargetNodeId !== jobTargetNodeId) {
    errors.push({
      code: "planTargetJobTargetMismatch",
      message: "Hierarchy cleanup plan target.nodeId must match the submitted job target.",
      details: { planTargetNodeId, jobTargetNodeId }
    });
  }
  for (const group of plan.groups || []) {
    const groupName = String(group.name || "");
    if (!/^\[[^\]]+\]$/.test(groupName)) {
      errors.push({
        code: "invalidGroupName",
        message: "新增分组名称必须使用方括号。",
        details: { groupName }
      });
    }
    if (!Array.isArray(group.childNodeIds) || group.childNodeIds.length === 0) {
      errors.push({
        code: "emptyChildNodeIds",
        message: "Each hierarchy cleanup group must contain at least one childNodeIds entry.",
        details: { groupName }
      });
    }
  }
  const plannedIds = collectHierarchyPlanChildIds(plan);
  const duplicateIds = plannedIds.filter((id, index) => plannedIds.indexOf(id) !== index);
  const uniqueDuplicateIds = uniqueStrings(duplicateIds);
  if (uniqueDuplicateIds.length > 0) {
    errors.push({
      code: "duplicateNodeIds",
      message: "计划中存在重复节点 id。",
      details: { nodeIds: uniqueDuplicateIds }
    });
  }

  const beforeSet = uniqueStrings(beforeChildIds);
  const plannedSet = uniqueStrings(plannedIds);
  const missing = beforeSet.filter((id) => plannedSet.indexOf(id) < 0);
  const extra = plannedSet.filter((id) => beforeSet.indexOf(id) < 0);
  if (missing.length > 0 || extra.length > 0) {
    errors.push({
      code: "planNodeSetMismatch",
      message: "计划节点集合必须与整理前根直接子节点完全一致。",
      details: { missing, extra }
    });
  }
  return errors;
}

/** Resolve planned cleanup nodes and require each node to be a direct child of root. */
async function resolveHierarchyCleanupPlanChildNodes(root, plan, beforeChildrenOrIds) {
  const errors = [];
  const nodesById = {};
  const beforeChildIds = normalizeHierarchyBeforeChildIds(beforeChildrenOrIds);
  const beforeChildIdSet = {};
  for (const id of beforeChildIds) {
    beforeChildIdSet[id] = true;
  }
  const plannedIds = uniqueStrings(collectHierarchyPlanChildIds(plan));
  for (const childId of plannedIds) {
    const node = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
    if (!node) {
      errors.push({
        code: "plannedChildMissing",
        message: "Hierarchy cleanup plan references a node that no longer exists.",
        details: { nodeId: childId }
      });
      continue;
    }
    const parent = node.parent || null;
    if (parent !== root || beforeChildIdSet[childId] !== true) {
      errors.push({
        code: "childNotDirectChild",
        message: "Every hierarchy cleanup childNodeId must be a current direct child of target.nodeId.",
        details: {
          nodeId: childId,
          nodeName: node.name || "",
          expectedParentId: root.id,
          actualParentId: parent ? parent.id : "",
          actualParentName: parent ? (parent.name || "") : ""
        }
      });
      continue;
    }
    nodesById[childId] = node;
  }
  return { nodesById, errors };
}

/** 校验重排计划必须完整覆盖当前直接子节点且不能重复。 */
function validateHierarchyReorderPlan(requestedIds, beforeChildIds) {
  const errors = [];
  const duplicateIds = requestedIds.filter((id, index) => requestedIds.indexOf(id) !== index);
  const uniqueDuplicateIds = uniqueStrings(duplicateIds);
  if (uniqueDuplicateIds.length > 0) {
    errors.push({
      code: "duplicateNodeIds",
      message: "重排计划中存在重复节点 id。",
      details: { nodeIds: uniqueDuplicateIds }
    });
  }

  const beforeSet = uniqueStrings(beforeChildIds);
  const requestedSet = uniqueStrings(requestedIds);
  const missing = beforeSet.filter((id) => requestedSet.indexOf(id) < 0);
  const extra = requestedSet.filter((id) => beforeSet.indexOf(id) < 0);
  if (missing.length > 0 || extra.length > 0 || requestedIds.length !== beforeChildIds.length) {
    errors.push({
      code: "reorderNodeSetMismatch",
      message: "重排计划节点集合必须与当前根直接子节点完全一致。",
      details: { missing, extra, expectedCount: beforeChildIds.length, actualCount: requestedIds.length }
    });
  }
  return errors;
}

/** 计划阻塞时返回稳定结构，禁止部分应用。 */
function buildHierarchyCleanupBlockedResult(root, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root.id,
    rootName: root.name || "",
    directChildren: beforeChildren,
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      createdGroups: 0,
      movedOriginalNodes: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 重排计划阻塞时返回稳定结构，禁止部分应用。 */
function buildHierarchyReorderBlockedResult(root, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root.id,
    rootName: root.name || "",
    directChildren: beforeChildren,
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      reorderedChildren: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 创建一个覆盖子节点视觉范围的整理分组 Frame。 */
function createHierarchyCleanupGroup(root, groupPlan, beforeChildren) {
  const childIds = groupPlan.childNodeIds || [];
  const childRecords = beforeChildren.filter((child) => childIds.indexOf(child.id) >= 0);
  const union = unionHierarchyBounds(childRecords.map((child) => child.bounds));
  const rootBounds = getNodeBounds(root);
  const frame = figma.createFrame();
  frame.name = String(groupPlan.name || "[Group]");
  frame.x = union.x - rootBounds.x;
  frame.y = union.y - rootBounds.y;
  frame.resize(Math.max(union.width, 0.01), Math.max(union.height, 0.01));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  root.appendChild(frame);
  return frame;
}

/** 判断节点是否为备份帧（名称以 [Backup]、[ComponentSourceBackup_ 或 [ComponentLibrary_ 开头）。 */
function isBackupFrame(node) {
  if (!node || typeof node.name !== "string") return false;
  const name = String(node.name);
  return name.startsWith("[Backup]") || name.startsWith("[ComponentSourceBackup_") || name.startsWith("[ComponentLibrary_");
}

/** 把原始节点移动到新分组后，恢复它相对新分组的局部坐标，避免视觉漂移。 */
function preserveHierarchyChildAbsoluteBounds(child, groupNode, beforeBounds) {
  if (!child || typeof child.x !== "number" || typeof child.y !== "number") {
    return;
  }
  const groupBounds = getNodeBounds(groupNode);
  const newX = numericOr(beforeBounds.x, 0) - numericOr(groupBounds.x, 0);
  const newY = numericOr(beforeBounds.y, 0) - numericOr(groupBounds.y, 0);
  child.x = newX;
  child.y = newY;
  // 坐标合理性检查：超过 ±5000 大概率是坐标系污染，记录日志
  if (Math.abs(newX) > 5000 || Math.abs(newY) > 5000) {
    pluginLogger.warn("层级 preserve 坐标异常", {
      childName: child.name || "?",
      newX: newX,
      newY: newY,
      beforeX: numericOr(beforeBounds.x, 0),
      beforeY: numericOr(beforeBounds.y, 0),
      groupX: numericOr(groupBounds.x, 0),
      groupY: numericOr(groupBounds.y, 0)
    });
  }
}

/** 合并多个绝对边界。 */
function unionHierarchyBounds(boundsList) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const bounds of boundsList) {
    const x = numericOr(bounds.x, 0);
    const y = numericOr(bounds.y, 0);
    const width = numericOr(bounds.width, 0);
    const height = numericOr(bounds.height, 0);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 0.01),
    height: Math.max(maxY - minY, 0.01)
  };
}

/** 收集整理后原始节点信息，用于验证节点守恒和视觉不漂移。 */
async function collectHierarchyOriginalNodesAfter(plan, beforeBoundsById) {
  const output = [];
  const rootBounds = { x: 0, y: 0, width: 0, height: 0 };
  for (const group of plan.groups || []) {
    for (const childId of group.childNodeIds || []) {
      const node = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
      if (!node) {
        continue;
      }
      output.push(buildHierarchyNodeRecord(node, node, rootBounds, node.parent ? node.parent.id : "", 0));
      output[output.length - 1].beforeBounds = beforeBoundsById[String(childId)] || null;
    }
  }
  return output;
}

/** 检查整理后原始节点的绝对边界是否漂移。 */
function collectHierarchyBoundsDrift(originalNodesAfter, beforeBoundsById, tolerance) {
  const driftNodes = [];
  for (const node of originalNodesAfter) {
    const before = beforeBoundsById[node.id];
    if (!before) {
      continue;
    }
    const after = node.bounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        nodeId: node.id,
        name: node.name,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 检查重排后直接子节点绝对边界是否漂移。 */
function collectHierarchyReorderBoundsDrift(afterChildren, beforeBoundsById, tolerance) {
  const driftNodes = [];
  for (const node of afterChildren || []) {
    const before = beforeBoundsById[node.id];
    if (!before) {
      continue;
    }
    const after = node.bounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        nodeId: node.id,
        name: node.name,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 根据 apply 阶段检查项生成阻塞错误。 */
function buildHierarchyApplyBlockingErrors(checks) {
  const errors = [];
  for (const key of Object.keys(checks)) {
    const check = checks[key];
    if (check && check.pass === false) {
      errors.push({
        code: key,
        message: `Figma 层级整理检查失败：${key}`,
        details: check
      });
    }
  }
  return errors;
}

/** 字符串数组去重并保持首次出现顺序。 */
function uniqueStrings(values) {
  const seen = {};
  const output = [];
  for (const value of values || []) {
    const text = String(value || "");
    if (!text || seen[text]) {
      continue;
    }
    seen[text] = true;
    output.push(text);
  }
  return output;
}

function serializePaints(paints) {
  if (!Array.isArray(paints)) {
    return [];
  }
  return paints.map((paint) => {
    const result = {
      type: String(paint.type || ""),
      visible: paint.visible !== false,
      opacity: typeof paint.opacity === "number" ? paint.opacity : 1
    };
    if (paint.color) {
      result.color = {
        r: roundNumber(paint.color.r || 0),
        g: roundNumber(paint.color.g || 0),
        b: roundNumber(paint.color.b || 0)
      };
    }
    if (paint.imageHash) {
      result.imageHash = String(paint.imageHash);
      result.scaleMode = String(paint.scaleMode || "");
    }
    return result;
  });
}

/** 序列化文本投影效果，Unity 侧会近似映射到 TMP Underlay。 */
function serializeEffects(effects) {
  if (!Array.isArray(effects)) {
    return [];
  }
  return effects.map((effect) => {
    const result = {
      type: String(effect.type || ""),
      visible: effect.visible !== false,
      radius: typeof effect.radius === "number" ? roundNumber(effect.radius) : 0,
      spread: typeof effect.spread === "number" ? roundNumber(effect.spread) : 0,
      blendMode: effect.blendMode ? String(effect.blendMode) : ""
    };
    if (effect.offset) {
      result.offset = {
        x: roundNumber(effect.offset.x || 0),
        y: roundNumber(effect.offset.y || 0)
      };
    }
    if (effect.color) {
      result.color = {
        r: roundNumber(effect.color.r || 0),
        g: roundNumber(effect.color.g || 0),
        b: roundNumber(effect.color.b || 0),
        a: typeof effect.color.a === "number" ? roundNumber(effect.color.a) : 1
      };
    }
    return result;
  });
}

function findFirstImageHash(node, includeHiddenImageFill) {
  const fills = Array.isArray(node && node.fills) ? node.fills : [];
  for (const paint of fills) {
    if (paint && (includeHiddenImageFill || paint.visible !== false) && paint.type === "IMAGE" && paint.imageHash) {
      return String(paint.imageHash);
    }
  }
  return "";
}

/** 九宫容器回溯源图：遍历 __slice_ 子节点获取 imageHash。 */
function findNineSliceSourceHash(node) {
  if (!node || !("children" in node) || !Array.isArray(node.children)) return "";
  for (const child of node.children) {
    if (String(child && child.name || "").startsWith("__slice_")) {
      const hash = findFirstImageHash(child, true);
      if (hash) return hash;
    }
  }
  return "";
}

// 读取 Figma 九宫切片信息，计算 Unity Sliced Sprite 所需边框。
function buildFigmaPrefabNineSliceInfo(node) {
  if (!node || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }

  const slices = {};
  for (const child of node.children) {
    const name = String(child && child.name || "");
    if (!name.startsWith("__slice_")) {
      continue;
    }
    slices[name] = getNodeBounds(child);
  }

  const sliceNames = Object.keys(slices);
  if (sliceNames.length !== 9 && sliceNames.length !== 3) {
    return null;
  }

  const bounds = getNodeBounds(node);
  const left = readSliceWidth(slices, "__slice_top_left", "__slice_left", "__slice_bottom_left");
  const right = readSliceWidth(slices, "__slice_top_right", "__slice_right", "__slice_bottom_right");
  const top = readSliceHeight(slices, "__slice_top_left", "__slice_top", "__slice_top_right");
  const bottom = readSliceHeight(slices, "__slice_bottom_left", "__slice_bottom", "__slice_bottom_right");

  if (left <= 0 && right <= 0 && top <= 0 && bottom <= 0) {
    return null;
  }

  const border = {
    left: roundNumber(left),
    bottom: roundNumber(bottom),
    right: roundNumber(right),
    top: roundNumber(top)
  };
  const sliceKind = inferFigmaPrefabSliceKind(slices, sliceNames, border);
  const sourceVisibleSize = {
    width: Math.max(1, Math.round(bounds.width || 1)),
    height: Math.max(1, Math.round(bounds.height || 1))
  };
  return {
    border,
    sliceKind,
    sliceCount: sliceNames.length,
    minSize: buildFigmaPrefabNineSliceExportSize(border, sliceKind, sourceVisibleSize),
    sourceVisibleSize
  };
}

function inferFigmaPrefabSliceKind(slices, sliceNames, border) {
  const names = new Set(sliceNames || []);
  const hasH3Names = names.has("__slice_left") || names.has("__slice_center") || names.has("__slice_right");
  const hasV3Names = names.has("__slice_top") || names.has("__slice_middle") || names.has("__slice_bottom");
  if (names.size === 3 && hasH3Names && !hasV3Names) {
    return "h3slice";
  }
  if (names.size === 3 && hasV3Names && !hasH3Names) {
    return "v3slice";
  }
  const hasHorizontalBorder = border.left > 0 && border.right > 0;
  const hasVerticalBorder = border.top > 0 && border.bottom > 0;
  if (hasHorizontalBorder && !hasVerticalBorder) {
    return "h3slice";
  }
  if (!hasHorizontalBorder && hasVerticalBorder) {
    return "v3slice";
  }
  return "9slice";
}

function buildFigmaPrefabNineSliceExportSize(border, sliceKind, sourceVisibleSize) {
  const minWidth = Math.max(1, Math.round(border.left + border.right + 2));
  const minHeight = Math.max(1, Math.round(border.top + border.bottom + 2));
  if (sliceKind === "h3slice") {
    return {
      width: minWidth,
      height: Math.max(1, Math.round(sourceVisibleSize.height || minHeight))
    };
  }
  if (sliceKind === "v3slice") {
    return {
      width: Math.max(1, Math.round(sourceVisibleSize.width || minWidth)),
      height: minHeight
    };
  }
  return {
    width: minWidth,
    height: minHeight
  };
}

function readSliceWidth(slices, a, b, c) {
  const item = slices[a] || slices[b] || slices[c];
  return item ? positiveOr(item.width, 0) : 0;
}

function readSliceHeight(slices, a, b, c) {
  const item = slices[a] || slices[b] || slices[c];
  return item ? positiveOr(item.height, 0) : 0;
}

function hasRenderablePaint(paints) {
  if (!Array.isArray(paints)) {
    return false;
  }
  return paints.some((paint) => paint && paint.visible !== false && paint.type !== "NONE");
}

function hasPositiveBounds(node) {
  const bounds = getNodeBounds(node);
  return bounds.width > 0 && bounds.height > 0;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function safeFileName(value) {
  return String(value || "asset").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

// 查找节点所属页面，避免跨页面 selection 或 append 触发 Figma 限制。
function findContainingPage(node) {
  let current = node;
  while (current && current.type !== "PAGE") {
    current = current.parent;
  }
  return current && current.type === "PAGE" ? current : null;
}

// 切换到节点所在页面，确保后续导出和 selection 操作在同一页面内执行。
async function setCurrentPageForNode(node) {
  const page = findContainingPage(node);
  if (page && figma.currentPage !== page) {
    await figma.setCurrentPageAsync(page);
  }
}

function roundNumber(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

/** 根据检测到的网格布局创建可复用组件。 */
async function handleCreateGridComponent(message) {
  try {
    const result = await createGridComponentFromManifest(message.job || {});
    figma.ui.postMessage({
      type: "CREATE_GRID_COMPONENT_RESULT",
      requestId: message.requestId,
      result: Object.assign({ status: "completed" }, result)
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "CREATE_GRID_COMPONENT_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 根据预分析数据创建网格组件。 */
async function createGridComponentFromManifest(job) {
  const root = await figma.getNodeByIdAsync(String(job.rootNodeId));
  if (!root || !("children" in root)) {
    throw new Error("Root node not found: " + job.rootNodeId);
  }

  const componentName = String(job.componentName || "C_GridSlot");
  const slots = Array.isArray(job.slots) ? job.slots : [];
  if (slots.length < 2) {
    throw new Error("At least 2 slots are required to create grid component");
  }

  const refSlotIndex = numericOr(job.referenceSlotIndex, 0);
  const refSlot = slots[refSlotIndex];
  if (!refSlot) throw new Error("Reference slot " + refSlotIndex + " not found");

  // 收集参考 slot 节点并计算边界。
  const refNodes = [];
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const item of (refSlot.nodes || [])) {
    const node = await figma.getNodeByIdAsync(String(item.id));
    if (!node || node.parent !== root) continue;
    refNodes.push({ node, key: item.key || "" });
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  if (refNodes.length === 0) throw new Error("Reference slot " + refSlotIndex + " has no nodes");

  // 创建临时 Frame，并移入参考节点。
  const tempFrame = figma.createFrame();
  tempFrame.name = "_TMP_" + componentName;
  tempFrame.x = minX;
  tempFrame.y = minY;
  tempFrame.resize(Math.max(maxX - minX, 1), Math.max(maxY - minY, 1));
  tempFrame.fills = [];
  tempFrame.strokes = [];
  for (const { node } of refNodes) {
    tempFrame.appendChild(node);
    node.x -= minX;
    node.y -= minY;
  }
  root.appendChild(tempFrame);

  // 转换为 Component。
  const component = figma.createComponentFromNode(tempFrame);
  component.name = componentName;
  component.clipsContent = false;

  // 添加 Component Properties。
  const propKeys = {};
  const charNodeIds = new Set((job.textNodeIds || []).map(String));
  const boolNodeIdsSet = new Set((job.booleanNodeIds || []).map(String));
  const propDefs = {
    dayNumber: { type: "TEXT", defaultValue: "1" },
    isLocked: { type: "BOOLEAN", defaultValue: false },
    isToday: { type: "BOOLEAN", defaultValue: false },
    hasReward: { type: "BOOLEAN", defaultValue: false },
    rewardCount: { type: "TEXT", defaultValue: "0" },
  };
  for (const [propName, def] of Object.entries(propDefs)) {
    propKeys[propName] = component.addComponentProperty(propName, def.type, def.defaultValue);
  }

  // 将属性绑定到子节点。
  for (const child of component.children) {
    const nodeId = child.id;
    const childName = String(child.name || "").toLowerCase();
    if (charNodeIds.has(nodeId)) {
      if (childName.includes("1__text") || childName.match(/\d+__text$/)) {
        // DayNumber: any child that is a number text
        child.componentPropertyReferences = { characters: propKeys.dayNumber };
      } else if (childName.includes("9__text") || childName.includes("reward")) {
        child.componentPropertyReferences = { characters: propKeys.rewardCount };
      }
    }
    if (boolNodeIdsSet.has(nodeId)) {
      if (childName.includes("lock") || childName.includes("common")) {
        child.componentPropertyReferences = { visible: propKeys.isLocked };
      } else if (childName.includes("icon_hd") || childName.includes("reward")) {
        child.componentPropertyReferences = { visible: propKeys.hasReward };
      }
    }
    if (job.variantNodeId && nodeId === String(job.variantNodeId)) {
      // 根据 isToday 属性切换背景可见性。
      child.componentPropertyReferences = { visible: propKeys.isToday };
    }
  }

  // 将 Component 放回参考 slot 位置。
  component.x = (refSlot.bounds && refSlot.bounds.x) || minX;
  component.y = (refSlot.bounds && refSlot.bounds.y) || minY;

  // 为每个非参考 slot 创建 Instance。
  const createdInstances = [];
  for (let si = 0; si < slots.length; si++) {
    const slot = slots[si];
    if (si === refSlotIndex) {
      createdInstances.push({ slotIndex: si, instanceId: component.id, x: component.x, y: component.y, properties: slot.properties || {} });
      continue;
    }
    // 删除 slot 的原节点。
    for (const item of (slot.nodes || [])) {
      const node = await figma.getNodeByIdAsync(String(item.id));
      if (node && node.parent === root) node.remove();
    }
    const instance = component.createInstance();
    root.appendChild(instance);
    instance.x = (slot.bounds && slot.bounds.x) || (si * 133);
    instance.y = (slot.bounds && slot.bounds.y) || minY;

    const props = {};
    if (slot.properties) {
      if (slot.properties.dayNumber) props[propKeys.dayNumber] = String(slot.properties.dayNumber);
      props[propKeys.isLocked] = !!slot.properties.isLocked;
      props[propKeys.isToday] = !!slot.properties.isToday;
      props[propKeys.hasReward] = !!slot.properties.hasReward;
      if (slot.properties.rewardCount) props[propKeys.rewardCount] = String(slot.properties.rewardCount);
    }
    instance.setProperties(props);
    createdInstances.push({ slotIndex: si, instanceId: instance.id, x: instance.x, y: instance.y, properties: slot.properties || {} });
  }

  return {
    componentId: component.id,
    componentName: component.name,
    instanceCount: createdInstances.length,
    instances: createdInstances,
    properties: Object.keys(propDefs)
  };
}

/** 查询当前 Figma 页面选中的节点，返回节点、页面与文件信息。 */
async function handleQuerySelection(message) {
  try {
    const sel = figma.currentPage.selection;
    const nodes = sel.map(function(n) {
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        width: Math.round(n.width || 0),
        height: Math.round(n.height || 0)
      };
    });
    const fileKey = figma.fileKey || "";
    const pageName = figma.currentPage.name;
    // 尝试从 figma.root 获取文档名。
    const docName = figma.root && figma.root.name ? figma.root.name : "";
    figma.ui.postMessage({
      type: "QUERY_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        fileKey: fileKey,
        docName: docName,
        pageName: pageName,
        nodes: nodes,
        count: nodes.length
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

/** Switch the active page and current selection for MCP-driven workflows. */
async function handleSetContext(message) {
  try {
    const job = message.job || {};
    const pageId = String(job.pageId || "").trim();
    const pageName = String(job.pageName || "").trim();
    const rawSelectionNodeIds = Array.isArray(job.selectionNodeIds) ? job.selectionNodeIds : null;
    const clearSelection = job.clearSelection !== false && !rawSelectionNodeIds;

    let page = null;
    if (pageId) {
      page = await findNodeAcrossPages(pageId);
      if (!page || page.type !== "PAGE") {
        throw new Error("pageId not found or is not PAGE: " + pageId);
      }
    } else if (pageName) {
      try { await figma.loadAllPagesAsync(); } catch (e) { /* dynamic-page mode may reject this; fall back to loaded pages */ }
      const matches = (figma.root.children || []).filter(function(candidate) {
        return candidate && candidate.type === "PAGE" && candidate.name === pageName;
      });
      if (matches.length === 0) {
        throw new Error("pageName not found: " + pageName);
      }
      if (matches.length > 1) {
        throw new Error("pageName is ambiguous: " + pageName);
      }
      page = matches[0];
    } else {
      page = figma.currentPage;
    }

    if (page && figma.currentPage !== page) {
      await figma.setCurrentPageAsync(page);
    }

    const selectionNodes = [];
    if (rawSelectionNodeIds) {
      for (const rawId of rawSelectionNodeIds) {
        const nodeId = String(rawId || "").trim();
        if (!nodeId) {
          continue;
        }
        const node = await findNodeAcrossPages(nodeId);
        if (!node) {
          throw new Error("selection node not found: " + nodeId);
        }
        if (node.type === "PAGE" || node.type === "DOCUMENT") {
          throw new Error("selection node cannot be " + node.type + ": " + nodeId);
        }
        const nodePage = findContainingPage(node);
        if (!nodePage || nodePage.id !== figma.currentPage.id) {
          throw new Error("selection node is not on target page: " + nodeId);
        }
        selectionNodes.push(node);
      }
      figma.currentPage.selection = selectionNodes;
    } else if (clearSelection) {
      figma.currentPage.selection = [];
    }

    figma.viewport.scrollAndZoomIntoView(
      figma.currentPage.selection && figma.currentPage.selection.length > 0
        ? figma.currentPage.selection
        : [figma.currentPage]
    );

    const nodes = (figma.currentPage.selection || []).map(function(n) {
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        width: Math.round(n.width || 0),
        height: Math.round(n.height || 0)
      };
    });
    figma.ui.postMessage({
      type: "SET_CONTEXT_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        fileKey: figma.fileKey || "",
        docName: figma.root && figma.root.name ? figma.root.name : "",
        pageId: figma.currentPage && figma.currentPage.id ? figma.currentPage.id : "",
        pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
        nodes: nodes,
        count: nodes.length
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "SET_CONTEXT_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

async function handleQueryNodeChildren(message) {
  try {
    const nodeId = String((message.job && message.job.nodeId) || "");
    if (!nodeId) {
      figma.ui.postMessage({
        type: "QUERY_NODE_CHILDREN_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["missing nodeId"] }
      });
      return;
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      figma.ui.postMessage({
        type: "QUERY_NODE_CHILDREN_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["node not found: " + nodeId] }
      });
      return;
    }
    if (!("children" in node)) {
      figma.ui.postMessage({
        type: "QUERY_NODE_CHILDREN_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["node has no children: " + node.type] }
      });
      return;
    }
    const children = [];
    for (const child of node.children) {
      const info = {
        id: child.id,
        name: child.name,
        type: child.type,
        x: Math.round(child.x),
        y: Math.round(child.y),
        width: Math.round(child.width),
        height: Math.round(child.height),
        visible: child.visible,
        opacity: child.opacity,
      };
      if ("children" in child) {
        info.childCount = child.children.length;
      }
      if (child.type === "TEXT") {
        info.characters = child.characters;
      }
      children.push(info);
    }
    figma.ui.postMessage({
      type: "QUERY_NODE_CHILDREN_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        nodeId: nodeId,
        nodeName: node.name,
        nodeType: node.type,
        childCount: children.length,
        children: children,
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_NODE_CHILDREN_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 递归收集节点子树内的 Component 和 ComponentSet。 */
function collectReusableComponents(node, output) {
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    output.push(node);
  }
  if ("children" in node) {
    for (const child of node.children) {
      collectReusableComponents(child, output);
    }
  }
}

/** 规范化组件名：去前缀、转小写、移除分隔符。 */
function normalizeComponentName(name) {
  let n = String(name || "");
  for (const prefix of ["Common_", "Common-", "common_", "common-"]) {
    if (n.startsWith(prefix)) { n = n.slice(prefix.length); break; }
  }
  return n.toLowerCase().replace(/[\s\-_\[\]().]/g, "");
}

/** 收集指定节点列表中的所有组件，返回带规范化索引的结构。 */
async function collectComponents(job) {
  const libraryNodeIds = job.libraryNodeIds || ["62:115", "2896:32"];
  const results = {};

  for (const nodeId of libraryNodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (!node) {
      results[nodeId] = { error: `节点 ${nodeId} 不存在，请确认当前文件是资源库` };
      continue;
    }
    const raw = [];
    collectReusableComponents(node, raw);
    const components = raw.map(function(c) {
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        width: Math.round(c.width || 0),
        height: Math.round(c.height || 0)
      };
    });
    const normalized = {};
    for (const comp of components) {
      const key = normalizeComponentName(comp.name);
      if (normalized[key]) {
        const existing = normalized[key];
        if (Array.isArray(existing)) {
          existing.push(comp);
        } else {
          normalized[key] = [existing, comp];
        }
      } else {
        normalized[key] = comp;
      }
    }
    results[nodeId] = { count: components.length, components: components, normalized: normalized };
  }
  return { libraries: results };
}

/** 批量设置节点坐标。接受 plan.positions[{nodeId, x, y}] */
async function setHierarchyNodePositionsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const positions = plan.positions || [];

  if (!Array.isArray(positions) || positions.length === 0) {
    throw new Error("FIGMA_HIERARCHY_SET_NODE_POSITIONS missing plan.positions");
  }

  const updated = [];
  const errors = [];
  const beforeBounds = {};

  for (const pos of positions) {
    const nodeId = String(pos.nodeId || "");
    if (!nodeId) { errors.push("position entry missing nodeId"); continue; }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) { errors.push("Node not found: " + nodeId); continue; }
    beforeBounds[nodeId] = { x: node.x, y: node.y, width: node.width, height: node.height };
    if (typeof pos.x === "number") node.x = pos.x;
    if (typeof pos.y === "number") node.y = pos.y;
    updated.push({ nodeId, x: node.x, y: node.y, width: node.width, height: node.height });
  }

  return {
    status: errors.length === 0 ? "completed" : "partial",
    allPass: errors.length === 0,
    updatedCount: updated.length,
    plannedCount: positions.length,
    updated,
    errors,
    warnings: [],
    checks: {
      allUpdated: { pass: updated.length === positions.length, updated: updated.length, planned: positions.length }
    },
    summary: { updatedCount: updated.length, errorCount: errors.length },
    artifacts: { plan, beforeBounds, updated },
    screenshot: options.includeScreenshot ? await exportNodePngScreenshot(updated[0] ? await figma.getNodeByIdAsync(updated[0].nodeId) : null) : null
  };
}

/** 处理 FIGMA_HIERARCHY_SET_NODE_POSITIONS 请求 */
async function handleFigmaHierarchySetNodePositions(message) {
  try {
    const job = message && message.job ? message.job : (message.plan || message);
    const result = await setHierarchyNodePositionsJob(job);
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_SET_NODE_POSITIONS_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_SET_NODE_POSITIONS_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        allPass: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        blockingErrors: [error instanceof Error ? { code: "setPositionException", message: error.message } : { code: "setPositionException", message: String(error) }]
      }
    });
  }
}

/** 跨组移动节点，保留被移动节点的绝对位置并返回可验收的检查结果。 */
async function moveHierarchyChildrenJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const sourceNodeId = String(plan.sourceNodeId || (job && job.target && job.target.nodeId) || "");
  if (!sourceNodeId) throw new Error("FIGMA_HIERARCHY_MOVE_NODES missing sourceNodeId");
  if (!Array.isArray(plan.moves) || plan.moves.length === 0) throw new Error("FIGMA_HIERARCHY_MOVE_NODES missing plan.moves");

  const source = await figma.getNodeByIdAsync(sourceNodeId).catch(() => null);
  if (!source) throw new Error("Source node not found: " + sourceNodeId);
  if (!("children" in source)) throw new Error("Source node has no children: " + source.type);

  await setCurrentPageForNode(source);
  const removeEmptySource = plan.removeEmptySource !== false;
  const plannedMoves = normalizeHierarchyMovePlan(plan.moves);
  const allPlannedIds = plannedMoves.map((item) => item.childId);
  const duplicateIds = allPlannedIds.filter((id, index) => allPlannedIds.indexOf(id) !== index);
  const movedNodes = [];
  const errors = [];
  const warnings = [];
  const beforeParents = {};
  const beforeBounds = {};
  const afterRecords = [];
  const targetByChildId = {};
  const moveRecords = [];

  for (const duplicateId of uniqueStrings(duplicateIds)) {
    errors.push("Duplicate childId in move plan: " + duplicateId);
  }

  for (const item of plannedMoves) {
    if (!item.targetParentId) { errors.push("move missing targetParentId"); continue; }
    if (!item.childId) { errors.push("move missing childId"); continue; }
    const target = await figma.getNodeByIdAsync(item.targetParentId).catch(() => null);
    if (!target || typeof target.appendChild !== "function") {
      errors.push("Target node not found or not a container: " + item.targetParentId);
      continue;
    }
    const child = await figma.getNodeByIdAsync(item.childId).catch(() => null);
    if (!child) { errors.push("Child not found: " + item.childId); continue; }
    if (!isHierarchyDescendantOf(child, source)) {
      errors.push("Child is not inside source: " + item.childId);
      continue;
    }
    if (child === target || isHierarchyDescendantOf(target, child)) {
      errors.push("Cannot move node into itself or its descendant: " + item.childId + " -> " + item.targetParentId);
      continue;
    }
    moveRecords.push({ child, target, childId: item.childId, targetParentId: item.targetParentId });
  }

  for (const record of moveRecords) {
    const child = record.child;
    const target = record.target;
    beforeParents[child.id] = child.parent ? child.parent.id : null;
    beforeBounds[child.id] = boundsToManifest(getNodeBounds(child));
    // 检测从备份帧移出节点 → 坐标污染警告
    const parent = child.parent;
    if (parent && isBackupFrame(parent)) {
      warnings.push({
        code: "moveFromBackupFrame",
        message: `节点 "${child.name}" 从备份帧 "${parent.name}" 移出，坐标可能已偏移。建议用 clone-node 从原始位置克隆。`,
        details: { childId: child.id, childName: child.name, parentId: parent.id, parentName: parent.name }
      });
    }
    // 检测移入备份帧 → 不影响视觉但告知
    if (target && isBackupFrame(target)) {
      warnings.push({
        code: "moveIntoBackupFrame",
        message: `节点 "${child.name}" 移入备份帧 "${target.name}"，坐标会被重排。后续从此帧移回会有坐标污染。`,
        details: { childId: child.id, childName: child.name, targetId: target.id, targetName: target.name }
      });
    }
  }

  if (errors.length === 0) {
    for (const record of moveRecords) {
      const child = record.child;
      const target = record.target;
      try {
        target.appendChild(child);
        preserveHierarchyChildAbsoluteBounds(child, target, beforeBounds[child.id]);
        movedNodes.push(child.id);
        targetByChildId[child.id] = target.id;
        afterRecords.push(buildHierarchyMoveAfterRecord(child, target));
      } catch (error) {
        errors.push(`Move failed for ${record.childId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  let sourceRemoved = false;
  if (removeEmptySource && "children" in source && source.children.length === 0) {
    source.remove();
    sourceRemoved = true;
  } else if (removeEmptySource && "children" in source && source.children.length > 0) {
    warnings.push("Source node was not removed because it still has children.");
  }

  const finalRecords = await collectHierarchyMovedNodeRecords(allPlannedIds, targetByChildId, beforeBounds);
  const driftNodes = collectHierarchyMoveBoundsDrift(finalRecords, beforeBounds, 0.01);
  const finalParentMismatches = finalRecords.filter((item) => item.expectedParentId && item.parentId !== item.expectedParentId);
  const missingAfter = allPlannedIds.filter((id) => !finalRecords.some((item) => item.id === id));
  const checks = {
    noRuntimeErrors: { pass: errors.length === 0, errors },
    childSetPreserved: {
      pass: movedNodes.length === allPlannedIds.length && uniqueStrings(movedNodes).length === uniqueStrings(allPlannedIds).length && missingAfter.length === 0,
      moved: movedNodes.length,
      planned: allPlannedIds.length,
      missingAfter,
      duplicateIds: uniqueStrings(duplicateIds)
    },
    finalParentsMatchPlan: {
      pass: finalParentMismatches.length === 0,
      mismatches: finalParentMismatches
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    sourceHandled: {
      pass: removeEmptySource ? sourceRemoved || ("children" in source && source.children.length > 0) : true,
      removeEmptySource,
      sourceRemoved,
      remainingChildren: !sourceRemoved && "children" in source ? source.children.length : 0
    }
  };
  const blockingErrors = buildHierarchyMoveBlockingErrors(checks);
  const screenshotTarget = await resolveHierarchyMoveScreenshotTarget(source, sourceRemoved, finalRecords);
  const screenshot = options.includeScreenshot ? await exportNodePngScreenshot(screenshotTarget) : null;

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    sourceNodeId,
    sourceRemoved,
    movedNodeCount: movedNodes.length,
    plannedCount: allPlannedIds.length,
    movedNodes,
    errors,
    warnings,
    blockingErrors,
    checks,
    summary: { movedCount: movedNodes.length, sourceRemoved, errorCount: errors.length, blockingErrorCount: blockingErrors.length },
    artifacts: { plan, beforeParents, beforeBounds, movedNodes, targetByChildId, afterRecords, finalRecords },
    screenshot
  };
}

/** 将移动计划展平为 childId -> targetParentId 记录，方便后续 O(n) 校验。 */
function normalizeHierarchyMovePlan(moves) {
  const output = [];
  for (const move of moves || []) {
    const targetParentId = String(move && move.targetParentId || "");
    for (const childId of (move && move.childIds) || []) {
      output.push({ targetParentId, childId: String(childId || "") });
    }
  }
  return output;
}

/** 判断 node 是否位于 ancestor 子树内。 */
function isHierarchyDescendantOf(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** 生成移动后的节点记录，供结果报告和漂移校验使用。 */
function buildHierarchyMoveAfterRecord(child, target) {
  return {
    id: child.id,
    name: child.name || "",
    type: child.type,
    parentId: child.parent ? child.parent.id : "",
    expectedParentId: target ? target.id : "",
    bounds: boundsToManifest(getNodeBounds(child))
  };
}

/** 收集计划节点最终状态，包含未移动成功的节点，用于阻塞错误判断。 */
async function collectHierarchyMovedNodeRecords(plannedIds, targetByChildId, beforeBounds) {
  const output = [];
  for (const childId of uniqueStrings(plannedIds)) {
    const node = await figma.getNodeByIdAsync(childId).catch(() => null);
    if (!node) {
      continue;
    }
    output.push({
      id: node.id,
      name: node.name || "",
      type: node.type,
      parentId: node.parent ? node.parent.id : "",
      expectedParentId: targetByChildId[node.id] || "",
      beforeBounds: beforeBounds[node.id] || null,
      bounds: boundsToManifest(getNodeBounds(node))
    });
  }
  return output;
}

/** 检查跨父节点移动后 absolute bounds 是否保持不变。 */
function collectHierarchyMoveBoundsDrift(finalRecords, beforeBoundsById, tolerance) {
  const driftNodes = [];
  for (const record of finalRecords || []) {
    const before = beforeBoundsById[record.id];
    if (!before) {
      continue;
    }
    const after = record.bounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({ nodeId: record.id, name: record.name, delta: roundNumber(delta), before, after });
    }
  }
  return driftNodes;
}

/** 根据 move 检查项生成阻塞错误，避免部分移动被误判成功。 */
function buildHierarchyMoveBlockingErrors(checks) {
  const errors = [];
  for (const key of Object.keys(checks)) {
    const check = checks[key];
    if (check && check.pass === false) {
      errors.push({
        code: key,
        message: `Figma 跨组移动检查失败：${key}`,
        details: check
      });
    }
  }
  return errors;
}

/** 选择移动任务截图目标，避免对已经删除的 source 节点导出截图。 */
async function resolveHierarchyMoveScreenshotTarget(source, sourceRemoved, finalRecords) {
  if (!sourceRemoved && source && "exportAsync" in source) {
    return source;
  }
  const firstRecord = finalRecords && finalRecords[0];
  if (firstRecord && firstRecord.parentId) {
    return await figma.getNodeByIdAsync(firstRecord.parentId).catch(() => null);
  }
  return null;
}

/** 处理 FIGMA_HIERARCHY_MOVE_NODES 请求 */
async function handleFigmaHierarchyMoveNodes(message) {
  try {
    const job = message && message.job ? message.job : (message.plan || message);
    const result = await moveHierarchyChildrenJob(job);
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_MOVE_NODES_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_MOVE_NODES_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        allPass: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        blockingErrors: [error instanceof Error ? { code: "moveException", message: error.message } : { code: "moveException", message: String(error) }]
      }
    });
  }
}

/** 处理 FIGMA_CLONE_NODE：复制指定节点为同级隐藏备份 */
async function handleFigmaCloneNode(message) {
  try {
    const job = message && message.job ? message.job : {};
    const target = job.target || {};
    const plan = job.plan || {};
    const nodeId = String(target.nodeId || plan.nodeId || "");
    if (!nodeId) {
      throw new Error("FIGMA_CLONE_NODE 缺少 nodeId");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error("节点未找到：" + nodeId);
    }
    const page = findContainingPage(node) || figma.currentPage;
    const clone = node.clone();
    page.appendChild(clone);
    // 默认放在原节点右侧 100px 处
    const offsetX = plan.offsetX !== undefined ? plan.offsetX : node.width + 100;
    const offsetY = plan.offsetY !== undefined ? plan.offsetY : 0;
    clone.x = node.x + offsetX;
    clone.y = node.y + offsetY;
    // 默认隐藏
    const hideClone = plan.hideClone !== false;
    if (hideClone) clone.visible = false;
    // 默认添加 [Backup] 前缀
    const backupPrefix = plan.backupPrefix !== false;
    if (backupPrefix) {
      clone.name = `[Backup]${node.name || ""}`;
    }
    figma.ui.postMessage({
      type: "FIGMA_CLONE_NODE_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        allPass: true,
        cloneId: clone.id,
        cloneName: clone.name,
        originalBounds: { x: node.x, y: node.y, width: node.width, height: node.height },
        cloneBounds: { x: clone.x, y: clone.y, width: clone.width, height: clone.height },
        visible: clone.visible,
        summary: { cloned: true, backupName: clone.name }
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_CLONE_NODE_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        allPass: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        blockingErrors: [{ code: "cloneException", message: error instanceof Error ? error.message : String(error) }]
      }
    });
  }
}
// 执行一次 PSD manifest_summary 导入，入口只消费 JSON 数据和 PNG 字节，不手动转录坐标。
async function importPsdJob(job, assets) {
  const startTime = Date.now();
  const manifest = normalizeManifest(job && job.manifest);
  const assetBytes = buildAssetBytesMap(assets);
  const context = {
    job,
    manifest,
    assetBytes,
    componentIndexes: await buildComponentIndexes(job),
    commonReports: [],
    sliceReports: [],
    textReports: [],
    imageHashes: new Map(),
    nodeByLayerIdx: new Map(),
    warnings: [],
    errors: [],
    stats: {
      image: 0,
      text: 0,
      commonInstance: 0,
      commonFallbackImage: 0,
      nineSlice: 0,
      slice: 0
    }
  };

  const root = await createRootFrame(job, manifest);
  const orderedLayers = manifest.layers.slice().sort((a, b) => numericOr(a.idx, 0) - numericOr(b.idx, 0));
  for (const layer of orderedLayers) {
    try {
      const node = await createLayerNode(root, layer, context);
      if (node) {
        context.nodeByLayerIdx.set(String(layer.idx), node.id);
      }
    } catch (error) {
      context.errors.push(`${layer.idx}:${layer.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await ensurePsdIndexOrder(root, orderedLayers, context);
  const validation = await validateImportedRoot(root, orderedLayers, context);
  const screenshot = await exportRootScreenshot(root, context);
  validation.screenshotExported = !!screenshot;
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);

  return {
    status: buildFinalStatus(context, validation),
    rootNodeId: root.id,
    rootName: root.name,
    createdCount: countDescendants(root),
    screenshot,
    summary: {
      layerCount: orderedLayers.length,
      stats: context.stats,
      validation,
      reports: {
        common: context.commonReports,
        slices: context.sliceReports,
        text: context.textReports
      },
      durationMs: Date.now() - startTime
    },
    warnings: context.warnings,
    errors: context.errors
  };
}

// 只读计算 PSD 增量差异；此阶段不得修改 Figma 文档。
async function previewPsdIncrementalUpdate(job, assets) {
  const prepared = await preparePsdIncrementalUpdate(job, assets);
  return buildPsdIncrementalResult(prepared, prepared.diff.status);
}

// Adopt the current manifest as legacy source truth without changing canvas fields.
async function adoptPsdIncrementalBaseline(job, assets) {
  const prepared = await preparePsdIncrementalUpdate(job, assets);
  const matched = prepared.diff.baselineRequired;
  if (prepared.diff.conflicts.length > 0 || matched.length === 0) {
    return buildPsdIncrementalResult(prepared, "baseline-adopt-blocked");
  }
  const protectedBefore = capturePsdProtectedSnapshot(prepared.target);
  const nodeMetadataBefore = matched.map((pair) => ({
    node: pair.target.node,
    metadata: capturePsdLayerMetadata(pair.target.node)
  }));
  const rootMetadataBefore = capturePsdRootMetadata(prepared.target);
  try {
    for (const pair of matched) {
      writeLayerMetadata(pair.target.node, pair.source, {});
    }
    writePsdRootMetadata(prepared.target, job, prepared.manifest);
    const errors = verifyPsdProtectedSnapshot(protectedBefore);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    if (typeof figma.commitUndo === "function") {
      figma.commitUndo();
    }
    return {
      status: "baseline-adopted",
      targetNodeId: prepared.target.id,
      adoptedCount: matched.length,
      warnings: prepared.context.warnings,
      errors: []
    };
  } catch (error) {
    for (const record of nodeMetadataBefore) {
      writePluginData(record.node, record.metadata);
    }
    writePluginData(prepared.target, rootMetadataBefore);
    throw error;
  }
}

// 重新校验预览指纹后，仅替换 PSD 拥有的像素或文字内容。
async function applyPsdIncrementalUpdate(job, assets) {
  const prepared = await preparePsdIncrementalUpdate(job, assets);
  const expectedFingerprint = String(job && job.baselineFingerprint || "");
  if (prepared.diff.status !== "preview-ready") {
    return buildPsdIncrementalResult(prepared, "apply-blocked");
  }
  if (!expectedFingerprint || expectedFingerprint !== prepared.baselineFingerprint) {
    prepared.diff.conflicts.push({
      kind: "stale-preview",
      message: "Figma 节点或 PSD 内容在确认前发生了变化，请重新预览。"
    });
    refreshPsdIncrementalDiffStatus(prepared.diff);
    return buildPsdIncrementalResult(prepared, "apply-blocked");
  }

  await preloadPsdMutationAssets(prepared);
  const structureBefore = capturePsdStructuralSnapshot(prepared.target);
  const rollbackRecords = prepared.plans.map((plan) => capturePsdMutationRollback(plan.target.node));
  const addedTransaction = preparePsdAddedLayerTransaction();
  prepared.rootMetadataBefore = capturePsdRootMetadata(prepared.target);
  try {
    await applyPsdAddedLayers(prepared, addedTransaction);
    await applyPsdMutationPlans(prepared);
    const verificationErrors = verifyPsdStructuralSnapshot(structureBefore, addedTransaction.createdNodeIds)
      .concat(verifyPsdAppliedFields(prepared.plans))
      .concat(verifyPsdAddedNodes(
        addedTransaction.createdNodes,
        prepared.diff.added,
        addedTransaction.stagingFrame,
        prepared.context
      ));
    if (verificationErrors.length > 0) {
      throw new Error(`PSD incremental verification failed: ${verificationErrors.slice(0, 8).join("; ")}`);
    }
    for (const plan of prepared.plans) {
      writeLayerMetadata(
        plan.target.node,
        plan.source,
        buildPsdIncrementalMetadataExtra(plan, prepared)
      );
    }
    writePsdRootMetadata(prepared.target, job, prepared.manifest);
    if (typeof figma.commitUndo === "function") {
      figma.commitUndo();
    }
  } catch (error) {
    const rollbackErrors = await rollbackPsdIncrementalMutation(rollbackRecords, addedTransaction, prepared);
    rollbackErrors.push(...verifyPsdStructuralSnapshot(structureBefore, new Set()));
    rollbackErrors.push(...verifyPsdRollbackRecords(rollbackRecords));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length > 0 ? `${message}; rollback drift: ${rollbackErrors.join("; ")}` : message);
  }

  const result = buildPsdIncrementalResult(prepared, "applied");
  result.updatedCount = prepared.plans.length;
  result.addedCount = prepared.diff.added.length;
  result.retainedMissingCount = prepared.diff.missing.length;
  result.stagingFrameId = addedTransaction.stagingFrame ? addedTransaction.stagingFrame.id : "";
  return result;
}

async function preparePsdIncrementalUpdate(job, assets) {
  const manifest = normalizeManifest(job && job.manifest);
  const target = await resolvePsdIncrementalTarget(job);
  const context = {
    job,
    manifest,
    assetBytes: buildAssetBytesMap(assets),
    componentIndexes: await buildComponentIndexes(job),
    commonReports: [],
    sliceReports: [],
    textReports: [],
    imageHashes: new Map(),
    nodeByLayerIdx: new Map(),
    warnings: [],
    errors: [],
    stats: { image: 0, text: 0, commonInstance: 0, commonFallbackImage: 0, nineSlice: 0, slice: 0 }
  };
  const currentNodes = collectPsdBoundNodes(target);
  const diff = buildPsdIncrementalDiff(currentNodes, manifest.layers);
  appendPsdIncrementalRuntimeConflicts(diff, target, currentNodes, job, manifest);
  appendPsdIncrementalAssetConflicts(diff, context);
  const plans = diff.changed.map(buildPsdLayerMutationPlan);
  appendPsdMutationPreflightConflicts(diff, plans, target);
  if (diff.identityWarning) {
    context.warnings.push(diff.identityWarning);
  }
  return {
    target,
    manifest,
    context,
    diff,
    plans,
    baselineFingerprint: buildPsdIncrementalFingerprint(target, currentNodes, manifest.layers)
  };
}

function appendPsdMutationPreflightConflicts(diff, plans, target) {
  for (const plan of plans) {
    const node = plan.target.node;
    const requiresGeometry = plan.categories.some((category) => (
      category === "position" || category === "size" || category === "rotation"
    ));
    if (!node || node.removed) {
      diff.conflicts.push({ kind: "missing-target-node", layerId: plan.layerId, nodeId: plan.nodeId });
      continue;
    }
    if (node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      diff.conflicts.push({ kind: "unsafe-component-boundary-write", layerId: plan.layerId, nodeId: plan.nodeId });
      continue;
    }
    if (requiresGeometry) {
      const parent = node.parent;
      if (!parent || !target.absoluteTransform || !parent.absoluteTransform) {
        diff.conflicts.push({ kind: "missing-transform-context", layerId: plan.layerId, nodeId: plan.nodeId });
        continue;
      }
      if (parent.layoutMode && parent.layoutMode !== "NONE" && node.layoutPositioning !== "ABSOLUTE") {
        diff.conflicts.push({ kind: "unsafe-auto-layout-geometry", layerId: plan.layerId, nodeId: plan.nodeId });
        continue;
      }
      if (!("x" in node) || !("y" in node) || typeof node.resize !== "function") {
        diff.conflicts.push({ kind: "unsupported-geometry-target", layerId: plan.layerId, nodeId: plan.nodeId });
        continue;
      }
      try {
        plan.expectedGeometry = computePsdGeometryTarget({
          baseline: plan.baseline.geometry,
          incoming: plan.incoming.geometry,
          currentAbsolute: getHierarchyNodeAbsolutePosition(node),
          currentSize: { width: node.width, height: node.height },
          currentRotation: numericOr(node.rotation, 0),
          rootAbsoluteTransform: target.absoluteTransform,
          parentAbsoluteTransform: parent.absoluteTransform
        });
        if (!(plan.expectedGeometry.size.width > 0) || !(plan.expectedGeometry.size.height > 0)) {
          throw new Error("invalid-target-size");
        }
      } catch (error) {
        diff.conflicts.push({
          kind: error instanceof Error ? error.message : "invalid-geometry-plan",
          layerId: plan.layerId,
          nodeId: plan.nodeId
        });
      }
    }
    if (plan.categories.includes("display")) {
      for (const path of plan.changedPaths.filter((value) => value.startsWith("display."))) {
        const property = path.slice("display.".length);
        if (!(property in node)) {
          diff.conflicts.push({ kind: `unsupported-display-${property}`, layerId: plan.layerId, nodeId: plan.nodeId });
        }
      }
    }
    if ((plan.categories.includes("textContent") || plan.categories.includes("textStyle")) && node.type !== "TEXT") {
      diff.conflicts.push({ kind: "unsupported-text-target", layerId: plan.layerId, nodeId: plan.nodeId });
    }
    if (plan.categories.includes("content") && plan.incoming.mode === "image" && node.type !== "RECTANGLE") {
      diff.conflicts.push({ kind: "unsupported-image-target", layerId: plan.layerId, nodeId: plan.nodeId });
    }
    if (plan.categories.includes("nineSlice") && (node.type !== "FRAME" || !("children" in node))) {
      diff.conflicts.push({ kind: "unsupported-nine-slice-target", layerId: plan.layerId, nodeId: plan.nodeId });
    }
  }
  refreshPsdIncrementalDiffStatus(diff);
}

async function resolvePsdIncrementalTarget(job) {
  const nodeId = String(job && job.targetNodeId || "");
  if (!nodeId) {
    throw new Error("增量更新缺少 targetNodeId。");
  }
  const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!node) {
    throw new Error(`找不到增量更新目标：${nodeId}`);
  }
  if (node.type !== "FRAME" && node.type !== "COMPONENT") {
    throw new Error(`增量更新只支持 FRAME 或 COMPONENT，当前为 ${node.type}。`);
  }
  return node;
}

function collectPsdBoundNodes(root) {
  const found = [];
  const visit = (node) => {
    if (isCleanupRecoveryNode(node)) return;
    const layerId = normalizePsdLayerId(readSharedPluginData(node, "psdLayerId"));
    if (layerId) {
      const storedSourceState = readStoredPsdSourceState(node);
      found.push({
        layerId,
        nodeId: node.id,
        node,
        name: String(node.name || ""),
        nodeType: node.type,
        contentHash: readSharedPluginData(node, "psdContentHash"),
        ownership: readSharedPluginData(node, "psdOwnership"),
        sourceState: storedSourceState.state,
        sourceStateHash: readSharedPluginData(node, "psdSourceStateHash"),
        sourceStateError: storedSourceState.error,
        parentId: node.parent ? node.parent.id : "",
        siblingIndex: node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1,
        liveContentSignature: buildPsdLiveContentSignature(node, readSharedPluginData(node, "psdOwnership")),
        liveWritableFieldSignature: buildPsdLiveWritableFieldSignature(node),
        transformSignature: hashPsdSourceState({
          absoluteTransform: node.absoluteTransform || null,
          parentAbsoluteTransform: node.parent && node.parent.absoluteTransform || null
        })
      });
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return found;
}

function readStoredPsdSourceState(node) {
  const raw = readSharedPluginData(node, "psdSourceState");
  if (!raw) return { state: null, error: "" };
  try {
    const parsed = JSON.parse(raw);
    const state = normalizePsdSourceState({ sourceState: parsed });
    return state && state.layerId
      ? { state, error: "" }
      : { state: null, error: "invalid-stored-source-state" };
  } catch (error) {
    return { state: null, error: "invalid-stored-source-state" };
  }
}

function appendPsdIncrementalRuntimeConflicts(diff, target, currentNodes, job, manifest) {
  const schemaVersion = readSharedPluginData(target, "psdImportSchemaVersion") || readSharedPluginData(target, "psdSchemaVersion");
  if (schemaVersion !== "2" && schemaVersion !== "3") {
    diff.conflicts.push({ kind: "missing-target-metadata", message: "目标不是带增量元数据的 PSD 导入结果。" });
  }
  for (const current of currentNodes) {
    if (current.sourceStateError) {
      diff.conflicts.push({
        kind: current.sourceStateError,
        layerId: current.layerId,
        nodeId: current.nodeId
      });
    }
  }
  const storedWidth = numericOr(readSharedPluginData(target, "psdCanvasWidth"), 0);
  const storedHeight = numericOr(readSharedPluginData(target, "psdCanvasHeight"), 0);
  if (storedWidth !== manifest.canvas.width || storedHeight !== manifest.canvas.height) {
    diff.conflicts.push({ kind: "source-canvas-mismatch", expected: `${storedWidth}x${storedHeight}`, actual: `${manifest.canvas.width}x${manifest.canvas.height}` });
  }
  const identity = measurePsdLayerIdentity(currentNodes, manifest.layers);
  const storedFileName = readSharedPluginData(target, "psdSourceFileName");
  const incomingFileName = normalizedPsdSourceFileName(job);
  const fileNameChanged = !!(storedFileName && incomingFileName && storedFileName !== incomingFileName);
  if (identity.currentCount === 0 && identity.incomingCount > 0) {
    diff.conflicts.push({ kind: "no-bound-target-layers", message: "目标中没有可匹配的 PSD Layer ID。" });
  } else if (!fileNameChanged && identity.currentCount > 0 && identity.currentCoverage < 0.5 && identity.incomingCoverage < 0.5) {
    diff.conflicts.push({ kind: "source-layer-identity-mismatch", message: `PSD Layer ID 重合率仅 ${Math.round(identity.overlap * 100)}%。` });
  }
  if (fileNameChanged) {
    if (identity.overlap >= 0.8) {
      diff.identityWarning = {
        kind: "source-file-renamed",
        expected: storedFileName,
        actual: incomingFileName,
        overlap: identity.overlap
      };
    } else {
      diff.conflicts.push({ kind: "source-file-and-identity-mismatch", expected: storedFileName, actual: incomingFileName });
    }
  }
  for (const pair of diff.changed) {
    const node = pair.target.node;
    const conflictKind = validatePsdOwnedTarget(
      pair.target.ownership,
      pair.source.mode,
      node && node.type,
      node && node.type === "TEXT" ? node.textAutoResize : ""
    );
    const fontName = node && node.type === "TEXT" ? node.fontName : null;
    const imagePaintCount = node && node.type === "RECTANGLE" && Array.isArray(node.fills)
      ? node.fills.filter((paint) => paint && paint.type === "IMAGE").length
      : 0;
    const paintConflict = pair.source.mode === "image" && imagePaintCount !== 1 ? "unsafe-image-fill-structure" : "";
    const nineSlicePaintCount = node && node.type === "FRAME" && Array.isArray(node.fills)
      ? node.fills.filter((paint) => paint && paint.type === "IMAGE").length
      : 0;
    const nineSlicePaintConflict = pair.source.mode === "nine-slice" && nineSlicePaintCount !== 1
      ? "unsafe-nine-slice-fill-structure"
      : "";
    if (conflictKind || paintConflict || nineSlicePaintConflict || (pair.source.mode === "text" && (!fontName || typeof fontName !== "object"))) {
      diff.conflicts.push({
        kind: conflictKind || paintConflict || nineSlicePaintConflict || "unsupported-text-font",
        layerId: pair.source.layerId,
        nodeId: pair.target.nodeId
      });
    }
  }
  refreshPsdIncrementalDiffStatus(diff);
}

function appendPsdIncrementalAssetConflicts(diff, context) {
  const sources = diff.changed
    .map((item) => item.source)
    .filter((layer) => psdOwnershipForMode(layer.mode) !== "protected")
    .concat(diff.added.map((item) => item.source))
    .filter((layer) => layer.mode !== "text");
  for (const layer of sources) {
    const bytes = context.assetBytes.get(String(layer.assetId));
    if (!bytes || bytes.length < 8) {
      diff.conflicts.push({ kind: "missing-raster-bytes", layerId: layer.layerId, name: layer.name });
      continue;
    }
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!pngSignature.every((value, index) => bytes[index] === value)) {
      diff.conflicts.push({ kind: "invalid-raster-bytes", layerId: layer.layerId, name: layer.name });
    }
  }
  refreshPsdIncrementalDiffStatus(diff);
}

function refreshPsdIncrementalDiffStatus(diff) {
  diff.summary.conflicts = diff.conflicts.length;
  diff.status = diff.conflicts.length > 0
    ? "preview-blocked"
    : diff.baselineRequired.length > 0
      ? "preview-baseline-required"
      : diff.changed.length === 0 && diff.added.length === 0
        ? "preview-no-changes"
        : "preview-ready";
  diff.canApply = diff.status === "preview-ready";
}

function buildPsdIncrementalFingerprint(target, currentNodes, incomingLayers) {
  const current = currentNodes
    .map((item) => [
      item.layerId,
      item.nodeId,
      item.parentId,
      item.siblingIndex,
      item.nodeType,
      item.ownership,
      item.sourceStateHash,
      item.liveContentSignature,
      item.liveWritableFieldSignature,
      item.transformSignature
    ].join(":"))
    .sort()
    .join("|");
  const incoming = incomingLayers
    .map((item) => `${normalizePsdLayerId(item.layerId)}:${hashPsdSourceState(normalizePsdSourceState(item))}`)
    .sort()
    .join("|");
  const currentIds = new Set(currentNodes.map((item) => item.layerId));
  const incomingIds = new Set(incomingLayers.map((item) => normalizePsdLayerId(item.layerId)).filter(Boolean));
  const added = Array.from(incomingIds).filter((layerId) => !currentIds.has(layerId)).sort().join(",");
  const missing = Array.from(currentIds).filter((layerId) => !incomingIds.has(layerId)).sort().join(",");
  const targetTransform = hashPsdSourceState(target.absoluteTransform || null);
  return `${target.id}:${targetTransform}::${current}::${incoming}::added=${added}::missing=${missing}`;
}

function buildPsdLiveContentSignature(node, ownership) {
  if (ownership === "text-content" && node.type === "TEXT") {
    return `text:${hashPsdString(node.characters)}`;
  }
  if (ownership === "image-content" && node.type === "RECTANGLE" && Array.isArray(node.fills)) {
    const imageHashes = node.fills
      .filter((paint) => paint && paint.type === "IMAGE")
      .map((paint) => String(paint.imageHash || ""));
    return `image:${imageHashes.join(",")}`;
  }
  return "protected";
}

function buildPsdLiveWritableFieldSignature(node) {
  const liveState = {
    geometry: {
      x: numericOr(node && node.x, 0),
      y: numericOr(node && node.y, 0),
      width: numericOr(node && node.width, 0),
      height: numericOr(node && node.height, 0),
      rotation: numericOr(node && node.rotation, 0)
    },
    display: {
      visible: !node || node.visible !== false,
      opacity: numericOr(node && node.opacity, 1),
      blendMode: String(node && node.blendMode || ""),
      constraints: node && node.constraints ? node.constraints : {}
    },
    text: node && node.type === "TEXT" ? {
      characters: String(node.characters || ""),
      fontName: node.fontName,
      fontSize: node.fontSize,
      lineHeight: node.lineHeight,
      textAlignHorizontal: node.textAlignHorizontal
    } : null
  };
  return hashPsdSourceState(liveState);
}

function buildPsdIncrementalResult(prepared, status) {
  const serializePair = (item) => ({
    layerId: normalizePsdLayerId(item.source && item.source.layerId || item.target && item.target.layerId),
    sourceName: String(item.source && item.source.name || ""),
    targetName: String(item.target && item.target.name || ""),
    targetNodeId: String(item.target && item.target.nodeId || ""),
    changes: Array.isArray(item.changes) ? item.changes.map((change) => ({
      path: String(change.path || ""),
      category: String(change.category || ""),
      before: change.before,
      after: change.after,
      delta: change.delta
    })) : []
  });
  return {
    status,
    canApply: prepared.diff.canApply,
    targetNodeId: prepared.target.id,
    targetName: prepared.target.name,
    baselineFingerprint: prepared.baselineFingerprint,
    summary: prepared.diff.summary,
    groups: {
      changed: prepared.diff.changed.map(serializePair),
      unchanged: prepared.diff.unchanged.map(serializePair),
      added: prepared.diff.added.map(serializePair),
      missing: prepared.diff.missing.map(serializePair),
      baselineRequired: prepared.diff.baselineRequired.map(serializePair),
      conflicts: prepared.diff.conflicts.map((item) => ({
        kind: String(item.kind || "unknown"),
        layerId: normalizePsdLayerId(item.layerId),
        nodeId: String(item.nodeId || item.duplicate && item.duplicate.nodeId || ""),
        name: String(item.name || ""),
        message: String(item.message || ""),
        expected: String(item.expected || ""),
        actual: String(item.actual || "")
      }))
    },
    warnings: prepared.context.warnings,
    errors: prepared.context.errors
  };
}

function findPsdIncrementalStagingFrame(target) {
  if (!("children" in target)) return null;
  return target.children.find((child) => child.type === "FRAME" && child.name === "__PSD新增待整理") || null;
}

function createPsdIncrementalStagingFrame(target) {
  const frame = figma.createFrame();
  frame.name = "__PSD新增待整理";
  frame.resize(positiveOr(target.width, 1), positiveOr(target.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) frame.layoutMode = "NONE";
  target.appendChild(frame);
  if (target.layoutMode && target.layoutMode !== "NONE" && "layoutPositioning" in frame) {
    frame.layoutPositioning = "ABSOLUTE";
  }
  frame.x = 0;
  frame.y = 0;
  return frame;
}

function isPsdOwnedSliceChild(node) {
  if (!node) return false;
  if (readSharedPluginData(node, "psdSliceRole") === "slice") return true;
  return !!readSharedPluginData(node, "parentLayerIndex")
    && String(node.name || "").startsWith("__slice");
}

function buildPsdComponentIdentity(node) {
  let mainComponentId = "";
  try {
    mainComponentId = "mainComponent" in node && node.mainComponent
      ? String(node.mainComponent.id || "")
      : "";
  } catch (error) {
    mainComponentId = "";
  }
  return [String(node.type || ""), String(node.id || ""), mainComponentId].join(":");
}

function capturePsdStructuralSnapshot(root) {
  const snapshots = [];
  const visit = (node) => {
    if (isPsdOwnedSliceChild(node)) return;
    snapshots.push({
      node,
      id: node.id,
      name: String(node.name || ""),
      parentId: node.parent ? node.parent.id : "",
      siblingIndex: node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1,
      type: String(node.type || ""),
      componentIdentity: buildPsdComponentIdentity(node),
      nonPsdChildIds: "children" in node
        ? node.children.filter((child) => !isPsdOwnedSliceChild(child)).map((child) => child.id)
        : []
    });
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return snapshots;
}

function verifyPsdStructuralSnapshot(snapshots, allowedAddedNodeIds) {
  const allowed = allowedAddedNodeIds || new Set();
  const errors = [];
  for (const item of snapshots) {
    const node = item.node;
    if (!node || node.removed) {
      errors.push(`${item.id}:removed`);
      continue;
    }
    const parentId = node.parent ? node.parent.id : "";
    const siblingIndex = node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1;
    const childIds = "children" in node
      ? node.children
        .filter((child) => !isPsdOwnedSliceChild(child) && !allowed.has(child.id))
        .map((child) => child.id)
      : [];
    if (node.id !== item.id
      || String(node.name || "") !== item.name
      || parentId !== item.parentId
      || siblingIndex !== item.siblingIndex
      || String(node.type || "") !== item.type
      || buildPsdComponentIdentity(node) !== item.componentIdentity
      || childIds.join("|") !== item.nonPsdChildIds.join("|")) {
      errors.push(`${item.id}:structural-drift`);
    }
  }
  return errors;
}

function capturePsdProtectedSnapshot(root) {
  const snapshots = [];
  const visit = (node) => {
    snapshots.push({
      node,
      id: node.id,
      name: String(node.name || ""),
      parentId: node.parent ? node.parent.id : "",
      index: node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1,
      x: numericOr(node.x, 0),
      y: numericOr(node.y, 0),
      width: numericOr(node.width, 0),
      height: numericOr(node.height, 0),
      rotation: numericOr(node.rotation, 0),
      layoutPositioning: "layoutPositioning" in node ? String(node.layoutPositioning || "") : ""
    });
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return snapshots;
}

function verifyPsdProtectedSnapshot(snapshots) {
  const errors = [];
  for (const item of snapshots) {
    const node = item.node;
    if (!node || node.removed) {
      errors.push(`${item.id} 已被删除`);
      continue;
    }
    const parentId = node.parent ? node.parent.id : "";
    const index = node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1;
    const changed = node.name !== item.name
      || parentId !== item.parentId
      || index !== item.index
      || Math.abs(numericOr(node.x, 0) - item.x) > 0.01
      || Math.abs(numericOr(node.y, 0) - item.y) > 0.01
      || Math.abs(numericOr(node.width, 0) - item.width) > 0.01
      || Math.abs(numericOr(node.height, 0) - item.height) > 0.01
      || Math.abs(numericOr(node.rotation, 0) - item.rotation) > 0.01
      || ("layoutPositioning" in node && String(node.layoutPositioning || "") !== item.layoutPositioning);
    if (changed) errors.push(`${item.id}:${item.name}`);
  }
  return errors;
}

function applyPsdGeometryPlan(plan, node) {
  const target = plan.expectedGeometry;
  if (!target) throw new Error("missing-expected-geometry");
  if (plan.changedPaths.includes("geometry.width") || plan.changedPaths.includes("geometry.height")) {
    node.resize(target.size.width, target.size.height);
  }
  if (plan.changedPaths.includes("geometry.x") || plan.changedPaths.includes("geometry.y")) {
    node.x = target.localPosition.x;
    node.y = target.localPosition.y;
  }
  if (plan.changedPaths.includes("geometry.rotation")) node.rotation = target.rotation;
}

function applyPsdDisplayPlan(plan, node) {
  const display = plan.incoming.display;
  if (plan.changedPaths.includes("display.visible")) node.visible = display.visible;
  if (plan.changedPaths.includes("display.opacity")) node.opacity = display.opacity;
  if (plan.changedPaths.includes("display.blendMode")) node.blendMode = display.blendMode;
  if (plan.changedPaths.includes("display.constraints")) node.constraints = clonePsdValue(display.constraints);
}

function applyPsdTextStroke(node, stroke) {
  if (!stroke || stroke.enabled !== true) {
    node.strokes = [];
    return;
  }
  const color = stroke.color || stroke;
  node.strokes = [solidPaintFromManifest(color, 1)];
  node.strokeWeight = numericOr(stroke.size, 1);
  node.strokeAlign = "OUTSIDE";
}

function applyPsdTextShadow(node, shadow) {
  const retained = Array.isArray(node.effects)
    ? node.effects.filter((effect) => !effect || effect.type !== "DROP_SHADOW")
    : [];
  if (!shadow || shadow.enabled !== true) {
    node.effects = retained;
    return;
  }
  const color = shadow.color || {};
  const angleRadians = numericOr(shadow.angle, 0) * Math.PI / 180;
  const distance = numericOr(shadow.distance, 0);
  retained.push({
    type: "DROP_SHADOW",
    color: {
      r: numericOr(color.r, 0),
      g: numericOr(color.g, 0),
      b: numericOr(color.b, 0),
      a: numericOr(shadow.opacity, numericOr(color.a, 1))
    },
    offset: {
      x: Math.cos(angleRadians) * distance,
      y: -Math.sin(angleRadians) * distance
    },
    radius: Math.max(0, numericOr(shadow.blur, 0)),
    spread: Math.max(0, numericOr(shadow.spread, 0)),
    visible: true,
    blendMode: "NORMAL"
  });
  node.effects = retained;
}

async function applyPsdTextPlan(plan, pair, prepared) {
  const node = pair.target.node;
  const text = plan.incoming.text || {};
  if (plan.changedPaths.includes("text.fontFamily") || plan.changedPaths.includes("text.fontFallback")) {
    const resolvedFont = prepared.resolvedFonts.get(plan.layerId);
    if (!resolvedFont) throw new Error("missing-resolved-font");
    node.fontName = resolvedFont;
  }
  if (plan.changedPaths.includes("text.characters")) node.characters = String(text.characters || "");
  if (plan.changedPaths.includes("text.fontSize") || plan.changedPaths.includes("text.effectiveFontSize")) {
    node.fontSize = positiveOr(text.effectiveFontSize, positiveOr(text.fontSize, node.fontSize));
  }
  if (plan.changedPaths.includes("text.leading") || plan.changedPaths.includes("text.lineHeightMode")) {
    node.lineHeight = text.lineHeightMode === "PIXELS" && Number(text.leading) > 0
      ? { unit: "PIXELS", value: Number(text.leading) }
      : { unit: "AUTO" };
  }
  if (plan.changedPaths.includes("text.textAlignHorizontal")) {
    node.textAlignHorizontal = text.textAlignHorizontal;
  }
  if (plan.changedPaths.includes("text.fillColor")) {
    node.fills = [solidPaintFromManifest(text.fillColor || {}, 1)];
  }
  if (plan.changedPaths.includes("text.stroke")) applyPsdTextStroke(node, text.stroke);
  if (plan.changedPaths.includes("text.dropShadow")) applyPsdTextShadow(node, text.dropShadow);
  node.textAutoResize = "NONE";
}

async function applyPsdNineSlicePlan(plan, pair, prepared) {
  const node = pair.target.node;
  if (!("children" in node)) throw new Error("unsupported-nine-slice-target");
  const imagePaint = prepared.imagePaints.get(plan.layerId);
  if (!imagePaint || !imagePaint.imageHash) throw new Error("missing-nine-slice-image");
  node.fills = replacePsdOwnedImageHash(node.fills, imagePaint);
  for (const child of node.children.slice().reverse()) {
    if (isPsdOwnedSliceChild(child)) child.remove();
  }
  const nineSlice = plan.incoming.nineSlice || {};
  const slices = Array.isArray(nineSlice.slices)
    ? nineSlice.slices
    : (Array.isArray(pair.source.slices) ? pair.source.slices : []);
  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = String(slice.name || "__slice");
    node.appendChild(sliceNode);
    const target = normalizeRectArray(slice.target);
    sliceNode.x = target[0];
    sliceNode.y = target[1];
    sliceNode.resize(positiveOr(target[2], 1), positiveOr(target[3], 1));
    sliceNode.fills = [createImagePaintFromHash(
      imagePaint.imageHash,
      "CROP",
      buildCropTransform(slice, pair.source),
      1
    )];
    sliceNode.strokes = [];
    sliceNode.constraints = inferSliceConstraints(sliceNode, node);
    writePluginData(sliceNode, {
      sourceRect: JSON.stringify(normalizeRectArray(slice.source)),
      parentLayerIndex: String(pair.source.idx),
      psdParentLayerId: plan.layerId,
      psdSliceRole: "slice"
    });
  }
}

async function applyPsdMutationPlans(prepared) {
  for (const plan of prepared.plans) {
    const pair = { source: plan.source, target: plan.target };
    const node = plan.target.node;
    if (plan.categories.includes("content") && plan.incoming.mode === "image") {
      node.fills = replacePsdOwnedImageHash(node.fills, prepared.imagePaints.get(plan.layerId));
    }
    if (plan.categories.includes("textContent") || plan.categories.includes("textStyle")) {
      await applyPsdTextPlan(plan, pair, prepared);
    }
    if (plan.categories.some((category) => (
      category === "position" || category === "size" || category === "rotation"
    ))) {
      applyPsdGeometryPlan(plan, node);
    }
    if (plan.categories.includes("display")) applyPsdDisplayPlan(plan, node);
    if (plan.categories.includes("nineSlice")) await applyPsdNineSlicePlan(plan, pair, prepared);
  }
}

async function preloadPsdMutationAssets(prepared) {
  prepared.imagePaints = new Map();
  prepared.resolvedFonts = new Map();
  for (const plan of prepared.plans) {
    if (plan.target.node.type === "TEXT" && plan.target.node.fontName && typeof plan.target.node.fontName === "object") {
      await figma.loadFontAsync(plan.target.node.fontName);
    }
    if (plan.categories.includes("textContent") || plan.categories.includes("textStyle")) {
      plan.expectedFontName = await loadBestFont(plan.source, prepared.context);
      prepared.resolvedFonts.set(plan.layerId, plan.expectedFontName);
    }
    if ((plan.incoming.mode === "image" && plan.categories.includes("content"))
      || plan.categories.includes("nineSlice")) {
      plan.expectedImagePaint = await createImagePaint(plan.source, prepared.context, "FILL", null);
      prepared.imagePaints.set(plan.layerId, plan.expectedImagePaint);
    }
  }
  for (const item of prepared.diff.added) {
    if (item.source.mode === "text") {
      await loadBestFont(item.source, prepared.context);
    } else {
      await createImagePaint(item.source, prepared.context, "FILL", null);
    }
  }
}

function preparePsdAddedLayerTransaction() {
  return {
    stagingFrame: null,
    createdStagingFrame: false,
    existingChildIds: new Set(),
    createdNodes: [],
    createdNodeIds: new Set()
  };
}

async function applyPsdAddedLayers(prepared, transaction) {
  if (prepared.diff.added.length === 0) return;
  transaction.stagingFrame = findPsdIncrementalStagingFrame(prepared.target);
  if (!transaction.stagingFrame) {
    transaction.stagingFrame = createPsdIncrementalStagingFrame(prepared.target);
    transaction.createdStagingFrame = true;
  } else {
    transaction.existingChildIds = new Set(transaction.stagingFrame.children.map((child) => child.id));
  }
  if (transaction.createdStagingFrame) transaction.createdNodeIds.add(transaction.stagingFrame.id);
  for (const item of prepared.diff.added) {
    const node = await createLayerNode(transaction.stagingFrame, item.source, prepared.context);
    if (!node) continue;
    transaction.createdNodes.push(node);
    transaction.createdNodeIds.add(node.id);
    prepared.context.nodeByLayerIdx.set(String(item.source.idx), node.id);
  }
}

function psdNumberMatches(actual, expected) {
  return Number.isFinite(Number(actual))
    && Number.isFinite(Number(expected))
    && Math.abs(Number(actual) - Number(expected)) <= 0.01;
}

function psdSolidPaintMatches(actual, expectedColor) {
  return !!actual && actual.type === "SOLID"
    && psdNumberMatches(actual.color && actual.color.r, expectedColor && expectedColor.r)
    && psdNumberMatches(actual.color && actual.color.g, expectedColor && expectedColor.g)
    && psdNumberMatches(actual.color && actual.color.b, expectedColor && expectedColor.b);
}

function verifyPsdTextStroke(node, stroke) {
  const strokes = Array.isArray(node.strokes) ? node.strokes : [];
  if (!stroke || stroke.enabled !== true) return strokes.length === 0;
  const color = stroke.color || stroke;
  return strokes.length === 1
    && psdSolidPaintMatches(strokes[0], color)
    && psdNumberMatches(node.strokeWeight, numericOr(stroke.size, 1))
    && node.strokeAlign === "OUTSIDE";
}

function verifyPsdTextShadow(node, shadow) {
  const effects = Array.isArray(node.effects)
    ? node.effects.filter((effect) => effect && effect.type === "DROP_SHADOW")
    : [];
  if (!shadow || shadow.enabled !== true) return effects.length === 0;
  if (effects.length !== 1) return false;
  const effect = effects[0];
  const color = shadow.color || {};
  const angleRadians = numericOr(shadow.angle, 0) * Math.PI / 180;
  const distance = numericOr(shadow.distance, 0);
  return psdNumberMatches(effect.color && effect.color.r, numericOr(color.r, 0))
    && psdNumberMatches(effect.color && effect.color.g, numericOr(color.g, 0))
    && psdNumberMatches(effect.color && effect.color.b, numericOr(color.b, 0))
    && psdNumberMatches(effect.color && effect.color.a, numericOr(shadow.opacity, numericOr(color.a, 1)))
    && psdNumberMatches(effect.offset && effect.offset.x, Math.cos(angleRadians) * distance)
    && psdNumberMatches(effect.offset && effect.offset.y, -Math.sin(angleRadians) * distance)
    && psdNumberMatches(effect.radius, Math.max(0, numericOr(shadow.blur, 0)))
    && psdNumberMatches(effect.spread, Math.max(0, numericOr(shadow.spread, 0)));
}

function verifyPsdAppliedFields(plans) {
  const errors = [];
  for (const plan of plans) {
    const node = plan.target.node;
    const geometry = plan.expectedGeometry;
    const display = plan.incoming.display || {};
    const text = plan.incoming.text || {};
    for (const path of plan.changedPaths) {
      let valid = true;
      if (path === "geometry.x") valid = geometry && psdNumberMatches(node.x, geometry.localPosition.x);
      else if (path === "geometry.y") valid = geometry && psdNumberMatches(node.y, geometry.localPosition.y);
      else if (path === "geometry.width") valid = geometry && psdNumberMatches(node.width, geometry.size.width);
      else if (path === "geometry.height") valid = geometry && psdNumberMatches(node.height, geometry.size.height);
      else if (path === "geometry.rotation") valid = geometry && psdNumberMatches(node.rotation, geometry.rotation);
      else if (path === "display.visible") valid = node.visible === display.visible;
      else if (path === "display.opacity") valid = psdNumberMatches(node.opacity, display.opacity);
      else if (path === "display.blendMode") valid = node.blendMode === display.blendMode;
      else if (path === "display.constraints") {
        valid = stablePsdSourceStateJson(node.constraints) === stablePsdSourceStateJson(display.constraints);
      } else if (path === "content.contentHash" && plan.incoming.mode === "image") {
        const imagePaint = plan.expectedImagePaint;
        const imageFills = Array.isArray(node.fills)
          ? node.fills.filter((paint) => paint && paint.type === "IMAGE")
          : [];
        valid = !!imagePaint && imageFills.length === 1 && imageFills[0].imageHash === imagePaint.imageHash;
      } else if (path === "text.characters") valid = node.characters === String(text.characters || "");
      else if (path === "text.fontFamily" || path === "text.fontFallback") {
        valid = stablePsdSourceStateJson(node.fontName) === stablePsdSourceStateJson(plan.expectedFontName);
      } else if (path === "text.fontSize" || path === "text.effectiveFontSize") {
        valid = psdNumberMatches(node.fontSize, positiveOr(text.effectiveFontSize, text.fontSize));
      } else if (path === "text.leading" || path === "text.lineHeightMode") {
        const expectedLineHeight = text.lineHeightMode === "PIXELS" && Number(text.leading) > 0
          ? { unit: "PIXELS", value: Number(text.leading) }
          : { unit: "AUTO" };
        valid = stablePsdSourceStateJson(node.lineHeight) === stablePsdSourceStateJson(expectedLineHeight);
      } else if (path === "text.textAlignHorizontal") valid = node.textAlignHorizontal === text.textAlignHorizontal;
      else if (path === "text.fillColor") {
        valid = Array.isArray(node.fills) && node.fills.length === 1 && psdSolidPaintMatches(node.fills[0], text.fillColor || {});
      } else if (path === "text.stroke") valid = verifyPsdTextStroke(node, text.stroke);
      else if (path === "text.dropShadow") valid = verifyPsdTextShadow(node, text.dropShadow);
      else if (path === "nineSlice") {
        const slices = "children" in node ? node.children.filter(isPsdOwnedSliceChild) : [];
        const expectedSlices = plan.incoming.nineSlice && Array.isArray(plan.incoming.nineSlice.slices)
          ? plan.incoming.nineSlice.slices
          : [];
        valid = slices.length === expectedSlices.length
          && !!plan.expectedImagePaint
          && hasExpectedNineSliceImageHash(node, plan.expectedImagePaint.imageHash);
      }
      if (!valid) errors.push(`${plan.layerId}:${path}`);
    }
  }
  return errors;
}

function buildPsdIncrementalMetadataExtra(plan, prepared) {
  if (plan.incoming.mode === "nine-slice") {
    const nineSlice = plan.incoming.nineSlice || {};
    return {
      border: JSON.stringify(nineSlice.border || {}),
      sliceCount: String(Array.isArray(nineSlice.slices) ? nineSlice.slices.length : 0),
      sourceImageFillIndex: "0",
      nodeRole: "nineSliceParent"
    };
  }
  if (plan.incoming.mode === "text") {
    const fontName = prepared.resolvedFonts.get(plan.layerId) || {};
    const text = plan.incoming.text || {};
    return {
      fontFamily: String(fontName.family || ""),
      fontStyle: String(fontName.style || ""),
      effectiveFontSize: String(firstDefined(text.effectiveFontSize, text.fontSize)),
      originalFontSize: String(firstDefined(text.fontSize, ""))
    };
  }
  return {};
}

function replacePsdOwnedImageHash(fills, decodedPaint) {
  let replaced = 0;
  const updated = fills.map((paint) => {
    if (!paint || paint.type !== "IMAGE") return paint;
    replaced += 1;
    return Object.assign({}, paint, { imageHash: decodedPaint.imageHash });
  });
  if (replaced !== 1) {
    throw new Error(`图片节点需要且只能包含一个 IMAGE fill，当前为 ${replaced}`);
  }
  return updated;
}

function verifyPsdAddedNodes(createdNodes, addedItems, stagingFrame, context) {
  const errors = [];
  if (createdNodes.length !== addedItems.length) {
    errors.push(`新增节点数量不一致：${createdNodes.length}/${addedItems.length}`);
  }
  for (const item of addedItems) {
    const layerId = normalizePsdLayerId(item.source.layerId);
    const node = createdNodes.find((candidate) => readSharedPluginData(candidate, "psdLayerId") === layerId);
    if (!node) {
      errors.push(`新增 Layer ID ${layerId} 未创建`);
      continue;
    }
    if (node.parent !== stagingFrame) errors.push(`新增 Layer ID ${layerId} 不在待整理容器`);
    if (readSharedPluginData(node, "psdContentHash") !== String(item.source.contentHash || "")) {
      errors.push(`新增 Layer ID ${layerId} 内容哈希不一致`);
    }
    const expectedSourceState = normalizePsdSourceState(item.source);
    const expectedSourceStateHash = hashPsdSourceState(expectedSourceState);
    if (readSharedPluginData(node, "psdSourceStateHash") !== expectedSourceStateHash) {
      errors.push(`Added Layer ID ${layerId} has invalid PSD source-state hash`);
    }
    const storedSourceState = readStoredPsdSourceState(node);
    if (storedSourceState.error
      || stablePsdSourceStateJson(storedSourceState.state) !== stablePsdSourceStateJson(expectedSourceState)) {
      errors.push(`Added Layer ID ${layerId} has invalid PSD source state`);
    }
    const expectedOwnership = psdOwnershipForMode(item.source.mode);
    if (readSharedPluginData(node, "psdOwnership") !== expectedOwnership) {
      errors.push(`Added Layer ID ${layerId} has invalid PSD ownership`);
    }
    if (item.source.mode === "image") {
      const imagePaints = node.type === "RECTANGLE" && Array.isArray(node.fills)
        ? node.fills.filter((paint) => paint && paint.type === "IMAGE")
        : [];
      const expectedImageHash = context && context.imageHashes
        ? context.imageHashes.get(String(item.source.assetId))
        : "";
      if (imagePaints.length !== 1 || !expectedImageHash || imagePaints[0].imageHash !== expectedImageHash) {
        errors.push(`Added Layer ID ${layerId} has invalid image content`);
      }
    }
    if (item.source.mode === "nine-slice") {
      const expectedImageHash = context && context.imageHashes
        ? context.imageHashes.get(String(item.source.assetId))
        : "";
      if (node.type !== "FRAME" || validateSliceFrame(node) !== 0 || !hasExpectedNineSliceImageHash(node, expectedImageHash)) {
        errors.push(`Added Layer ID ${layerId} has invalid slice structure`);
      }
    }
    if (item.source.mode === "text" && node.type === "TEXT" && node.characters !== String(item.source.chars || "")) {
      errors.push(`新增 Layer ID ${layerId} 文本内容不一致`);
    }
  }
  return errors;
}

function clonePsdValue(value) {
  if (Array.isArray(value)) return value.map(clonePsdValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value)) result[key] = clonePsdValue(value[key]);
  return result;
}

function capturePsdSliceChildren(node) {
  if (!("children" in node)) return [];
  return node.children.filter(isPsdOwnedSliceChild).map((child) => ({
    index: node.children.indexOf(child),
    name: String(child.name || ""),
    x: numericOr(child.x, 0),
    y: numericOr(child.y, 0),
    width: positiveOr(child.width, 1),
    height: positiveOr(child.height, 1),
    rotation: numericOr(child.rotation, 0),
    visible: child.visible !== false,
    opacity: numericOr(child.opacity, 1),
    fills: "fills" in child ? clonePsdValue(child.fills) : [],
    strokes: "strokes" in child ? clonePsdValue(child.strokes) : [],
    effects: "effects" in child ? clonePsdValue(child.effects) : [],
    constraints: "constraints" in child ? clonePsdValue(child.constraints) : null,
    metadata: {
      sourceRect: readSharedPluginData(child, "sourceRect"),
      parentLayerIndex: readSharedPluginData(child, "parentLayerIndex"),
      psdParentLayerId: readSharedPluginData(child, "psdParentLayerId"),
      psdSliceRole: readSharedPluginData(child, "psdSliceRole")
    }
  }));
}

function capturePsdMutationRollback(node) {
  return {
    node,
    x: "x" in node ? node.x : null,
    y: "y" in node ? node.y : null,
    width: "width" in node ? node.width : null,
    height: "height" in node ? node.height : null,
    rotation: "rotation" in node ? node.rotation : null,
    visible: "visible" in node ? node.visible : null,
    opacity: "opacity" in node ? node.opacity : null,
    blendMode: "blendMode" in node ? node.blendMode : null,
    constraints: "constraints" in node ? clonePsdValue(node.constraints) : null,
    characters: "characters" in node ? node.characters : null,
    fontName: "fontName" in node ? clonePsdValue(node.fontName) : null,
    fontSize: "fontSize" in node ? node.fontSize : null,
    lineHeight: "lineHeight" in node ? clonePsdValue(node.lineHeight) : null,
    textAlignHorizontal: "textAlignHorizontal" in node ? node.textAlignHorizontal : null,
    textAutoResize: "textAutoResize" in node ? node.textAutoResize : null,
    fills: "fills" in node ? clonePsdValue(node.fills) : null,
    strokes: "strokes" in node ? clonePsdValue(node.strokes) : null,
    strokeWeight: "strokeWeight" in node ? node.strokeWeight : null,
    strokeAlign: "strokeAlign" in node ? node.strokeAlign : null,
    effects: "effects" in node ? clonePsdValue(node.effects) : null,
    sliceChildren: capturePsdSliceChildren(node),
    metadata: capturePsdLayerMetadata(node)
  };
}

function restorePsdSliceChildren(node, records) {
  if (!("children" in node)) return;
  for (const child of node.children.slice().reverse()) {
    if (isPsdOwnedSliceChild(child)) child.remove();
  }
  for (const record of records.slice().sort((left, right) => left.index - right.index)) {
    const child = figma.createRectangle();
    child.name = record.name;
    const insertIndex = Math.max(0, Math.min(record.index, node.children.length));
    if (typeof node.insertChild === "function") node.insertChild(insertIndex, child);
    else node.appendChild(child);
    child.resize(record.width, record.height);
    child.x = record.x;
    child.y = record.y;
    child.rotation = record.rotation;
    child.visible = record.visible;
    child.opacity = record.opacity;
    child.fills = clonePsdValue(record.fills);
    child.strokes = clonePsdValue(record.strokes);
    child.effects = clonePsdValue(record.effects);
    if (record.constraints) child.constraints = clonePsdValue(record.constraints);
    writePluginData(child, record.metadata);
  }
}

function restorePsdMutationRollback(record) {
  const node = record.node;
  if (!node || node.removed) throw new Error("rollback-target-removed");
  if (record.width !== null && record.height !== null && typeof node.resize === "function") {
    node.resize(record.width, record.height);
  }
  if (record.x !== null) node.x = record.x;
  if (record.y !== null) node.y = record.y;
  if (record.rotation !== null) node.rotation = record.rotation;
  if (record.visible !== null) node.visible = record.visible;
  if (record.opacity !== null) node.opacity = record.opacity;
  if (record.blendMode !== null) node.blendMode = record.blendMode;
  if (record.constraints !== null) node.constraints = clonePsdValue(record.constraints);
  if (record.fontName !== null) node.fontName = clonePsdValue(record.fontName);
  if (record.fontSize !== null) node.fontSize = record.fontSize;
  if (record.lineHeight !== null) node.lineHeight = clonePsdValue(record.lineHeight);
  if (record.textAlignHorizontal !== null) node.textAlignHorizontal = record.textAlignHorizontal;
  if (record.textAutoResize !== null) node.textAutoResize = record.textAutoResize;
  if (record.characters !== null) node.characters = record.characters;
  if (record.fills !== null) node.fills = clonePsdValue(record.fills);
  if (record.strokes !== null) node.strokes = clonePsdValue(record.strokes);
  if (record.strokeWeight !== null) node.strokeWeight = record.strokeWeight;
  if (record.strokeAlign !== null) node.strokeAlign = record.strokeAlign;
  if (record.effects !== null) node.effects = clonePsdValue(record.effects);
  restorePsdSliceChildren(node, record.sliceChildren);
  writePluginData(node, record.metadata);
}

function verifyPsdRollbackRecords(records) {
  const errors = [];
  const numericFields = ["x", "y", "width", "height", "rotation", "opacity", "fontSize", "strokeWeight"];
  const exactFields = [
    "visible", "blendMode", "characters", "textAlignHorizontal", "textAutoResize", "strokeAlign"
  ];
  const valueFields = [
    "constraints", "fontName", "lineHeight", "fills", "strokes", "effects", "sliceChildren", "metadata"
  ];
  for (const record of records) {
    const current = capturePsdMutationRollback(record.node);
    for (const field of numericFields) {
      if (record[field] !== null && !psdNumberMatches(current[field], record[field])) {
        errors.push(`${record.node.id}:rollback-${field}`);
      }
    }
    for (const field of exactFields) {
      if (current[field] !== record[field]) errors.push(`${record.node.id}:rollback-${field}`);
    }
    for (const field of valueFields) {
      if (stablePsdSourceStateJson(current[field]) !== stablePsdSourceStateJson(record[field])) {
        errors.push(`${record.node.id}:rollback-${field}`);
      }
    }
  }
  return errors;
}

function capturePsdLayerMetadata(node) {
  const keys = [
    "rawPsdLayerName", "normalizedLayerName", "semanticMode", "normalizationWarnings",
    "psdLayerIndex", "psdLayerId", "psdOriginalName", "psdContentHash", "psdOwnership",
    "psdSourceState", "psdSourceStateHash"
  ];
  const values = {};
  for (const key of keys) values[key] = readSharedPluginData(node, key);
  return values;
}

function capturePsdRootMetadata(node) {
  const keys = [
    "importKind", "schemaVersion", "source", "psdSchemaVersion", "psdImportSchemaVersion",
    "psdSourceFileName", "psdSourceKey", "psdLayerSetFingerprint", "psdCanvasWidth", "psdCanvasHeight"
  ];
  const values = {};
  for (const key of keys) values[key] = readSharedPluginData(node, key);
  return values;
}

async function rollbackPsdIncrementalMutation(records, transaction, prepared) {
  const errors = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    try {
      restorePsdMutationRollback(record);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    if (transaction.createdStagingFrame && transaction.stagingFrame && !transaction.stagingFrame.removed) {
      transaction.stagingFrame.remove();
    } else if (transaction.stagingFrame && !transaction.stagingFrame.removed) {
      for (const child of transaction.stagingFrame.children.slice().reverse()) {
        if (!transaction.existingChildIds.has(child.id)) child.remove();
      }
    } else {
      for (let index = transaction.createdNodes.length - 1; index >= 0; index -= 1) {
        const node = transaction.createdNodes[index];
        if (node && !node.removed) node.remove();
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    writePluginData(prepared.target, prepared.rootMetadataBefore);
    if (stablePsdSourceStateJson(capturePsdRootMetadata(prepared.target))
      !== stablePsdSourceStateJson(prepared.rootMetadataBefore)) {
      errors.push("rollback-root-metadata");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

// 规范化 manifest_summary 数据，兼容不同摘要脚本输出格式。
function normalizeManifest(rawManifest) {
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new Error("任务缺少 manifest 数据。");
  }
  const canvas = rawManifest.canvas || {};
  const layers = Array.isArray(rawManifest.layers)
    ? rawManifest.layers
    : []
      .concat(rawManifest.imageLayers || [])
      .concat(rawManifest.textLayers || [])
      .concat(rawManifest.commonLayers || [])
      .concat(rawManifest.nineSliceLayers || []);

  return {
    canvas: {
      width: positiveOr(canvas.width, 100),
      height: positiveOr(canvas.height, 100)
    },
    layers: layers.map(normalizeLayer)
  };
}

// 规范化单个图层，统一 x/y/w/h、opacity、语义字段和资源 id。
function normalizeLayer(layer) {
  const widthSource = firstDefined(layer.w, layer.width);
  const heightSource = firstDefined(layer.h, layer.height);
  const width = positiveOr(widthSource, 1);
  const height = positiveOr(heightSource, 1);
  const opacityRaw = numericOr(layer.opacity, 255);
  const rawAssetId = firstDefined(layer.assetId, firstDefined(layer.idx, firstDefined(layer.index, "")));
  const normalized = cloneObject(layer);
  const mode = String(layer.mode || layer.semanticMode || "image");
  Object.assign(normalized, {
    idx: numericOr(firstDefined(layer.idx, layer.index), 0),
    name: String(layer.name || `Layer_${firstDefined(layer.idx, firstDefined(layer.index, 0))}`),
    mode,
    x: numericOr(layer.x, 0),
    y: numericOr(layer.y, 0),
    w: width,
    h: height,
    opacity: opacityRaw > 1 ? opacityRaw / 255 : opacityRaw,
    visible: layer.visible !== false,
    assetId: String(rawAssetId),
    constraints: layer.constraints || {},
    rawPsdLayerName: String(layer.rawPsdLayerName || layer.name || ""),
    normalizedLayerName: String(layer.normalizedLayerName || layer.name || ""),
    semanticMode: String(layer.semanticMode || layer.mode || "image"),
    layerId: normalizePsdLayerId(layer.layerId),
    contentHash: String(layer.contentHash || ""),
    normalizationWarnings: Array.isArray(layer.normalizationWarnings) ? layer.normalizationWarnings : []
  });
  applyNestedManifestCompatibility(normalized, layer, mode, width, height);
  normalized.sourceState = normalizePsdSourceState({ ...normalized, sourceState: layer.sourceState });
  normalized.sourceStateHash = hashPsdSourceState(normalized.sourceState);
  return normalized;
}

// 兼容导出端把九宫和文字数据放在嵌套对象中的 manifest，统一提升为 MCP Relay 创建节点时读取的顶层字段。
function applyNestedManifestCompatibility(normalized, layer, mode, width, height) {
  if (mode === "nine-slice") {
    const nineSlice = layer.nineSlice && typeof layer.nineSlice === "object" ? layer.nineSlice : {};
    normalized.slices = Array.isArray(layer.slices) ? layer.slices : (Array.isArray(nineSlice.slices) ? nineSlice.slices : []);
    normalized.border = layer.border && typeof layer.border === "object" ? layer.border : (nineSlice.border || {});
    normalized.sliceType = String(firstDefined(layer.sliceType, firstDefined(nineSlice.sliceType, "")));
    normalized.inferredBorder = !!firstDefined(layer.inferredBorder, nineSlice.inferredBorder);
    normalized.inferMethod = String(firstDefined(layer.inferMethod, firstDefined(nineSlice.inferMethod, "")));
    normalized.confidence = String(firstDefined(layer.confidence, firstDefined(nineSlice.confidence, "")));
    normalized.sourceImageWidth = positiveOr(firstDefined(layer.sourceImageWidth, layer.sourceImageW), width);
    normalized.sourceImageHeight = positiveOr(firstDefined(layer.sourceImageHeight, layer.sourceImageH), height);
  }

  if (mode === "text") {
    const text = layer.text && typeof layer.text === "object" ? layer.text : {};
    const effects = text.effects && typeof text.effects === "object" ? text.effects : {};
    normalized.chars = String(firstDefined(layer.chars, firstDefined(text.characters, "")));
    normalized.fontSize = positiveOr(firstDefined(layer.fontSize, text.fontSize), Math.max(12, height));
    normalized.originalFontSize = positiveOr(firstDefined(layer.originalFontSize, firstDefined(text.originalFontSize, text.fontSize)), normalized.fontSize);
    normalized.effectiveFontSize = positiveOr(firstDefined(layer.effectiveFontSize, text.effectiveFontSize), normalized.fontSize);
    normalized.effectiveSizeSource = String(firstDefined(layer.effectiveSizeSource, text.effectiveSizeSource || ""));
    normalized.textTransform = layer.textTransform || text.textTransform || null;
    normalized.leading = firstDefined(layer.leading, text.leading);
    normalized.fillColor = layer.fillColor || text.fillColor || {};
    normalized.textAlign = firstDefined(layer.textAlign, text.textAlignHorizontal);
    normalized.fontFallback = Array.isArray(layer.fontFallback)
      ? layer.fontFallback
      : extractTextFontFallback(text);
    normalized.stroke = normalizeTextStroke(firstDefined(layer.stroke, effects.stroke));
  }
}

// 从文字元数据中提取 Figma 候选字体，避免嵌套 manifest 导入时退回空字体列表。
function extractTextFontFallback(text) {
  const figmaInfo = text.figma && typeof text.figma === "object" ? text.figma : {};
  if (Array.isArray(figmaInfo.fontFallbackCandidates)) {
    return figmaInfo.fontFallbackCandidates;
  }
  return Array.isArray(text.fontFallback) ? text.fontFallback : [];
}

// 兼容嵌套 text.effects.stroke 结构，统一成 createTextLayer 使用的 stroke 字段。
function normalizeTextStroke(value) {
  if (!value || typeof value !== "object") {
    return { enabled: false, size: 0 };
  }
  const color = value.color && typeof value.color === "object" ? value.color : value;
  return {
    enabled: value.enabled === true,
    size: numericOr(value.size, 0),
    r: numericOr(firstDefined(value.r, color.r), 0),
    g: numericOr(firstDefined(value.g, color.g), 0),
    b: numericOr(firstDefined(value.b, color.b), 0),
    hex: String(firstDefined(value.hex, firstDefined(color.hex, "")))
  };
}

// 将 UI 线程传入的资源字节转换为 assetId -> Uint8Array 映射。
function buildAssetBytesMap(assets) {
  const map = new Map();
  for (const asset of assets || []) {
    map.set(String(asset.id), toUint8Array(asset.bytes));
  }
  return map;
}

// 创建本次导入根 Frame，并放到目标容器或当前页面。
async function createRootFrame(job, manifest) {
  const root = figma.createFrame();
  root.name = String(job.name || DefaultRootName);
  root.resize(manifest.canvas.width, manifest.canvas.height);
  root.x = numericOr(job.x, 0);
  root.y = numericOr(job.y, 0);
  root.fills = [];
  root.strokes = [];
  root.clipsContent = false;
  writePsdRootMetadata(root, job, manifest);

  const parent = await resolveTargetParent(job.target);
  parent.appendChild(root);
  return root;
}

function writePsdRootMetadata(root, job, manifest) {
  writePluginData(root, {
    importKind: "psd-layer-to-figma",
    schemaVersion: "3",
    source: String(job.source || ""),
    psdSchemaVersion: "3",
    psdImportSchemaVersion: "3",
    psdSourceFileName: normalizedPsdSourceFileName(job),
    psdSourceKey: buildPsdSourceKey(job, manifest),
    psdLayerSetFingerprint: hashPsdLayerIds(manifest.layers),
    psdCanvasWidth: String(manifest.canvas.width),
    psdCanvasHeight: String(manifest.canvas.height)
  });
}

function buildPsdSourceKey(job, manifest) {
  return `${normalizedPsdSourceFileName(job)}:${manifest.canvas.width}x${manifest.canvas.height}:${hashPsdLayerIds(manifest.layers)}`;
}

function normalizedPsdSourceFileName(job) {
  return String(job && (job.sourceFileName || job.name) || "")
    .split(/[\\/]/)
    .pop()
    .trim()
    .toLowerCase();
}

function hashPsdLayerIds(layers) {
  const text = (layers || [])
    .map((layer) => normalizePsdLayerId(layer.layerId))
    .filter(Boolean)
    .sort()
    .join(",");
  return hashPsdString(text);
}

function hashPsdString(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// 解析目标父节点；目标不是容器时回退到当前页面。
async function resolveTargetParent(target) {
  const nodeId = target && target.nodeId ? String(target.nodeId) : "";
  if (!nodeId) {
    return figma.currentPage;
  }

  const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!node) {
    return figma.currentPage;
  }
  if (node.type === "PAGE") {
    await figma.setCurrentPageAsync(node);
    return node;
  }
  if ("appendChild" in node) {
    return node;
  }
  return node.parent && "appendChild" in node.parent ? node.parent : figma.currentPage;
}

// 根据图层模式创建对应 Figma 节点，common 失败时自动降级为图片层。
async function createLayerNode(root, layer, context) {
  if (layer.mode === "common-component") {
    const instance = await tryCreateCommonInstance(root, layer, context);
    if (instance) {
      return instance;
    }
    context.stats.commonFallbackImage += 1;
    context.commonReports.push({
      idx: layer.idx,
      name: layer.name,
      status: "fallback-image",
      candidates: buildCommonCandidateNames(layer),
      reason: "组件库未命中，已降级为图片"
    });
    context.warnings.push(`${layer.idx}:${layer.name}: common 组件未命中，已降级为图片。`);
  }

  if (layer.mode === "text") {
    return await createTextLayer(root, layer, context);
  }

  if (layer.mode === "nine-slice") {
    return await createSliceLayer(root, layer, context);
  }

  return await createImageLayer(root, layer, context);
}

// 尝试按 manifest 离线匹配结果或 MCP Relay 内组件索引创建通用组件实例。
async function tryCreateCommonInstance(root, layer, context) {
  const match = resolveCommonMatch(layer, context);
  if (!match || !match.componentId) {
    return null;
  }

  const component = await figma.getNodeByIdAsync(String(match.componentId)).catch(() => null);
  if (!component || (component.type !== "COMPONENT" && component.type !== "COMPONENT_SET")) {
    context.warnings.push(`${layer.idx}:${layer.name}: 匹配组件 ${match.componentId} 不存在。`);
    return null;
  }

  const instance = component.type === "COMPONENT_SET" && component.defaultVariant
    ? component.defaultVariant.createInstance()
    : component.createInstance();
  root.appendChild(instance);
  if (shouldUsePsdLayerSizeForCommonInstance(match, component, layer)) {
    applyLayerGeometry(instance, layer);
  } else {
    applyInstanceGeometry(instance, layer);
  }
  applyLayerCommonState(instance, layer);
  writeLayerMetadata(instance, layer, {
    matchedComponentName: String(match.matchedComponentName || component.name),
    matchStrategy: String(match.matchStrategy || ""),
    matchConfidence: String(firstDefined(match.matchConfidence, ""))
  });
  context.commonReports.push({
    idx: layer.idx,
    name: layer.name,
    status: "instance",
    matchedComponentId: component.id,
    matchedComponentName: component.name,
    matchStrategy: String(match.matchStrategy || ""),
    matchConfidence: Number(firstDefined(match.matchConfidence, 0))
  });
  context.stats.commonInstance += 1;
  return instance;
}

// 创建普通图片层，使用 figma.createImage 生成 imageHash 后直接设置填充。
async function createImageLayer(root, layer, context) {
  const rect = figma.createRectangle();
  rect.name = buildImageLayerName(layer);
  root.appendChild(rect);
  applyLayerGeometry(rect, layer);
  applyLayerCommonState(rect, layer);
  rect.fills = [await createImagePaint(layer, context, "FILL", null)];
  writeLayerMetadata(rect, layer, {});
  context.stats.image += 1;
  return rect;
}

// 创建可编辑文字层，颜色和描边严格来自 manifest 数据。
async function createTextLayer(root, layer, context) {
  const text = figma.createText();
  text.name = buildTextLayerName(layer);
  root.appendChild(text);

  const fontName = await loadBestFont(layer, context);
  text.fontName = fontName;
  text.characters = String(layer.chars || "");
  const resolvedFontSize = positiveOr(layer.effectiveFontSize, positiveOr(layer.fontSize, Math.max(12, layer.h)));
  text.fontSize = resolvedFontSize;
  const sourceText = layer.sourceState && layer.sourceState.text || {};
  text.lineHeight = sourceText.lineHeightMode === "PIXELS" && Number(sourceText.leading) > 0
    ? { unit: "PIXELS", value: Number(sourceText.leading) }
    : { unit: "AUTO" };
  text.textAutoResize = "WIDTH_AND_HEIGHT";
  text.textAlignHorizontal = normalizeTextAlign(layer.textAlign, layer, context.manifest.canvas);
  text.textAlignVertical = "CENTER";
  text.fills = [solidPaintFromManifest(layer.fillColor, 1)];
  if (layer.stroke && layer.stroke.enabled === true) {
    text.strokes = [solidPaintFromManifest({
      r: layer.stroke.r,
      g: layer.stroke.g,
      b: layer.stroke.b
    }, 1)];
    text.strokeWeight = numericOr(layer.stroke.size, 1);
    text.strokeAlign = "OUTSIDE";
  } else {
    text.strokes = [];
  }
  applyPsdTextShadow(text, sourceText.dropShadow);

  centerNodeOnLayer(text, layer);
  const sourceGeometry = layer.sourceState && layer.sourceState.geometry || {};
  if (Number.isFinite(sourceGeometry.rotation)) text.rotation = sourceGeometry.rotation;
  if ("constraints" in text && layer.constraints) {
    text.constraints = {
      horizontal: normalizeConstraint(layer.constraints.horizontal, "MIN"),
      vertical: normalizeConstraint(layer.constraints.vertical, "MIN")
    };
  }
  // 首次导入后冻结当前几何；后续增量只改 characters，不让自动尺寸扰动整理后的布局。
  text.textAutoResize = "NONE";
  applyLayerCommonState(text, layer);
  writeLayerMetadata(text, layer, {
    fontFamily: fontName.family,
    fontStyle: fontName.style,
    fillHex: String(layer.fillColor && layer.fillColor.hex || ""),
    originalFontSize: String(layer.originalFontSize || layer.fontSize || ""),
    effectiveFontSize: String(resolvedFontSize),
    effectiveSizeSource: String(layer.effectiveSizeSource || "")
  });
  context.textReports.push({
    idx: layer.idx,
    name: layer.name,
    characters: String(layer.chars || ""),
    fontSize: resolvedFontSize,
    originalFontSize: numericOr(layer.originalFontSize, numericOr(layer.fontSize, 0)),
    effectiveSizeSource: String(layer.effectiveSizeSource || ""),
    fillHex: String(layer.fillColor && layer.fillColor.hex || ""),
    strokeEnabled: !!(layer.stroke && layer.stroke.enabled === true),
    strokeSize: layer.stroke && layer.stroke.enabled === true ? numericOr(layer.stroke.size, 0) : 0,
    fontFamily: fontName.family,
    fontStyle: fontName.style
  });
  context.stats.text += 1;
  return text;
}

// 创建九宫、横向三切片或纵向三切片父层，按 slices 数据动态生成子切片。
async function createSliceLayer(root, layer, context) {
  const frame = figma.createFrame();
  frame.name = buildSliceLayerName(layer);
  root.appendChild(frame);
  applyLayerGeometry(frame, layer);
  applyLayerCommonState(frame, layer);
  const imageHash = await getImageHash(layer, context);
  frame.fills = [createImagePaintFromHash(imageHash, "FILL", null, 0)];
  frame.strokes = [];
  frame.clipsContent = false;
  writeLayerMetadata(frame, layer, {
    border: JSON.stringify(layer.border || {}),
    sliceCount: String((layer.slices || []).length),
    sourceImageFillIndex: "0",
    nodeRole: "nineSliceParent"
  });

  const slices = Array.isArray(layer.slices) ? layer.slices : [];
  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = String(slice.name || "__slice");
    frame.appendChild(sliceNode);
    const target = normalizeRectArray(slice.target);
    sliceNode.x = target[0];
    sliceNode.y = target[1];
    sliceNode.resize(positiveOr(target[2], 1), positiveOr(target[3], 1));
    sliceNode.fills = [createImagePaintFromHash(imageHash, "CROP", buildCropTransform(slice, layer), 1)];
    sliceNode.strokes = [];
    sliceNode.constraints = inferSliceConstraints(sliceNode, frame);
    writePluginData(sliceNode, {
      sourceRect: JSON.stringify(normalizeRectArray(slice.source)),
      parentLayerIndex: String(layer.idx),
      psdParentLayerId: normalizePsdLayerId(layer.layerId),
      psdSliceRole: "slice"
    });
    context.stats.slice += 1;
  }

  context.sliceReports.push({
    idx: layer.idx,
    name: layer.name,
    childCount: slices.length,
    sliceKind: inferSliceKindFromSlices(slices),
    border: layer.border || {},
    inferredBorder: !!layer.inferredBorder,
    inferMethod: String(layer.inferMethod || ""),
    confidence: String(layer.confidence || "")
  });
  context.stats.nineSlice += 1;
  return frame;
}

// 根据源切片数据计算 Figma CROP imageTransform，禁止取倒数。
function buildCropTransform(slice, layer) {
  const source = normalizeRectArray(slice.source);
  const imageWidth = positiveOr(layer.sourceImageWidth || layer.w, layer.w);
  const imageHeight = positiveOr(layer.sourceImageHeight || layer.h, layer.h);
  const transform = [
    [source[2] / imageWidth, 0, source[0] / imageWidth],
    [0, source[3] / imageHeight, source[1] / imageHeight]
  ];
  assertTransformInRange(transform, `${layer.idx}:${layer.name}:${slice.name}`);
  return transform;
}

// 获取或创建图层图片 hash，同一 assetId 在本次导入内复用。
async function getImageHash(layer, context) {
  const assetId = String(layer.assetId || layer.idx);
  if (context.imageHashes.has(assetId)) {
    return context.imageHashes.get(assetId);
  }

  const bytes = context.assetBytes.get(assetId);
  if (!bytes || bytes.length === 0) {
    throw new Error(`缺少图片资源 assetId=${assetId}`);
  }
  const image = figma.createImage(bytes);
  context.imageHashes.set(assetId, image.hash);
  return image.hash;
}

// 创建 IMAGE paint，支持普通 FILL 和 CROP 切片。
async function createImagePaint(layer, context, scaleMode, imageTransform) {
  return createImagePaintFromHash(await getImageHash(layer, context), scaleMode, imageTransform);
}

// 根据已创建的 imageHash 创建 IMAGE paint，九宫父节点和子切片共用同一张源图。
function createImagePaintFromHash(imageHash, scaleMode, imageTransform, opacity) {
  const paint = {
    type: "IMAGE",
    imageHash,
    scaleMode,
    opacity: typeof opacity === "number" ? opacity : 1
  };
  if (scaleMode === "CROP" && imageTransform) {
    paint.imageTransform = imageTransform;
  }
  return paint;
}

// 缓存本机可用字体列表和替换结果，避免重复调用 listAvailableFontsAsync。
let _availableFontsCache = null;
const _fontSubstituteCache = new Map();

// 获取本机可用字体列表（单次调用后缓存）。
async function getAvailableFonts() {
  if (_availableFontsCache) return _availableFontsCache;
  try {
    _availableFontsCache = await figma.listAvailableFontsAsync();
  } catch (e) {
    _availableFontsCache = [];
  }
  return _availableFontsCache;
}

// 在可用字体列表中模糊匹配最接近的目标字体。
function findBestFontMatch(targetFamily, targetStyle, availableFonts) {
  if (!availableFonts.length) return null;

  // 精确匹配
  const exact = availableFonts.find(function (f) {
    return f.fontName.family === targetFamily && f.fontName.style === targetStyle;
  });
  if (exact) return exact.fontName;

  // family 精确匹配 + 任意 style
  var familyMatches = availableFonts.filter(function (f) {
    return f.fontName.family === targetFamily;
  });
  if (familyMatches.length > 0) {
    var styleMatch = familyMatches.find(function (f) { return f.fontName.style === targetStyle; });
    return styleMatch ? styleMatch.fontName : familyMatches[0].fontName;
  }

  // family 包含关系匹配（忽略大小写）
  var a = targetFamily.toLowerCase();
  var similar = availableFonts.filter(function (f) {
    var b = f.fontName.family.toLowerCase();
    return a.includes(b) || b.includes(a);
  });
  if (similar.length > 0) {
    var s = similar.find(function (f) { return f.fontName.style === targetStyle; });
    return s ? s.fontName : similar[0].fontName;
  }

  return null;
}

// 加载文字字体：PSD 候选字体 → 本机模糊匹配 → Inter 保底。
async function loadBestFont(layer, context) {
  const candidates = normalizeFontCandidates(layer.fontFallback);
  const availableFonts = await getAvailableFonts();

  for (const fontName of candidates) {
    var cacheKey = fontName.family + "|" + fontName.style;
    if (_fontSubstituteCache.has(cacheKey)) {
      var cached = _fontSubstituteCache.get(cacheKey);
      if (cached) return cached;
      continue; // 之前已判定不可用，跳过
    }

    try {
      await figma.loadFontAsync(fontName);
      _fontSubstituteCache.set(cacheKey, fontName);
      return fontName;
    } catch (error) {
      // PSD 字体不可用，尝试本机模糊匹配
      var match = findBestFontMatch(fontName.family, fontName.style, availableFonts);
      if (match) {
        try {
          await figma.loadFontAsync(match);
          _fontSubstituteCache.set(cacheKey, match);
          context.warnings.push(
            layer.idx + ":" + layer.name + ": 字体 " + fontName.family + " " + fontName.style +
            " 不可用，已自动替换为 " + match.family + " " + match.style
          );
          return match;
        } catch (e2) {}
      }
      _fontSubstituteCache.set(cacheKey, null);
      context.warnings.push(
        layer.idx + ":" + layer.name + ": 字体 " + fontName.family + " " + fontName.style + " 加载失败。"
      );
    }
  }

  // 最终保底：Inter
  var fallbacks = [
    { family: "Inter", style: "Bold" },
    { family: "Inter", style: "Regular" }
  ];
  for (var i = 0; i < fallbacks.length; i++) {
    try {
      await figma.loadFontAsync(fallbacks[i]);
      return fallbacks[i];
    } catch (e) {}
  }
  throw new Error("无法加载任何可用字体。");
}

// 规范化字体候选，兼容字符串或 {family, style} 格式。
function normalizeFontCandidates(value) {
  const result = [];
  const list = Array.isArray(value) ? value : [];
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      result.push({ family: item.trim(), style: "Regular" });
    } else if (item && typeof item === "object" && item.family) {
      result.push({
        family: String(item.family),
        style: String(item.style || "Regular")
      });
    }
  }
  return result;
}

// 应用图层位置、尺寸和约束。
function applyLayerGeometry(node, layer) {
  node.x = numericOr(layer.x, 0);
  node.y = numericOr(layer.y, 0);
  if ("resize" in node) {
    node.resize(positiveOr(layer.w, 1), positiveOr(layer.h, 1));
  }
  if ("constraints" in node && layer.constraints) {
    node.constraints = {
      horizontal: normalizeConstraint(layer.constraints.horizontal, "MIN"),
      vertical: normalizeConstraint(layer.constraints.vertical, "MIN")
    };
  }
  const sourceGeometry = layer.sourceState && layer.sourceState.geometry || {};
  if ("rotation" in node && Number.isFinite(sourceGeometry.rotation)) {
    node.rotation = sourceGeometry.rotation;
  }
}

// 应用 common 组件 Instance 几何属性：保留模板原生尺寸，居中于 PSD 图层位置。
function applyInstanceGeometry(instance, layer) {
  var cx = numericOr(layer.x, 0) + positiveOr(layer.w, 1) / 2;
  var cy = numericOr(layer.y, 0) + positiveOr(layer.h, 1) / 2;
  instance.x = Math.round(cx - instance.width / 2);
  instance.y = Math.round(cy - instance.height / 2);
  if ("constraints" in instance && layer.constraints) {
    instance.constraints = {
      horizontal: normalizeConstraint(layer.constraints.horizontal, "MIN"),
      vertical: normalizeConstraint(layer.constraints.vertical, "MIN")
    };
  }
}

// 判断 common 实例尺寸策略：Common_Texture 保持 PSD 图层尺寸，Common_Prefab 保持模板原生尺寸，
// 但 Common_Prefab Btn 按钮组件例外，使用 PSD 图层尺寸。
function shouldUsePsdLayerSizeForCommonInstance(match, component, layer) {
  const names = [
    match && match.matchedComponentName,
    component && component.name,
    layer && layer.name,
    layer && layer.rawPsdLayerName,
    layer && layer.normalizedLayerName
  ].map((value) => String(value || ""));
  if (names.some(isCommonTextureName)) {
    return true;
  }
  if (names.some(isCommonPrefabBtnName)) {
    return true;
  }
  if (names.some(isCommonPrefabName)) {
    return false;
  }
  const matchStrategy = String(match && match.matchStrategy || "");
  return matchStrategy.includes("image-library");
}

// 判断名称是否属于通用纹理组件，纹理组件必须按 PSD 图层尺寸缩放。
function isCommonTextureName(value) {
  return normalizeNameForMatch(value).startsWith("commontexture");
}

// 判断名称是否属于通用预制体组件，预制体组件必须保留模板原生尺寸。
function isCommonPrefabName(value) {
  return normalizeNameForMatch(value).startsWith("commonprefab");
}

// 判断名称是否属于通用预制体按钮组件，按钮组件按 PSD 图层尺寸缩放。
function isCommonPrefabBtnName(value) {
  const normalized = normalizeNameForMatch(value);
  return normalized.startsWith("commonprefab") && normalized.includes("btn");
}

// 应用图层显隐和透明度。
function applyLayerCommonState(node, layer) {
  const display = layer.sourceState && layer.sourceState.display || {};
  node.visible = display.visible !== undefined ? display.visible !== false : layer.visible !== false;
  node.opacity = clamp01(display.opacity !== undefined ? display.opacity : layer.opacity);
  if ("blendMode" in node && display.blendMode) node.blendMode = display.blendMode;
}

// 把 Text 按原始 PSD 图层中心点回摆，避免自动尺寸改变后跑位。
function centerNodeOnLayer(node, layer) {
  const centerX = numericOr(layer.x, 0) + positiveOr(layer.w, 1) / 2;
  const centerY = numericOr(layer.y, 0) + positiveOr(layer.h, 1) / 2;
  node.x = centerX - node.width / 2;
  node.y = centerY - node.height / 2;
}

// 写入 PSD 图层元数据，供后续 Unity 导入或排查问题。
function writeLayerMetadata(node, layer, extra) {
  const sourceState = normalizePsdSourceState(layer);
  const metadata = {
    rawPsdLayerName: layer.rawPsdLayerName,
    normalizedLayerName: layer.normalizedLayerName,
    semanticMode: layer.semanticMode,
    normalizationWarnings: JSON.stringify(layer.normalizationWarnings || []),
    psdLayerIndex: String(layer.idx),
    psdLayerId: normalizePsdLayerId(layer.layerId),
    psdOriginalName: String(layer.rawPsdLayerName || layer.name || ""),
    psdContentHash: String(layer.contentHash || ""),
    psdOwnership: psdOwnershipForMode(layer.mode),
    psdSourceState: stablePsdSourceStateJson(sourceState),
    psdSourceStateHash: hashPsdSourceState(sourceState)
  };
  Object.assign(metadata, extra || {});
  writePluginData(node, metadata);
}

// 使用 SharedPluginData 写元数据，避免依赖普通 pluginData 的插件清单隔离。
function writePluginData(node, values) {
  if (!node || typeof node.setSharedPluginData !== "function") {
    return;
  }
  for (const [key, value] of Object.entries(values || {})) {
    node.setSharedPluginData(McpMetadataNamespace, key, String(firstDefined(value, "")));
  }
}

// 按 PSD index 重新 append 直接子节点，避免九宫或大背景遮挡前景。
async function ensurePsdIndexOrder(root, orderedLayers, context) {
  for (const layer of orderedLayers) {
    const nodeId = context.nodeByLayerIdx.get(String(layer.idx));
    if (!nodeId) {
      continue;
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && node.parent === root) {
      root.appendChild(node);
    }
  }
}

// 导入后做关键门禁校验，结果会回传给 MCP Relay。
async function validateImportedRoot(root, orderedLayers, context) {
  const validation = {
    directChildCount: root.children.length,
    expectedLayerCount: orderedLayers.length,
    missingNodeCount: 0,
    emptyImageFillCount: 0,
    badTransformCount: 0,
    textClipRiskCount: 0,
    emptyTextCount: 0,
    textColorMismatchCount: 0,
    textStrokeMismatchCount: 0,
    sliceProblemCount: 0,
    emptySliceLayerCount: 0,
    missingSliceSourceFillCount: 0,
    indexOrderBad: 0,
    positionMismatchCount: 0,
    sizeMismatchCount: 0,
    positionMismatches: [],
    sizeMismatches: [],
    screenshotExported: false
  };

  validation.indexOrderBad = countIndexOrderProblems(root);

  for (const layer of orderedLayers) {
    const nodeId = context.nodeByLayerIdx.get(String(layer.idx));
    if (!nodeId) {
      validation.missingNodeCount += 1;
      continue;
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      validation.missingNodeCount += 1;
      continue;
    }
    validation.emptyImageFillCount += countEmptyImageFills(node);
    validation.badTransformCount += countBadTransforms(node);
    if (node.type !== "TEXT") {
      validateLayerGeometry(layer, node, validation);
    }
    if (node.type === "TEXT") {
      if (!String(node.characters || "").length || !String(layer.chars || "").length) {
        validation.emptyTextCount += 1;
      }
      if (node.textAutoResize !== "WIDTH_AND_HEIGHT" || !node.lineHeight || node.lineHeight.unit !== "AUTO") {
        validation.textClipRiskCount += 1;
      }
      const textResult = validateTextAgainstLayer(node, layer);
      validation.textColorMismatchCount += textResult.fillMismatch ? 1 : 0;
      validation.textStrokeMismatchCount += textResult.strokeMismatch ? 1 : 0;
    }
    if (layer.mode === "nine-slice") {
      const expectedSliceCount = Array.isArray(layer.slices) ? layer.slices.length : 0;
      const actualSliceCount = node.type === "FRAME" && "children" in node
        ? node.children.filter((child) => String(child.name).startsWith("__slice_")).length
        : 0;
      if (expectedSliceCount <= 0 || actualSliceCount <= 0) {
        validation.emptySliceLayerCount += 1;
      }
      if (node.type === "FRAME") {
        validation.sliceProblemCount += validateSliceFrame(node);
        validation.missingSliceSourceFillCount += hasNineSliceSourceFill(node) ? 0 : 1;
      } else {
        validation.sliceProblemCount += 1;
        validation.missingSliceSourceFillCount += 1;
      }
    }
  }
  return validation;
}

// 构建最终状态，任何门禁失败都返回 completed_with_errors。
function buildFinalStatus(context, validation) {
  if (context.errors.length > 0) {
    return "completed_with_errors";
  }
  if (!validation || validation.screenshotExported !== true) {
    return "completed_with_errors";
  }
  const gateFields = ["missingNodeCount", "emptyImageFillCount", "badTransformCount", "textClipRiskCount", "emptyTextCount", "textColorMismatchCount", "textStrokeMismatchCount", "sliceProblemCount", "emptySliceLayerCount", "missingSliceSourceFillCount", "indexOrderBad", "positionMismatchCount", "sizeMismatchCount"];
  for (const field of gateFields) {
    if (numericOr(validation[field], 0) > 0) {
      return "completed_with_errors";
    }
  }
  return "completed";
}

function buildLayerMismatchRecord(layer, node, kind, values) {
  return {
    kind: kind,
    layerIndex: numericOr(layer && layer.idx, 0),
    layerName: String(layer && layer.name || ""),
    rawPsdLayerName: String(layer && layer.rawPsdLayerName || ""),
    nodeId: node && node.id ? node.id : "",
    nodeName: node && node.name ? node.name : "",
    nodeType: node && node.type ? node.type : "",
    expected: values.expected,
    actual: values.actual,
    delta: values.delta
  };
}

function validateLayerGeometry(layer, node, validation) {
  if (shouldValidateCommonPrefabByCenter(layer, node)) {
    const expectedCenter = layerCenter(layer);
    const actualCenter = nodeCenter(node);
    if (Math.abs(actualCenter.x - expectedCenter.x) > 1.5 || Math.abs(actualCenter.y - expectedCenter.y) > 1.5) {
      validation.positionMismatchCount += 1;
      validation.positionMismatches.push(buildLayerMismatchRecord(layer, node, "center-position", {
        expected: expectedCenter,
        actual: actualCenter,
        delta: { x: roundDelta(actualCenter.x - expectedCenter.x), y: roundDelta(actualCenter.y - expectedCenter.y) }
      }));
    }
    return;
  }

  const expectedX = numericOr(layer.x, 0);
  const expectedY = numericOr(layer.y, 0);
  const actualX = numericOr(node.x, 0);
  const actualY = numericOr(node.y, 0);
  if (Math.abs(actualX - expectedX) > 1.5 || Math.abs(actualY - expectedY) > 1.5) {
    validation.positionMismatchCount += 1;
    validation.positionMismatches.push(buildLayerMismatchRecord(layer, node, "position", {
      expected: { x: expectedX, y: expectedY },
      actual: { x: actualX, y: actualY },
      delta: { x: roundDelta(actualX - expectedX), y: roundDelta(actualY - expectedY) }
    }));
  }
  const expectedWidth = positiveOr(layer.w, 1);
  const expectedHeight = positiveOr(layer.h, 1);
  const actualWidth = positiveOr(node.width, 1);
  const actualHeight = positiveOr(node.height, 1);
  if (Math.abs(actualWidth - expectedWidth) > 1.5 || Math.abs(actualHeight - expectedHeight) > 1.5) {
    validation.sizeMismatchCount += 1;
    validation.sizeMismatches.push(buildLayerMismatchRecord(layer, node, "size", {
      expected: { width: expectedWidth, height: expectedHeight },
      actual: { width: actualWidth, height: actualHeight },
      delta: { width: roundDelta(actualWidth - expectedWidth), height: roundDelta(actualHeight - expectedHeight) }
    }));
  }
}

function shouldValidateCommonPrefabByCenter(layer, node) {
  const names = [
    node && node.name,
    readSharedPluginData(node, "matchedComponentName"),
    layer && layer.name,
    layer && layer.rawPsdLayerName,
    layer && layer.normalizedLayerName
  ].map((value) => String(value || ""));
  return names.some(isCommonPrefabName) && !names.some(isCommonPrefabBtnName) && !names.some(isCommonTextureName);
}

function layerCenter(layer) {
  return {
    x: numericOr(layer && layer.x, 0) + positiveOr(layer && layer.w, 1) / 2,
    y: numericOr(layer && layer.y, 0) + positiveOr(layer && layer.h, 1) / 2
  };
}

function nodeCenter(node) {
  return {
    x: numericOr(node && node.x, 0) + positiveOr(node && node.width, 1) / 2,
    y: numericOr(node && node.y, 0) + positiveOr(node && node.height, 1) / 2
  };
}

function readSharedPluginData(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return "";
  }
  try {
    return node.getSharedPluginData(McpMetadataNamespace, key);
  } catch (error) {
    return "";
  }
}

function roundDelta(value) {
  return Math.round(numericOr(value, 0) * 1000) / 1000;
}

// 在 MCP Relay 内扫描通用组件库和通用图片库，避免标准流程依赖官方/通用 Figma MCP。
async function buildComponentIndexes(job) {
  const config = Object.assign({ commonRootId: "62:115", imageRootId: "2896:32" }, job && job.componentLibrary || {});
  return {
    common: await collectComponentIndex(config.commonRootId),
    image: await collectComponentIndex(config.imageRootId)
  };
}

// 收集某个根节点下的 Component/ComponentSet，用标准化名称建立索引。
async function collectComponentIndex(rootId) {
  const list = [];
  if (!rootId) {
    return { list, byName: {}, byNormalized: {} };
  }
  const root = await findNodeAcrossPages(String(rootId));
  if (!root) {
    return { list, byName: {}, byNormalized: {} };
  }
  const nodes = [];
  if (root.type === "COMPONENT" || root.type === "COMPONENT_SET") {
    nodes.push(root);
  }
  if ("findAll" in root) {
    const foundNodes = root.findAll((node) => node.type === "COMPONENT" || node.type === "COMPONENT_SET");
    for (const foundNode of foundNodes) {
      nodes.push(foundNode);
    }
  }
  const byName = {};
  const byNormalized = {};
  for (const node of nodes) {
    const item = {
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.width || 0,
      height: node.height || 0,
      normalized: normalizeNameForMatch(node.name),
      commonImageName: normalizeNameForMatch(stripCommonImagePrefix(node.name))
    };
    list.push(item);
    byName[item.name] = item;
    for (const key of [item.normalized, item.commonImageName]) {
      byNormalized[key] = byNormalized[key] || [];
      byNormalized[key].push(item);
    }
  }
  return { list, byName, byNormalized };
}

// 跨页面查找节点，并在需要时加载页面内容。
async function findNodeAcrossPages(nodeId) {
  const originalPage = figma.currentPage;
  let foundNode = null;
  for (const page of figma.root.children) {
    await figma.setCurrentPageAsync(page);
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (node) {
      foundNode = node;
      break;
    }
  }
  if (originalPage && figma.currentPage !== originalPage) {
    await figma.setCurrentPageAsync(originalPage);
  }
  return foundNode;
}

// 解析 common 匹配：优先 manifest 离线结果，其次 MCP Relay 内组件库索引。
function resolveCommonMatch(layer, context) {
  const offline = layer.match || {};
  const offlineId = offline.matchedComponentId || layer.matchedComponentId;
  if (offlineId) {
    return {
      componentId: String(offlineId),
      matchedComponentName: String(offline.matchedComponentName || ""),
      matchStrategy: String(offline.matchMethod || offline.matchStrategy || "manifest-offline"),
      matchConfidence: firstDefined(offline.matchConfidence, 1)
    };
  }
  const candidates = buildCommonCandidateNames(layer);
  const commonMatch = findBestComponentMatch(candidates, context.componentIndexes.common, layer, 0.88);
  if (commonMatch) {
    return commonMatch;
  }
  const imageMatch = findBestComponentMatch(candidates, context.componentIndexes.image, layer, 1.0);
  if (imageMatch) {
    imageMatch.matchStrategy = "common-image-name-binding";
    imageMatch.matchConfidence = 1;
    return imageMatch;
  }
  return null;
}

// 生成 common 候选名，兼容 common_ / Common_ / __ImportBounds。
function buildCommonCandidateNames(layer) {
  const raw = String(layer.query || layer.name || "");
  const cleanRaw = stripLayerCopyNoiseForMatch(raw);
  const stripped = stripImportBoundsSuffix(stripCommonImagePrefix(cleanRaw).replace(/^common[\s_-]*/i, ""));
  const names = [];
  for (const name of [
    raw,
    cleanRaw,
    stripped,
    `${stripped}__ImportBounds`,
    `${stripped}_1`,
    `Common_${stripped}`,
    `Common_Prefab_${stripped}`,
    `Common_Texture_${stripped}`
  ]) {
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

// 在组件索引中做精确/标准化/轻量模糊匹配。
function findBestComponentMatch(candidates, index, layer, fuzzyThreshold) {
  if (!index || !Array.isArray(index.list)) {
    return null;
  }
  for (const candidate of candidates) {
    if (index.byName[candidate]) {
      return componentMatchResult(index.byName[candidate], "exact-name", 1);
    }
  }
  for (const candidate of candidates) {
    const hits = index.byNormalized[normalizeNameForMatch(candidate)] || [];
    if (hits.length === 1) {
      return componentMatchResult(hits[0], "normalized-name", 1);
    }
  }
  let best = null;
  let secondScore = 0;
  for (const item of index.list) {
    for (const candidate of candidates) {
      const score = scoreComponentCandidate(candidate, item, layer);
      if (!best || score > best.score) {
        secondScore = best ? best.score : secondScore;
        best = { item, score };
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
  }
  if (best && best.score >= fuzzyThreshold && best.score - secondScore >= 0.08) {
    return componentMatchResult(best.item, "fuzzy-name-size", best.score);
  }
  return null;
}

// 组件匹配返回对象。
function componentMatchResult(item, strategy, confidence) {
  return { componentId: item.id, matchedComponentName: item.name, matchStrategy: strategy, matchConfidence: confidence };
}

// 轻量评分：名称相似度为主，尺寸相似度为辅。
function scoreComponentCandidate(candidate, item, layer) {
  const a = normalizeNameForMatch(candidate);
  const b = item.normalized;
  if (!a || !b) {
    return 0;
  }
  let nameScore = similarityScore(a, b);
  if (a.includes(b) || b.includes(a)) {
    nameScore = Math.max(nameScore, 0.86);
  }
  return nameScore * 0.82 + scoreSizeSimilarity(layer, item) * 0.18;
}

// 名称相似度，避免引入高成本算法。
function similarityScore(a, b) {
  if (a === b) {
    return 1;
  }
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (!longer) {
    return 0;
  }
  let same = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) {
      same += 1;
    }
  }
  return same / longer.length;
}

// 尺寸相似度。
function scoreSizeSimilarity(layer, item) {
  const lw = positiveOr(layer.w, 1);
  const lh = positiveOr(layer.h, 1);
  const iw = positiveOr(item.width, 1);
  const ih = positiveOr(item.height, 1);
  return Math.max(0, 1 - Math.abs((lw / lh) - (iw / ih)));
}

// 标准化名称用于组件匹配。
function normalizeNameForMatch(value) {
  return stripLayerCopyNoiseForMatch(value).toLowerCase().replace(/__importbounds$/i, "").replace(/\.(png|jpg|jpeg|webp)$/i, "").replace(/[\s_\-\[\]\(\)]/g, "");
}

// 仅清理 PSD/Figma 自动复制产生的噪声，避免删除有业务含义的中文名称。
function stripLayerCopyNoiseForMatch(value) {
  return String(value || "")
    .trim()
    .replace(/^\d+[\s_.-]+/, "")
    .replace(/[\s_-]*(?:copy|副本|拷贝)(?:[\s_-]*\d+)?$/i, "")
    .trim();
}

// 去掉 Common_ / image_ 等可选前缀。
function stripCommonImagePrefix(value) {
  return String(value || "").replace(/^(common|image|img)[\s_-]*/i, "");
}

function stripImportBoundsSuffix(value) {
  return String(value || "").replace(/__ImportBounds$/i, "");
}

// 导出根节点截图，作为 MCP Relay 标准交付证据。
async function exportRootScreenshot(root, context) {
  try {
    const bytes = await promiseWithTimeout(root.exportAsync({ format: "PNG" }), 45000, "root screenshot export timeout");
    return {
      fileName: `${sanitizeFileName(root.name)}_${root.id.replace(":", "_")}.png`,
      mimeType: "image/png",
      width: root.width,
      height: root.height,
      byteLength: bytes.length,
      base64: bytesToBase64(bytes)
    };
  } catch (error) {
    context.warnings.push(`截图导出失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// Uint8Array 转 base64，分块避免参数过长。
function promiseWithTimeout(promise, timeoutMs, message) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error(message || "operation timeout"));
    }, timeoutMs);
    promise.then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

// 文件名清理。
function sanitizeFileName(value) {
  return String(value || "figma_export").replace(/[\\/:*?"<>|]/g, "_");
}

// 检查直接子节点 PSD index 是否升序。
function countIndexOrderProblems(root) {
  let bad = 0;
  let prev = -Infinity;
  for (const child of root.children) {
    const idx = numericOr(child.getSharedPluginData(McpMetadataNamespace, "psdLayerIndex"), parseIndexFromName(child.name));
    if (idx < prev) {
      bad += 1;
    }
    prev = idx;
  }
  return bad;
}

// 从名称前缀解析 index。
function parseIndexFromName(name) {
  const match = String(name || "").match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

// Text 创建后与 manifest 的颜色、描边做全量对比。
function validateTextAgainstLayer(node, layer) {
  const result = { fillMismatch: false, strokeMismatch: false };
  const fill = Array.isArray(node.fills) && node.fills[0] && node.fills[0].type === "SOLID" ? node.fills[0] : null;
  const expectedFill = layer.fillColor || {};
  if (!fill || !closeNumber(fill.color.r, expectedFill.r) || !closeNumber(fill.color.g, expectedFill.g) || !closeNumber(fill.color.b, expectedFill.b)) {
    result.fillMismatch = true;
  }
  const strokes = Array.isArray(node.strokes) ? node.strokes : [];
  if (layer.stroke && layer.stroke.enabled === true) {
    const stroke = strokes[0] && strokes[0].type === "SOLID" ? strokes[0] : null;
    if (!stroke || !closeNumber(stroke.color.r, layer.stroke.r) || !closeNumber(stroke.color.g, layer.stroke.g) || !closeNumber(stroke.color.b, layer.stroke.b) || !closeNumber(node.strokeWeight, layer.stroke.size)) {
      result.strokeMismatch = true;
    }
  } else if (strokes.length > 0) {
    result.strokeMismatch = true;
  }
  return result;
}

// 判断数值近似相等。
function closeNumber(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.002;
}

// 判断是否有切片子节点。
function hasSliceChildren(node) {
  return "children" in node && node.children.some((child) => String(child.name).startsWith("__slice_"));
}

// 校验 h3/v3/9-slice 子切片结构。
function validateSliceFrame(frame) {
  const children = frame.children.filter((child) => String(child.name).startsWith("__slice_"));
  if (children.length === 9) {
    return children.every(hasValidCropTransform) ? 0 : 1;
  }
  if (children.length === 3) {
    const h3 = children.every((child) => Math.abs(child.y) <= 0.01 && Math.abs(child.height - frame.height) <= 0.01);
    const v3 = children.every((child) => Math.abs(child.x) <= 0.01 && Math.abs(child.width - frame.width) <= 0.01);
    if (h3) {
      return children.every(hasValidH3SliceTransform) ? 0 : 1;
    }
    if (v3) {
      return children.every(hasValidV3SliceTransform) ? 0 : 1;
    }
    return 1;
  }
  return 1;
}

// 校验普通九宫切片 CROP transform 是否存在且未越界。
function hasValidCropTransform(node) {
  const transform = getFirstCropTransform(node);
  return !!transform && isTransformInRange(transform);
}

// 校验横向三切片只切 X，保留完整高度。
function hasValidH3SliceTransform(node) {
  const transform = getFirstCropTransform(node);
  return !!transform &&
    isTransformInRange(transform) &&
    closeNumber(transform[1] && transform[1][0], 0) &&
    closeNumber(transform[1] && transform[1][1], 1) &&
    closeNumber(transform[1] && transform[1][2], 0);
}

// 校验纵向三切片只切 Y，保留完整宽度。
function hasValidV3SliceTransform(node) {
  const transform = getFirstCropTransform(node);
  return !!transform &&
    isTransformInRange(transform) &&
    closeNumber(transform[0] && transform[0][0], 1) &&
    closeNumber(transform[0] && transform[0][1], 0) &&
    closeNumber(transform[0] && transform[0][2], 0);
}

// 读取节点首个 CROP 图片填充矩阵。
function getFirstCropTransform(node) {
  const fills = Array.isArray(node && node.fills) ? node.fills : [];
  for (const fill of fills) {
    if (fill && fill.type === "IMAGE" && fill.scaleMode === "CROP" && fill.imageTransform) {
      return fill.imageTransform;
    }
  }
  return null;
}

// 校验九宫父节点是否保留隐藏源图 fill，供后续 Unity 导出链路直接回溯原图。
function hasNineSliceSourceFill(frame) {
  if (!frame || !Array.isArray(frame.fills)) {
    return false;
  }
  return frame.fills.some((fill) => fill && fill.type === "IMAGE" && !!fill.imageHash);
}

function hasExpectedNineSliceImageHash(frame, expectedImageHash) {
  if (!frame || !expectedImageHash || !Array.isArray(frame.fills) || !("children" in frame)) {
    return false;
  }
  const sourcePaints = frame.fills.filter((paint) => paint && paint.type === "IMAGE");
  if (sourcePaints.length !== 1 || sourcePaints[0].imageHash !== expectedImageHash) {
    return false;
  }
  const slices = frame.children.filter((child) => String(child.name).startsWith("__slice_"));
  return slices.length > 0 && slices.every((slice) => {
    const imagePaints = Array.isArray(slice.fills)
      ? slice.fills.filter((paint) => paint && paint.type === "IMAGE")
      : [];
    return imagePaints.length === 1 && imagePaints[0].imageHash === expectedImageHash;
  });
}

// 根据 slices 数量推断报告用切片类型。
function inferSliceKindFromSlices(slices) {
  if (!Array.isArray(slices)) {
    return "unknown";
  }
  if (slices.length === 9) {
    return "9-slice";
  }
  if (slices.length === 3) {
    return slices.every((slice) => normalizeRectArray(slice.target)[1] === 0) ? "h3-slice" : "v3-slice";
  }
  return `slice-${slices.length}`;
}

// 基于当前单选图片节点推断九宫边框，遇到不适合九宫的小图时只报错不创建。
async function suggestNineSliceFromCurrentSelection() {
  const source = getSingleSelectedImageNodeForNineSlice();
  const suggestion = inferManualNineSliceBorderForSuggestion(source);
  const bounds = suggestion.bounds;
  const border = normalizeManualNineSliceBorder(suggestion.border, bounds.width, bounds.height);
  const sliceKind = decideManualNineSliceKind(bounds.width, bounds.height, border);
  if (sliceKind === "image") {
    throw new Error("当前图片尺寸较小且接近正方形，不适合切九宫。");
  }
  const effectiveBorder = buildEffectiveNineSliceBorder(border, sliceKind);
  let imageBase64 = "";
  try {
    const width = positiveOr(bounds.width, positiveOr(source.width, 1));
    const height = positiveOr(bounds.height, positiveOr(source.height, 1));
    const scale = Math.min(200 / width, 200 / height, 1);
    const bytes = await source.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
      contentsOnly: true
    });
    imageBase64 = bytesToBase64(bytes);
  } catch (error) {
    imageBase64 = "";
  }
  return {
    status: "completed",
    nodeId: source.id,
    nodeName: source.name,
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    border: effectiveBorder,
    sliceKind,
    inferMethod: suggestion.inferMethod,
    imageBase64
  };
}

// 自动识别九宫边框：优先复用已有切片和 PSD/MCP Relay 元数据，最后才按尺寸比例兜底。
function inferManualNineSliceBorderForSuggestion(source) {
  const existing = readExistingSliceBorderFromNode(source);
  if (existing) {
    return existing;
  }

  const wrapper = findManualNineSliceWrapperForHiddenSource(source);
  const wrapperExisting = readExistingSliceBorderFromNode(wrapper);
  if (wrapperExisting) {
    return wrapperExisting;
  }

  const shared = readSharedSpriteBorder(source);
  if (shared) {
    return {
      border: shared,
      bounds: getNodeBounds(source),
      inferMethod: "shared-sprite-border"
    };
  }

  const wrapperShared = readSharedSpriteBorder(wrapper);
  if (wrapperShared) {
    return {
      border: wrapperShared,
      bounds: getNodeBounds(wrapper),
      inferMethod: "wrapper-shared-sprite-border"
    };
  }

  const bounds = getNodeBounds(source);
  return {
    border: inferNineSliceBorderFromSize(bounds.width, bounds.height),
    bounds,
    inferMethod: "size-ratio-fallback"
  };
}

// 从已有 __slice_* 子节点反推 Unity spriteBorder，避免覆盖已有九宫时退回 25% 推断。
function readExistingSliceBorderFromNode(node) {
  const info = buildFigmaPrefabNineSliceInfo(node);
  if (!info || !info.border) {
    return null;
  }
  const bounds = getNodeBounds(node);
  const adjusted = adjustManualExistingNineSliceBorder(info.border, bounds, info.sliceKind);
  return {
    border: adjusted.border,
    bounds,
    inferMethod: adjusted.changed
      ? `existing-slices-${info.sliceCount}-large-round-safe`
      : `existing-slices-${info.sliceCount}`
  };
}

// 手动九宫复用已有切片时，拦截大图上异常小的 9-slice border。
// 这只影响“建议值”，不覆盖用户手动输入的明确 border。
function adjustManualExistingNineSliceBorder(border, bounds, sliceKind) {
  const current = {
    left: Math.round(numericOr(border && border.left, 0)),
    bottom: Math.round(numericOr(border && border.bottom, 0)),
    right: Math.round(numericOr(border && border.right, 0)),
    top: Math.round(numericOr(border && border.top, 0))
  };
  if (String(sliceKind || "") !== "9slice") {
    return { border: current, changed: false };
  }
  const width = positiveOr(bounds && bounds.width, 0);
  const height = positiveOr(bounds && bounds.height, 0);
  const shortAxis = Math.min(width, height);
  if (width < 256 || height < 256 || shortAxis <= 0) {
    return { border: current, changed: false };
  }

  const tinyLimit = Math.max(12, Math.round(shortAxis * 0.02));
  const hasTinyHorizontal = current.left <= tinyLimit || current.right <= tinyLimit;
  const hasTinyTop = current.top <= tinyLimit && current.top >= current.bottom;
  const hasTinyBottom = current.bottom <= tinyLimit;
  if (!hasTinyHorizontal && !hasTinyTop && !hasTinyBottom) {
    return { border: current, changed: false };
  }

  const safe = Math.max(24, Math.min(96, Math.round(shortAxis * 0.08)));
  const adjusted = {
    left: hasTinyHorizontal ? Math.max(current.left, safe) : current.left,
    bottom: hasTinyBottom ? Math.max(current.bottom, safe) : current.bottom,
    right: hasTinyHorizontal ? Math.max(current.right, safe) : current.right,
    top: hasTinyTop ? Math.max(current.top, safe) : current.top
  };
  if (adjusted.left + adjusted.right >= width) {
    adjusted.left = current.left;
    adjusted.right = current.right;
  }
  if (adjusted.top + adjusted.bottom >= height) {
    adjusted.top = current.top;
    adjusted.bottom = current.bottom;
  }
  return {
    border: adjusted,
    changed: adjusted.left !== current.left
      || adjusted.right !== current.right
      || adjusted.top !== current.top
      || adjusted.bottom !== current.bottom
  };
}

// 读取 PSD/MCP Relay 写入的 Unity spriteBorder 元数据，格式为 left,bottom,right,top。
function readSharedSpriteBorder(node) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return null;
  }
  const raw = node.getSharedPluginData(McpMetadataNamespace, "spriteBorder");
  const border = parseSpriteBorderString(raw);
  if (border) {
    return border;
  }
  const rawJson = node.getSharedPluginData(McpMetadataNamespace, "border");
  return parseSpriteBorderJson(rawJson);
}

// 解析 Unity spriteBorder 字符串：left,bottom,right,top。
function parseSpriteBorderString(raw) {
  if (!raw) {
    return null;
  }
  const parts = String(raw).split(",").map((part) => Number(String(part).trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  return {
    left: parts[0],
    bottom: parts[1],
    right: parts[2],
    top: parts[3]
  };
}

// 兼容旧数据里 JSON 形式保存的 border。
function parseSpriteBorderJson(raw) {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== "object") {
      return null;
    }
    const border = {
      left: Number(value.left),
      bottom: Number(value.bottom),
      right: Number(value.right),
      top: Number(value.top)
    };
    return Object.keys(border).every((key) => Number.isFinite(border[key]) && border[key] >= 0)
      ? border
      : null;
  } catch (error) {
    return null;
  }
}

// 从当前单选图片节点原地生成九宫或三切片；叶子图层会先转换为同名 Frame。
async function createNineSliceFromCurrentSelection(job) {
  const selectedSource = getSingleSelectedImageNodeForNineSlice();
  const sourceHash = findFirstImageHash(selectedSource, true);
  const selectedBounds = getNodeBounds(selectedSource);
  const existingWrapper = findManualNineSliceWrapperForHiddenSource(selectedSource);
  const bounds = existingWrapper ? getNodeBounds(existingWrapper) : selectedBounds;
  const border = normalizeManualNineSliceBorder(job && job.border, bounds.width, bounds.height);
  const sliceKind = decideManualNineSliceKind(bounds.width, bounds.height, border);
  if (sliceKind === "image") {
    throw new Error("当前图片尺寸较小且接近正方形，不适合切九宫。");
  }
  const effectiveBorder = buildEffectiveNineSliceBorder(border, sliceKind);

  const wrapResult = ensureManualNineSliceContainer(selectedSource, sourceHash, bounds, existingWrapper);
  const source = wrapResult.container;
  const sourceWasVisible = source.visible !== false;
  const originalFills = "fills" in source && Array.isArray(source.fills) ? source.fills.slice() : [];
  const removedOldNineSliceCount = removeDirectSliceChildren(source);
  const slices = buildManualNineSlicePlan(bounds.width, bounds.height, effectiveBorder, sliceKind);
  source.fills = [createImagePaintFromHash(sourceHash, "FILL", null, 0)];
  source.clipsContent = false;
  source.visible = sourceWasVisible;

  writePluginData(source, {
    importKind: "manual-nine-slice",
    nodeRole: "nineSliceParent",
    sourceNodeId: source.id,
    sourceNodeName: source.name || "",
    originalSourceNodeId: wrapResult.originalSourceId || source.id,
    originalSourceNodeName: wrapResult.originalSourceName || source.name || "",
    sourceImageFillIndex: "0",
    sliceKind,
    sliceCount: String(slices.length),
    generatedInSourceNode: "true",
    wrappedSourceNode: wrapResult.wrapped ? "true" : "false",
    border: JSON.stringify(effectiveBorder),
    spriteBorder: [effectiveBorder.left, effectiveBorder.bottom, effectiveBorder.right, effectiveBorder.top].join(",")
  });

  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = slice.name;
    source.appendChild(sliceNode);
    const target = normalizeRectArray(slice.target);
    sliceNode.x = target[0];
    sliceNode.y = target[1];
    sliceNode.resize(positiveOr(target[2], 1), positiveOr(target[3], 1));
    sliceNode.fills = [createImagePaintFromHash(sourceHash, "CROP", buildCropTransform(slice, {
      idx: 0,
      name: source.name || "manual-nine-slice",
      w: bounds.width,
      h: bounds.height,
      sourceImageWidth: bounds.width,
      sourceImageHeight: bounds.height
    }), 1)];
    sliceNode.strokes = [];
    sliceNode.constraints = inferSliceConstraints(sliceNode, source);
    writePluginData(sliceNode, {
      nodeRole: "slice",
      sourceRect: JSON.stringify(normalizeRectArray(slice.source)),
      parentSourceNodeId: source.id
    });
  }

  const sliceProblems = validateSliceFrame(source);
  const badTransformCount = countBadTransforms(source);
  if (sliceProblems > 0 || badTransformCount > 0 || !hasNineSliceSourceFill(source)) {
    removeDirectSliceChildren(source);
    source.fills = originalFills;
    throw new Error(`九宫生成校验失败：sliceProblem=${sliceProblems}, badTransform=${badTransformCount}`);
  }

  figma.currentPage.selection = [source];
  figma.viewport.scrollAndZoomIntoView([source]);
  return {
    status: "completed",
    sourceNodeId: source.id,
    createdNodeId: source.id,
    createdNodeName: source.name,
    summary: {
      sliceKind,
      sliceCount: slices.length,
      border: effectiveBorder,
      sourceNodeName: source.name || "",
      sourceNodeId: source.id,
      sourcePreserved: true,
      generatedInSourceNode: true,
      wrappedSourceNode: wrapResult.wrapped,
      oldNineSliceRemovedCount: removedOldNineSliceCount,
      sourceNodeVisible: source.visible !== false,
      validation: {
        sliceProblemCount: sliceProblems,
        badTransformCount,
        missingSliceSourceFillCount: hasNineSliceSourceFill(source) ? 0 : 1
      }
    },
    warnings: [],
    errors: []
  };
}

// 根据最终切片类型输出实际生效的 Unity spriteBorder，三切片会清零未使用轴。
function buildEffectiveNineSliceBorder(border, sliceKind) {
  const value = {
    left: Math.round(numericOr(border && border.left, 0)),
    bottom: Math.round(numericOr(border && border.bottom, 0)),
    right: Math.round(numericOr(border && border.right, 0)),
    top: Math.round(numericOr(border && border.top, 0))
  };
  if (sliceKind === "h3-slice") {
    value.bottom = 0;
    value.top = 0;
  } else if (sliceKind === "v3-slice") {
    value.left = 0;
    value.right = 0;
  }
  return value;
}

// 校验当前选择必须且只能是一个带 IMAGE fill 的节点。
function getSingleSelectedImageNodeForNineSlice() {
  const selection = figma.currentPage.selection || [];
  if (selection.length === 0) {
    throw new Error("请先在 Figma 画布中选择 1 个图片节点。");
  }
  if (selection.length > 1) {
    throw new Error(`只能选择 1 个图片节点，当前选择了 ${selection.length} 个。`);
  }
  const node = selection[0];
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") {
    throw new Error("当前选择不是可切九宫的图片节点。");
  }
  const bounds = getNodeBounds(node);
  if (positiveOr(bounds.width, 0) <= 1 || positiveOr(bounds.height, 0) <= 1) {
    throw new Error("当前选择尺寸过小，无法切九宫。");
  }
  if (!findFirstImageHash(node, true)) {
    throw new Error("当前选择没有可读取的 IMAGE fill，无法切九宫。");
  }
  return node;
}

// 自动推断默认 border，按 25% 推断并限制在半轴内。
function inferNineSliceBorderFromSize(width, height) {
  const w = positiveOr(width, 1);
  const h = positiveOr(height, 1);
  return {
    left: Math.max(1, Math.floor(Math.min(w * 0.25, (w - 1) / 2))),
    bottom: Math.max(1, Math.floor(Math.min(h * 0.25, (h - 1) / 2))),
    right: Math.max(1, Math.floor(Math.min(w * 0.25, (w - 1) / 2))),
    top: Math.max(1, Math.floor(Math.min(h * 0.25, (h - 1) / 2)))
  };
}

// 校验用户输入的 Unity spriteBorder：left,bottom,right,top。
function normalizeManualNineSliceBorder(value, width, height) {
  const raw = value && typeof value === "object" ? value : {};
  const border = {
    left: numericOr(raw.left, NaN),
    bottom: numericOr(raw.bottom, NaN),
    right: numericOr(raw.right, NaN),
    top: numericOr(raw.top, NaN)
  };
  for (const key of ["left", "bottom", "right", "top"]) {
    if (!Number.isFinite(border[key]) || border[key] < 0) {
      throw new Error(`九宫边框 ${key} 必须是非负数字。`);
    }
    border[key] = Math.round(border[key]);
  }
  const w = positiveOr(width, 1);
  const h = positiveOr(height, 1);
  if (border.left + border.right >= w) {
    throw new Error(`九宫左右边框之和必须小于图片宽度：left+right=${border.left + border.right}, width=${Math.round(w)}`);
  }
  if (border.top + border.bottom >= h) {
    throw new Error(`九宫上下边框之和必须小于图片高度：top+bottom=${border.top + border.bottom}, height=${Math.round(h)}`);
  }
  return border;
}

// 按 PSD 导入规则判断切片类型；小图直接阻止，避免盲目九宫。
function decideManualNineSliceKind(width, height, border) {
  const w = positiveOr(width, 1);
  const h = positiveOr(height, 1);
  const ratio = w / h;
  if (w < 100 && h < 100 && ratio >= 0.5 && ratio <= 2) {
    return "image";
  }
  // 基于 border 值判断三切片类型：支持手动输入 left/right 为 0（v3）或 top/bottom 为 0（h3）
  if (border) {
    const hasH = border.left > 0 && border.right > 0;
    const hasV = border.top > 0 && border.bottom > 0;
    if (hasH && !hasV) return "h3-slice";
    if (!hasH && hasV) return "v3-slice";
    if (hasH && hasV) return "9-slice";
  }
  if (ratio > 3 || (h < 80 && w > h * 3)) {
    return "h3-slice";
  }
  if (ratio < 1 / 3 || (w < 80 && h > w * 3)) {
    return "v3-slice";
  }
  if (!border || border.left <= 0 || border.right <= 0 || border.top <= 0 || border.bottom <= 0) {
    throw new Error("标准九宫需要 left、bottom、right、top 都大于 0。");
  }
  return "9-slice";
}

// 生成 PSD/MCP Relay 兼容的 slices 数据：source 和 target 都使用 [x,y,w,h]。
function buildManualNineSlicePlan(width, height, border, sliceKind) {
  const w = Math.round(positiveOr(width, 1));
  const h = Math.round(positiveOr(height, 1));
  const left = Math.round(border.left);
  const right = Math.round(border.right);
  const top = Math.round(border.top);
  const bottom = Math.round(border.bottom);
  const centerW = Math.max(1, w - left - right);
  const centerH = Math.max(1, h - top - bottom);

  if (sliceKind === "h3-slice") {
    if (left <= 0 || right <= 0) {
      throw new Error("横向三切片需要 left 和 right 大于 0。");
    }
    return [
      { name: "__slice_left", source: [0, 0, left, h], target: [0, 0, left, h] },
      { name: "__slice_center", source: [left, 0, centerW, h], target: [left, 0, centerW, h] },
      { name: "__slice_right", source: [w - right, 0, right, h], target: [w - right, 0, right, h] }
    ];
  }

  if (sliceKind === "v3-slice") {
    if (top <= 0 || bottom <= 0) {
      throw new Error("纵向三切片需要 top 和 bottom 大于 0。");
    }
    return [
      { name: "__slice_top", source: [0, 0, w, top], target: [0, 0, w, top] },
      { name: "__slice_center", source: [0, top, w, centerH], target: [0, top, w, centerH] },
      { name: "__slice_bottom", source: [0, h - bottom, w, bottom], target: [0, h - bottom, w, bottom] }
    ];
  }

  return [
    { name: "__slice_top_left", source: [0, 0, left, top], target: [0, 0, left, top] },
    { name: "__slice_top", source: [left, 0, centerW, top], target: [left, 0, centerW, top] },
    { name: "__slice_top_right", source: [w - right, 0, right, top], target: [w - right, 0, right, top] },
    { name: "__slice_left", source: [0, top, left, centerH], target: [0, top, left, centerH] },
    { name: "__slice_center", source: [left, top, centerW, centerH], target: [left, top, centerW, centerH] },
    { name: "__slice_right", source: [w - right, top, right, centerH], target: [w - right, top, right, centerH] },
    { name: "__slice_bottom_left", source: [0, h - bottom, left, bottom], target: [0, h - bottom, left, bottom] },
    { name: "__slice_bottom", source: [left, h - bottom, centerW, bottom], target: [left, h - bottom, centerW, bottom] },
    { name: "__slice_bottom_right", source: [w - right, h - bottom, right, bottom], target: [w - right, h - bottom, right, bottom] }
  ];
}

// 确保手动九宫有可容纳切片的父节点；叶子图层会原地包装成同名 Frame。
function ensureManualNineSliceContainer(source, sourceHash, bounds, existingWrapper) {
  if (existingWrapper) {
    return {
      container: existingWrapper,
      bounds: getNodeBounds(existingWrapper),
      wrapped: false,
      originalSourceId: source.id,
      originalSourceName: source.name || ""
    };
  }

  if ("children" in source && typeof source.appendChild === "function") {
    return {
      container: source,
      bounds: getNodeBounds(source),
      wrapped: false,
      originalSourceId: source.id,
      originalSourceName: source.name || ""
    };
  }

  const currentWrapper = findManualNineSliceWrapperForHiddenSource(source);
  if (currentWrapper) {
    return {
      container: currentWrapper,
      bounds: getNodeBounds(currentWrapper),
      wrapped: false,
      originalSourceId: source.id,
      originalSourceName: source.name || ""
    };
  }

  const parent = source.parent && "children" in source.parent && typeof source.parent.insertChild === "function"
    ? source.parent
    : null;
  if (!parent) {
    throw new Error("当前图片节点没有可写入的父级，无法原地转换为九宫容器。");
  }

  const index = Math.max(0, parent.children.indexOf(source));
  const wrapper = figma.createFrame();
  wrapper.name = source.name || "NineSlice";
  parent.insertChild(index, wrapper);
  wrapper.x = numericOr(source.x, numericOr(bounds.x, 0));
  wrapper.y = numericOr(source.y, numericOr(bounds.y, 0));
  wrapper.resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)));
  wrapper.fills = [createImagePaintFromHash(sourceHash, "FILL", null, 0)];
  wrapper.strokes = [];
  wrapper.clipsContent = false;
  wrapper.visible = source.visible !== false;
  wrapper.opacity = typeof source.opacity === "number" ? source.opacity : 1;
  if ("constraints" in wrapper && "constraints" in source) {
    wrapper.constraints = cloneObject(source.constraints);
  }

  wrapper.appendChild(source);
  source.x = 0;
  source.y = 0;
  if ("resize" in source) {
    source.resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)));
  }
  source.visible = false;
  writePluginData(source, {
    nodeRole: "hiddenOriginalSource",
    wrappedByManualNineSlice: "true",
    wrapperNodeId: wrapper.id
  });

  return {
    container: wrapper,
    bounds: getNodeBounds(wrapper),
    wrapped: true,
    originalSourceId: source.id,
    originalSourceName: source.name || ""
  };
}

// 如果用户误选了已隐藏的原始叶子图层，复用它的九宫父 Frame，避免重复包一层。
function findManualNineSliceWrapperForHiddenSource(source) {
  if (!source || typeof source.getSharedPluginData !== "function") {
    return null;
  }
  if (source.getSharedPluginData(McpMetadataNamespace, "wrappedByManualNineSlice") !== "true") {
    return null;
  }
  const parent = source.parent && "children" in source.parent && typeof source.parent.appendChild === "function"
    ? source.parent
    : null;
  if (!parent) {
    return null;
  }
  const originalSourceNodeId = typeof parent.getSharedPluginData === "function"
    ? parent.getSharedPluginData(McpMetadataNamespace, "originalSourceNodeId")
    : "";
  if (originalSourceNodeId && originalSourceNodeId !== source.id) {
    return null;
  }
  return parent;
}

// 清理原节点下已有的九宫切片，避免重复生成堆叠。
function removeDirectSliceChildren(source) {
  if (!source || !("children" in source)) {
    return 0;
  }
  const sliceChildren = source.children.filter((child) => String(child && child.name || "").startsWith("__slice_"));
  for (const child of sliceChildren) {
    child.remove();
  }
  return sliceChildren.length;
}

// 统计空 IMAGE fill，避免“节点存在但缺图”。
function countEmptyImageFills(node) {
  let count = hasEmptyImageFill(node) ? 1 : 0;
  if ("children" in node) {
    for (const child of node.children) {
      count += countEmptyImageFills(child);
    }
  }
  return count;
}

// 判断节点是否存在空图片填充。
function hasEmptyImageFill(node) {
  if (!("fills" in node) || !Array.isArray(node.fills)) {
    return false;
  }
  return node.fills.some((fill) => fill && fill.type === "IMAGE" && !fill.imageHash);
}

// 统计 CROP 矩阵越界数量。
function countBadTransforms(node) {
  let count = 0;
  if ("fills" in node && Array.isArray(node.fills)) {
    for (const fill of node.fills) {
      if (fill && fill.type === "IMAGE" && fill.scaleMode === "CROP" && fill.imageTransform) {
        if (!isTransformInRange(fill.imageTransform)) {
          count += 1;
        }
      }
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      count += countBadTransforms(child);
    }
  }
  return count;
}

// 统计节点自身及所有子节点数量。
function countDescendants(node) {
  let count = 1;
  if ("children" in node) {
    for (const child of node.children) {
      count += countDescendants(child);
    }
  }
  return count;
}

// 从 manifest 颜色创建 SOLID paint，颜色值直接使用 0 到 1 通道。
function solidPaintFromManifest(color, opacity) {
  return {
    type: "SOLID",
    color: {
      r: clamp01(color && color.r),
      g: clamp01(color && color.g),
      b: clamp01(color && color.b)
    },
    opacity: clamp01(opacity)
  };
}

// 根据位置推断文本对齐，优先保护视觉居中。
function normalizeTextAlign(value, layer, canvas) {
  const centerX = numericOr(layer.x, 0) + positiveOr(layer.w, 1) / 2;
  const canvasWidth = positiveOr(canvas.width, 1);
  if (centerX >= canvasWidth * 0.4 && centerX <= canvasWidth * 0.6) {
    return "CENTER";
  }
  const text = String(value || "").toUpperCase();
  if (text.includes("RIGHT")) {
    return "RIGHT";
  }
  if (text.includes("CENTER")) {
    return "CENTER";
  }
  return "LEFT";
}

// 根据切片位置设置约束，边缘固定，中间拉伸。
function inferSliceConstraints(sliceNode, parent) {
  const horizontal = sliceNode.x <= 0
    ? "MIN"
    : sliceNode.x + sliceNode.width >= parent.width - 0.01
      ? "MAX"
      : "STRETCH";
  const vertical = sliceNode.y <= 0
    ? "MIN"
    : sliceNode.y + sliceNode.height >= parent.height - 0.01
      ? "MAX"
      : "STRETCH";
  return { horizontal, vertical };
}

// 标准化切片 rect 数组。
function normalizeRectArray(value) {
  const array = Array.isArray(value) ? value : [0, 0, 1, 1];
  return [
    numericOr(array[0], 0),
    numericOr(array[1], 0),
    positiveOr(array[2], 1),
    positiveOr(array[3], 1)
  ];
}

// 检查 CROP 矩阵必须处于 0 到 1，发现错误立即阻止交付。
function assertTransformInRange(transform, label) {
  if (!isTransformInRange(transform)) {
    throw new Error(`切片 imageTransform 越界：${label}`);
  }
}

// 判断 CROP 矩阵所有值是否处于 0 到 1。
function isTransformInRange(transform) {
  for (const row of transform || []) {
    for (const value of row || []) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < -0.0001 || number > 1.0001) {
        return false;
      }
    }
  }
  return true;
}

// 构建图片节点名称，保留 PSD index 方便排查。
function buildImageLayerName(layer) {
  return `${padIndex(layer.idx)}_${resolvePsdDisplayLayerName(layer, "Layer")}`;
}

// 构建文字节点名称，优先使用 PSD 图层名；弱名称时用文字内容兜底。
function buildTextLayerName(layer) {
  return `${padIndex(layer.idx)}_${resolvePsdDisplayLayerName(layer, "Text")}__text`;
}

// 构建切片父节点名称。
function buildSliceLayerName(layer) {
  return `${padIndex(layer.idx)}_${resolvePsdDisplayLayerName(layer, "Slice")}__slice`;
}

// 选择适合显示在 Figma 层级里的 PSD 图层名，避免纯数字、空名和下划线污染层级。
function resolvePsdDisplayLayerName(layer, fallbackKind) {
  const candidates = [
    layer && layer.normalizedLayerName,
    layer && layer.rawPsdLayerName,
    layer && layer.name
  ];
  for (const candidate of candidates) {
    const cleaned = sanitizeFigmaLayerDisplayName(candidate);
    if (!isWeakPsdDisplayName(cleaned)) {
      return cleaned;
    }
  }

  const chars = sanitizeFigmaLayerDisplayName(layer && layer.chars);
  if (fallbackKind === "Text" && chars) {
    return trimFigmaLayerDisplayName(`Text_${chars}`);
  }
  return String(fallbackKind || "Layer");
}

function sanitizeFigmaLayerDisplayName(value) {
  return trimFigmaLayerDisplayName(String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " "));
}

function trimFigmaLayerDisplayName(value) {
  const trimmed = String(value || "").trim().replace(/^_+|_+$/g, "");
  return trimmed.length > 48 ? trimmed.slice(0, 48).trim().replace(/^_+|_+$/g, "") : trimmed;
}

function isWeakPsdDisplayName(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/^[_\-. ]+$/.test(text)) return true;
  if (/^\d+_?$/.test(text)) return true;
  return false;
}

// 将 index 补齐到两位，便于人工检查层级顺序。
function padIndex(index) {
  return String(numericOr(index, 0)).padStart(2, "0");
}

// 约束值白名单化，避免 manifest 中异常字符串导致插件报错。
function normalizeConstraint(value, fallback) {
  const text = String(value || fallback).toUpperCase();
  return ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"].includes(text) ? text : fallback;
}

// 转为 Uint8Array，兼容 ArrayBuffer、数组和 TypedArray。
function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer);
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }
  return new Uint8Array([]);
}

// 数字转换，非法时返回 fallback。
function numericOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// 浅拷贝对象，替代 Figma 旧解析器不支持的 object spread。
function cloneObject(value) {
  return Object.assign({}, value || {});
}

// 兼容 Figma 旧 JS 解析器，替代 nullish coalescing。
function firstDefined(value, fallback) {
  return value !== undefined && value !== null ? value : fallback;
}

// 正尺寸转换，非法或非正数时返回 fallback。
function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// 把数值限制在 0 到 1。
function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(1, number));
}
// ─────────────────────── Figma 选区图片导出到 Unity ───────────────────────

/**
 * 处理 EXPORT_IMAGES_TO_UNITY 消息。
 * 九宫：父节点 exportAsync + 读 pluginData spriteBorder → UI 发 MCP Relay Python cutter 切图
 * 普通：直接 exportAsync → UI 发 Unity Gateway
 */
async function handleExportImagesToUnity(message) {
  const selection = figma.currentPage.selection || [];
  const diagnostics = [];
  diagnostics.push("导出诊断：selectionCount=" + selection.length);
  for (const node of selection) {
    diagnostics.push("选区节点：" + describeExportNode(node));
  }
  if (selection.length === 0) {
    throw new Error("请先在 Figma 画布中选择节点。");
  }

  const imageNodes = collectExportImageNodes(selection, diagnostics);
  diagnostics.push("收集结果：imageNodeCount=" + imageNodes.length);
  if (imageNodes.length === 0) {
    throw new Error("当前选区中没有可导出的图片节点。\n" + diagnostics.join("\n"));
  }

  const images = [];
  for (const item of imageNodes) {
    // 九宫：读取完整源图 bytes，并附带 border 元数据交给 MCP Relay Python cutter 合成最小 Sprite。
    if (item.nineSlice) {
      // 九宫图必须使用完整源图，不能导出父节点渲染图后再裁剪，否则会把已裁过的切片再次裁成十字形。
      var parentHash = findFirstImageHash(item.node, true);
      var sliceHash = parentHash ? "" : findNineSliceSourceHash(item.node);
      var sourceHash = parentHash || sliceHash;
      diagnostics.push("九宫导出：" + item.path
        + " sourceHash=" + (sourceHash ? "yes" : "no")
        + " source=" + (parentHash ? "parentFill" : (sliceHash ? "sliceFill" : "missing"))
        + " border=" + JSON.stringify(item.nineSlice.border));
      var sourceImage = sourceHash ? figma.getImageByHash(sourceHash) : null;
      if (!sourceImage) {
        throw new Error("九宫图缺少可读取的源 imageHash：" + item.path + "\n" + diagnostics.join("\n"));
      }
      var sourceBytes = await sourceImage.getBytesAsync();
      var spriteBorder = readSpriteBorderFromPlugin(item.node);
      var border = item.nineSlice.border;
      // pluginData 有精确值优先，否则用 buildFigmaPrefabNineSliceInfo 计算值
      var bL = spriteBorder.valid ? spriteBorder.left : border.left;
      var bR = spriteBorder.valid ? spriteBorder.right : border.right;
      var bT = spriteBorder.valid ? spriteBorder.top : border.top;
      var bB = spriteBorder.valid ? spriteBorder.bottom : border.bottom;
      var finalBorder = { left: bL, right: bR, top: bT, bottom: bB };
      images.push({
        nodeId: item.node.id,
        nodeName: item.node.name || "",
        nodePath: item.path,
        fileName: buildUnityImageName(item.node, item.path),
        base64: bytesToBase64(sourceBytes),
        imageType: "Sliced",
        sliceKind: sliceKindFromBorders(finalBorder),
        borderLeft: bL,
        borderRight: bR,
        borderTop: bT,
        borderBottom: bB
      });
      continue;
    }

    // 非九宫：直接导出
    diagnostics.push("普通图片导出：" + item.path + " node=" + describeExportNode(item.node));
    const bytes = await item.node.exportAsync({ format: "PNG" });
    images.push({
      nodeId: item.node.id,
      nodeName: item.node.name || "FigmaImage",
      nodePath: item.path,
      fileName: buildUnityImageName(item.node, item.path),
      base64: bytesToBase64(bytes)
    });
  }

  figma.ui.postMessage({
    type: "EXPORT_IMAGES_TO_UNITY_RESULT",
    requestId: message.requestId,
    result: {
        status: "completed",
        images,
        stats: { selectedCount: selection.length, imageCount: images.length },
        diagnostics,
        errors: [],
        warnings: []
      }
  });
  figma.notify(`已导出 ${images.length} 张图片，等待 Unity 导入。`);
}

/**
 * 从选区中递归收集可导出的图片节点。
 * - 九宫父节点：返回父节点（附 nineSlice 信息）
 * - 普通图节点：导出自带 IMAGE fill 的节点
 */
function collectExportImageNodes(selection, diagnostics) {
  const visited = new Set();
  const result = [];
  for (const root of selection) {
    walkExportImageNodes(root, "", visited, result, diagnostics, 0);
  }
  return result;
}

function walkExportImageNodes(node, parentPath, visited, result, diagnostics, depth) {
  if (!node || !("id" in node) || visited.has(node.id)) return;
  if (node.type === "DOCUMENT" || node.type === "PAGE") return;
  visited.add(node.id);

  const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  if (diagnostics && depth <= 2) {
    diagnostics.push("扫描节点：" + currentPath + " " + describeExportNode(node) + " slices=" + countDirectSliceChildren(node));
  }

  // 检测九宫父节点（有 __slice_* 子节点）
  const nineSlice = buildFigmaPrefabNineSliceInfo(node);
  if (nineSlice) {
    // 收集切片子节点（供 Figma 内裁剪参考）
    var sliceChildren = [];
    if ("children" in node) {
      for (var ci = 0; ci < node.children.length; ci++) {
        var child = node.children[ci];
        if (String(child.name || "").startsWith("__slice_") && "exportAsync" in child && child.width > 0 && child.height > 0) {
          sliceChildren.push(child);
        }
      }
    }
    if (diagnostics) {
      diagnostics.push("识别九宫：" + currentPath
        + " sliceCount=" + nineSlice.sliceCount
        + " directSliceExportable=" + sliceChildren.length
        + " border=" + JSON.stringify(nineSlice.border)
        + " parentImageHash=" + (findFirstImageHash(node, true) ? "yes" : "no")
        + " sliceImageHash=" + (findNineSliceSourceHash(node) ? "yes" : "no"));
    }
    result.push({ node: node, path: currentPath, nineSlice: nineSlice, slices: sliceChildren });
    return;
  }

  // 跳过 __slice_* 内部子节点
  if (String(node.name).startsWith("__slice_")) {
    if (diagnostics) {
      diagnostics.push("跳过切片子节点：" + currentPath);
    }
    return;
  }

  // 普通图片节点
  if (hasImageFill(node) && "exportAsync" in node && node.width > 0 && node.height > 0) {
    if (diagnostics) {
      diagnostics.push("识别普通图片：" + currentPath);
    }
    result.push({ node, path: currentPath, nineSlice: null });
    return;
  }
  if (diagnostics && depth <= 2) {
    diagnostics.push("未直接导出：" + currentPath
      + " hasVisibleImageFill=" + hasImageFill(node)
      + " hasAnyImageFill=" + hasAnyImageFill(node)
      + " exportAsync=" + ("exportAsync" in node)
      + " size=" + Math.round(Number(node.width || 0)) + "x" + Math.round(Number(node.height || 0)));
  }

  // 递归子节点
  if ("children" in node) {
    for (const child of node.children) {
      walkExportImageNodes(child, currentPath, visited, result, diagnostics, depth + 1);
    }
  }
}

/** 判断节点是否有 IMAGE 类型填充。 */
function hasImageFill(node) {
  if (!("fills" in node) || !Array.isArray(node.fills)) return false;
  return node.fills.some(function (f) {
    return f && f.type === "IMAGE" && f.visible !== false;
  });
}

/** 判断节点是否存在任意 IMAGE 填充，包括隐藏填充。 */
function hasAnyImageFill(node) {
  if (!("fills" in node) || !Array.isArray(node.fills)) return false;
  return node.fills.some(function (f) {
    return f && f.type === "IMAGE";
  });
}

/** 统计直接子节点中的九宫切片数量。 */
function countDirectSliceChildren(node) {
  if (!node || !("children" in node) || !Array.isArray(node.children)) return 0;
  var count = 0;
  for (var i = 0; i < node.children.length; i++) {
    if (String(node.children[i] && node.children[i].name || "").startsWith("__slice_")) {
      count += 1;
    }
  }
  return count;
}

/** 输出节点导出相关关键状态。 */
function describeExportNode(node) {
  if (!node) return "<null>";
  return "id=" + (node.id || "")
    + " name=" + (node.name || "")
    + " type=" + (node.type || "")
    + " visible=" + (node.visible !== false)
    + " size=" + Math.round(Number(node.width || 0)) + "x" + Math.round(Number(node.height || 0))
    + " hasVisibleImageFill=" + hasImageFill(node)
    + " hasAnyImageFill=" + hasAnyImageFill(node)
    + " exportAsync=" + ("exportAsync" in node);
}

/**
 * 生成 Unity 友好文件名。
 * 优先用 pluginData 里的原始资源路径名，否则用节点名。
 */
function buildUnityImageName(node, nodePath) {
  var assetPath = "";
  if (typeof node.getPluginData === "function") {
    assetPath = node.getPluginData("spritePath") || node.getPluginData("assetPath") || "";
  }
  if (!assetPath && typeof node.getSharedPluginData === "function") {
    assetPath = node.getSharedPluginData(PrefabToFigmaNamespace, "spritePath")
      || node.getSharedPluginData(PrefabToFigmaNamespace, "assetPath")
      || "";
  }
  var sourceName = assetPath ? assetPath.split("/").pop() : "";
  var baseName = sourceName
    ? sourceName.replace(/\.[a-z0-9]+$/i, "")
    : (node.name || "FigmaImage");
  return sanitizeFileName(baseName) + ".png";
}

function readHierarchyImageAssetInfo(node) {
  var info = {
    spriteGuid: "",
    spritePath: "",
    assetPath: ""
  };
  if (!node) {
    return info;
  }
  if (typeof node.getSharedPluginData === "function") {
    info.spriteGuid = node.getSharedPluginData(PrefabToFigmaNamespace, "spriteGuid")
      || node.getSharedPluginData(PrefabToFigmaNamespace, "imageGuid")
      || "";
    info.spritePath = node.getSharedPluginData(PrefabToFigmaNamespace, "spritePath") || "";
    info.assetPath = node.getSharedPluginData(PrefabToFigmaNamespace, "assetPath") || "";
  }
  if (typeof node.getPluginData === "function") {
    info.spriteGuid = info.spriteGuid
      || node.getPluginData("spriteGuid")
      || node.getPluginData("imageGuid")
      || "";
    info.spritePath = info.spritePath || node.getPluginData("spritePath") || "";
    info.assetPath = info.assetPath || node.getPluginData("assetPath") || "";
  }
  return info;
}

/**
 * 从 Figma 节点的 pluginData 读取 Unity 导出时写入的精确 spriteBorder。
 * 格式: "left,bottom,right,top" (与 Unity TextureImporter.spriteBorder 一致)
 */
function readSpriteBorderFromPlugin(node) {
  if (!node || typeof node.getPluginData !== "function") {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  var raw = node.getPluginData("spriteBorder");
  if (!raw) {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  var parts = String(raw).split(",");
  if (parts.length !== 4) {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  var left = parseInt(parts[0], 10);
  var bottom = parseInt(parts[1], 10);
  var right = parseInt(parts[2], 10);
  var top = parseInt(parts[3], 10);
  if (isNaN(left) || isNaN(bottom) || isNaN(right) || isNaN(top)) {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  return { valid: true, left: left, right: right, top: top, bottom: bottom };
}

/** 根据四个边框值判断切片类型。 */
function sliceKindFromBorders(border) {
  if (!border) return "9slice";
  var h = border.left > 0 && border.right > 0;
  var v = border.top > 0 && border.bottom > 0;
  if (h && v) return "9slice";
  if (h) return "h3slice";
  if (v) return "v3slice";
  return "9slice";
}
/**
 * 处理选中文本样式同步到 Unity 的 Figma 侧采集。
 * 只读取一个 TEXT 节点，按 figma-to-prefab 的 TMP 材质规则生成 textMaterial。
 */
async function handleExportSelectedTextStyleToUnity(message) {
  const requestId = message && message.requestId ? String(message.requestId) : "";
  const job = message && message.job ? message.job : {};
  const syncColor = job.syncColor !== false;
  const selection = figma.currentPage.selection || [];
  try {
    if (selection.length !== 1) {
      throw new Error("请在 Figma 中只选择 1 个文本节点，当前选择数量：" + selection.length);
    }

    const node = selection[0];
    if (!node || node.type !== "TEXT") {
      throw new Error("当前节点不是 TEXT 文本节点，不能同步字体样式。");
    }

    const fontSize = readFigmaFontSize(node);
    const fillColor = readFirstVisibleSolidPaintColor(node.fills);
    if (syncColor && !fillColor) {
      throw new Error("当前文本没有可见的 SOLID 填充色，无法同步字体颜色。");
    }

    const strokeColor = readFirstVisibleSolidPaintColor(node.strokes);
    const strokeWeight = readFigmaStrokeWeight(node);
    const effects = serializeEffects(node.effects);
    const style = {
      nodeId: node.id,
      nodeName: node.name || "",
      pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
      fontSize: roundNumber(fontSize),
      fillColor: fillColor || { r: 0, g: 0, b: 0, a: 1 },
      strokeColor,
      strokeWeight,
      effects,
      textMaterial: buildSelectedTextMaterialSpec(strokeColor, strokeWeight, effects, fontSize)
    };

    figma.ui.postMessage({
      type: "EXPORT_SELECTED_TEXT_STYLE_TO_UNITY_RESULT",
      requestId,
      ok: true,
      result: {
        status: "completed",
        style,
        warnings: [],
        errors: []
      }
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({
      type: "EXPORT_SELECTED_TEXT_STYLE_TO_UNITY_RESULT",
      requestId,
      ok: false,
      error: messageText,
      result: {
        status: "failed",
        errors: [messageText]
      }
    });
    figma.notify("字体同步失败：" + messageText, { error: true });
  }
}

/** 从 Figma paints 中读取第一个可见 SOLID 颜色，保留 alpha。 */
function readFirstVisibleSolidPaintColor(paints) {
  if (!Array.isArray(paints)) {
    return null;
  }
  for (const paint of paints) {
    if (!paint || paint.visible === false || paint.type !== "SOLID" || !paint.color) {
      continue;
    }
    return {
      r: roundDigits(paint.color.r || 0, 3),
      g: roundDigits(paint.color.g || 0, 3),
      b: roundDigits(paint.color.b || 0, 3),
      a: typeof paint.opacity === "number" ? roundDigits(paint.opacity, 3) : 1
    };
  }
  return null;
}

/** 根据 figma-to-prefab 的规则构建 TMP 描边/投影材质需求。 */
function buildSelectedTextMaterialSpec(strokeColor, strokeWeight, effects, fontSize) {
  const safeFontSize = Math.max(Number(fontSize) || 0, 1);
  let outlineColor = strokeColor;
  let outlineWidth = 0;
  const safeStrokeWeight = roundDigits(Number(strokeWeight) || 0, 2);
  if (outlineColor && safeStrokeWeight > 0) {
    outlineWidth = roundDigits(clampNumber(7.0 / 3.0 * safeStrokeWeight / safeFontSize, 0, 1), 2);
  }
  if (outlineWidth <= 0.01) {
    outlineColor = null;
    outlineWidth = 0;
  }

  const shadow = findFirstVisibleDropShadow(effects);
  let underlayColor = null;
  let underlayOffsetX = 0;
  let underlayOffsetY = 0;
  let underlaySoftness = 0;
  let underlayDilate = 0;
  if (shadow) {
    const color = shadow.color || {};
    underlayColor = {
      r: roundDigits(color.r || 0, 3),
      g: roundDigits(color.g || 0, 3),
      b: roundDigits(color.b || 0, 3),
      a: typeof color.a === "number" ? roundDigits(color.a, 3) : 1
    };
    const offset = shadow.offset || {};
    underlayOffsetX = roundDigits(clampNumber((offset.x || 0) / safeFontSize, -1, 1), 2);
    underlayOffsetY = roundDigits(clampNumber(-(offset.y || 0) / safeFontSize, -1, 1), 2);
    underlaySoftness = roundDigits(clampNumber((shadow.radius || 0) / safeFontSize, 0, 1), 2);
    underlayDilate = roundDigits(clampNumber((shadow.spread || 0) / safeFontSize, 0, 1), 2);
    if (underlayColor.a <= 0.01) {
      underlayColor = null;
    }
  }

  const hasOutline = !!outlineColor;
  const hasUnderlay = !!underlayColor;
  if (!hasOutline && !hasUnderlay) {
    return {
      enabled: false,
      signature: "",
      materialName: "",
      outlineColor: { r: 0, g: 0, b: 0, a: 1 },
      outlineWidth: 0,
      underlayColor: { r: 0, g: 0, b: 0, a: 1 },
      underlayOffsetX: 0,
      underlayOffsetY: 0,
      underlaySoftness: 0,
      underlayDilate: 0,
      hasOutline: false,
      hasUnderlay: false,
      sourceStrokeWeight: safeStrokeWeight
    };
  }

  const outlineHex = hasOutline ? colorToMaterialHex(outlineColor) : "none";
  const underlayHex = hasUnderlay ? colorToMaterialHex(underlayColor) : "none";
  const signature = "o_" + outlineHex
    + "_w_" + pad3(Math.round(outlineWidth * 100))
    + "_u_" + underlayHex
    + "_x_" + pad3(Math.round((underlayOffsetX + 1) * 100))
    + "_y_" + pad3(Math.round((underlayOffsetY + 1) * 100))
    + "_s_" + pad3(Math.round(underlaySoftness * 100))
    + "_d_" + pad3(Math.round(underlayDilate * 100));

  return {
    enabled: true,
    signature,
    materialName: "CommonFont_figma_" + signature,
    outlineColor: outlineColor || { r: 0, g: 0, b: 0, a: 1 },
    outlineWidth,
    underlayColor: underlayColor || { r: 0, g: 0, b: 0, a: 1 },
    underlayOffsetX,
    underlayOffsetY,
    underlaySoftness,
    underlayDilate,
    hasOutline,
    hasUnderlay,
    sourceStrokeWeight: safeStrokeWeight
  };
}

/** 获取第一个可见 DropShadow，用于映射 TMP Underlay。 */
function findFirstVisibleDropShadow(effects) {
  if (!Array.isArray(effects)) {
    return null;
  }
  for (const effect of effects) {
    if (effect && effect.visible !== false && effect.type === "DROP_SHADOW") {
      return effect;
    }
  }
  return null;
}

/** 数字限制到指定范围。 */
function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

/** 按指定位数四舍五入。 */
function roundDigits(value, digits) {
  const factor = Math.pow(10, digits || 0);
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** 颜色转换为材质签名中的 RGBA 十六进制。 */
function colorToMaterialHex(color) {
  const r = Math.round(clampNumber(color && color.r, 0, 1) * 255);
  const g = Math.round(clampNumber(color && color.g, 0, 1) * 255);
  const b = Math.round(clampNumber(color && color.b, 0, 1) * 255);
  const a = Math.round(clampNumber(color && typeof color.a === "number" ? color.a : 1, 0, 1) * 255);
  return toHex2(r) + toHex2(g) + toHex2(b) + toHex2(a);
}

/** 生成两位十六进制文本。 */
function toHex2(value) {
  return ("0" + Math.round(value).toString(16)).slice(-2);
}

/** 生成三位数字签名段。 */
function pad3(value) {
  return ("000" + Math.round(value)).slice(-3);
}
/**
 * 采集当前 Figma 单选根节点的层级和几何数据，交给 Unity 网关做确定性同步。
 * 这里只读 Figma 画布，不做图片、字体、材质资源替换。
 */
async function handleExportHierarchyToUnity(message) {
  try {
    const selection = figma.currentPage.selection || [];
    if (selection.length !== 1) {
      throw new Error("请在 Figma 中只选择 1 个根节点。当前选择数量：" + selection.length);
    }

    const selectedRoot = selection[0];
    const root = resolveHierarchyExportRootNode(selectedRoot);
    if (!root) {
      throw new Error("当前选择的节点不支持Figma导入Prefab：" + ((selectedRoot && selectedRoot.type) || "UNKNOWN"));
    }

    const syncImages = !!(message && message.syncImages);
    const selectedAncestorIds = buildHierarchyAncestorIdSet(selectedRoot, root);
    const selectedNodeId = selectedRoot && selectedRoot.id ? String(selectedRoot.id) : "";
    const selectionTargetsWholeRoot = selectedRoot === root || isHierarchyImportBoundsNode(selectedRoot);
    const geometrySyncSelectionId = selectionTargetsWholeRoot && root && root.id ? String(root.id) : selectedNodeId;
    const hierarchyRoot = await collectHierarchyExportNode(root, "", 0, syncImages, selectedAncestorIds, selectedNodeId, null, false, geometrySyncSelectionId, false);
    hierarchyRoot.geometryChangedFromBaseline = false;
    const rootPrefabPath = getHierarchySharedPluginData(root, "prefabPath") || getHierarchySharedPluginData(selectedRoot, "prefabPath") || "";
    hierarchyRoot.prefabPath = rootPrefabPath;
    const payload = {
      version: 1,
      fileKey: figma.fileKey || "",
      pageId: figma.currentPage && figma.currentPage.id ? figma.currentPage.id : "",
      pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
      prefabPath: rootPrefabPath,
      syncImages,
      root: hierarchyRoot
    };

    figma.ui.postMessage({
      type: "EXPORT_HIERARCHY_TO_UNITY_RESULT",
      requestId: message.requestId,
      ok: true,
      result: payload
    });
    figma.notify("已采集 Figma 层级，等待 Unity 同步。");
  } catch (error) {
    figma.ui.postMessage({
      type: "EXPORT_HIERARCHY_TO_UNITY_RESULT",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** 判断节点是否可以参与Figma导入Prefab。 */
function isHierarchyExportNode(node) {
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") {
    return false;
  }
  if (isHierarchySliceLeafNode(node)) {
    return false;
  }
  if (isHierarchyPrefabVisualLeafNode(node)) {
    return false;
  }
  return "width" in node && "height" in node;
}

/** 将 Prefab导入Figma 生成的 __ImportBounds 外壳解包到真实 Prefab 根节点。 */
function resolveHierarchyExportRootNode(node) {
  const candidate = resolveHierarchyPrefabRootCandidate(node);
  if (!isHierarchyExportRootNode(candidate)) {
    return null;
  }
  if (!isHierarchyImportBoundsNode(candidate)) {
    return candidate;
  }
  const children = candidate.children.filter(isHierarchyExportNode);
  return children.length === 1 && isHierarchyExportRootNode(children[0]) ? children[0] : candidate;
}

/** 判断当前选择是否可以作为 Figma导入Prefab 的根节点。 */
function isHierarchyExportRootNode(node) {
  if (!isHierarchyExportNode(node)) {
    return false;
  }
  return "children" in node && Array.isArray(node.children);
}

function resolveHierarchyPrefabRootCandidate(node) {
  if (!node) {
    return null;
  }
  if (isHierarchyImportBoundsNode(node)) {
    return node;
  }

  const selectedPrefabPath = getHierarchySharedPluginData(node, "prefabPath");
  let current = node;
  let topPrefabNode = null;
  let importBoundsParent = null;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (isHierarchyImportBoundsNode(current)) {
      importBoundsParent = current;
    }

    const importKind = getHierarchySharedPluginData(current, "importKind");
    const currentPrefabPath = getHierarchySharedPluginData(current, "prefabPath");
    if (
      importKind === "prefab-to-figma" &&
      (!selectedPrefabPath || !currentPrefabPath || currentPrefabPath === selectedPrefabPath) &&
      isHierarchyExportRootNode(current)
    ) {
      topPrefabNode = current;
    }

    current = current.parent;
  }

  return importBoundsParent || topPrefabNode || node;
}

function isHierarchyImportBoundsNode(node) {
  const name = String(node && node.name || "");
  return getHierarchySharedPluginData(node, "nodeRole") === "importBounds" || name.endsWith("__ImportBounds");
}

function getHierarchySharedPluginData(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return "";
  }
  return node.getSharedPluginData(PrefabToFigmaNamespace, key) || "";
}

/** 跳过九宫/三切片内部叶子，不跳过父容器名中包含 __slice 的节点。 */
function isHierarchySliceLeafNode(node) {
  return String(node && node.name || "").startsWith("__slice_");
}

/** 跳过 Prefab导入Figma 为渲染效果创建的内部视觉叶子。 */
function isHierarchyPrefabVisualLeafNode(node) {
  const name = String(node && node.name || "");
  return name === "__text" || name === "__text_underlay" || name === "__image";
}

/** 嵌套 Prefab / 通用组件作为一个 Unity 节点同步，不展开 Figma 内部实现层。 */
function isHierarchyOpaquePrefabNode(node, parentPath) {
  if (!node) {
    return false;
  }
  const role = getHierarchySharedPluginData(node, "nodeRole");
  if (
    role === "prefabInstance" ||
    role === "prefabInstanceFrame" ||
    role === "missingNestedPrefabPlaceholder"
  ) {
    return true;
  }
  if (
    getHierarchySharedPluginData(node, "sourcePrefabGuid") ||
    getHierarchySharedPluginData(node, "sourcePrefabPath")
  ) {
    return true;
  }
  if (!parentPath) {
    return false;
  }
  return isHierarchyCommonPrefabName(node.name);
}

function isHierarchyCommonPrefabName(name) {
  const normalized = String(name || "").replace(/^\[|\]$/g, "");
  return /^(Common_|Common-|CommonPrefab_|Common_Prefab_|KaTong|KaTone)/.test(normalized);
}

function getHierarchySyncBoundaryKind(node, parentPath, rootPath) {
  if (isHierarchyOpaquePrefabNode(node, parentPath)) {
    return "NestedPrefabBoundary";
  }
  if (!parentPath && isHierarchyCommonPrefabName(node && node.name)) {
    return "NestedPrefabBoundary";
  }
  if (!parentPath && !rootPath) {
    return "RootAsset";
  }
  return "NormalNode";
}

function buildHierarchyStructuralPath(node, rootNode) {
  const segments = [];
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    segments.push(getHierarchyStructuralSegment(current));
    if (rootNode && current === rootNode) {
      break;
    }
    current = current.parent;
  }
  return segments.reverse().join("/");
}

function getHierarchyStructuralSegment(node) {
  const name = String(node && node.name || "Unnamed");
  const index = getHierarchyRawSiblingIndex(node);
  return index + ":" + name;
}

function buildHierarchyAncestorIdSet(selectedNode, rootNode) {
  const result = {};
  let current = selectedNode;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.id) {
      result[String(current.id)] = true;
    }
    if (rootNode && current === rootNode) {
      break;
    }
    current = current.parent;
  }
  return result;
}

function isHierarchySelectedAncestor(node, selectedAncestorIds) {
  return !!(node && node.id && selectedAncestorIds && selectedAncestorIds[String(node.id)]);
}

function isHierarchySelectedNode(node, selectedNodeId) {
  return !!(node && node.id && selectedNodeId && String(node.id) === selectedNodeId);
}

/** 递归采集节点树，保留 siblingIndex 作为 Unity 排序依据。 */
async function collectHierarchyExportNode(node, parentPath, siblingIndex, syncImages, selectedAncestorIds, selectedNodeId, rootNode, insideNestedPrefabOverride, geometrySyncSelectionId, insideGeometrySyncSelection) {
  if (isCleanupRecoveryNode(node)) {
    throw new Error("cleanup recovery backup cannot be exported");
  }
  const name = String(node.name || "Unnamed");
  const path = parentPath ? parentPath + "/" + name : name;
  const rawSyncBoundaryKind = getHierarchySyncBoundaryKind(node, parentPath, "");
  const isOpaquePrefab = rawSyncBoundaryKind === "NestedPrefabBoundary";
  const isNestedPrefabOverride = !!insideNestedPrefabOverride || isOpaquePrefab;
  const syncBoundaryKind = isNestedPrefabOverride ? "NestedPrefabInternalOverride" : rawSyncBoundaryKind;
  const absolute = getHierarchyNodeAbsolutePosition(node);
  const local = getHierarchyNodeLocalPosition(node);
  const textInfo = getHierarchyTextInfo(node);
  const imageInfo = syncImages && syncBoundaryKind === "NormalNode" ? await getHierarchyImageInfo(node, path) : null;
  const rawSiblingIndex = getHierarchyRawSiblingIndex(node);
  const orderBaseline = readHierarchyOrderBaseline(node, rawSiblingIndex);
  const geometrySnapshot = {
    x: roundHierarchyNumber(local.x),
    y: roundHierarchyNumber(local.y),
    width: roundHierarchyNumber(Number(node.width || 0)),
    height: roundHierarchyNumber(Number(node.height || 0)),
    rotation: roundHierarchyNumber(Number(node.rotation || 0))
  };
  const geometryBaseline = readHierarchyGeometryBaseline(node, geometrySnapshot);
  const isGeometrySyncSelectionNode = !!(geometrySyncSelectionId && node && node.id && String(node.id) === geometrySyncSelectionId);
  const canSyncGeometry = !!geometrySyncSelectionId && (insideGeometrySyncSelection || isGeometrySyncSelectionNode);
  const result = {
    id: String(node.id || ""),
    name,
    type: String(node.type || ""),
    path,
    structuralPath: buildHierarchyStructuralPath(node, rootNode || node),
    syncBoundaryKind,
    sourcePrefabGuid: getHierarchySharedPluginData(node, "sourcePrefabGuid"),
    sourcePrefabPath: getHierarchySharedPluginData(node, "sourcePrefabPath"),
    nodeRole: getHierarchySharedPluginData(node, "nodeRole"),
    allowCreateChildren: !isNestedPrefabOverride && (syncBoundaryKind === "NormalNode" || syncBoundaryKind === "RootAsset"),
    allowDeleteChildren: !isNestedPrefabOverride && (syncBoundaryKind === "NormalNode" || syncBoundaryKind === "RootAsset"),
    allowReparent: !isNestedPrefabOverride && (syncBoundaryKind === "NormalNode" || syncBoundaryKind === "RootAsset"),
    siblingIndex: siblingIndex || 0,
    figmaSiblingIndex: rawSiblingIndex,
    hasOrderBaseline: orderBaseline.hasBaseline,
    orderBaselineSiblingIndex: orderBaseline.value,
    hasGeometryBaseline: geometryBaseline.hasBaseline,
    geometryChangedFromBaseline: canSyncGeometry && geometryBaseline.changed,
    visible: node.visible !== false,
    x: geometrySnapshot.x,
    y: geometrySnapshot.y,
    absoluteX: roundHierarchyNumber(absolute.x),
    absoluteY: roundHierarchyNumber(absolute.y),
    width: geometrySnapshot.width,
    height: geometrySnapshot.height,
    rotation: geometrySnapshot.rotation,
    constraints: normalizeHierarchyExportConstraints(node),
    fontSize: textInfo.fontSize,
    hasText: textInfo.hasText,
    hasImage: !!imageInfo,
    image: imageInfo,
    childrenComplete: true,
    children: []
  };

  const isSelectedAncestor = isHierarchySelectedAncestor(node, selectedAncestorIds);
  const isSelectedNode = isHierarchySelectedNode(node, selectedNodeId);
  const restrictOpaqueChildrenToSelectedPath = isOpaquePrefab && isSelectedAncestor && !isSelectedNode;

  if ("children" in node && Array.isArray(node.children)) {
    let children = node.children.filter(child => isHierarchyExportNode(child) && !isCleanupRecoveryNode(child));
    if (restrictOpaqueChildrenToSelectedPath) {
      children = children.filter(child => isHierarchySelectedAncestor(child, selectedAncestorIds));
    }
    for (let i = 0; i < children.length; i++) {
      result.children.push(await collectHierarchyExportNode(children[i], path, i, syncImages, selectedAncestorIds, selectedNodeId, rootNode || node, isNestedPrefabOverride, geometrySyncSelectionId, canSyncGeometry));
    }
  }

  return result;
}

function normalizeHierarchyExportConstraints(node) {
  if (!node || !("constraints" in node) || !node.constraints) {
    return { horizontal: "CENTER", vertical: "CENTER" };
  }
  return {
    horizontal: normalizeConstraint(node.constraints.horizontal, "CENTER"),
    vertical: normalizeConstraint(node.constraints.vertical, "CENTER")
  };
}

function getHierarchyRawSiblingIndex(node) {
  if (!node || !node.parent || !("children" in node.parent) || !Array.isArray(node.parent.children)) {
    return 0;
  }
  const index = node.parent.children.indexOf(node);
  return index >= 0 ? index : 0;
}

function readHierarchyOrderBaseline(node, currentIndex) {
  const key = "hierarchySyncBaselineSiblingIndex";
  const raw = getHierarchySharedPluginData(node, key);
  if (raw !== "") {
    const parsed = Number(raw);
    return {
      hasBaseline: Number.isFinite(parsed),
      value: Number.isFinite(parsed) ? Math.round(parsed) : currentIndex
    };
  }
  if (node && typeof node.setSharedPluginData === "function") {
    node.setSharedPluginData(PrefabToFigmaNamespace, key, String(currentIndex));
  }
  return {
    hasBaseline: false,
    value: currentIndex
  };
}

function readHierarchyGeometryBaseline(node, snapshot) {
  const key = "hierarchySyncBaselineGeometry";
  const importedRect = parseHierarchyGeometryBaseline(getHierarchySharedPluginData(node, "rect"));
  if (importedRect) {
    return {
      hasBaseline: true,
      changed: !hierarchyGeometryApproximatelyEqual(snapshot, importedRect)
    };
  }

  const raw = getHierarchySharedPluginData(node, key);
  if (raw !== "") {
    const baseline = parseHierarchyGeometryBaseline(raw);
    if (baseline) {
      return {
        hasBaseline: true,
        changed: !hierarchyGeometryApproximatelyEqual(snapshot, baseline)
      };
    }
  }

  if (node && typeof node.setSharedPluginData === "function") {
    node.setSharedPluginData(PrefabToFigmaNamespace, key, JSON.stringify(snapshot));
  }
  return {
    hasBaseline: false,
    changed: false
  };
}

function parseHierarchyGeometryBaseline(raw) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      x: Number(parsed.x || 0),
      y: Number(parsed.y || 0),
      width: Number(parsed.width || 0),
      height: Number(parsed.height || 0),
      rotation: Number(parsed.rotation || 0)
    };
  } catch (_error) {
    return null;
  }
}

function hierarchyGeometryApproximatelyEqual(left, right) {
  return hierarchyNumberApproximatelyEqual(left.x, right.x)
    && hierarchyNumberApproximatelyEqual(left.y, right.y)
    && hierarchyNumberApproximatelyEqual(left.width, right.width)
    && hierarchyNumberApproximatelyEqual(left.height, right.height)
    && hierarchyNumberApproximatelyEqual(left.rotation, right.rotation);
}

function hierarchyNumberApproximatelyEqual(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= 0.01;
}

/** 如果节点有可见 IMAGE fill，则导出 PNG 数据给 Unity 替换匹配 Image 组件的 Sprite。 */
async function getHierarchyImageInfo(node, nodePath) {
  const assetInfo = readHierarchyImageAssetInfo(node);
  const hasExistingSprite = !!(assetInfo.spriteGuid || assetInfo.spritePath || assetInfo.assetPath);
  if (hasExistingSprite) {
    return {
      nodeId: String(node.id || ""),
      nodeName: String(node.name || "FigmaImage"),
      nodePath: String(nodePath || ""),
      imageHash: findFirstImageHash(node, false),
      fileName: buildUnityImageName(node, nodePath),
      base64: "",
      mode: "existingSprite",
      spriteGuid: assetInfo.spriteGuid,
      spritePath: assetInfo.spritePath,
      assetPath: assetInfo.assetPath
    };
  }

  if (!hasImageFill(node) || !("exportAsync" in node) || Number(node.width || 0) <= 0 || Number(node.height || 0) <= 0) {
    return null;
  }

  const bytes = await node.exportAsync({ format: "PNG" });
  return {
    nodeId: String(node.id || ""),
    nodeName: String(node.name || "FigmaImage"),
    nodePath: String(nodePath || ""),
    imageHash: findFirstImageHash(node, false),
    fileName: buildUnityImageName(node, nodePath),
    base64: bytesToBase64(bytes),
    mode: "exportedPng",
    spriteGuid: "",
    spritePath: "",
    assetPath: ""
  };
}

/** 获取节点相对父节点的 Figma 左上角坐标。 */
function getHierarchyNodeLocalPosition(node) {
  return {
    x: Number(node.x || 0),
    y: Number(node.y || 0)
  };
}

/** 获取节点绝对左上角坐标，供 Unity 根节点或跨父级同步计算。 */
function getHierarchyNodeAbsolutePosition(node) {
  if (node && node.absoluteTransform) {
    return {
      x: Number(node.absoluteTransform[0][2] || 0),
      y: Number(node.absoluteTransform[1][2] || 0)
    };
  }
  return getHierarchyNodeLocalPosition(node);
}

/** 只采集字号；字体、材质、字库引用不参与同步。 */
function getHierarchyTextInfo(node) {
  if (!node || node.type !== "TEXT") {
    return { hasText: false, fontSize: 0 };
  }

  const value = node.fontSize;
  if (typeof value === "number") {
    return { hasText: true, fontSize: roundHierarchyNumber(value) };
  }
  return { hasText: true, fontSize: 0 };
}

/** 限制小数噪声，避免 Unity Prefab 反复出现无意义改动。 */
function roundHierarchyNumber(value) {
  const number = Number(value || 0);
  if (!isFinite(number)) {
    return 0;
  }
  return Math.round(number * 1000) / 1000;
}
