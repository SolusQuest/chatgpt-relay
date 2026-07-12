// extension/lib/config.js
// SW 端共享配置。content-script 使用内联常量，不 import 此文件（content
// scripts 是 classic scripts，不能用 ES import）。
export const DEFAULT_BASE = "http://127.0.0.1:8765";

export const POLL_ALARM_NAME = "cgcon-poll";
export const HEARTBEAT_ALARM_NAME = "cgcon-heartbeat";

// alarms 最小周期是 1 分钟（Chrome 限制），使用组合：alarm 一次醒来，SW 内
// setTimeout 短周期递归。alarm 只用于保活。
export const POLL_INTERVAL_MS = 4000;
export const HEARTBEAT_INTERVAL_MS = 12000;
export const NEXT_TASK_WAIT_MS = 3000; // long-poll wait chunk

export const STORAGE_KEYS = {
  INFLIGHT: "inflight",       // Map<sessionId, {taskId, submittedAt}>
  PAUSE: "paused_sessions",   // Set<sessionId>
  LAST_ERROR: "last_error",
};