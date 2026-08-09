// server/task-store.ts
// Task and session state machines persisted in SQLite across relay restarts.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

export type TaskStatus =
  | "queued"
  | "in_progress"
  | "recovering"
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
  recoveryStartedAt: number | null;
  recoveryObservedAt: number | null;
  recoveryReason: string | null;
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

// SQLite row shape in snake_case.
interface TaskRowRaw {
  id: string;
  session: string;
  client_request_id: string | null;
  status: TaskStatus;
  text: string;
  reply: string | null;
  late_reply: string | null;
  error: string | null;
  timeout_ms: number;
  submitted_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
  late_completed_at: number | null;
  submit_started_at: number | null;
  send_attempted_at: number | null;
  submit_acknowledged_at: number | null;
  generating_seen_at: number | null;
  reply_detected_at: number | null;
  recovery_started_at: number | null;
  recovery_observed_at: number | null;
  recovery_reason: string | null;
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
    lateReply: r.late_reply,
    error: r.error,
    timeoutMs: r.timeout_ms,
    submittedAt: r.submitted_at,
    dispatchedAt: r.dispatched_at,
    completedAt: r.completed_at,
    lateCompletedAt: r.late_completed_at,
    submitStartedAt: r.submit_started_at,
    sendAttemptedAt: r.send_attempted_at,
    submitAcknowledgedAt: r.submit_acknowledged_at,
    generatingSeenAt: r.generating_seen_at,
    replyDetectedAt: r.reply_detected_at,
    recoveryStartedAt: r.recovery_started_at,
    recoveryObservedAt: r.recovery_observed_at,
    recoveryReason: r.recovery_reason,
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

export type TaskProgressPhase =
  | "submit_started"
  | "send_attempted"
  | "submit_acknowledged"
  | "generating_seen"
  | "recovery_observed"
  | "reply_detected";

export type TaskObservationPhase =
  | "accepted"
  | "generating"
  | "answer_streaming";

export interface TaskObservation {
  revision: number;
  phase: TaskObservationPhase;
  activity: string | null;
  outputChars: number;
  observedAt: number;
  changedAt: number;
  provisional: true;
}

export interface TaskObservationInput {
  phase: TaskObservationPhase;
  activity?: string | null;
  outputChars?: number;
}

export interface CaptureReplyResult {
  task: Task;
  captured: boolean;
  late: boolean;
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
      | "unsafe_retry_after_send_attempt"
      | "duplicate_request",
  ) {
    super(message);
  }
}

export class TaskStore {
  private readonly emitter = new EventEmitter();
  private readonly taskObservations = new Map<string, TaskObservation>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {
    this.emitter.setMaxListeners(0);
  }

  // ── Task lifecycle ───────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const now = input.now ?? Date.now();
    const timeoutMs = normalizeTimeout(
      input.timeoutMs,
      this.config.defaultTimeoutMs,
      this.config.maxTaskTimeoutMs,
    );
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

    // Idempotency.
    if (input.clientRequestId) {
      const existing = this.db
        .prepare(
          `SELECT * FROM tasks WHERE session = ? AND client_request_id = ? LIMIT 1`,
        )
        .get(input.session, input.clientRequestId) as TaskRowRaw | undefined;
      if (existing) return rowToTask(existing);
    }

    // Queue capacity.
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

  getTaskObservation(id: string, now = Date.now()): TaskObservation | null {
    const observation = this.taskObservations.get(id);
    if (!observation) return null;
    const task = this.getTask(id);
    if (
      !task ||
      (task.status !== "in_progress" && task.status !== "recovering") ||
      observation.observedAt + TASK_OBSERVATION_TTL_MS <= now
    ) {
      this.taskObservations.delete(id);
      return null;
    }
    return { ...observation };
  }

  reportTaskObservation(
    id: string,
    input: TaskObservationInput,
    now = Date.now(),
  ): { task: Task; observation: TaskObservation | null } {
    const task = this.getTask(id);
    if (!task) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (task.status !== "in_progress" && task.status !== "recovering") {
      this.taskObservations.delete(id);
      return { task, observation: null };
    }

    const activity = normalizeObservationActivity(input.activity);
    const outputChars = normalizeObservationOutputChars(input.outputChars);
    let previous = this.taskObservations.get(id);
    if (previous && previous.observedAt + TASK_OBSERVATION_TTL_MS <= now) {
      this.taskObservations.delete(id);
      previous = undefined;
    }
    const changed = !previous ||
      previous.phase !== input.phase ||
      previous.activity !== activity ||
      previous.outputChars !== outputChars;
    let revision = Math.max(now, (previous?.revision ?? 0) + 1);
    let changedAt = now;
    if (previous && !changed) {
      revision = previous.revision;
      changedAt = previous.changedAt;
    }
    const observation: TaskObservation = {
      revision,
      phase: input.phase,
      activity,
      outputChars,
      observedAt: now,
      changedAt,
      provisional: true,
    };
    this.taskObservations.set(id, observation);
    if (changed) this.emitTaskObservation(task);
    return { task, observation: { ...observation } };
  }

  getActiveTaskGraceMs(): number {
    return this.config.activeTaskGraceMs;
  }

  getLateReplyGraceMs(): number {
    return this.config.lateReplyGraceMs;
  }

  getRecoveryLeaseMs(): number {
    return this.config.recoveryLeaseMs;
  }

  getRecoveryDeadlineAt(task: Task): number {
    return task.expiresAt + this.config.activeTaskGraceMs + this.config.lateReplyGraceMs;
  }

  getRecoveryLeaseDeadlineAt(task: Task): number | null {
    const anchor = task.recoveryObservedAt ?? task.recoveryStartedAt;
    if (anchor === null) return null;
    return Math.min(anchor + this.config.recoveryLeaseMs, this.getRecoveryDeadlineAt(task));
  }

  getLateReplyDeadlineAt(task: Task): number {
    return this.getRecoveryDeadlineAt(task);
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

  // Atomically claim the next queued task unless the session already has one in progress.
  claimNextTask(sessionId: string, now = Date.now()): Task | null {
    // Use a transaction to preserve atomicity.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db
        .prepare(
          `SELECT id FROM tasks
             WHERE session = ? AND status IN ('in_progress', 'recovering') LIMIT 1`,
        )
        .get(sessionId) as { id: string } | undefined;
      if (active) {
        this.db.exec("COMMIT");
        return null;
      }
      const next = this.db
        .prepare(
          `SELECT * FROM tasks
             WHERE session = ? AND status = 'queued'
               AND send_attempted_at IS NULL
               AND expires_at > ?
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
    if (
      existing.status !== "in_progress" &&
      existing.status !== "recovering" &&
      existing.status !== "queued"
    ) {
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
    this.taskObservations.delete(id);
    this.emitTaskChange(task);
    return task;
  }

  captureReply(id: string, text: string, now = Date.now()): CaptureReplyResult {
    const existing = this.getTask(id);
    if (!existing) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (
      existing.status === "queued" ||
      existing.status === "in_progress" ||
      existing.status === "recovering"
    ) {
      return { task: this.completeTask(id, { text, now }), captured: true, late: false };
    }
    if (existing.status === "done") {
      return { task: existing, captured: false, late: false };
    }
    if (
      existing.status === "failed" &&
      isLateReplyEligible(existing.error) &&
      now <= this.getLateReplyDeadlineAt(existing)
    ) {
      if (existing.lateReply !== null) {
        return { task: existing, captured: false, late: true };
      }
      this.db
        .prepare(
          `UPDATE tasks
             SET late_reply = ?, late_completed_at = ?,
                 reply_detected_at = COALESCE(reply_detected_at, ?)
             WHERE id = ?`,
        )
        .run(text, now, now, id);
      const task = this.mustGetTask(id);
      this.emitTaskChange(task);
      return { task, captured: true, late: true };
    }
    return { task: existing, captured: false, late: false };
  }

  markTaskProgress(id: string, phase: TaskProgressPhase, now = Date.now()): Task {
    const existing = this.getTask(id);
    if (!existing) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (phase === "send_attempted" && existing.status !== "in_progress") {
      throw new TaskStoreError(
        `task ${id} cannot record send_attempted from status ${existing.status}`,
        "invalid_transition",
      );
    }
    if (phase === "recovery_observed") {
      if (existing.status !== "in_progress" && existing.status !== "recovering") {
        throw new TaskStoreError(
          `task ${id} cannot renew recovery from status ${existing.status}`,
          "invalid_transition",
        );
      }
      this.db
        .prepare(`UPDATE tasks SET recovery_observed_at = ? WHERE id = ?`)
        .run(now, id);
      return this.mustGetTask(id);
    }
    const column: Record<Exclude<TaskProgressPhase, "recovery_observed">, string> = {
      submit_started: "submit_started_at",
      send_attempted: "send_attempted_at",
      submit_acknowledged: "submit_acknowledged_at",
      generating_seen: "generating_seen_at",
      reply_detected: "reply_detected_at",
    };
    this.db
      .prepare(`UPDATE tasks SET ${column[phase]} = COALESCE(${column[phase]}, ?) WHERE id = ?`)
      .run(now, id);
    return this.mustGetTask(id);
  }

  deferTask(id: string): Task {
    const existing = this.getTask(id);
    if (!existing) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (existing.status !== "in_progress") {
      throw new TaskStoreError(
        `task ${id} cannot defer from status ${existing.status}`,
        "invalid_transition",
      );
    }
    if (existing.sendAttemptedAt !== null) {
      throw new TaskStoreError(
        `task ${id} cannot defer after Send may have been attempted`,
        "unsafe_retry_after_send_attempt",
      );
    }
    this.db
      .prepare(`UPDATE tasks SET status = 'queued', dispatched_at = NULL WHERE id = ?`)
      .run(id);
    const task = this.mustGetTask(id);
    this.taskObservations.delete(id);
    this.emitTaskChange(task);
    return task;
  }

  cancelTask(id: string, now = Date.now(), reason = "cancelled by client"): Task {
    const existing = this.getTask(id);
    if (!existing) throw new TaskStoreError(`task ${id} not found`, "task_not_found");
    if (TERMINAL_STATUSES.includes(existing.status)) {
      return existing;
    }
    this.db
      .prepare(
        `UPDATE tasks SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ?`,
      )
      .run(now, reason, id);
    const task = this.mustGetTask(id);
    this.taskObservations.delete(id);
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
    if (existing.sendAttemptedAt !== null) {
      throw new TaskStoreError(
        `task ${id} cannot requeue after Send may have been attempted`,
        "unsafe_retry_after_send_attempt",
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
    this.taskObservations.delete(id);
    this.emitTaskChange(task);
    return task;
  }

  // Maintenance for queued, active, and recovering tasks.
  expireDueTasks(now = Date.now()): number {
    // Expired queued tasks become expired.
    const q = this.db
      .prepare(
        `UPDATE tasks
           SET status = 'expired', completed_at = ?,
               error = 'task_expired_before_dispatch'
           WHERE status = 'queued' AND expires_at <= ?`,
      )
      .run(now, now);
    // A post-send task crossing the soft deadline remains non-terminal. The
    // extension can renew this recovery state while strong page evidence is
    // still visible, and a captured reply completes it normally.
    const grace = this.config.activeTaskGraceMs;
    const recovering = this.db
      .prepare(
        `UPDATE tasks
           SET status = 'recovering', recovery_started_at = ?, error = NULL,
               recovery_reason = CASE
                 WHEN submit_acknowledged_at IS NULL AND generating_seen_at IS NULL
                   THEN 'delivery_uncertain'
                 ELSE 'task_deadline_exceeded'
               END
           WHERE status = 'in_progress'
             AND send_attempted_at IS NOT NULL
             AND expires_at + ? <= ?`,
      )
      .run(now, grace, now);

    // A claimed task that never crossed the durable Send fence has nothing to
    // recover and can fail at the soft deadline.
    const preSend = this.db
      .prepare(
        `UPDATE tasks
           SET status = 'failed', completed_at = ?, error = 'task_processing_timeout'
           WHERE status = 'in_progress'
             AND send_attempted_at IS NULL
             AND expires_at + ? <= ?`,
      )
      .run(now, grace, now);

    const hardTimeout = this.db
      .prepare(
        `UPDATE tasks
           SET status = 'failed', completed_at = ?,
               error = CASE
                 WHEN recovery_reason = 'delivery_uncertain'
                   THEN 'submission_outcome_unknown'
                 ELSE 'task_recovery_timeout'
               END
           WHERE status = 'recovering'
             AND expires_at + ? + ? <= ?`,
      )
      .run(now, grace, this.config.lateReplyGraceMs, now);

    const leaseExpired = this.db
      .prepare(
        `UPDATE tasks
           SET status = 'failed', completed_at = ?,
               error = CASE
                 WHEN recovery_reason = 'delivery_uncertain'
                   THEN 'submission_outcome_unknown'
                 ELSE 'task_recovery_lease_expired'
               END
           WHERE status = 'recovering'
             AND COALESCE(recovery_observed_at, recovery_started_at) + ? <= ?`,
      )
      .run(now, this.config.recoveryLeaseMs, now);

    const total = Number(q.changes) + Number(recovering.changes) +
      Number(preSend.changes) + Number(hardTimeout.changes) + Number(leaseExpired.changes);
    this.pruneTaskObservations(now);
    if (total > 0) this.emitBulkChange();
    return total;
  }

  // Release active tasks after session heartbeat loss.
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
                 error = 'session_heartbeat_lost'
             WHERE session = ? AND status IN ('in_progress', 'recovering')`,
        )
        .run(now, s.id);
      changed += Number(info.changes);
    }
    this.pruneTaskObservations(now);
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
    preserveQueued = false,
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
      // Safety pauses fail all outstanding work. A pre-send attachment cleanup
      // block can preserve queued successors while still terminating active work.
      this.db
        .prepare(
          `UPDATE tasks
             SET status = 'failed', completed_at = ?,
                 error = ?
             WHERE session = ?
               AND status IN ('queued', 'in_progress', 'recovering')
               AND (? = 0 OR status <> 'queued')`,
        )
        .run(now, `session paused: ${reason ?? "unknown"}`, id, preserveQueued ? 1 : 0);
      this.clearTaskObservationsForSession(id);
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

  private emitTaskObservation(task: Task): void {
    this.emitter.emit(`task:${task.id}`, task);
  }

  private emitBulkChange(): void {
    // Notify every listener to query again.
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

  private pruneTaskObservations(now: number): void {
    for (const [taskId, observation] of this.taskObservations) {
      const task = this.getTask(taskId);
      if (
        !task ||
        (task.status !== "in_progress" && task.status !== "recovering") ||
        observation.observedAt + TASK_OBSERVATION_TTL_MS <= now
      ) {
        this.taskObservations.delete(taskId);
      }
    }
  }

  private clearTaskObservationsForSession(sessionId: string): void {
    for (const taskId of this.taskObservations.keys()) {
      if (this.getTask(taskId)?.session === sessionId) {
        this.taskObservations.delete(taskId);
      }
    }
  }
}

const TASK_OBSERVATION_TTL_MS = 2 * 60_000;

function normalizeObservationActivity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 200) : null;
}

function normalizeObservationOutputChars(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return 0;
  return Math.min(Math.floor(value), 10_000_000);
}

function normalizeTimeout(input: number | undefined, fallback: number, max: number): number {
  const cap = Math.max(1000, Math.floor(max));
  const defaultTimeout = Math.min(cap, Math.max(1000, Math.floor(fallback)));
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return defaultTimeout;
  return Math.min(cap, Math.max(1000, Math.floor(n)));
}

export function isLateReplyEligible(error: string | null): boolean {
  return error === "task_processing_timeout" ||
    error === "submission_not_observed" ||
    error === "submission_outcome_unknown" ||
    error === "task_recovery_timeout" ||
    error === "task_recovery_lease_expired" ||
    error === "session_heartbeat_lost" ||
    error === "aborted";
}
