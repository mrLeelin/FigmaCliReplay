import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { claudeCodeCliProvider } from "./ai/claudeCodeCliProvider.js";
import { codexCliProvider } from "./ai/codexCliProvider.js";
import {
  CleanupConfirmationDecisionFileName,
  CleanupConfirmationPlanFileName,
  compileCleanupConfirmationPlanToV3,
  materializeCleanupConfirmationPlanArtifact,
  validateCleanupConfirmationPlanArtifact,
  type CleanupConfirmationPlanSummary,
} from "./cleanupConfirmationPlan.js";
import type { CleanupPlanV3, CleanupSnapshotV1 } from "./cleanupPlan.js";
import type { ConversationCleanupDispatcher } from "./cleanup/conversationCleanupDispatcher.js";
import {
  assertCleanupAiPhaseWriteEvidence,
  beginCleanupAiWriteGuard,
  endCleanupAiWriteGuard,
  setCleanupAiWritePhase,
  type CleanupAiWritePhase,
} from "./cleanupAiWriteGuard.js";
import { LOCAL_DIR, PLUGIN_ROOT } from "./config.js";
import { getLoggingRuntime } from "./logging/loggingRuntime.js";
import type { OperationScope } from "./logging/operationScope.js";
import { logInfo } from "./utils/logger.js";
import { isRecord } from "./utils.js";
import { UnityProjectRegistry, type UnityProjectStatus } from "./unityProjectRegistry.js";

type RunnerKind = "codex" | "claude";
type RunStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

interface RunnerConfig { runner: RunnerKind; command: string; workspace: string; }
interface OutputEntry { sequence: number; at: string; stream: "stdout" | "stderr" | "system"; text: string; }
interface FollowupRequestRecord { prompt: string; response: { ok: true; runId: string; status: RunStatus; clientRequestId: string; reused?: boolean }; }
interface AiRun {
  runId: string; capabilityToken: string; sessionId: string; config: RunnerConfig; runDir: string; taskFile: string; cleanupSnapshotFile?: string;
  executionLog: string; status: RunStatus; child?: ChildProcess; pid?: number; cliSessionId?: string;
  taskKind: string; taskJson: string; unityProject?: Readonly<UnityProjectStatus>; startedAt: string; endedAt?: string; exitCode?: number | null; output: OutputEntry[]; nextSequence: number; finalised: boolean;
  totalTimeout?: NodeJS.Timeout; idleTimeout?: NodeJS.Timeout;
  operation?: OperationScope; outputBytes: number;
  conversationTurn: number; relayClientFailureLogged: boolean;
  cleanupPhase?: CleanupAiWritePhase; cleanupSnapshot?: CleanupSnapshotV1; clientRequestId?: string;
  cleanupConfirmationPlanValidated: boolean; cleanupPlanRepairAttempts: number;
  cleanupConfirmationPlanSummary?: CleanupConfirmationPlanSummary;
  cleanupExecutionAbort?: AbortController;
  followupRequests: Map<string, FollowupRequestRecord>;
}

const CONFIG_PATH = path.join(LOCAL_DIR, "ai-runner.json");
const RUNS_ROOT = path.join(PLUGIN_ROOT, ".tmp", "ai-runs");
const CleanupSkillDirectory = path.join(PLUGIN_ROOT, "ai", "skills", "figma-hierarchy-cleanup-mcp");
const CleanupSkillFile = path.join(CleanupSkillDirectory, "SKILL.md");
const CleanupClientScript = path.join(CleanupSkillDirectory, "scripts", "figma_hierarchy_cleanup_mcp_client.py");
const CleanupPipelineScript = path.join(CleanupSkillDirectory, "scripts", "run_cleanup_pipeline.py");
const runs = new Map<string, AiRun>();
const MaxOutputEntries = 800;
const MaxCleanupPlanRepairAttempts = 3;
const SupportedPromptTemplates = new Set(["cleanup", "unity", "componentVariants"]);
const aiLogger = getLoggingRuntime().logger("local-ai-runner");
let cleanupDispatcher: ConversationCleanupDispatcher | undefined;

export function configureLocalAiCleanupDispatcher(dispatcher: ConversationCleanupDispatcher): void {
  cleanupDispatcher = dispatcher;
}

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

export function runLocalAiPrompt(payload: unknown) {
  if (!isRecord(payload) || typeof payload.sessionId !== "string") throw new Error("missing sessionId");
  const template = typeof payload.template === "string" ? payload.template.trim() : "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!SupportedPromptTemplates.has(template)) throw new Error("unsupported AI prompt template");
  if (!prompt) throw new Error("AI prompt is required");
  const unityProject = resolveUnityProjectSnapshot(payload);
  const cleanupSnapshot = template === "cleanup" ? cleanupSnapshotFrom(payload.cleanupSnapshot) : undefined;
  const requestedConfig = template === "cleanup" ? preset(runnerFrom(payload)) : undefined;
  const clientRequestId = typeof payload.clientRequestId === "string" ? payload.clientRequestId.trim() : "";
  if (template === "cleanup" && !clientRequestId) throw new Error("cleanup clientRequestId is required");
  const cleanupUserRequest = template === "cleanup" ? cleanupInitialUserRequest(prompt) : undefined;
  if (template === "cleanup") {
    logInfo("Cleanup prompt normalized", {
      template,
      sourceChars: prompt.length,
      normalizedChars: cleanupUserRequest!.length,
      embeddedPolicyRemoved: cleanupUserRequest !== prompt,
    });
  }
  const taskContent = template === "cleanup"
    ? buildCleanupConversationTask(cleanupUserRequest!, cleanupSnapshot)
    : [
    `# Figma AI task: ${template}`, "",
    "The user clicked the corresponding action in the Figma plugin and authorized this task to execute.",
    "Follow the prompt below, use the repository tools and skills it names, and preserve the CLI session for follow-up requests.", "",
    ...(unityProject ? ["## Unity project snapshot", "", "```json", JSON.stringify(unityProject, null, 2), "```", ""] : []),
    "## Task prompt", "", prompt
  ].join("\n");
  return startLocalAiTask(
    payload.sessionId,
    template,
    taskContent,
    unityProject,
    prompt.length,
    requestedConfig,
    cleanupSnapshot,
    clientRequestId,
  );
}

/**
 * Starts a user-visible, interactive local CLI window. This deliberately does
 * not create an AiRun: Relay cannot observe or authorize later terminal input.
 */
export async function openLocalAiTerminal(payload: unknown) {
  const request = isRecord(payload) ? payload : {};
  const template = typeof request.template === "string" ? request.template.trim() : "";
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  const runner = runnerFrom(request);
  const sessionId = typeof request.sessionId === "string" ? request.sessionId : "";
  const terminalId = `terminal-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const operation = aiLogger.startOperation("ai.terminal", "打开本地 AI 交互终端", {
    operationId: terminalId,
    data: { template, runner, sessionId, promptChars: prompt.length },
  });
  try {
    if (!sessionId) throw new Error("missing sessionId");
    if (!SupportedPromptTemplates.has(template)) throw new Error("unsupported AI prompt template");
    if (!prompt) throw new Error("AI prompt is required");
    const config = preset(runner);
    if (!commandAvailable(config.command)) throw new Error(`local AI command is not available: ${config.command}`);
    const unityProject = resolveUnityProjectSnapshot(payload);
    const taskContent = buildInteractiveTerminalTask(template, prompt, unityProject);
    const terminalDir = path.join(RUNS_ROOT, terminalId);
    const taskFile = path.join(terminalDir, "terminal-task.md");
    const pidFile = path.join(terminalDir, "terminal.pid");
    fs.mkdirSync(terminalDir, { recursive: true });
    fs.writeFileSync(taskFile, `\uFEFF${taskContent}`, "utf8");
    operation.step("task-persisted", "终端任务已保存为 UTF-8 文件", {
      template,
      runner: config.runner,
      fileName: path.basename(taskFile),
      taskChars: taskContent.length,
    });

    const command = resolveInteractiveRunnerCommand(config.command);
    const script = buildInteractivePowerShellScript(config.workspace, taskFile, pidFile, command);
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    operation.step("command-prepared", "已生成 PowerShell 交互启动命令", {
      runner: config.runner,
      command: path.basename(command),
      encoded: true,
      taskFile: path.basename(taskFile),
    });
    const pid = await launchInteractivePowerShell(config.workspace, encodedScript, pidFile);
    operation.step("powershell-started", "已启动可见的 PowerShell 交互窗口", {
      runner: config.runner,
      pid,
      taskFile: path.basename(taskFile),
    });
    operation.succeed("本地 AI 交互终端已启动", {
      runner: config.runner,
      pid,
      taskFile: path.basename(taskFile),
    });
    return { ok: true, runner: config.runner, taskFile, pid };
  } catch (error) {
    operation.fail(error, "打开本地 AI 交互终端失败", {
      template,
      runner,
      sessionId,
      promptChars: prompt.length,
    });
    throw error;
  }
}

function buildInteractiveTerminalTask(
  template: string,
  prompt: string,
  unityProject?: Readonly<UnityProjectStatus>,
): string {
  return [
    `# Figma AI task: ${template}`,
    "",
    "This task was explicitly handed to an interactive local AI terminal by the user.",
    "Read and follow the task prompt below. Keep the conversation in this terminal for any follow-up requests.",
    "The Figma MCP Relay at http://127.0.0.1:32130 is an externally managed endpoint. You are its client: never launch, restart, stop, reconfigure, probe, bind, or listen on its ports. If a Relay connection fails, report the exact error and do not add retries outside the task workflow.",
    "",
    ...(unityProject ? ["## Unity project snapshot", "", "```json", JSON.stringify(unityProject, null, 2), "```", ""] : []),
    "## Task prompt", "", prompt,
  ].join("\n");
}

function buildInteractivePowerShellScript(workspace: string, taskFile: string, pidFile: string, command: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `[Diagnostics.Process]::GetCurrentProcess().Id | Set-Content -LiteralPath ${powerShellLiteral(pidFile)} -Encoding ascii`,
    `Set-Location -LiteralPath ${powerShellLiteral(workspace)}`,
    `$terminalPrompt = Get-Content -LiteralPath ${powerShellLiteral(taskFile)} -Raw -Encoding UTF8`,
    `& ${powerShellLiteral(command)} $terminalPrompt`,
    "if ($LASTEXITCODE -ne 0) { Write-Host ('AI CLI exited with code ' + $LASTEXITCODE) -ForegroundColor Yellow }",
  ].join("; ");
}

async function launchInteractivePowerShell(workspace: string, encodedScript: string, pidFile: string): Promise<number> {
  if (process.platform !== "win32") throw new Error("interactive AI terminal launch is only supported on Windows");
  if (!commandAvailable("wt.exe")) throw new Error("Windows Terminal (wt.exe) is required to open a visible AI PowerShell window");
  fs.rmSync(pidFile, { force: true });

  const child = spawn("wt.exe", ["-w", "new", "nt", "-d", workspace, "powershell.exe", "-NoLogo", "-NoExit", "-EncodedCommand", encodedScript], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await waitForChildSpawn(child);
  child.unref();
  return await waitForTerminalPid(pidFile, 8_000);
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function waitForTerminalPid(pidFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid)) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Windows Terminal did not create a live PowerShell process within 8 seconds");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The UI cleanup template used to contain a second complete execution policy.
 * The Relay owns that policy in buildCleanupConversationTask, so passing the
 * UI template through as a user request created contradictory instructions.
 */
export function cleanupInitialUserRequest(prompt: string): string {
  const normalized = prompt.trim();
  if (normalized.startsWith("# Relay-owned cleanup execution")
    || normalized.startsWith("使用 Relay 内置整理技能：$figma-hierarchy-cleanup-mcp")) {
    return "\u6574\u7406\u5f53\u524d\u9009\u4e2d\u7684 Figma \u8282\u70b9\u3002";
  }
  return normalized;
}

/**
 * The plugin window is the cleanup conversation surface. The first turn may
 * inspect and plan with the Relay-managed cleanup policy. Relay owns the safe
 * hierarchy transaction immediately after it validates the plan.
 */
export function buildCleanupConversationTask(prompt: string, cleanupSnapshot?: CleanupSnapshotV1): string {
  const skillFile = CleanupSkillFile.replaceAll("\\", "/");
  const clientScript = CleanupClientScript.replaceAll("\\", "/");
  const pipelineScript = CleanupPipelineScript.replaceAll("\\", "/");
  const projectSkillFile = ".figma/plugins/figma-mcp-relay/ai/skills/figma-hierarchy-cleanup-mcp/SKILL.md";
  return [
    "# Figma hierarchy cleanup conversation",
    "",
    "You are speaking directly with the user in the Figma plugin window. Follow the Relay-managed cleanup policy embedded in this task.",
    "Cleanup skill identifier: $figma-hierarchy-cleanup-mcp.",
    `Mandatory skill file: ${skillFile}. If this project exposes the plugin-installed path ${projectSkillFile}, read that equivalent file instead. This is a project-defined skill, not a Claude Code built-in skill.`,
    "Do not call Skill() or ToolSearch to discover this skill. Directly read the selected SKILL.md with UTF-8 encoding before analyzing any Figma node, then follow its standard analyze -> plan -> apply workflow.",
    `Standard script entry points are ${clientScript} and ${pipelineScript}. Do not hand-write Relay HTTP jobs or use generic Figma MCP write tools. The first turn remains read-only; Relay executes the validated hierarchy transaction after planning, so do not invoke an apply command yourself before Relay advances the conversation phase.`,
    "所有面向用户的回复、进度摘要和错误说明必须使用简体中文。",
    "Relay is the only Figma write authority. Use only the Relay-provided cleanup commands and verification evidence; never use an official or generic Figma MCP write tool.",
    "",
    "## Relay lifecycle boundary",
    "The Figma MCP Relay at http://127.0.0.1:32130 is an externally managed MCP endpoint. You are a client of that endpoint, not its service owner.",
    "The task-start preflight is authoritative: this task was accepted by the Relay itself. Do not independently run curl, Invoke-WebRequest, or any direct /health probe, and do not guess another port such as localhost:3000.",
    "Never launch, restart, stop, kill, or reconfigure the Relay. Never bind or listen on ports 32130 or 32131. Do not run start_mcp_companion, start_mcp_hidden, start_mcp_oneclick, npm run dev, or any equivalent service-management command.",
    "If a Relay-provided command or tool reports WinError 10055, ENOBUFS, WinError 10048, EADDRINUSE, timeout, or a connection error, do not attempt a service restart, raw /health probe, or port diagnostic. Report the exact error as local TCP resource pressure that prevented this client from opening a connection; do not claim that the Relay is stopped or ask the user to start it. Stop the current turn without adding connection pressure.",
    "",
    "## Initial-turn safety boundary",
    "This initial turn is read-only. A server-side write guard independently rejects every Figma mutation while you analyze. Use the supplied authoritative snapshot first; request further evidence only through Relay-provided read operations when it is needed.",
    "You must not write to Figma, apply a plan, create groups, reorder nodes, create Components or ComponentSets, create variants, or make any visual change in this initial turn.",
    `You must write ${CleanupConfirmationDecisionFileName} before ending this initial turn. Writing that one local Relay decision artifact is required planning output, not a Figma mutation.`,
    "End the turn after writing the complete decision and a concise explanation. Relay dispatches the validated safe hierarchy transaction automatically; do not ask for hierarchy confirmation or claim that you executed it.",
    "",
    "## Relay-plan completeness gate",
    "Before ending the turn, enumerate every original direct child from the authoritative snapshot exactly once by original ID and name, with one explicit target parent and target sibling order.",
    "Do not use ellipses, ranges, or narrative substitutes such as 其余节点、随对应图片移动、同类节点一起移动. A descendant of an original direct-child container is not another root direct child; assign the original container and preserve its descendants, including nine-slice structures.",
    "Duplicate PSD layer names are expected input, not an ambiguity or deletion request. Node IDs, sibling order, type, geometry, and hierarchy are authoritative when names repeat. Do not ask the user to resolve duplicate layer names, delete duplicates, or choose a duplicate set; preserve every original node exactly once.",
    `Write only the compact count-based semantic decision ${CleanupConfirmationDecisionFileName} beside task.md. Do not write ${CleanupConfirmationPlanFileName} yourself. Relay deterministically expands the compact decision from the authoritative snapshot and independently validates the generated full artifact after the turn; the AI's own validation claim is non-authoritative.`,
    "The compact decision schema is: schemaVersion, rootNodeId, groups, componentCandidates, warnings. Each groups[] item contains name, count, startNodeId, endNodeId, and optional subgroups. Counts describe consecutive slices of the authoritative root direct-child order; startNodeId/endNodeId anchor the intended semantic boundary and must equal the first/last node of that slice. Top-level counts must total directChildCount. Each subgroup uses the same boundary-anchored shape; subgroup counts must exactly total the parent count. Every group and subgroup needs at least two nodes, and any count of 12 or more requires at least two further contiguous subgroups.",
    `Relay generates ${CleanupConfirmationPlanFileName} with authoritative sourceNodeIds, exact nodeName values, assignments, and sibling indexes. Never hand-copy the full ID/name mapping into the machine-readable artifact.`,
    "Relay validation must prove set equality and report beforeCount, assignedCount, missing [], duplicate [], extra [], and groupCount. It rejects descendants substituted for root children, name mismatches, duplicate or missing nodes, changed order, single-child groups, and unexpanded large groups.",
    "If counts differ, any set is non-empty, a target parent is invalid, a group has only one child, or a large semantic group is not fully expanded, remain in read-only analysis and repair the plan.",
    "The user-facing plan may summarize the validated mapping, but it must not omit assignments or replace them with prose.",
    "",
    "## Conversation protocol",
    "After Relay validates the decision, Relay itself executes the safe hierarchy transaction with ComponentSet creation disabled. Do not execute or simulate Figma writes yourself; report only the Relay-provided verification evidence.",
    "After verified hierarchy cleanup, ask whether the user is satisfied. Only an explicit satisfied response (for example, 满意) may begin the Relay-controlled ComponentSet/variant stage; adjustment feedback requires fresh analysis and a revised plan.",
    "Keep all clarification, plan review, progress, and final result in this same resumable CLI conversation. If evidence is ambiguous, ask the user instead of guessing.",
    "",
    "## User's initial request",
    prompt,
    ...(cleanupSnapshot ? [
      "",
      "## Authoritative cleanup snapshot",
      "The active Figma plugin captured the planning baseline, including hidden nodes, immediately before this conversation started.",
      "Relay persisted it beside this task as cleanup-snapshot.json; the launch instruction provides its absolute forward-slash path. Read that JSON file directly.",
      `Do not create a helper script to re-encode or parse the supplied snapshot. First read the required SKILL.md above, then use a bounded local read of cleanup-snapshot.json and write the required ${CleanupConfirmationDecisionFileName} beside task.md. Do not invoke a write command or generic MCP write tool during this read-only phase.`,
    ] : []),
  ].join("\n");
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
  initialInputChars = taskContent.length,
  requestedConfig?: RunnerConfig,
  cleanupSnapshot?: CleanupSnapshotV1,
  clientRequestId?: string,
) {
  const existing = taskKind === "cleanup"
    ? [...runs.values()].find((candidate) => candidate.sessionId === sessionId && candidate.clientRequestId === clientRequestId)
    : undefined;
  if (existing) {
    existing.operation?.step("idempotent-start", "重复的 AI 整理启动请求已复用原会话", {
      clientRequestId,
      cleanupPhase: existing.cleanupPhase,
    });
    return { ok: true, runId: existing.runId, capabilityToken: existing.capabilityToken, runner: existing.config.runner, phase: existing.cleanupPhase, reused: true };
  }
  if (taskKind === "cleanup") {
    const active = [...runs.values()].find((candidate) => candidate.sessionId === sessionId
      && candidate.taskKind === "cleanup"
      && !["finished", "failed", "cancelled"].includes(String(candidate.cleanupPhase || "")));
    if (active) throw new Error(`cleanup AI conversation already active for this Figma session: ${active.runId}`);
  }
  const config = requestedConfig || readConfig();
  if (!commandAvailable(config.command)) throw new Error(`local AI command is not available: ${config.command}`);
  const runId = `${taskKind}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const taskFile = path.join(runDir, "task.md");
  const taskJson = path.join(runDir, "task.json");
  const cleanupSnapshotFile = cleanupSnapshot ? path.join(runDir, "cleanup-snapshot.json") : undefined;
  fs.writeFileSync(taskFile, `\uFEFF${taskContent}`, "utf8");
  if (cleanupSnapshotFile && cleanupSnapshot) {
    fs.writeFileSync(cleanupSnapshotFile, `${JSON.stringify(cleanupSnapshot, null, 2)}\n`, "utf8");
  }
  fs.writeFileSync(taskJson, `${JSON.stringify({
    schemaVersion: 1,
    taskKind,
    initialInputChars,
    unityProject: unityProject || null,
    cleanupSnapshotFile: cleanupSnapshotFile ? path.basename(cleanupSnapshotFile) : null,
  }, null, 2)}\n`, "utf8");
  const run: AiRun = {
    runId, capabilityToken: randomBytes(32).toString("base64url"), sessionId, config, runDir, taskFile, taskJson, unityProject, cleanupSnapshotFile,
    executionLog: path.join(runDir, "execution.log"), status: "starting", taskKind, startedAt: new Date().toISOString(), output: [], nextSequence: 1, finalised: false, outputBytes: 0, conversationTurn: 0, relayClientFailureLogged: false,
    cleanupPhase: taskKind === "cleanup" ? "analysis" : undefined,
    cleanupSnapshot,
    cleanupConfirmationPlanValidated: false,
    cleanupPlanRepairAttempts: 0,
    clientRequestId,
    followupRequests: new Map(),
  };
  run.operation = aiLogger.startOperation("ai.run", "开始本地 AI 任务", {
    operationId: runId,
    data: { taskKind, runner: config.runner, inputChars: initialInputChars, taskChars: taskContent.length }
  });
  run.operation.step("provider-probe", "本地 AI Provider 已确认可用", {
    runner: config.runner,
    command: path.basename(config.command)
  });
  if (cleanupSnapshotFile && cleanupSnapshot) {
    run.operation.step("snapshot-persisted", "AI 整理权威快照已保存为独立 UTF-8 JSON 文件", {
      fileName: path.basename(cleanupSnapshotFile),
      nodeCount: cleanupSnapshot.nodes.length,
      rootNodeId: cleanupSnapshot.rootNodeId,
      bytes: fs.statSync(cleanupSnapshotFile).size,
    });
  }
  if (taskKind === "cleanup") {
    beginCleanupAiWriteGuard(sessionId, runId);
    run.operation.step("conversation-opened", "已打开 AI 整理多轮对话，首轮限定为只读规划分析", {
      conversationTurn: run.conversationTurn,
      writeAuthorised: false,
      inputChars: initialInputChars,
    });
  }
  runs.set(runId, run);
  try {
    startTurn(run, taskInstruction(run), false);
  } catch (error) {
    runs.delete(runId);
    if (taskKind === "cleanup") endCleanupAiWriteGuard(sessionId, runId);
    run.operation.fail(error, "本地 AI CLI 启动失败", { taskKind, runner: config.runner });
    throw error;
  }
  logInfo("Local AI task started", { runId, taskKind, runner: config.runner, inputChars: initialInputChars, taskChars: taskContent.length });
  return { ok: true, runId, capabilityToken: run.capabilityToken, runner: config.runner, ...(run.cleanupPhase ? { phase: run.cleanupPhase } : {}) };
}

export function getAiRun(runId: string, capabilityToken: string, afterSequence: number) {
  const run = authorisedRun(runId, capabilityToken);
  return {
    ok: true, runId, runner: run.config.runner, status: run.status, cliSessionId: run.cliSessionId ? "available" : "pending",
    ...(run.cleanupPhase ? { phase: run.cleanupPhase } : {}),
    startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.exitCode, nextSequence: run.nextSequence,
    output: run.output.filter((entry) => entry.sequence > afterSequence).slice(0, 200), logPath: run.executionLog
  };
}

export function followupAiRun(runId: string, capabilityToken: string, payload: unknown) {
  const run = authorisedRun(runId, capabilityToken);
  const text = isRecord(payload) ? payload.text : payload;
  const prompt = typeof text === "string" ? text.trim() : "";
  const clientRequestId = isRecord(payload) && typeof payload.clientRequestId === "string" ? payload.clientRequestId.trim() : "";
  if (!prompt) throw new Error("follow-up text is required");
  if (!clientRequestId) throw new Error("follow-up clientRequestId is required");
  const existingRequest = run.followupRequests.get(clientRequestId);
  if (existingRequest) {
    if (existingRequest.prompt !== prompt) throw new Error("follow-up clientRequestId was reused with different text");
    run.operation?.step("idempotent-followup", "重复的 AI 后续请求已复用原回合", {
      clientRequestId,
      conversationTurn: run.conversationTurn,
      status: run.status,
      cleanupPhase: run.cleanupPhase,
    });
    return { ...existingRequest.response, status: run.status, reused: true };
  }
  if (run.status !== "completed" && run.status !== "failed") throw new Error("follow-up is available only after the current turn stops");
  const canDispatchSatisfiedVariantsWithoutCli = run.taskKind === "cleanup"
    && classifyCleanupFollowup(run.cleanupPhase, prompt) === "variants";
  if (!run.cliSessionId && !canDispatchSatisfiedVariantsWithoutCli) {
    throw new Error("the current CLI did not return a resumable session id");
  }
  const previousRelayClientFailure = run.relayClientFailureLogged;
  const previousCleanupPhase = run.cleanupPhase;
  const previousStatus = run.status;
  const previousFinalised = run.finalised;
  const previousEndedAt = run.endedAt;
  const previousExitCode = run.exitCode;
  const previousOutputBytes = run.outputBytes;
  const previousConversationTurn = run.conversationTurn;
  const previousCleanupSnapshot = run.cleanupSnapshot;
  const previousCleanupConfirmationPlanValidated = run.cleanupConfirmationPlanValidated;
  const previousCleanupConfirmationPlanSummary = run.cleanupConfirmationPlanSummary;
  const previousCleanupPlanRepairAttempts = run.cleanupPlanRepairAttempts;
  let freshCleanupSnapshot: CleanupSnapshotV1 | undefined;
  let archivedConfirmationArtifact: string | undefined;
  let archivedDecisionArtifact: string | undefined;
  let confirmationPlanSummary: CleanupConfirmationPlanSummary | undefined;
  let validatedVariantPlan: CleanupPlanV3 | undefined;
  if (run.taskKind === "cleanup") {
    const nextCleanupPhase = classifyCleanupFollowup(previousCleanupPhase, prompt);
    if (nextCleanupPhase === "hierarchy") {
      if (!run.cleanupConfirmationPlanValidated || !run.cleanupSnapshot) {
        throw new Error("Relay 尚未独立验证 cleanup-plan-for-confirmation.json，禁止确认执行");
      }
      confirmationPlanSummary = validateCleanupConfirmationPlanArtifact(run.runDir, run.cleanupSnapshot).summary;
    } else if (nextCleanupPhase === "variants") {
      if (!run.cleanupConfirmationPlanValidated || !run.cleanupSnapshot) {
        throw new Error("Relay 尚未保留已验证的层级整理方案，禁止创建 ComponentSet 变体");
      }
      const validation = validateCleanupConfirmationPlanArtifact(run.runDir, run.cleanupSnapshot);
      confirmationPlanSummary = validation.summary;
      validatedVariantPlan = compileCleanupConfirmationPlanToV3(validation.plan, run.cleanupSnapshot);
    } else if (nextCleanupPhase === "analysis") {
      if (!isRecord(payload) || payload.cleanupSnapshot === undefined) {
        throw new Error("fresh cleanup snapshot is required for cleanup plan adjustments");
      }
      freshCleanupSnapshot = cleanupSnapshotFrom(payload.cleanupSnapshot);
      if (run.cleanupSnapshot && freshCleanupSnapshot.rootNodeId !== run.cleanupSnapshot.rootNodeId) {
        throw new Error(`cleanup adjustment target changed from ${run.cleanupSnapshot.rootNodeId} to ${freshCleanupSnapshot.rootNodeId}`);
      }
      run.cleanupSnapshot = freshCleanupSnapshot;
      if (!run.cleanupSnapshotFile) throw new Error("cleanup snapshot file is missing for the active conversation");
      fs.writeFileSync(run.cleanupSnapshotFile, `${JSON.stringify(freshCleanupSnapshot, null, 2)}\n`, "utf8");
      archivedConfirmationArtifact = resetCleanupConfirmationPlanArtifact(run, "user-adjustment");
      archivedDecisionArtifact = resetCleanupConfirmationDecisionArtifact(run, "user-adjustment");
      run.cleanupPlanRepairAttempts = 0;
    }
    run.cleanupPhase = nextCleanupPhase;
    setCleanupAiWritePhase(run.sessionId, run.runId, run.cleanupPhase);
  }
  run.status = "starting"; run.finalised = false; run.endedAt = undefined; run.exitCode = undefined;
  run.outputBytes = 0;
  run.relayClientFailureLogged = false;
  run.conversationTurn += 1;
  run.operation = aiLogger.startOperation("ai.followup", "开始本地 AI 后续任务", {
    operationId: run.runId,
    data: { taskKind: run.taskKind, runner: run.config.runner, conversationTurn: run.conversationTurn, inputChars: prompt.length, previousRelayClientFailure, previousCleanupPhase, cleanupPhase: run.cleanupPhase }
  });
  if (run.taskKind === "cleanup") {
    run.operation.step("conversation-message", "收到 AI 整理窗口的后续消息，继续 Relay 管理的整理流程", {
      conversationTurn: run.conversationTurn,
      inputChars: prompt.length,
      previousCleanupPhase,
      cleanupPhase: run.cleanupPhase,
    });
    if (confirmationPlanSummary) {
      run.operation.step("confirmation-plan-revalidated", "执行前已重新校验用户确认的固定整理方案", {
        artifact: CleanupConfirmationPlanFileName,
        ...confirmationPlanSummary,
      });
    }
    if (freshCleanupSnapshot && run.cleanupSnapshotFile) {
      run.operation.step("snapshot-refreshed", "用户提出调整后已重新采集并替换 authoritative cleanup snapshot", {
        fileName: path.basename(run.cleanupSnapshotFile),
        rootNodeId: freshCleanupSnapshot.rootNodeId,
        nodeCount: freshCleanupSnapshot.nodes.length,
        bytes: fs.statSync(run.cleanupSnapshotFile).size,
        previousPhase: previousCleanupPhase,
        cleanupPhase: run.cleanupPhase,
      });
    }
    if (previousRelayClientFailure) {
      run.operation.step("relay-client-recovery-attempt", "前一回合连接失败，当前回合将重新独立判定连接结果", {
        conversationTurn: run.conversationTurn,
        previousRelayClientFailure,
      });
    }
  }
  try {
    if (validatedVariantPlan) {
      startRelayOwnedVariantExecution(run, validatedVariantPlan);
      const response = { ok: true as const, runId, status: run.status, clientRequestId };
      run.followupRequests.set(clientRequestId, { prompt, response });
      return response;
    }
    startTurn(run, prompt, true);
    const response = { ok: true as const, runId, status: run.status, clientRequestId };
    run.followupRequests.set(clientRequestId, { prompt, response });
    return response;
  } catch (error) {
    run.status = previousStatus;
    run.finalised = previousFinalised;
    run.endedAt = previousEndedAt;
    run.exitCode = previousExitCode;
    run.outputBytes = previousOutputBytes;
    run.conversationTurn = previousConversationTurn;
    run.relayClientFailureLogged = previousRelayClientFailure;
    run.cleanupPhase = previousCleanupPhase;
    run.cleanupSnapshot = previousCleanupSnapshot;
    run.cleanupConfirmationPlanValidated = previousCleanupConfirmationPlanValidated;
    run.cleanupConfirmationPlanSummary = previousCleanupConfirmationPlanSummary;
    run.cleanupPlanRepairAttempts = previousCleanupPlanRepairAttempts;
    if (run.cleanupSnapshotFile && previousCleanupSnapshot) {
      fs.writeFileSync(run.cleanupSnapshotFile, `${JSON.stringify(previousCleanupSnapshot, null, 2)}\n`, "utf8");
    }
    if (archivedConfirmationArtifact) {
      const archivedPath = path.join(run.runDir, archivedConfirmationArtifact);
      const artifactPath = path.join(run.runDir, CleanupConfirmationPlanFileName);
      if (fs.existsSync(archivedPath) && !fs.existsSync(artifactPath)) fs.renameSync(archivedPath, artifactPath);
    }
    if (archivedDecisionArtifact) {
      const archivedPath = path.join(run.runDir, archivedDecisionArtifact);
      const decisionPath = path.join(run.runDir, CleanupConfirmationDecisionFileName);
      if (fs.existsSync(archivedPath) && !fs.existsSync(decisionPath)) fs.renameSync(archivedPath, decisionPath);
    }
    if (run.taskKind === "cleanup" && previousCleanupPhase) {
      setCleanupAiWritePhase(run.sessionId, run.runId, previousCleanupPhase);
    }
    run.operation?.fail(error, "本地 AI 后续回合启动失败，已恢复上一阶段", {
      clientRequestId,
      previousCleanupPhase,
      restoredStatus: previousStatus,
    });
    throw error;
  }
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
  run.operation?.step("cli-spawn", "本地 AI CLI 进程已启动", {
    command: path.basename(command),
    argumentCount: args.length,
    pid: launched.pid,
    resume,
    conversationTurn: run.conversationTurn,
    strictMcpConfig: run.config.runner === "claude" && run.taskKind === "cleanup",
  });
  appendOutput(run, "system", `${resume ? "Follow-up" : "Initial"} turn started with ${run.config.runner}.`);
  scheduleRunTimeouts(run);
  wireOutput(run, launched.stdout, "stdout"); wireOutput(run, launched.stderr, "stderr");
  launched.once("error", (error) => {
    if (run.child !== launched) return;
    appendOutput(run, "stderr", error.message);
    finalise(run, "failed", null);
  });
  launched.once("close", (code) => {
    if (run.child !== launched) return;
    if (!run.finalised) finishRunTurn(run, code === 0 ? "completed" : "failed", code);
  });
}

function commandArgs(run: AiRun, prompt: string, resume: boolean): string[] {
  if (run.config.runner === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    // Cleanup uses the Relay-managed local execution boundary. Loading unrelated
    // global MCP servers (for example codegraph) adds minutes and extra sockets.
    if (run.taskKind === "cleanup") args.push("--strict-mcp-config");
    // Unity quick-import has a fixed script pipeline. Claude's automatic Skill routing
    // spends minutes loading the broad skill before it reaches that pipeline.
    if (resume) args.push("--resume", run.cliSessionId!);
    args.push(prompt);
    // Claude parses --disallowedTools as a variadic option; it must be placed
    // after the positional prompt or it consumes the whole task text.
    if (run.taskKind === "unity" && !resume) args.push("--disallowedTools", "Skill,ToolSearch");
    return args;
  }
  return codexExecArgs(run.config.workspace, prompt, resume ? run.cliSessionId : undefined);
}

export function codexExecArgs(workspace: string, prompt: string, resumeSessionId?: string): string[] {
  if (!resumeSessionId) return codexCliProvider.buildArgs(workspace, prompt);
  const args = [
    "exec", "--json", "--full-auto",
    "--disable", "hooks",
    "-c", "mcp_servers.coplay-mcp.enabled=false",
    "-c", "mcp_servers.coplay_mcp.enabled=false",
    "--cd", workspace
  ];
  args.splice(2, 1, "--sandbox", "workspace-write");
  if (resumeSessionId) args.push("resume", resumeSessionId);
  args.push(prompt); return args;
}

function taskInstruction(run: AiRun) {
  const taskFile = run.taskFile.replaceAll("\\", "/");
  const snapshotInstruction = run.cleanupSnapshotFile
    ? ` The authoritative cleanup snapshot is already stored at ${run.cleanupSnapshotFile.replaceAll("\\", "/")}. Read it directly; do not create a helper script to copy, re-encode, or parse it.`
    : "";
  const confirmationArtifactInstruction = run.taskKind === "cleanup"
    ? ` Write only the compact count-based decision to ${path.join(run.runDir, CleanupConfirmationDecisionFileName).replaceAll("\\", "/")}; do not write ${CleanupConfirmationPlanFileName}. Relay will expand exact IDs, names, assignments, and ordering from the authoritative snapshot, then independently validate the generated artifact after this turn.`
    : "";
  return `Read and obey the task file before acting: ${taskFile}.${snapshotInstruction}${confirmationArtifactInstruction} In every tool JSON argument, write Windows paths with forward slashes so backslashes cannot invalidate JSON. On Windows, read every UTF-8 text file with Get-Content -Encoding UTF8; never rely on the Windows PowerShell 5.1 default text encoding. The user started this task from Figma; follow the task file's authorization rules exactly.`;
}
function spawnCli(command: string, args: string[], cwd: string): ChildProcessByStdio<null, Readable, Readable> {
  const env = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  if (process.platform === "win32" && /\.cmd$/i.test(command)) return spawn("cmd.exe", ["/d", "/s", "/c", `call ${cmdQuote(command)} ${args.map(cmdQuote).join(" ")}`], { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, windowsVerbatimArguments: true });
  return spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
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
    const id = findProviderSessionId(run.config.runner, event);
    if (id && !run.cliSessionId) {
      run.cliSessionId = id;
      run.operation?.step("cli-session-captured", "已取得可续接的 AI CLI 会话标识", {
        runner: run.config.runner,
        conversationTurn: run.conversationTurn,
        sessionIdLength: id.length,
        eventType: isRecord(event) && typeof event.type === "string" ? event.type : "unknown",
      });
    }
    if (run.config.runner === "claude" && stream === "stdout") {
      formatClaudeStreamEvent(event).forEach((text) => appendOutput(run, stream, text));
      const terminalStatus = classifyClaudeTerminalEvent(event);
      if (terminalStatus) finishTerminalStreamEvent(run, terminalStatus);
      return;
    }
    if (run.config.runner === "codex" && stream === "stdout") {
      formatCodexStreamEvent(event).forEach((text) => appendOutput(run, stream, text));
      const terminalStatus = codexCliProvider.isTerminalEvent(event);
      if (terminalStatus) finishTerminalStreamEvent(run, terminalStatus);
      return;
    }
  } catch { /* plain CLI line */ }
  appendOutput(run, stream, line);
}

export function formatCodexStreamEvent(value: unknown): string[] {
  if (!isRecord(value) || typeof value.type !== "string") return [];
  if (value.type === "thread.started") return ["Codex 会话已初始化。"];
  if (value.type === "turn.started") return ["Codex 正在执行本回合。"];
  if (value.type === "error" || value.type === "turn.failed" || value.type === "thread.failed") {
    const message = codexEventError(value);
    return [message ? `Codex 执行失败：${message}` : "Codex 执行失败。"];
  }
  if (value.type !== "item.completed" || !isRecord(value.item)) return [];
  const item = value.item;
  if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
    return [item.text.trim()];
  }
  if (item.type === "command_execution") {
    const command = typeof item.command === "string" ? compactCodexText(item.command, 240) : "本地命令";
    const exitCode = typeof item.exit_code === "number" ? `（exit ${item.exit_code}）` : "";
    return [`命令执行完成${exitCode}：${command}`];
  }
  if (item.type === "mcp_tool_call" || item.type === "tool_call") {
    const toolName = [item.server, item.name].filter((part) => typeof part === "string" && part.trim()).join("/") || "MCP 工具";
    const status = typeof item.status === "string" && item.status.trim() ? `（${item.status.trim()}）` : "";
    return [`工具调用完成${status}：${toolName}`];
  }
  if (item.type === "reasoning") return [];
  return typeof item.type === "string" && item.type.trim() ? [`Codex 已完成步骤：${item.type.trim()}`] : [];
}

function codexEventError(value: Record<string, unknown>): string {
  if (typeof value.message === "string") return compactCodexText(value.message, 500);
  if (typeof value.error === "string") return compactCodexText(value.error, 500);
  if (isRecord(value.error) && typeof value.error.message === "string") return compactCodexText(value.error.message, 500);
  return "";
}

function compactCodexText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
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
  return claudeCodeCliProvider.isTerminalEvent(value);
}

export function localAiTimeoutPolicy(_taskKind: string) {
  return { totalMs: 30 * 60 * 1000, idleMs: 5 * 60 * 1000 };
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

export function findProviderSessionId(runner: RunnerKind, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (runner === "claude"
    && value.type === "system"
    && value.subtype === "init"
    && typeof value.session_id === "string"
    && validCliSessionId(value.session_id)) return value.session_id;
  if (runner === "codex"
    && value.type === "thread.started"
    && typeof value.thread_id === "string"
    && validCliSessionId(value.thread_id)) return value.thread_id;
  return undefined;
}
function appendOutput(run: AiRun, stream: OutputEntry["stream"], text: string) {
  recordRelayClientConnectionFailure(run, stream, text);
  const entry = { sequence: run.nextSequence++, at: new Date().toISOString(), stream, text };
  run.outputBytes += Buffer.byteLength(text, "utf8");
  run.output.push(entry); if (run.output.length > MaxOutputEntries) run.output.splice(0, run.output.length - MaxOutputEntries);
  fs.appendFileSync(run.executionLog, `${entry.at} [${stream}] ${text}\n`, "utf8");
  if (!run.finalised && (run.status === "starting" || run.status === "running")) resetIdleTimeout(run);
}

function recordRelayClientConnectionFailure(run: AiRun, stream: OutputEntry["stream"], text: string) {
  if (run.taskKind !== "cleanup" || run.relayClientFailureLogged) return;
  const errorClass = relayClientConnectionFailureClass(text);
  if (!errorClass) return;
  run.relayClientFailureLogged = true;
  run.operation?.step("relay-client-connection-failed", "AI Relay 客户端无法建立连接", {
    stream,
    errorClass,
    errorSummary: text.slice(0, 500),
    nextStep: "do-not-restart-relay-or-probe-ports",
  }, "warn");
}

function relayClientConnectionFailureClass(text: string): string | undefined {
  if (/WinError\s+10055|\b(?:WSA)?ENOBUFS\b/i.test(text)) return "socket-buffer-exhausted";
  if (/WinError\s+10048|EADDRINUSE/i.test(text)) return "address-in-use";
  if (/WinError\s+10061|ECONNREFUSED|curl:\s*\(7\)\s+Failed to connect|Unable to connect to the remote server|Could not connect to server/i.test(text)) return "tcp-connect-failed";
  if (/ETIMEDOUT|TimeoutError|ConnectTimeoutError|connection\s+timed\s+out/i.test(text)) return "tcp-timeout";
  if (/socket hang up|ECONNRESET|connection pool|pool timeout/i.test(text)) return "tcp-connection-lost";
  return undefined;
}

function finalise(run: AiRun, status: RunStatus, code: number | null) {
  if (run.finalised) return;
  let validatedHierarchyPlan: CleanupPlanV3 | undefined;
  if (status === "completed" && run.relayClientFailureLogged) status = "failed";
  if (status === "completed" && run.taskKind === "cleanup" && run.cleanupPhase === "analysis") {
    try {
      if (!run.cleanupSnapshot) throw new Error("缺少 AI 整理权威快照，无法独立验证确认方案");
      const validation = materializeCleanupConfirmationPlanArtifact(run.runDir, run.cleanupSnapshot);
      validatedHierarchyPlan = compileCleanupConfirmationPlanToV3(validation.plan, run.cleanupSnapshot);
      run.cleanupConfirmationPlanValidated = true;
      run.cleanupConfirmationPlanSummary = validation.summary;
      const snapshotNodeById = new Map(run.cleanupSnapshot.nodes.map((node) => [node.id, node]));
      run.operation?.step("confirmation-plan-materialized", "Relay 已把精简语义决策确定性展开为完整确认方案", {
        decisionArtifact: CleanupConfirmationDecisionFileName,
        decisionBytes: validation.decisionBytes,
        artifact: CleanupConfirmationPlanFileName,
        artifactBytes: validation.artifactBytes,
        replacedAiArtifact: validation.replacedAiArtifact,
        rootNodeId: run.cleanupSnapshot.rootNodeId,
        directChildCount: validation.summary.beforeCount,
        groupCount: validation.summary.groupCount,
        groupBoundaries: validation.plan.groups.map((group) => {
          const firstNodeId = group.sourceNodeIds[0] || "";
          const lastNodeId = group.sourceNodeIds.at(-1) || "";
          return {
            name: group.name,
            count: group.sourceNodeIds.length,
            firstNodeId,
            firstNodeName: snapshotNodeById.get(firstNodeId)?.name || "",
            lastNodeId,
            lastNodeName: snapshotNodeById.get(lastNodeId)?.name || "",
            subgroupCount: group.subgroups?.length || 0,
          };
        }),
      });
      run.operation?.step("plan-validation-succeeded", "Relay 已根据权威快照独立验证固定确认方案", {
        artifact: CleanupConfirmationPlanFileName,
        artifactBytes: validation.artifactBytes,
        repairAttempts: run.cleanupPlanRepairAttempts,
        ...validation.summary,
      });
    } catch (error) {
      const validationError = error instanceof Error ? error : new Error(String(error));
      run.cleanupConfirmationPlanValidated = false;
      run.cleanupConfirmationPlanSummary = undefined;
      appendOutput(run, "system", `Relay rejected the cleanup confirmation plan: ${validationError.message}`);
      run.operation?.step("plan-validation-failed", "Relay 独立校验拒绝了 AI 整理方案，未开放确认或写入阶段", {
        artifact: CleanupConfirmationPlanFileName,
        error: validationError.message,
        repairAttempts: run.cleanupPlanRepairAttempts,
        maxRepairAttempts: MaxCleanupPlanRepairAttempts,
        cleanupPhase: run.cleanupPhase,
        decisionPresent: fs.existsSync(path.join(run.runDir, CleanupConfirmationDecisionFileName)),
        decisionBytes: existingFileBytes(path.join(run.runDir, CleanupConfirmationDecisionFileName)),
        artifactPresent: fs.existsSync(path.join(run.runDir, CleanupConfirmationPlanFileName)),
        artifactBytes: existingFileBytes(path.join(run.runDir, CleanupConfirmationPlanFileName)),
      }, "warn");
      if (run.cliSessionId && run.cleanupPlanRepairAttempts < MaxCleanupPlanRepairAttempts) {
        scheduleCleanupPlanRepair(run, validationError, code);
        return;
      }
      run.operation?.step("plan-repair-exhausted", "AI 整理方案自动修复次数已耗尽，关闭当前整理会话", {
        repairAttempts: run.cleanupPlanRepairAttempts,
        maxRepairAttempts: MaxCleanupPlanRepairAttempts,
        resumableSessionAvailable: Boolean(run.cliSessionId),
        error: validationError.message,
      }, "error");
      status = "failed";
    }
  }
  if (status === "completed" && run.taskKind === "cleanup" && run.cleanupPhase === "analysis" && validatedHierarchyPlan) {
    startRelayOwnedHierarchyExecution(run, validatedHierarchyPlan, code);
    return;
  }
  if (status === "completed" && run.taskKind === "cleanup" && (run.cleanupPhase === "hierarchy" || run.cleanupPhase === "variants")) {
    try {
      assertCleanupAiPhaseWriteEvidence(run.sessionId, run.runId, run.cleanupPhase);
    } catch (error) {
      appendOutput(run, "system", error instanceof Error ? error.message : String(error));
      run.operation?.step("missing-write-evidence", "AI 整理回合未产生成功的 Figma 写入，拒绝推进阶段", {
        cleanupPhase: run.cleanupPhase,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      status = "failed";
    }
  }
  settleCleanupPhase(run, status);
  clearRunTimeouts(run);
  run.finalised = true; run.status = status; run.exitCode = code; run.endedAt = new Date().toISOString(); run.child = undefined; run.pid = undefined;
  run.operation?.step("cli-exit", "本地 AI CLI 进程已退出", {
    exitCode: code,
    outputBytes: run.outputBytes,
    status
  });
  if (status === "completed") {
    run.operation?.succeed("本地 AI 任务执行完成", { exitCode: code, outputBytes: run.outputBytes });
  } else if (status === "cancelled") {
    run.operation?.cancel("本地 AI 任务已取消", { outputBytes: run.outputBytes });
  } else {
    run.operation?.fail(new Error(`local AI task ${status}`), "本地 AI 任务执行失败", {
      exitCode: code,
      outputBytes: run.outputBytes
    });
  }
  appendOutput(run, "system", `Turn ${status}${code === null ? "" : ` (exit ${code})`}.`);
}

function startRelayOwnedHierarchyExecution(run: AiRun, plan: CleanupPlanV3, code: number | null): void {
  if (!run.cleanupSnapshot) throw new Error("cleanup snapshot is required for Relay-owned hierarchy execution");
  if (!cleanupDispatcher) throw new Error("Relay cleanup dispatcher is not configured");
  clearRunTimeouts(run);
  run.child = undefined;
  run.pid = undefined;
  run.exitCode = code;
  run.endedAt = undefined;
  run.finalised = false;
  run.status = "running";
  run.cleanupPhase = "hierarchy";
  setCleanupAiWritePhase(run.sessionId, run.runId, "hierarchy");
  const controller = new AbortController();
  run.cleanupExecutionAbort = controller;
  appendOutput(run, "system", "Relay 正在执行已验证的层级整理事务。");
  run.operation?.step("hierarchy-dispatch-started", "Relay 开始调度已验证的 Figma 层级整理事务", {
    operationCount: plan.operations.length,
    rootNodeId: run.cleanupSnapshot.rootNodeId,
  });
  void cleanupDispatcher.dispatchValidatedHierarchyCleanup({
    runId: run.runId,
    sessionId: run.sessionId,
    plan,
    snapshot: run.cleanupSnapshot,
    signal: controller.signal,
    onProgress: (message) => appendOutput(run, "system", message),
  }).then((result) => {
    if (run.cleanupExecutionAbort !== controller || run.status === "cancelled") return;
    if (result.state !== "succeeded") throw new Error(`cleanup transaction ended as ${result.state}`);
    assertCleanupAiPhaseWriteEvidence(run.sessionId, run.runId, "hierarchy");
    run.cleanupPhase = "awaiting_satisfaction";
    setCleanupAiWritePhase(run.sessionId, run.runId, "awaiting_satisfaction");
    run.cleanupExecutionAbort = undefined;
    run.finalised = true;
    run.status = "completed";
    run.endedAt = new Date().toISOString();
    appendOutput(run, "system", "层级整理已完成并验证，是否满意？");
    run.operation?.step("awaiting-satisfaction", "层级整理已验证完成，等待用户满意度确认", {
      hierarchyWritesVerified: true,
    });
    run.operation?.succeed("Relay 已执行并验证层级整理事务", { exitCode: code, outputBytes: run.outputBytes });
  }).catch((error) => {
    if (run.cleanupExecutionAbort !== controller || run.status === "cancelled") return;
    run.cleanupExecutionAbort = undefined;
    run.cleanupPhase = "analysis";
    setCleanupAiWritePhase(run.sessionId, run.runId, "analysis");
    run.finalised = true;
    run.status = "completed";
    run.endedAt = new Date().toISOString();
    appendOutput(run, "stderr", `Relay hierarchy transaction failed: ${error instanceof Error ? error.message : String(error)}`);
    appendOutput(run, "system", "The validated plan was preserved. Describe an adjustment or start a new cleanup run.");
    run.operation?.step("hierarchy-dispatch-failed", "Relay 层级整理事务失败，已保留已验证计划供后续调整", {
      error: error instanceof Error ? error.message : String(error),
    }, "error");
  });
}

function startRelayOwnedVariantExecution(run: AiRun, plan: CleanupPlanV3): void {
  if (!run.cleanupSnapshot) throw new Error("cleanup snapshot is required for Relay-owned ComponentSet execution");
  if (!cleanupDispatcher) throw new Error("Relay cleanup dispatcher is not configured");
  clearRunTimeouts(run);
  run.child = undefined;
  run.pid = undefined;
  run.exitCode = undefined;
  run.endedAt = undefined;
  run.finalised = false;
  run.status = "running";
  run.cleanupPhase = "variants";
  setCleanupAiWritePhase(run.sessionId, run.runId, "variants");
  const controller = new AbortController();
  run.cleanupExecutionAbort = controller;
  appendOutput(run, "system", "Relay 正在根据满意确认创建 ComponentSet 变体。");
  run.operation?.step("variants-dispatch-started", "Relay 开始调度满意确认后的 ComponentSet 变体阶段", {
    rootNodeId: run.cleanupSnapshot.rootNodeId,
  });
  void cleanupDispatcher.dispatchConfirmedComponentSets({
    runId: run.runId,
    sessionId: run.sessionId,
    plan,
    snapshot: run.cleanupSnapshot,
    signal: controller.signal,
    onProgress: (message) => appendOutput(run, "system", message),
  }).then((result) => {
    if (run.cleanupExecutionAbort !== controller || run.status === "cancelled") return;
    if (result.state !== "succeeded") throw new Error(`component-set transaction ended as ${result.state}`);
    assertCleanupAiPhaseWriteEvidence(run.sessionId, run.runId, "variants");
    run.cleanupExecutionAbort = undefined;
    run.cleanupPhase = "finished";
    endCleanupAiWriteGuard(run.sessionId, run.runId);
    run.finalised = true;
    run.status = "completed";
    run.endedAt = new Date().toISOString();
    appendOutput(run, "system", "ComponentSet 变体阶段已完成。");
    run.operation?.step("variants-completed", "Relay 已完成并验证满意确认后的 ComponentSet 变体阶段", {
      variantWritesVerified: true,
    });
    run.operation?.succeed("Relay 已完成满意确认后的 ComponentSet 变体阶段", { outputBytes: run.outputBytes });
  }).catch((error) => {
    if (run.cleanupExecutionAbort !== controller || run.status === "cancelled") return;
    run.cleanupExecutionAbort = undefined;
    run.cleanupPhase = "awaiting_satisfaction";
    setCleanupAiWritePhase(run.sessionId, run.runId, "awaiting_satisfaction");
    run.finalised = true;
    run.status = "completed";
    run.endedAt = new Date().toISOString();
    appendOutput(run, "stderr", `Relay ComponentSet variant stage failed: ${error instanceof Error ? error.message : String(error)}`);
    appendOutput(run, "system", "ComponentSet 创建未完成。回复“满意”可重试，或直接说明需要调整的内容。");
    run.operation?.fail(error, "Relay ComponentSet 变体阶段失败，仍可重试或调整", {
      cleanupPhase: run.cleanupPhase,
    });
  });
}

function scheduleCleanupPlanRepair(run: AiRun, validationError: Error, code: number | null): void {
  run.cleanupPlanRepairAttempts += 1;
  const repairAttempt = run.cleanupPlanRepairAttempts;
  const archivedArtifact = resetCleanupConfirmationPlanArtifact(run, `rejected-${repairAttempt}`);
  const archivedDecisionArtifact = resetCleanupConfirmationDecisionArtifact(run, `rejected-${repairAttempt}`);
  clearRunTimeouts(run);
  appendOutput(
    run,
    "system",
    `Cleanup plan validation failed; automatic repair ${repairAttempt}/${MaxCleanupPlanRepairAttempts} will continue in the same AI session.`,
  );
  run.operation?.step("auto-plan-repair", "正在同一 AI Skill 会话中自动修复被拒绝的确认方案", {
    repairAttempt,
    maxRepairAttempts: MaxCleanupPlanRepairAttempts,
    artifact: CleanupConfirmationPlanFileName,
    archivedArtifact,
    archivedDecisionArtifact,
    validationError: validationError.message,
    conversationTurn: run.conversationTurn,
  }, "warn");
  run.operation?.step("cli-exit", "本地 AI CLI 分析回合已退出，等待自动修复回合", {
    exitCode: code,
    outputBytes: run.outputBytes,
    status: "plan-rejected",
  });
  run.operation?.succeed("AI 分析回合已结束，Relay 已自动安排方案修复", {
    exitCode: code,
    outputBytes: run.outputBytes,
    repairAttempt,
  });

  run.finalised = true;
  run.status = "starting";
  run.exitCode = undefined;
  run.endedAt = undefined;
  run.child = undefined;
  run.pid = undefined;
  setCleanupAiWritePhase(run.sessionId, run.runId, "analysis");

  const repairPrompt = [
    `Relay rejected the compact cleanup decision or generated ${CleanupConfirmationPlanFileName} during independent validation.`,
    `Validation error: ${validationError.message}`,
    `This is automatic repair attempt ${repairAttempt}/${MaxCleanupPlanRepairAttempts}. You are still in the read-only analysis phase; do not call any Figma write command and do not claim that the user confirmed execution.`,
    `Re-read the authoritative cleanup-snapshot.json and rewrite only the compact decision ${path.join(run.runDir, CleanupConfirmationDecisionFileName).replaceAll("\\", "/")}. Do not write ${CleanupConfirmationPlanFileName}.`,
    "Use only contiguous boundary-anchored groups: each group has name, count, startNodeId, endNodeId, and optional subgroups. Top-level counts must exactly total the authoritative directChildCount; each anchor must equal the actual first/last node of its consecutive slice. Subgroup counts must exactly total the parent count and use the same anchors. Every group needs at least two nodes; every count of 12 or more must be recursively split into at least two contiguous subgroups.",
    "The current cleanup-snapshot.json is the only authoritative source for this repair. Do not read, reuse, or copy any cleanup-plan-decision.*.json or cleanup-plan-for-confirmation.*.json files from earlier turns; they are archived failed attempts and may describe a different root structure.",
    "After rewriting the compact decision, summarize the corrected complete tree. Do not ask the user for confirmation: Relay will expand authoritative IDs/names/order, independently validate the generated file, and automatically execute it only after validation succeeds.",
  ].join("\n");

  setTimeout(() => {
    if (run.cleanupPhase !== "analysis" || run.status !== "starting") return;
    run.finalised = false;
    run.outputBytes = 0;
    run.relayClientFailureLogged = false;
    run.conversationTurn += 1;
    run.operation = aiLogger.startOperation("ai.plan-repair", "开始自动修复 AI 整理确认方案", {
      operationId: run.runId,
      data: {
        taskKind: run.taskKind,
        runner: run.config.runner,
        conversationTurn: run.conversationTurn,
        repairAttempt,
        maxRepairAttempts: MaxCleanupPlanRepairAttempts,
        validationError: validationError.message,
      },
    });
    try {
      startTurn(run, repairPrompt, true);
    } catch (error) {
      appendOutput(run, "stderr", error instanceof Error ? error.message : String(error));
      finalise(run, "failed", null);
    }
  }, 50);
}

function resetCleanupConfirmationPlanArtifact(run: AiRun, reason: string): string | undefined {
  run.cleanupConfirmationPlanValidated = false;
  run.cleanupConfirmationPlanSummary = undefined;
  const artifactPath = path.join(run.runDir, CleanupConfirmationPlanFileName);
  if (!fs.existsSync(artifactPath)) return undefined;
  const safeReason = reason.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "reset";
  const archivedName = `cleanup-plan-for-confirmation.${safeReason}.${Date.now()}.json`;
  fs.renameSync(artifactPath, path.join(run.runDir, archivedName));
  run.operation?.step("confirmation-artifact-reset", "旧的 AI 整理确认方案已归档，禁止后续回合误用", {
    reason,
    artifact: CleanupConfirmationPlanFileName,
    archivedArtifact: archivedName,
  });
  logInfo("Cleanup confirmation artifact reset", {
    runId: run.runId,
    conversationTurn: run.conversationTurn,
    reason,
    artifact: CleanupConfirmationPlanFileName,
    archivedArtifact: archivedName,
  });
  return archivedName;
}

function resetCleanupConfirmationDecisionArtifact(run: AiRun, reason: string): string | undefined {
  const decisionPath = path.join(run.runDir, CleanupConfirmationDecisionFileName);
  if (!fs.existsSync(decisionPath)) return undefined;
  const safeReason = reason.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "reset";
  const archivedName = `cleanup-plan-decision.${safeReason}.${Date.now()}.json`;
  fs.renameSync(decisionPath, path.join(run.runDir, archivedName));
  run.operation?.step("confirmation-decision-reset", "旧的 AI 精简整理决策已归档，禁止后续回合误用", {
    reason,
    decisionArtifact: CleanupConfirmationDecisionFileName,
    archivedDecisionArtifact: archivedName,
  });
  logInfo("Cleanup confirmation decision reset", {
    runId: run.runId,
    conversationTurn: run.conversationTurn,
    reason,
    decisionArtifact: CleanupConfirmationDecisionFileName,
    archivedDecisionArtifact: archivedName,
  });
  return archivedName;
}
function existingFileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
function finishTerminalStreamEvent(run: AiRun, status: "completed" | "failed") {
  if (run.finalised) return;
  finishRunTurn(run, status, status === "completed" ? 0 : 1);
}
function finishRunTurn(run: AiRun, status: "completed" | "failed", code: number | null) {
  terminateChild(run);
  finalise(run, status, status === "completed" ? code : code === 0 ? 1 : code);
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
  run.operation?.step("timeout", "本地 AI 任务超时", { reason }, "warn");
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
  if (run.status !== "starting" && run.status !== "running") return false;
  appendOutput(run, "system", reason);
  run.operation?.step("cancel", "本地 AI 任务收到取消请求", { reason }, "warn");
  if (run.cleanupExecutionAbort) run.cleanupExecutionAbort.abort();
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
function resolveRunnerCommand(command: string) {
  if (process.platform !== "win32" || path.extname(command)) return command;
  const result = spawnSync("where.exe", [command], { windowsHide: true });
  const candidates = result.stdout?.toString().split(/\r?\n/).map((item) => item.trim()).filter(Boolean) || [];
  return candidates.find((item) => /\.exe$/i.test(item))
    || candidates.find((item) => /\.cmd$/i.test(item))
    || command;
}

export function resolveInteractiveRunnerCommand(command: string): string {
  const resolved = resolveRunnerCommand(command);
  if (process.platform !== "win32" || !/\.cmd$/i.test(resolved) || !fs.existsSync(resolved)) return resolved;
  const shim = fs.readFileSync(resolved, "utf8");
  const nativeMatch = shim.match(/"([^"\r\n]*\.exe)"\s+%\*/i);
  if (!nativeMatch) return resolved;
  const shimRoot = `${path.dirname(resolved)}${path.sep}`;
  const nativeCommand = path.resolve(nativeMatch[1].replace(/%dp0%/gi, shimRoot));
  return fs.existsSync(nativeCommand) ? nativeCommand : resolved;
}
function cmdQuote(value: string) { return `"${value.replaceAll("\"", "\"\"")}"`; }

export function classifyCleanupFollowup(
  phase: CleanupAiWritePhase | undefined,
  text: string,
): CleanupAiWritePhase {
  const prompt = String(text || "").trim();
  if (phase === "awaiting_plan_confirmation") {
    return /^(确认|确认执行|可以执行了|按此执行|执行计划|可以|同意)[。.!！]?$/.test(prompt)
      ? "hierarchy"
      : "analysis";
  }
  if (phase === "awaiting_satisfaction") {
    return /^(满意|满意了|确认满意|效果满意|可以了)[。.!！]?$/.test(prompt)
      ? "variants"
      : "analysis";
  }
  throw new Error(`cleanup follow-up is not allowed in phase ${String(phase || "unknown")}`);
}

function settleCleanupPhase(run: AiRun, status: RunStatus): void {
  if (run.taskKind !== "cleanup" || !run.cleanupPhase) return;
  const previousPhase = run.cleanupPhase;
  if (status !== "completed") {
    run.cleanupPhase = status === "cancelled" ? "cancelled" : "failed";
    endCleanupAiWriteGuard(run.sessionId, run.runId);
    run.operation?.step("cleanup-phase", "AI 整理阶段已因回合终止而关闭写入权限", {
      previousPhase,
      cleanupPhase: run.cleanupPhase,
      status,
    }, status === "cancelled" ? "warn" : "error");
    return;
  }
  if (run.cleanupPhase === "analysis") run.cleanupPhase = "awaiting_plan_confirmation";
  else if (run.cleanupPhase === "hierarchy") run.cleanupPhase = "awaiting_satisfaction";
  else if (run.cleanupPhase === "variants") run.cleanupPhase = "finished";
  if (run.cleanupPhase === "finished") {
    endCleanupAiWriteGuard(run.sessionId, run.runId);
  } else {
    setCleanupAiWritePhase(run.sessionId, run.runId, run.cleanupPhase);
  }
  run.operation?.step("cleanup-phase", "AI 整理回合完成，服务端写入闸门已推进", {
    previousPhase,
    cleanupPhase: run.cleanupPhase,
    status,
  });
}

function cleanupSnapshotFrom(value: unknown): CleanupSnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.rootNodeId !== "string" || !Array.isArray(value.nodes)) {
    throw new Error("cleanup snapshot is required");
  }
  return value as unknown as CleanupSnapshotV1;
}

function validCliSessionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{7,}$/i.test(value);
}
