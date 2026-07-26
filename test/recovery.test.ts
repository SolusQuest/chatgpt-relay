// test/recovery.test.ts
// Simulate the full extension reply-recovery path after a page refresh.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

let server: http.Server | null = null;
let stop: (() => void) | null = null;
let baseUrl = "";
let dataDir = "";

async function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
async function get(p: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${p}`);
  return { status: r.status, json: await r.json() };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-rec-"));
  process.env.GPT_RELAY_DATA_DIR = dataDir;
  const cfg = loadConfig();
  const h = createApp(cfg);
  stop = h.stopMaintenance;
  await new Promise<void>((r) => { server = h.app.listen(0, "127.0.0.1", () => r()); });
  const a = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${a.port}`;
});
after(async () => {
  stop?.();
  await new Promise<void>((r) => server?.close(() => r()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test("recover flow: task in_progress -> page reload -> DOM sees new reply -> recover completes", async () => {
  // The agent submits a task.
  const c = await post("/v1/tasks", { session: "recA", text: "please review" });
  const taskId = c.json.taskId;
  // The extension claims it.
  const claim = await get("/internal/next_task?session=recA");
  assert.equal(claim.json.task?.taskId, taskId);
  // Assume the content script submitted the prompt, then the page was refreshed.
  // On restart it reads the in-flight record, finds a new assistant message in
  // the DOM, and sends recover-task through the service worker to /recover.
  const rec = await post(`/internal/tasks/${taskId}/recover`, {
    text: "ChatGPT 说：这段代码看起来...",
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.recovered, true);
  // The agent can now retrieve the result.
  const t = await get(`/v1/tasks/${taskId}`);
  assert.equal(t.json.status, "done");
  assert.equal(t.json.reply, "ChatGPT 说：这段代码看起来...");
});

test("recover flow: no new reply -> requeue -> reclaim later", async () => {
  const c = await post("/v1/tasks", { session: "recB", text: "second try" });
  const taskId = c.json.taskId;
  await get("/internal/next_task?session=recB");
  // After refresh, no new DOM reply is present, so the task is requeued.
  const rq = await post(`/internal/tasks/${taskId}/requeue`, {});
  assert.equal(rq.json.status, "queued");
  // The next claim receives the same taskId.
  const c2 = await get("/internal/next_task?session=recB");
  assert.equal(c2.json.task?.taskId, taskId);
  assert.equal(c2.json.task?.requeueCount, 1);
});

test("recover flow: agent already saw failed status but recover still races -> idempotent noop", async () => {
  const c = await post("/v1/tasks", { session: "recC", text: "race case" });
  const taskId = c.json.taskId;
  await get("/internal/next_task?session=recC");
  // Fail the task first to simulate a reply wait timeout.
  await post(`/internal/tasks/${taskId}/complete`, { error: "timeout" });
  // The extension then recovers a reply captured from the DOM.
  const rec = await post(`/internal/tasks/${taskId}/recover`, { text: "late reply" });
  // Recovery must not overwrite the existing failed status.
  assert.equal(rec.json.recovered, false);
  const t = await get(`/v1/tasks/${taskId}`);
  assert.equal(t.json.status, "failed");
  assert.equal(t.json.reply, null);
});
