// server/long-poll.ts
// 帮助函数：给定一个"读快照"和"是否满足退出条件"，用 TaskStore 的事件做长轮询。
import type { TaskStore, Task } from "./task-store.js";

export interface LongPollTaskOptions {
  taskId: string;
  timeoutMs: number;
  isDone: (task: Task) => boolean;
}

export async function longPollTask(
  store: TaskStore,
  opts: LongPollTaskOptions,
): Promise<Task | null> {
  const initial = store.getTask(opts.taskId);
  if (!initial) return null;
  if (opts.isDone(initial)) return initial;
  if (opts.timeoutMs <= 0) return initial;

  return new Promise<Task | null>((resolve) => {
    let finished = false;
    const off = store.onTaskChange(opts.taskId, (task) => {
      if (finished) return;
      if (opts.isDone(task)) {
        finished = true;
        cleanup();
        resolve(task);
      }
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(store.getTask(opts.taskId));
    }, opts.timeoutMs);
    const cleanup = () => {
      off();
      clearTimeout(timer);
    };
  });
}

export async function longPollSession<T>(
  store: TaskStore,
  sessionId: string,
  timeoutMs: number,
  attempt: () => T | null,
): Promise<T | null> {
  const first = attempt();
  if (first != null) return first;
  if (timeoutMs <= 0) return null;

  return new Promise<T | null>((resolve) => {
    let finished = false;
    const off = store.onSessionTaskChange(sessionId, () => {
      if (finished) return;
      const v = attempt();
      if (v != null) {
        finished = true;
        cleanup();
        resolve(v);
      }
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      off();
      clearTimeout(timer);
    };
  });
}