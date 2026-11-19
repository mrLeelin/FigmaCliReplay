import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RelayLogger } from "../dist/logging/relayLogger.js";
import { readRelayBuild } from "./relay_build_stamp.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const logger = new RelayLogger({ module: "relay-supervisor", emit: event => process.stderr.write(`${JSON.stringify(event)}\n`) });
let child;
let stopping = false;
const stop = () => {
  stopping = true;
  child?.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

let failures = 0;
while (!stopping) {
  const started = Date.now();
  const operation = logger.startOperation("relay.supervise", "启动本地 Relay");
  let delay = 0;
  try {
    const build = readRelayBuild(root, true);
    child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
      cwd: root,
      env: { ...process.env, FIGMA_RELAY_SOURCE_SUPERVISED: "1" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    operation.step("spawn", "已创建 Relay 进程", { pid: child.pid, version: build?.version, buildId: build?.id });
    const [code, signal] = await once(child, "exit");
    child = undefined;
    if (stopping || code === 0) {
      operation.succeed("Relay 正常关闭", { code, signal });
      break;
    }
    if (code === 75) {
      operation.succeed("启动器将加载已校验的新构建");
      failures = 0;
    } else {
      throw new Error(`Relay exited unexpectedly (${code ?? signal}).`);
    }
  } catch (error) {
    child = undefined;
    if (Date.now() - started >= 15000) failures = 0;
    delay = Math.min(15000, 1000 * 2 ** Math.min(4, failures++));
    operation.step("retry", "等待后重新启动 Relay", { delayMs: delay, attempt: failures });
    operation.fail(error, "Relay 进程未能保持运行");
  }
  if (!stopping && delay > 0) await sleep(delay);
}
