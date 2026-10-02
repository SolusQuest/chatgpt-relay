import type { Db } from "./db.js";

// Triggers capture bulk maintenance and direct state transitions in the same
// transaction as the task. No prompts or response contents enter the log.
export function installTaskTrace(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
    at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, seq);
    CREATE TRIGGER IF NOT EXISTS trace_created AFTER INSERT ON tasks BEGIN
      INSERT INTO task_events(task_id, at, event) VALUES (NEW.id, NEW.submitted_at, 'created');
    END;
    CREATE TRIGGER IF NOT EXISTS trace_status AFTER UPDATE OF status ON tasks
    WHEN OLD.status <> NEW.status BEGIN
      INSERT INTO task_events(task_id, at, event, detail)
      VALUES (NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER), NEW.status, NEW.error);
    END;`);
  for (const column of ["submit_started_at", "send_attempted_at", "submit_acknowledged_at",
    "generating_seen_at", "reply_detected_at", "recovery_started_at", "recovery_observed_at", "late_completed_at"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS trace_${column} AFTER UPDATE OF ${column} ON tasks
      WHEN NEW.${column} IS NOT NULL AND OLD.${column} IS NOT NEW.${column} BEGIN
        INSERT INTO task_events(task_id, at, event) VALUES (NEW.id, NEW.${column}, '${column.slice(0, -3)}');
      END;`);
  }
}

export function readTaskTrace(db: Db, taskId: string) {
  const events = db.prepare("SELECT seq, at, event, detail FROM task_events WHERE task_id = ? ORDER BY seq")
    .all(taskId);
  return { taskId, completeHistory: events.some(e => e.event === "created"), events };
}
