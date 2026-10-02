// server/routes/v1-tasks.ts
// Public API for task submission, lookup, cancellation, and listing.
import { Router } from "express";
import type { Request, Response } from "express";
import type { TaskStore, Task, TaskObservation, TaskStatus } from "../task-store.js";
import { TaskStoreError, TERMINAL_STATUSES } from "../task-store.js";
import { longPollTask } from "../long-poll.js";
import { asPositiveInt, isValidSessionId } from "../util.js";
import { tryFixEncoding } from "../encoding-fix.js";
import { errorInfo } from "../error-info.js";

const VALID_STATUSES: readonly TaskStatus[] = [
  "queued",
  "in_progress",
  "recovering",
  "done",
  "failed",
  "cancelled",
  "expired",
];

export const SUBMISSION_VERIFICATION_MS = 2 * 60_000;

export type SubmissionState =
  | "not_attempted"
  | "verifying"
  | "acknowledged"
  | "replied"
  | "not_observed"
  | "unknown";

export interface TaskView {
  sessionRef: string | null;
  conversationId: string | null;
  taskId: string;
  session: string;
  clientRequestId: string | null;
  status: TaskStatus;
  text?: string;
  reply: string | null;
  lateReply: string | null;
  error: string | null;
  errorInfo: ReturnType<typeof errorInfo> | null;
  timeoutMs: number;
  submittedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  lateCompletedAt: number | null;
  submitStartedAt: number | null;
  sendAttemptedAt: number | null;
  submissionState: SubmissionState;
  submissionVerificationDeadlineAt: number | null;
  submitAcknowledgedAt: number | null;
  generatingSeenAt: number | null;
  replyDetectedAt: number | null;
  recoveryStartedAt: number | null;
  recoveryObservedAt: number | null;
  recoveryReason: string | null;
  expiresAt: number;
  completionDeadlineAt: number;
  recoveryLeaseDeadlineAt: number | null;
  recoveryDeadlineAt: number;
  lateReplyDeadlineAt: number;
  requeueCount: number;
  progress: TaskObservation | null;
}

function getSubmissionState(t: Task): SubmissionState {
  if (t.reply !== null || t.lateReply !== null) return "replied";
  if (t.error === "submission_not_observed") return "not_observed";
  if (t.error === "submission_outcome_unknown") return "unknown";
  if (t.submitAcknowledgedAt !== null || t.generatingSeenAt !== null) {
    return "acknowledged";
  }
  if (t.sendAttemptedAt !== null) return "verifying";
  return "not_attempted";
}

export function toTaskView(store: TaskStore, t: Task, includeText = false): TaskView {
  const submissionState = getSubmissionState(t);
  const v: TaskView = {
    sessionRef: store.registry.get(t.session)?.ref ?? null,
    conversationId: store.registry.get(t.session)?.conversation ?? null,
    taskId: t.id,
    session: t.session,
    clientRequestId: t.clientRequestId,
    status: t.status,
    reply: t.reply,
    lateReply: t.lateReply,
    error: t.error,
    errorInfo: t.error ? errorInfo(t.error, t) : null,
    timeoutMs: t.timeoutMs,
    submittedAt: t.submittedAt,
    dispatchedAt: t.dispatchedAt,
    completedAt: t.completedAt,
    lateCompletedAt: t.lateCompletedAt,
    submitStartedAt: t.submitStartedAt,
    sendAttemptedAt: t.sendAttemptedAt,
    submissionState,
    submissionVerificationDeadlineAt:
      submissionState === "verifying" && t.sendAttemptedAt !== null
        ? t.sendAttemptedAt + SUBMISSION_VERIFICATION_MS
        : null,
    submitAcknowledgedAt: t.submitAcknowledgedAt,
    generatingSeenAt: t.generatingSeenAt,
    replyDetectedAt: t.replyDetectedAt,
    recoveryStartedAt: t.recoveryStartedAt,
    recoveryObservedAt: t.recoveryObservedAt,
    recoveryReason: t.recoveryReason,
    expiresAt: t.expiresAt,
    completionDeadlineAt: t.expiresAt + store.getActiveTaskGraceMs(),
    recoveryLeaseDeadlineAt: store.getRecoveryLeaseDeadlineAt(t),
    recoveryDeadlineAt: store.getRecoveryDeadlineAt(t),
    lateReplyDeadlineAt: store.getLateReplyDeadlineAt(t),
    requeueCount: t.requeueCount,
    progress: store.getTaskObservation(t.id),
  };
  if (includeText) v.text = t.text;
  return v;
}

export function createV1TasksRouter(store: TaskStore): Router {
  const router = Router();
  router.get("/tasks/:id/trace", (req, res) => {
    if (!store.getTask(String(req.params.id))) return res.status(404).json({ error: "task_not_found" });
    res.json(store.traceTask(String(req.params.id)));
  });

  // Create a task.
  router.post("/tasks", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      session?: unknown;
      sessionRef?: unknown;
      text?: unknown;
      timeout?: unknown;
      clientRequestId?: unknown;
    };
    if ((body.session !== undefined) === (body.sessionRef !== undefined)) {
      return res.status(400).json({ error: "provide exactly one of session or sessionRef" });
    }
    if (body.sessionRef !== undefined) {
      const row = store.registry.requireRef(body.sessionRef);
      body.session = row.canonical;
    }
    if (!isValidSessionId(body.session)) {
      return res.status(400).json({ error: "invalid session" });
    }
    if (typeof body.text !== "string" || body.text.length === 0) {
      return res.status(400).json({ error: "missing text" });
    }
    const timeoutMs = asPositiveInt(body.timeout) ?? undefined;
    if (body.clientRequestId !== undefined && (typeof body.clientRequestId !== "string" ||
      !body.clientRequestId.trim() || body.clientRequestId.length > 128)) {
      return res.status(400).json({ error: "invalid clientRequestId" });
    }
    const clientRequestId =
      typeof body.clientRequestId === "string" ? body.clientRequestId : null;
    const fix = tryFixEncoding(body.text);
    if (fix.fixed) console.warn(`[v1/tasks] encoding-fix ${fix.method}: ${fix.note}`);
    else if (fix.method === "ascii-lossy-warn") console.warn(`[v1/tasks] encoding-warn: ${fix.note}`);
    try {
      const task = store.createTask({
        session: body.session,
        text: fix.text,
        timeoutMs,
        clientRequestId,
      });
      const payload: { taskId: string; status: string; encodingWarning?: string; encodingFixed?: string } = { taskId: task.id, status: task.status };
      if (fix.method === "ascii-lossy-warn") payload.encodingWarning = fix.note;
      if (fix.fixed) payload.encodingFixed = `${fix.method}: ${fix.note}`;
      return res.status(201).json(payload);
    } catch (err) {
      return respondStoreError(res, err);
    }
  });

  // Read one task and optionally long-poll until it becomes terminal.
  router.get("/tasks/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const wait = asPositiveInt(req.query.wait) ?? 0;
    const capped = Math.min(wait, 60_000); // Cap at 60 seconds.
    const progressAfterRaw = req.query.progress_after;
    let progressAfter: number | null = null;
    if (progressAfterRaw !== undefined) {
      if (typeof progressAfterRaw !== "string") {
        return res.status(400).json({ error: "invalid progress_after" });
      }
      const parsed = Number(progressAfterRaw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return res.status(400).json({ error: "invalid progress_after" });
      }
      progressAfter = parsed;
    }
    const task = await longPollTask(store, {
      taskId: id,
      timeoutMs: capped,
      isDone: (t) =>
        TERMINAL_STATUSES.includes(t.status) ||
        (progressAfter !== null &&
          (store.getTaskObservation(t.id)?.revision ?? 0) > progressAfter),
    });
    if (!task) return res.status(404).json({ error: "task not found" });
    return res.json(toTaskView(store, task, true));
  });

  // Cancel a task.
  router.delete("/tasks/:id", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    try {
      const task = store.cancelTask(id);
      return res.json(toTaskView(store, task));
    } catch (err) {
      return respondStoreError(res, err);
    }
  });

  // List tasks.
  router.get("/tasks", (req: Request, res: Response) => {
    const session =
      typeof req.query.session === "string" ? req.query.session : undefined;
    if (req.query.session !== undefined && req.query.sessionRef !== undefined) {
      return res.status(400).json({ error: "provide one session selector" });
    }
    const refSession = req.query.sessionRef !== undefined
      ? store.registry.requireRef(String(req.query.sessionRef)).canonical : undefined;
    const statusRaw = req.query.status;
    let status: TaskStatus | TaskStatus[] | undefined;
    if (typeof statusRaw === "string" && statusRaw.length > 0) {
      const parts = statusRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is TaskStatus =>
          (VALID_STATUSES as readonly string[]).includes(s),
        );
      status = parts.length === 1 ? parts[0] : parts;
    }
    const since = asPositiveInt(req.query.since) ?? undefined;
    const limit = asPositiveInt(req.query.limit) ?? undefined;
    const includeText = req.query.include_text === "1";
    const requestId = req.query.clientRequestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !requestId.trim() || requestId.length > 128)) {
      return res.status(400).json({ error: "invalid clientRequestId" });
    }
    const rows = store.listTasks({ session: refSession ?? session, status, since, limit,
      clientRequestId: typeof requestId === "string" ? requestId : undefined });
    return res.json({ tasks: rows.map((r) => toTaskView(store, r, includeText)) });
  });

  return router;
}

function respondStoreError(res: Response, err: unknown): Response {
  if (err instanceof TaskStoreError) {
    const codeMap: Record<TaskStoreError["code"], number> = {
      session_paused: 409,
      queue_full: 429,
      task_too_large: 413,
      task_not_found: 404,
      invalid_transition: 409,
      unsafe_retry_after_send_attempt: 409,
      duplicate_request: 409,
    };
    return res.status(codeMap[err.code]).json({ error: err.code, message: err.message });
  }
  console.error("[v1] unexpected error:", err);
  return res
    .status(500)
    .json({ error: "internal_error", message: (err as Error)?.message });
}
