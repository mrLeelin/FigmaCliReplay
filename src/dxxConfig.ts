import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOCAL_DIR, PLUGIN_ROOT } from "./config.js";

export const DEFAULT_DXX_API_BASE = "https://canvas.dxx.cn";

interface StoredDxxConfig {
  version: 1;
  apiBase: string;
  apiKey?: string;
}

interface DxxConfigOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface EffectiveDxxConfig {
  apiBase: string;
  apiKey: string;
  keySource: "project" | "environment" | "none";
}

/** Errors from this module contain fixed local messages, never upstream bodies or credentials. */
class DxxConfigError extends Error {}

function apiBase(value: unknown): string {
  const invalid = () => new DxxConfigError("DXX API 地址必须是 HTTPS 源站，不能包含路径、账号或查询参数。");
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw invalid(); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash || /[?#]/.test(value)) throw invalid();
  return parsed.origin;
}

function apiKey(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DxxConfigError("DXX Key 格式无效，请输入不含换行的 Key。");
  }
  const key = value.trim();
  if (key.length > 8192 || /\s/.test(key)) throw new DxxConfigError("DXX Key 格式无效，请检查 Key 内容。");
  return key;
}

/** Project-local credentials shared by the settings UI and the bundled Python client. */
export class DxxConfig {
  private readonly configPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DxxConfigOptions = {}) {
    this.configPath = path.resolve(options.configPath ?? path.join(LOCAL_DIR, "dxx-config.json"));
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  private readStored(): StoredDxxConfig | undefined {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const value = parsed as Record<string, unknown>;
      if (value.version !== 1) throw new Error();
      const savedBase = apiBase(value.apiBase);
      const savedKey = value.apiKey === undefined ? "" : apiKey(value.apiKey);
      return { version: 1, apiBase: savedBase, ...(savedKey ? { apiKey: savedKey } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DxxConfigError("无法读取本机 DXX 配置，请检查配置文件格式和权限。");
    }
  }

  private effective(stored = this.readStored()) {
    const projectKey = stored?.apiKey || "";
    const environmentKey = projectKey ? "" : apiKey(this.env.GORILLA_API_KEY || "");
    return {
      apiBase: stored?.apiBase ?? apiBase(this.env.GORILLA_API_BASE || DEFAULT_DXX_API_BASE),
      apiKey: projectKey || environmentKey,
      keySource: projectKey ? "project" as const : environmentKey ? "environment" as const : "none" as const,
    };
  }

  private metadata(effective: EffectiveDxxConfig) {
    return {
      apiBase: effective.apiBase,
      hasKey: Boolean(effective.apiKey),
      keySource: effective.keySource,
      configPath: this.configPath,
      skillPath: path.join(PLUGIN_ROOT, "ai", "skills", "dxx-image", "SKILL.md"),
      pythonCliPath: path.join(PLUGIN_ROOT, "ai", "skills", "dxx-image", "scripts", "dxx_image.py"),
    };
  }

  get() {
    return { ok: true as const, config: this.metadata(this.effective()) };
  }

  /** Explicit settings readback requested by the user; this response must not be logged. */
  readForSettings() {
    const effective = this.effective();
    return { ok: true as const, config: { ...this.metadata(effective), apiKey: effective.apiKey } };
  }

  set(payload: Record<string, unknown>) {
    const stored = this.readStored();
    if (payload.clearKey !== undefined && typeof payload.clearKey !== "boolean") {
      throw new DxxConfigError("清除 Key 的选项必须为布尔值。");
    }
    const nextKey = payload.apiKey === undefined ? "" : apiKey(payload.apiKey);
    if (payload.clearKey === true && nextKey) throw new DxxConfigError("清除 Key 时不能同时输入新 Key。");
    const key = payload.clearKey === true ? ""
      : nextKey || stored?.apiKey || apiKey(this.env.GORILLA_API_KEY || "");
    const next: StoredDxxConfig = {
      version: 1,
      apiBase: payload.apiBase === undefined
        ? stored?.apiBase ?? apiBase(this.env.GORILLA_API_BASE || DEFAULT_DXX_API_BASE)
        : apiBase(payload.apiBase),
      ...(key ? { apiKey: key } : {}),
    };
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporaryPath, this.configPath);
    } catch {
      try { fs.unlinkSync(temporaryPath); } catch { /* No temporary file may have been created. */ }
      throw new DxxConfigError("保存 DXX 配置失败，请检查本机配置目录权限。");
    }
    return this.get();
  }

  async test(payload: Record<string, unknown> = {}) {
    const stored = this.readStored();
    const base = payload.apiBase === undefined
      ? stored?.apiBase ?? apiBase(this.env.GORILLA_API_BASE || DEFAULT_DXX_API_BASE)
      : apiBase(payload.apiBase);
    const key = (payload.apiKey === undefined ? "" : apiKey(payload.apiKey))
      || stored?.apiKey || apiKey(this.env.GORILLA_API_KEY || "");
    if (!key) throw new DxxConfigError("请先输入 DXX Key。");

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = async () => {
        const response = await this.fetchImpl(`${base}/api/v1/layer-decomposition`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new DxxConfigError("DXX 接口返回重定向，请检查 API 地址。");
        }
        if (response.status === 401) throw new DxxConfigError("DXX Key 无效或已失效，请检查后重试。");
        if (response.status === 403) throw new DxxConfigError("DXX Key 没有访问拆层接口的权限。");
        if (response.status === 429) throw new DxxConfigError("DXX 请求过于频繁，请稍后重试。");
        if (!response.ok) throw new DxxConfigError("DXX 接口暂不可用，请稍后重试。");
        let body: unknown;
        try { body = await response.json(); } catch { throw new DxxConfigError("DXX 接口返回了无法识别的响应。"); }
        if (!body || typeof body !== "object" || Array.isArray(body)
          || typeof (body as Record<string, unknown>).enabled !== "boolean") {
          throw new DxxConfigError("DXX 接口返回了无法识别的响应。");
        }
        if ((body as Record<string, unknown>).enabled !== true) {
          throw new DxxConfigError("DXX Key 验证通过，但图片拆层服务尚未启用。");
        }
        return { ok: true as const, apiBase: base, enabled: true as const, message: "连接成功，Key 有效，图片拆层服务已启用。" };
      };
      return await Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DxxConfigError("DXX 连接测试超时，请检查网络后重试。"));
          }, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw new DxxConfigError("DXX 连接测试超时，请检查网络后重试。");
      if (error instanceof DxxConfigError) throw error;
      throw new DxxConfigError("无法连接 DXX，请检查网络和 API 地址。");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
