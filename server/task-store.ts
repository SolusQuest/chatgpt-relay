// server/task-store.ts
// Task 状态机 + session 状态。SQLite 落盘，进程重启后队列/状态保留。
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

export type TaskStatus =
  | "queued"
  | "in_progress"
  | "done"
  | "failed"
  | "cancelled"
  | "expired";

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "done",
  "failed",
  "cancelled",
  "expired",
];

export interface Task {
  id: string;
  session: string;
  clientRequestId: string | null;
  status: TaskStatus;
  text: string;
  reply: string | null;
  error: string | null;
  timeoutMs: number;
  submittedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  requeueCount: number;
}

export interface SessionRow {
  id: string;
  lastSeen: number;
  lastStatusAt: number | null;
  paused: boolean;
  pauseReason: string | null;
  pausedAt: number | null;
}

// SQLite 行类型（snake_case）
interface TaskRowRaw {
  id: string;
  session: string;
  client_request_id: string | null;
  status: TaskStatus;
  text: string;
  reply: string | null;
  error: string | null;
  timeout_ms: number;
  submitted_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
  expires_at: number;
  requeue_count: number;
}
interface SessionRowRaw {
  id: string;
  last_seen: number;
  last_status_at: number | null;
  paused: number;
  pause_reason: string | null;
  paused_at: number | null;
}

function rowToTask(r: TaskRowRaw): Task {
  return {
    id: r.id,
    session: r.session,
    clientRequestId: r.client_request_id,
    status: r.status,
    text: r.text,
    reply: r.reply,
    error: r.error,
    timeoutMs: r.timeout_ms,
    submittedAt: r.submitted_at,
    dispatchedAt: r.dispatched_at,
    completedAt: r.completed_at,
    expiresAt: r.expires_at,
    requeueCount: r.requeue_count,
  };
}
function rowToSession(r: SessionRowRaw): SessionRow {
  return {
    id: r.id,
    lastSeen: r.last_seen,
    lastStatusAt: r.last_status_at,
    paused: r.paused !== 0,
    pauseReason: r.pause_reason,
    pausedAt: r.paused_at,
  };
}

export interface CreateTaskInput {
  session: string;
  text: string;
  timeoutMs?: number;
  clientRequestId?: string | null;
  now?: number;
}

export interface ListTasksQuery {
  session?: string;
  status?: TaskStatus | TaskStatus[];
  since?: number;
  limit?: number;
}

export interface CompleteTaskInput {
  text?: string;
  error?: string;
  now?: number;
}

export class TaskStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "session_paused"
      | "queue_full"
      | "task_too_large"
      | "task_not_found"
      | "invalid_transition"
      | "duplicate_request",
  ) {
    super(message);
  }
}

export class TaskStore {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.emitter.setMaxListeners(0);
  }

  // ── Task lifecycle ───────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const now = input.now ?? Date.now();
    const timeoutMs = normalizeTimeout(input.timeoutMs, this.config.defaultTimeoutMs);
    if (Buffer.byteLength(input.text, "utf8") > this.config.maxTaskTextBytes) {
      throw new TaskStoreError(
        `task text exceeds ${this.config.maxTaskTextBytes} bytes`,
        "task_too_large",
      );
    }

    const session = this.upsertSession(input.session, now);
    if (session.paused) {
      throw new TaskStoreError(
        `session paused: ${session.pauseReason ?? "unknown"}`,
        "session_paused",
      );
    }

    // 幂等
    if (input.clientRequestId) {
      const existing = this.db
        .prepare(
          `SELECT * FROM tasks WHERE session = ? AND client_request_id = ? LIMIT 1`,
        )
        .get(input.session, input.clientRequestId) as TaskRowRaw | undefined;
      if (existing) return rowToTask(existing);
    }

    // 队列容量
    const queued = this.db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE session = ? AND status = 'queued'`)
      .get(input.session) as { c: number };
    if (queued.c >= this.config.maxQueuedPerSession) {
      throw new TaskStoreError(
        `queue full for session (${queued.c} pending)`,
        "queue_full",
      );
    }

    const id = randomUUID();
    const expiresAt = now + timeoutMs;
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, session, client_request_id, status, text, timeout_ms,
            submitted_at, expires_at, requeue_count)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        input.session,
        input.clientRequestId ?? null,
        input.text,
        timeoutMs,
        now,
        expiresAt,
      );
    const task = this.mustGetTask(id);
    this.emitTaskChange(task);
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      | TaskRowRaw
      | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(query: ListTasksQuery = {}): Task[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.session) {
      clauses.push(`session = ?`);
      params.push(query.session);
    }
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length > 0) {
        clauses.push(
          `status IN (${statuses.map(() => "?").join(",")})`,
        );
        params.push(...statuses);
      }
    }
    if (query.since != null) {
      clauses.push(`submitted_at >= ?`);
      params.push(query.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${where} ORDER BY submitted_at DESC LIMIT ?`,
      )
      .all(...(params as any[]), limit) as unknown as TaskRowRaw[];
    return rows.map(rowToTask);
  }

  // 原子取下一个 queued task 并置为 in_progress。同 session 已有 in_progress 时返回 null。
  claimNextTask(sessionId: string, now = Date.now()): Task | null {
    // 使用事务保证原子性
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db
        .prepare(
          `SELECT id FROM tasks WHERE session = ? AND status = 'in_progress' LIMIT 1`,
        )
        .get(sessionId) as { id: string } | undefined;
      if (active) {
        this.db.exec("COMMIT");
        return null;
      }
      const next = this.db
        .prepare(
          `SELECT * FROM tasks
             WHERE session = ? AND status = 'queued' AND expires_at > ?
             ORDER BY submitted_at ASC LIMIT 1`,
        )
        .get(sessionId, now) as TaskRowRaw | undefined;
      if (!next) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          `UPDATE tasks
             SET status = 'in_progress', dispatched_at = ?
             WHERE id = ?`,
        )
        .run(now, next.id);
      this.db.exec("COMMIT");
      const task = this.mustGetTask(next.id);
      this.emitTaskChange(task);
      return task;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  completeTask(id: string, input: CompleteTaskInput): Task {
    const now = input.now ?? Date.now();
    const existing = this.getTask(id);
    if (!existing) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (existing.status !== "in_progress" && existing.status !== "queued") {
      throw new TaskStoreError(
        `task ${id} cannot complete from status ${existing.status}`,
        "invalid_transition",
      );
    }
    const isError = typeof input.error === "string" && input.error.length > 0;
    const status: TaskStatus = isError ? "failed" : "done";
    this.db
      .prepare(
        `UPDATE tasks
           SET status = ?, completed_at = ?, reply = ?, error = ?
           WHERE id = ?`,
      )
      .run(
        status,
        now,
        isError ? null : (input.text ?? null),
        isError ? (input.error ?? null) : null,
        id,
      );
    const task = this.mustGetTask(id);
    this.emitTaskChange(task);
    return task;
  }

  cancelTask(id: string, now = Date.now()): Task {
    const existing = this.getTask(id);
    if (!existing) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (TERMINAL_STATUSES.includes(existing.status)) {
      return existing;
    }
    this.db
      .prepare(
        `UPDATE tasks SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ?`,
      )
      .run(now, "cancelled by client", id);
    const task = this.mustGetTask(id);
    this.emitTaskChange(task);
    return task;
  }

  requeueTask(id: string, now = Date.now(), maxRequeues = 2): Task {
    const existing = this.getTask(id);
    if (!existing) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (existing.status !== "in_progress") {
      throw new TaskStoreError(
        `task ${id} cannot requeue from status ${existing.status}`,
        "invalid_transition",
      );
    }
    if (existing.requeueCount >= maxRequeues) {
      return this.completeTask(id, {
        error: `exceeded requeue limit (${maxRequeues})`,
        now,
      });
    }
    this.db
      .prepare(
        `UPDATE tasks
           SET status = 'queued', dispatched_at = NULL,
               requeue_count = requeue_count + 1
           WHERE id = ?`,
      )
      .run(id);
    const task = this.mustGetTask(id);
    this.emitTaskChange(task);
    return task;
  }

  // 维护：过期 queued / in_progress 任务
  expireDueTasks(now = Date.now()): number {
    // Queued 且已过期 → expired
    const q = this.db
      .prepare(
        `UPDATE tasks
           SET status = 'expired', completed_at = ?,
               error = '任务已过期，未发送到页面'
           WHERE status = 'queued' AND expires_at <= ?`,
      )
      .run(now, now);
    // In-progress 且过期太久（超出 grace） → failed
    const grace = this.config.activeTaskGraceMs;
    const p = this.db
      .prepare(
        `UPDATE tasks
           SET status = 'failed', completed_at = ?,
               error = '任务处理超时'
           WHERE status = 'in_progress' AND expires_at + ? <= ?`,
      )
      .run(now, grace, now);
    const total = Number(q.changes) + Number(p.changes);
    if (total > 0) this.emitBulkChange();
    return total;
  }

  // 心跳丢失 → 释放 in_progress task
  releaseHeartbeatLostTasks(now = Date.now()): number {
    const stale = this.config.heartbeatStaleMs;
    const staleSessions = this.db
      .prepare(
        `SELECT id FROM sessions WHERE last_seen + ? <= ?`,
      )
      .all(stale, now) as { id: string }[];
    let changed = 0;
    for (const s of staleSessions) {
      const info = this.db
        .prepare(
          `UPDATE tasks
             SET status = 'failed', completed_at = ?,
                 error = 'session 心跳丢失，任务被释放'
             WHERE session = ? AND status = 'in_progress'`,
        )
        .run(now, s.id);
      changed += Number(info.changes);
    }
    if (changed > 0) this.emitBulkChange();
    return changed;
  }

  // ── Session state ───────────────────────────────────────────────────────

  upsertSession(id: string, now = Date.now()): SessionRow {
    this.db
      .prepare(
        `INSERT INTO sessions (id, last_seen)
           VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(id, now);
    return this.getSessionOrThrow(id);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRowRaw
      | undefined;
    return row ? rowToSession(row) : null;
  }

  listSessions(activeSince = Date.now() - this.config.sessionActiveMs): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE last_seen >= ? ORDER BY last_seen DESC`)
      .all(activeSince) as unknown as SessionRowRaw[];
    return rows.map(rowToSession);
  }

  markSessionStatus(
    id: string,
    paused: boolean,
    reason: string | null,
    now = Date.now(),
  ): SessionRow {
    this.upsertSession(id, now);
    if (paused) {
      this.db
        .prepare(
          `UPDATE sessions
             SET paused = 1, pause_reason = ?, paused_at = COALESCE(paused_at, ?),
                 last_status_at = ?, last_seen = ?
             WHERE id = ?`,
        )
        .run(reason, now, now, now, id);
      // 该 session 所有 queued / in_progress 任务全部失败
      this.db
        .prepare(
          `UPDATE tasks
             SET status = 'failed', completed_at = ?,
                 error = ?
             WHERE session = ? AND status IN ('queued', 'in_progress')`,
        )
        .run(now, `session paused: ${reason ?? "unknown"}`, id);
      this.emitBulkChange();
    } else {
      this.db
        .prepare(
          `UPDATE sessions
             SET paused = 0, pause_reason = NULL, paused_at = NULL,
                 last_status_at = ?, last_seen = ?
             WHERE id = ?`,
        )
        .run(now, now, id);
    }
    return this.getSessionOrThrow(id);
  }

  touchSession(id: string, now = Date.now()): SessionRow {
    return this.upsertSession(id, now);
  }

  // ── Long-poll support ────────────────────────────────────────────────────

  onTaskChange(taskId: string, listener: (task: Task) => void): () => void {
    this.emitter.on(`task:${taskId}`, listener);
    return () => this.emitter.off(`task:${taskId}`, listener);
  }

  onSessionTaskChange(sessionId: string, listener: () => void): () => void {
    this.emitter.on(`session:${sessionId}`, listener);
    return () => this.emitter.off(`session:${sessionId}`, listener);
  }

  private emitTaskChange(task: Task): void {
    this.emitter.emit(`task:${task.id}`, task);
    this.emitter.emit(`session:${task.session}`);
  }

  private emitBulkChange(): void {
    // 简单起见，通知所有 listener 重新查询
    this.emitter.emit("bulk");
    for (const ev of this.emitter.eventNames()) {
      if (typeof ev === "string" && ev.startsWith("session:")) {
        this.emitter.emit(ev);
      }
    }
  }

  onBulkChange(listener: () => void): () => void {
    this.emitter.on("bulk", listener);
    return () => this.emitter.off("bulk", listener);
  }

  // ── helpers ──

  private mustGetTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new TaskStoreError(`task ${id} vanished after write`, "task_not_found");
    return t;
  }

  private getSessionOrThrow(id: string): SessionRow {
    const s = this.getSession(id);
    if (!s) throw new Error(`session ${id} not found after upsert`);
    return s;
  }
}

function normalizeTimeout(input: number | undefined, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1000, Math.floor(n));
}