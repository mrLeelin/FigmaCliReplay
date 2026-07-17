const CleanupMetadataNamespace = "psd_layer_to_figma_bridge";

const CleanupPsdMetadataKeys = Object.freeze([
  "psdLayerId",
  "psdOwnership",
  "psdContentHash",
  "rawPsdLayerName",
  "psdSourceFileName",
  "psdSourceKey",
  "psdLayerSetFingerprint",
]);

export const CleanupSnapshotLimits = Object.freeze({
  maxNodes: 500,
  maxDepth: 12,
  maxTextCharacters: 256,
  maxBytes: 256 * 1024,
});

export function isCleanupRecoveryNode(node) {
  let current = node || null;
  while (current) {
    if (typeof current.name === "string" && current.name.startsWith("__cleanup_backup__")) {
      return true;
    }
    current = current.parent || null;
  }
  return false;
}

export function buildCleanupSnapshot(root, requestedLimits = CleanupSnapshotLimits) {
  if (!root || !root.id) throw new Error("cleanup snapshot requires one root node");
  if (isCleanupRecoveryNode(root)) throw new Error("cleanup recovery backup cannot be used as a cleanup root");
  const limits = normalizeCleanupSnapshotLimits(requestedLimits);
  const nodes = [];
  collectCleanupSnapshotNodes(root, 0, nodes, limits);
  const snapshot = {
    schemaVersion: 1,
    rootNodeId: String(root.id),
    capturedAt: typeof requestedLimits.now === "function"
      ? String(requestedLimits.now())
      : new Date().toISOString(),
    limits: {
      maxNodes: limits.maxNodes,
      maxDepth: limits.maxDepth,
      maxTextCharacters: limits.maxTextCharacters,
      maxBytes: limits.maxBytes,
    },
    nodes,
  };
  const byteLength = cleanupUtf8ByteLength(JSON.stringify(snapshot));
  if (byteLength > limits.maxBytes) {
    throw new Error(`cleanup snapshot exceeds ${limits.maxBytes} bytes`);
  }
  return snapshot;
}

function normalizeCleanupSnapshotLimits(value) {
  return {
    maxNodes: positiveCleanupLimit(value && value.maxNodes, CleanupSnapshotLimits.maxNodes),
    maxDepth: nonNegativeCleanupLimit(value && value.maxDepth, CleanupSnapshotLimits.maxDepth),
    maxTextCharacters: nonNegativeCleanupLimit(value && value.maxTextCharacters, CleanupSnapshotLimits.maxTextCharacters),
    maxBytes: positiveCleanupLimit(value && value.maxBytes, CleanupSnapshotLimits.maxBytes),
  };
}

function positiveCleanupLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeCleanupLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function collectCleanupSnapshotNodes(node, depth, output, limits) {
  if (isCleanupRecoveryNode(node)) return;
  if (depth > limits.maxDepth) {
    throw new Error(`cleanup snapshot exceeds depth ${limits.maxDepth}`);
  }
  if (output.length >= limits.maxNodes) {
    throw new Error(`cleanup snapshot exceeds ${limits.maxNodes} nodes`);
  }
  output.push(buildCleanupSnapshotNode(node, depth, limits.maxTextCharacters));
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    collectCleanupSnapshotNodes(child, depth + 1, output, limits);
  }
}

function buildCleanupSnapshotNode(node, depth, maxTextCharacters) {
  const psd = readCleanupPsdMetadata(node);
  const children = Array.isArray(node.children)
    ? node.children.filter((child) => !isCleanupRecoveryNode(child))
    : [];
  const record = {
    id: String(node.id || ""),
    parentId: node.parent && node.parent.id ? String(node.parent.id) : "",
    type: String(node.type || ""),
    name: String(node.name || ""),
    siblingIndex: cleanupSiblingIndex(node),
    depth,
    x: finiteCleanupNumber(node.x),
    y: finiteCleanupNumber(node.y),
    w: finiteCleanupNumber(node.width),
    h: finiteCleanupNumber(node.height),
    visible: node.visible !== false,
    opacity: Number.isFinite(Number(node.opacity)) ? Number(node.opacity) : 1,
    childCount: children.length,
    roles: {
      image: cleanupHasImagePaint(node),
      nineSlice: cleanupIsNineSlice(node),
      component: node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE",
      psdSource: Object.keys(psd).length > 0,
    },
  };
  if (node.type === "TEXT") {
    record.characters = String(node.characters || "").slice(0, maxTextCharacters);
  }
  if (Object.keys(psd).length > 0) record.psd = psd;
  return record;
}

function cleanupSiblingIndex(node) {
  const siblings = node.parent && Array.isArray(node.parent.children)
    ? node.parent.children.filter((sibling) => !isCleanupRecoveryNode(sibling))
    : [];
  const index = siblings.indexOf(node);
  return index >= 0 ? index : 0;
}

function finiteCleanupNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function cleanupHasImagePaint(node) {
  return Array.isArray(node.fills) && node.fills.some((paint) => paint && paint.type === "IMAGE");
}

function cleanupIsNineSlice(node) {
  const name = String(node.name || "").toLowerCase();
  return /(?:nine.?slice|jiugong|__slice_|slice[_-]?\d)/.test(name)
    || cleanupSharedPluginData(node, "spriteBorder") !== ""
    || cleanupSharedPluginData(node, "border") !== "";
}

function readCleanupPsdMetadata(node) {
  const result = {};
  for (const key of CleanupPsdMetadataKeys) {
    const value = cleanupSharedPluginData(node, key);
    if (value !== "") result[key] = value;
  }
  return result;
}

function cleanupSharedPluginData(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") return "";
  try {
    return String(node.getSharedPluginData(CleanupMetadataNamespace, key) || "");
  } catch (_) {
    return "";
  }
}

function cleanupUtf8ByteLength(value) {
  return encodeURIComponent(String(value)).replace(/%[0-9A-F]{2}|./gi, "x").length;
}
