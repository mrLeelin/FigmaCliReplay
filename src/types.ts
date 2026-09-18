export type JsonObject = Record<string, unknown>;

export interface RelayJob {
  requestId: string;
  operationId: string;
  job: JsonObject;
  assetPaths: Map<string, string>;
  targetSessionId?: string;
  targetFileKey?: string;
  requiredTransport?: "websocket";
  cancelRequestedAt?: number;
  cancelOutcome?: "running" | "unknown";
  deliveryState?: "waiting_reconnect" | "result_unknown";
  reconnectDeadline?: number;
  resultToken?: string;
  result?: JsonObject;
  delivered: boolean;
  inFlight: boolean;
  deliveredBy?: "websocket" | "polling";
  lastDispatchBy?: "websocket" | "polling";
  dispatchAttempts: number;
  lastDispatchedAt?: number;
  acknowledgedAt?: number;
  leaseExpiresAt?: number;
  lastDeliveryError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface PluginCommand {
  type: "command.request";
  id: string;
  requestId: string;
  operationId: string;
  job: JsonObject;
}

export interface PluginSessionTarget {
  sessionId?: string;
  fileKey?: string;
}

export interface PluginSessionStatus {
  connected: boolean;
  authenticated: boolean;
  capabilities: string[];
  sessionId?: string;
  fileKey?: string;
  fileName?: string;
  currentPageId?: string;
  currentPageName?: string;
  editorType?: string;
  lastHeartbeatAt?: string;
  queueLength: number;
}

export interface PluginGatewayStatus {
  connected: boolean;
  authenticated: boolean;
  activeSessionId?: string;
  sessions: PluginSessionStatus[];
  sessionCount: number;
}

export interface AlgorithmStatus {
  enabled: boolean;
  available: boolean;
  url: string;
  scriptExists: boolean;
  processRunning: boolean;
  error?: string;
}
