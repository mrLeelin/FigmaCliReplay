import { isRecord } from "../utils.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { PlanningProvider } from "./planningProvider.js";

const logger = getLoggingRuntime().logger("codex-cli-provider");

export const codexCliProvider: PlanningProvider = {
  id: "codex",
  label: "Codex",
  command: "codex",
  buildArgs(workspace: string, prompt?: string): string[] {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--disable",
      "hooks",
      "-c",
      "mcp_servers.coplay-mcp.enabled=false",
      "-c",
      "mcp_servers.coplay_mcp.enabled=false",
      "--cd",
      workspace,
      prompt ?? "-",
    ];
    logger.debug("已构建 Codex CLI 安全参数", {
      step: "cli-spawn",
      argumentCount: args.length,
      promptViaStdin: prompt === undefined
    });
    return args;
  },
  buildStdin(prompt: string): string {
    return prompt;
  },
  extractAssistantText(event: unknown): string {
    if (!isRecord(event) || event.type !== "item.completed" || !isRecord(event.item) || event.item.type !== "agent_message") return "";
    return typeof event.item.text === "string" ? event.item.text.trim() : "";
  },
  isTerminalEvent(event: unknown): "completed" | "failed" | null {
    if (!isRecord(event) || typeof event.type !== "string") return null;
    if (event.type === "turn.completed" || event.type === "thread.completed") return "completed";
    if (event.type === "turn.failed" || event.type === "thread.failed" || event.type === "error") return "failed";
    return null;
  },
};
