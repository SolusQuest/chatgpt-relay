// test/v1-api.test.ts
// v1 HTTP API 集成测试：真实 Express app + fetch。
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgcon-v1-"));
  process.env.CGCON_DATA_DIR = dataDir;
  process.env.CGCON_PORT = "0";
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

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}
async function del(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "DELETE" });
  return { status: res.status, json: await res.json() };
}

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

  // 后台 200ms 后完成
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

test("legacy /task + /get_task + /reply + /get_reply flow", async () => {
  const create = await post("/task", { session: "sL", text: "legacy prompt" });
  assert.equal(create.json.status, "ok");
  const taskId = create.json.taskId as string;

  const getTask = await get("/get_task?session=sL");
  assert.equal(getTask.json.taskId, taskId);
  assert.equal(getTask.json.text, "legacy prompt");

  const reply = await post("/reply", {
    session: "sL",
    taskId,
    text: "legacy reply",
  });
  assert.equal(reply.json.status, "ok");

  const getReply = await get(`/get_reply?session=sL&taskId=${taskId}`);
  assert.equal(getReply.json.text, "legacy reply");
  assert.equal(getReply.json.taskId, taskId);
});

test("legacy /session_status pause propagates", async () => {
  await post("/task", { session: "sM", text: "pending" });
  await post("/session_status", {
    session: "sM",
    paused: true,
    reason: "limit",
  });
  const list = await get("/sessions");
  const s = list.json.sessions.find((x: any) => x.session === "sM");
  assert.equal(s.paused, true);
  assert.equal(s.pauseReason, "limit");
});

test("legacy /health returns ok", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
});