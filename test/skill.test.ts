// test/skill.test.ts
// 验证 skills/gpt-relay-review/scripts 关键脚本。使用异步 spawn 避免与同进程 server 死锁。
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
const SCRIPTS = path.join(REPO_ROOT, "skills", "gpt-relay-review", "scripts");

let server: http.Server | null = null;
let stop: (() => void) | null = null;
let baseUrl = "";
let dataDir = "";

interface SpawnResult { stdout: string; stderr: string; code: number }

function runNode(
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
      env: { ...process.env, GPT_RELAY_URL: baseUrl, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout: ${script}`));
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

test("health.mjs reports ok", async () => {
  const r = await runNode("health.mjs", []);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /ok/);
});

test("health.mjs exits 1 when relay unreachable", async () => {
  const r = await runNode("health.mjs", [], { GPT_RELAY_URL: "http://127.0.0.1:1" });
  assert.equal(r.code, 1);
});

test("sessions.mjs returns JSON array", async () => {
  const r = await runNode("sessions.mjs", []);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const arr = JSON.parse(r.stdout);
  assert.ok(Array.isArray(arr));
});

test("list.mjs prints header", async () => {
  const r = await runNode("list.mjs", ["--last", "5"]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /taskId\tsession\tstatus/);
});

test("review.mjs --no-wait submits and returns taskId immediately", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-p-"));
  try {
    const r = await runNode("review.mjs", [
      "--session", "skill-nw",
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

test("resume.mjs reports no pending when dir empty", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-relay-p-"));
  try {
    const r = await runNode("resume.mjs", [], { GPT_RELAY_PENDING_DIR: tmp });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /no pending/);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
});