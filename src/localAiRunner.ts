import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { PLUGIN_ROOT, REPO_ROOT } from "./config.js";
import { logInfo } from "./logger.js";
import { isRecord } from "./utils.js";

type RunnerKind = "codex" | "claude";
type RunStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

interface RunnerConfig { runner: RunnerKind; command: string; workspace: string; }
interface OutputEntry { sequence: number; at: string; stream: "stdout" | "stderr" | "system"; text: string; }
interface AiRun {
  runId: string; capabilityToken: string; sessionId: string; config: RunnerConfig; runDir: string; taskFile: string;
  executionLog: string; status: RunStatus; child?: ChildProcessWithoutNullStreams; pid?: number; cliSessionId?: string;
  taskKind: string; startedAt: string; endedAt?: string; exitCode?: number | null; output: OutputEntry[]; nextSequence: number; finalised: boolean;
}

const CONFIG_PATH = path.join(REPO_ROOT, ".local", "ai-runner.json");
const RUNS_ROOT = path.join(PLUGIN_ROOT, ".tmp", "ai-runs");
const runs = new Map<string, AiRun>();
const MaxOutputEntries = 800;
const SupportedPromptTemplates = new Set(["unity", "componentVariants"]);

export function localAiRunnerStatus() {
  const config = readConfig();
  return { ok: true, config, available: commandAvailable(config.command) };
}

export function writeLocalAiRunnerConfig(payload: unknown) {
  const config = preset(runnerFrom(payload));
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { ok: true, config, available: commandAvailable(config.command) };
}

export function runLocalAiCleanup(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.selection) || typeof payload.sessionId !== "string") throw new Error("missing selection snapshot or sessionId");
  const skillPath = path.join(PLUGIN_ROOT, "ai", "skills", "figma-hierarchy-cleanup-mcp", "SKILL.md");
  const taskContent = [
    "# Figma automatic hierarchy cleanup task", "", `Read and obey this Skill first: \`${skillPath}\`.`,
    "Clicking the cleanup button starts PlanReview only; it is not permission to write to Figma.",
    "First analyze and present one complete final plan covering hierarchy grouping and expected automatic ComponentSet candidates.",
    "Wait for one explicit approval. Treat 满意了, 可以执行了, 整理完毕了, 可以了, 确认, and clear equivalents as that approval.",
    "After approval, continuously execute hierarchy apply -> verify -> AutoComponentSet -> verify without asking the user to repeat 打组变体. Pause only for ambiguity, verification failure, or duplicate-component risk.",
    "After this turn, preserve the CLI session for approval and follow-up requests.", "",
    "## Figma selection snapshot", "```json", JSON.stringify(payload.selection, null, 2), "```"
  ].join("\n");
  return startLocalAiTask(payload.sessionId, "cleanup", taskContent);
}

export function runLocalAiPrompt(payload: unknown) {
  if (!isRecord(payload) || typeof payload.sessionId !== "string") throw new Error("missing sessionId");
  const template = typeof payload.template === "string" ? payload.template.trim() : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!SupportedPromptTemplates.has(template)) throw new Error("unsupported AI prompt template");
  if (!prompt) throw new Error("AI prompt is required");
  const taskContent = [
    `# Figma AI task: ${template}`, "",
    "The user clicked the corresponding action in the Figma plugin and authorized this task to execute.",
    "Follow the prompt below, use the repository tools and skills it names, and preserve the CLI session for follow-up requests.", "",
    "## Task prompt", "", prompt
  ].join("\n");
  return startLocalAiTask(payload.sessionId, template, taskContent);
}

function startLocalAiTask(sessionId: string, taskKind: string, taskContent: string) {
  const config = readConfig();
  if (!commandAvailable(config.command)) throw new Error(`local AI command is not available: ${config.command}`);
  const runId = `${taskKind}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const taskFile = path.join(runDir, "task.md");
  fs.writeFileSync(taskFile, `\uFEFF${taskContent}`, "utf8");
  const run: AiRun = {
    runId, capabilityToken: randomBytes(32).toString("base64url"), sessionId, config, runDir, taskFile,
    executionLog: path.join(runDir, "execution.log"), status: "starting", taskKind, startedAt: new Date().toISOString(), output: [], nextSequence: 1, finalised: false
  };
  runs.set(runId, run);
  startTurn(run, taskInstruction(run), false);
  logInfo("Local AI task started", { runId, taskKind, runner: config.runner });
  return { ok: true, runId, capabilityToken: run.capabilityToken, runner: config.runner };
}

export function getAiRun(runId: string, capabilityToken: string, afterSequence: number) {
  const run = authorisedRun(runId, capabilityToken);
  return {
    ok: true, runId, runner: run.config.runner, status: run.status, cliSessionId: run.cliSessionId ? "available" : "pending",
    startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode, nextSequence: run.nextSequence,
    output: run.output.filter((entry) => entry.sequence > afterSequence).slice(0, 200), logPath: run.executionLog
  };
}

export function followupAiRun(runId: string, capabilityToken: string, text: unknown) {
  const run = authorisedRun(runId, capabilityToken);
  const prompt = typeof text === "string" ? text.trim() : "";
  if (!prompt) throw new Error("follow-up text is required");
  if (run.status !== "completed" && run.status !== "failed") throw new Error("follow-up is available only after the current turn stops");
  if (!run.cliSessionId) throw new Error("the current CLI did not return a resumable session id");
  run.status = "starting"; run.finalised = false; run.endedAt = undefined; run.exitCode = undefined;
  startTurn(run, prompt, true);
  return { ok: true, runId, status: run.status };
}

export function stopAiRun(runId: string, capabilityToken: string) {
  const run = authorisedRun(runId, capabilityToken);
  stopRun(run, "Stop requested from the Figma plugin panel.");
  return { ok: true, runId, status: run.status };
}

export function stopAiRunsForSession(sessionId: string, reason: string) {
  let stopped = 0;
  for (const run of runs.values()) {
    if (run.sessionId !== sessionId || (run.status !== "starting" && run.status !== "running")) continue;
    if (stopRun(run, `Figma plugin session ended: ${reason}`)) stopped += 1;
  }
  if (stopped > 0) logInfo("Stopped local AI runs for disconnected Figma session", { sessionId, stopped, reason });
  return stopped;
}

function startTurn(run: AiRun, prompt: string, resume: boolean) {
  const command = resolveRunnerCommand(run.config.command);
  const args = commandArgs(run, prompt, resume);
  const launched = spawnCli(command, args, run.config.workspace);
  run.child = launched; run.pid = launched.pid; run.status = "running";
  appendOutput(run, "system", `${resume ? "Follow-up" : "Initial"} turn started with ${run.config.runner}.`);
  wireOutput(run, launched.stdout, "stdout"); wireOutput(run, launched.stderr, "stderr");
  launched.once("error", (error) => { appendOutput(run, "stderr", error.message); finalise(run, "failed", null); });
  launched.once("close", (code) => finalise(run, run.finalised ? run.status : code === 0 ? "completed" : "failed", code));
  launched.stdin.end();
}

function commandArgs(run: AiRun, prompt: string, resume: boolean): string[] {
  if (run.config.runner === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    // Unity quick-import has a fixed script pipeline. Claude's automatic Skill routing
    // spends minutes loading the broad skill before it reaches that pipeline.
    if (resume) args.push("--resume", run.cliSessionId!);
    args.push(prompt);
    // Claude parses --disallowedTools as a variadic option; it must be placed
    // after the positional prompt or it consumes the whole task text.
    if (run.taskKind === "unity" && !resume) args.push("--disallowedTools", "Skill,ToolSearch");
    return args;
  }
  const args = [
    "exec", "--json", "--full-auto",
    "--disable", "hooks",
    "-c", "mcp_servers.coplay-mcp.enabled=false",
    "-c", "mcp_servers.coplay_mcp.enabled=false",
    "--cd", run.config.workspace
  ];
  if (resume) args.push("resume", run.cliSessionId!);
  args.push(prompt); return args;
}

function taskInstruction(run: AiRun) { return `Read and obey the task file before acting: ${run.taskFile}. On Windows, read every UTF-8 text file with Get-Content -Encoding UTF8; never rely on the Windows PowerShell 5.1 default text encoding. The user started this task from Figma; follow the task file's authorization rules exactly.`; }
function spawnCli(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  if (process.platform === "win32" && /\.cmd$/i.test(command)) return spawn("cmd.exe", ["/d", "/s", "/c", `call ${cmdQuote(command)} ${args.map(cmdQuote).join(" ")}`], { cwd, env, stdio: "pipe", shell: false, windowsHide: true, windowsVerbatimArguments: true });
  return spawn(command, args, { cwd, env, stdio: "pipe", shell: false, windowsHide: true });
}
function wireOutput(run: AiRun, stream: NodeJS.ReadableStream, kind: "stdout" | "stderr") {
  let pending = "";
  stream.setEncoding("utf8"); stream.on("data", (chunk: string) => {
    pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop() || ""; lines.forEach((line) => consumeLine(run, kind, line));
  }); stream.on("end", () => { if (pending) consumeLine(run, kind, pending); });
}
function consumeLine(run: AiRun, stream: "stdout" | "stderr", line: string) {
  try {
    const event = JSON.parse(line);
    const id = findSessionId(event);
    if (id) run.cliSessionId = id;
    if (run.config.runner === "claude" && stream === "stdout") {
      formatClaudeStreamEvent(event).forEach((text) => appendOutput(run, stream, text));
      return;
    }
  } catch { /* plain CLI line */ }
  appendOutput(run, stream, line);
}

export function formatClaudeStreamEvent(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (value.type === "system" && value.subtype === "init") {
    const servers = Array.isArray(value.mcp_servers)
      ? value.mcp_servers
        .filter((server) => isRecord(server) && server.status === "connected" && typeof server.name === "string")
        .map((server) => String(server.name))
      : [];
    return [`Claude 会话已初始化${servers.length > 0 ? `；MCP：${servers.join("、")}。` : "。"}`];
  }
  if (value.type === "user" && isRecord(value.message) && Array.isArray(value.message.content)
    && value.message.content.some((item) => isRecord(item) && item.type === "tool_result")) {
    const summaries = value.message.content
      .filter((item) => isRecord(item) && item.type === "tool_result")
      .map((item) => formatClaudeToolResult(item))
      .filter(Boolean);
    return summaries.length > 0 ? summaries : ["工具已完成，正在进入下一步。"];
  }
  if (value.type === "result" && typeof value.result === "string" && value.result.trim()) {
    return [value.result.trim()];
  }
  if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) return [];
  const messages: string[] = [];
  for (const item of value.message.content) {
    if (!isRecord(item)) continue;
    if (item.type === "tool_use" && typeof item.name === "string") {
      messages.push(`调用工具：${item.name.replace(/^mcp__figmaMcpRelay__/, "")}`);
    } else if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      messages.push(item.text.trim());
    }
  }
  return messages;
}

function formatClaudeToolResult(item: Record<string, unknown>): string {
  const text = toolResultText(item.content);
  if (!text) return "工具已完成，正在进入下一步。";
  const summaryMatch = text.match(/\[SUMMARY_JSON\]\s*(\{[^\r\n]+\})/);
  if (summaryMatch) return `导入摘要：${summaryMatch[1]}`;
  const compact = text.replace(/\s+/g, " ").trim();
  return `工具完成：${compact.length > 600 ? `${compact.slice(0, 600)}…` : compact}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => isRecord(item) && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("\n");
}

function findSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["session_id", "sessionId", "thread_id", "threadId", "id"]) { if (typeof value[key] === "string" && /[a-z0-9-]{8,}/i.test(value[key] as string)) return value[key] as string; }
  for (const item of Object.values(value)) { const found = findSessionId(item); if (found) return found; } return undefined;
}
function appendOutput(run: AiRun, stream: OutputEntry["stream"], text: string) {
  const entry = { sequence: run.nextSequence++, at: new Date().toISOString(), stream, text };
  run.output.push(entry); if (run.output.length > MaxOutputEntries) run.output.splice(0, run.output.length - MaxOutputEntries);
  fs.appendFileSync(run.executionLog, `${entry.at} [${stream}] ${text}\n`, "utf8");
}
function finalise(run: AiRun, status: RunStatus, code: number | null) {
  if (run.finalised) return;
  run.finalised = true; run.status = status; run.exitCode = code; run.endedAt = new Date().toISOString(); run.child = undefined;
  appendOutput(run, "system", `Turn ${status}${code === null ? "" : ` (exit ${code})`}.`);
}
function authorisedRun(runId: string, token: string) { const run = runs.get(runId); if (!run || token !== run.capabilityToken) throw new Error("unknown run or invalid capability"); return run; }
function stopRun(run: AiRun, reason: string) {
  if (!run.child || (run.status !== "starting" && run.status !== "running")) return false;
  appendOutput(run, "system", reason);
  terminateChild(run);
  finalise(run, "cancelled", null);
  return true;
}
function terminateChild(run: AiRun) {
  if (process.platform === "win32" && run.pid) spawn("taskkill.exe", ["/PID", String(run.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else run.child?.kill();
}
function readConfig(): RunnerConfig { if (!fs.existsSync(CONFIG_PATH)) return preset("codex"); return preset(runnerFrom(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")))); }
function runnerFrom(value: unknown): RunnerKind { return isRecord(value) && value.runner === "claude" ? "claude" : "codex"; }
function preset(runner: RunnerKind): RunnerConfig { return runner === "claude" ? { runner, command: "claude", workspace: REPO_ROOT } : { runner, command: "codex", workspace: REPO_ROOT }; }
function commandAvailable(command: string) { return spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { windowsHide: true }).status === 0; }
function resolveRunnerCommand(command: string) { if (process.platform !== "win32" || path.extname(command)) return command; const result = spawnSync("where.exe", [command], { windowsHide: true }); const candidates = result.stdout?.toString().split(/\r?\n/).map((item) => item.trim()).filter(Boolean) || []; return candidates.find((item) => /\.(cmd|exe)$/i.test(item)) || command; }
function cmdQuote(value: string) { return `"${value.replaceAll("\"", "\"\"")}"`; }
