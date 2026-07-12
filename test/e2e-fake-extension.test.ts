// test/e2e-fake-extension.test.ts
// 端到端：起 server + fake 扩展 + agent-client review()，验证完整链路。
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { review, resumePending, listPending, clearPending } from "../client/agent-client.js";

let server: http.Server | null = null;
let stopMaintenance: (() => void) | null = null;
let baseUrl = "";
let dataDir = "";
let pendingDir = "";

/** Fake 扩展：轮询 /internal/next_task → 假装 ChatGPT 回复 → POST complete */
function startFakeExtension(sessionId: string, replier: (prompt: string) => string) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const res = await fetch(
          `${baseUrl}/internal/next_task?session=${sessionId}&wait=1000`,
        );
        const data = (await res.json()) as {
          task: { taskId: string; text: string } | null;
        };
        if (data.task) {
          const reply = replier(data.task.text);
          await fetch(`${baseUrl}/internal/tasks/${data.task.taskId}/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: reply }),
          });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgcon-e2e-"));
  pendingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgcon-pending-"));
  process.env.CGCON_DATA_DIR = dataDir;
  process.env.CGCON_PENDING_DIR = pendingDir;
  const config = loadConfig();
  const handle = createApp(config);
  stopMaintenance = handle.stopMaintenance;
  await new Promise<void>((resolve) => {
    server = handle.app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  process.env.CGCON_URL = baseUrl;
});

after(async () => {
  stopMaintenance?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(pendingDir, { recursive: true, force: true }); } catch { /* */ }
});

test("review round-trip via fake extension", async () => {
  const stopExt = startFakeExtension("e2e-1", (p) => `echo: ${p}`);
  try {
    const r = await review("hello there", { session: "e2e-1", baseUrl });
    assert.ok("reply" in r);
    assert.equal(r.status, "done");
    assert.equal(r.reply, "echo: hello there");
    assert.ok(r.elapsedMs >= 0);
  } finally {
    stopExt();
  }
});

test("resume returns already-done task from previous crash", async () => {
  const stopExt = startFakeExtension("e2e-2", (p) => `late: ${p}`);
  try {
    // 用 wait:false 提交 → 拿到 taskId 并已写 pending
    const submitted = await review("resume me", {
      session: "e2e-2",
      baseUrl,
      wait: false,
    });
    assert.ok(!("reply" in submitted));
    // 等 fake extension 完成
    await new Promise((r) => setTimeout(r, 500));
    // 现在 resume 应能看到 done
    const rows = await resumePending(baseUrl);
    const row = rows.find((r) => r.record.taskId === submitted.taskId);
    assert.ok(row);
    assert.equal(row!.task?.status, "done");
    assert.equal(row!.task?.reply, "late: resume me");
    // pending 文件应被清理
    assert.ok(!listPending().some((p) => p.taskId === submitted.taskId));
  } finally {
    stopExt();
  }
});

test("pause via session_status stops new tasks", async () => {
  await fetch(`${baseUrl}/internal/sessions/e2e-3/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused: true, reason: "test-pause" }),
  });
  try {
    await review("should fail", { session: "e2e-3", baseUrl });
    assert.fail("expected review to throw");
  } catch (err) {
    assert.match((err as Error).message, /paused/i);
  }
  // 清理 pending（review 提交阶段就失败了，不会有 pending 文件；防止 leak）
  for (const p of listPending()) clearPending(p.taskId);
});