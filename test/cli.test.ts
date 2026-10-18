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
import { listBrowserInstances, inspectSession, submitSessionControl, getOperation } from "../client/agent-client.js";

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
  cwd = REPO_ROOT,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
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
    child.on("close", (code) => {
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

test("CLI creates a ref with first text, exposes its status, and refuses implicit project defaults", async () => {
  const pending = fs.mkdtempSync(path.join(os.tmpdir(), "relay-create-cli-"));
  try {
    const ref = "sr_cli_created";
    const args = ["review", "--new-session", "--session-ref", ref, "--no-project", "--text", "bootstrap", "--no-wait"];
    const first = await runCli(args, { GPT_RELAY_PENDING_DIR: pending });
    assert.equal(first.code, 0, first.stderr);
    const accepted = JSON.parse(first.stdout);
    assert.equal(accepted.sessionRef, ref);
    assert.ok(accepted.clientRequestId);
    const duplicate = await runCli(args, { GPT_RELAY_PENDING_DIR: pending });
    assert.equal(JSON.parse(duplicate.stdout).taskId, accepted.taskId);
    const queried = await runCli(["sessions", "--session-ref", ref, "--json"]);
    assert.equal(JSON.parse(queried.stdout).initialTaskId, accepted.taskId);
    const listed = await runCli(["tasks", "--session-ref", ref]);
    assert.match(listed.stdout, /queued/);
    for (const invalid of [
      ["review", "--new-session", "--session-ref", "sr_missing_project", "--text", "first"],
      ["review", "--new-session", "--session-ref", "sr_both", "--no-project", "--project-id", "bad", "--text", "first"],
      ["review", "--session", "legacy", "--session-ref", ref, "--text", "first"],
    ]) assert.equal((await runCli(invalid, { GPT_RELAY_PENDING_DIR: pending })).code, 64);
  } finally { fs.rmSync(pending, { recursive: true, force: true }); }
});

test("CLI project maintenance updates local metadata and preserves descriptions", async () => {
  const id = "g-p-" + "b".repeat(32);
  assert.equal((await runCli(["projects", "set", "--project-id", id, "--name", "Test", "--description", "Purpose"])).code, 0);
  assert.equal((await runCli(["projects", "set", "--project-id", id, "--name", "Renamed"])).code, 0);
  const result = await runCli(["projects", "--json"]);
  const row = JSON.parse(result.stdout).projects.find((p: any) => p.projectId === id);
  assert.equal(row.name, "Renamed");
  assert.equal(row.description, "Purpose");
  assert.equal((await runCli(["projects", "remove", "--project-id", id])).code, 0);
});

test("CLI discovery returns an asynchronous ID and rejects unsupported options", async () => {
  const r = await runCli(["projects", "discover", "--no-wait", "--save"]);
  assert.equal(r.code, 0, r.stderr);
  const row = JSON.parse(r.stdout);
  assert.equal(row.status, "queued"); assert.equal(row.save, true);
  assert.ok(row.discoveryId);
  assert.notEqual((await runCli(["projects", "discover", "--all"])).code, 0);
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

test("sessions inspect resolves a session and reports unknown page state", async () => {
  await fetch(`${baseUrl}/internal/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: "inspect-cli" }) });
  const r = await runCli(["sessions", "inspect", "--session", "inspect-cli"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).pageStatus, "unknown");
  assert.equal(JSON.parse(r.stdout).activeTaskId, null);
});

test("agent commands return structured errors for missing sessions", async () => {
  const r = await runCli(["sessions", "inspect", "--session", "nonexistent-session"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stderr).errorInfo.code, "session_not_found");
  assert.equal(JSON.parse(r.stderr).errorInfo.safeToResubmit, null);
});

test("maintenance CLI suspends, diagnoses and tracks an idempotent refresh operation", async () => {
  const session = "maintenance-cli";
  const post = async (route: string, body: unknown) => (await fetch(`${baseUrl}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })).json() as Promise<any>;
  await post("/internal/heartbeat", { session });
  await post("/internal/session-snapshots", { owner: "cli-browser", tabId: 42, session, protocol: 1,
    ready: true, generating: false, composerClean: true, capabilities: { composer: true } });
  for (const action of ["suspend", "continue"]) {
    const r = await runCli(["sessions", action, "--session", session]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).suspended, action === "suspend");
  }
  const doctor = await runCli(["doctor", "--session", session]);
  assert.equal(doctor.code, 0, doctor.stderr);
  const args = ["sessions", "refresh", "--session", session, "--operation-id", "cli-refresh-test"];
  const created = await runCli(args);
  assert.equal(created.code, 0, created.stderr);
  const command = (await post("/internal/session-controls/claim", { owner: "cli-browser" })).command;
  assert.equal(command.operationId, "cli-refresh-test");
  await post(`/internal/session-controls/${command.operationId}/finish`, { owner: command.owner, token: command.token,
    state: "blocked", error: "composer_not_clean" });
  const status = await runCli(["operations", command.operationId]);
  assert.equal(JSON.parse(status.stdout).errorInfo.code, "composer_not_clean");
  const retried = await runCli(args);
  assert.equal(JSON.parse(retried.stdout).state, "blocked");
  const bad = await runCli([...args, "--force"]);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stderr).errorInfo.code, "client_error");
});

test("CLI and client open and close accept both identities and preserve idempotency and suspension", async () => {
  const session = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
  const owner = "page-controls-cli";
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.json() as Promise<any>;
  };
  await post("/internal/heartbeat", { session });
  await post("/internal/browser-inventory", { owner, generation: 1, revision: 1, controls: ["open", "close"], tabs: [] });
  const ref = (await inspectSession(session, baseUrl)).sessionRef;
  const opened = await runCli(["sessions", "open", "--session-ref", ref, "--instance", owner, "--operation-id", "cli-open-existing"]);
  assert.equal(opened.code, 0, opened.stderr);
  assert.equal(JSON.parse(opened.stdout).instanceId, owner);
  const retried = await submitSessionControl({ kind: "open", session, operationId: "cli-open-existing", instanceId: owner }, baseUrl);
  assert.equal(retried.operationId, "cli-open-existing");
  assert.equal((await listBrowserInstances(baseUrl)).find(i => i.instanceId === owner)!.tabs.length, 0);
  const command = (await post("/internal/session-controls/claim", { owner })).command;
  await post(`/internal/session-controls/${command.operationId}/finish`, { owner, token: command.token, state: "succeeded", result: { action: "page_reused" } });
  await post("/internal/browser-inventory", { owner, generation: 1, revision: 2, controls: ["open", "close"], tabs: [{ tabId: 7, conversationId: session }] });
  await post("/internal/session-snapshots", { owner, generation: 1, tabId: 7, session, protocol: 1, ready: true, generating: false, composerClean: true });
  const closed = await runCli(["sessions", "close", "--session", session, "--operation-id", "cli-close-existing"]);
  assert.equal(closed.code, 0, closed.stderr);
  const close = (await post("/internal/session-controls/claim", { owner })).command;
  await post(`/internal/session-controls/${close.operationId}/fence`, { owner, token: close.token, generation: 1, documentId: "original" });
  const blockedContinue = await runCli(["sessions", "continue", "--session-ref", ref]);
  assert.equal(blockedContinue.code, 1);
  await post(`/internal/session-controls/${close.operationId}/finish`, { owner, token: close.token, state: "blocked", error: "composer_not_clean" });
  const operation = await getOperation(close.operationId, baseUrl);
  assert.equal(operation.suspended, true);
  assert.equal(operation.result!.suspended, true);
  const repeatClose = await runCli(["sessions", "close", "--session-ref", ref, "--operation-id", close.operationId]);
  assert.equal(JSON.parse(repeatClose.stdout).state, "blocked");
  for (const args of [
    ["sessions", "open", "--session", session, "--session-ref", ref],
    ["sessions", "close", "--session", session, "--instance", owner],
    ["sessions", "open", "--session", session, "--force"],
  ]) assert.equal((await runCli(args)).code, 1);
});

test("--output saves review JSON with relative paths and keeps stdout unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-output-"));
  try {
    fs.mkdirSync(path.join(dir, "results"));
    fs.writeFileSync(path.join(dir, "prompt.md"), "\u5ba1\u67e5 Unicode input\n");
    const args = ["review", "--new-session", "--session-ref", "sr_cli_output", "--no-project",
      "--file", "prompt.md", "--no-wait", "--json", "--server", baseUrl, "--cri", "cli-output"];
    const env = { GPT_RELAY_PENDING_DIR: path.join(dir, "pending") };
    const saved = await runCli([...args, "--output", "results/\u5ba1\u67e5 result.json"], env, dir);
    assert.equal(saved.code, 0, saved.stderr);
    const target = path.join(dir, "results/\u5ba1\u67e5 result.json");
    assert.equal(fs.readFileSync(target, "utf8"), saved.stdout);
    const result = JSON.parse(saved.stdout);
    assert.equal(result.sessionRef, "sr_cli_output");
    assert.equal(result.status, "queued");
    assert.ok(result.taskId);
    const legacy = await runCli(args, env, dir);
    assert.deepEqual(legacy, saved);
    fs.writeFileSync(target, "old longer content".repeat(100));
    const replaced = await runCli([...args, "--output", target], env, dir);
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), replaced.stdout);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("--output covers observation and control commands and excludes stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-output-"));
  try {
    await fetch(`${baseUrl}/internal/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: "output-controls" }) });
    await fetch(`${baseUrl}/internal/session-snapshots`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "output-browser", tabId: 99, session: "output-controls", protocol: 1,
        ready: true, generating: false, composerClean: true, capabilities: { composer: true } }) });
    const target = path.join(dir, "result.json");
    const env = { GPT_RELAY_PENDING_DIR: path.join(dir, "pending"), GPT_RELAY_CLIENT_CONFIG: path.join(dir, "config.json"),
      GPT_RELAY_DISCOVERY: "0", GPT_RELAY_REGISTRY_DIR: path.join(dir, "registry") };
    for (const args of [["sessions", "--json"], ["tasks", "--json"], ["projects", "--json"],
      ["resume", "--json"], ["bind", "--json"], ["detect", "--list", "--json"],
      ["sessions", "refresh", "--session", "output-controls", "--operation-id", "output-refresh", "--json"],
      ["operations", "output-refresh", "--json"], ["doctor", "--json"]]) {
      const result = await runCli([...args, "--output", target], env);
      assert.ok([0, 2].includes(result.code), result.stderr);
      assert.equal(fs.readFileSync(target, "utf8"), result.stdout);
      JSON.parse(result.stdout);
      if (args[1] === "refresh") assert.deepEqual(JSON.parse(result.stderr), { operationId: "output-refresh" });
    }
    const health = await runCli(["health", "--output", target], env);
    assert.equal(health.code, 0, health.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), health.stdout);
    assert.match(health.stdout, /^ok /);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("--output rejects invalid paths before submitting and preserves files on command errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-output-"));
  try {
    for (const target of [dir, path.join(dir, "missing", "result.json")]) {
      const r = await runCli(["review", "--session", "output-must-not-submit", "--text", "test", "--no-wait", "--json", "--output", target]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      assert.equal(JSON.parse(r.stderr).error, "output_write_failed");
      assert.ok(JSON.parse(r.stderr).message.includes(target));
    }
    const tasks = await runCli(["tasks", "--session", "output-must-not-submit", "--json"]);
    assert.deepEqual(JSON.parse(tasks.stdout), { tasks: [] });
    const target = path.join(dir, "previous.json");
    const previous = '{"previous":true}\n';
    fs.writeFileSync(target, previous);
    const r = await runCli(["sessions", "inspect", "--session", "output-missing-session", "--json", "--output", target]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(fs.readFileSync(target, "utf8"), previous);
    assert.deepEqual(fs.readdirSync(dir), ["previous.json"]);
    const missingTask = await runCli(["show", "nonexistent-output-task", "--json", "--output", target]);
    assert.equal(missingTask.code, 1);
    assert.equal(missingTask.stdout, "");
    assert.equal(fs.readFileSync(target, "utf8"), previous);
    for (const args of [["health", "--output"], ["health", "--output", ""],
      ["health", "--output", target, "--output", target], ["start", "--output", target], ["service", "status", "--output", target]]) {
      assert.equal((await runCli(args)).code, 64);
    }
    assert.equal(fs.readFileSync(target, "utf8"), previous);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
