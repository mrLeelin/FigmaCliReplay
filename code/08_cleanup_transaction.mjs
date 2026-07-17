const CleanupBackupPrefix = "__cleanup_backup__";
const CleanupRecoveryMetadataKey = "cleanupRecoveryMetadata";

export function computeCleanupSnapshotHashFromNodes(nodes) {
  const canonicalNodes = (Array.isArray(nodes) ? nodes : [])
    .map(function (node) {
      return {
        id: String(node && node.id || ""),
        parentId: String(node && node.parentId || ""),
        type: String(node && node.type || ""),
        name: String(node && node.name || ""),
        siblingIndex: Number.isInteger(Number(node && node.siblingIndex)) ? Number(node.siblingIndex) : 0,
        depth: Number.isInteger(Number(node && node.depth)) ? Number(node.depth) : 0,
        x: cleanupPrimitiveOrNull(node && node.x),
        y: cleanupPrimitiveOrNull(node && node.y),
        w: cleanupPrimitiveOrNull(node && node.w),
        h: cleanupPrimitiveOrNull(node && node.h),
        visible: cleanupPrimitiveOrNull(node && node.visible),
        opacity: cleanupPrimitiveOrNull(node && node.opacity),
        childCount: cleanupPrimitiveOrNull(node && node.childCount),
        characters: cleanupPrimitiveOrNull(node && node.characters),
        roles: cleanupStableJsonValue(node && node.roles),
        psd: cleanupStableJsonValue(node && node.psd),
      };
    })
    .sort(function (left, right) {
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  return cleanupSha256(JSON.stringify(canonicalNodes));
}

export function captureCleanupRollbackJournal(root) {
  if (!root || !root.id) throw new Error("cleanup rollback journal requires a root node");
  const entries = [];
  cleanupCollectRollbackEntries(root, 0, entries);
  return {
    root: root,
    rootBounds: cleanupReadBounds(root),
    entries: entries,
    createdNodes: [],
    backupNode: null,
  };
}

export async function rollbackCleanupTransaction(journal) {
  const errors = [];
  const mismatches = [];
  const entries = Array.isArray(journal && journal.entries) ? journal.entries : [];

  for (const entry of entries) {
    try {
      if (!entry.node || !entry.parent || typeof entry.parent.insertChild !== "function") {
        throw new Error("missing original parent for node " + entry.id);
      }
      entry.parent.insertChild(Math.min(entry.index, cleanupChildCount(entry.parent)), entry.node);
    } catch (error) {
      errors.push("restore parent " + entry.id + ": " + cleanupErrorMessage(error));
    }
  }

  for (const entry of entries) {
    try {
      cleanupRestoreNodeProperties(entry);
    } catch (error) {
      errors.push("restore properties " + entry.id + ": " + cleanupErrorMessage(error));
    }
  }

  const createdNodes = Array.isArray(journal && journal.createdNodes) ? journal.createdNodes.slice().reverse() : [];
  for (const node of createdNodes) {
    try {
      if (node && typeof node.remove === "function" && !node.removed) node.remove();
    } catch (error) {
      errors.push("remove created node: " + cleanupErrorMessage(error));
    }
  }

  for (const entry of entries) {
    const actualIndex = cleanupNodeIndex(entry.node);
    if (entry.node.parent !== entry.parent || actualIndex !== entry.index || String(entry.node.name || "") !== entry.name) {
      mismatches.push({
        nodeId: entry.id,
        expectedParentId: entry.parent && entry.parent.id ? String(entry.parent.id) : "",
        actualParentId: entry.node.parent && entry.node.parent.id ? String(entry.node.parent.id) : "",
        expectedIndex: entry.index,
        actualIndex: actualIndex,
        expectedName: entry.name,
        actualName: String(entry.node.name || ""),
      });
    }
  }

  return { pass: errors.length === 0 && mismatches.length === 0, errors: errors, mismatches: mismatches };
}

export async function applyFigmaHierarchyCleanupTransactionJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  cleanupValidateTransactionEnvelope(plan, target);
  const nodeId = String(target.nodeId || plan.target.nodeId || "");
  const root = await cleanupGetNodeById(nodeId);
  if (!root) throw new Error("Figma node not found: " + nodeId);
  if (!Array.isArray(root.children)) throw new Error("Figma node has no children: " + String(root.type || "unknown"));
  await setCurrentPageForNode(root);

  const currentSnapshot = buildCleanupSnapshot(root);
  const actualHash = computeCleanupSnapshotHashFromNodes(currentSnapshot.nodes);
  const expectedHash = String(target.snapshotHash || plan.target.snapshotHash || "");
  if (actualHash !== expectedHash) {
    return {
      status: "failed",
      state: "failed",
      checks: { snapshotHash: { pass: false, expected: expectedHash, actual: actualHash } },
      rollback: {},
      errors: ["cleanup snapshot changed after approval; no writes were applied"],
    };
  }

  const journal = captureCleanupRollbackJournal(root);
  const operationResults = [];
  try {
    if (plan.createBackup !== false) journal.backupNode = cleanupCreateBackup(root, job && job.sessionId);
    for (const operation of plan.operations) {
      operationResults.push(await cleanupApplyOperation(operation, journal));
    }
    const checks = cleanupVerifyTransaction(root, journal, plan, operationResults);
    if (!checks.allPass) throw new CleanupVerificationError(checks);
    cleanupRemoveBackup(journal);
    return {
      status: "completed",
      state: "succeeded",
      rootNodeId: String(root.id),
      checks: checks,
      rollback: {},
      operationResults: operationResults,
      errors: [],
    };
  } catch (error) {
    const checks = error instanceof CleanupVerificationError
      ? error.checks
      : { allPass: false, operationExecution: { pass: false, error: cleanupErrorMessage(error) } };
    const rollback = await rollbackCleanupTransaction(journal);
    if (rollback.pass) {
      cleanupRemoveBackup(journal);
      return {
        status: "rolled_back",
        state: "rolled_back",
        rootNodeId: String(root.id),
        backupNodeId: "",
        checks: checks,
        rollback: rollback,
        operationResults: operationResults,
        errors: [cleanupErrorMessage(error)],
      };
    }
    return {
      status: "recovery_required",
      state: "recovery_required",
      rootNodeId: String(root.id),
      backupNodeId: journal.backupNode && journal.backupNode.id ? String(journal.backupNode.id) : "",
      checks: checks,
      rollback: rollback,
      operationResults: operationResults,
      errors: [cleanupErrorMessage(error)],
    };
  }
}

async function handleFigmaHierarchyCleanupTransaction(message) {
  try {
    const result = await applyFigmaHierarchyCleanupTransactionJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_TRANSACTION_RESULT",
      requestId: message.requestId,
      result: result,
    });
    if (result.state === "succeeded") {
      figma.notify("AI 层级整理已完成");
    } else if (result.state === "rolled_back") {
      figma.notify("AI 层级整理校验失败，已自动回滚", { error: true });
    } else {
      figma.notify("AI 层级整理失败，请保留隐藏备份并检查恢复信息", { error: true });
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_TRANSACTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "failed",
        state: "failed",
        checks: {},
        rollback: {},
        errors: [cleanupErrorMessage(error)],
      },
    });
    figma.notify("AI 层级整理失败：" + cleanupErrorMessage(error), { error: true });
  }
}

export function listCleanupRecoveryBackups(root) {
  const result = [];
  const visit = function (node) {
    if (!node) return;
    if (cleanupIsRecoveryBackupRoot(node)) {
      const metadata = cleanupReadRecoveryMetadata(node);
      result.push({
        nodeId: String(node.id || ""),
        name: String(node.name || ""),
        runId: String(metadata.runId || String(node.name || "").slice(CleanupBackupPrefix.length)),
        sourceName: String(metadata.sourceName || ""),
        type: String(node.type || ""),
      });
      return;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) visit(child);
  };
  visit(root);
  return result;
}

export function restoreCleanupRecoveryBackup(backup, target) {
  if (!cleanupIsRecoveryBackupRoot(backup)) throw new Error("selected node is not a cleanup recovery backup");
  if (!target || !target.id || cleanupIsRecoveryNode(target)) throw new Error("select exactly one damaged non-backup root to restore");
  const parent = target.parent;
  if (!parent || !Array.isArray(parent.children) || typeof parent.insertChild !== "function") {
    throw new Error("selected damaged root cannot be replaced in its current parent");
  }
  if (typeof backup.clone !== "function") throw new Error("cleanup recovery backup cannot be cloned");
  if (typeof target.remove !== "function") throw new Error("selected damaged root cannot be removed");

  const metadata = cleanupReadRecoveryMetadata(backup);
  const targetIndex = Math.max(0, parent.children.indexOf(target));
  const restored = backup.clone();
  let targetRemoved = false;
  try {
    restored.name = String(metadata.sourceName || target.name || "Restored");
    if ("x" in restored) restored.x = cleanupRecoveryNumber(metadata.sourceX, target.x);
    if ("y" in restored) restored.y = cleanupRecoveryNumber(metadata.sourceY, target.y);
    if ("visible" in restored) restored.visible = typeof metadata.sourceVisible === "boolean" ? metadata.sourceVisible : target.visible !== false;
    if ("locked" in restored) restored.locked = typeof metadata.sourceLocked === "boolean" ? metadata.sourceLocked : target.locked === true;
    parent.insertChild(targetIndex, restored);
    target.remove();
    targetRemoved = true;
  } catch (error) {
    if (!targetRemoved && restored && typeof restored.remove === "function" && !restored.removed) {
      try { restored.remove(); } catch (_) { /* keep the original backup for manual recovery */ }
    }
    throw error;
  }

  let backupRetained = false;
  try {
    backup.remove();
  } catch (_) {
    backupRetained = true;
  }
  return {
    replacedNodeId: String(target.id),
    restoredNodeId: String(restored.id || ""),
    backupRetained: backupRetained,
  };
}

export function deleteCleanupRecoveryBackup(backup) {
  if (!cleanupIsRecoveryBackupRoot(backup)) throw new Error("selected node is not a cleanup recovery backup");
  if (typeof backup.remove !== "function") throw new Error("cleanup recovery backup cannot be removed");
  const deletedNodeId = String(backup.id || "");
  backup.remove();
  return { deletedNodeId: deletedNodeId };
}

async function handleQueryCleanupRecoveryBackups(message) {
  try {
    figma.ui.postMessage({
      type: "QUERY_CLEANUP_RECOVERY_BACKUPS_RESULT",
      requestId: message.requestId,
      ok: true,
      backups: listCleanupRecoveryBackups(figma.currentPage),
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_CLEANUP_RECOVERY_BACKUPS_RESULT",
      requestId: message.requestId,
      ok: false,
      error: cleanupErrorMessage(error),
      backups: [],
    });
  }
}

async function handleRestoreCleanupRecoveryBackup(message) {
  try {
    const backup = await cleanupGetNodeById(String(message.backupNodeId || ""));
    const selection = figma.currentPage && Array.isArray(figma.currentPage.selection) ? figma.currentPage.selection : [];
    if (selection.length !== 1) throw new Error("请先只选择 1 个需要恢复的受损根节点");
    const result = restoreCleanupRecoveryBackup(backup, selection[0]);
    const restored = await cleanupGetNodeById(result.restoredNodeId);
    if (restored) figma.currentPage.selection = [restored];
    figma.ui.postMessage({
      type: "RESTORE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: true,
      result: result,
    });
    figma.notify(result.backupRetained ? "已恢复节点，但旧备份删除失败，请稍后手动删除" : "已从整理备份恢复节点");
  } catch (error) {
    figma.ui.postMessage({
      type: "RESTORE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: false,
      error: cleanupErrorMessage(error),
    });
    figma.notify("恢复整理备份失败：" + cleanupErrorMessage(error), { error: true });
  }
}

async function handleDeleteCleanupRecoveryBackup(message) {
  try {
    const backup = await cleanupGetNodeById(String(message.backupNodeId || ""));
    const result = deleteCleanupRecoveryBackup(backup);
    figma.ui.postMessage({
      type: "DELETE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: true,
      result: result,
    });
    figma.notify("已删除整理恢复备份");
  } catch (error) {
    figma.ui.postMessage({
      type: "DELETE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: false,
      error: cleanupErrorMessage(error),
    });
    figma.notify("删除整理备份失败：" + cleanupErrorMessage(error), { error: true });
  }
}

class CleanupVerificationError extends Error {
  constructor(checks) {
    super("cleanup transaction verification failed");
    this.name = "CleanupVerificationError";
    this.checks = checks;
  }
}

function cleanupValidateTransactionEnvelope(plan, target) {
  if (!plan || plan.schemaVersion !== 2 || plan.operation !== "figma-hierarchy-cleanup-transaction") {
    throw new Error("invalid cleanup transaction plan");
  }
  if (!target || !String(target.nodeId || plan.target && plan.target.nodeId || "")) {
    throw new Error("cleanup transaction target.nodeId is required");
  }
  if (!Array.isArray(plan.operations)) throw new Error("cleanup transaction operations must be an array");
  if (!plan.verification || typeof plan.verification !== "object") throw new Error("cleanup transaction verification is required");
}

async function cleanupApplyOperation(operation, journal) {
  if (!operation || !operation.type) throw new Error("cleanup transaction contains an invalid operation");
  switch (operation.type) {
    case "CREATE_GROUP": {
      const parent = await cleanupRequireContainer(operation.parentNodeId);
      const children = [];
      for (const childId of operation.childNodeIds || []) {
        const child = await cleanupGetNodeById(String(childId));
        if (!child || child.parent !== parent) throw new Error("CREATE_GROUP child is not a direct child: " + childId);
        children.push(child);
      }
      if (children.length < 2) throw new Error("CREATE_GROUP requires at least two children");
      const firstIndex = Math.min.apply(null, children.map(cleanupNodeIndex));
      const beforeChildren = children.map(function (child) {
        return { id: String(child.id), bounds: cleanupReadBounds(child) };
      });
      const group = createHierarchyCleanupGroup(parent, {
        name: String(operation.name || "[Group]"),
        childNodeIds: children.map(function (child) { return String(child.id); }),
      }, beforeChildren);
      journal.createdNodes.push(group);
      if (typeof parent.insertChild === "function") parent.insertChild(firstIndex, group);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const bounds = beforeChildren[index].bounds;
        group.appendChild(child);
        preserveHierarchyChildAbsoluteBounds(child, group, bounds);
      }
      return { id: String(operation.id), type: operation.type, createdNodeId: String(group.id) };
    }
    case "RENAME_NODE": {
      const node = await cleanupRequireNode(operation.nodeId);
      node.name = String(operation.name || "");
      return { id: String(operation.id), type: operation.type, nodeId: String(node.id) };
    }
    case "MOVE_NODE": {
      const node = await cleanupRequireNode(operation.nodeId);
      const parent = await cleanupRequireContainer(operation.parentNodeId);
      const bounds = cleanupReadBounds(node);
      parent.insertChild(Math.min(Number(operation.index), cleanupChildCount(parent)), node);
      preserveHierarchyChildAbsoluteBounds(node, parent, bounds);
      return { id: String(operation.id), type: operation.type, nodeId: String(node.id) };
    }
    case "REORDER_CHILDREN": {
      const parent = await cleanupRequireContainer(operation.parentNodeId);
      const expectedIds = (operation.childNodeIds || []).map(String);
      const actualIds = parent.children.map(function (child) { return String(child.id); });
      if (expectedIds.length !== actualIds.length || expectedIds.some(function (id) { return actualIds.indexOf(id) < 0; })) {
        throw new Error("REORDER_CHILDREN must list every direct child exactly once");
      }
      for (let index = 0; index < expectedIds.length; index += 1) {
        const child = await cleanupRequireNode(expectedIds[index]);
        parent.insertChild(index, child);
      }
      return { id: String(operation.id), type: operation.type, parentNodeId: String(parent.id) };
    }
    case "SET_AUTO_LAYOUT": {
      const node = await cleanupRequireNode(operation.nodeId);
      if (!("layoutMode" in node)) throw new Error("SET_AUTO_LAYOUT target does not support Auto Layout");
      node.layoutMode = operation.layoutMode;
      node.itemSpacing = Number(operation.itemSpacing);
      node.paddingTop = Number(operation.paddingTop);
      node.paddingRight = Number(operation.paddingRight);
      node.paddingBottom = Number(operation.paddingBottom);
      node.paddingLeft = Number(operation.paddingLeft);
      return { id: String(operation.id), type: operation.type, nodeId: String(node.id) };
    }
    default:
      throw new Error("unsupported cleanup operation: " + String(operation.type));
  }
}

function cleanupVerifyTransaction(root, journal, plan, operationResults) {
  const toleranceValue = Number(plan.verification && plan.verification.preserveAbsoluteBoundsTolerance);
  const tolerance = Number.isFinite(toleranceValue) && toleranceValue >= 0 ? toleranceValue : 0.01;
  const rootAfter = cleanupReadBounds(root);
  const rootDrift = cleanupBoundsDrift(journal.rootBounds, rootAfter);
  const boundsMismatches = [];
  const psdMismatches = [];
  for (const entry of journal.entries) {
    const drift = cleanupBoundsDrift(entry.bounds, cleanupReadBounds(entry.node));
    if (drift > tolerance) boundsMismatches.push({ nodeId: entry.id, drift: drift });
    if (JSON.stringify(entry.psd) !== JSON.stringify(cleanupReadPsdMetadata(entry.node))) psdMismatches.push(entry.id);
  }
  let semanticErrors = [];
  if (typeof buildHierarchyLiveSemanticBlockingErrors === "function") {
    semanticErrors = buildHierarchyLiveSemanticBlockingErrors(root, { mode: "cleanupTransaction", plan: plan }) || [];
  }
  const checks = {
    snapshotHash: { pass: true },
    operationsAppliedExactlyOnce: { pass: operationResults.length === plan.operations.length, expected: plan.operations.length, actual: operationResults.length },
    rootBoundsPreserved: { pass: rootDrift <= tolerance, drift: rootDrift, tolerance: tolerance },
    originalBoundsPreserved: { pass: boundsMismatches.length === 0, mismatches: boundsMismatches },
    psdIdentityPreserved: { pass: psdMismatches.length === 0, nodeIds: psdMismatches },
    semanticHierarchyRules: { pass: semanticErrors.length === 0, errors: semanticErrors },
  };
  checks.allPass = Object.keys(checks).every(function (key) {
    return key === "allPass" || checks[key].pass === true;
  });
  return checks;
}

function cleanupCreateBackup(root, runId) {
  if (!root || typeof root.clone !== "function") throw new Error("cleanup target cannot be cloned for rollback backup");
  const clone = root.clone();
  if (typeof clone.setPluginData === "function") {
    try {
      clone.setPluginData(CleanupRecoveryMetadataKey, JSON.stringify({
        schemaVersion: 1,
        runId: String(runId || ""),
        sourceName: String(root.name || ""),
        sourceX: cleanupRecoveryNumber(root.x, 0),
        sourceY: cleanupRecoveryNumber(root.y, 0),
        sourceVisible: root.visible !== false,
        sourceLocked: root.locked === true,
      }));
    } catch (_) { /* backup remains usable with the selected target's root properties */ }
  }
  const page = findContainingPage(root) || figma.currentPage;
  if (clone.parent !== page && page && typeof page.appendChild === "function") page.appendChild(clone);
  clone.name = CleanupBackupPrefix + String(runId || Date.now());
  if ("visible" in clone) clone.visible = false;
  if ("locked" in clone) clone.locked = true;
  if (typeof clone.x === "number" && typeof root.x === "number" && typeof root.width === "number") clone.x = root.x + root.width + 100;
  if (typeof clone.y === "number" && typeof root.y === "number") clone.y = root.y;
  return clone;
}

function cleanupIsRecoveryBackupRoot(node) {
  return !!(node && typeof node.name === "string" && node.name.startsWith(CleanupBackupPrefix));
}

function cleanupIsRecoveryNode(node) {
  if (typeof isCleanupRecoveryNode === "function") return isCleanupRecoveryNode(node);
  let current = node || null;
  while (current) {
    if (cleanupIsRecoveryBackupRoot(current)) return true;
    current = current.parent || null;
  }
  return false;
}

function cleanupReadRecoveryMetadata(node) {
  if (!node || typeof node.getPluginData !== "function") return {};
  try {
    const value = JSON.parse(String(node.getPluginData(CleanupRecoveryMetadataKey) || "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function cleanupRecoveryNumber(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
}

function cleanupRemoveBackup(journal) {
  const backup = journal && journal.backupNode;
  if (backup && typeof backup.remove === "function") {
    try { backup.remove(); } catch (_) { return; }
  }
  if (journal) journal.backupNode = null;
}

function cleanupCollectRollbackEntries(parent, depth, output) {
  const children = Array.isArray(parent && parent.children) ? parent.children.slice() : [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    output.push({
      id: String(node.id || ""),
      node: node,
      parent: parent,
      index: index,
      depth: depth + 1,
      name: String(node.name || ""),
      bounds: cleanupReadBounds(node),
      layout: cleanupCaptureLayout(node),
      psd: cleanupReadPsdMetadata(node),
      visible: node.visible,
      opacity: node.opacity,
    });
    cleanupCollectRollbackEntries(node, depth + 1, output);
  }
}

function cleanupCaptureLayout(node) {
  const result = {};
  const keys = ["layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisSizingMode", "counterAxisSizingMode"];
  for (const key of keys) {
    if (node && key in node) result[key] = node[key];
  }
  return result;
}

function cleanupRestoreNodeProperties(entry) {
  for (const key of Object.keys(entry.layout || {})) {
    try { entry.node[key] = entry.layout[key]; } catch (_) { /* best effort, verified below */ }
  }
  entry.node.name = entry.name;
  if (typeof entry.visible === "boolean" && "visible" in entry.node) entry.node.visible = entry.visible;
  if (typeof entry.opacity === "number" && "opacity" in entry.node) entry.node.opacity = entry.opacity;
  if (typeof entry.node.resize === "function" && entry.bounds.width >= 0 && entry.bounds.height >= 0) {
    entry.node.resize(Math.max(entry.bounds.width, 0.01), Math.max(entry.bounds.height, 0.01));
  }
  if (typeof entry.node.x === "number") entry.node.x = entry.bounds.x - cleanupParentAbsoluteOrigin(entry.parent).x;
  if (typeof entry.node.y === "number") entry.node.y = entry.bounds.y - cleanupParentAbsoluteOrigin(entry.parent).y;
}

function cleanupReadBounds(node) {
  if (typeof getNodeBounds === "function") return getNodeBounds(node);
  const absolute = node && node.absoluteBoundingBox;
  return {
    x: Number(absolute && absolute.x !== undefined ? absolute.x : node && node.x || 0),
    y: Number(absolute && absolute.y !== undefined ? absolute.y : node && node.y || 0),
    width: Number(absolute && absolute.width !== undefined ? absolute.width : node && node.width || 0),
    height: Number(absolute && absolute.height !== undefined ? absolute.height : node && node.height || 0),
  };
}

function cleanupParentAbsoluteOrigin(parent) {
  if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") return { x: 0, y: 0 };
  const bounds = cleanupReadBounds(parent);
  return { x: bounds.x, y: bounds.y };
}

function cleanupBoundsDrift(before, after) {
  return Math.max(
    Math.abs(Number(before.x) - Number(after.x)),
    Math.abs(Number(before.y) - Number(after.y)),
    Math.abs(Number(before.width) - Number(after.width)),
    Math.abs(Number(before.height) - Number(after.height)),
  );
}

function cleanupReadPsdMetadata(node) {
  if (typeof readCleanupPsdMetadata !== "function") return {};
  const value = readCleanupPsdMetadata(node);
  return cleanupStableJsonValue(value) || {};
}

async function cleanupGetNodeById(nodeId) {
  if (typeof figma === "undefined") return null;
  if (typeof figma.getNodeByIdAsync === "function") {
    try { return await figma.getNodeByIdAsync(String(nodeId)); } catch (_) { return null; }
  }
  if (typeof figma.getNodeById === "function") {
    try { return figma.getNodeById(String(nodeId)); } catch (_) { return null; }
  }
  return null;
}

async function cleanupRequireNode(nodeId) {
  const node = await cleanupGetNodeById(String(nodeId));
  if (!node) throw new Error("Figma node not found: " + String(nodeId));
  return node;
}

async function cleanupRequireContainer(nodeId) {
  const node = await cleanupRequireNode(nodeId);
  if (!Array.isArray(node.children) || typeof node.insertChild !== "function") {
    throw new Error("Figma node is not a container: " + String(nodeId));
  }
  return node;
}

function cleanupNodeIndex(node) {
  const siblings = node && node.parent && Array.isArray(node.parent.children) ? node.parent.children : [];
  const index = siblings.indexOf(node);
  return index >= 0 ? index : 0;
}

function cleanupChildCount(node) {
  return Array.isArray(node && node.children) ? node.children.length : 0;
}

function cleanupPrimitiveOrNull(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function cleanupStableJsonValue(value) {
  if (Array.isArray(value)) return value.map(cleanupStableJsonValue);
  if (!value || typeof value !== "object") return cleanupPrimitiveOrNull(value);
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = cleanupStableJsonValue(value[key]);
  return output;
}

function cleanupErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanupUtf8Bytes(value) {
  const bytes = [];
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

function cleanupSha256(value) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = cleanupUtf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = ((bytes[base] << 24) | (bytes[base + 1] << 16) | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = (cleanupRotateRight(x, 7) ^ cleanupRotateRight(x, 18) ^ (x >>> 3)) >>> 0;
      const sigma1 = (cleanupRotateRight(y, 17) ^ cleanupRotateRight(y, 19) ^ (y >>> 10)) >>> 0;
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let a = hash[0]; let b = hash[1]; let c = hash[2]; let d = hash[3];
    let e = hash[4]; let f = hash[5]; let g = hash[6]; let h = hash[7];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = (cleanupRotateRight(e, 6) ^ cleanupRotateRight(e, 11) ^ cleanupRotateRight(e, 25)) >>> 0;
      const choice = ((e & f) ^ ((~e) & g)) >>> 0;
      const temp1 = (h + bigSigma1 + choice + constants[index] + words[index]) >>> 0;
      const bigSigma0 = (cleanupRotateRight(a, 2) ^ cleanupRotateRight(a, 13) ^ cleanupRotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map(function (word) { return ("00000000" + word.toString(16)).slice(-8); }).join("");
}

function cleanupRotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}
