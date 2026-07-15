import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { logInfo, logWarn } from "./logger.js";
import { redactLargeRelayPayload, type RuntimeRelay } from "./runtimeRelay.js";
import type { JsonObject, JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { isRecord, readJson } from "./utils.js";

type ToolHandler = (args: JsonObject) => Promise<JsonObject>;

interface RelayToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  handler: ToolHandler;
}

interface McpSessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

const MCP_SESSION_TTL_MS = 30 * 60 * 1000;

export class RelayMcpHttpEndpoint {
  private readonly sessions = new Map<string, McpSessionEntry>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly relay: RuntimeRelay) {
    this.cleanupTimer = setInterval(() => void this.cleanupSessions(), 60_000);
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sessionId = this.header(request, "mcp-session-id");
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      response.writeHead(405).end();
      logWarn("MCP rejected unsupported method", { method: request.method || "" });
      return;
    }
    let parsedBody: unknown;
    const entry = sessionId
      ? this.sessions.get(sessionId)
      : await this.createSessionForRequest(request, response, (body) => {
          parsedBody = body;
        });
    if (!entry) {
      if (response.headersSent) {
        return;
      }
      response.writeHead(sessionId ? 404 : 400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: sessionId ? -32001 : -32000,
          message: sessionId
            ? "MCP session not found. Re-run initialize."
            : "Bad Request: No valid session ID provided."
        }
      }));
      logWarn("MCP request missing session", {
        method: request.method || "",
        hasSessionId: Boolean(sessionId)
      });
      return;
    }
    entry.lastSeenAt = Date.now();
    await entry.transport.handleRequest(request, response, parsedBody);
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const entry of this.sessions.values()) {
      void entry.server.close().catch(() => undefined);
    }
    this.sessions.clear();
  }

  private async createSession(): Promise<McpSessionEntry> {
    const provisionalId = randomUUID();
    let generatedSessionId = "";
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => {
        generatedSessionId = randomUUID();
        return generatedSessionId;
      },
      onsessioninitialized: (sessionId) => {
        const pending = this.sessions.get(provisionalId) ?? this.sessions.get(generatedSessionId);
        if (pending) {
          this.sessions.delete(provisionalId);
          if (generatedSessionId && generatedSessionId !== sessionId) {
            this.sessions.delete(generatedSessionId);
          }
          this.sessions.set(sessionId, pending);
          logInfo("MCP session initialized", { sessionId: shortId(sessionId) });
        }
      },
      onsessionclosed: (sessionId) => {
        const entry = this.sessions.get(sessionId);
        if (entry) {
          this.sessions.delete(sessionId);
          logInfo("MCP session closed", { sessionId: shortId(sessionId) });
          void entry.server.close().catch(() => undefined);
        }
      }
    });
    const server = createSdkServer(this.relay);
    const entry: McpSessionEntry = {
      server,
      transport,
      lastSeenAt: Date.now()
    };
    this.sessions.set(provisionalId, entry);
    await server.connect(transport);
    return entry;
  }

  private header(request: IncomingMessage, key: string): string {
    const value = request.headers[key.toLowerCase()];
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }

  private async createSessionForRequest(
    request: IncomingMessage,
    response: ServerResponse,
    onBody: (body: unknown) => void
  ): Promise<McpSessionEntry | undefined> {
    if (request.method !== "POST") {
      return undefined;
    }
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error"
        }
      }));
      return undefined;
    }
    onBody(body);
    if (!isInitializeRequest(body)) {
      logWarn("MCP first request was not initialize", {
        method: request.method || "",
        hasBody: body !== undefined
      });
      return undefined;
    }
    logInfo("MCP initialize request received");
    return this.createSession();
  }

  private async cleanupSessions(now = Date.now()): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastSeenAt <= MCP_SESSION_TTL_MS) {
        continue;
      }
      this.sessions.delete(sessionId);
      logInfo("MCP session expired", { sessionId: shortId(sessionId) });
      await entry.server.close().catch(() => undefined);
    }
  }
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(isInitializeRequest);
  }
  return isRecord(body) && body.method === "initialize";
}

export class RelayMcpServer {
  constructor(private readonly relay: RuntimeRelay) {}

  async handle(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(payload)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of payload) {
        if (isRecord(item)) {
          const response = await this.handleOne(item);
          if (response) {
            responses.push(response);
          }
        }
      }
      return responses;
    }
    if (!isRecord(payload)) {
      return this.error(null, -32600, "MCP JSON-RPC body must be object or array");
    }
    return this.handleOne(payload);
  }

  private async handleOne(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const id = request.id ?? null;
    const method = String(request.method ?? "");
    const params = isRecord(request.params) ? request.params : {};
    try {
      if (method === "initialize") {
        return this.response(id, {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });
      }
      if (method === "notifications/initialized") {
        return undefined;
      }
      if (method === "ping") {
        return this.response(id, {});
      }
      if (method === "tools/list") {
        return this.response(id, { tools: createRelayTools(this.relay).map(toLegacyTool) });
      }
      if (method === "tools/call") {
        const name = String(params.name ?? "");
        const args = isRecord(params.arguments) ? params.arguments : {};
        return this.response(id, await callRelayTool(this.relay, name, args));
      }
      if (method === "resources/list") {
        return this.response(id, { resources: [] });
      }
      if (method === "prompts/list") {
        return this.response(id, { prompts: [] });
      }
      return this.error(id, -32601, `unknown method: ${method}`);
    } catch (error) {
      return this.response(id, toolText({ error: errorMessage(error), method }, true));
    }
  }

  private response(id: unknown, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: unknown, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

export function toolText(payload: unknown, isError = false): JsonObject {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: isRecord(payload) ? payload : { value: payload },
    isError
  };
}

function createSdkServer(relay: RuntimeRelay): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: "Local Figma relay. Keep the Figma plugin panel open before calling plugin-backed tools."
    }
  );
  for (const tool of createRelayTools(relay)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations
      },
      async (args) => toCallToolResult(await tool.handler(args as JsonObject))
    );
  }
  return server;
}

function createRelayTools(relay: RuntimeRelay): RelayToolDefinition[] {
  return [
    {
      name: "figma_health",
      title: "Figma relay health",
      description: "Check the local Figma MCP Relay gateway, plugin sessions, and legacy backend health.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async () => toolText(relay.status())
    },
    {
      name: "figma_query_selection",
      title: "Query Figma selection",
      description: "Ask the connected Figma plugin for the current file, page, and selected nodes.",
      inputSchema: targetSchema.extend({ timeout: z.number().default(15).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "QUERY_SELECTION", args, Number(args.timeout ?? 15))
    },
    {
      name: "figma_query_plugin_status",
      title: "Query plugin status",
      description: "Ask the connected Figma plugin for build, file key, and current page status.",
      inputSchema: targetSchema.extend({ timeout: z.number().default(8).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "QUERY_PLUGIN_STATUS", args, Number(args.timeout ?? 8))
    },
    {
      name: "figma_query_node_children",
      title: "Query node children",
      description: "Read direct child metadata for a Figma node through the connected Figma plugin.",
      inputSchema: targetSchema.extend({
        nodeId: z.string().min(1),
        timeout: z.number().default(15).optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "QUERY_NODE_CHILDREN", args, Number(args.timeout ?? 15))
    },
    {
      name: "figma_query_components",
      title: "Query components",
      description: "Collect component metadata from library/root nodes inside the current Figma file.",
      inputSchema: targetSchema.extend({
        libraryNodeIds: z.array(z.string()).default(["62:115", "2896:32"]).optional(),
        timeout: z.number().default(20).optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "COLLECT_COMPONENTS", {
        ...args,
        libraryNodeIds: Array.isArray(args.libraryNodeIds) && args.libraryNodeIds.length > 0 ? args.libraryNodeIds : ["62:115", "2896:32"]
      }, Number(args.timeout ?? 20))
    },
    {
      name: "figma_analyze_repeat_clusters",
      title: "Analyze repeat clusters",
      description: "Read-only geometry/type clustering for repeated UI hierarchy candidates. Names, paths, and text characters are ignored for scoring.",
      inputSchema: targetSchema.extend({
        nodeId: z.string().min(1),
        includeHidden: z.boolean().default(false).optional(),
        maxDepth: z.number().default(4).optional(),
        confidenceThreshold: z.number().default(0.85).optional(),
        expectedXCount: z.number().default(7).optional(),
        expectedYCount: z.number().default(5).optional(),
        timeout: z.number().default(20).optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE", {
        ...args,
        target: { nodeId: String(args.nodeId || "") },
        options: {
          includeHidden: args.includeHidden === true,
          maxDepth: Number(args.maxDepth ?? 4),
          confidenceThreshold: Number(args.confidenceThreshold ?? 0.85),
          expectedXCount: Number(args.expectedXCount ?? 7),
          expectedYCount: Number(args.expectedYCount ?? 5)
        }
      }, Number(args.timeout ?? 20))
    },
    {
      name: "figma_query_pages",
      title: "Query Figma pages",
      description: "Read page ids and names from the connected Figma file.",
      inputSchema: targetSchema.extend({ timeout: z.number().default(10).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "QUERY_FIGMA_PAGES", args, Number(args.timeout ?? 10))
    },
    {
      name: "figma_set_context",
      title: "Set Figma page and selection",
      description: "Switch the connected Figma plugin to a page and optionally clear or set the current selection.",
      inputSchema: targetSchema.extend({
        pageId: z.string().optional(),
        pageName: z.string().optional(),
        clearSelection: z.boolean().default(true).optional(),
        selectionNodeIds: z.array(z.string()).optional(),
        timeout: z.number().default(15).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "SET_CONTEXT", args, Number(args.timeout ?? 15))
    },
    {
      name: "figma_resize_node",
      title: "Resize Figma node",
      description: "Resize a Figma node by id through the connected plugin.",
      inputSchema: targetSchema.extend({
        nodeId: z.string().min(1),
        width: z.number().positive(),
        height: z.number().positive(),
        timeout: z.number().default(15).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "RESIZE_NODE", args, Number(args.timeout ?? 15))
    },
    {
      name: "figma_delete_node",
      title: "Delete Figma node",
      description: "Delete a Figma node by id. The plugin refuses PAGE and DOCUMENT nodes.",
      inputSchema: targetSchema.extend({
        nodeId: z.string().min(1),
        timeout: z.number().default(15).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: async (args) => submitEndpointJob(relay, "DELETE_NODE_BY_ID", args, Number(args.timeout ?? 15))
    },
    {
      name: "figma_submit_job",
      title: "Submit raw relay job",
      description: "Submit a raw Figma MCP Relay job. Use target.sessionId or target.fileKey when multiple plugin sessions are open.",
      inputSchema: targetSchema.extend({
        job: z.record(z.unknown()),
        assetPaths: z.record(z.string()).default({}).optional(),
        requestId: z.string().default("").optional(),
        wait: z.boolean().default(false).optional(),
        fullResult: z.boolean().default(false).optional(),
        debugFullResult: z.boolean().default(false).optional(),
        timeout: z.number().default(60).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => {
        const job = args.job;
        if (!isRecord(job)) {
          throw new Error("figma_submit_job requires object argument: job");
        }
        const submitted = relay.submitJob({
          job,
          assetPaths: isRecord(args.assetPaths) ? args.assetPaths : {},
          requestId: typeof args.requestId === "string" ? args.requestId : "",
          target: targetFromArgs(args)
        });
        if (args.wait) {
          const result = wantsDebugFullResult(args)
            ? redactLargeRelayPayload(await relay.waitResult(String(submitted.requestId), Number(args.timeout ?? 60), 0.5))
            : await relay.waitResultCompact(String(submitted.requestId), Number(args.timeout ?? 60), 0.5);
          return toolText({ submitted, result });
        }
        return toolText(submitted);
      }
    },
    {
      name: "figma_wait_result",
      title: "Wait for relay job result",
      description: "Wait for a previously submitted Figma MCP Relay job result.",
      inputSchema: z.object({
        requestId: z.string().min(1),
        timeout: z.number().default(60).optional(),
        interval: z.number().default(0.5).optional(),
        fullResult: z.boolean().default(false).optional(),
        debugFullResult: z.boolean().default(false).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => toolText(wantsDebugFullResult(args)
        ? redactLargeRelayPayload(await relay.waitResult(
          String(args.requestId),
          Number(args.timeout ?? 60),
          Number(args.interval ?? 0.5)
        ))
        : await relay.waitResultCompact(
          String(args.requestId),
          Number(args.timeout ?? 60),
          Number(args.interval ?? 0.5)
        ))
    },
    {
      name: "figma_prefab_import_start",
      title: "Start prefab import",
      description: "Start the deterministic Unity UGUI Prefab to Figma import pipeline through the legacy local backend.",
      inputSchema: z.object({
        prefabPaths: z.array(z.string()).min(1),
        canvas: z.string().default("auto").optional(),
        canvasByPrefabPath: z.record(z.string()).default({}).optional(),
        componentMode: z.string().default("component").optional(),
        nestedPrefabComponentMode: z.string().default("all").optional(),
        figmaUrl: z.string().default("").optional(),
        fileKey: z.string().default("").optional(),
        targetNodeId: z.string().default("").optional()
      }).passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args) => {
        const result = await relay.legacyJson("/prefab-to-figma/import", "POST", args, 30_000);
        return toolText(result.json ?? { status: result.status, body: result.body.toString("utf8") }, result.status >= 400);
      }
    },
    {
      name: "figma_prefab_import_status",
      title: "Read prefab import status",
      description: "Read status for a deterministic Unity UGUI Prefab to Figma import task.",
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => {
        const result = await relay.legacyJson(
          `/prefab-to-figma/import/${encodeURIComponent(String(args.taskId))}/status`,
          "GET",
          undefined,
          10_000
        );
        return toolText(result.json ?? { status: result.status, body: result.body.toString("utf8") }, result.status >= 400);
      }
    }
  ];
}

const targetSchema = z.object({
  target: z.object({
    sessionId: z.string().optional(),
    fileKey: z.string().optional()
  }).optional(),
  sessionId: z.string().optional(),
  fileKey: z.string().optional()
});

async function callRelayTool(relay: RuntimeRelay, name: string, args: JsonObject): Promise<JsonObject> {
  const tool = createRelayTools(relay).find((item) => item.name === name);
  if (!tool) {
    logWarn("MCP unknown tool", { tool: name });
    return toolText({ error: `unknown tool: ${name}` }, true);
  }
  const startedAt = Date.now();
  logInfo("MCP tool call started", { tool: name });
  try {
    const result = await tool.handler(args);
    logInfo("MCP tool call completed", {
      tool: name,
      elapsedMs: Date.now() - startedAt,
      isError: result.isError === true
    });
    return result;
  } catch (error) {
    logWarn("MCP tool call failed", {
      tool: name,
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(error)
    });
    return toolText({ error: errorMessage(error), tool: name }, true);
  }
}

async function submitEndpointJob(
  relay: RuntimeRelay,
  type: string,
  args: JsonObject,
  timeout: number
): Promise<JsonObject> {
  const cleanJob = withoutRelayArgs(args);
  const submitted = relay.submitJob({
    job: { type, ...cleanJob },
    target: targetFromArgs(args)
  });
  const result = await relay.waitResult(String(submitted.requestId), timeout, 0.5);
  return toolText(result);
}

function targetFromArgs(args: JsonObject): JsonObject {
  const target = isRecord(args.target) ? args.target : {};
  const sessionId = stringValue(args.sessionId) || stringValue(target.sessionId);
  const fileKey = stringValue(args.fileKey) || stringValue(target.fileKey);
  return {
    sessionId,
    fileKey
  };
}

function withoutRelayArgs(args: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (["timeout", "target", "sessionId", "fileKey"].includes(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function wantsDebugFullResult(args: JsonObject): boolean {
  return args.fullResult === true && args.debugFullResult === true;
}

function toCallToolResult(payload: JsonObject): CallToolResult {
  const content = Array.isArray(payload.content)
    ? payload.content as CallToolResult["content"]
    : [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }];
  const result: CallToolResult = {
    content,
    isError: payload.isError === true
  };
  if (isRecord(payload.structuredContent)) {
    result.structuredContent = payload.structuredContent;
  }
  return result;
}

function toLegacyTool(tool: RelayToolDefinition): JsonObject {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema)
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}
