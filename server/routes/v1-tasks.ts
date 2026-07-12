// server/routes/v1-tasks.ts
// 对外 API: 提交任务 / 查询 / 取消 / 列表。
import { Router } from "express";
import type { Request, Response } from "express";
import type { TaskStore, Task, TaskStatus } from "../task-store.js";
import { TaskStoreError, TERMINAL_STATUSES } from "../task-store.js";
import { longPollTask } from "../long-poll.js";
import { asPositiveInt, isValidSessionId } from "../util.js";

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
  error: string | null;
  timeoutMs: number;
  submittedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  requeueCount: number;
}

export function toTaskView(t: Task, includeText = false): TaskView {
  const v: TaskView = {
    taskId: t.id,
    session: t.session,
    clientRequestId: t.clientRequestId,
    status: t.status,
    reply: t.reply,
    error: t.error,
    timeoutMs: t.timeoutMs,
    submittedAt: t.submittedAt,
    dispatchedAt: t.dispatchedAt,
    completedAt: t.completedAt,
    expiresAt: t.expiresAt,
    requeueCount: t.requeueCount,
  };
  if (includeText) v.text = t.text;
  return v;
}

export function createV1TasksRouter(store: TaskStore): Router {
  const router = Router();

  // 创建任务
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
    try {
      const task = store.createTask({
        session: body.session,
        text: body.text,
        timeoutMs,
        clientRequestId,
      });
      return res.status(201).json({ taskId: task.id, status: task.status });
    } catch (err) {
      return respondStoreError(res, err);
    }
  });

  // 查询单个任务，支持 ?wait=毫秒 的长轮询直到进入终态
  router.get("/tasks/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const wait = asPositiveInt(req.query.wait) ?? 0;
    const capped = Math.min(wait, 60_000); // 上限 60s
    const task = await longPollTask(store, {
      taskId: id,
      timeoutMs: capped,
      isDone: (t) => TERMINAL_STATUSES.includes(t.status),
    });
    if (!task) return res.status(404).json({ error: "task not found" });
    return res.json(toTaskView(task, true));
  });

  // 取消
  router.delete("/tasks/:id", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    try {
      const task = store.cancelTask(id);
      return res.json(toTaskView(task));
    } catch (err) {
      return respondStoreError(res, err);
    }
  });

  // 列表
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
    return res.json({ tasks: rows.map((r) => toTaskView(r, includeText)) });
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
      duplicate_request: 409,
    };
    return res.status(codeMap[err.code]).json({ error: err.code, message: err.message });
  }
  console.error("[v1] unexpected error:", err);
  return res
    .status(500)
    .json({ error: "internal_error", message: (err as Error)?.message });
}