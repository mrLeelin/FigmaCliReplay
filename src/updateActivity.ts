/** The drain barrier is set only after all existing work has finished. */
let draining = false;
let controls = 0;

export function assertRuntimeAcceptingWork(): void {
  if (draining) throw new Error("Relay 正在切换版本，请稍后重新连接。");
}

export function beginRuntimeControl(): () => void {
  assertRuntimeAcceptingWork();
  controls++;
  let released = false;
  return () => { if (!released) { released = true; controls--; } };
}

export function activeRuntimeControls(): number { return controls; }
export function drainRuntime(): void { draining = true; }
