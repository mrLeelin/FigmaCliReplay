import assert from "node:assert/strict";
import test from "node:test";

import { RelayLogger } from "../dist/logging/relayLogger.js";

function createHarness() {
  const events = [];
  const times = [
    new Date("2026-07-18T10:00:00.000Z"),
    new Date("2026-07-18T10:00:00.010Z"),
    new Date("2026-07-18T10:00:00.025Z"),
    new Date("2026-07-18T10:00:00.030Z"),
  ];
  const logger = new RelayLogger({
    source: "relay",
    module: "tests",
    emit: (event) => events.push(event),
    now: () => times.shift() ?? new Date("2026-07-18T10:00:00.030Z"),
    idFactory: () => "op-fixed",
  });
  return { events, logger };
}

test("operation scope emits start, ordered progress, and one success terminal", () => {
  const { events, logger } = createHarness();

  const operation = logger.startOperation("relay.submit", "开始提交命令", {
    command: "figma.create_rectangle",
  });
  operation.step("relay.validate", "参数校验完成");
  operation.succeed("命令提交成功", { requestId: "req-1" });

  assert.deepEqual(events.map(({ stepIndex, status }) => [stepIndex, status]), [
    [0, "started"],
    [1, "progress"],
    [2, "succeeded"],
  ]);
  assert.equal(events[2].durationMs, 25);
  assert.ok(events.every((event) => event.operationId === "op-fixed"));
  assert.equal(operation.completed, true);
});

test("operation scope converts failures into structured error details", () => {
  const { events, logger } = createHarness();
  const operation = logger.startOperation("relay.submit", "开始提交命令");
  const error = Object.assign(new Error("连接失败"), { code: "ECONNRESET" });

  operation.fail(error, "命令提交失败");

  assert.equal(events[1].status, "failed");
  assert.equal(events[1].level, "error");
  assert.equal(events[1].error.message, "连接失败");
  assert.equal(events[1].error.code, "ECONNRESET");
  assert.equal(events[1].durationMs, 10);
});

test("repeated terminal calls retain exactly one terminal event and emit a warning", () => {
  const { events, logger } = createHarness();
  const operation = logger.startOperation("relay.submit", "开始提交命令");

  operation.succeed("命令提交成功");
  operation.fail(new Error("late failure"), "不应覆盖结果");

  const terminals = events.filter((event) =>
    ["succeeded", "failed", "cancelled"].includes(event.status));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].status, "succeeded");
  assert.equal(events.at(-1).level, "warn");
  assert.equal(events.at(-1).step, "operation.terminal.ignored");
});
