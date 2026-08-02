// server/db.ts
// Single-process SQLite wrapper. The synchronous Node 22+ API suits this local tool.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  session            TEXT NOT NULL,
  client_request_id  TEXT,
  status             TEXT NOT NULL CHECK (status IN
                       ('queued','in_progress','recovering','done','failed','cancelled','expired')),
  text               TEXT NOT NULL,
  reply              TEXT,
  late_reply         TEXT,
  error              TEXT,
  timeout_ms         INTEGER NOT NULL,
  submitted_at       INTEGER NOT NULL,
  dispatched_at      INTEGER,
  completed_at       INTEGER,
  late_completed_at  INTEGER,
  submit_started_at  INTEGER,
  send_attempted_at  INTEGER,
  submit_acknowledged_at INTEGER,
  generating_seen_at INTEGER,
  reply_detected_at  INTEGER,
  recovery_started_at INTEGER,
  recovery_observed_at INTEGER,
  recovery_reason    TEXT,
  expires_at         INTEGER NOT NULL,
  requeue_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session, status);
CREATE INDEX IF NOT EXISTS idx_tasks_expires        ON tasks(expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at   ON tasks(submitted_at);

-- Idempotency key: client_request_id is unique within a session.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tasks_cri
  ON tasks(session, client_request_id) WHERE client_request_id IS NOT NULL;

-- Enforce at most one active task per session with a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tasks_active
  ON tasks(session) WHERE status IN ('in_progress', 'recovering');

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  last_seen     INTEGER NOT NULL,
  last_status_at INTEGER,
  paused        INTEGER NOT NULL DEFAULT 0,
  pause_reason  TEXT,
  paused_at     INTEGER
);
`;

export function openDatabase(dbFile: string): Db {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  ensureTaskColumns(db);
  ensureRecoveringTaskSchema(db);
  return db;
}

function ensureTaskColumns(db: Db): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name),
  );
  const additions: [string, string][] = [
    ["late_reply", "TEXT"],
    ["late_completed_at", "INTEGER"],
    ["submit_started_at", "INTEGER"],
    ["send_attempted_at", "INTEGER"],
    ["submit_acknowledged_at", "INTEGER"],
    ["generating_seen_at", "INTEGER"],
    ["reply_detected_at", "INTEGER"],
    ["recovery_started_at", "INTEGER"],
    ["recovery_observed_at", "INTEGER"],
    ["recovery_reason", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }
}

function ensureRecoveringTaskSchema(db: Db): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get() as { sql: string } | undefined;
  if (!row?.sql.includes("'recovering'")) {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS idx_tasks_session_status;
      DROP INDEX IF EXISTS idx_tasks_expires;
      DROP INDEX IF EXISTS idx_tasks_submitted_at;
      DROP INDEX IF EXISTS uniq_tasks_cri;
      DROP INDEX IF EXISTS uniq_tasks_active;
      ALTER TABLE tasks RENAME TO tasks_before_recovering;

      CREATE TABLE tasks (
        id                 TEXT PRIMARY KEY,
        session            TEXT NOT NULL,
        client_request_id  TEXT,
        status             TEXT NOT NULL CHECK (status IN
                             ('queued','in_progress','recovering','done','failed','cancelled','expired')),
        text               TEXT NOT NULL,
        reply              TEXT,
        late_reply         TEXT,
        error              TEXT,
        timeout_ms         INTEGER NOT NULL,
        submitted_at       INTEGER NOT NULL,
        dispatched_at      INTEGER,
        completed_at       INTEGER,
        late_completed_at  INTEGER,
        submit_started_at  INTEGER,
        send_attempted_at  INTEGER,
        submit_acknowledged_at INTEGER,
        generating_seen_at INTEGER,
        reply_detected_at  INTEGER,
        recovery_started_at INTEGER,
        recovery_observed_at INTEGER,
        recovery_reason    TEXT,
        expires_at         INTEGER NOT NULL,
        requeue_count      INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO tasks (
        id, session, client_request_id, status, text, reply, late_reply, error,
        timeout_ms, submitted_at, dispatched_at, completed_at, late_completed_at,
        submit_started_at, send_attempted_at, submit_acknowledged_at,
        generating_seen_at, reply_detected_at, recovery_started_at,
        recovery_observed_at, recovery_reason, expires_at, requeue_count
      )
      SELECT
        id, session, client_request_id, status, text, reply, late_reply, error,
        timeout_ms, submitted_at, dispatched_at, completed_at, late_completed_at,
        submit_started_at, send_attempted_at, submit_acknowledged_at,
        generating_seen_at, reply_detected_at, recovery_started_at,
        recovery_observed_at, recovery_reason, expires_at, requeue_count
      FROM tasks_before_recovering;

      DROP TABLE tasks_before_recovering;
      CREATE INDEX idx_tasks_session_status ON tasks(session, status);
      CREATE INDEX idx_tasks_expires ON tasks(expires_at);
      CREATE INDEX idx_tasks_submitted_at ON tasks(submitted_at);
      CREATE UNIQUE INDEX uniq_tasks_cri
        ON tasks(session, client_request_id) WHERE client_request_id IS NOT NULL;
      CREATE UNIQUE INDEX uniq_tasks_active
        ON tasks(session) WHERE status IN ('in_progress', 'recovering');
      COMMIT;
    `);
    return;
  }

  // Older development builds may already allow the status but still have the
  // narrower unique index. Recreate it to keep both active states exclusive.
  db.exec(`
    DROP INDEX IF EXISTS uniq_tasks_active;
    CREATE UNIQUE INDEX uniq_tasks_active
      ON tasks(session) WHERE status IN ('in_progress', 'recovering');
  `);
}
