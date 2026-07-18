param(
    [string]$GatewayUrl = "http://127.0.0.1:32130"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $ScriptDir
$nodeScript = @'
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket } = require("ws");

const baseUrl = (process.argv[2] || "http://127.0.0.1:32130").replace(/\/+$/, "");
const scriptDir = process.argv[3] || process.cwd();
const mcpUrl = `${baseUrl}/mcp`;

function log(message) {
  console.log(`[SMOKE] ${message}`);
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "x-figma-mcp-relay-internal": "plugin-runtime",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let json;
  if (text.trim()) {
    json = JSON.parse(text);
  }
  return { response, text, json };
}

async function rpc(id, method, params, sessionId = "") {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream"
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = "2025-11-25";
  }
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const text = await response.text();
  const json = text.trim() ? JSON.parse(text) : undefined;
  return {
    response,
    json,
    sessionId: response.headers.get("mcp-session-id") || ""
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function openPluginSession(base, sessionId, fileKey) {
  return new Promise((resolve, reject) => {
    const wsUrl = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/figma";
    const socket = new WebSocket(wsUrl, { origin: "https://www.figma.com" });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`timeout opening websocket session ${sessionId}`));
    }, 5000);
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "plugin.register",
        sessionId,
        figma: {
          fileKey,
          fileName: `${fileKey}.fig`,
          currentPageId: "0:1",
          currentPageName: "Smoke",
          editorType: "figma"
        }
      }));
      socket.send(JSON.stringify({
        type: "plugin.heartbeat",
        figma: { fileKey, currentPageId: "0:1", currentPageName: "Smoke" }
      }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "plugin.registered") {
        clearTimeout(timeout);
        resolve(socket);
        return;
      }
      if (message.type === "command.request") {
        socket.emit("relay-command", message);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForCommand(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("relay-command", onCommand);
      reject(new Error("timeout waiting for websocket command"));
    }, 5000);
    function onCommand(message) {
      clearTimeout(timeout);
      socket.off("relay-command", onCommand);
      resolve(message);
    }
    socket.on("relay-command", onCommand);
  });
}

async function postPluginResult(requestId, result) {
  const response = await requestJson("/figma/result", {
    method: "POST",
    body: JSON.stringify({ requestId, result })
  });
  assert(response.response.status === 200, `plugin result status=${response.response.status}`);
}

(async () => {
  log("health");
  const health = await requestJson("/health");
  assert(health.response.status === 200, `health status=${health.response.status}`);
  assert(health.json && health.json.mode === "node-gateway", "unexpected gateway mode");

  log("MCP initialize");
  const init = await rpc(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "figma-relay-smoke", version: "0.1.0" }
  });
  assert(init.response.status === 200, `initialize status=${init.response.status}`);
  assert(init.sessionId, "MCP initialize did not return mcp-session-id");
  assert(init.json.result.serverInfo.name === "figmaMcpRelay", "unexpected server name");

  log("MCP tools/list");
  const tools = await rpc(2, "tools/list", {}, init.sessionId);
  assert(tools.response.status === 200, `tools/list status=${tools.response.status}`);
  const toolNames = tools.json.result.tools.map((tool) => tool.name);
  assert(toolNames.includes("figma_health"), "figma_health tool missing");
  for (const name of ["figma_query_pages", "figma_resize_node", "figma_delete_node"]) {
    assert(toolNames.includes(name), `${name} tool missing`);
  }

  log("MCP figma_health");
  const healthTool = await rpc(3, "tools/call", { name: "figma_health", arguments: {} }, init.sessionId);
  assert(healthTool.response.status === 200, `figma_health status=${healthTool.response.status}`);
  assert(!healthTool.json.result.isError, "figma_health returned error");

  log("MCP rejects no-session non-initialize");
  const noSession = await rpc(4, "tools/list", {});
  assert(noSession.response.status === 400, `no-session tools/list status=${noSession.response.status}`);

  log("bad Origin is rejected");
  const badOrigin = await requestJson("/health", { headers: { origin: "https://evil.example" } });
  assert(badOrigin.response.status === 403, `bad Origin status=${badOrigin.response.status}`);

  log("null Origin is allowed for Figma plugin sandbox");
  const nullOrigin = await requestJson("/health", { headers: { origin: "null" } });
  assert(nullOrigin.response.status === 200, `null Origin status=${nullOrigin.response.status}`);

  log("asset token isolation");
  const tokenFile = path.join(scriptDir, ".local", "admin-token.txt");
  if (fs.existsSync(tokenFile)) {
    const assetSubmit = await requestJson("/jobs", {
      method: "POST",
      body: JSON.stringify({
        requestId: `smoke-token-leak-check-${Date.now()}`,
        job: { type: "QUERY_PLUGIN_STATUS", assets: [{ id: "token" }] },
        assetPaths: { token: tokenFile }
      })
    });
    assert(assetSubmit.response.status >= 400 && assetSubmit.response.status < 500, `token asset path status=${assetSubmit.response.status}`);
  }

  log("websocket multi-session routing");
  const sessionA = await openPluginSession(baseUrl, "smoke-session-a", "smoke-file-a");
  const sessionB = await openPluginSession(baseUrl, "smoke-session-b", "smoke-file-b");
  try {
    const ambiguous = await requestJson("/jobs", {
      method: "POST",
      body: JSON.stringify({
        requestId: `smoke-ambiguous-${Date.now()}`,
        job: { type: "QUERY_PLUGIN_STATUS" }
      })
    });
    assert(ambiguous.response.status === 400, `ambiguous submit status=${ambiguous.response.status}`);

    const targetedId = `smoke-targeted-${Date.now()}`;
    const commandPromise = waitForCommand(sessionB);
    const targeted = await requestJson("/jobs", {
      method: "POST",
      body: JSON.stringify({
        requestId: targetedId,
        target: { fileKey: "smoke-file-b" },
        job: { type: "QUERY_PLUGIN_STATUS" }
      })
    });
    assert(targeted.response.status === 200, `targeted submit status=${targeted.response.status}`);
    assert(targeted.json.transport === "websocket", "targeted job did not use websocket");
    const command = await commandPromise;
    assert(command.requestId === targetedId, "targeted command reached wrong requestId");
    assert(command.job && command.job.type === "QUERY_PLUGIN_STATUS", "targeted command payload mismatch");
    sessionB.send(JSON.stringify({ type: "command.received", id: targetedId, requestId: targetedId }));
    sessionB.send(JSON.stringify({ type: "command.response", id: targetedId, requestId: targetedId, accepted: true }));

    log("MCP figma_resize_node routes to plugin job");
    const resizeCommandPromise = waitForCommand(sessionB);
    const resizeCallPromise = rpc(5, "tools/call", {
      name: "figma_resize_node",
      arguments: {
        target: { fileKey: "smoke-file-b" },
        nodeId: "1:2",
        width: 320,
        height: 180,
        timeout: 5
      }
    }, init.sessionId);
    const resizeCommand = await resizeCommandPromise;
    assert(resizeCommand.job && resizeCommand.job.type === "RESIZE_NODE", "resize command type mismatch");
    assert(resizeCommand.job.nodeId === "1:2", "resize nodeId mismatch");
    assert(resizeCommand.job.width === 320 && resizeCommand.job.height === 180, "resize dimensions mismatch");
    sessionB.send(JSON.stringify({ type: "command.received", id: resizeCommand.requestId, requestId: resizeCommand.requestId }));
    sessionB.send(JSON.stringify({ type: "command.response", id: resizeCommand.requestId, requestId: resizeCommand.requestId, accepted: true }));
    await postPluginResult(resizeCommand.requestId, {
      status: "completed",
      nodeId: "1:2",
      before: { width: 100, height: 100 },
      after: { width: 320, height: 180 }
    });
    const resizeCall = await resizeCallPromise;
    assert(resizeCall.response.status === 200, `resize tool status=${resizeCall.response.status}`);
    assert(!resizeCall.json.result.isError, "figma_resize_node returned error");
  } finally {
    sessionA.close();
    sessionB.close();
  }

  console.log("[OK] MCP smoke passed");
})().catch((error) => {
  console.error(`[FAIL] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
'@

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeScript))
node -e "eval(Buffer.from(process.argv[1], 'base64').toString('utf8'))" $encoded $GatewayUrl $PluginRoot
