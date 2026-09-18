import { z } from "zod";

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_CLI_PATH = "/relay";
/** Unity Bridge 主动连入的路径（出站倒置的接收侧）。 */
export const UNITY_BRIDGE_PATH = "/unity";

const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

export const cliHelloSchema = z.object({
  type: z.literal("relay.hello"),
  role: z.literal("cli"),
  protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
  clientVersion: z.string(),
}).strict();

export const cliRequestSchema = z.object({
  type: z.literal("relay.request"),
  requestId: identifier,
  operationId: identifier,
  action: z.enum(["relay.sessions", "figma.selection", "figma.command", "relay.control", "task.status", "task.cancel", "task.wait"]),
  payload: z.object({
    target: z.object({
      sessionId: z.string().trim().min(1).max(256).optional(),
      fileKey: z.string().trim().min(1).max(256).optional(),
    }).strict().optional(),
    timeout: z.number().finite().min(0.1).max(120).default(15),
    detach: z.boolean().default(false),
    taskId: identifier.optional(),
    jobType: identifier.optional(),
    job: z.record(z.unknown()).optional(),
    assetPaths: z.record(z.string()).optional(),
    controlAction: identifier.optional(),
    controlPayload: z.record(z.unknown()).optional(),
  }).strict(),
}).strict();

export class RelayProtocolError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RelayProtocolError";
  }
}
