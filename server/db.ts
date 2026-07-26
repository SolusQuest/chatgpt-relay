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
                       ('queued','in_progress','done','failed','cancelled','expired')),
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
  submit_acknowledged_at INTEGER,
  generating_seen_at INTEGER,
  reply_detected_at  INTEGER,
  expires_at         INTEGER NOT NULL,
  requeue_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session, status);
CREATE INDEX IF NOT EXISTS idx_tasks_expires        ON tasks(expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at   ON tasks(submitted_at);

-- Idempotency key: client_request_id is unique within a session.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tasks_cri
  ON tasks(session, client_request_id) WHERE client_request_id IS NOT NULL;

-- Enforce at most one in-progress task per session with a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tasks_active
  ON tasks(session) WHERE status = 'in_progress';

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
    ["submit_acknowledged_at", "INTEGER"],
    ["generating_seen_at", "INTEGER"],
    ["reply_detected_at", "INTEGER"],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }
}
