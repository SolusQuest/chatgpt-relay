// test/v1-api.test.ts
// v1 HTTP API integration tests with the real Express app and fetch.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import type { TaskStore } from "../server/task-store.js";
import type { AddressInfo } from "node:net";

let baseUrl = "";
let server: http.Server | null = null;
let stopMaintenance: (() => void) | null = null;
let taskStore: TaskStore | null = null;
let dataDir = "";

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-v1-"));
  process.env.GPT_RELAY_DATA_DIR = dataDir;
  process.env.GPT_RELAY_PORT = "0";
  const config = loadConfig();
  const handle = createApp(config);
  taskStore = handle.store;
  stopMaintenance = handle.stopMaintenance;
  await new Promise<void>((resolve) => {
    server = handle.app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  stopMaintenance?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may hold SQLite WAL files */ }
});

async function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function get(p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: await res.json() };
}
async function del(p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${p}`, { method: "DELETE" });
  return { status: res.status, json: await res.json() };
}

test("GET /health returns ok", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
});

test('disconnected next_task poll cannot claim a later task',async()=>{
  const session='disconnected-claim';
  const original=taskStore!.onSessionTaskChange.bind(taskStore);
  let registered!:()=>void;
  const waiting=new Promise<void>(resolve=>{registered=resolve;});
  taskStore!.onSessionTaskChange=(sid,listener)=>{
    const off=original(sid,listener);
    if(sid===session) registered();
    return off;
  };
  let responseClosed!:()=>void;
  const closed=new Promise<void>(resolve=>{responseClosed=resolve;});
  const trackClose=(req:http.IncomingMessage,res:http.ServerResponse)=>{
    if(req.url?.includes(session)) res.once('close',responseClosed);
  };
  server!.on('request',trackClose);
  const request=http.get(`${baseUrl}/internal/next_task?session=${session}&wait=1000`);
  request.on('error',()=>{});
  try {
    await waiting;
    request.destroy();
    await closed;
    const created=await post('/v1/tasks',{session,text:'must stay queued until a live poll claims it'});
    const task=await get(`/v1/tasks/${created.json.taskId}`);
    assert.equal(task.json.status,'queued');
    const live=await get(`/internal/next_task?session=${session}`);
    assert.equal(live.json.task.taskId,created.json.taskId);
  } finally {
    request.destroy();
    taskStore!.onSessionTaskChange=original;
    server!.off('request',trackClose);
  }
});

test("POST /v1/tasks creates queued task", async () => {
  const r = await post("/v1/tasks", { session: "sA", text: "hello" });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "queued");
  assert.ok(typeof r.json.taskId === "string");
});

test("POST /v1/tasks rejects missing text", async () => {
  const r = await post("/v1/tasks", { session: "sA" });
  assert.equal(r.status, 400);
});

test("GET /v1/tasks/:id long-polls until claim + complete", async () => {
  const created = await post("/v1/tasks", { session: "sB", text: "poll me" });
  const taskId = created.json.taskId as string;

  setTimeout(async () => {
    const nx = await get("/internal/next_task?session=sB&wait=0");
    const t = nx.json.task;
    await post(`/internal/tasks/${t.taskId}/complete`, { text: "reply-1" });
  }, 200);

  const r = await get(`/v1/tasks/${taskId}?wait=3000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "done");
  assert.equal(r.json.reply, "reply-1");
});

test("DELETE /v1/tasks/:id cancels queued task", async () => {
  const c = await post("/v1/tasks", { session: "sC", text: "cancel me" });
  const id = c.json.taskId;
  const r = await del(`/v1/tasks/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "cancelled");
});

test("internal next_task returns null then task on demand", async () => {
  const empty = await get("/internal/next_task?session=sD");
  assert.equal(empty.json.task, null);
  await post("/v1/tasks", { session: "sD", text: "hi" });
  const got = await get("/internal/next_task?session=sD");
  assert.equal(got.json.task?.text, "hi");
  assert.equal(typeof got.json.task?.expiresAt, "number");
  assert.equal(typeof got.json.task?.completionDeadlineAt, "number");
  assert.equal(typeof got.json.task?.recoveryDeadlineAt, "number");
  assert.equal(typeof got.json.task?.lateReplyDeadlineAt, "number");
});

test("internal next_task honors long-poll wait", async () => {
  setTimeout(() => {
    void post("/v1/tasks", { session: "sE", text: "delayed" });
  }, 150);
  const t0 = Date.now();
  const r = await get("/internal/next_task?session=sE&wait=2000");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 100, `should wait, elapsed=${elapsed}`);
  assert.equal(r.json.task?.text, "delayed");
});

test("internal user-stop cancels an in-progress task", async () => {
  const created = await post("/v1/tasks", { session: "stop-api", text: "stop me" });
  const taskId = created.json.taskId;
  const claim = await get("/internal/next_task?session=stop-api");
  assert.equal(claim.json.task?.taskId, taskId);

  const stopped = await post(`/internal/tasks/${taskId}/user-stop`, {
    reason: "user stopped before reply",
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.status, "cancelled");

  const task = await get(`/v1/tasks/${taskId}`);
  assert.equal(task.json.status, "cancelled");
  assert.equal(task.json.error, "user stopped before reply");
});

test("internal requeue moves in_progress back to queued", async () => {
  const c = await post("/v1/tasks", { session: "sF", text: "retry" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=sF");
  const rq = await post(`/internal/tasks/${id}/requeue`, {});
  assert.equal(rq.json.status, "queued");
});

test("internal requeue rejects a task after Send may have been attempted", async () => {
  const c = await post("/v1/tasks", { session: "sF-fenced", text: "do not retry" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=sF-fenced");
  await post(`/internal/tasks/${id}/progress`, { phase: "send_attempted" });
  const rq = await post(`/internal/tasks/${id}/requeue`, {});
  assert.equal(rq.status, 400);
  assert.equal(rq.json.error, "unsafe_retry_after_send_attempt");
  const task = await get(`/v1/tasks/${id}`);
  assert.equal(task.json.status, "in_progress");
});

test("session pause fails in-flight tasks", async () => {
  const c = await post("/v1/tasks", { session: "sG", text: "will pause" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=sG");
  await post("/internal/sessions/sG/status", { paused: true, reason: "captcha" });
  const r = await get(`/v1/tasks/${id}`);
  assert.equal(r.json.status, "failed");
  assert.match(r.json.error ?? "", /captcha/);
});

test("internal attachment pause can preserve queued successors", async () => {
  const first = await post("/v1/tasks", { session: "attachment-pause", text: "upload" });
  const second = await post("/v1/tasks", { session: "attachment-pause", text: "next" });
  await get("/internal/next_task?session=attachment-pause");
  await post("/internal/sessions/attachment-pause/status", {
    paused: true,
    reason: "attachment cleanup uncertain",
    preserveQueued: true,
  });

  assert.equal((await get(`/v1/tasks/${first.json.taskId}`)).json.status, "failed");
  assert.equal((await get(`/v1/tasks/${second.json.taskId}`)).json.status, "queued");
  const blocked = await post("/v1/tasks", { session: "attachment-pause", text: "blocked" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, "session_paused");
  await post("/internal/sessions/attachment-pause/status", { paused: false });
  const next = await get("/internal/next_task?session=attachment-pause");
  assert.equal(next.json.task.taskId, second.json.taskId);
});

test("v1 sessions lists active sessions with pending count", async () => {
  await post("/v1/tasks", { session: "sH", text: "one" });
  await post("/v1/tasks", { session: "sH", text: "two" });
  const r = await get("/v1/sessions");
  const sH = r.json.sessions.find((s: any) => s.session === "sH");
  assert.ok(sH);
  assert.equal(sH.pendingTasks, 2);
});

test("clientRequestId dedup at HTTP layer", async () => {
  const a = await post("/v1/tasks", {
    session: "sI",
    text: "once",
    clientRequestId: "cri-42",
  });
  const b = await post("/v1/tasks", {
    session: "sI",
    text: "once",
    clientRequestId: "cri-42",
  });
  assert.equal(a.json.taskId, b.json.taskId);
  const conflict = await post("/v1/tasks", { session: "sI", text: "twice", clientRequestId: "cri-42" });
  assert.equal(conflict.status, 409);
});

test("recover endpoint completes an in-flight task with DOM-captured reply", async () => {
  const c = await post("/v1/tasks", { session: "sR", text: "recover me" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=sR");
  const rec = await post(`/internal/tasks/${id}/recover`, { text: "captured reply" });
  assert.equal(rec.json.status, "done");
  assert.equal(rec.json.recovered, true);
  const t = await get(`/v1/tasks/${id}`);
  assert.equal(t.json.reply, "captured reply");
});

test("recover on already-done task is idempotent", async () => {
  const c = await post("/v1/tasks", { session: "sR2", text: "already done" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=sR2");
  await post(`/internal/tasks/${id}/complete`, { text: "original" });
  const rec = await post(`/internal/tasks/${id}/recover`, { text: "duplicate" });
  assert.equal(rec.json.status, "done");
  assert.equal(rec.json.recovered, false);
  const t = await get(`/v1/tasks/${id}`);
  assert.equal(t.json.reply, "original");
});

test("capture stores timeout reply as late without rewriting failed status", async () => {
  const c = await post("/v1/tasks", {
    session: "late-capture",
    text: "slow answer",
    timeout: 1000,
  });
  const id = c.json.taskId;
  await get("/internal/next_task?session=late-capture");

  // Force the same timeout terminal state the maintenance loop produces.
  await post(`/internal/tasks/${id}/complete`, { error: "task_processing_timeout" });
  const captured = await post(`/internal/tasks/${id}/capture`, {
    text: "eventual browser reply",
  });
  assert.equal(captured.status, 200);
  assert.equal(captured.json.captured, true);
  assert.equal(captured.json.late, true);

  const task = await get(`/v1/tasks/${id}`);
  assert.equal(task.json.status, "failed");
  assert.equal(task.json.reply, null);
  assert.equal(task.json.lateReply, "eventual browser reply");
  assert.equal(typeof task.json.lateCompletedAt, "number");
});

test("progress endpoint records page lifecycle timestamps", async () => {
  const c = await post("/v1/tasks", { session: "progress-api", text: "trace me" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=progress-api");
  for (const phase of [
    "submit_started",
    "send_attempted",
    "submit_acknowledged",
    "generating_seen",
    "recovery_observed",
    "reply_detected",
  ]) {
    const progress = await post(`/internal/tasks/${id}/progress`, { phase });
    assert.equal(progress.status, 200);
  }
  const task = await get(`/v1/tasks/${id}`);
  assert.equal(typeof task.json.submitStartedAt, "number");
  assert.equal(typeof task.json.sendAttemptedAt, "number");
  assert.equal(typeof task.json.submitAcknowledgedAt, "number");
  assert.equal(typeof task.json.generatingSeenAt, "number");
  assert.equal(typeof task.json.recoveryObservedAt, "number");
  assert.equal(typeof task.json.replyDetectedAt, "number");
});

test("task view exposes submission verification and late correction", async () => {
  const c = await post("/v1/tasks", { session: "submission-state-api", text: "trace send" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=submission-state-api");

  const before = await get(`/v1/tasks/${id}`);
  assert.equal(before.json.submissionState, "not_attempted");
  assert.equal(before.json.submissionVerificationDeadlineAt, null);

  await post(`/internal/tasks/${id}/progress`, { phase: "send_attempted" });
  const verifying = await get(`/v1/tasks/${id}`);
  assert.equal(verifying.json.submissionState, "verifying");
  assert.equal(
    verifying.json.submissionVerificationDeadlineAt,
    verifying.json.sendAttemptedAt + 120_000,
  );

  await post(`/internal/tasks/${id}/complete`, { error: "submission_not_observed" });
  const failed = await get(`/v1/tasks/${id}`);
  assert.equal(failed.json.submissionState, "not_observed");

  await post(`/internal/tasks/${id}/capture`, { text: "late correction" });
  const corrected = await get(`/v1/tasks/${id}`);
  assert.equal(corrected.json.submissionState, "replied");
  assert.equal(corrected.json.lateReply, "late correction");

  const c2 = await post("/v1/tasks", {
    session: "submission-state-api",
    text: "acknowledged send",
  });
  const id2 = c2.json.taskId;
  await get("/internal/next_task?session=submission-state-api");
  await post(`/internal/tasks/${id2}/progress`, { phase: "send_attempted" });
  await post(`/internal/tasks/${id2}/progress`, { phase: "submit_acknowledged" });
  const acknowledged = await get(`/v1/tasks/${id2}`);
  assert.equal(acknowledged.json.submissionState, "acknowledged");
  assert.equal(acknowledged.json.submissionVerificationDeadlineAt, null);
  await post(`/internal/tasks/${id2}/complete`, { text: "done" });
});

test("provisional observations stay separate from durable task results", async () => {
  const c = await post("/v1/tasks", { session: "observation-api", text: "watch me" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=observation-api");

  const first = await post(`/internal/tasks/${id}/observation`, {
    phase: "generating",
    activity: "  Reading\nfiles  ",
    outputChars: 0,
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.progress.provisional, true);
  assert.equal(first.json.progress.activity, "Reading files");
  const revision = first.json.progress.revision as number;

  const waiting = get(`/v1/tasks/${id}?wait=3000&progress_after=${revision}`);
  setTimeout(() => {
    void post(`/internal/tasks/${id}/observation`, {
      phase: "answer_streaming",
      outputChars: 250,
    });
  }, 100);
  const changed = await waiting;
  assert.equal(changed.status, 200);
  assert.equal(changed.json.status, "in_progress");
  assert.equal(changed.json.progress.phase, "answer_streaming");
  assert.equal(changed.json.progress.outputChars, 250);
  assert.ok(changed.json.progress.revision > revision);
  assert.equal(changed.json.reply, null);

  await post(`/internal/tasks/${id}/complete`, { text: "final answer" });
  const done = await get(`/v1/tasks/${id}`);
  assert.equal(done.json.status, "done");
  assert.equal(done.json.reply, "final answer");
  assert.equal(done.json.progress, null);
});

test("observation endpoint validates provisional fields", async () => {
  const c = await post("/v1/tasks", { session: "observation-invalid", text: "watch" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=observation-invalid");

  assert.equal((await post(`/internal/tasks/${id}/observation`, {
    phase: "hidden_reasoning",
  })).status, 400);
  assert.equal((await post(`/internal/tasks/${id}/observation`, {
    phase: "generating",
    outputChars: "12",
  })).status, 400);
  assert.equal((await get(`/v1/tasks/${id}?progress_after=invalid`)).status, 400);
});

test("soft deadline exposes recovering until a normal reply completes it", async () => {
  const c = await post("/v1/tasks", {
    session: "recovering-api",
    text: "keep waiting",
    timeout: 1000,
  });
  const id = c.json.taskId;
  await get("/internal/next_task?session=recovering-api");
  await post(`/internal/tasks/${id}/progress`, { phase: "send_attempted" });
  await post(`/internal/tasks/${id}/progress`, { phase: "submit_acknowledged" });
  const active = await get(`/v1/tasks/${id}`);
  taskStore!.expireDueTasks(active.json.completionDeadlineAt + 1);

  const recovering = await get(`/v1/tasks/${id}?wait=1`);
  assert.equal(recovering.json.status, "recovering");
  assert.equal(recovering.json.error, null);
  assert.equal(recovering.json.recoveryReason, "task_deadline_exceeded");
  assert.equal(typeof recovering.json.recoveryStartedAt, "number");
  assert.equal(typeof recovering.json.recoveryLeaseDeadlineAt, "number");
  assert.equal(typeof recovering.json.recoveryDeadlineAt, "number");

  const sessions = await get("/v1/sessions");
  const session = sessions.json.sessions.find((row: any) => row.session === "recovering-api");
  assert.equal(session.activeTaskId, id);
  assert.equal(session.activeTaskStatus, "recovering");

  const captured = await post(`/internal/tasks/${id}/capture`, { text: "finished late" });
  assert.equal(captured.json.status, "done");
  assert.equal(captured.json.late, false);
  const done = await get(`/v1/tasks/${id}`);
  assert.equal(done.json.reply, "finished late");
  assert.equal(done.json.lateReply, null);
});

test("page user Stop cancels a recovering task", async () => {
  const c = await post("/v1/tasks", {
    session: "recovering-stop-api",
    text: "stop this recovery",
    timeout: 1000,
  });
  const id = c.json.taskId;
  await get("/internal/next_task?session=recovering-stop-api");
  await post(`/internal/tasks/${id}/progress`, { phase: "send_attempted" });
  const active = await get(`/v1/tasks/${id}`);
  taskStore!.expireDueTasks(active.json.completionDeadlineAt + 1);

  const stopped = await post(`/internal/tasks/${id}/user-stop`, {
    reason: "user selected Stop",
  });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.status, "cancelled");
  const cancelled = await get(`/v1/tasks/${id}`);
  assert.equal(cancelled.json.status, "cancelled");
  assert.equal(cancelled.json.error, "user selected Stop");
});

test("defer endpoint returns a claimed page-busy task to queued", async () => {
  const c = await post("/v1/tasks", { session: "defer-api", text: "wait for page" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=defer-api");
  const deferred = await post(`/internal/tasks/${id}/defer`, {});
  assert.equal(deferred.status, 200);
  assert.equal(deferred.json.status, "queued");
  const task = await get(`/v1/tasks/${id}`);
  assert.equal(task.json.status, "queued");
  assert.equal(task.json.requeueCount, 0);
});

test("recover on unknown task returns 404", async () => {
  const rec = await post(`/internal/tasks/nope/recover`, { text: "x" });
  assert.equal(rec.status, 404);
});

test("POST /v1/tasks auto-fixes latin-1 mojibake", async () => {
  const original = "帮我 review";
  const mojibake = Buffer.from(original, "utf8").toString("latin1");
  const r = await post("/v1/tasks", { session: "sEnc1", text: mojibake });
  assert.equal(r.status, 201);
  assert.ok(r.json.encodingFixed, `expected encodingFixed, got ${JSON.stringify(r.json)}`);
  // The server should persist the repaired text.
  const taskId = r.json.taskId;
  const t = await get(`/v1/tasks/${taskId}?include_text=1`);
  // Lists require include_text=1, while GET /:id includes text by default.
  assert.equal(t.json.text, original);
});

test("POST /v1/tasks warns on ASCII-lossy input but preserves it", async () => {
  const r = await post("/v1/tasks", {
    session: "sEnc2",
    text: "?? review ?????? code",
  });
  assert.equal(r.status, 201);
  assert.ok(r.json.encodingWarning, `expected encodingWarning, got ${JSON.stringify(r.json)}`);
  const t = await get(`/v1/tasks/${r.json.taskId}`);
  assert.equal(t.json.text, "?? review ?????? code");
});

test("POST /v1/tasks passes through clean UTF-8 CJK without warning", async () => {
  const r = await post("/v1/tasks", {
    session: "sEnc3",
    text: "帮我 review 一下这段代码：function f(x){return x*2}",
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.encodingFixed, undefined);
  assert.equal(r.json.encodingWarning, undefined);
});

test("creation effort is durable, idempotent and validated before dispatch", async () => {
  const body = { sessionRef: "sr_effort_creation_api", projectId: null, text: "effort create",
    effort: "high", effortFallback: "lower" };
  const created = await post("/v1/sessions", body);
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.effortPolicy, { effort: "high", effortFallback: "lower" });
  assert.equal((await post("/v1/sessions", body)).json.taskId, created.json.taskId);
  assert.equal((await post("/v1/sessions", { ...body, effort: "max" })).status, 409);
  assert.equal((await post("/v1/sessions", { ...body, sessionRef: "sr_invalid_effort", effort: "xhigh" })).status, 400);
  const owner = { owner: "effort-api-owner" };
  // Claim may return earlier pending creations in this shared test database;
  // the registry's owned API lets this test attach only its own creation.
  let row = taskStore!.registry.get(body.sessionRef)!;
  for (let n = 0; n < 100 && !row.owner; n++) {
    const next = taskStore!.registry.claim(owner.owner);
    if (!next) break;
    if (next.ref !== body.sessionRef) {
      taskStore!.registry.opening(next.ref, owner.owner, next.token!);
      taskStore!.registry.attach(next.ref, owner.owner, next.token!, 990 + n);
    }
    row = taskStore!.registry.get(body.sessionRef)!;
  }
  assert.equal(row.owner, owner.owner);
  taskStore!.registry.opening(row.ref, row.owner!, row.token!);
  taskStore!.registry.attach(row.ref, row.owner!, row.token!, 980);
  const claim = await get(`/internal/next_task?session=${row.ref}`);
  assert.deepEqual(claim.json.task.effortPolicy, { effort: "high", effortFallback: "lower" });
  const id = claim.json.task.taskId;
  const badFence = await post(`/internal/tasks/${id}/progress`, { phase: "send_attempted" });
  assert.equal(badFence.status, 400);
  assert.equal(taskStore!.getTask(id)!.sendAttemptedAt, null);
  const selected = { requestedEffort: "high", effectiveEffort: "high", fallbackApplied: false, modelFamily: "GPT-6" };
  assert.equal((await post(`/internal/tasks/${id}/progress`, { phase: "send_attempted", effortSelection: selected })).status, 200);
  await post(`/internal/tasks/${id}/capture`, { text: "captured fallback answer",
    effortEvidence: { model: "gpt-6-thinking", thinkingEffort: "standard" } });
  const result = (await get(`/v1/tasks/${id}`)).json;
  assert.equal(result.status, "failed");
  assert.equal(result.reply, "captured fallback answer");
  assert.equal(result.error, "effort_mismatch");
  assert.equal(result.effortVerification.status, "mismatch");
  assert.equal(result.errorInfo.safeToResubmit, false);
});

test("session effort controls validate JSON and leave unrelated controls compatible", async () => {
  for (const invalid of [{ kind: "set-effort", effort: "xhigh" }, { kind: "set-effort", effortFallback: "lower" },
      { kind: "refresh", effort: "max" }]) {
    assert.equal((await post("/v1/session-controls", { operationId: "invalid-effort-control", session: "anything", ...invalid })).status, 400);
  }
});

test("post-Send creation route mismatch cannot fail a valid reply or override successful binding", async () => {
  const ref = "sr_effort_creation_race";
  const created = await post("/v1/sessions", { sessionRef: ref, projectId: null, text: "route race", effort: "medium" });
  const owner = "effort-route-race";
  let row = taskStore!.registry.get(ref)!;
  for (let n = 0; n < 100 && !row.owner; n++) {
    const next = taskStore!.registry.claim(owner);
    if (!next) break;
    if (next.ref !== ref) {
      taskStore!.registry.opening(next.ref, owner, next.token!);
      taskStore!.registry.attach(next.ref, owner, next.token!, 700 + n);
    }
    row = taskStore!.registry.get(ref)!;
  }
  const own = { owner, token: row.token! };
  taskStore!.registry.opening(ref, owner, row.token!);
  taskStore!.registry.attach(ref, owner, row.token!, 777);
  const task = taskStore!.claimNextTask(ref)!;
  taskStore!.recordEffortSelection(task.id, { requestedEffort: "medium", effectiveEffort: "medium", fallbackApplied: false, modelFamily: "GPT-6" });
  taskStore!.markTaskProgress(task.id, "send_attempted");
  await post(`/internal/session-creations/${ref}/fail`, { ...own, error: "creation_route_mismatch" });
  assert.equal(taskStore!.getTask(task.id)!.status, "in_progress");
  await post(`/internal/session-creations/${ref}/bind`, { ...own, tabId: 777,
    conversationId: "6ad00000-0000-0000-0000-000000000077", projectId: null });
  await post(`/internal/session-creations/${ref}/fail`, { ...own, error: "stale_creation_failure" });
  assert.equal(taskStore!.getTask(task.id)!.status, "in_progress");
  await post(`/internal/tasks/${created.json.taskId}/capture`, { text: "correct answer",
    effortEvidence: { model: "gpt-6-thinking", thinkingEffort: "standard" } });
  assert.equal(taskStore!.getTask(task.id)!.status, "done");
});
