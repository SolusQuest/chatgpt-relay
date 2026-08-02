// Pure recovery policy shared by the service worker and Node-based tests.
//
// ChatGPT does not expose an idempotency key to DOM automation. Once a Send
// attempt may have happened, automatic replay is unsafe: an empty DOM can mean
// either "not submitted" or simply "the refreshed page has not hydrated yet".
const PROVEN_PRE_SEND_PHASES = new Set([
  "unattempted",
  "preparing",
  "not-submitted",
]);

const LATE_REPLY_ERRORS = new Set([
  "task_processing_timeout",
  "submission_outcome_unknown",
  "task_recovery_timeout",
  "task_recovery_lease_expired",
  "session_heartbeat_lost",
  "aborted",
]);

export function hasSendFence(record = {}, task = {}) {
  if (
    task.sendAttemptedAt != null ||
    task.submitAcknowledgedAt != null ||
    task.generatingSeenAt != null ||
    task.replyDetectedAt != null
  ) {
    return true;
  }

  const phase = record.deliveryPhase ?? record.phase ?? record.ackState;
  // Legacy pending records did not always persist a delivery phase. They were
  // created only after run-task could have crossed the Send boundary, so the
  // safe interpretation is "possibly submitted".
  if (phase == null) return true;
  return !PROVEN_PRE_SEND_PHASES.has(phase);
}

export function isRecoverableLateReply(task, now = Date.now()) {
  return task?.status === "failed" &&
    task.lateReply == null &&
    LATE_REPLY_ERRORS.has(task.error) &&
    typeof task.lateReplyDeadlineAt === "number" &&
    task.lateReplyDeadlineAt > now;
}

export function shouldYieldPendingToQueuedTask(
  snapshotStatus,
  record = {},
  hasQueuedTask = false,
  now = Date.now(),
  uncertainIdleReleaseMs = 5_000,
) {
  if (!hasQueuedTask) return false;

  if (snapshotStatus === "not-started") {
    return typeof record.uncertainIdleSince === "number" &&
      now - record.uncertainIdleSince >= uncertainIdleReleaseMs;
  }

  // A visible submitted user message is strong task evidence. It reserves the
  // session until the task itself reaches a terminal transition.
  return false;
}

export function classifyRecoveryAction(task, record = {}, now = Date.now()) {
  if (!task) return "wait";
  if (task.status === "done" || task.status === "cancelled" || task.status === "expired") {
    return "clear";
  }
  if (task.status === "failed") {
    return isRecoverableLateReply(task, now) && hasSendFence(record, task)
      ? "reattach"
      : "clear";
  }

  const fenced = hasSendFence(record, task);
  if (task.status === "queued") {
    return fenced ? "fail-uncertain" : "clear";
  }
  if (task.status === "in_progress") {
    return fenced ? "reattach" : "defer";
  }
  if (task.status === "recovering") {
    return fenced ? "reattach" : "clear";
  }
  return "wait";
}
