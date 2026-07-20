export function normalizePsdLayerId(value) {
  var text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) && text !== "0" ? text : "";
}

export function canonicalizePsdSourceState(value) {
  if (Array.isArray(value)) return value.map(canonicalizePsdSourceState);
  if (!value || typeof value !== "object") return value;
  var result = {};
  for (var key of Object.keys(value).sort()) {
    var child = value[key];
    if (typeof child !== "undefined") result[key] = canonicalizePsdSourceState(child);
  }
  return result;
}

export function stablePsdSourceStateJson(value) {
  return JSON.stringify(canonicalizePsdSourceState(value));
}

export function hashPsdSourceState(value) {
  var text = stablePsdSourceStateJson(value);
  var hash = 2166136261;
  for (var index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizePsdSourceState(layer) {
  var sourceLayer = layer || {};
  var raw = sourceLayer.sourceState && typeof sourceLayer.sourceState === "object"
    ? sourceLayer.sourceState
    : sourceLayer;
  if (!raw || typeof raw !== "object") return null;
  var geometry = raw.geometry || {};
  var display = raw.display || {};
  var geometryX = geometry.x != null ? geometry.x : sourceLayer.x;
  var geometryY = geometry.y != null ? geometry.y : sourceLayer.y;
  var geometryWidth = geometry.width != null
    ? geometry.width
    : (sourceLayer.w != null ? sourceLayer.w : sourceLayer.width);
  var geometryHeight = geometry.height != null
    ? geometry.height
    : (sourceLayer.h != null ? sourceLayer.h : sourceLayer.height);
  var rotation = geometry.rotation == null ? null : Number(geometry.rotation);
  return canonicalizePsdSourceState({
    version: 3,
    layerId: normalizePsdLayerId(raw.layerId || sourceLayer.layerId),
    mode: String(raw.mode || sourceLayer.mode || "image"),
    geometry: {
      x: Number(geometryX == null ? 0 : geometryX),
      y: Number(geometryY == null ? 0 : geometryY),
      width: Number(geometryWidth == null ? 0 : geometryWidth),
      height: Number(geometryHeight == null ? 0 : geometryHeight),
      rotation: Number.isFinite(rotation) ? rotation : null,
    },
    display: {
      visible: (display.visible != null ? display.visible : sourceLayer.visible) !== false,
      opacity: Number(display.opacity != null
        ? display.opacity
        : (sourceLayer.opacity != null ? sourceLayer.opacity : 1)),
      blendMode: display.blendMode != null ? display.blendMode : null,
      constraints: display.constraints || sourceLayer.constraints || {},
    },
    content: raw.content || { contentHash: String(sourceLayer.contentHash || "") },
    text: raw.text || null,
    nineSlice: raw.nineSlice || null,
    unsupported: Array.isArray(raw.unsupported) ? raw.unsupported : [],
  });
}

var PSD_SOURCE_FIELD_DESCRIPTORS = [
  ["content.contentHash", "content"],
  ["geometry.x", "position"], ["geometry.y", "position"],
  ["geometry.width", "size"], ["geometry.height", "size"],
  ["geometry.rotation", "rotation"],
  ["display.visible", "display"], ["display.opacity", "display"],
  ["display.blendMode", "display"], ["display.constraints", "display"],
  ["text.characters", "textContent"], ["text.fontFamily", "textStyle"],
  ["text.fontFallback", "textStyle"], ["text.fontSize", "textStyle"],
  ["text.effectiveFontSize", "textStyle"], ["text.leading", "textStyle"],
  ["text.lineHeightMode", "textStyle"], ["text.textAlignHorizontal", "textStyle"],
  ["text.fillColor", "textStyle"], ["text.stroke", "textStyle"],
  ["text.dropShadow", "textStyle"],
  ["nineSlice", "nineSlice"],
];

function valueAtPsdPath(value, path) {
  return path.split(".").reduce(function (current, key) {
    return current == null ? undefined : current[key];
  }, value);
}

export function diffPsdSourceStates(baseline, incoming) {
  var changes = [];
  for (var descriptor of PSD_SOURCE_FIELD_DESCRIPTORS) {
    var before = valueAtPsdPath(baseline, descriptor[0]);
    var after = valueAtPsdPath(incoming, descriptor[0]);
    if (stablePsdSourceStateJson(before) === stablePsdSourceStateJson(after)) continue;
    changes.push({
      path: descriptor[0],
      category: descriptor[1],
      before: before,
      after: after,
      delta: typeof before === "number" && typeof after === "number" ? after - before : null,
    });
  }
  var unsupportedChanged = stablePsdSourceStateJson(baseline.unsupported || [])
    !== stablePsdSourceStateJson(incoming.unsupported || []);
  return { changes: changes, unsupportedChanged: unsupportedChanged };
}

function categoryLayerCount(changed, category) {
  return changed.filter(function (pair) {
    return pair.changes.some(function (change) { return change.category === category; });
  }).length;
}

function transformPsdVector(matrix, vector) {
  return {
    x: matrix[0][0] * vector.x + matrix[0][1] * vector.y,
    y: matrix[1][0] * vector.x + matrix[1][1] * vector.y,
  };
}

function inversePsdTransformPoint(matrix, point) {
  var a = matrix[0][0], c = matrix[0][1], tx = matrix[0][2];
  var b = matrix[1][0], d = matrix[1][1], ty = matrix[1][2];
  var determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
    throw new Error("non-invertible-parent-transform");
  }
  var x = point.x - tx;
  var y = point.y - ty;
  return {
    x: (d * x - c * y) / determinant,
    y: (-b * x + a * y) / determinant,
  };
}

export function computePsdGeometryTarget(input) {
  var baseline = input.baseline;
  var incoming = input.incoming;
  if (!(baseline.width > 0) || !(baseline.height > 0)) {
    throw new Error("invalid-baseline-size");
  }
  var sourceDelta = { x: incoming.x - baseline.x, y: incoming.y - baseline.y };
  var pageDelta = transformPsdVector(input.rootAbsoluteTransform, sourceDelta);
  var desiredAbsolute = {
    x: input.currentAbsolute.x + pageDelta.x,
    y: input.currentAbsolute.y + pageDelta.y,
  };
  return {
    localPosition: inversePsdTransformPoint(input.parentAbsoluteTransform, desiredAbsolute),
    size: {
      width: input.currentSize.width * incoming.width / baseline.width,
      height: input.currentSize.height * incoming.height / baseline.height,
    },
    rotation: Number.isFinite(baseline.rotation) && Number.isFinite(incoming.rotation)
      ? input.currentRotation + incoming.rotation - baseline.rotation
      : input.currentRotation,
  };
}

export function buildPsdLayerMutationPlan(pair) {
  var categories = Array.from(new Set(pair.changes.map(function (change) {
    return change.category;
  }))).sort();
  return {
    layerId: normalizePsdLayerId(pair.source.layerId),
    nodeId: String(pair.target.nodeId || ""),
    source: pair.source,
    target: pair.target,
    categories: categories,
    changedPaths: pair.changes.map(function (change) { return change.path; }).sort(),
    baseline: normalizePsdSourceState({ sourceState: pair.target.sourceState }),
    incoming: normalizePsdSourceState(pair.source),
  };
}

export function psdOwnershipForMode(mode) {
  if (mode === "text") return "text-content";
  if (mode === "image") return "image-content";
  if (mode === "nine-slice") return "nine-slice-content";
  return "protected";
}

export function validatePsdOwnedTarget(ownership, sourceMode, nodeType, textAutoResize) {
  var expected = psdOwnershipForMode(sourceMode);
  if (expected === "protected") return "protected-source-mode";
  if (ownership !== expected) return "ownership-mismatch";
  if (expected === "nine-slice-content") {
    return nodeType === "FRAME" ? "" : "unsupported-nine-slice-target";
  }
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
  var baselineRequired = [];

  for (var incomingEntry of incomingById.entries()) {
    var layerId = incomingEntry[0];
    var sourceLayer = incomingEntry[1];
    var incomingState = normalizePsdSourceState(sourceLayer);
    var target = currentById.get(layerId);
    if (!target) {
      if (incomingState && incomingState.unsupported.length > 0) {
        conflicts.push({
          kind: "unsupported-source-change",
          layerId: layerId,
          unsupported: incomingState.unsupported,
        });
      } else {
        added.push({ source: sourceLayer, sourceState: incomingState });
      }
      continue;
    }

    if (!target.sourceState || typeof target.sourceState !== "object") {
      baselineRequired.push({ source: sourceLayer, target: target, sourceState: incomingState });
      continue;
    }

    var baselineState = normalizePsdSourceState({
      layerId: layerId,
      sourceState: target.sourceState,
    });
    var fieldDiff = diffPsdSourceStates(baselineState, incomingState);
    var pair = {
      source: sourceLayer,
      target: target,
      baselineState: baselineState,
      sourceState: incomingState,
      changes: fieldDiff.changes,
    };

    if (fieldDiff.changes.some(function (change) {
      return change.path === "geometry.rotation"
        && (!Number.isFinite(change.before) || !Number.isFinite(change.after));
    })) {
      conflicts.push({ kind: "unreliable-rotation-delta", layerId: layerId });
    }
    if (fieldDiff.unsupportedChanged) {
      conflicts.push({
        kind: "unsupported-source-change",
        layerId: layerId,
        before: baselineState.unsupported,
        after: incomingState.unsupported,
      });
    }

    if (fieldDiff.changes.length === 0 && !fieldDiff.unsupportedChanged) unchanged.push(pair);
    else changed.push(pair);
  }

  for (var currentEntry of currentById.entries()) {
    if (!incomingById.has(currentEntry[0])) {
      missing.push({ target: currentEntry[1] });
    }
  }

  var status = conflicts.length > 0
    ? "preview-blocked"
    : baselineRequired.length > 0
      ? "preview-baseline-required"
      : changed.length === 0 && added.length === 0
        ? "preview-no-changes"
        : "preview-ready";

  return {
    status: status,
    changed: changed,
    unchanged: unchanged,
    added: added,
    missing: missing,
    baselineRequired: baselineRequired,
    conflicts: conflicts,
    canApply: status === "preview-ready",
    summary: {
      affected: changed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      added: added.length,
      missing: missing.length,
      conflicts: conflicts.length,
      content: categoryLayerCount(changed, "content"),
      textContent: categoryLayerCount(changed, "textContent"),
      position: categoryLayerCount(changed, "position"),
      size: categoryLayerCount(changed, "size"),
      rotation: categoryLayerCount(changed, "rotation"),
      display: categoryLayerCount(changed, "display"),
      textStyle: categoryLayerCount(changed, "textStyle"),
      nineSlice: categoryLayerCount(changed, "nineSlice"),
      baselineRequired: baselineRequired.length,
    },
  };
}
