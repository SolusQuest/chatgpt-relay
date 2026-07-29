// server/routes/internal.ts
// Extension API for claiming tasks, submitting replies, heartbeat, and session status.
import { Router } from "express";
import type { Request, Response } from "express";
import type { TaskStore } from "../task-store.js";
import { TaskStoreError } from "../task-store.js";
import type { TaskProgressPhase } from "../task-store.js";
import { longPollSession } from "../long-poll.js";
import { asPositiveInt, isValidSessionId } from "../util.js";

export function createInternalRouter(store: TaskStore): Router {
  const router = Router();

  // Claim the next task, with optional long polling via the wait query.
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
        expiresAt: task.expiresAt,
        completionDeadlineAt: task.expiresAt + store.getActiveTaskGraceMs(),
        lateReplyDeadlineAt:
          task.expiresAt + store.getActiveTaskGraceMs() + store.getLateReplyGraceMs(),
        requeueCount: task.requeueCount,
      },
    });
  });

  // Capture a DOM reply. Active tasks complete normally; timeout replies are
  // stored separately without rewriting the terminal status.
  router.post("/tasks/:id/capture", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return res.status(400).json({ error: "missing text" });
    try {
      const result = store.captureReply(id, text);
      return res.json({
        status: result.task.status,
        taskId: result.task.id,
        captured: result.captured,
        late: result.late,
      });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  router.post("/tasks/:id/progress", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as { phase?: unknown };
    const phases: TaskProgressPhase[] = [
      "submit_started",
      "send_attempted",
      "submit_acknowledged",
      "generating_seen",
      "reply_detected",
    ];
    if (typeof body.phase !== "string" || !phases.includes(body.phase as TaskProgressPhase)) {
      return res.status(400).json({ error: "invalid phase" });
    }
    try {
      const task = store.markTaskProgress(id, body.phase as TaskProgressPhase);
      return res.json({ status: task.status, taskId: task.id, phase: body.phase });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Complete a task.
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

  // Cancel when the page user selects Stop so refresh cannot resubmit the task.
  router.post("/tasks/:id/user-stop", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === "string" && body.reason.length > 0
      ? body.reason
      : "user stopped before reply";
    try {
      const task = store.cancelTask(id, Date.now(), reason);
      return res.json({ status: task.status, taskId: task.id });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Report a DOM reply discovered after extension or page restart. Active tasks
  // complete normally, timeout replies are stored separately, and other
  // terminal tasks are ignored.
  router.post("/tasks/:id/recover", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return res.status(400).json({ error: "missing text" });
    try {
      const result = store.captureReply(id, text);
      return res.json({
        status: result.task.status,
        taskId: result.task.id,
        recovered: result.captured,
        late: result.late,
      });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        const status = err.code === "task_not_found" ? 404 : 400;
        return res.status(status).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Return a newly claimed task to the queue if the page is still busy.
  router.post("/tasks/:id/defer", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    try {
      const task = store.deferTask(id);
      return res.json({ status: task.status, taskId: task.id });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Requeue only when the extension can prove Send was never attempted.
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

  // Session heartbeat.
  router.post("/heartbeat", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { session?: unknown };
    if (!isValidSessionId(body.session)) {
      return res.status(400).json({ error: "invalid session" });
    }
    store.touchSession(body.session);
    res.json({ status: "ok" });
  });

  // Report session pause, resume, and safety state.
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
