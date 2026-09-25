// extension/lib/config.js
// Shared service-worker configuration. The classic content script cannot import
// this module, so it keeps its constants inline.
export const DEFAULT_BASE = "http://127.0.0.1:8765";

export const POLL_ALARM_NAME = "gpt-relay-poll";
export const HEARTBEAT_ALARM_NAME = "gpt-relay-heartbeat";

// Chrome alarms have a one-minute minimum. An alarm wakes the service worker,
// then short setTimeout recursion handles active work; alarms provide a fallback.
export const POLL_INTERVAL_MS = 4000;
export const HEARTBEAT_INTERVAL_MS = 12000;
// Per-session dispatch loop: long-poll duration and retry interval.
export const NEXT_TASK_WAIT_MS = 25000; // Matches the server next_task long poll.
export const DISPATCH_LOOP_RETRY_MS = 2000;

export const STORAGE_KEYS = {
  INFLIGHT: "inflight",              // Map<sessionId, {taskId, submittedAt}>
  PAUSE: "paused_sessions",          // Set<sessionId>
  LAST_ERROR: "last_error",
  PENDING_REPLIES: "pending_replies", // Map<taskId, PendingReplyRecord>
  ATTACHMENT_BLOCKS: "attachment_blocked_sessions", // Map<sessionId, {reason, at, cleanSince?}>
};

// Pending-reply state-machine constants. The service worker requests one DOM
// snapshot at a time through poll-reply; see pollOnePending.
export const POLL_REPLY_STABLE_SAMPLES = 2;      // Identical samples required for completion.
export const POLL_NOT_STARTED_MAX = 6;           // Pre-send-only not-started samples before failure.
export const POLL_HARD_TIMEOUT_MS = 15 * 60_000; // Fallback for legacy pending records.
export const POLL_LATE_REPLY_GRACE_MS = 30 * 60_000;
export const SUBMISSION_VERIFICATION_MS = 2 * 60_000;
export const RECOVERY_OBSERVATION_INTERVAL_MS = 30_000;
export const TASK_OBSERVATION_CHANGE_INTERVAL_MS = 10_000;
export const TASK_OBSERVATION_HEARTBEAT_INTERVAL_MS = 30_000;
export const ATTACHMENT_BLOCK_CLEAN_STABLE_MS = 5_000;
export const POLL_REPLY_SENDMSG_TIMEOUT_MS = 6000;
// Covers the content script's bounded page/composer wait plus a large-paste
// upload, Send readiness, and submission acceptance.
export const RUN_TASK_ACK_TIMEOUT_MS = 240_000;
export const PAGE_STATE_SENDMSG_TIMEOUT_MS = 5000;
