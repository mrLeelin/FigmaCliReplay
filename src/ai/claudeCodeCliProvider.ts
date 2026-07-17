import { isRecord } from "../utils.js";
import type { PlanningProvider } from "./planningProvider.js";

export const claudeCodeCliProvider: PlanningProvider = {
  id: "claude-code",
  label: "Claude Code",
  command: "claude",
  buildArgs(_workspace: string, prompt: string): string[] {
    return ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", prompt];
  },
  extractAssistantText(event: unknown): string {
    if (!isRecord(event)) return "";
    if (event.type === "result" && typeof event.result === "string") return event.result.trim();
    if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return "";
    return event.message.content
      .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => String((item as Record<string, unknown>).text).trim())
      .filter(Boolean)
      .join("\n");
  },
  isTerminalEvent(event: unknown): "completed" | "failed" | null {
    if (!isRecord(event) || event.type !== "result") return null;
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    return event.is_error === true || subtype.startsWith("error") ? "failed" : "completed";
  },
};

