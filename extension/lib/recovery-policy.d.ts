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
  submissionVerificationDeadlineAt?: number | null;
    submissionAcknowledged?: boolean;
    wasGenerating?: boolean;
    composerPayloadObservedAfterFailure?: boolean;
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

export function classifySubmissionVerification(
  snapshotStatus: string,
  record?: RecoveryRecord,
  composerHasPayload?: boolean,
  now?: number,
): "acknowledged" | "wait" | "fail-not-observed" | "fail-unknown";

export function classifyRecoveryAction(
  task: RecoveryTask | null,
  record?: RecoveryRecord,
  now?: number,
): RecoveryAction;
