import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";
import { SessionControls } from "../server/session-controls.js";
import { SessionDiagnostics } from "../server/session-diagnostics.js";
import { verifyEffort } from "../shared/effort.js";

const policy = { effort: "max", effortFallback: "error" } as const;
const selection = { requestedEffort: "max", effectiveEffort: "max", fallbackApplied: false, modelFamily: "GPT-6" } as const;
const ids = { submittedUserMessageId: "original-user", assistantMessageId: "original-answer" };
const verified = { ...ids, model: "gpt-6-thinking", thinkingEffort: "max" };
const mismatch = { ...verified, thinkingEffort: "extended" };
const unknown = { ...ids, model: null, thinkingEffort: null, reason: "timeout", attempts: 3 };

function fixture() {
  const db = openDatabase(":memory:");
  const store = new TaskStore(db, loadConfig());
  store.touchSession("chat"); store.registry.setEffort("chat", policy);
  const task = store.createTask({ session: "chat", text: "original prompt" });
  store.claimNextTask("chat"); store.recordEffortSelection(task.id, selection);
  store.markTaskProgress(task.id, "send_attempted");
  store.captureReply(task.id, "original reply", Date.now(), unknown);
  return { db, store, task: store.getTask(task.id)! };
}

test("post-hoc controls survive restart, bind exact turns and preserve captured reply and diagnostics", () => {
  const { db, store, task } = fixture();
  try {
    assert.equal(task.status, "done"); assert.equal(task.error, null);
    assert.equal(task.effortVerification!.reason, "timeout");
    const diagnostics = new SessionDiagnostics(db, store);
    // Read-only verification also works while the composer contains a draft.
    diagnostics.report({ session: "chat", owner: "browser", tabId: 7, protocol: 1, composerClean: false });
    let controls = new SessionControls(db, store, diagnostics);
    const body = { kind: "reverify-effort", taskId: task.id, operationId: "reverify-original" };
    controls.create(body);
    const command = controls.claim("browser")!;
    assert.deepEqual(command.target, ids);
    const owner = { owner: "browser", token: command.token };
    assert.throws(() => controls.finish(command.operationId, { ...owner, owner: "other", state: "succeeded", result: verified }), /ownership/);
    assert.throws(() => controls.finish(command.operationId, { ...owner, state: "succeeded", result: { ...verified, assistantMessageId: "later-answer" } }), /identity_mismatch/);
    controls = new SessionControls(db, store, diagnostics);
    assert.equal(controls.claim("browser")!.operationId, command.operationId);
    assert.equal(controls.finish(command.operationId, { ...owner, state: "succeeded", result: verified }).result.status, "verified");
    assert.equal(controls.create(body).state, "succeeded");
    const updated = new TaskStore(db, loadConfig()).getTask(task.id)!;
    assert.equal(updated.reply, task.reply); assert.equal(updated.completedAt, task.completedAt);
    assert.equal(updated.sendAttemptedAt, task.sendAttemptedAt); assert.equal(updated.requeueCount, 0);
    assert.equal(updated.effortVerification!.status, "verified");
    const history = JSON.stringify(store.traceTask(task.id));
    assert.match(history, /timeout/); assert.match(history, /effort_reverified/);
    assert.equal(store.reverifyEffort(task.id, unknown).effortVerification!.status, "verified");
    assert.equal(store.reverifyEffort(task.id, mismatch).error, "effort_mismatch");
    assert.equal(store.reverifyEffort(task.id, unknown).effortVerification!.status, "mismatch");
    assert.equal(store.reverifyEffort(task.id, verified).effortVerification!.status, "mismatch");
  } finally { db.close(); }
});

test("legacy unknown without exact IDs is not rebound; legacy identified failure can be repaired", () => {
  const { db, store, task } = fixture();
  try {
    db.prepare("UPDATE tasks SET status='failed',error='effort_verification_unknown' WHERE id=?").run(task.id);
    const updated = store.reverifyEffort(task.id, verified);
    assert.equal(updated.status, "done"); assert.equal(updated.error, null);
    db.prepare("UPDATE tasks SET effort_verification=? WHERE id=?").run(JSON.stringify({ status: "unknown", model: null, thinkingEffort: null }), task.id);
    const controls = new SessionControls(db, store, new SessionDiagnostics(db, store));
    assert.throws(() => controls.create({ kind: "reverify-effort", taskId: task.id, operationId: "reverify-legacy" }), /missing_turn_ids/);
    assert.throws(() => store.reverifyEffort(task.id, verified), /identity_mismatch/);
  } finally { db.close(); }
});

test("bounded evidence strips arbitrary diagnostic payload and known wrong family remains mismatch", () => {
  const result = verifyEffort(selection, { ...unknown, reason: "secret body", httpStatus: 503, accessToken: "SECRET", attempts: 99 });
  assert.equal(result.reason, "missing_evidence"); assert.equal(result.attempts, undefined);
  assert.equal(result.httpStatus, 503); assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(verifyEffort(selection, { model: "gpt-5.6-thinking" }).status, "mismatch");
});

function reader(fetch: (url: string, options: any) => Promise<any>, timers?: { timeout: boolean }) {
  const worker = fs.readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  const source = worker.slice(worker.indexOf("async function readEffortEvidence("), worker.indexOf("async function verifyReplyEffort("));
  const context: any = { location: { origin: "https://chatgpt.com", pathname: "/c/chat" }, AbortController,
    setTimeout: (callback: () => void, ms: number) => { if (ms < 15000 || timers?.timeout) queueMicrotask(callback); return 1; },
    clearTimeout: () => {}, fetch };
  vm.runInNewContext(source, context);
  return context;
}
const response = () => ({ ok: true, json: async () => ({ messages: [
  { id: ids.submittedUserMessageId, author: { role: "user" } },
  { id: ids.assistantMessageId, author: { role: "assistant" }, status: "finished_successfully", metadata: { model_slug: "gpt-6-thinking", thinking_effort: "max" } },
] }) });

test("history retries only reads, recovers transient failure, and stops on permanent HTTP/identity failure", async () => {
  let calls = 0;
  const context = reader(async (url, options) => {
    assert.ok(url.startsWith("/backend-api/conversations/")); assert.equal(options.method, undefined);
    calls++;
    if (calls === 1) throw new Error("transient");
    if (calls === 2) return { ok: false, status: 503 };
    return response();
  });
  const result = await context.readEffortEvidence("chat", ids.submittedUserMessageId, ids.assistantMessageId);
  assert.equal(result.model, "gpt-6-thinking"); assert.equal(result.attempts, 3); assert.equal(calls, 3);
  calls = 0;
  const permanent = reader(async () => { calls++; return { ok: false, status: 403 }; });
  assert.equal((await permanent.readEffortEvidence("chat", "u", "a")).httpStatus, 403);
  assert.equal(calls, 1);
  permanent.location.pathname = "/c/other";
  assert.equal((await permanent.readEffortEvidence("chat", "u", "a")).reason, "identity_changed");
  assert.equal(calls, 1);
});

test("history timeout and metadata lag report bounded causes and retry counts", async () => {
  let calls = 0;
  const context = reader(async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private error"))));
  }, { timeout: true });
  const result = await context.readEffortEvidence("chat", "u", "a");
  assert.equal(result.reason, "timeout"); assert.equal(result.attempts, 3); assert.equal(calls, 3);
  assert.ok(!JSON.stringify(result).includes("private error"));
  calls = 0;
  const lag = reader(async () => {
    calls++;
    return calls < 3 ? { ok: true, json: async () => ({ messages: [] }) } : response();
  });
  assert.equal((await lag.readEffortEvidence("chat", ids.submittedUserMessageId, ids.assistantMessageId)).attempts, 3);
});
