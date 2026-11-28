import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 进程内 Relay 的全局日志默认读写仓库下的 .logs；本机日志很大时 logs.query 会超时。
// 必须在加载 dist/config.js 之前执行，因此由测试文件作为第一个 import 引入。
if (!process.env.FIGMA_RELAY_DATA_ROOT) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-data-"));
  process.env.FIGMA_RELAY_DATA_ROOT = dataRoot;
  process.on("exit", () => fs.rmSync(dataRoot, { recursive: true, force: true }));
}
