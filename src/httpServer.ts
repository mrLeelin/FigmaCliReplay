import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import type { GatewayConfig } from "./config.js";
import { PLUGIN_ROOT, publicUrl } from "./config.js";
import { getCleanupRuntime, type CleanupRuntime } from "./cleanup/cleanupRuntime.js";
import { CleanupError } from "./cleanup/cleanupTypes.js";
import type { CleanupSnapshotV1 } from "./cleanupPlan.js";
import { LogLevels, LogSources, LogStatuses, type LogQuery } from "./logging/logEvent.js";
import { getLoggingRuntime, type LoggingRuntime } from "./logging/loggingRuntime.js";
import { UnityLogCollector } from "./logging/unityLogCollector.js";
import { logError, logInfo, logWarn, logger } from "./utils/logger.js";
import { RelayMcpHttpEndpoint } from "./mcpServer.js";
import { resolveDroppedPrefabs } from "./prefabDropResolver.js";
import {
  adoptPsdImportBaseline,
  applyPsdImportTask,
  getPsdImportTask,
  startPsdImportTask
} from "./psdImportTask.js";
import { followupAiRun, getAiRun, localAiRunnerStatus, openLocalAiTerminal, runLocalAiPrompt, stopAiRun, writeLocalAiRunnerConfig } from "./localAiRunner.js";
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
  OPERATION_ID_HEADER,
  readJson,
  requestOperationId,
  validOperationId
} from "./utils.js";

export function createRelayHttpServer(
  config: GatewayConfig,
  relay: RuntimeRelay,
  unityProjects = new UnityProjectRegistry(),
  cleanupRuntime = getCleanupRuntime(),
  logging = getLoggingRuntime()
) {
  const mcpEndpoint = new RelayMcpHttpEndpoint(relay);
  const httpLogger = logging.logger("http-server");
  const unityLogCollector = new UnityLogCollector(logging);
  const server = createServer(async (request, response) => {
    const method = request.method || "";
    const url = request.url || "/";
    const operationId = requestOperationId(request);
    response.setHeader(OPERATION_ID_HEADER, operationId);
    const requestScope = httpLogger.startOperation("http.request", `${method || "UNKNOWN"} ${url}`, {
      operationId,
      data: { method, url }
    });
    response.once("finish", () => {
      if (requestScope.completed) {
        return;
      }
      const data = { method, url, status: response.statusCode };
      if (response.statusCode < 400) {
        requestScope.succeed("HTTP 请求完成", data);
      } else {
        requestScope.fail(new Error(`HTTP ${response.statusCode}`), "HTTP 请求失败", data);
      }
    });
    response.once("close", () => {
      if (!requestScope.completed) {
        requestScope.cancel("HTTP 连接在响应完成前关闭", { method, url });
      }
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
      if (request.method === "GET" && await handleLogGet(
        logging,
        unityLogCollector,
        unityProjects,
        operationId,
        requestUrl,
        response,
      )) {
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/logs/events") {
        if (!isFigmaPluginRequest(request) && !isInternalRelayRequest(request)) {
          jsonResponse(response, 403, { error: "log ingestion requires a Figma or internal runtime request" });
          return;
        }
        const payload = await readJson(request);
        if (!isRecord(payload) || !Array.isArray(payload.events)) {
          jsonResponse(response, 400, { error: "events must be an array" });
          return;
        }
        try {
          const accepted = logging.store.ingest(payload.events);
          jsonResponse(response, 202, { accepted: accepted.length });
        } catch (error) {
          jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (requestUrl.pathname === config.mcpPath && ["GET", "POST", "DELETE"].includes(request.method || "")) {
        await mcpEndpoint.handleRequest(request, response);
        return;
      }
      if (request.method === "GET") {
        await handleGet(config, relay, unityProjects, cleanupRuntime, request, requestUrl, response);
        return;
      }
      if (request.method === "POST") {
        if (isPrivateRuntimePostPath(requestUrl.pathname) && !isRuntimeRelayRequest(request, response)) {
          return;
        }
        const payload = await readJson(request);
        if (isRecord(payload) && !validOperationId(payload.operationId)) {
          payload.operationId = operationId;
        }
        await handlePost(config, relay, unityProjects, cleanupRuntime, request, requestUrl, payload, response);
        return;
      }
      jsonResponse(response, 405, { error: "method not allowed" });
    } catch (error) {
      requestScope.fail(error, "HTTP 请求处理异常", { method, url });
      logError("HTTP request failed", {
        method,
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!response.headersSent) {
        jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    }
  });
  server.once("close", () => mcpEndpoint.dispose());
  return server;
}

async function handleLogGet(
  logging: LoggingRuntime,
  unityLogCollector: UnityLogCollector,
  unityProjects: Pick<UnityProjectRegistry, "list">,
  operationId: string,
  requestUrl: URL,
  response: ServerResponse,
): Promise<boolean> {
  const pathname = requestUrl.pathname;
  if (pathname !== "/logs"
    && pathname !== "/log"
    && pathname !== "/logs/download"
    && !pathname.startsWith("/logs/operations/")) {
    return false;
  }
  let query: LogQuery;
  try {
    query = parseLogQuery(requestUrl.searchParams);
    const operationMatch = pathname.match(/^\/logs\/operations\/([^/]+)$/);
    if (operationMatch) {
      query.operationId = decodeURIComponent(operationMatch[1]);
    } else if (pathname.startsWith("/logs/operations/")) {
      throw new Error("invalid operation log path");
    }
  } catch (error) {
    jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  if (!query.source || query.source === "unity") {
    await unityLogCollector.collect(unityProjects, operationId);
  }
  const result = await logging.store.query(query);
  if (pathname === "/log") {
    jsonResponse(response, 200, { logs: result.events });
    return true;
  }
  if (pathname === "/logs/download") {
    const jsonl = result.events.map((event) => JSON.stringify(event)).join("\n");
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    response.writeHead(200, corsHeaders({
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="figma-mcp-relay-logs-${suffix}.jsonl"`,
    }));
    response.end(jsonl ? `${jsonl}\n` : "");
    return true;
  }
  jsonResponse(response, 200, result);
  return true;
}

function parseLogQuery(searchParams: URLSearchParams): LogQuery {
  const query: LogQuery = {};
  const level = optionalEnum(searchParams, "level", LogLevels);
  const source = optionalEnum(searchParams, "source", LogSources);
  const status = optionalEnum(searchParams, "status", LogStatuses);
  if (level) query.level = level;
  if (source) query.source = source;
  if (status) query.status = status;
  query.module = optionalText(searchParams, "module");
  query.operationId = optionalText(searchParams, "operationId");
  query.keyword = optionalText(searchParams, "keyword");
  query.from = optionalDate(searchParams, "from");
  query.to = optionalDate(searchParams, "to");
  query.cursor = optionalInteger(searchParams, "cursor", 0, Number.MAX_SAFE_INTEGER);
  query.limit = optionalInteger(searchParams, "limit", 1, 1_000);
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) as LogQuery;
}

function optionalEnum<const T extends readonly string[]>(
  searchParams: URLSearchParams,
  name: string,
  values: T,
): T[number] | undefined {
  const value = optionalText(searchParams, name);
  if (value === undefined) return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return value as T[number];
}

function optionalText(searchParams: URLSearchParams, name: string): string | undefined {
  const value = searchParams.get(name);
  return value === null || value.trim() === "" ? undefined : value.trim();
}

function optionalDate(searchParams: URLSearchParams, name: string): string | undefined {
  const value = optionalText(searchParams, name);
  if (value !== undefined && !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return value;
}

function optionalInteger(
  searchParams: URLSearchParams,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalText(searchParams, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return number;
}

async function handleGet(
  config: GatewayConfig,
  relay: RuntimeRelay,
  unityProjects: UnityProjectRegistry,
  cleanupRuntime: CleanupRuntime,
  request: IncomingMessage,
  requestUrl: URL,
  response: ServerResponse
): Promise<void> {
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
    return Promise.resolve();
  }
  if (pathname === "/ai-runner/providers") {
    jsonResponse(response, 200, { ok: true, providers: await cleanupRuntime.providers.list() });
    return;
  }
  if (pathname === "/ai-runner/status") {
    jsonResponse(response, 200, localAiRunnerStatus());
    return Promise.resolve();
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
    if (cleanupRuntime.controller.has(runMatch[1])) {
      respondWithCleanupAction(response, () => cleanupRuntime.controller.get(
        runMatch[1],
        cleanupCapability(request),
        Number.parseInt(requestUrl.searchParams.get("afterSequence") || "0", 10) || 0,
      ));
      return Promise.resolve();
    }
    try {
      const afterSequence = Number.parseInt(requestUrl.searchParams.get("afterSequence") || "0", 10) || 0;
      jsonResponse(response, 200, getAiRun(runMatch[1], String(request.headers["x-ai-run-capability"] || ""), afterSequence));
    } catch (error) {
      jsonResponse(response, 403, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return Promise.resolve();
  }
  const cleanupRunMatch = pathname.match(/^\/cleanup\/runs\/([^/]+)$/);
  if (cleanupRunMatch) {
    respondWithCleanupAction(response, () => cleanupRuntime.controller.get(
      cleanupRunMatch[1],
      cleanupCapability(request),
      Number.parseInt(requestUrl.searchParams.get("afterSequence") || "0", 10) || 0,
    ));
    return Promise.resolve();
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
  return Promise.resolve();
}

async function handlePost(
  config: GatewayConfig,
  relay: RuntimeRelay,
  unityProjects: UnityProjectRegistry,
  cleanupRuntime: CleanupRuntime,
  request: IncomingMessage,
  requestUrl: URL,
  payload: unknown,
  response: ServerResponse
): Promise<void> {
  const pathname = requestUrl.pathname;
  if (pathname === "/cleanup/runs") {
    if (!isRecord(payload) || !relay.hasLivePluginSession(payload.sessionId)) {
      jsonResponse(response, 403, { ok: false, error: "Cleanup actions require a live local Figma plugin session." });
      return;
    }
    try {
      await cleanupRuntime.providers.resolve(payload.providerId);
      const result = await cleanupRuntime.controller.start({
        sessionId: String(payload.sessionId || ""),
        providerId: cleanupProviderId(payload.providerId),
        snapshot: payload.snapshot as CleanupSnapshotV1,
        autoApprove: payload.autoApprove === true,
      });
      jsonResponse(response, 200, result);
    } catch (error) {
      cleanupErrorResponse(response, error);
    }
    return;
  }
  const cleanupAction = pathname.match(/^\/cleanup\/runs\/([^/]+)\/(approve|cancel|confirm-component-sets)$/);
  if (cleanupAction) {
    respondWithCleanupAction(response, () => {
      const token = cleanupCapability(request);
      if (cleanupAction[2] === "cancel") return cleanupRuntime.controller.cancel(cleanupAction[1], token);
      if (cleanupAction[2] === "confirm-component-sets") {
        if (!isRecord(payload)) throw new CleanupError("CLEANUP_REQUEST_INVALID", "ComponentSet confirmation body must be an object");
        return cleanupRuntime.controller.confirmComponentSets(cleanupAction[1], token, {
          satisfied: payload.satisfied === true,
          ...(typeof payload.feedback === "string" ? { feedback: payload.feedback } : {}),
        });
      }
      if (!isRecord(payload)) throw new CleanupError("CLEANUP_REQUEST_INVALID", "approval body must be an object");
      return cleanupRuntime.controller.approve(cleanupAction[1], token, {
        approval: payload.approval === true,
        snapshotHash: String(payload.snapshotHash || ""),
      });
    });
    return;
  }
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
  if (pathname === "/ai-runner/config" || pathname === "/ai-runner/open-terminal" || pathname === "/ai-runner/run-cleanup" || pathname === "/ai-runner/run-prompt" || /^\/ai-runner\/runs\/[^/]+\/(followup|stop)$/.test(pathname)) {
    const runAction = pathname.match(/^\/ai-runner\/runs\/([^/]+)\/(followup|stop)$/);
    if (runAction) {
      try {
        const token = String(request.headers["x-ai-run-capability"] || "");
        const result = runAction[2] === "followup" ? followupAiRun(runAction[1], token, payload) : stopAiRun(runAction[1], token);
        jsonResponse(response, 200, result);
      } catch (error) {
        jsonResponse(response, 403, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (!isRecord(payload) || !relay.hasLivePluginSession(payload.sessionId)) {
      jsonResponse(response, 403, { ok: false, error: "AI runner actions require a live local Figma plugin session." });
      return;
    }
    try {
      const result = pathname === "/ai-runner/config"
        ? writeLocalAiRunnerConfig(payload)
        : pathname === "/ai-runner/open-terminal"
          ? openLocalAiTerminal(payload)
        : pathname === "/ai-runner/run-cleanup"
          ? await startLegacyCleanup(cleanupRuntime, payload)
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
  // Route shape: /psd-to-figma/import/[^/]+/adopt-baseline
  const psdBaselineMatch = pathname.match(/^\/psd-to-figma\/import\/([^/]+)\/adopt-baseline$/);
  if (psdBaselineMatch) {
    const taskId = decodeURIComponent(psdBaselineMatch[1] || "");
    try {
      const task = adoptPsdImportBaseline(config, taskId, payload);
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

async function startLegacyCleanup(cleanupRuntime: CleanupRuntime, payload: Record<string, unknown>) {
  logWarn("Deprecated cleanup start endpoint used", { pathname: "/ai-runner/run-cleanup" });
  const configuredProvider = localAiRunnerStatus().config.runner === "claude" ? "claude-code" : "codex";
  const providerId = cleanupProviderId(payload.providerId || configuredProvider);
  await cleanupRuntime.providers.resolve(providerId);
  return await cleanupRuntime.controller.start({
    sessionId: String(payload.sessionId || ""),
    providerId,
    snapshot: payload.snapshot as CleanupSnapshotV1,
  });
}

function cleanupProviderId(value: unknown): "codex" | "claude-code" {
  if (value === "codex" || value === "claude-code") return value;
  throw new CleanupError("PROVIDER_UNAVAILABLE", `unknown planning provider: ${String(value || "missing")}`);
}

function cleanupCapability(request: IncomingMessage): string {
  return String(request.headers["x-ai-run-capability"] || "");
}

function respondWithCleanupAction(response: ServerResponse, action: () => unknown): void {
  try {
    jsonResponse(response, 200, action());
  } catch (error) {
    cleanupErrorResponse(response, error);
  }
}

function cleanupErrorResponse(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CleanupError ? error.code : undefined;
  const status = code === "CLEANUP_ALREADY_RUNNING"
    ? 409
    : code === "CLEANUP_CAPABILITY_INVALID"
      ? 403
      : code === "CLEANUP_RUN_NOT_FOUND"
        ? 404
        : 400;
  jsonResponse(response, status, { ok: false, ...(code ? { code } : {}), error: message });
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
