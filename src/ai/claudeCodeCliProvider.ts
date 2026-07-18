import { isRecord } from "../utils.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { PlanningProvider } from "./planningProvider.js";

const logger = getLoggingRuntime().logger("claude-code-cli-provider");

export const claudeCodeCliProvider: PlanningProvider = {
  id: "claude-code",
  label: "Claude Code",
  command: "claude",
  buildArgs(_workspace: string, prompt?: string): string[] {
    const args = [
      "-p",
      ...(prompt === undefined ? ["--input-format", "stream-json"] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (prompt !== undefined) args.push(prompt);
    logger.debug("已构建 Claude Code CLI 安全参数", {
      step: "cli-spawn",
      argumentCount: args.length,
      promptViaStdin: prompt === undefined
    });
    return args;
  },
  buildStdin(prompt: string): string {
    return `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    })}\n`;
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
