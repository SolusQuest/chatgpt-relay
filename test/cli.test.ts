// test/cli.test.ts
// Verify the published gpt-relay CLI shim. Async spawn avoids deadlocking the in-process server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI = path.join(REPO_ROOT, "bin", "gpt-relay.mjs");

let server: http.Server | null = null;
let stop: (() => void) | null = null;
let baseUrl = "";
let dataDir = "";

interface SpawnResult { stdout: string; stderr: string; code: number }

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GPT_RELAY_URL: baseUrl, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout: gpt-relay ${args.join(" ")}`));
    }, 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.on("error", reject);
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-skill-"));
  process.env.GPT_RELAY_DATA_DIR = dataDir;
  const config = loadConfig();
  const handle = createApp(config);
  stop = handle.stopMaintenance;
  await new Promise<void>((resolve) => {
    server = handle.app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  stop?.();
  await new Promise<void>((r) => server?.close(() => r()));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

test("gpt-relay health reports ok", async () => {
  const r = await runCli(["health"]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /ok/);
});

test("gpt-relay health exits 1 when relay unreachable", async () => {
  const r = await runCli(["health"], { GPT_RELAY_URL: "http://127.0.0.1:1" });
  assert.equal(r.code, 1);
});

test("gpt-relay sessions reports no active sessions", async () => {
  const r = await runCli(["sessions"]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /no active sessions/);
});

test("gpt-relay tasks reports no tasks", async () => {
  const r = await runCli(["tasks", "--last", "5"]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /no tasks/);
});

test("gpt-relay review --no-wait submits and returns taskId immediately", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-p-"));
  try {
    const r = await runCli([
      "review",
      "--session", "cli-nw",
      "--text", "hi",
      "--no-wait",
    ], { GPT_RELAY_PENDING_DIR: tmp });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, "queued");
    assert.match(parsed.taskId, /^[a-f0-9-]{36}$/);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
});

test("gpt-relay review separates client wait timeout from task timeout", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-p-"));
  try {
    const waitOnly = await runCli([
      "review",
      "--session", "cli-timeout-wait",
      "--text", "wait only",
      "--no-wait",
      "--timeout", "1000",
    ], { GPT_RELAY_PENDING_DIR: tmp });
    assert.equal(waitOnly.code, 0, `stderr: ${waitOnly.stderr}`);
    const waitTaskId = JSON.parse(waitOnly.stdout).taskId;
    const waitTask = await fetch(`${baseUrl}/v1/tasks/${waitTaskId}`)
      .then((r) => r.json()) as { timeoutMs: number };
    assert.ok(waitTask.timeoutMs > 1000);

    const hardTask = await runCli([
      "review",
      "--session", "cli-timeout-hard",
      "--text", "hard timeout",
      "--no-wait",
      "--task-timeout", "1000",
    ], { GPT_RELAY_PENDING_DIR: tmp });
    assert.equal(hardTask.code, 0, `stderr: ${hardTask.stderr}`);
    const hardTaskId = JSON.parse(hardTask.stdout).taskId;
    const hardTaskView = await fetch(`${baseUrl}/v1/tasks/${hardTaskId}`)
      .then((r) => r.json()) as { timeoutMs: number };
    assert.equal(hardTaskView.timeoutMs, 1000);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
});

test("gpt-relay resume reports no pending when dir empty", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-p-"));
  try {
    const r = await runCli(["resume"], { GPT_RELAY_PENDING_DIR: tmp });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /no pending/);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
});

test("gpt-relay show labels in-memory progress as provisional", async () => {
  const created = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: "cli-progress", text: "watch" }),
  }).then((r) => r.json()) as { taskId: string };
  await fetch(`${baseUrl}/internal/next_task?session=cli-progress`);
  await fetch(`${baseUrl}/internal/tasks/${created.taskId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phase: "send_attempted" }),
  });
  await fetch(`${baseUrl}/internal/tasks/${created.taskId}/observation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phase: "answer_streaming",
      activity: "Reading files",
      outputChars: 321,
    }),
  });

  const shown = await runCli(["show", created.taskId]);
  assert.equal(shown.code, 0, `stderr: ${shown.stderr}`);
  assert.match(shown.stdout, /progress \(provisional\)/);
  assert.match(shown.stdout, /submission:\s+verifying/);
  assert.match(shown.stdout, /verify until:/);
  assert.match(shown.stdout, /answer_streaming/);
  assert.match(shown.stdout, /Reading files/);
  assert.match(shown.stdout, /321/);
  assert.doesNotMatch(shown.stdout, /partial reply/);
  await fetch(`${baseUrl}/internal/tasks/${created.taskId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "done" }),
  });
});
