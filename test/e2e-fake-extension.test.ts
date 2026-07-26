// test/e2e-fake-extension.test.ts
// End-to-end coverage with a server, fake extension, and agent-client review().
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { review, resumePending, listPending, clearPending, getTask, cancelTask } from "../client/agent-client.js";

let server: http.Server | null = null;
let stopMaintenance: (() => void) | null = null;
let baseUrl = "";
let dataDir = "";
let pendingDir = "";

/** Fake extension: poll /internal/next_task, simulate ChatGPT, then POST completion. */
function startFakeExtension(sessionId: string, replier: (prompt: string) => string | Promise<string>) {
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
          const reply = await replier(data.task.text);
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-e2e-"));
  pendingDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-pending-"));
  process.env.GPT_RELAY_DATA_DIR = dataDir;
  process.env.GPT_RELAY_PENDING_DIR = pendingDir;
  const config = loadConfig();
  const handle = createApp(config);
  stopMaintenance = handle.stopMaintenance;
  await new Promise<void>((resolve) => {
    server = handle.app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  process.env.GPT_RELAY_URL = baseUrl;
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
    // Submit with wait:false to get a taskId and persist a pending record.
    const submitted = await review("resume me", {
      session: "e2e-2",
      baseUrl,
      wait: false,
    });
    assert.ok(!("reply" in submitted));
    // Wait for the fake extension to complete the task.
    await new Promise((r) => setTimeout(r, 500));
    // Resume should now observe the completed task.
    const rows = await resumePending(baseUrl);
    const row = rows.find((r) => r.record.taskId === submitted.taskId);
    assert.ok(row);
    assert.equal(row!.task?.status, "done");
    assert.equal(row!.task?.reply, "late: resume me");
    // The pending record should be removed.
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
  // Clean pending state defensively after a submission-stage failure.
  for (const p of listPending()) clearPending(p.taskId);
});

test("two sessions run in parallel", async () => {
  const log: string[] = [];
  const stop1 = startFakeExtension("parallel-1", (p) => {
    log.push(`s1:${p}`);
    return `s1-echo: ${p}`;
  });
  const stop2 = startFakeExtension("parallel-2", (p) => {
    log.push(`s2:${p}`);
    return `s2-echo: ${p}`;
  });
  try {
    const [r1, r2] = await Promise.all([
      review("prompt-1", { session: "parallel-1", baseUrl }),
      review("prompt-2", { session: "parallel-2", baseUrl }),
    ]);
    assert.equal(r1.status, "done");
    assert.equal(r1.reply, "s1-echo: prompt-1");
    assert.equal(r2.status, "done");
    assert.equal(r2.reply, "s2-echo: prompt-2");
    assert.ok(log.includes("s1:prompt-1"));
    assert.ok(log.includes("s2:prompt-2"));
  } finally {
    stop1();
    stop2();
  }
});

test("fake extension keeps long-polling on empty queue and picks up task later", async () => {
  const stop = startFakeExtension("late-1", (p) => `late-echo: ${p}`);
  try {
    // Keep the extension polling an empty queue and confirm that it stays alive.
    await new Promise((r) => setTimeout(r, 300));
    const start = Date.now();
    const r = await review("late prompt", { session: "late-1", baseUrl });
    const elapsed = Date.now() - start;
    assert.equal(r.status, "done");
    assert.equal(r.reply, "late-echo: late prompt");
    // It should be claimed within one long-poll cycle, not after a minute-scale delay.
    assert.ok(elapsed < 3000, `task took too long: ${elapsed}ms`);
  } finally {
    stop();
  }
});

test("fake extension recovers after restart with queued task", async () => {
  let stop = startFakeExtension("restart-1", (p) => `restarted: ${p}`);
  try {
    const submitted = await review("survive extension restart", {
      session: "restart-1",
      baseUrl,
      wait: false,
    });
    // Simulate a service-worker restart while the task is probably still queued.
    stop();
    await new Promise((r) => setTimeout(r, 400));
    // Restarting the extension simulates an alarm waking the service worker.
    stop = startFakeExtension("restart-1", (p) => `restarted: ${p}`);
    let task = null;
    for (let i = 0; i < 50; i++) {
      task = await getTask(submitted.taskId, baseUrl);
      if (task?.status === "done") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(task?.status, "done");
    assert.equal(task?.reply, "restarted: survive extension restart");
  } finally {
    stop();
  }
});

test("client wait timeout then resume gets reply", async () => {
  const stop = startFakeExtension(
    "resume-timeout",
    (p) => new Promise<string>((resolve) => setTimeout(() => resolve(`slow: ${p}`), 3000)),
  );
  try {
    await assert.rejects(
      () => review("timeout me", { session: "resume-timeout", baseUrl, timeoutMs: 1000 }),
      /timeout/i,
    );
    await new Promise((r) => setTimeout(r, 3500));
    const rows = await resumePending(baseUrl);
    const row = rows.find((r) => r.record.session === "resume-timeout");
    assert.ok(row);
    assert.equal(row!.task?.status, "done");
    assert.equal(row!.task?.reply, "slow: timeout me");
    assert.ok((row!.task?.timeoutMs ?? 0) > 1000, "client wait timeout must not shorten task lifetime");
  } finally {
    stop();
  }
});

test("resume keeps timeout failure pending until a late reply is captured", async () => {
  const submitted = await review("capture me later", {
    session: "late-pending",
    baseUrl,
    wait: false,
  });
  const claim = await fetch(`${baseUrl}/internal/next_task?session=late-pending`)
    .then((r) => r.json()) as { task: { taskId: string } };
  assert.equal(claim.task.taskId, submitted.taskId);
  await fetch(`${baseUrl}/internal/tasks/${submitted.taskId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "task_processing_timeout" }),
  });

  const beforeLate = await resumePending(baseUrl);
  const waiting = beforeLate.find((row) => row.record.taskId === submitted.taskId);
  assert.equal(waiting?.task?.status, "failed");
  assert.equal(waiting?.task?.lateReply, null);
  assert.ok(listPending().some((row) => row.taskId === submitted.taskId));

  await fetch(`${baseUrl}/internal/tasks/${submitted.taskId}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "late but preserved" }),
  });
  const afterLate = await resumePending(baseUrl);
  const captured = afterLate.find((row) => row.record.taskId === submitted.taskId);
  assert.equal(captured?.task?.lateReply, "late but preserved");
  assert.ok(!listPending().some((row) => row.taskId === submitted.taskId));
});

test("sequential tasks in same session are queued and processed in order", async () => {
  const replies: string[] = [];
  const stop = startFakeExtension("sequential", (p) => {
    replies.push(p);
    return `seq: ${p}`;
  });
  try {
    const r1 = await review("first", { session: "sequential", baseUrl });
    const r2 = await review("second", { session: "sequential", baseUrl });
    const r3 = await review("third", { session: "sequential", baseUrl });
    assert.equal(r1.status, "done");
    assert.equal(r2.status, "done");
    assert.equal(r3.status, "done");
    assert.equal(r1.reply, "seq: first");
    assert.equal(r2.reply, "seq: second");
    assert.equal(r3.reply, "seq: third");
    assert.deepEqual(replies, ["first", "second", "third"]);
  } finally {
    stop();
  }
});

test("cancel queued task prevents processing", async () => {
  const submitted = await review("cancel me", {
    session: "cancel-test",
    baseUrl,
    wait: false,
  });
  const cancelled = await cancelTask(submitted.taskId, baseUrl);
  assert.equal(cancelled.status, "cancelled");
  const stop = startFakeExtension("cancel-test", (p) => `should not run: ${p}`);
  try {
    await new Promise((r) => setTimeout(r, 600));
    const task = await getTask(submitted.taskId, baseUrl);
    assert.equal(task?.status, "cancelled");
  } finally {
    stop();
  }
});

test("cancel in-progress task", async () => {
  const stop = startFakeExtension(
    "cancel-inflight",
    (p) => new Promise<string>((resolve) => setTimeout(() => resolve(`slow: ${p}`), 4000)),
  );
  try {
    const submitted = await review("cancel inflight", {
      session: "cancel-inflight",
      baseUrl,
      wait: false,
    });
    await new Promise((r) => setTimeout(r, 300));
    const cancelled = await cancelTask(submitted.taskId, baseUrl);
    assert.equal(cancelled.status, "cancelled");
    await new Promise((r) => setTimeout(r, 500));
    const task = await getTask(submitted.taskId, baseUrl);
    assert.equal(task?.status, "cancelled");
  } finally {
    stop();
  }
});

test("task expires when timeout is too short", async () => {
  // Without the fake extension, the queued task should eventually expire.
  const submitted = await review("expire me", {
    session: "expire-test",
    baseUrl,
    wait: false,
    taskTimeoutMs: 1000,
  });
  await new Promise((r) => setTimeout(r, 2500));
  // Give the maintenance loop enough time to remove the expired queued task.
  await new Promise((r) => setTimeout(r, 3000));
  const task = await getTask(submitted.taskId, baseUrl);
  assert.equal(task?.status, "expired");
});

test("special characters and multiline text", async () => {
  const stop = startFakeExtension("special", (p) => `got ${p.length} chars`);
  try {
    const text = 'Hello 世界 🌍\nLine2\t"quoted" <html> &amp; \\backslash\r\n日本語';
    const r = await review(text, { session: "special", baseUrl });
    assert.equal(r.status, "done");
    assert.equal(r.reply, `got ${text.length} chars`);
  } finally {
    stop();
  }
});

test("multiple tasks per session in parallel across sessions", async () => {
  const replies = new Map<string, string[]>();
  for (const sid of ["multi-a", "multi-b"]) {
    replies.set(sid, []);
  }
  const stopA = startFakeExtension("multi-a", (p) => {
    replies.get("multi-a")!.push(p);
    return `A:${p}`;
  });
  const stopB = startFakeExtension("multi-b", (p) => {
    replies.get("multi-b")!.push(p);
    return `B:${p}`;
  });
  try {
    const tasks: Promise<any>[] = [];
    for (let i = 0; i < 3; i++) {
      tasks.push(review(`a-${i}`, { session: "multi-a", baseUrl }));
      tasks.push(review(`b-${i}`, { session: "multi-b", baseUrl }));
    }
    const results = await Promise.all(tasks);
    assert.equal(results.filter((r) => r.reply?.startsWith("A:")).length, 3);
    assert.equal(results.filter((r) => r.reply?.startsWith("B:")).length, 3);
    assert.deepEqual(replies.get("multi-a"), ["a-0", "a-1", "a-2"]);
    assert.deepEqual(replies.get("multi-b"), ["b-0", "b-1", "b-2"]);
  } finally {
    stopA();
    stopB();
  }
});
