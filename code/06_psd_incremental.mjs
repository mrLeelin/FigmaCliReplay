export function normalizePsdLayerId(value) {
  var text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) && text !== "0" ? text : "";
}

export function psdOwnershipForMode(mode) {
  if (mode === "text") return "text-content";
  if (mode === "image") return "image-content";
  return "protected";
}

export function validatePsdOwnedTarget(ownership, sourceMode, nodeType, textAutoResize) {
  var expected = psdOwnershipForMode(sourceMode);
  if (expected === "protected") return "protected-source-mode";
  if (ownership !== expected) return "ownership-mismatch";
  if (expected === "text-content") {
    if (nodeType !== "TEXT") return "unsupported-text-target";
    if (textAutoResize && textAutoResize !== "NONE") return "unsafe-text-auto-resize";
    return "";
  }
  return nodeType === "RECTANGLE" ? "" : "unsupported-image-target";
}

export function measurePsdLayerIdentity(currentNodes, incomingLayers) {
  var current = new Set((currentNodes || []).map(function (item) {
    return normalizePsdLayerId(item && item.layerId);
  }).filter(Boolean));
  var incoming = new Set((incomingLayers || []).map(function (item) {
    return normalizePsdLayerId(item && item.layerId);
  }).filter(Boolean));
  var matched = 0;
  for (var layerId of current) {
    if (incoming.has(layerId)) matched += 1;
  }
  var comparisonSize = Math.max(current.size, incoming.size);
  return {
    currentCount: current.size,
    incomingCount: incoming.size,
    matchedCount: matched,
    currentCoverage: current.size > 0 ? matched / current.size : 0,
    incomingCoverage: incoming.size > 0 ? matched / incoming.size : 0,
    overlap: comparisonSize > 0 ? matched / comparisonSize : 0,
  };
}

export function isPsdIncrementalCandidate(record) {
  var node = record && record.node;
  if (!node) return true;
  if (typeof isCleanupRecoveryNode === "function") {
    return !isCleanupRecoveryNode(node);
  }
  var current = node;
  while (current) {
    if (typeof current.name === "string" && current.name.startsWith("__cleanup_backup__")) {
      return false;
    }
    current = current.parent || null;
  }
  return true;
}


export function buildPsdIncrementalDiff(currentNodes, incomingLayers) {
  var currentById = new Map();
  var conflicts = [];

  for (var current of currentNodes || []) {
    if (!isPsdIncrementalCandidate(current)) continue;
    var currentId = normalizePsdLayerId(current && current.layerId);
    if (!currentId) continue;
    if (currentById.has(currentId)) {
      conflicts.push({
        kind: "duplicate-target-layer-id",
        layerId: currentId,
        first: currentById.get(currentId),
        duplicate: current,
      });
      continue;
    }
    currentById.set(currentId, current);
  }

  var incomingById = new Map();
  for (var source of incomingLayers || []) {
    var sourceId = normalizePsdLayerId(source && source.layerId);
    if (!sourceId) {
      conflicts.push({
        kind: "missing-source-layer-id",
        name: source && source.name ? String(source.name) : "",
      });
      continue;
    }
    if (incomingById.has(sourceId)) {
      conflicts.push({
        kind: "duplicate-source-layer-id",
        layerId: sourceId,
        first: incomingById.get(sourceId),
        duplicate: source,
      });
      continue;
    }
    incomingById.set(sourceId, source);
  }

  var changed = [];
  var unchanged = [];
  var added = [];
  var missing = [];

  for (var incomingEntry of incomingById.entries()) {
    var layerId = incomingEntry[0];
    var sourceLayer = incomingEntry[1];
    var target = currentById.get(layerId);
    if (!target) {
      added.push({ source: sourceLayer });
      continue;
    }

    var targetHash = String(target.contentHash || "");
    var sourceHash = String(sourceLayer.contentHash || "");
    var pair = { source: sourceLayer, target: target };
    if (targetHash && targetHash === sourceHash) unchanged.push(pair);
    else changed.push(pair);
  }

  for (var currentEntry of currentById.entries()) {
    if (!incomingById.has(currentEntry[0])) {
      missing.push({ target: currentEntry[1] });
    }
  }

  return {
    changed: changed,
    unchanged: unchanged,
    added: added,
    missing: missing,
    conflicts: conflicts,
    canApply: conflicts.length === 0,
    summary: {
      changed: changed.length,
      unchanged: unchanged.length,
      added: added.length,
      missing: missing.length,
      conflicts: conflicts.length,
    },
  };
}
