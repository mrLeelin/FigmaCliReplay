import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { compareVersions, parseSignedManifest, validateDownloadUrl } from "../scripts/update_common.mjs";
import { DATA_ROOT, INSTALL_ROOT, PLUGIN_ROOT, SERVER_VERSION } from "./config.js";
import { drainRuntime } from "./updateActivity.js";
import { isRecord } from "./utils.js";

export type UpdatePhase = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "preparing" | "waiting" | "installing" | "restart-required" | "rolled-back" | "failed";
interface ReleasePayload { schemaVersion: number; version: string; publishedAt: string; notes: string[]; archiveUrl: string; sha256: string; size: number; }
export interface UpdateStatus {
  ok: true; currentVersion: string; installed: boolean; configured: boolean; autoCheck: boolean;
  manifestUrl?: string; phase: UpdatePhase; message: string; canInstall: boolean; progress?: number; error?: string;
  latest?: Pick<ReleasePayload, "version" | "publishedAt" | "notes">;
  bridge?: { projectId: string; phase: string; message: string };
}
export interface UpdateServiceOptions {
  installRoot?: string; dataRoot?: string; projectRoot?: string; currentVersion?: string;
  activity?: () => number; shutdown?: () => void;
  refreshBridge?: () => Promise<void>;
  launchUpdater?: (planPath: string) => Promise<void>;
  fetchManifest?: (url: string) => Promise<unknown>;
}

const activePhases = new Set<UpdatePhase>(["downloading", "preparing", "waiting", "installing"]);
const phases = new Set<UpdatePhase>(["idle", "checking", "available", "up-to-date", ...activePhases, "restart-required", "rolled-back", "failed"]);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function writeUpdateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(value)) throw new Error("Invalid JSON object: " + path.basename(file));
    return value;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function fetchUpdateManifest(url: string): Promise<unknown> {
  let target = validateDownloadUrl(url);
  const signal = AbortSignal.timeout(15_000);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(target, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("更新源重定向过多。");
    target = validateDownloadUrl(new URL(location, target).href);
  }
  if (!response) throw new Error("更新源没有响应。");
  if (!response.ok || !response.body) throw new Error(`更新检查失败：HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw new Error("更新清单超出大小限制。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Only publisher-pinned metadata controls downloads; plugin input cannot choose paths or URLs. */
export class UpdateService {
  readonly installRoot: string | undefined;
  readonly directory: string;
  private readonly version: string;
  private readonly projectRoot: string;
  private envelope?: unknown;
  private latest?: ReleasePayload;
  private checkPromise?: Promise<UpdateStatus>;
  private launching = false;
  private localState?: Partial<UpdateStatus>;
  private shutdownAccepted = false;

  constructor(private readonly options: UpdateServiceOptions = {}) {
    this.installRoot = options.installRoot ?? INSTALL_ROOT;
    this.projectRoot = options.projectRoot ?? PLUGIN_ROOT;
    this.directory = path.join(options.dataRoot ?? DATA_ROOT, "updates");
    this.version = options.currentVersion ?? SERVER_VERSION;
  }

  private configuration(): { manifestUrl: string; publicKey: string; installed: boolean } {
    const record = this.installRoot ? readJson(path.join(this.installRoot, "install.json")) : undefined;
    const config = record ?? readJson(path.join(this.projectRoot, "release-config.json"));
    return { installed: Boolean(record && record.schemaVersion === 1),
      manifestUrl: typeof config?.manifestUrl === "string" ? config.manifestUrl : "",
      publicKey: typeof config?.publicKey === "string" ? config.publicKey : "" };
  }

  status(): UpdateStatus {
    const config = this.configuration();
    const settings = readJson(path.join(this.directory, "settings.json"));
    let stored = readJson(path.join(this.directory, "status.json"));
    const runner = readJson(path.join(this.directory, "runner.json"));
    if (stored && activePhases.has(stored.phase as UpdatePhase) && runner?.planId !== stored.planId
      && typeof stored.updatedAt === "string" && Date.now() - Date.parse(stored.updatedAt) > 30_000) {
      const lock = readJson(path.join(this.directory, "install.lock"));
      let installerAlive = false;
      if (typeof lock?.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0) {
        try { process.kill(lock.pid, 0); installerAlive = true; }
        catch (error) { installerAlive = !(isRecord(error) && error.code === "ESRCH"); }
      }
      if (!installerAlive) {
        stored = { ...stored, phase: "failed", message: "上次更新器未能启动，请运行安装目录中的“更新修复”后重试。", error: "The prepared plan has no running updater." };
        writeUpdateJson(path.join(this.directory, "status.json"), stored);
      }
    }
    if (stored && activePhases.has(stored.phase as UpdatePhase) && runner?.planId === stored.planId
      && typeof runner?.pid === "number" && Number.isSafeInteger(runner.pid) && runner.pid > 0) {
      try { process.kill(runner.pid, 0); }
      catch (error) {
        if (isRecord(error) && error.code === "ESRCH") {
          stored = { ...stored, phase: "failed", message: "更新器已中断，请运行安装目录中的“更新修复”后重试。", error: "Updater process exited before completing the recorded plan." };
          writeUpdateJson(path.join(this.directory, "status.json"), stored);
        }
      }
    }
    if (isRecord(stored?.bridge) && stored.bridge.phase === "pending-reconnect" && this.options.refreshBridge) {
      void this.options.refreshBridge().catch(() => { /* The Bridge worker records its own recoverable result. */ });
    }
    // The detached updater owns durable progress; a previous check must not hide it.
    const state = stored && activePhases.has(stored.phase as UpdatePhase) ? stored
      : this.localState ? { ...stored, ...this.localState } : stored;
    const phase = typeof state?.phase === "string" && phases.has(state.phase as UpdatePhase) ? state.phase as UpdatePhase : "idle";
    const latest = this.localState?.phase === "failed" && !this.envelope ? undefined
      : this.latest ?? (isRecord(stored?.latest) ? stored.latest as unknown as ReleasePayload : undefined);
    const configured = Boolean(config.manifestUrl && config.publicKey);
    return {
      ok: true, currentVersion: this.version, installed: config.installed, configured,
      autoCheck: settings?.autoCheck !== false, ...(config.manifestUrl ? { manifestUrl: config.manifestUrl } : {}), phase,
      message: typeof state?.message === "string" ? state.message : !configured ? "发布者尚未配置更新源。" : !config.installed ? "请先通过首次安装迁移到固定安装目录，再使用一键更新。" : "可检查最新版本。",
      canInstall: config.installed && configured && Boolean(latest && compareVersions(latest.version, this.version) > 0) && !activePhases.has(phase) && phase !== "checking",
      ...(latest ? { latest: { version: latest.version, notes: latest.notes, publishedAt: latest.publishedAt } } : {}),
      ...(typeof state?.progress === "number" ? { progress: state.progress } : {}),
      ...(typeof state?.error === "string" ? { error: state.error } : {}),
      ...(isRecord(stored?.bridge) ? { bridge: stored.bridge as unknown as UpdateStatus["bridge"] } : {}),
    };
  }

  settings(autoCheck: unknown): UpdateStatus {
    if (typeof autoCheck !== "boolean") throw new Error("autoCheck 必须为布尔值。");
    writeUpdateJson(path.join(this.directory, "settings.json"), { schemaVersion: 1, autoCheck });
    return this.status();
  }

  check(): Promise<UpdateStatus> {
    if (this.checkPromise) return this.checkPromise;
    if (activePhases.has(this.status().phase)) return Promise.resolve(this.status());
    this.checkPromise = this.performCheck().finally(() => { this.checkPromise = undefined; });
    return this.checkPromise;
  }

  private async performCheck(): Promise<UpdateStatus> {
    this.localState = { phase: "checking", message: "正在检查更新…" };
    try {
      const config = this.configuration();
      if (!config.manifestUrl || !config.publicKey) throw new Error("发布者尚未配置更新源。");
      const envelope = await (this.options.fetchManifest ?? fetchUpdateManifest)(config.manifestUrl);
      const latest = parseSignedManifest(envelope, config.publicKey) as ReleasePayload;
      this.envelope = envelope;
      this.latest = latest;
      const available = compareVersions(latest.version, this.version) > 0;
      this.localState = { phase: available ? "available" : "up-to-date", message: available ? `发现新版本 v${latest.version}。` : "当前已是最新版本。" };
    } catch (error) {
      this.envelope = undefined;
      this.latest = undefined;
      this.localState = { phase: "failed", message: messageOf(error), error: messageOf(error) };
    }
    return this.status();
  }

  async install(bridge?: { projectId: string; projectPath: string }): Promise<UpdateStatus> {
    if (this.launching || activePhases.has(this.status().phase)) return this.status();
    this.launching = true;
    try {
      const config = this.configuration();
      if (!config.installed || !this.installRoot) throw new Error("源码目录不能自动覆盖，请运行首次安装迁移到固定目录。");
      // A fresh verified feed prevents installing a cached or superseded offer.
      await this.check();
      if (!this.envelope || !this.latest || !this.status().canInstall) throw new Error(this.status().message || "没有可安装的新版本。");
      const runtime = readJson(path.join(this.options.dataRoot ?? DATA_ROOT, ".local", "runtime.json"));
      if (!runtime || runtime.pid !== process.pid || typeof runtime.instanceId !== "string") throw new Error("无法核对当前 Relay 实例，请通过固定目录启动器启动后重试。");
      const planId = randomUUID();
      const planFile = path.join(this.directory, "plan.json");
      writeUpdateJson(planFile, { schemaVersion: 1, planId, installRoot: this.installRoot, envelope: this.envelope, runtime,
        ...(bridge ? { updateBridgeProjectPath: bridge.projectPath, updateBridgeProjectId: bridge.projectId } : {}) });
      const initial = { schemaVersion: 1, planId, phase: "preparing", latest: this.latest, message: "更新器正在准备下载，新版本准备完成后才会切换。", updatedAt: new Date().toISOString(),
        ...(bridge ? { bridge: { projectId: bridge.projectId, phase: "pending", message: "等待应用更新完成后更新当前工程 Bridge。" } } : {}) };
      writeUpdateJson(path.join(this.directory, "status.json"), initial);
      this.localState = undefined;
      await (this.options.launchUpdater ?? ((file) => this.spawnUpdater(file)))(planFile);
      return this.status();
    } catch (error) {
      this.localState = { phase: "failed", message: messageOf(error), error: messageOf(error) };
      writeUpdateJson(path.join(this.directory, "status.json"), this.localState);
      return this.status();
    } finally { this.launching = false; }
  }

  private async spawnUpdater(planFile: string): Promise<void> {
    const updater = path.join(this.installRoot!, "updater", "apply_update.mjs");
    if (!fs.statSync(updater).isFile()) throw new Error("更新器缺失，请运行首次安装修复。");
    const log = fs.openSync(path.join(this.directory, "updater.log"), "a");
    try {
      const child = spawn(process.execPath, [updater, "--plan", planFile], { detached: true, windowsHide: true, stdio: ["ignore", log, log] });
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
      writeUpdateJson(path.join(this.directory, "runner.json"), { planId: readJson(planFile)?.planId, pid: child.pid, startedAt: new Date().toISOString() });
      child.unref();
    } finally { fs.closeSync(log); }
  }

  activity(): Record<string, unknown> {
    const activeCount = this.options.activity?.() ?? 0;
    return { ok: true, busy: activeCount > 0, activeCount, pid: process.pid, entry: path.join(this.projectRoot, "dist", "index.js"),
      instanceId: process.env.FIGMA_RELAY_INSTANCE_ID ?? "", version: this.version };
  }

  shutdown(planId: unknown): { ok: true } {
    const plan = readJson(path.join(this.directory, "plan.json"));
    if (!this.installRoot || typeof planId !== "string" || !planId || plan?.planId !== planId || !isRecord(plan.runtime)
      || plan.runtime.pid !== process.pid || plan.runtime.instanceId !== process.env.FIGMA_RELAY_INSTANCE_ID) throw new Error("更新计划与当前 Relay 实例不匹配。");
    if (this.activity().busy) throw new Error("Relay 仍有任务运行，等待任务完成后再更新。");
    if (!this.options.shutdown) throw new Error("当前 Relay 未提供安全停止入口。");
    if (!this.shutdownAccepted) {
      this.shutdownAccepted = true;
      drainRuntime();
      const timer = setTimeout(() => this.options.shutdown!(), 250);
      timer.unref();
    }
    return { ok: true };
  }
}
