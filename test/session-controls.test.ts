import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";
import { SessionDiagnostics } from "../server/session-diagnostics.js";
import { SessionControls } from "../server/session-controls.js";

test("recovery controls are idempotent, owned, durable and independent of active task", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const diagnostics = new SessionDiagnostics(db, store);
    let controls = new SessionControls(db, store, diagnostics);
    const task = store.createTask({ session: "control", text: "prompt" });
    const body = { operationId: "recover-test-1", kind: "recover", taskId: task.id };
    assert.throws(() => controls.create(body), /task_not_recoverable/);
    store.claimNextTask("control");
    store.markTaskProgress(task.id, "send_attempted");
    assert.throws(() => controls.create(body), /page_identity_unavailable/);
    diagnostics.report({ session: "control", owner: "edge", tabId: 7, protocol: 1 });
    assert.equal(controls.create(body).state, "queued");
    assert.equal(controls.create(body).operationId, body.operationId);
    assert.equal(controls.claim("other"), null);
    const command = controls.claim("edge")!;
    assert.equal(command.tabId, 7);
    controls = new SessionControls(db, store, diagnostics);
    assert.equal(controls.claim("edge")!.token, command.token);
    assert.throws(() => controls.finish(command.operationId, { owner: "other", token: command.token, state: "succeeded" }), /ownership/);
    controls.finish(command.operationId, { owner: "edge", token: command.token, state: "succeeded", result: { action: "observation_attached" } });
    assert.equal(controls.create(body).state, "succeeded");
    assert.equal(store.getTask(task.id)!.status, "in_progress");
    assert.equal(store.getTask(task.id)!.requeueCount, 0);
  } finally { db.close(); }
});
