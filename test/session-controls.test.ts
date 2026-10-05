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

test("open accepts both aliases, selects a unique instance without pages and survives uncertain requests", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const id = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
    store.touchSession(id);
    const diagnostics = new SessionDiagnostics(db, store);
    const controls = new SessionControls(db, store, diagnostics);
    const body = { operationId: "open-existing-1", kind: "open", session: id };
    assert.throws(() => controls.create(body), /instance_unavailable/);
    diagnostics.instances.report({ owner: "edge", generation: 1, revision: 1, controls: ["open", "close"], tabs: [] });
    const operation = controls.create(body);
    assert.equal(operation.tabId, null);
    assert.equal(operation.instanceId, "edge");
    assert.equal(controls.create({ ...body, session: store.registry.get(id)!.ref }).operationId, body.operationId);
    assert.throws(() => controls.create({ ...body, instanceId: "edge" }), /operation_id_conflict/);
    const command = controls.claim("edge")!;
    const evidence = { owner: "edge", token: command.token, generation: 1 };
    assert.equal(controls.fence(command.operationId, evidence).execute, true);
    assert.equal(new SessionControls(db, store, diagnostics).fence(command.operationId, evidence).execute, false);
    controls.finish(command.operationId, { ...evidence, state: "unknown" });
    diagnostics.instances.report({ owner: "other", generation: 1, revision: 1, controls: ["open"], tabs: [] });
    assert.throws(() => controls.create({ ...body, operationId: "open-existing-2" }), /instance_ambiguous/);
    const explicit = controls.create({ ...body, operationId: "open-existing-2", instanceId: "other" });
    assert.equal(explicit.instanceId, "other");
    store.touchSession("not-a-conversation");
    assert.throws(() => controls.create({ ...body, operationId: "open-existing-3", session: "not-a-conversation" }), /conversation_not_bound/);
  } finally { db.close(); }
});

test("close rejects drafts, gates dispatch and durably suspends it only at the execution fence", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const id = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
    store.touchSession(id);
    const diagnostics = new SessionDiagnostics(db, store);
    let controls = new SessionControls(db, store, diagnostics);
    const report = { owner: "edge", generation: 1, tabId: 7, session: id, protocol: 1, ready: true, composerClean: false, generating: false };
    diagnostics.instances.report({ owner: "edge", generation: 1, revision: 1, controls: ["close"], tabs: [{ tabId: 7, conversationId: id }] });
    diagnostics.report(report);
    const body = { operationId: "close-existing-1", kind: "close", session: store.registry.get(id)!.ref };
    assert.throws(() => controls.create(body), /composer_not_clean/);
    diagnostics.report({ ...report, composerClean: true });
    controls.create(body);
    const queued = store.createTask({ session: id, text: "preserved" });
    assert.equal(store.claimNextTask(id), null);
    assert.equal(store.isSuspended(id), false);
    assert.throws(() => store.suspendDispatch(id, false), /Close must finish/);
    const command = controls.claim("edge")!;
    const evidence = { owner: "edge", token: command.token, generation: 1, documentId: "original" };
    assert.equal(controls.fence(command.operationId, evidence).execute, true);
    assert.equal(store.isSuspended(id), true);
    controls = new SessionControls(db, store, diagnostics);
    assert.equal(controls.fence(command.operationId, evidence).execute, false);
    controls.finish(command.operationId, { ...evidence, state: "succeeded", result: { action: "page_closed", suspended: true } });
    assert.equal(store.getTask(queued.id)!.status, "queued");
    assert.equal(store.claimNextTask(id), null);
    assert.equal(controls.create({ ...body, session: id }).state, "succeeded");
    store.suspendDispatch(id, false);
    assert.equal(store.claimNextTask(id)!.id, queued.id);
  } finally { db.close(); }
});

test("an old page operation cannot execute against a new worker generation", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const id = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
    store.touchSession(id);
    const diagnostics = new SessionDiagnostics(db, store);
    const controls = new SessionControls(db, store, diagnostics);
    const report = { owner: "edge", generation: 1, revision: 1, controls: ["open"], tabs: [] };
    diagnostics.instances.report(report);
    controls.create({ operationId: "open-generation", kind: "open", session: id });
    const command = controls.claim("edge")!;
    diagnostics.instances.report({ ...report, generation: 2 });
    assert.throws(() => controls.fence(command.operationId, { owner: "edge", token: command.token, generation: 2 }), /instance_generation_changed/);
    assert.equal(store.isSuspended(id), false);
  } finally { db.close(); }
});

test("browser inventory blocks refresh when a second matching tab has no page script", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const id = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
    store.touchSession(id);
    const diagnostics = new SessionDiagnostics(db, store);
    diagnostics.instances.report({ owner: "edge", generation: 1, revision: 1, controls: ["open", "close"],
      tabs: [{ tabId: 7, conversationId: id }, { tabId: 8, conversationId: id }] });
    diagnostics.report({ owner: "edge", generation: 1, tabId: 7, session: id, protocol: 1, ready: true, composerClean: true, generating: false });
    const controls = new SessionControls(db, store, diagnostics);
    assert.throws(() => controls.create({ kind: "refresh", operationId: "refresh-ambiguous", session: id }), /page_ambiguous/);
    assert.equal(store.isSuspended(id), false);
  } finally { db.close(); }
});

test("legacy control schema upgrades without losing an executing fence", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`CREATE TABLE session_controls (id TEXT PRIMARY KEY, session TEXT NOT NULL, owner TEXT NOT NULL, tab INTEGER NOT NULL,
      kind TEXT NOT NULL, task_id TEXT, state TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, error TEXT, result TEXT);`);
    db.prepare("INSERT INTO session_controls VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy-open", "legacy", "edge", 7,
      "refresh", null, "executing", "token", Date.now(), Date.now() + 120000, null, JSON.stringify({ beforeDocumentId: "original" }));
    const store = new TaskStore(db, loadConfig());
    const diagnostics = new SessionDiagnostics(db, store);
    const controls = new SessionControls(db, store, diagnostics);
    assert.equal(controls.claim("edge")!.state, "executing");
    assert.equal(controls.claim("edge")!.result.beforeDocumentId, "original");
    assert.equal(controls.fence("legacy-open", { owner: "edge", token: "token", documentId: "different" }).execute, false);
  } finally { db.close(); }
});
