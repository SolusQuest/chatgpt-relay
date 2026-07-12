// test/recovery.test.ts
// 模拟扩展在页面刷新后从 DOM 回捞回复的完整链路。
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgcon-rec-"));
  process.env.CGCON_DATA_DIR = dataDir;
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
  // Agent 提交
  const c = await post("/v1/tasks", { session: "recA", text: "please review" });
  const taskId = c.json.taskId;
  // 扩展 claim
  const claim = await get("/internal/next_task?session=recA");
  assert.equal(claim.json.task?.taskId, taskId);
  // === 假设：此时 content-script 已注入 + 点击 send，但页面被 F5 刷新 ===
  // === 刷新后 content-script 重启，读 sessionStorage 里的 inflight，发现 ===
  // === DOM 已经有新的 assistant message，走 recover-task 消息 → SW → /recover  ===
  const rec = await post(`/internal/tasks/${taskId}/recover`, {
    text: "ChatGPT 说：这段代码看起来...",
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.recovered, true);
  // Agent 现在能拿到结果
  const t = await get(`/v1/tasks/${taskId}`);
  assert.equal(t.json.status, "done");
  assert.equal(t.json.reply, "ChatGPT 说：这段代码看起来...");
});

test("recover flow: no new reply -> requeue -> reclaim later", async () => {
  const c = await post("/v1/tasks", { session: "recB", text: "second try" });
  const taskId = c.json.taskId;
  await get("/internal/next_task?session=recB");
  // === 页面刷新后 content-script 发现 DOM 里没有新回复 → 走 requeue ===
  const rq = await post(`/internal/tasks/${taskId}/requeue`, {});
  assert.equal(rq.json.status, "queued");
  // 新一轮 claim 拿到同一 taskId
  const c2 = await get("/internal/next_task?session=recB");
  assert.equal(c2.json.task?.taskId, taskId);
  assert.equal(c2.json.task?.requeueCount, 1);
});

test("recover flow: agent already saw failed status but recover still races -> idempotent noop", async () => {
  const c = await post("/v1/tasks", { session: "recC", text: "race case" });
  const taskId = c.json.taskId;
  await get("/internal/next_task?session=recC");
  // 先让 task 失败（模拟 waitForReply timeout）
  await post(`/internal/tasks/${taskId}/complete`, { error: "timeout" });
  // 现在扩展 recover 上来一个从 DOM 抓的回复
  const rec = await post(`/internal/tasks/${taskId}/recover`, { text: "late reply" });
  // 应该被忽略（不覆盖已 failed 状态）
  assert.equal(rec.json.recovered, false);
  const t = await get(`/v1/tasks/${taskId}`);
  assert.equal(t.json.status, "failed");
  assert.equal(t.json.reply, null);
});