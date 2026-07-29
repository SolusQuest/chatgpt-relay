// server/routes/v1-tasks.ts
// Public API for task submission, lookup, cancellation, and listing.
import { Router } from "express";
import type { Request, Response } from "express";
import type { TaskStore, Task, TaskStatus } from "../task-store.js";
import { TaskStoreError, TERMINAL_STATUSES } from "../task-store.js";
import { longPollTask } from "../long-poll.js";
import { asPositiveInt, isValidSessionId } from "../util.js";
import { tryFixEncoding } from "../encoding-fix.js";

const VALID_STATUSES: readonly TaskStatus[] = [
  "queued",
  "in_progress",
  "done",
  "failed",
  "cancelled",
  "expired",
];

export interface TaskView {
  taskId: string;
  session: string;
  clientRequestId: string | null;
  status: TaskStatus;
  text?: string;
  reply: string | null;
  lateReply: string | null;
  error: string | null;
  timeoutMs: number;
  submittedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  lateCompletedAt: number | null;
  submitStartedAt: number | null;
  sendAttemptedAt: number | null;
  submitAcknowledgedAt: number | null;
  generatingSeenAt: number | null;
  replyDetectedAt: number | null;
  expiresAt: number;
  completionDeadlineAt: number;
  lateReplyDeadlineAt: number;
  requeueCount: number;
}

export function toTaskView(store: TaskStore, t: Task, includeText = false): TaskView {
  const v: TaskView = {
    taskId: t.id,
    session: t.session,
    clientRequestId: t.clientRequestId,
    status: t.status,
    reply: t.reply,
    lateReply: t.lateReply,
    error: t.error,
    timeoutMs: t.timeoutMs,
    submittedAt: t.submittedAt,
    dispatchedAt: t.dispatchedAt,
    completedAt: t.completedAt,
    lateCompletedAt: t.lateCompletedAt,
    submitStartedAt: t.submitStartedAt,
    sendAttemptedAt: t.sendAttemptedAt,
    submitAcknowledgedAt: t.submitAcknowledgedAt,
    generatingSeenAt: t.generatingSeenAt,
    replyDetectedAt: t.replyDetectedAt,
    expiresAt: t.expiresAt,
    completionDeadlineAt: t.expiresAt + store.getActiveTaskGraceMs(),
    lateReplyDeadlineAt: store.getLateReplyDeadlineAt(t),
    requeueCount: t.requeueCount,
  };
  if (includeText) v.text = t.text;
  return v;
}

export function createV1TasksRouter(store: TaskStore): Router {
  const router = Router();

  // Create a task.
  router.post("/tasks", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      session?: unknown;
      text?: unknown;
      timeout?: unknown;
      clientRequestId?: unknown;
    };
    if (!isValidSessionId(body.session)) {
      return res.status(400).json({ error: "invalid session" });
    }
    if (typeof body.text !== "string" || body.text.length === 0) {
      return res.status(400).json({ error: "missing text" });
    }
    const timeoutMs = asPositiveInt(body.timeout) ?? undefined;
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
    const task = await longPollTask(store, {
      taskId: id,
      timeoutMs: capped,
      isDone: (t) => TERMINAL_STATUSES.includes(t.status),
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
    const rows = store.listTasks({ session, status, since, limit });
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
