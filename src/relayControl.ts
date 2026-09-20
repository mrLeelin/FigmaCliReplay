import * as localAi from "./localAiRunner.js";
import type { CleanupRuntime } from "./cleanup/cleanupRuntime.js";
import type { CleanupSnapshotV1 } from "./cleanupPlan.js";
import type { RuntimeRelay } from "./runtimeRelay.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import { PLUGIN_ROOT } from "./config.js";
import { UnityLogCollector } from "./logging/unityLogCollector.js";
import { LogLevels, LogSources, LogStatuses, type LogQuery } from "./logging/logEvent.js";
import { UnityProjectRegistry } from "./unityProjectRegistry.js";
import { installUnityBridge } from "./unityBridgeInstaller.js";
import { callUnityBridge } from "./unityBridgeClient.js";
import { unityProjectKey, unitySessionStatus } from "./unitySessionRegistry.js";
import { isRecord } from "./utils.js";
import { resolveDroppedPrefabs } from "./prefabDropResolver.js";

/** Shared CLI and authenticated plugin controls; capability checks stay in the controllers. */
export function createRelayControlHandler(
  relay: Pick<RuntimeRelay, "status"> & Partial<Pick<RuntimeRelay, "algorithmControl">>,
  cleanup: CleanupRuntime,
  ai = localAi,
  unityProjects = new UnityProjectRegistry(),
  bridgeToken = "",
) {
  return async (action: string, payload: Record<string, unknown>, parentOperationId?: string): Promise<unknown> => {
    const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
    const token = typeof payload.capabilityToken === "string" ? payload.capabilityToken : "";
    const afterSequence = typeof payload.afterSequence === "number" && Number.isFinite(payload.afterSequence)
      ? Math.max(0, Math.trunc(payload.afterSequence)) : 0;
    const operation = getLoggingRuntime().logger("relay-control").startOperation("relay.control", "Execute Relay control", {
      operationId: parentOperationId,
      data: { action, runId },
    });
    try {
      operation.step("validate", "Validate control target and capability", { action, runId });
      const requiresLiveFigmaSession = [
        "psd.import.start",
        "psd.import.apply",
        "psd.import.adopt-baseline",
        "figma.prefab.start",
        "prefab.import.start",
        "image.crop",
        "ai.run.start",
        "ai.config",
        "ai.open-terminal",
        "cleanup.run.start",
      ].includes(action);
      if (requiresLiveFigmaSession) {
        const sessions = relay.status().plugin.sessions.filter((session) => session.authenticated
          && (!payload.sessionId || session.sessionId === payload.sessionId)
          && (!payload.fileKey || session.fileKey === payload.fileKey));
        if (sessions.length !== 1) throw new Error("Select exactly one live Figma session for this control action.");
        payload = { ...payload, sessionId: sessions[0].sessionId, fileKey: sessions[0].fileKey };
      }
      if ((action.startsWith("ai.run.") || action.startsWith("cleanup.run.")) && !action.endsWith(".start") && !runId) {
        throw new Error("Run id is required.");
      }
      let result: unknown;
      switch (action) {
        case "relay.status":
          result = { ...relay.status(), gateway: { pluginRoot: PLUGIN_ROOT } };
          break;
        case "logs.query": {
          const params = isRecord(payload.query) ? payload.query : {};
          const limit = params.limit === undefined ? 200 : Number(params.limit);
          const cursor = params.cursor === undefined ? undefined : Number(params.cursor);
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0))) throw new Error("Invalid log pagination");
          for (const [key, values] of Object.entries({ level: LogLevels, source: LogSources, status: LogStatuses })) {
            if (params[key] !== undefined && !(values as readonly string[]).includes(String(params[key]))) throw new Error("Invalid log " + key);
          }
          const query: LogQuery = { limit, cursor };
          for (const key of ["from", "to", "level", "source", "module", "status", "operationId", "keyword"] as const) {
            const value = params[key];
            if (value === undefined) continue;
            if (typeof value !== "string" || value.length > 2000) throw new Error("Invalid log " + key);
            if ((key === "from" || key === "to") && !Number.isFinite(Date.parse(value))) throw new Error("Invalid log " + key);
            Object.assign(query, { [key]: value });
          }
          if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new Error("Invalid log time range");
          if (!query.source || query.source === "unity") await new UnityLogCollector(getLoggingRuntime()).collect(unityProjects, operation.operationId);
          result = await getLoggingRuntime().store.query(query);
          break;
        }
        case "prefab.resolve-dropped": {
          if (typeof payload.projectId !== "string" || !payload.projectId) throw new Error("Explicit Unity project id is required");
          const project = unityProjects.snapshot(payload.projectId);
          result = resolveDroppedPrefabs({ files: payload.files, unityProjectPath: project.path });
          break;
        }
        case "unity.command":
        case "unity.command-status": {
          const id = typeof payload.id === "string" ? payload.id.trim() : "";
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error("Explicit Unity project id and stable requestId are required.");
          const project = unityProjects.snapshot(id);
          const command = typeof payload.action === "string" ? payload.action : "";
          const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 30000;
          if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error("Unity timeout must be between 100 and 120000 ms.");
          result = { ok: true, requestId, result: await callUnityBridge(project.path, command, isRecord(payload.body) ? payload.body : {}, {
            requestId, timeoutMs, operationId: operation.operationId, statusOnly: action === "unity.command-status",
            query: typeof payload.query === "string" ? payload.query : "",
          }) };
          break;
        }
        case "unity.projects.list": result = { ok: true, ...unityProjects.list() }; break;
        case "unity.projects.add": {
          const project = unityProjects.add(String(payload.path || ""));
          result = { ok: true, project, ...unityProjects.list() };
          break;
        }
        case "unity.projects.select":
        case "unity.projects.remove":
        case "unity.bridge.install":
        case "unity.gateway.get": {
          const id = typeof payload.id === "string" ? payload.id.trim() : "";
          if (!id) throw new Error("An explicit Unity project id is required.");
          const existing = unityProjects.list().projects.find((project) => project.id === id);
          if (!existing) throw new Error("Unknown Unity project.");
          if (action === "unity.gateway.get") {
            // 只有出站会话一种形态：没有会话就是未连接（不再读取发现文件）。
            const key = unityProjectKey(existing.path);
            const session = existing.valid
              ? unitySessionStatus().find((item) => unityProjectKey(item.projectPath) === key)
              : undefined;
            result = session
              ? {
                  found: true,
                  transport: "inbound",
                  gatewayUrl: "relay-session://inbound",
                  projectPath: session.projectPath,
                  clientVersion: session.clientVersion,
                  updatedAtUtc: session.lastHeartbeatAt
                }
              : { found: false };
          }
          else if (action === "unity.projects.remove") {
            unityProjects.remove(id);
            result = { ok: true, ...unityProjects.list() };
          } else if (action === "unity.projects.select") {
            const project = unityProjects.select(id);
            result = { ok: true, project, ...unityProjects.list() };
          } else {
            const selected = unityProjects.snapshot(id);
            const installResult = installUnityBridge(selected.path, undefined, bridgeToken);
            const project = unityProjects.add(selected.path);
            result = { ok: true, installResult, project, ...unityProjects.list() };
          }
          break;
        }
        case "psd.import.start":
        case "psd.import.get":
        case "psd.import.cancel":
        case "psd.import.apply":
        case "psd.import.adopt-baseline":
        case "image.crop":
        case "plugin.open-folder":
        case "prefab.import.start":
        case "figma.prefab.start":
        case "figma.prefab.get":
        case "prefab.import.get": {
          if (!relay.algorithmControl) throw new Error("Algorithm control is unavailable.");
          result = await relay.algorithmControl(action, payload, unityProjects);
          break;
        }
        case "ai.providers": result = { ok: true, providers: await cleanup.providers.list() }; break;
        case "ai.status": result = ai.localAiRunnerStatus(); break;
        case "ai.config": result = ai.writeLocalAiRunnerConfig(payload); break;
        case "ai.open-terminal": result = await ai.openLocalAiTerminal(payload); break;
        case "ai.run.start": result = ai.runLocalAiPrompt(payload); break;
        case "ai.run.get": result = cleanup.controller.has(runId) ? cleanup.controller.get(runId, token, afterSequence) : ai.getAiRun(runId, token, afterSequence); break;
        case "ai.run.followup": result = ai.followupAiRun(runId, token, payload); break;
        case "ai.run.stop": result = ai.stopAiRun(runId, token); break;
        case "cleanup.run.start": {
          if (payload.providerId !== "codex" && payload.providerId !== "claude-code") throw new Error("Unknown planning provider.");
          await cleanup.providers.resolve(payload.providerId);
          result = await cleanup.controller.start({ sessionId: String(payload.sessionId), providerId: payload.providerId, snapshot: payload.snapshot as CleanupSnapshotV1, autoApprove: payload.autoApprove === true });
          break;
        }
        case "cleanup.run.get": result = cleanup.controller.get(runId, token, afterSequence); break;
        case "cleanup.run.approve": result = cleanup.controller.approve(runId, token, { approval: payload.approval === true, snapshotHash: String(payload.snapshotHash || "") }); break;
        case "cleanup.run.cancel": result = cleanup.controller.cancel(runId, token); break;
        case "cleanup.run.confirm-component-sets": result = cleanup.controller.confirmComponentSets(runId, token, { satisfied: payload.satisfied === true, ...(typeof payload.feedback === "string" ? { feedback: payload.feedback } : {}) }); break;
        default: throw new Error(`Unsupported Relay control action: ${action}`);
      }
      operation.succeed("Relay control completed", { action, runId });
      return result;
    } catch (error) {
      operation.fail(error, "Relay control rejected", { action, runId });
      throw error;
    }
  };
}
