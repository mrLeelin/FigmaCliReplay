import { isRecord } from "../utils.js";
import type { PlanningProvider } from "./planningProvider.js";

export const codexCliProvider: PlanningProvider = {
  id: "codex",
  label: "Codex",
  command: "codex",
  buildArgs(workspace: string, prompt: string): string[] {
    return [
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
      prompt,
    ];
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

