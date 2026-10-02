import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";
import { SessionDiagnostics } from "../server/session-diagnostics.js";
import { SessionControls } from "../server/session-controls.js";

test("Stop fence retains original message identity after task cleanup and control restart", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const diagnostics = new SessionDiagnostics(db, store);
    let controls = new SessionControls(db, store, diagnostics);
    const task = store.createTask({ session: "stop", text: "prompt" });
    store.claimNextTask("stop"); store.markTaskProgress(task.id, "send_attempted");
    diagnostics.report({ session: "stop", owner: "edge", tabId: 7, protocol: 1 });
    controls.create({ operationId: "stop-restart-1", kind: "stop", taskId: task.id });
    const command = controls.claim("edge")!;
    const evidence = { owner: "edge", token: command.token, documentId: "original-document", submittedUserMessageId: "original-user" };
    for (const invalid of [123, "", "x".repeat(201)]) {
      assert.throws(() => controls.fence(command.operationId, { ...evidence, submittedUserMessageId: invalid }), /invalid_submitted_user/);
    }
    assert.equal(controls.fence(command.operationId, evidence).execute, true);
    store.cancelTask(task.id, Date.now(), "user stopped before reply");
    controls = new SessionControls(db, store, diagnostics);
    const resumed = controls.claim("edge")!;
    assert.equal(resumed.state, "executing");
    assert.deepEqual(resumed.result, { beforeDocumentId: "original-document", submittedUserMessageId: "original-user" });
    assert.equal(controls.fence(command.operationId, { ...evidence, submittedUserMessageId: "different-user" }).execute, false);
    const result = { stopRequested: true, pageGenerationState: "stopped", relayTaskStatus: "cancelled" };
    controls.finish(command.operationId, { ...evidence, state: "succeeded", result });
    assert.deepEqual(controls.finish(command.operationId, { ...evidence, state: "unknown" }).result, result);
  } finally { db.close(); }
});

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

test("refresh holds claims, rejects drafts and active work, and fences execution once across restart", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const diagnostics = new SessionDiagnostics(db, store);
    let controls = new SessionControls(db, store, diagnostics);
    store.touchSession("refresh");
    const report = { session: "refresh", owner: "edge", tabId: 7, protocol: 1, ready: true, generating: false, composerClean: false };
    diagnostics.report(report);
    const body = { operationId: "refresh-test-1", kind: "refresh", session: "refresh" };
    assert.throws(() => controls.create(body), /composer_not_clean/);
    diagnostics.report({ ...report, composerClean: true });
    controls.create(body);
    const queued = store.createTask({ session: "refresh", text: "after reload" });
    assert.equal(store.claimNextTask("refresh"), null);
    const command = controls.claim("edge")!;
    const owner = { owner: "edge", token: command.token, documentId: "old-document" };
    assert.equal(controls.fence(command.operationId, owner).execute, true);
    controls = new SessionControls(db, store, diagnostics);
    assert.equal(controls.fence(command.operationId, owner).execute, false);
    assert.equal(controls.claim("edge")!.result.beforeDocumentId, "old-document");
    controls.finish(command.operationId, { ...owner, state: "succeeded", result: { action: "page_refreshed" } });
    assert.equal(controls.create(body).state, "succeeded");
    assert.equal(store.claimNextTask("refresh")!.id, queued.id);
    assert.throws(() => controls.create({ ...body, operationId: "refresh-test-2" }), /session_busy/);
    store.markTaskProgress(queued.id, "send_attempted");
    const recovering = controls.create({ ...body, operationId: "refresh-test-3", taskId: queued.id });
    assert.equal(recovering.taskId, queued.id);
    assert.equal(store.getTask(queued.id)!.requeueCount, 0);
  } finally { db.close(); }
});
