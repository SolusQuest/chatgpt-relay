// test/task-store.test.ts
// Task-state-machine tests using an in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TaskStore, TaskStoreError } from "../server/task-store.js";
import type { Config } from "../server/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: "",
    dbFile: ":memory:",
    logDir: "",
    defaultTimeoutMs: 60_000,
    maxTaskTimeoutMs: 3_600_000,
    activeTaskGraceMs: 5_000,
    lateReplyGraceMs: 30_000,
    heartbeatStaleMs: 30_000,
    sessionActiveMs: 30_000,
    maintenanceIntervalMs: 5_000,
    maxTaskTextBytes: 1024,
    maxQueuedPerSession: 3,
    ...overrides,
  };
}

function makeStore(overrides: Partial<Config> = {}): TaskStore {
  const db = new DatabaseSync(":memory:");
  // Reproduce the db.ts schema here so importing it cannot create a test file.
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, client_request_id TEXT,
      status TEXT NOT NULL, text TEXT NOT NULL, reply TEXT, late_reply TEXT, error TEXT,
      timeout_ms INTEGER NOT NULL, submitted_at INTEGER NOT NULL,
      dispatched_at INTEGER, completed_at INTEGER, late_completed_at INTEGER,
      submit_started_at INTEGER, submit_acknowledged_at INTEGER,
      generating_seen_at INTEGER, reply_detected_at INTEGER,
      expires_at INTEGER NOT NULL,
      requeue_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX uniq_tasks_cri ON tasks(session, client_request_id)
      WHERE client_request_id IS NOT NULL;
    CREATE UNIQUE INDEX uniq_tasks_active ON tasks(session)
      WHERE status = 'in_progress';
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, last_status_at INTEGER,
      paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, paused_at INTEGER
    );
  `);
  return new TaskStore(db, makeConfig(overrides));
}

test("createTask returns queued task", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "hello" });
  assert.equal(t.session, "s1");
  assert.equal(t.status, "queued");
  assert.equal(t.text, "hello");
  assert.equal(t.reply, null);
  assert.ok(t.expiresAt > t.submittedAt);
});

test("createTask caps requested timeout at configured maximum", () => {
  const store = makeStore({
    defaultTimeoutMs: 900_000,
    maxTaskTimeoutMs: 3_600_000,
  });
  const task = store.createTask({
    session: "s1",
    text: "long review",
    timeoutMs: 90 * 60_000,
    now: 100,
  });
  assert.equal(task.timeoutMs, 3_600_000);
  assert.equal(task.expiresAt, 3_600_100);
});

test("claimNextTask picks oldest queued and marks in_progress", () => {
  const store = makeStore();
  const a = store.createTask({ session: "s1", text: "a", now: 100 });
  const b = store.createTask({ session: "s1", text: "b", now: 200 });
  const claimed = store.claimNextTask("s1", 300);
  assert.equal(claimed?.id, a.id);
  assert.equal(claimed?.status, "in_progress");
  // Task b remains queued.
  assert.equal(store.getTask(b.id)?.status, "queued");
});

test("claimNextTask returns null when session already has in_progress", () => {
  const store = makeStore();
  store.createTask({ session: "s1", text: "a" });
  store.createTask({ session: "s1", text: "b" });
  store.claimNextTask("s1");
  const second = store.claimNextTask("s1");
  assert.equal(second, null);
});

test("claimNextTask returns null on empty queue", () => {
  const store = makeStore();
  assert.equal(store.claimNextTask("s1"), null);
});

test("completeTask sets done + reply", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "q" });
  store.claimNextTask("s1");
  const done = store.completeTask(t.id, { text: "answer" });
  assert.equal(done.status, "done");
  assert.equal(done.reply, "answer");
  assert.equal(done.error, null);
  assert.ok(done.completedAt);
});

test("completeTask with error sets failed", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "q" });
  store.claimNextTask("s1");
  const failed = store.completeTask(t.id, { error: "boom" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
  assert.equal(failed.reply, null);
});

test("captureReply stores a late reply without rewriting timeout failure", () => {
  const store = makeStore({ activeTaskGraceMs: 500, lateReplyGraceMs: 5_000 });
  const t = store.createTask({ session: "s1", text: "q", timeoutMs: 1000, now: 100 });
  store.claimNextTask("s1", 200);
  store.expireDueTasks(1601);

  const captured = store.captureReply(t.id, "eventual answer", 2000);
  assert.equal(captured.captured, true);
  assert.equal(captured.late, true);
  assert.equal(captured.task.status, "failed");
  assert.equal(captured.task.reply, null);
  assert.equal(captured.task.lateReply, "eventual answer");
  assert.equal(captured.task.lateCompletedAt, 2000);
});

test("captureReply rejects a late reply after the bounded recovery window", () => {
  const store = makeStore({ activeTaskGraceMs: 500, lateReplyGraceMs: 5_000 });
  const t = store.createTask({ session: "s1", text: "q", timeoutMs: 1000, now: 100 });
  store.claimNextTask("s1", 200);
  store.expireDueTasks(1601);

  const captured = store.captureReply(t.id, "too late", 6601);
  assert.equal(captured.captured, false);
  assert.equal(captured.task.lateReply, null);
});

test("captureReply does not attach output to unrelated failures or overwrite the first late reply", () => {
  const store = makeStore({ activeTaskGraceMs: 500, lateReplyGraceMs: 5_000 });
  const unrelated = store.createTask({ session: "s1", text: "q", now: 100 });
  store.claimNextTask("s1", 200);
  store.completeTask(unrelated.id, { error: "text injection failed", now: 300 });
  const rejected = store.captureReply(unrelated.id, "wrong owner", 400);
  assert.equal(rejected.captured, false);
  assert.equal(rejected.task.lateReply, null);

  const timedOut = store.createTask({ session: "s2", text: "q", timeoutMs: 1000, now: 100 });
  store.claimNextTask("s2", 200);
  store.expireDueTasks(1601);
  store.captureReply(timedOut.id, "first", 2000);
  const duplicate = store.captureReply(timedOut.id, "second", 2100);
  assert.equal(duplicate.captured, false);
  assert.equal(duplicate.late, true);
  assert.equal(duplicate.task.lateReply, "first");
});

test("deferTask releases the session without incrementing requeue count", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "q" });
  store.claimNextTask("s1");
  const deferred = store.deferTask(t.id);
  assert.equal(deferred.status, "queued");
  assert.equal(deferred.dispatchedAt, null);
  assert.equal(deferred.requeueCount, 0);
});

test("markTaskProgress records each page lifecycle phase once", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "q" });
  store.markTaskProgress(t.id, "submit_started", 100);
  store.markTaskProgress(t.id, "submit_started", 200);
  store.markTaskProgress(t.id, "submit_acknowledged", 300);
  store.markTaskProgress(t.id, "generating_seen", 400);
  const progressed = store.markTaskProgress(t.id, "reply_detected", 500);
  assert.equal(progressed.submitStartedAt, 100);
  assert.equal(progressed.submitAcknowledgedAt, 300);
  assert.equal(progressed.generatingSeenAt, 400);
  assert.equal(progressed.replyDetectedAt, 500);
});

test("cancelTask cancels queued task", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "q" });
  const c = store.cancelTask(t.id);
  assert.equal(c.status, "cancelled");
});

test("cancelTask is idempotent for terminal task", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "q" });
  store.claimNextTask("s1");
  store.completeTask(t.id, { text: "ok" });
  const c = store.cancelTask(t.id);
  assert.equal(c.status, "done"); // no change
});

test("idempotent clientRequestId returns same task", () => {
  const store = makeStore();
  const t1 = store.createTask({ session: "s1", text: "hi", clientRequestId: "cri-1" });
  const t2 = store.createTask({ session: "s1", text: "hi again", clientRequestId: "cri-1" });
  assert.equal(t1.id, t2.id);
  assert.equal(t2.text, "hi"); // Preserve the original content.
});

test("queue full throws", () => {
  const store = makeStore({ maxQueuedPerSession: 2 });
  store.createTask({ session: "s1", text: "a" });
  store.createTask({ session: "s1", text: "b" });
  assert.throws(
    () => store.createTask({ session: "s1", text: "c" }),
    (e) => e instanceof TaskStoreError && e.code === "queue_full",
  );
});

test("task text too large throws", () => {
  const store = makeStore({ maxTaskTextBytes: 10 });
  assert.throws(
    () => store.createTask({ session: "s1", text: "12345678901" }),
    (e) => e instanceof TaskStoreError && e.code === "task_too_large",
  );
});

test("paused session rejects createTask", () => {
  const store = makeStore();
  store.markSessionStatus("s1", true, "captcha");
  assert.throws(
    () => store.createTask({ session: "s1", text: "hi" }),
    (e) => e instanceof TaskStoreError && e.code === "session_paused",
  );
});

test("markSessionStatus paused fails in-flight tasks", () => {
  const store = makeStore();
  const t1 = store.createTask({ session: "s1", text: "a" });
  store.claimNextTask("s1");
  const t2 = store.createTask({ session: "s1", text: "b" });
  store.markSessionStatus("s1", true, "captcha");
  assert.equal(store.getTask(t1.id)?.status, "failed");
  assert.equal(store.getTask(t2.id)?.status, "failed");
});

test("expireDueTasks marks past-expiry queued as expired", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "a", timeoutMs: 1000, now: 100 });
  const n = store.expireDueTasks(200);
  assert.equal(n, 0); // not yet
  assert.equal(store.getTask(t.id)?.status, "queued");
  const n2 = store.expireDueTasks(100 + 1000 + 1);
  assert.equal(n2, 1);
  const expired = store.getTask(t.id);
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.error, "task_expired_before_dispatch");
});

test("expireDueTasks fails in_progress past expiry+grace", () => {
  const store = makeStore({ activeTaskGraceMs: 500 });
  const t = store.createTask({ session: "s1", text: "a", timeoutMs: 1000, now: 100 });
  store.claimNextTask("s1", 200);
  const stillOk = store.expireDueTasks(1500);
  assert.equal(stillOk, 0);
  const failed = store.expireDueTasks(100 + 1000 + 500 + 1);
  assert.equal(failed, 1);
  const result = store.getTask(t.id);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error, "task_processing_timeout");
});

test("releaseHeartbeatLostTasks uses a stable error code", () => {
  const store = makeStore({ heartbeatStaleMs: 500 });
  const t = store.createTask({ session: "s1", text: "a", now: 100 });
  store.claimNextTask("s1", 200);
  store.touchSession("s1", 200);

  assert.equal(store.releaseHeartbeatLostTasks(700), 1);
  const result = store.getTask(t.id);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error, "session_heartbeat_lost");
});

test("requeueTask returns task to queued", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "a" });
  store.claimNextTask("s1");
  const r = store.requeueTask(t.id);
  assert.equal(r.status, "queued");
  assert.equal(r.requeueCount, 1);
  // The task can be claimed again.
  const c = store.claimNextTask("s1");
  assert.equal(c?.id, t.id);
});

test("requeueTask over limit fails task", () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "a" });
  store.claimNextTask("s1");
  store.requeueTask(t.id, Date.now(), 1);
  store.claimNextTask("s1");
  const r = store.requeueTask(t.id, Date.now(), 1);
  assert.equal(r.status, "failed");
});

test("listTasks filters by session and status", () => {
  const store = makeStore();
  store.createTask({ session: "s1", text: "a" });
  const t2 = store.createTask({ session: "s2", text: "b" });
  store.claimNextTask("s2");
  store.completeTask(t2.id, { text: "done" });
  const s1 = store.listTasks({ session: "s1" });
  assert.equal(s1.length, 1);
  const done = store.listTasks({ status: "done" });
  assert.equal(done.length, 1);
  assert.equal(done[0]?.id, t2.id);
});

test("onTaskChange fires on state change", async () => {
  const store = makeStore();
  const t = store.createTask({ session: "s1", text: "a" });
  const seen: string[] = [];
  const off = store.onTaskChange(t.id, (task) => seen.push(task.status));
  store.claimNextTask("s1");
  store.completeTask(t.id, { text: "r" });
  off();
  assert.deepEqual(seen, ["in_progress", "done"]);
});

test("touchSession updates last_seen", () => {
  const store = makeStore();
  store.touchSession("s1", 1000);
  assert.equal(store.getSession("s1")?.lastSeen, 1000);
  store.touchSession("s1", 2000);
  assert.equal(store.getSession("s1")?.lastSeen, 2000);
});

test("listSessions filters by lastSeen", () => {
  const store = makeStore();
  store.touchSession("s1", 1000);
  store.touchSession("s2", 5000);
  const active = store.listSessions(3000);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, "s2");
});
