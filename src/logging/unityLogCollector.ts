import type { LoggingRuntime } from "./loggingRuntime.js";
import type { UnityProjectRegistry, UnityProjectStatus } from "../unityProjectRegistry.js";
import { callUnityBridge } from "../unityBridgeClient.js";
import { hasUnitySession } from "../unitySessionRegistry.js";

interface UnityLogCollectorOptions {
  /** 仅测试用：覆盖"该工程是否已有 Unity 出站会话"的判断。 */
  connected?: (projectPath: string) => boolean;
  command?: typeof callUnityBridge;
  timeoutMs?: number;
  maxSeenEvents?: number;
}

interface UnityLogPayload {
  events?: unknown[];
}

export class UnityLogCollector {
  private readonly logger;
  private readonly connected;
  private readonly command;
  private readonly timeoutMs;
  private readonly maxSeenEvents;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(
    private readonly logging: LoggingRuntime,
    options: UnityLogCollectorOptions = {},
  ) {
    this.logger = logging.logger("unity-log-collector");
    this.connected = options.connected ?? hasUnitySession;
    this.command = options.command ?? callUnityBridge;
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.maxSeenEvents = options.maxSeenEvents ?? 10_000;
  }

  async collect(
    registry: Pick<UnityProjectRegistry, "list">,
    operationId: string,
  ): Promise<{ gateways: number; accepted: number }> {
    const operation = this.logger.startOperation("unity.logs-collect", "开始汇入 Unity Bridge 日志", {
      operationId,
    });
    let gateways = 0;
    let accepted = 0;
    try {
      const projects = registry.list().projects.filter((project) => project.valid);
      operation.step("discover", "正在发现 Unity Bridge 日志端点", { projectCount: projects.length });
      for (const project of projects) {
        const result = await this.collectProject(project, operationId);
        if (!result.found) continue;
        gateways += 1;
        accepted += result.accepted;
      }
      operation.succeed("Unity Bridge 日志汇入完成", { gateways, accepted });
      return { gateways, accepted };
    } catch (error) {
      operation.fail(error, "Unity Bridge 日志汇入失败", { gateways, accepted });
      return { gateways, accepted };
    }
  }

  private async collectProject(
    project: UnityProjectStatus,
    parentOperationId: string,
  ): Promise<{ found: boolean; accepted: number }> {
    if (!this.connected(project.path)) return { found: false, accepted: 0 };
    try {
      const payload: UnityLogPayload = await this.command(project.path, "unity.logs", {}, {
        operationId: parentOperationId, timeoutMs: this.timeoutMs, query: "limit=1000",
      });
      const events = Array.isArray(payload.events)
        ? payload.events.filter(isUnityEvent).filter((event) => !this.seen.has(eventKey(event)))
        : [];
      const accepted = this.logging.store.ingest(events);
      for (const event of accepted) this.remember(eventKey(event));
      this.logger.debug("Unity Bridge 日志批次已汇入", {
        projectId: project.id,
        received: Array.isArray(payload.events) ? payload.events.length : 0,
        accepted: accepted.length,
      }, { operationId: parentOperationId, operationName: "unity.logs-collect" });
      return { found: true, accepted: accepted.length };
    } catch (error) {
      this.logger.warn("Unity Bridge 日志端点暂不可用", {
        projectId: project.id,
        error: error instanceof Error ? error.message : String(error),
      }, { operationId: parentOperationId, operationName: "unity.logs-collect" });
      return { found: true, accepted: 0 };
    }
  }

  private remember(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > this.maxSeenEvents) {
      const removed = this.seenOrder.shift();
      if (removed) this.seen.delete(removed);
    }
  }
}

function isUnityEvent(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).source === "unity";
}

interface EventIdentity {
  timestamp?: unknown;
  source?: unknown;
  module?: unknown;
  operationId?: unknown;
  operationName?: unknown;
  step?: unknown;
  stepIndex?: unknown;
  status?: unknown;
  message?: unknown;
}

function eventKey(event: EventIdentity): string {
  return JSON.stringify([
    event.timestamp,
    event.source,
    event.module,
    event.operationId,
    event.operationName,
    event.step,
    event.stepIndex,
    event.status,
    event.message,
  ]);
}
