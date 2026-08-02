// Existing installations must gain recovery columns/status support without deleting history.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../server/db.js";

test("openDatabase migrates the pre-recovering task schema in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-db-migration-"));
  const file = path.join(dir, "relay.db");
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, client_request_id TEXT,
        status TEXT NOT NULL CHECK (status IN
          ('queued','in_progress','done','failed','cancelled','expired')),
        text TEXT NOT NULL, reply TEXT, error TEXT,
        timeout_ms INTEGER NOT NULL, submitted_at INTEGER NOT NULL,
        dispatched_at INTEGER, completed_at INTEGER, expires_at INTEGER NOT NULL,
        requeue_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, last_status_at INTEGER,
        paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, paused_at INTEGER
      );
      CREATE UNIQUE INDEX uniq_tasks_active
        ON tasks(session) WHERE status = 'in_progress';
      INSERT INTO tasks (
        id, session, status, text, timeout_ms, submitted_at, expires_at
      ) VALUES ('old-task', 'old-session', 'failed', 'keep me', 1000, 10, 1010);
    `);
    old.close();

    const migrated = openDatabase(file);
    const columns = new Set(
      (migrated.prepare("PRAGMA table_info(tasks)").all() as { name: string }[])
        .map((row) => row.name),
    );
    for (const name of [
      "late_reply",
      "late_completed_at",
      "submit_started_at",
      "send_attempted_at",
      "submit_acknowledged_at",
      "generating_seen_at",
      "reply_detected_at",
      "recovery_started_at",
      "recovery_observed_at",
      "recovery_reason",
    ]) {
      assert.ok(columns.has(name), `missing migrated column ${name}`);
    }
    const preserved = migrated
      .prepare("SELECT text, late_reply FROM tasks WHERE id = 'old-task'")
      .get() as { text: string; late_reply: string | null };
    assert.equal(preserved.text, "keep me");
    assert.equal(preserved.late_reply, null);
    const tableSql = (migrated
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() as { sql: string }).sql;
    assert.match(tableSql, /'recovering'/);
    const activeIndexSql = (migrated
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uniq_tasks_active'")
      .get() as { sql: string }).sql;
    assert.match(activeIndexSql, /recovering/);
    migrated.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});
