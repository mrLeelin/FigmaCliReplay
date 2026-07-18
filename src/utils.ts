import { randomUUID, timingSafeEqual } from "node:crypto";
import { IncomingMessage, type RequestOptions, request as httpRequest, ServerResponse } from "node:http";

export const OPERATION_ID_HEADER = "x-operation-id";
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function makeRequestId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || randomUUID();
}

export function requestOperationId(request: IncomingMessage): string {
  const header = request.headers[OPERATION_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  return typeof candidate === "string" && OPERATION_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
}

export function validOperationId(value: unknown): string | undefined {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonResponse(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.writeHead(status, corsHeaders({ "content-type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(payload));
}

export function emptyResponse(response: ServerResponse, status: number): void {
  response.writeHead(status, corsHeaders());
  response.end();
}

export function corsHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Figma-Mcp-Relay-Token, X-Figma-Mcp-Relay-Internal, X-Operation-Id, X-AI-Run-Capability, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS"
  };
}

export function isAllowedLocalRequest(request: IncomingMessage): boolean {
  return isAllowedHostHeader(request.headers.host) && isAllowedOriginHeader(request.headers.origin);
}

export function isFigmaPluginRequest(request: IncomingMessage): boolean {
  const origin = headerFirst(request.headers.origin);
  if (!origin) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return [
    "figma.com",
    "www.figma.com",
    "desktop.figma.com"
  ].includes(parsed.hostname.toLowerCase());
}

export function isInternalRelayRequest(request: IncomingMessage): boolean {
  const value = request.headers["x-figma-mcp-relay-internal"];
  const text = Array.isArray(value) ? String(value[0] || "") : String(value || "");
  return text.toLowerCase() === "plugin-runtime";
}

export function localRequestSecurityState(request: IncomingMessage): {
  host: string;
  origin: string;
  hostAllowed: boolean;
  originAllowed: boolean;
} {
  const host = headerFirst(request.headers.host);
  const origin = headerFirst(request.headers.origin);
  return {
    host,
    origin,
    hostAllowed: isAllowedHostHeader(host),
    originAllowed: isAllowedOriginHeader(origin)
  };
}

function headerFirst(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function isAllowedHostHeader(value: string | string[] | undefined): boolean {
  const host = Array.isArray(value) ? value[0] : value;
  if (!host) {
    return true;
  }
  return isLocalHostname(hostnameFromUrlLike(`http://${host}`));
}

function isAllowedOriginHeader(value: string | string[] | undefined): boolean {
  const origin = Array.isArray(value) ? value[0] : value;
  if (!origin) {
    return true;
  }
  if (origin === "null") {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (isLocalHostname(parsed.hostname)) {
    return true;
  }
  return [
    "figma.com",
    "www.figma.com",
    "desktop.figma.com"
  ].includes(parsed.hostname.toLowerCase());
}

function hostnameFromUrlLike(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function isLocalHostname(value: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(value.toLowerCase());
}

export function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.toLowerCase().startsWith("bearer ")) {
    return value.slice("bearer ".length).trim();
  }
  const direct = request.headers["x-figma-mcp-relay-token"];
  return Array.isArray(direct) ? String(direct[0] || "") : String(direct || "");
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const text = await readBody(request);
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(stripBom(text));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HttpJsonResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  json?: unknown;
}

export function requestJson(
  targetUrl: URL,
  method: string,
  payload?: unknown,
  timeoutMs = 10_000
): Promise<HttpJsonResult> {
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), "utf8");
  const options: RequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method,
    timeout: timeoutMs,
    headers: body
      ? {
          "content-type": "application/json; charset=utf-8",
          "content-length": body.length
        }
      : undefined
  };

  return new Promise((resolve, reject) => {
    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        const result: HttpJsonResult = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: responseBody
        };
        const contentType = String(res.headers["content-type"] ?? "");
        if (responseBody.length > 0 && contentType.includes("application/json")) {
          try {
            result.json = JSON.parse(stripBom(responseBody.toString("utf8")));
          } catch {
            // Keep raw body when a compatibility endpoint returns malformed JSON.
          }
        }
        resolve(result);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`timeout requesting ${targetUrl.href}`));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}
