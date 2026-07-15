export function createImageHealth(status, reason, details = {}) {
  return Object.assign({ status, reason }, details);
}

export function isValidImagePayload(item) {
  return !!item
    && Number(item.width) >= 1
    && Number(item.height) >= 1
    && Number(item.byteLength) > 8
    && typeof item.base64 === "string"
    && item.base64.startsWith("iVBORw0KGgo");
}

export function validateImageExports(exports) {
  const byId = new Map(exports.map((item) => [String(item.id || ""), item]));
  const errors = [];
  for (const item of exports) {
    if (item.duplicateOf) {
      const source = byId.get(String(item.duplicateOf));
      if (!source || !isValidImagePayload(source)) {
        errors.push({ code: "danglingDuplicate", nodeId: item.nodeId || "", nodePath: item.nodePath || "", exportId: item.id || "", sourceExportId: item.duplicateOf });
      }
      continue;
    }
    if (!isValidImagePayload(item)) {
      errors.push({ code: "invalidImagePayload", nodeId: item.nodeId || "", nodePath: item.nodePath || "", exportId: item.id || "", width: Number(item.width) || 0, height: Number(item.height) || 0, byteLength: Number(item.byteLength) || 0 });
    }
  }
  return errors;
}

export function summarizeImageHealth(exports) {
  const summary = { total: exports.length, healthy: 0, repaired: 0, blocked: 0 };
  for (const item of exports) {
    const status = item && item.health ? item.health.status : "blocked";
    if (status === "healthy" || status === "repaired" || status === "blocked") summary[status] += 1;
    else summary.blocked += 1;
  }
  return summary;
}

export function applyImageValidationErrors(exports, errors) {
  const byId = new Map(exports.map((item) => [String(item.id || ""), item]));
  for (const error of errors) {
    const item = byId.get(String(error.exportId || ""));
    if (item) item.health = createImageHealth("blocked", error.code || "invalidImagePayload", { sourceExportId: error.sourceExportId || "" });
  }
}
