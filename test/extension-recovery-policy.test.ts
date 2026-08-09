import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRecoveryAction,
  classifySubmissionVerification,
  hasSendFence,
  isRecoverableLateReply,
} from "../extension/lib/recovery-policy.js";

function task(overrides: Record<string, unknown> = {}) {
  return {
    status: "in_progress",
    sendAttemptedAt: null,
    submitAcknowledgedAt: null,
    generatingSeenAt: null,
    replyDetectedAt: null,
    error: null,
    lateReply: null,
    lateReplyDeadlineAt: 50_000,
    ...overrides,
  };
}

test("post-attempt and legacy unknown records are fenced against automatic resend", () => {
  for (const deliveryPhase of [
    "send-attempted",
    "send-fenced",
    "send-clicked",
    "accepted",
    "unknown",
  ]) {
    assert.equal(hasSendFence({ deliveryPhase }, task()), true, deliveryPhase);
  }
  assert.equal(hasSendFence({}, task()), true, "legacy pending records must be conservative");
  assert.equal(hasSendFence({ deliveryPhase: "preparing" }, task()), false);
  assert.equal(
    hasSendFence({ deliveryPhase: "preparing" }, task({ sendAttemptedAt: 123 })),
    true,
  );
});

test("recovery reattaches fenced work and only defers proven pre-send work", () => {
  assert.equal(
    classifyRecoveryAction(task(), { deliveryPhase: "accepted" }, 1_000),
    "reattach",
  );
  assert.equal(
    classifyRecoveryAction(task(), { deliveryPhase: "send-clicked" }, 1_000),
    "reattach",
  );
  assert.equal(
    classifyRecoveryAction(
      task({ status: "recovering", recoveryReason: "task_deadline_exceeded" }),
      { deliveryPhase: "accepted" },
      1_000,
    ),
    "reattach",
  );
  assert.equal(
    classifyRecoveryAction(task(), { deliveryPhase: "preparing" }, 1_000),
    "defer",
  );
  assert.equal(
    classifyRecoveryAction(
      task({ status: "queued", sendAttemptedAt: 500 }),
      { deliveryPhase: "preparing" },
      1_000,
    ),
    "fail-uncertain",
  );
  assert.equal(
    classifyRecoveryAction(task({ status: "done" }), { deliveryPhase: "accepted" }, 1_000),
    "clear",
  );
});

test("eligible timeout failures reattach only inside the late-reply window", () => {
  for (const error of ["submission_not_observed", "submission_outcome_unknown"]) {
    const failed = task({ status: "failed", error, sendAttemptedAt: 100 });
    assert.equal(isRecoverableLateReply(failed, 1_000), true, error);
    assert.equal(classifyRecoveryAction(failed, {}, 1_000), "reattach", error);
    assert.equal(isRecoverableLateReply(failed, 60_000), false, error);
    assert.equal(classifyRecoveryAction(failed, {}, 60_000), "clear", error);
  }
});

test("recovery terminal errors retain bounded late-reply compatibility", () => {
  for (const error of ["task_recovery_timeout", "task_recovery_lease_expired"]) {
    const failed = task({ status: "failed", error, sendAttemptedAt: 100 });
    assert.equal(isRecoverableLateReply(failed, 1_000), true, error);
  }
});

test("uncertain delivery keeps a fixed verification window from the Send fence", () => {
  const record = {
    deliveryPhase: "send-clicked",
    submissionVerificationDeadlineAt: 6_000,
  };
  assert.equal(
    classifySubmissionVerification("not-started", record, true, 5_999),
    "wait",
  );
  assert.equal(
    classifySubmissionVerification("not-started", record, true, 6_000),
    "fail-not-observed",
  );
  assert.equal(
    classifySubmissionVerification(
      "not-started",
      { ...record, composerPayloadObservedAfterFailure: true },
      false,
      6_000,
    ),
    "fail-not-observed",
  );
  assert.equal(
    classifySubmissionVerification("not-started", record, false, 6_000),
    "fail-unknown",
  );
  assert.equal(
    classifySubmissionVerification(
      "not-started",
      { ...record, deliveryPhase: "accepted" },
      true,
      10_000,
    ),
    "acknowledged",
  );
});

test("visible submitted work never yields merely because newer work is queued", () => {
  assert.equal(
    classifySubmissionVerification(
      "posted-no-reply-yet",
      { deliveryPhase: "accepted", submissionVerificationDeadlineAt: 5_000 },
      false,
      10_000,
    ),
    "acknowledged",
  );
  assert.equal(
    classifySubmissionVerification(
      "generating",
      { wasGenerating: true, submissionVerificationDeadlineAt: 5_000 },
      false,
      10_000,
    ),
    "acknowledged",
  );
});
