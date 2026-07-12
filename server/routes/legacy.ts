// server/routes/legacy.ts
// 旧 API shim。让当前 tampermonkey.js 和 agent-client.js 完全不修改也能工作。
// Phase 5 会整个删除此文件。
import { Router } from "express";
import type { Request, Response } from "express";
import type { TaskStore, TaskStatus } from "../task-store.js";
import { TaskStoreError, TERMINAL_STATUSES } from "../task-store.js";
import { asPositiveInt, isValidSessionId } from "../util.js";
import { longPollSession, longPollTask } from "../long-poll.js";

// 已在响应里返回过的 done/failed task，需要标记以避免重复。旧 replyQueue 是"一次消费"语义。
// 使用内存 Set；进程重启后 legacy client 顶多多收一次结果，无实际影响。
const consumedReplies = new Set<string>();

export function createLegacyRouter(store: TaskStore): Router {
  const router = Router();

  // ── Agent 端 ──

  router.post("/task", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      session?: unknown;
      text?: unknown;
      timeout?: unknown;
    };
    if (!isValidSessionId(body.session) || typeof body.text !== "string") {
      return res.status(400).json({ error: "Missing session or text" });
    }
    const timeoutMs = asPositiveInt(body.timeout) ?? undefined;
    try {
      const task = store.createTask({
        session: body.session,
        text: body.text,
        timeoutMs,
      });
      return res.json({ status: "ok", taskId: task.id });
    } catch (err) {
      if (err instanceof TaskStoreError) {
        if (err.code === "session_paused") {
          return res.status(409).json({ error: err.message });
        }
        if (err.code === "task_too_large") {
          return res
            .status(413)
            .json({ error: "PAYLOAD_TOO_LARGE", message: err.message });
        }
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });

  router.get("/get_reply", async (req: Request, res: Response) => {
    const session = req.query.session;
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : null;
    if (!isValidSessionId(session)) {
      return res.status(400).json({ error: "Missing session" });
    }
    // 旧客户端本身没有 wait 参数，短轮询即可；但我们主动加一个短等待降低空转。
    if (taskId) {
      const task = await longPollTask(store, {
        taskId,
        timeoutMs: 500,
        isDone: (t) => TERMINAL_STATUSES.includes(t.status),
      });
      if (!task || task.session !== session) {
        return res.json({ text: null });
      }
      if (TERMINAL_STATUSES.includes(task.status) && !consumedReplies.has(task.id)) {
        consumedReplies.add(task.id);
        // 旧协议：done→text，其它→error 字段
        if (task.status === "done") {
          return res.json({ text: task.reply ?? "", taskId: task.id });
        }
        return res.json({
          text: null,
          taskId: task.id,
          error: task.error ?? task.status,
        });
      }
      // 未终态：返回 pause 提示（如果有）
      const s = store.getSession(session);
      return res.json({
        text: null,
        paused: s?.paused ?? false,
        pauseReason: s?.pauseReason ?? null,
        activeTaskId: findInProgressId(store, session),
      });
    }
    // 无 taskId：取当前 session 最新未消费 terminal 任务
    const rows = store.listTasks({ session, limit: 20 });
    for (const t of rows) {
      if (
        TERMINAL_STATUSES.includes(t.status) &&
        !consumedReplies.has(t.id)
      ) {
        consumedReplies.add(t.id);
        if (t.status === "done") {
          return res.json({ text: t.reply ?? "", taskId: t.id });
        }
        return res.json({ text: null, taskId: t.id, error: t.error ?? t.status });
      }
    }
    const s = store.getSession(session);
    return res.json({
      text: null,
      paused: s?.paused ?? false,
      pauseReason: s?.pauseReason ?? null,
      activeTaskId: findInProgressId(store, session),
    });
  });

  router.get("/sessions", (_req: Request, res: Response) => {
    const now = Date.now();
    const sessions = store.listSessions().map((s) => ({
      session: s.id,
      pendingTasks: store.listTasks({ session: s.id, status: "queued" }).length,
      activeTaskId: findInProgressId(store, s.id),
      activeSince:
        store.listTasks({ session: s.id, status: "in_progress" })[0]?.dispatchedAt ??
        null,
      activeForMs: 0,
      paused: s.paused,
      pauseReason: s.pauseReason,
      pausedAt: s.pausedAt,
      lastSeen: s.lastSeen,
      lastStatusAt: s.lastStatusAt,
    }));
    for (const s of sessions) {
      s.activeForMs = s.activeSince ? now - s.activeSince : 0;
    }
    res.json({ sessions });
  });

  router.get("/health", (_req: Request, res: Response) => {
    const active = store.listSessions().length;
    res.json({ status: "ok", sessions: active });
  });

  router.post("/heartbeat", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { session?: unknown };
    if (!isValidSessionId(body.session)) {
      return res.status(400).json({ error: "Invalid session" });
    }
    store.touchSession(body.session);
    res.json({ status: "ok" });
  });

  // ── 扩展/油猴端 ──

  router.get("/get_task", async (req: Request, res: Response) => {
    const session = req.query.session;
    if (!isValidSessionId(session)) {
      return res.status(400).json({ error: "Missing session" });
    }
    store.touchSession(session);
    const s = store.getSession(session);
    if (s?.paused) {
      return res.json({ taskId: null, text: null, paused: true, pauseReason: s.pauseReason });
    }
    // 旧脚本每 2.5-5.5s 短轮询，不 wait
    const task = await longPollSession(store, session, 0, () =>
      store.claimNextTask(session),
    );
    if (!task) {
      const active = findInProgressId(store, session);
      if (active) {
        return res.json({ taskId: null, text: null, activeTaskId: active });
      }
      return res.json({ taskId: null, text: null });
    }
    return res.json({ taskId: task.id, text: task.text });
  });

  router.post("/reply", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      session?: unknown;
      taskId?: unknown;
      text?: unknown;
      error?: unknown;
    };
    if (!isValidSessionId(body.session)) {
      return res.status(400).json({ error: "Missing session" });
    }
    if (typeof body.taskId !== "string") {
      return res.status(400).json({ error: "Missing taskId" });
    }
    store.touchSession(body.session);
    try {
      store.completeTask(body.taskId, {
        text: typeof body.text === "string" ? body.text : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
      });
    } catch (err) {
      if (err instanceof TaskStoreError && err.code === "task_not_found") {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof TaskStoreError && err.code === "invalid_transition") {
        // 幂等：task 已 terminal，忽略即可
        return res.json({ status: "ok" });
      }
      throw err;
    }
    res.json({ status: "ok" });
  });

  router.post("/session_status", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      session?: unknown;
      paused?: unknown;
      reason?: unknown;
    };
    if (!isValidSessionId(body.session)) {
      return res.status(400).json({ error: "Missing session" });
    }
    const paused = body.paused === true;
    const reason = typeof body.reason === "string" ? body.reason : null;
    const s = store.markSessionStatus(body.session, paused, reason);
    res.json({ status: "ok", session: s });
  });

  return router;
}

function findInProgressId(store: TaskStore, sessionId: string): string | null {
  return store.listTasks({ session: sessionId, status: "in_progress" })[0]?.id ?? null;
}

// 允许测试重置 consumedReplies
export function _resetLegacyState(): void {
  consumedReplies.clear();
}