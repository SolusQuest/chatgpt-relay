export type RecoveryAction =
  | "clear"
  | "defer"
  | "fail-uncertain"
  | "reattach"
  | "wait";

export interface RecoveryRecord {
  deliveryPhase?: string | null;
  phase?: string | null;
  ackState?: string | null;
  uncertainIdleSince?: number | null;
  hardTimedOutAt?: number | null;
  [key: string]: unknown;
}

export interface RecoveryTask {
  status?: string;
  sendAttemptedAt?: number | null;
  submitAcknowledgedAt?: number | null;
  generatingSeenAt?: number | null;
  replyDetectedAt?: number | null;
  error?: string | null;
  lateReply?: string | null;
  lateReplyDeadlineAt?: number | null;
  [key: string]: unknown;
}

export function hasSendFence(
  record?: RecoveryRecord,
  task?: RecoveryTask,
): boolean;

export function isRecoverableLateReply(
  task: RecoveryTask,
  now?: number,
): boolean;

export function shouldYieldPendingToQueuedTask(
  snapshotStatus: string,
  record?: RecoveryRecord,
  hasQueuedTask?: boolean,
  now?: number,
  uncertainIdleReleaseMs?: number,
): boolean;

export function classifyRecoveryAction(
  task: RecoveryTask | null,
  record?: RecoveryRecord,
  now?: number,
): RecoveryAction;
