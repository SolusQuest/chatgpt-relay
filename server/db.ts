// server/db.ts
// 单进程 SQLite 封装。node:sqlite 在 Node 22+ 内置，同步 API 天然适合本地小工具。
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
  error              TEXT,
  timeout_ms         INTEGER NOT NULL,
  submitted_at       INTEGER NOT NULL,
  dispatched_at      INTEGER,
  completed_at       INTEGER,
  expires_at         INTEGER NOT NULL,
  requeue_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session, status);
CREATE INDEX IF NOT EXISTS idx_tasks_expires        ON tasks(expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at   ON tasks(submitted_at);

-- 幂等键（同 session 内 client_request_id 唯一）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tasks_cri
  ON tasks(session, client_request_id) WHERE client_request_id IS NOT NULL;

-- 同 session 最多一个 in_progress（通过 partial unique 强制）
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
  return db;
}