// server/routes/internal.ts
// 扩展端接口: 认领下一个任务 / 提交回复 / 心跳 / session 状态上报。
import { Router } from "express";
import type { Request, Response } from "express";
import type { TaskStore } from "../task-store.js";
import { TaskStoreError } from "../task-store.js";
import { longPollSession } from "../long-poll.js";
import { asPositiveInt, isValidSessionId } from "../util.js";

export function createInternalRouter(store: TaskStore): Router {
  const router = Router();

  // 认领下一个任务（长轮询，可选 wait 参数）
  router.get("/next_task", async (req: Request, res: Response) => {
    const session = req.query.session;
    if (!isValidSessionId(session)) {
      return res.status(400).json({ error: "invalid session" });
    }
    store.touchSession(session);
    const wait = Math.min(asPositiveInt(req.query.wait) ?? 0, 25_000);
    const sessionState = store.getSession(session);
    if (sessionState?.paused) {
      return res.json({
        task: null,
        paused: true,
        pauseReason: sessionState.pauseReason,
      });
    }
    const task = await longPollSession(store, session, wait, () =>
      store.claimNextTask(session),
    );
    if (!task) {
      return res.json({ task: null });
    }
    return res.json({
      task: {
        taskId: task.id,
        text: task.text,
        timeoutMs: task.timeoutMs,
        submittedAt: task.submittedAt,
        requeueCount: task.requeueCount,
      },
    });
  });

  // 完成任务
  router.post("/tasks/:id/complete", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as { text?: unknown; error?: unknown };
    try {
      const task = store.completeTask(id, {
        text: typeof body.text === "string" ? body.text : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
      });
      return res.json({ status: task.status, taskId: task.id });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 从 DOM 回捞的回复：扩展重启/刷新后发现某 taskId 已生成完，走这里报回。
  // 语义：如果 task 处于 queued/in_progress 则视为 complete；已 terminal 则忽略。
  router.post("/tasks/:id/recover", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return res.status(400).json({ error: "missing text" });
    const existing = store.getTask(id);
    if (!existing) return res.status(404).json({ error: "task not found" });
    if (["done", "failed", "cancelled", "expired"].includes(existing.status)) {
      return res.json({ status: existing.status, taskId: id, recovered: false });
    }
    try {
      const task = store.completeTask(id, { text });
      return res.json({ status: task.status, taskId: task.id, recovered: true });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 请求把任务打回 queued（页面刷新后回捞失败等场景）
  router.post("/tasks/:id/requeue", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    try {
      const task = store.requeueTask(id);
      return res.json({ status: task.status, taskId: task.id, requeueCount: task.requeueCount });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Session 心跳
  router.post("/heartbeat", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { session?: unknown };
    if (!isValidSessionId(body.session)) {
      return res.status(400).json({ error: "invalid session" });
    }
    store.touchSession(body.session);
    res.json({ status: "ok" });
  });

  // Session 状态上报（安全暂停/恢复）
  router.post("/sessions/:id/status", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!isValidSessionId(id)) return res.status(400).json({ error: "invalid session" });
    const body = (req.body ?? {}) as { paused?: unknown; reason?: unknown };
    const paused = body.paused === true;
    const reason = typeof body.reason === "string" ? body.reason : null;
    const s = store.markSessionStatus(id, paused, reason);
    res.json({ status: "ok", session: s });
  });

  return router;
}