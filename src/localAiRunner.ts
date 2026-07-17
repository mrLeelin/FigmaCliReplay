import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { LOCAL_DIR, PLUGIN_ROOT } from "./config.js";
import {
  CleanupPlanMarker,
  extractCleanupPlan,
  toPipelineRootPlan,
  validateCleanupPlan,
  type CleanupPlanV1,
  type CleanupSnapshotV1,
} from "./cleanupPlan.js";
import { logInfo } from "./logger.js";
import { isRecord } from "./utils.js";
import { UnityProjectRegistry, type UnityProjectStatus } from "./unityProjectRegistry.js";

type RunnerKind = "codex" | "claude";
type RunStatus = "starting" | "running" | "completed" | "failed" | "cancelled";
type CleanupRunPhase = "planning" | "validating" | "awaiting-approval" | "applying" | "verifying";

interface RunnerConfig { runner: RunnerKind; command: string; workspace: string; }
interface OutputEntry { sequence: number; at: string; stream: "stdout" | "stderr" | "system"; text: string; }
interface AiRun {
  runId: string; capabilityToken: string; sessionId: string; config: RunnerConfig; runDir: string; taskFile: string;
  executionLog: string; status: RunStatus; child?: ChildProcessWithoutNullStreams; pid?: number; cliSessionId?: string;
  taskKind: string; taskJson: string; unityProject?: Readonly<UnityProjectStatus>; startedAt: string; endedAt?: string; exitCode?: number | null; output: OutputEntry[]; nextSequence: number; finalised: boolean;
  totalTimeout?: NodeJS.Timeout; idleTimeout?: NodeJS.Timeout;
  cleanupSnapshot?: CleanupSnapshotV1; cleanupPlan?: CleanupPlanV1; cleanupPlanPath?: string; cleanupPipelinePlanPath?: string;
  assistantText: string; phase?: CleanupRunPhase; planSummary?: CleanupPlanSummary; planReady: boolean;
}

export interface CleanupPlanSummary {
  groupCount: number;
  groups: Array<{ name: string; sourceNodeCount: number }>;
  componentCandidateCount: number;
  componentCandidates: Array<{ name: string; sourceNodeCount: number }>;
  warningCount: number;
  warnings: string[];
}

const CONFIG_PATH = path.join(LOCAL_DIR, "ai-runner.json");
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
  if (!isRecord(payload) || !isRecord(payload.snapshot) || typeof payload.sessionId !== "string") throw new Error("missing cleanup snapshot or sessionId");
  const cleanupSnapshot = payload.snapshot as CleanupSnapshotV1;
  return startLocalAiTask(payload.sessionId, "cleanup", buildCleanupPlanReviewTask(cleanupSnapshot), undefined, cleanupSnapshot);
}

export function cleanupPlanReviewRules() {
  return [
    "This initial turn is read-only: do not call tools or MCP, and do not invoke any cleanup apply/pipeline command or other Figma write.",
    "Use only the supplied snapshot. Do not spawn subagents, and finish PlanReview within 3 minutes.",
    "Group every root direct child exactly once, preserve global sibling order, and do not move descendants across parents.",
    "Preserve absolute bounds, masks, hidden nodes, image/nine-slice structure, and all PSD SharedPluginData identity.",
    "Report clear ComponentSet candidates separately; do not treat them as apply commands.",
    "Return exactly one marked JSON object and end the turn immediately.",
  ];
}

export function buildCleanupPlanReviewTask(snapshot: CleanupSnapshotV1): string {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes) || typeof snapshot.rootNodeId !== "string") {
    throw new Error("invalid cleanup snapshot");
  }
  return [
    "# Figma cleanup PlanReview",
    "",
    ...cleanupPlanReviewRules(),
    "Do not include prose before or after the marked JSON object.",
    "The JSON schema is:",
    '{"schemaVersion":1,"rootNodeId":"string","groups":[{"name":"string","parentNodeId":"rootNodeId","sourceNodeIds":["direct-child-id"],"preserveSiblingOrder":true}],"componentCandidates":[{"name":"string","sourceNodeIds":["snapshot-node-id"],"reason":"string"}],"warnings":["string"]}',
    "",
    CleanupPlanMarker,
    "<one JSON object>",
    "",
    "## Snapshot",
    JSON.stringify(snapshot),
  ].join("\n");
}

export function runLocalAiPrompt(payload: unknown) {
  if (!isRecord(payload) || typeof payload.sessionId !== "string") throw new Error("missing sessionId");
  const template = typeof payload.template === "string" ? payload.template.trim() : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!SupportedPromptTemplates.has(template)) throw new Error("unsupported AI prompt template");
  if (!prompt) throw new Error("AI prompt is required");
  const unityProject = resolveUnityProjectSnapshot(payload);
  const taskContent = [
    `# Figma AI task: ${template}`, "",
    "The user clicked the corresponding action in the Figma plugin and authorized this task to execute.",
    "Follow the prompt below, use the repository tools and skills it names, and preserve the CLI session for follow-up requests.", "",
    ...(unityProject ? ["## Unity project snapshot", "", "```json", JSON.stringify(unityProject, null, 2), "```", ""] : []),
    "## Task prompt", "", prompt
  ].join("\n");
  return startLocalAiTask(payload.sessionId, template, taskContent, unityProject);
}

export function resolveUnityProjectSnapshot(
  payload: unknown,
  registry = new UnityProjectRegistry()
): Readonly<UnityProjectStatus> | undefined {
  if (!isRecord(payload) || payload.template !== "unity") return undefined;
  const requested = isRecord(payload.unityProject) ? payload.unityProject : {};
  const projectId = typeof requested.id === "string" ? requested.id : "";
  if (!projectId) throw new Error("Unity task requires a registered project id");
  return Object.freeze({ ...registry.snapshot(projectId) });
}

function startLocalAiTask(
  sessionId: string,
  taskKind: string,
  taskContent: string,
  unityProject?: Readonly<UnityProjectStatus>,
  cleanupSnapshot?: CleanupSnapshotV1
) {
  const config = readConfig();
  if (!commandAvailable(config.command)) throw new Error(`local AI command is not available: ${config.command}`);
  const runId = `${taskKind}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const taskFile = path.join(runDir, "task.md");
  const taskJson = path.join(runDir, "task.json");
  fs.writeFileSync(taskFile, `\uFEFF${taskContent}`, "utf8");
  fs.writeFileSync(taskJson, `${JSON.stringify({ schemaVersion: 1, taskKind, unityProject: unityProject || null, cleanupSnapshot: cleanupSnapshot || null }, null, 2)}\n`, "utf8");
  const run: AiRun = {
    runId, capabilityToken: randomBytes(32).toString("base64url"), sessionId, config, runDir, taskFile, taskJson, unityProject, cleanupSnapshot,
    executionLog: path.join(runDir, "execution.log"), status: "starting", taskKind, startedAt: new Date().toISOString(), output: [], nextSequence: 1, finalised: false,
    assistantText: "", phase: taskKind === "cleanup" ? "planning" : undefined, planReady: false
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
    phase: run.phase, planReady: run.planReady, planSummary: run.planSummary,
    output: run.output.filter((entry) => entry.sequence > afterSequence).slice(0, 200), logPath: run.executionLog
  };
}

export function followupAiRun(runId: string, capabilityToken: string, payload: unknown) {
  const run = authorisedRun(runId, capabilityToken);
  if (run.taskKind === "cleanup") {
    validateCleanupApprovalState(run, payload);
    if (!run.cleanupSnapshot || !run.cleanupPipelinePlanPath || !fs.existsSync(run.cleanupPipelinePlanPath)) {
      throw new Error("validated cleanup plan file is missing");
    }
    const prompt = buildCleanupApplyInstruction({
      pluginRoot: PLUGIN_ROOT,
      rootNodeId: run.cleanupSnapshot.rootNodeId,
      sessionId: run.sessionId,
      pipelinePlanPath: run.cleanupPipelinePlanPath,
      runDir: run.runDir,
    });
    run.status = "starting"; run.finalised = false; run.endedAt = undefined; run.exitCode = undefined;
    run.phase = "applying"; run.assistantText = "";
    startTurn(run, prompt, true);
    return { ok: true, runId, status: run.status, phase: run.phase };
  }
  const text = isRecord(payload) ? payload.text : payload;
  const prompt = typeof text === "string" ? text.trim() : "";
  if (!prompt) throw new Error("follow-up text is required");
  if (run.status !== "completed" && run.status !== "failed") throw new Error("follow-up is available only after the current turn stops");
  if (!run.cliSessionId) throw new Error("the current CLI did not return a resumable session id");
  run.status = "starting"; run.finalised = false; run.endedAt = undefined; run.exitCode = undefined;
  startTurn(run, prompt, true);
  return { ok: true, runId, status: run.status };
}

export function validateCleanupApprovalState(state: unknown, payload: unknown): void {
  if (!isRecord(payload) || payload.approval !== true) throw new Error("explicit cleanup approval is required");
  if (!isRecord(state) || state.status !== "completed") throw new Error("cleanup approval requires a completed PlanReview");
  if (state.phase !== "awaiting-approval") throw new Error("cleanup PlanReview is not awaiting approval");
  if (state.planReady !== true || typeof state.cleanupPipelinePlanPath !== "string" || !state.cleanupPipelinePlanPath) {
    throw new Error("validated cleanup plan is required");
  }
  if (typeof state.cliSessionId !== "string" || !state.cliSessionId) throw new Error("cleanup approval requires a resumable CLI session");
}

export function buildCleanupApplyInstruction(options: {
  pluginRoot: string;
  rootNodeId: string;
  sessionId: string;
  pipelinePlanPath: string;
  runDir: string;
}): string {
  const skillPath = path.join(options.pluginRoot, "ai", "skills", "figma-hierarchy-cleanup-mcp", "SKILL.md");
  const scriptPath = path.join(options.pluginRoot, "ai", "skills", "figma-hierarchy-cleanup-mcp", "scripts", "run_cleanup_pipeline.py");
  const workDir = path.join(options.runDir, "apply");
  const outputPath = path.join(options.runDir, "apply-report.json");
  const command = [
    "python", cleanupCommandQuote(scriptPath),
    "--node-id", cleanupCommandQuote(options.rootNodeId),
    "--session-id", cleanupCommandQuote(options.sessionId),
    "--plan", cleanupCommandQuote(options.pipelinePlanPath),
    "--work-dir", cleanupCommandQuote(workDir),
    "--output", cleanupCommandQuote(outputPath),
    "--apply-confirmed", "--auto-nested-generic", "--auto-component-sets",
  ].join(" ");
  return [
    `Read and obey this Skill for apply and verification only: \`${skillPath}\`.`,
    "The user explicitly approved the validated cleanup plan.",
    "Execute exactly the command below. Do not recompute, rewrite, or replace the root plan.",
    command,
    "Stop after the pipeline summary. Report validation or rollback failures without starting another plan turn.",
  ].join("\n");
}

function cleanupCommandQuote(value: string): string {
  return `"${String(value).replace(/"/g, '\\"')}"`;
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
  scheduleRunTimeouts(run);
  wireOutput(run, launched.stdout, "stdout"); wireOutput(run, launched.stderr, "stderr");
  launched.once("error", (error) => { appendOutput(run, "stderr", error.message); finalise(run, "failed", null); });
  launched.once("close", (code) => {
    if (!run.finalised) finishRunTurn(run, code === 0 ? "completed" : "failed", code);
  });
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
    if (run.taskKind === "cleanup" && stream === "stdout") {
      const assistantText = captureCleanupAssistantText(run.config.runner, event);
      if (assistantText) run.assistantText = assistantText;
    }
    if (run.config.runner === "claude" && stream === "stdout") {
      formatClaudeStreamEvent(event).forEach((text) => appendOutput(run, stream, text));
      const terminalStatus = classifyClaudeTerminalEvent(event);
      if (terminalStatus) finishTerminalStreamEvent(run, terminalStatus);
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

export function classifyClaudeTerminalEvent(value: unknown): "completed" | "failed" | null {
  if (!isRecord(value) || value.type !== "result") return null;
  const subtype = typeof value.subtype === "string" ? value.subtype : "";
  return value.is_error === true || subtype.startsWith("error") ? "failed" : "completed";
}

export function captureCleanupAssistantText(runner: RunnerKind, value: unknown): string {
  if (!isRecord(value)) return "";
  if (runner === "claude") {
    if (value.type === "result" && typeof value.result === "string") return value.result.trim();
    if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) return "";
    return value.message.content
      .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => String((item as Record<string, unknown>).text).trim())
      .filter(Boolean)
      .join("\n");
  }
  if (value.type !== "item.completed" || !isRecord(value.item) || value.item.type !== "agent_message") return "";
  return typeof value.item.text === "string" ? value.item.text.trim() : "";
}

export function persistValidatedCleanupPlanOutput(assistantText: string, snapshot: CleanupSnapshotV1, runDir: string) {
  const plan = validateCleanupPlan(extractCleanupPlan(assistantText), snapshot);
  const pipelinePlan = toPipelineRootPlan(plan, snapshot);
  const planPath = path.join(runDir, "cleanup-plan.json");
  const pipelinePlanPath = path.join(runDir, "cleanup-pipeline-plan.json");
  const summary = buildCleanupPlanSummary(plan);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  fs.writeFileSync(pipelinePlanPath, `${JSON.stringify(pipelinePlan, null, 2)}\n`, "utf8");
  return { planReady: true as const, plan, planPath, pipelinePlanPath, summary };
}

function buildCleanupPlanSummary(plan: CleanupPlanV1): CleanupPlanSummary {
  return {
    groupCount: plan.groups.length,
    groups: plan.groups.map((group) => ({ name: group.name, sourceNodeCount: group.sourceNodeIds.length })),
    componentCandidateCount: plan.componentCandidates.length,
    componentCandidates: plan.componentCandidates.map((candidate) => ({ name: candidate.name, sourceNodeCount: candidate.sourceNodeIds.length })),
    warningCount: plan.warnings.length,
    warnings: [...plan.warnings],
  };
}

export function localAiTimeoutPolicy(taskKind: string) {
  return taskKind === "cleanup"
    ? { totalMs: 5 * 60 * 1000, idleMs: 90 * 1000 }
    : { totalMs: 30 * 60 * 1000, idleMs: 5 * 60 * 1000 };
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
  if (run.taskKind === "cleanup" && run.phase === "applying") {
    run.phase = cleanupApplyPhaseForOutput(text, run.phase);
  }
  const entry = { sequence: run.nextSequence++, at: new Date().toISOString(), stream, text };
  run.output.push(entry); if (run.output.length > MaxOutputEntries) run.output.splice(0, run.output.length - MaxOutputEntries);
  fs.appendFileSync(run.executionLog, `${entry.at} [${stream}] ${text}\n`, "utf8");
  if (!run.finalised && (run.status === "starting" || run.status === "running")) resetIdleTimeout(run);
}

export function cleanupApplyPhaseForOutput(text: string, current: "applying" | "verifying"): "applying" | "verifying" {
  if (current === "verifying") return current;
  return /\[SUMMARY_JSON\]|\bverif(?:y|ying|ication)\b|验证(?:中|结果|层级|整理)?/i.test(text)
    ? "verifying"
    : "applying";
}
function finalise(run: AiRun, status: RunStatus, code: number | null) {
  if (run.finalised) return;
  clearRunTimeouts(run);
  run.finalised = true; run.status = status; run.exitCode = code; run.endedAt = new Date().toISOString(); run.child = undefined;
  appendOutput(run, "system", `Turn ${status}${code === null ? "" : ` (exit ${code})`}.`);
}
function finishTerminalStreamEvent(run: AiRun, status: "completed" | "failed") {
  if (run.finalised) return;
  finishRunTurn(run, status, status === "completed" ? 0 : 1);
}
function finishRunTurn(run: AiRun, status: "completed" | "failed", code: number | null) {
  let finalStatus = status;
  if (status === "completed" && run.taskKind === "cleanup" && run.phase === "planning") {
    run.phase = "validating";
    try {
      if (!run.cleanupSnapshot) throw new Error("cleanup snapshot is missing from the run");
      const result = persistValidatedCleanupPlanOutput(run.assistantText, run.cleanupSnapshot, run.runDir);
      run.cleanupPlan = result.plan;
      run.cleanupPlanPath = result.planPath;
      run.cleanupPipelinePlanPath = result.pipelinePlanPath;
      run.planSummary = result.summary;
      run.planReady = true;
      run.phase = "awaiting-approval";
      appendOutput(run, "system", `Cleanup plan validated: ${result.summary.groupCount} groups, ${result.summary.componentCandidateCount} component candidates.`);
    } catch (error) {
      finalStatus = "failed";
      run.planReady = false;
      appendOutput(run, "stderr", `Cleanup plan validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  terminateChild(run);
  finalise(run, finalStatus, finalStatus === "completed" ? code : code === 0 ? 1 : code);
}
function scheduleRunTimeouts(run: AiRun) {
  clearRunTimeouts(run);
  const policy = localAiTimeoutPolicy(run.taskKind);
  run.totalTimeout = setTimeout(() => failTimedOutRun(run, `AI turn exceeded ${Math.round(policy.totalMs / 60000)} minutes.`), policy.totalMs);
  resetIdleTimeout(run);
}
function resetIdleTimeout(run: AiRun) {
  if (run.idleTimeout) clearTimeout(run.idleTimeout);
  const policy = localAiTimeoutPolicy(run.taskKind);
  run.idleTimeout = setTimeout(() => failTimedOutRun(run, `AI turn produced no output for ${Math.round(policy.idleMs / 1000)} seconds.`), policy.idleMs);
}
function failTimedOutRun(run: AiRun, reason: string) {
  if (run.finalised || (run.status !== "starting" && run.status !== "running")) return;
  appendOutput(run, "system", reason);
  terminateChild(run);
  finalise(run, "failed", null);
}
function clearRunTimeouts(run: AiRun) {
  if (run.totalTimeout) clearTimeout(run.totalTimeout);
  if (run.idleTimeout) clearTimeout(run.idleTimeout);
  run.totalTimeout = undefined;
  run.idleTimeout = undefined;
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
function preset(runner: RunnerKind): RunnerConfig { return runner === "claude" ? { runner, command: "claude", workspace: PLUGIN_ROOT } : { runner, command: "codex", workspace: PLUGIN_ROOT }; }
function commandAvailable(command: string) { return spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { windowsHide: true }).status === 0; }
function resolveRunnerCommand(command: string) { if (process.platform !== "win32" || path.extname(command)) return command; const result = spawnSync("where.exe", [command], { windowsHide: true }); const candidates = result.stdout?.toString().split(/\r?\n/).map((item) => item.trim()).filter(Boolean) || []; return candidates.find((item) => /\.(cmd|exe)$/i.test(item)) || command; }
function cmdQuote(value: string) { return `"${value.replaceAll("\"", "\"\"")}"`; }
