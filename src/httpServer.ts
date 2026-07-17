import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { PLUGIN_ROOT, publicUrl } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { RelayMcpHttpEndpoint } from "./mcpServer.js";
import { resolveDroppedPrefabs } from "./prefabDropResolver.js";
import { applyPsdImportTask, getPsdImportTask, startPsdImportTask } from "./psdImportTask.js";
import { followupAiRun, getAiRun, localAiRunnerStatus, runLocalAiCleanup, runLocalAiPrompt, stopAiRun, writeLocalAiRunnerConfig } from "./localAiRunner.js";
import { redactLargeRelayPayload, type RuntimeRelay } from "./runtimeRelay.js";
import { UnityProjectRegistry } from "./unityProjectRegistry.js";
import { readUnityGatewayDiscovery } from "./unityGatewayDiscovery.js";
import { installUnityBridge } from "./unityBridgeInstaller.js";
import {
  bearerToken,
  constantTimeEqual,
  corsHeaders,
  emptyResponse,
  isFigmaPluginRequest,
  isInternalRelayRequest,
  isAllowedLocalRequest,
  localRequestSecurityState,
  isRecord,
  jsonResponse,
  readJson
} from "./utils.js";

export function createRelayHttpServer(
  config: GatewayConfig,
  relay: RuntimeRelay,
  unityProjects = new UnityProjectRegistry()
) {
  const mcpEndpoint = new RelayMcpHttpEndpoint(relay);
  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const method = request.method || "";
    const url = request.url || "/";
    response.once("finish", () => {
      logHttpRequest(method, url, response.statusCode, Date.now() - startedAt);
    });
    try {
      if (!isAllowedLocalRequest(request)) {
        logWarn("Blocked non-local request", {
          method,
          url,
          ...localRequestSecurityState(request)
        });
        jsonResponse(response, 403, {
          error: "forbidden origin or host",
          request: {
            method: request.method,
            url: request.url,
            ...localRequestSecurityState(request)
          }
        });
        return;
      }
      if (request.method === "OPTIONS") {
        emptyResponse(response, 204);
        return;
      }
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (requestUrl.pathname === config.mcpPath && ["GET", "POST", "DELETE"].includes(request.method || "")) {
        await mcpEndpoint.handleRequest(request, response);
        return;
      }
      if (request.method === "GET") {
        handleGet(config, relay, unityProjects, request, requestUrl, response);
        return;
      }
      if (request.method === "POST") {
        if (isPrivateRuntimePostPath(requestUrl.pathname) && !isRuntimeRelayRequest(request, response)) {
          return;
        }
        const payload = await readJson(request);
        await handlePost(config, relay, unityProjects, request, requestUrl, payload, response);
        return;
      }
      jsonResponse(response, 405, { error: "method not allowed" });
    } catch (error) {
      logError("HTTP request failed", {
        method,
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.once("close", () => mcpEndpoint.dispose());
  return server;
}

function handleGet(
  config: GatewayConfig,
  relay: RuntimeRelay,
  unityProjects: UnityProjectRegistry,
  request: IncomingMessage,
  requestUrl: URL,
  response: ServerResponse
): void {
  const pathname = requestUrl.pathname;
  if (pathname === "/health") {
    const payload = relay.status();
    jsonResponse(response, 200, {
      ...payload,
      gateway: {
        pluginRoot: PLUGIN_ROOT,
        publicUrl: publicUrl(config)
      },
      mcp: {
        enabled: true,
        transport: "streamable_http",
        endpoint: `${publicUrl(config)}${config.mcpPath}`
      }
    });
    return;
  }
  if (pathname === "/mcp/config/status") {
    jsonResponse(response, 200, relay.mcpConfigStatus(requestUrl.searchParams.get("client") ?? ""));
    return;
  }
  if (pathname === "/mcp/clients") {
    jsonResponse(response, 200, relay.mcpClientsStatus());
    return;
  }
  if (pathname === "/ai-runner/status") {
    jsonResponse(response, 200, localAiRunnerStatus());
    return;
  }
  if (pathname === "/unity-projects") {
    jsonResponse(response, 200, unityProjects.list());
    return;
  }
  const unityGatewayMatch = pathname.match(/^\/unity-projects\/([^/]+)\/gateway$/);
  if (unityGatewayMatch) {
    const projectId = decodeURIComponent(unityGatewayMatch[1]);
    const project = unityProjects.list().projects.find((item) => item.id === projectId);
    if (!project) {
      jsonResponse(response, 404, { error: "unknown Unity project" });
    } else if (!project.valid) {
      jsonResponse(response, 200, { found: false });
    } else {
      jsonResponse(response, 200, readUnityGatewayDiscovery(project.path));
    }
    return;
  }
  const runMatch = pathname.match(/^\/ai-runner\/runs\/([^/]+)$/);
  if (runMatch) {
    try {
      const afterSequence = Number.parseInt(requestUrl.searchParams.get("afterSequence") || "0", 10) || 0;
      jsonResponse(response, 200, getAiRun(runMatch[1], String(request.headers["x-ai-run-capability"] || ""), afterSequence));
    } catch (error) {
      jsonResponse(response, 403, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (pathname === config.mcpPath) {
    jsonResponse(response, 405, { error: "MCP endpoint accepts POST requests" });
    return;
  }
  if (pathname === "/figma/pending") {
    if (!isRuntimeRelayRequest(request, response)) {
      return;
    }
    const job = relay.getNextPollingJobForTarget({
      sessionId: requestUrl.searchParams.get("sessionId") || undefined,
      fileKey: requestUrl.searchParams.get("fileKey") || undefined
    });
    if (!job) {
      emptyResponse(response, 204);
      return;
    }
    jsonResponse(response, 200, {
      requestId: job.requestId,
      job: job.job,
      target: {
        sessionId: job.targetSessionId,
        fileKey: job.targetFileKey
      }
    });
    return;
  }
  if (pathname.startsWith("/assets/")) {
    if (!isRuntimeRelayRequest(request, response)) {
      return;
    }
    const parts = pathname.split("/");
    if (parts.length < 4) {
      jsonResponse(response, 404, { error: "asset path must be /assets/{requestId}/{assetId}" });
      return;
    }
    const requestId = decodeURIComponent(parts[2]);
    const assetId = decodeURIComponent(parts.slice(3).join("/"));
    const assetPath = relay.assetPath(requestId, assetId);
    if (!assetPath) {
      jsonResponse(response, 404, { error: `unknown asset: ${assetId}` });
      return;
    }
    fileResponse(response, assetPath);
    return;
  }
  if (pathname.startsWith("/jobs/") && pathname.endsWith("/result")) {
    if (!isRuntimeRelayRequest(request, response)) {
      return;
    }
    const requestId = decodeURIComponent(pathname.split("/")[2]);
    const job = relay.getJob(requestId);
    if (!job) {
      jsonResponse(response, 404, { error: `unknown job: ${requestId}` });
      return;
    }
    if (!job.result) {
      emptyResponse(response, 204);
      return;
    }
    jsonResponse(response, 200, { requestId, result: redactLargeRelayPayload(job.result) });
    return;
  }
  if (pathname.startsWith("/prefab-to-figma/import/") && pathname.endsWith("/status")) {
    void proxyLegacy(relay, requestUrl.pathname, "GET", undefined, response, 10_000);
    return;
  }
  if (pathname.startsWith("/psd-to-figma/import/") && pathname.endsWith("/status")) {
    const parts = pathname.split("/");
    const taskId = decodeURIComponent(parts[3] || "");
    const task = getPsdImportTask(taskId);
    if (!task) {
      jsonResponse(response, 404, { ok: false, error: `unknown PSD import task: ${taskId}` });
      return;
    }
    jsonResponse(response, 200, { ok: true, task });
    return;
  }
  jsonResponse(response, 404, { error: `unknown endpoint: ${pathname}` });
}

async function handlePost(
  config: GatewayConfig,
  relay: RuntimeRelay,
  unityProjects: UnityProjectRegistry,
  request: IncomingMessage,
  requestUrl: URL,
  payload: unknown,
  response: ServerResponse
): Promise<void> {
  const pathname = requestUrl.pathname;
  if (pathname === "/unity-projects/add" || pathname === "/unity-projects/select" || pathname === "/unity-projects/remove" || pathname === "/unity-projects/install-bridge") {
    if (!canManageUnityProjects(config, relay, request, payload)) {
      jsonResponse(response, 403, { ok: false, error: "Unity project changes require the local admin token or an online Figma plugin session." });
      return;
    }
    if (!isRecord(payload)) {
      jsonResponse(response, 400, { ok: false, error: "json body must be object" });
      return;
    }
    try {
      if (pathname === "/unity-projects/add") {
        const project = unityProjects.add(String(payload.path || ""));
        jsonResponse(response, 200, { ok: true, project, ...unityProjects.list() });
      } else if (pathname === "/unity-projects/select") {
        const project = unityProjects.select(String(payload.id || ""));
        jsonResponse(response, 200, { ok: true, project, ...unityProjects.list() });
      } else if (pathname === "/unity-projects/remove") {
        unityProjects.remove(String(payload.id || ""));
        jsonResponse(response, 200, { ok: true, ...unityProjects.list() });
      } else {
        const selectedProject = unityProjects.snapshot(String(payload.id || ""));
        const installResult = installUnityBridge(selectedProject.path);
        const project = unityProjects.add(selectedProject.path);
        jsonResponse(response, 200, { ok: true, installResult, project, ...unityProjects.list() });
      }
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (pathname === "/jobs") {
    if (!isRuntimeRelayRequest(request, response)) {
      return;
    }
    submitJobResponse(relay, payload, response);
    return;
  }
  if (pathname === "/figma/result") {
    if (!isRuntimeRelayRequest(request, response)) {
      return;
    }
    if (!isRecord(payload)) {
      jsonResponse(response, 400, { error: "json body must be object" });
      return;
    }
    const requestId = String(payload.requestId ?? "");
    const result = payload.result;
    if (!requestId || !isRecord(result)) {
      jsonResponse(response, 400, { error: "missing requestId or result" });
      return;
    }
    if (!relay.setResult(requestId, result)) {
      jsonResponse(response, 404, { error: `unknown job: ${requestId}` });
      return;
    }
    jsonResponse(response, 200, { ok: true });
    return;
  }
  if (pathname === "/figma/query-selection") {
    submitJobResponse(relay, { job: { type: "QUERY_SELECTION" } }, response);
    return;
  }
  if (pathname === "/figma/query-plugin-status") {
    submitJobResponse(relay, { job: { type: "QUERY_PLUGIN_STATUS" } }, response);
    return;
  }
  if (pathname === "/figma/query-node-children") {
    if (!isRecord(payload) || !payload.nodeId) {
      jsonResponse(response, 400, { error: "missing nodeId" });
      return;
    }
    submitJobResponse(relay, {
      job: { type: "QUERY_NODE_CHILDREN", nodeId: String(payload.nodeId) }
    }, response);
    return;
  }
  if (pathname === "/figma/query-components") {
    const libraryNodeIds = isRecord(payload) && Array.isArray(payload.libraryNodeIds)
      ? payload.libraryNodeIds
      : ["62:115", "2896:32"];
    submitJobResponse(relay, {
      job: { type: "COLLECT_COMPONENTS", libraryNodeIds }
    }, response);
    return;
  }
  if (pathname === "/figma/resize-node") {
    if (!isRecord(payload) || !payload.nodeId) {
      jsonResponse(response, 400, { error: "missing nodeId" });
      return;
    }
    submitJobResponse(relay, {
      job: {
        type: "RESIZE_NODE",
        nodeId: String(payload.nodeId),
        width: payload.width,
        height: payload.height
      }
    }, response);
    return;
  }
  if (pathname === "/figma/delete-node") {
    if (!isRecord(payload) || !payload.nodeId) {
      jsonResponse(response, 400, { error: "missing nodeId" });
      return;
    }
    submitJobResponse(relay, {
      job: { type: "DELETE_NODE_BY_ID", nodeId: String(payload.nodeId) }
    }, response);
    return;
  }
  if (pathname === "/mcp/config/write" || pathname === "/mcp/config/delete" || pathname === "/mcp/config/open") {
    if (!isRecord(payload)) {
      jsonResponse(response, 400, { ok: false, error: "json body must be object" });
      return;
    }
    const tokenAllowed = Boolean(config.adminToken) && constantTimeEqual(bearerToken(request), config.adminToken);
    const figmaPluginAllowed = isFigmaPluginRequest(request);
    const livePluginSessionAllowed = relay.hasLivePluginSession(payload.sessionId);
    if (!tokenAllowed && !figmaPluginAllowed && !livePluginSessionAllowed) {
      jsonResponse(response, 403, {
        ok: false,
        error: "MCP config changes require the local admin token or an online Figma plugin session. Use scripts/setup_mcp_config.ps1 for teammate setup."
      });
      return;
    }
    const client = payload.client || "codex";
    const source = tokenAllowed ? "token" : figmaPluginAllowed ? "figma-origin" : "figma-session";
    if (pathname === "/mcp/config/write") {
      logInfo("MCP config write requested", { client: String(client), source });
      jsonResponse(response, 200, relay.writeMcpConfig(client, payload.url));
    } else if (pathname === "/mcp/config/delete") {
      logInfo("MCP config delete requested", { client: String(client), source });
      jsonResponse(response, 200, relay.deleteMcpConfig(client));
    } else {
      logInfo("MCP config open requested", { client: String(client), source });
      const result = relay.openMcpConfig(client);
      jsonResponse(response, result.ok === false ? 500 : 200, result);
    }
    return;
  }
  if (pathname === "/ai-runner/config" || pathname === "/ai-runner/run-cleanup" || pathname === "/ai-runner/run-prompt" || /^\/ai-runner\/runs\/[^/]+\/(followup|stop)$/.test(pathname)) {
    const runAction = pathname.match(/^\/ai-runner\/runs\/([^/]+)\/(followup|stop)$/);
    if (runAction) {
      try {
        const token = String(request.headers["x-ai-run-capability"] || "");
        const result = runAction[2] === "followup" ? followupAiRun(runAction[1], token, isRecord(payload) ? payload.text : undefined) : stopAiRun(runAction[1], token);
        jsonResponse(response, 200, result);
      } catch (error) {
        jsonResponse(response, 403, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (!isRecord(payload) || (!isFigmaPluginRequest(request) && !relay.hasLivePluginSession(payload.sessionId))) {
      jsonResponse(response, 403, { ok: false, error: "AI runner actions require a live local Figma plugin session." });
      return;
    }
    try {
      const result = pathname === "/ai-runner/config"
        ? writeLocalAiRunnerConfig(payload)
        : pathname === "/ai-runner/run-cleanup"
          ? runLocalAiCleanup(payload)
          : runLocalAiPrompt(payload);
      jsonResponse(response, 200, result);
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (pathname === "/open-plugin-folder" || pathname === "/crop-jiugong") {
    await proxyLegacy(relay, pathname, "POST", payload, response, 30_000);
    return;
  }
  if (pathname === "/prefab-to-figma/import") {
    await proxyLegacy(relay, pathname, "POST", payload, response, 30_000);
    return;
  }
  if (pathname === "/prefab-to-figma/resolve-dropped") {
    try {
      jsonResponse(response, 200, resolveDroppedPrefabs(payload));
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (pathname === "/psd-to-figma/import") {
    try {
      const task = startPsdImportTask(config, payload);
      jsonResponse(response, 200, { ok: true, task });
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  // Route shape: /psd-to-figma/import/[^/]+/apply
  const psdApplyMatch = pathname.match(/^\/psd-to-figma\/import\/([^/]+)\/apply$/);
  if (psdApplyMatch) {
    const taskId = decodeURIComponent(psdApplyMatch[1] || "");
    try {
      const task = applyPsdImportTask(config, taskId, payload);
      jsonResponse(response, 200, { ok: true, task });
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  jsonResponse(response, 404, { error: `unknown endpoint: ${pathname}` });
}

function canManageUnityProjects(
  config: GatewayConfig,
  relay: RuntimeRelay,
  request: IncomingMessage,
  payload: unknown
): boolean {
  const tokenAllowed = Boolean(config.adminToken) && constantTimeEqual(bearerToken(request), config.adminToken);
  const sessionId = isRecord(payload) ? payload.sessionId : undefined;
  return tokenAllowed || isFigmaPluginRequest(request) || relay.hasLivePluginSession(sessionId);
}

function isRuntimeRelayRequest(request: IncomingMessage, response: ServerResponse): boolean {
  if (isFigmaPluginRequest(request) || isInternalRelayRequest(request)) {
    return true;
  }
  jsonResponse(response, 403, {
    ok: false,
    error: "Private Figma runtime relay endpoint. Use the /mcp endpoint for agent calls."
  });
  return false;
}

function isPrivateRuntimePostPath(pathname: string): boolean {
  return pathname === "/jobs" || pathname === "/figma/result";
}

function submitJobResponse(relay: RuntimeRelay, payload: unknown, response: ServerResponse): void {
  try {
    const submitted = relay.submitJob(payload);
    logInfo("HTTP job submitted", {
      requestId: String(submitted.requestId || ""),
      transport: String(submitted.transport || "")
    });
    jsonResponse(response, 200, submitted);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("duplicate in-flight requestId")
      ? 409
      : message.includes("No online Figma plugin WebSocket session")
        ? 503
        : message.includes("asset path is outside allowed roots")
          || message.includes("Multiple online Figma plugin sessions require target")
            ? 400
            : 500;
    logWarn("HTTP job submit failed", { status, error: message });
    jsonResponse(response, status, { ok: false, error: message });
  }
}

async function proxyLegacy(
  relay: RuntimeRelay,
  pathname: string,
  method: "GET" | "POST",
  payload: unknown,
  response: ServerResponse,
  timeoutMs: number
): Promise<void> {
  try {
    const result = await relay.legacyJson(pathname, method, payload, timeoutMs);
    if (result.json !== undefined) {
      jsonResponse(response, result.status, result.json);
      return;
    }
    response.writeHead(result.status, corsHeaders(normalizeHeaders(result.headers)));
    response.end(result.body);
  } catch (error) {
    jsonResponse(response, 503, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function logHttpRequest(method: string, url: string, status: number, elapsedMs: number): void {
  let pathname = url;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    // Keep the raw URL if parsing fails.
  }
  if (status >= 500) {
    logError("HTTP request", { method, path: pathname, status, elapsedMs });
    return;
  }
  if (status >= 400) {
    logWarn("HTTP request", { method, path: pathname, status, elapsedMs });
    return;
  }
  if (pathname === "/figma/pending" && status === 204) {
    return;
  }
  if (pathname === "/health") {
    return;
  }
  logInfo("HTTP request", { method, path: pathname, status, elapsedMs });
}

function fileResponse(response: ServerResponse, filePath: string): void {
  const stream = fs.createReadStream(filePath);
  response.writeHead(200, corsHeaders({ "content-type": contentType(filePath) }));
  stream.pipe(response);
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      normalized[key] = value.join(", ");
    }
  }
  return normalized;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".json") {
    return "application/json";
  }
  return "application/octet-stream";
}
