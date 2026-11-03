import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DxxConfig, DEFAULT_DXX_API_BASE } from "../dist/dxxConfig.js";
import { createRelayControlHandler } from "../dist/relayControl.js";

const SECRET = "fixture-dxx-key-do-not-echo";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-dxx-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, ".local", "dxx-config.json");
  return { root, configPath, service: new DxxConfig({ configPath, env: {}, ...options }) };
}

function publicOnly(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(SECRET), false, "public results must never include a key");
  assert.equal(serialized.includes('"apiKey"'), false, "public status must not expose a secret field");
  return value;
}

test("unconfigured status is local metadata and does not create a configuration", (t) => {
  const { service, configPath } = fixture(t);
  const status = publicOnly(service.get());
  assert.equal(status.ok, true);
  assert.equal(status.config.apiBase, DEFAULT_DXX_API_BASE);
  assert.equal(status.config.hasKey, false);
  assert.equal(status.config.keySource, "none");
  assert.match(status.config.skillPath.replaceAll("\\", "/"), /ai\/skills\/dxx-image\/SKILL\.md$/);
  assert.match(status.config.pythonCliPath.replaceAll("\\", "/"), /ai\/skills\/dxx-image\/scripts\/dxx_image\.py$/);
  assert.equal(fs.existsSync(configPath), false);
});

test("settings persist once for the Python client while all public replies omit credentials", (t) => {
  const { service, configPath } = fixture(t);
  const saved = publicOnly(service.set({ apiBase: "https://canvas.example/", apiKey: `  ${SECRET}  ` }));
  assert.equal(saved.config.apiBase, "https://canvas.example");
  assert.equal(saved.config.keySource, "project");
  assert.equal(saved.config.hasKey, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
    version: 1, apiBase: "https://canvas.example", apiKey: SECRET,
  });
  assert.equal(new DxxConfig({ configPath, env: {} }).get().config.keySource, "project");
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ["dxx-config.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test("saved project values override environment and blank input preserves the saved key", (t) => {
  const { service, configPath } = fixture(t, { env: { GORILLA_API_KEY: "environment-key", GORILLA_API_BASE: "https://environment.example" } });
  assert.equal(service.get().config.keySource, "environment");
  service.set({ apiBase: "https://project.example", apiKey: SECRET });
  const result = publicOnly(service.set({ apiKey: "  " }));
  assert.equal(result.config.apiBase, "https://project.example");
  assert.equal(result.config.keySource, "project");
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).apiKey, SECRET);
});

test("saving an empty legacy key persists the effective environment key across restart", (t) => {
  const { service, configPath } = fixture(t, { env: { GORILLA_API_KEY: SECRET } });
  assert.equal(service.get().config.keySource, "environment");
  const result = publicOnly(service.set({ apiKey: "" }));
  assert.equal(result.config.keySource, "project");
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).apiKey, SECRET);
  const reopened = new DxxConfig({ configPath, env: {} });
  assert.equal(publicOnly(reopened.get()).config.hasKey, true);
  assert.equal(reopened.readForSettings().config.apiKey, SECRET);
});

test("saving omitted key migrates a base-only legacy configuration and retains persisted key later", (t) => {
  const { service, configPath } = fixture(t, { env: { GORILLA_API_KEY: SECRET } });
  fs.mkdirSync(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, apiBase: "https://saved.example" }));
  const saved = publicOnly(service.set({}));
  assert.equal(saved.config.keySource, "project");
  assert.equal(saved.config.apiBase, "https://saved.example");
  const reopened = new DxxConfig({ configPath, env: { GORILLA_API_KEY: "different-environment-key" } });
  assert.equal(reopened.readForSettings().config.apiKey, SECRET);
  reopened.set({ apiKey: "" });
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).apiKey, SECRET);
});

test("explicit settings read returns the effective plaintext key without writing or changing default metadata", (t) => {
  const { service, configPath } = fixture(t, { env: { GORILLA_API_KEY: SECRET } });
  assert.equal(service.readForSettings().config.apiKey, SECRET);
  assert.equal(service.readForSettings().config.keySource, "environment");
  assert.equal(fs.existsSync(configPath), false, "reading settings must not create a file");
  publicOnly(service.get());
  service.set({ apiKey: "project-key" });
  const before = fs.readFileSync(configPath, "utf8");
  assert.equal(service.readForSettings().config.apiKey, "project-key");
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  publicOnly(service.get());
});

test("explicit clearing removes only the project key and reports environment fallback", (t) => {
  const { service, configPath } = fixture(t, { env: { GORILLA_API_KEY: SECRET } });
  service.set({ apiKey: "project-key" });
  assert.equal(service.get().config.keySource, "project");
  const result = publicOnly(service.set({ clearKey: true }));
  assert.equal(result.config.keySource, "environment");
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(configPath, "utf8")), "apiKey"), false);
  assert.throws(() => service.set({ clearKey: true, apiKey: "replacement" }), /不能同时/);
  assert.throws(() => service.set({ clearKey: "yes" }), /布尔值/);
});

test("malformed local configuration fails safely rather than using another account", (t) => {
  const { service, configPath } = fixture(t, { env: { GORILLA_API_KEY: SECRET } });
  fs.mkdirSync(path.dirname(configPath));
  for (const content of [`{"apiKey":"${SECRET}",`, "[]", '{"version":2}', '{"version":1,"apiBase":"http://invalid"}']) {
    fs.writeFileSync(configPath, content);
    assert.throws(() => service.get(), (error) => /无法读取本机 DXX 配置/.test(error.message) && !error.message.includes(SECRET));
  }
});

test("invalid addresses and malformed keys fail before any file or network write", async (t) => {
  let requests = 0;
  const { service, configPath } = fixture(t, { fetchImpl: async () => { requests++; throw new Error("must not run"); } });
  for (const apiBase of ["", null, 123, "http://canvas.example", "https://user:secret@canvas.example", "https://canvas.example/api", "https://canvas.example?key=" + SECRET, "https://canvas.example/#fragment", "https://canvas.example\n"]) {
    assert.throws(() => service.set({ apiBase }), /HTTPS/);
    await assert.rejects(service.test({ apiBase, apiKey: SECRET }), /HTTPS/);
  }
  for (const apiKey of [null, 123, {}, "bad\nkey", "bad\rkey", "bad key", "a".repeat(8193)]) {
    assert.throws(() => service.set({ apiKey }), /Key 格式/);
    await assert.rejects(service.test({ apiKey }), /Key 格式/);
  }
  await assert.rejects(service.test(), /请先输入/);
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(configPath), false);
});

test("connection tests authenticate only a readonly GET and never persist draft values", async (t) => {
  const calls = [];
  const { service, configPath } = fixture(t, { fetchImpl: async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ enabled: true, unexpected: SECRET }));
  } });
  service.set({ apiBase: "https://saved.example", apiKey: "saved-key" });
  const before = fs.readFileSync(configPath, "utf8");
  const result = publicOnly(await service.test({ apiBase: "https://draft.example", apiKey: SECRET }));
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.apiBase, "https://draft.example");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://draft.example/api/v1/layer-decomposition");
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.Authorization, "Bearer " + SECRET);
  assert.equal(calls[0][1].body, undefined);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("a valid explicit replacement can correct invalid environment configuration", async (t) => {
  const { service } = fixture(t, {
    env: { GORILLA_API_KEY: "broken\nvalue", GORILLA_API_BASE: "invalid-url" },
    fetchImpl: async () => new Response('{"enabled":true}'),
  });
  assert.equal((await service.test({ apiBase: "https://fixed.example", apiKey: SECRET })).ok, true);
  assert.equal(service.set({ apiBase: "https://fixed.example", apiKey: SECRET }).config.keySource, "project");
});

for (const [status, expected] of [[401, /Key 无效/], [403, /没有访问/], [429, /过于频繁/], [500, /暂不可用/], [302, /重定向/]]) {
  test(`HTTP ${status} reports a fixed safe message without echoing upstream text`, async (t) => {
    const { service } = fixture(t, { env: { GORILLA_API_KEY: SECRET }, fetchImpl: async () => new Response(SECRET, { status }) });
    await assert.rejects(service.test(), (error) => expected.test(error.message) && !error.message.includes(SECRET) && !error.stack.includes(SECRET));
  });
}

test("non-JSON, unexpected shape, and disabled service have explicit safe failures", async (t) => {
  for (const [body, expected] of [[SECRET, /无法识别/], ['{"unexpected":"' + SECRET + '"}', /无法识别/], ['{"enabled":false}', /尚未启用/]]) {
    const { service } = fixture(t, { env: { GORILLA_API_KEY: SECRET }, fetchImpl: async () => new Response(body) });
    await assert.rejects(service.test(), (error) => expected.test(error.message) && !error.message.includes(SECRET));
  }
});

test("network and response-body exceptions never expose upstream credentials", async (t) => {
  for (const fetchImpl of [async () => { throw new Error("Authorization Bearer " + SECRET); }, async () => ({ ok: true, status: 200, json: async () => { throw new Error(SECRET); } })]) {
    const { service } = fixture(t, { env: { GORILLA_API_KEY: SECRET }, fetchImpl });
    await assert.rejects(service.test(), (error) => !error.message.includes(SECRET) && !error.stack.includes(SECRET));
  }
});

test("timeout aborts an in-flight readonly test and remains bounded even if fetch ignores abort", async (t) => {
  let signal;
  const { service } = fixture(t, { timeoutMs: 15, env: { GORILLA_API_KEY: SECRET }, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(service.test(), /超时/);
  assert.equal(signal.aborted, true);
});

test("DXX controls route without a live Figma target and preserve payload boundaries", async () => {
  const calls = [];
  const dxx = {
    get: () => { calls.push(["get"]); return { ok: true, config: { hasKey: false } }; },
    readForSettings: () => { calls.push(["read"]); return { ok: true, config: { hasKey: true, apiKey: SECRET } }; },
    set: (payload) => { calls.push(["set", payload]); return { ok: true }; },
    test: async (payload) => { calls.push(["test", payload]); return { ok: true, enabled: true }; },
  };
  const control = createRelayControlHandler({ status: () => { throw new Error("No live session should be needed"); } }, {}, undefined, undefined, "", dxx);
  const draft = { apiKey: "fixture-route-key" };
  assert.deepEqual(await control("dxx.config.get", {}), { ok: true, config: { hasKey: false } });
  assert.equal((await control("dxx.config.read", {})).config.apiKey, SECRET);
  assert.equal((await control("dxx.config.set", draft)).ok, true);
  assert.equal((await control("dxx.config.test", draft)).enabled, true);
  assert.deepEqual(calls, [["get"], ["read"], ["set", draft], ["test", draft]]);
});
