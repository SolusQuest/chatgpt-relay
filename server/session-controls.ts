import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "./db.js";
import type { TaskStore } from "./task-store.js";
import type { SessionDiagnostics } from "./session-diagnostics.js";

export function installControls(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_controls (
    id TEXT PRIMARY KEY, session TEXT NOT NULL, owner TEXT NOT NULL, tab INTEGER NOT NULL,
    kind TEXT NOT NULL, task_id TEXT, state TEXT NOT NULL, token TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, error TEXT, result TEXT);
    CREATE INDEX IF NOT EXISTS idx_controls_session ON session_controls(session, state);`);
}
interface ControlRow {
  id: string; session: string; owner: string; tab: number; kind: string;
  task_id: string | null; state: string; token: string; created_at: number;
  expires_at: number; error: string | null; result: string | null;
}
export class ControlError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export class SessionControls {
  constructor(private db: Db, private store: TaskStore, private diagnostics: SessionDiagnostics) { installControls(db); }
  row(id: string) { return this.db.prepare("SELECT * FROM session_controls WHERE id = ?").get(id) as unknown as ControlRow | undefined; }
  expire() {
    this.db.prepare(`UPDATE session_controls SET state='unknown', error='control_timeout'
      WHERE state IN ('queued','claimed','executing') AND expires_at <= ?`).run(Date.now());
  }
  view(row: ControlRow) {
    return { operationId: row.id, session: row.session, kind: row.kind, taskId: row.task_id,
      state: row.state, createdAt: row.created_at, expiresAt: row.expires_at, error: row.error,
      result: row.result ? JSON.parse(row.result) : null };
  }
  create(body: any) {
    this.expire();
    if (typeof body?.operationId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.operationId) ||
        body.kind !== "recover" || typeof body.taskId !== "string") throw new ControlError("invalid_control", 400);
    const task = this.store.getTask(body.taskId);
    if (!task) throw new ControlError("task_not_found", 404);
    const old = this.row(body.operationId);
    if (old) {
      if (old.session !== task.session || old.kind !== body.kind || old.task_id !== body.taskId) throw new ControlError("operation_id_conflict");
      return this.view(old);
    }
    if (task.sendAttemptedAt == null || !["in_progress", "recovering"].includes(task.status)) throw new ControlError("task_not_recoverable");
    const snapshot = this.diagnostics.inspect(task.session);
    if (snapshot?.pageStatus !== "observed" || snapshot.page.protocol !== 1) throw new ControlError("page_identity_unavailable");
    if (this.db.prepare("SELECT id FROM session_controls WHERE session=? AND state IN ('queued','claimed','executing')").get(task.session)) throw new ControlError("control_in_progress");
    this.db.prepare("INSERT INTO session_controls VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, NULL)")
      .run(body.operationId, task.session, snapshot.page.owner, snapshot.page.tabId, body.kind, task.id, randomUUID(), Date.now(), Date.now() + 120_000);
    return this.view(this.row(body.operationId)!);
  }
  claim(owner: string) {
    this.expire();
    const row = this.db.prepare("SELECT * FROM session_controls WHERE owner=? AND state IN ('queued','claimed','executing') ORDER BY created_at LIMIT 1").get(owner) as unknown as ControlRow | undefined;
    if (!row) return null;
    if (row.state === "queued") this.db.prepare("UPDATE session_controls SET state='claimed' WHERE id=?").run(row.id);
    return { ...this.view(this.row(row.id)!), owner, tabId: row.tab, token: row.token };
  }
  finish(id: string, body: any) {
    this.expire();
    const row = this.row(id);
    if (!row || row.owner !== body?.owner || row.token !== body?.token) throw new ControlError("control_ownership_mismatch");
    if (!["claimed", "executing"].includes(row.state)) return this.view(row);
    if (!["succeeded", "blocked", "unknown"].includes(body.state)) throw new ControlError("invalid_control_state", 400);
    this.db.prepare("UPDATE session_controls SET state=?, error=?, result=? WHERE id=?")
      .run(body.state, typeof body.error === "string" ? body.error.slice(0, 150) : null,
        JSON.stringify(body.result ?? null).slice(0, 4000), id);
    return this.view(this.row(id)!);
  }
}
export function controlsRouter(controls: SessionControls) {
  const router = Router();
  router.post("/v1/session-controls", (req, res) => res.status(202).json(controls.create(req.body)));
  router.get("/v1/operations/:id", (req, res) => {
    controls.expire();
    const row = controls.row(String(req.params.id));
    if (!row) return res.status(404).json({ error: "operation_not_found" });
    res.json(controls.view(row));
  });
  router.post("/internal/session-controls/claim", (req, res) => {
    if (typeof req.body?.owner !== "string") throw new ControlError("invalid_owner", 400);
    res.json({ command: controls.claim(req.body.owner) });
  });
  router.post("/internal/session-controls/:id/finish", (req, res) => res.json(controls.finish(String(req.params.id), req.body)));
  router.use((err: unknown, _req: any, res: any, next: any) => {
    if (err instanceof ControlError) return res.status(err.status).json({ error: err.code });
    next(err);
  });
  return router;
}
