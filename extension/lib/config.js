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
  INFLIGHT: "inflight",              // Map<sessionId, {taskId, submittedAt}>
  PAUSE: "paused_sessions",          // Set<sessionId>
  LAST_ERROR: "last_error",
  PENDING_REPLIES: "pending_replies", // Map<taskId, PendingReplyRecord>
};

// pending-reply state machine 常量。SW 每次 alarm tick 通过 sendMessage(poll-reply)
// 唤醒 content script 做单次 DOM 快照；见 service-worker.js pollOnePending。
export const POLL_REPLY_STABLE_SAMPLES = 2;      // 需要 N 次连续相同快照才判定 done
export const POLL_NOT_STARTED_MAX = 6;           // 连续 N 次都是 not-started 视为提交丢失
export const POLL_HARD_TIMEOUT_MS = 10 * 60_000; // pending 硬超时上限（10 分钟）
export const POLL_REPLY_SENDMSG_TIMEOUT_MS = 6000;