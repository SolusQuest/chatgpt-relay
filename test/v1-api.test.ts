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
import type { AddressInfo } from "node:net";

let baseUrl = "";
let server: http.Server | null = null;
let stopMaintenance: (() => void) | null = null;
let dataDir = "";

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-v1-"));
  process.env.GPT_RELAY_DATA_DIR = dataDir;
  process.env.GPT_RELAY_PORT = "0";
  const config = loadConfig();
  const handle = createApp(config);
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

test("session pause fails in-flight tasks", async () => {
  const c = await post("/v1/tasks", { session: "sG", text: "will pause" });
  const id = c.json.taskId;
  await get("/internal/next_task?session=sG");
  await post("/internal/sessions/sG/status", { paused: true, reason: "captcha" });
  const r = await get(`/v1/tasks/${id}`);
  assert.equal(r.json.status, "failed");
  assert.match(r.json.error ?? "", /captcha/);
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
    text: "twice",
    clientRequestId: "cri-42",
  });
  assert.equal(a.json.taskId, b.json.taskId);
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
  for (const phase of [
    "submit_started",
    "submit_acknowledged",
    "generating_seen",
    "reply_detected",
  ]) {
    const progress = await post(`/internal/tasks/${id}/progress`, { phase });
    assert.equal(progress.status, 200);
  }
  const task = await get(`/v1/tasks/${id}`);
  assert.equal(typeof task.json.submitStartedAt, "number");
  assert.equal(typeof task.json.submitAcknowledgedAt, "number");
  assert.equal(typeof task.json.generatingSeenAt, "number");
  assert.equal(typeof task.json.replyDetectedAt, "number");
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
