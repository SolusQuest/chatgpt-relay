import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";

test("trace captures ordered dispatch, send fence, Stop and bulk transitions without content", () => {
  const db = openDatabase(":memory:");
  try {
    let store = new TaskStore(db, loadConfig());
    const task = store.createTask({ session: "trace", text: "PRIVATE" });
    store.claimNextTask("trace");
    store.markTaskProgress(task.id, "submit_started");
    store.markTaskProgress(task.id, "send_attempted");
    store.markTaskProgress(task.id, "send_attempted");
    store.cancelTask(task.id, Date.now(), "user stopped before reply");
    store = new TaskStore(db, loadConfig());
    const trace = store.traceTask(task.id);
    assert.equal(trace.completeHistory, true);
    assert.deepEqual(trace.events.map(e => e.event), ["created", "in_progress", "submit_started", "send_attempted", "cancelled"]);
    assert.ok(!JSON.stringify(trace).includes("PRIVATE"));
    const queued = store.createTask({ session: "trace", text: "PRIVATE" });
    store.markSessionStatus("trace", true, "test");
    assert.equal(store.traceTask(queued.id).events.at(-1)!.event, "failed");
    assert.throws(() => store.traceTask("missing"));
  } finally { db.close(); }
});
