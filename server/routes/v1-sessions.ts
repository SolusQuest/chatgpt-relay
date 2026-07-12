// server/routes/v1-sessions.ts
import { Router } from "express";
import type { Request, Response } from "express";
import type { TaskStore } from "../task-store.js";
import { isValidSessionId } from "../util.js";

export function createV1SessionsRouter(store: TaskStore): Router {
  const router = Router();

  router.get("/sessions", (_req: Request, res: Response) => {
    const sessions = store.listSessions().map((s) => ({
      session: s.id,
      lastSeen: s.lastSeen,
      lastStatusAt: s.lastStatusAt,
      paused: s.paused,
      pauseReason: s.pauseReason,
      pausedAt: s.pausedAt,
      pendingTasks: store.listTasks({ session: s.id, status: "queued" }).length,
      inProgressTaskId:
        store.listTasks({ session: s.id, status: "in_progress" })[0]?.id ?? null,
    }));
    res.json({ sessions });
  });

  router.post("/sessions/:id/pause", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!isValidSessionId(id)) return res.status(400).json({ error: "invalid session" });
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason : "manual pause";
    const s = store.markSessionStatus(id, true, reason);
    res.json({ session: s });
  });

  router.post("/sessions/:id/resume", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!isValidSessionId(id)) return res.status(400).json({ error: "invalid session" });
    const s = store.markSessionStatus(id, false, null);
    res.json({ session: s });
  });

  return router;
}