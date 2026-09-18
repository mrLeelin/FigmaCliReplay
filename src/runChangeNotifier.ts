/**
 * 进度订阅的变更通知。
 *
 * 数据源（AI 运行、整理运行、PSD/Figma 导入任务）在自身进度变化时调用 notifyRunChanged，
 * 网关收到通知后按订阅拉取一次视图并推送。这样订阅是"变化驱动"的：
 * 既不再需要每 250ms 无条件 get 一次，也让"仅在变化时推送"成为事实而非文档承诺。
 *
 * 键与订阅请求里的 runId / taskId 一致；通知是同步的，网关侧会做合并（同一轮事件循环只推一次）。
 */
export type RunChangeListener = () => void;

const listeners = new Map<string, Set<RunChangeListener>>();

/** 注册某个运行/任务的变更监听，返回解除函数。 */
export function watchRunChanges(key: string, listener: RunChangeListener): () => void {
  if (!key) return () => undefined;
  let bucket = listeners.get(key);
  if (!bucket) {
    bucket = new Set();
    listeners.set(key, bucket);
  }
  bucket.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

/** 宣告某个运行/任务的视图可能已变化。无订阅者时是空操作。 */
export function notifyRunChanged(key: string): void {
  if (!key) return;
  const bucket = listeners.get(key);
  if (!bucket || bucket.size === 0) return;
  for (const listener of [...bucket]) {
    try {
      listener();
    } catch {
      // 单个订阅失败不应影响其它订阅，也不应打断数据源自身的流程
    }
  }
}

/** 诊断/测试用：当前有订阅者的键。 */
export function watchedRunKeys(): string[] {
  return [...listeners.keys()];
}
