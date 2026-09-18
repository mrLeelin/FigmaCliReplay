import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { GatewayConfig } from "./config.js";
import type { RuntimeRelay } from "./runtimeRelay.js";
import { UnityProjectRegistry } from "./unityProjectRegistry.js";
import { getCleanupRuntime } from "./cleanup/cleanupRuntime.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { corsHeaders, emptyResponse, isAllowedLocalRequest, isFigmaPluginRequest, isInternalRelayRequest, jsonResponse, OPERATION_ID_HEADER, requestOperationId } from "./utils.js";

export function createRelayHttpServer(
  _config: GatewayConfig,
  relay: RuntimeRelay,
  _unityProjects = new UnityProjectRegistry(),
  _cleanupRuntime = getCleanupRuntime(),
  logging = getLoggingRuntime(),
) {
  return createServer(async (request, response) => {
    const operationId = requestOperationId(request);
    const operation = logging.logger("http-server").startOperation("http.request", "Handle resource request", {
      operationId, data: { method: request.method, url: request.url },
    });
    response.setHeader(OPERATION_ID_HEADER, operationId);
    response.once("finish", () => {
      if (response.statusCode < 400) operation.succeed("Resource response completed", { status: response.statusCode });
      else operation.fail(new Error("HTTP " + response.statusCode), "Request rejected");
    });
    response.once("close", () => { if (!operation.completed) operation.cancel("Connection closed"); });
    try {
      operation.step("validate", "Validate local resource access");
      if (!isAllowedLocalRequest(request)) {
        jsonResponse(response, 403, { error: "forbidden origin or host" });
        return;
      }
      if (request.method === "OPTIONS") { emptyResponse(response, 204); return; }
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method !== "GET" || !url.pathname.startsWith("/assets/")) {
        jsonResponse(response, 410, { ok: false, code: "UPGRADE_REQUIRED", error: "Upgrade required: use CLI/WebSocket controls. HTTP only serves registered assets." });
        return;
      }
      if (!isFigmaPluginRequest(request) && !isInternalRelayRequest(request)) {
        jsonResponse(response, 403, { error: "Resource access requires a Figma or internal runtime request" });
        return;
      }
      const parts = url.pathname.split("/");
      if (parts.length < 4) { jsonResponse(response, 404, { error: "Invalid asset path" }); return; }
      const assetPath = relay.assetPath(decodeURIComponent(parts[2]), decodeURIComponent(parts.slice(3).join("/")));
      if (!assetPath) { jsonResponse(response, 404, { error: "Unknown asset" }); return; }
      operation.step("download", "Stream registered resource");
      const stream = fs.createReadStream(assetPath);
      stream.once("error", (error) => {
        operation.fail(error, "Resource stream failed");
        if (!response.headersSent) jsonResponse(response, 500, { error: "Resource unavailable" });
        else response.destroy(error);
      });
      response.once("close", () => stream.destroy());
      const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json" };
      response.writeHead(200, corsHeaders({ "content-type": types[path.extname(assetPath).toLowerCase()] || "application/octet-stream" }));
      stream.pipe(response);
    } catch (error) {
      operation.fail(error, "Resource request failed");
      if (!response.headersSent) jsonResponse(response, 500, { error: "Resource request failed" });
      else response.end();
    }
  });
}
