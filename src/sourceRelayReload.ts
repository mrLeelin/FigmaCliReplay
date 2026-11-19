import { readRelayBuild, type RelayBuild } from "../scripts/relay_build_stamp.mjs";
import { compareVersions } from "../scripts/update_common.mjs";
import type { RelayLogger } from "./logging/relayLogger.js";
import { drainRuntime } from "./updateActivity.js";

export function createSourceRelayReload(options: {
  root: string;
  version: string;
  activity: () => number;
  supervised: () => boolean;
  restart: () => void;
  logger: RelayLogger;
}) {
  const { root, version, activity, supervised, restart, logger } = options;
  const readBuild = (): RelayBuild | undefined => readRelayBuild(root);
  let runningId: string | undefined;
  if (supervised()) {
    try {
      const build = readBuild();
      if (build?.version === version) runningId = build.id;
    } catch (error) {
      logger.error("无法读取运行构建的标记，保留当前 Relay", error);
    }
  }

  let retry: NodeJS.Timeout | undefined;
  let operation: ReturnType<RelayLogger["startOperation"]> | undefined;
  let switching = false;

  function pluginOpened(sessionId: string) {
    if (!supervised() || operation || switching) return;
    const check = logger.startOperation("relay.source-reload", "检查本地 Relay 构建", { data: { sessionId, version } });
    try {
      const build = readBuild();
      const order = build ? compareVersions(build.version, version) : -1;
      check.step("compare", "比对运行构建与磁盘构建", { version, candidateVersion: build?.version });
      if (!build || build.id === runningId || order < 0 || (order === 0 && !runningId)) {
        check.succeed("继续使用当前 Relay", { changed: false });
        return;
      }

      operation = check;
      const targetId = build.id;
      let lastActivity: number | undefined;
      function waitUntilIdle() {
        try {
          if (!supervised()) {
            check.cancel("启动器已断开，保留当前 Relay");
            operation = undefined;
            return;
          }
          const count = activity();
          if (count !== lastActivity) {
            check.step("activity", "检查 Relay 是否可以切换", { activeCount: count });
            lastActivity = count;
          }
          if (count > 0) {
            retry = setTimeout(waitUntilIdle, 1000);
            return;
          }
          const ready = readRelayBuild(root, true);
          if (ready?.id !== targetId) {
            check.cancel("构建已变更，保留当前 Relay，等待下次检查");
            operation = undefined;
            return;
          }
          switching = true;
          drainRuntime();
          check.succeed("已完成切换检查，交由本地启动器加载新构建", { version: ready.version, buildId: ready.id });
          operation = undefined;
          restart();
        } catch (error) {
          check.fail(error, "构建校验失败，保留当前 Relay");
          operation = undefined;
        }
      }
      // 先让当前插件收到登记应答，关闭后由已有的重连流程再次登记。
      retry = setTimeout(waitUntilIdle, 250);
    } catch (error) {
      check.fail(error, "无法检查新构建，保留当前 Relay");
    }
  }

  return {
    pluginOpened,
    stop() {
      switching = true;
      if (retry) clearTimeout(retry);
      operation?.cancel("Relay 正在关闭");
      operation = undefined;
    },
  };
}
