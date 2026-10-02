import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";

test("suspension preserves work, survives restart, and is independent of safety status", () => {
  const db = openDatabase(":memory:");
  try {
    let store = new TaskStore(db, loadConfig());
    const active = store.createTask({ session: "suspend", text: "first" });
    store.claimNextTask("suspend");
    const queued = store.createTask({ session: "suspend", text: "second" });
    store.suspendDispatch("suspend", true);
    store.markSessionStatus("suspend", false, null);
    assert.equal(store.getTask(active.id)!.status, "in_progress");
    store.completeTask(active.id, { text: "done" });
    assert.equal(store.getTask(queued.id)!.status, "queued");
    store = new TaskStore(db, loadConfig());
    assert.equal(store.claimNextTask("suspend"), null);
    const ref = store.registry.get("suspend")!.ref;
    store.suspendDispatch(ref, false);
    assert.equal(store.claimNextTask("suspend")!.id, queued.id);
  } finally { db.close(); }
});
