import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppHandle } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { listSessions } from "../client/agent-client.js";
import type { ReviewResult } from "../client/agent-client.js";
import { reviewExitCode } from "../client/task-output.js";

let handle: AppHandle, server: Server, base: string, temp: string, serial = 0;
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-effort-cli-"));
  handle = createApp({ ...loadConfig(), dbFile: path.join(temp, "test.db") });
  server = await new Promise<Server>(resolve => {
    const listening = handle.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  handle?.stopMaintenance();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  handle?.closeDatabase();
  fs.rmSync(temp, { recursive: true, force: true });
});

function fixture(options: { effort?: "max" | "pro" | null; verification?: "verified" | "mismatch" | "unknown"; late?: boolean; pending?: boolean; preSendFailure?: boolean } = {}) {
  const session = `ec-${serial++}`;
  const effort = options.effort === undefined ? "max" : options.effort;
  handle.store.touchSession(session);
  if (effort) handle.store.registry.setEffort(session, { effort, effortFallback: effort === "pro" ? "max" : "error" });
  const task = handle.store.createTask({ session, text: "audit", clientRequestId: session });
  if (options.pending) return { session, id: task.id };
  handle.store.claimNextTask(session);
  if (options.preSendFailure) {
    handle.store.completeTask(task.id, { error: "effort_unavailable" });
    return { session, id: task.id };
  }
  if (effort) handle.store.recordEffortSelection(task.id, { requestedEffort: effort, effectiveEffort: "max", fallbackApplied: effort === "pro", modelFamily: "GPT-6" });
  handle.store.markTaskProgress(task.id, "send_attempted");
  if (options.late) handle.store.completeTask(task.id, { error: "task_processing_timeout" });
  const evidence = options.verification === "unknown" ? null : { model: "gpt-6-thinking", thinkingEffort: options.verification === "mismatch" ? "standard" : "max" };
  handle.store.captureReply(task.id, "CAPTURED_AUDIT_REPLY", Date.now(), evidence);
  return { session, id: task.id };
}

async function cli(args: string[], pending?: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/gpt-relay.mjs", ...(args[0] === "--help" ? [] : ["--server", base]), ...args], {
      env: { ...process.env, GPT_RELAY_PENDING_DIR: pending ?? path.join(temp, `pending-${serial++}`) },
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI timed out")); }, 10000);
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.stdin.end();
  });
}
function pendingFor(task: ReturnType<typeof fixture>) {
  const dir = path.join(temp, `resume-${serial++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify({ taskId: task.id, session: task.session,
    textPreview: "audit", submittedAt: Date.now(), serverId: handle.identity.serverId, baseUrl: base }));
  return dir;
}

test("show exposes effort verification and raw task JSON including errors and retained replies", async () => {
  const task = fixture({ effort: "pro", verification: "mismatch" });
  const text = await cli(["show", task.id]);
  assert.equal(text.code, 0);
  for (const value of ["pro", "max", "mismatch", "gpt-6-thinking", "standard", "CAPTURED_AUDIT_REPLY"]) assert.ok(text.stdout.includes(value), value);
  const json = JSON.parse((await cli(["show", task.id, "--json"])).stdout);
  assert.equal(json.effortSelection.fallbackApplied, true);
  assert.equal(json.effortVerification.status, "mismatch");
  assert.equal(json.errorInfo.safeToResubmit, false);
  assert.equal(json.reply, "CAPTURED_AUDIT_REPLY");
});

test("tasks JSON works for empty and populated filters and text summarizes effort", async () => {
  const task = fixture({ verification: "unknown" });
  const args = ["tasks", "--session", task.session];
  const json = JSON.parse((await cli([...args, "--json"])).stdout);
  assert.equal(json.tasks[0].effortVerification.status, "unknown");
  const text = await cli(args);
  assert.match(text.stdout, /max/);
  assert.match(text.stdout, /unknown/);
  assert.deepEqual(JSON.parse((await cli(["tasks", "--session", "absent", "--json"])).stdout), { tasks: [] });
});

test("show distinguishes disabled, pending and terminal unchecked verification", async () => {
  for (const [options, label] of [[{ effort: null }, "disabled"], [{ pending: true }, "pending"], [{ preSendFailure: true }, "not_checked"]] as const) {
    const task = fixture(options);
    assert.ok((await cli(["show", task.id])).stdout.includes(label), label);
  }
});

test("review preserves failed replies and uses identical text/JSON exit codes for normal and late results", async () => {
  for (const late of [false, true]) for (const verification of ["verified", "mismatch", "unknown"] as const) {
    const task = fixture({ late, verification });
    for (const json of [false, true]) {
      const result = await cli(["review", "--session", task.session, "--text", "audit", "--cri", task.session, ...(json ? ["--json"] : [])]);
      assert.equal(result.code, verification !== "mismatch" ? 0 : 2, JSON.stringify({ late, verification, json, result }));
      assert.ok(result.stdout.includes("CAPTURED_AUDIT_REPLY"));
      if (json) {
        const view = JSON.parse(result.stdout);
        assert.equal(view.effortVerification.status, verification);
        if (view.error) assert.equal(view.errorInfo.safeToResubmit, false);
      }
    }
  }
});

test("late replies without effort preserve success behavior in both output modes", async () => {
  const task = fixture({ effort: null, late: true });
  for (const json of [false, true]) {
    const result = await cli(["review", "--session", task.session, "--text", "audit", "--cri", task.session, ...(json ? ["--json"] : [])]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes("CAPTURED_AUDIT_REPLY"));
  }
});

test("--output preserves terminal review text, JSON and nonzero result exit codes", async () => {
  const task = fixture({ verification: "mismatch" });
  for (const json of [false, true]) {
    const args = ["review", "--session", task.session, "--text", "audit", "--cri", task.session, ...(json ? ["--json"] : [])];
    const legacy = await cli(args);
    const target = path.join(temp, `review-result-${json}.txt`);
    const saved = await cli([...args, "--output", target]);
    assert.equal(saved.code, 2);
    if (json) {
      const { elapsedMs: savedMs, ...savedResult } = JSON.parse(saved.stdout);
      const { elapsedMs: legacyMs, ...legacyResult } = JSON.parse(legacy.stdout);
      assert.equal(typeof savedMs, "number");
      assert.equal(typeof legacyMs, "number");
      assert.deepEqual(savedResult, legacyResult);
    } else assert.equal(saved.stdout, legacy.stdout);
    assert.equal(saved.stderr, legacy.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), saved.stdout);
    if (json) assert.equal(JSON.parse(saved.stdout).effortVerification.status, "mismatch");
    else assert.equal(saved.stdout, "CAPTURED_AUDIT_REPLY");
    for (const command of [["show", task.id, "--json"], ["tasks", "trace", task.id, "--json"]]) {
      const view = await cli([...command, "--output", target]);
      assert.equal(view.code, 0, view.stderr);
      assert.equal(fs.readFileSync(target, "utf8"), view.stdout);
      JSON.parse(view.stdout);
    }
  }
});

test("resume exposes failed captured replies and verification in text and JSON", async () => {
  for (const late of [false, true]) {
    const task = fixture({ late, verification: "mismatch" });
    const text = await cli(["resume"], pendingFor(task));
    assert.equal(text.code, 0);
    assert.match(text.stdout, /CAPTURED_AUDIT_REPLY/);
    assert.match(text.stdout, /mismatch/);
    const json = JSON.parse((await cli(["resume", "--json"], pendingFor(task))).stdout);
    assert.equal(json.results[0].task.effortVerification.status, "mismatch");
    assert.equal(json.results[0].task.errorInfo.safeToResubmit, false);
  }
  assert.deepEqual(JSON.parse((await cli(["resume", "--json"])).stdout), { results: [] });
});

test("resume JSON retains unresolved records without resubmission", async () => {
  const dir = pendingFor({ id: "missing-task", session: "missing-session" });
  const result = JSON.parse((await cli(["resume", "--json"], dir)).stdout).results[0];
  assert.equal(result.task, null);
  assert.equal(result.reason, "not_found_retained");
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("sessions expose saved effort policy in text, JSON and typed SDK results", async () => {
  const task = fixture({ effort: "pro" });
  const text = await cli(["sessions"]);
  const row = text.stdout.split("\n").find(line => line.startsWith(task.session.slice(0, 12) + "…"));
  assert.ok(row?.includes("pro"));
  assert.ok(row?.includes("max"));
  const json = JSON.parse((await cli(["sessions", "--json"])).stdout);
  assert.deepEqual(json.sessions.find((s: any) => s.session === task.session).effortPolicy, { effort: "pro", effortFallback: "max" });
  assert.equal((await listSessions(base)).find(s => s.session === task.session)?.effortPolicy?.effort, "pro");
});

test("CLI help documents effort operation IDs and JSON observation commands", async () => {
  const help = await cli(["--help"]);
  assert.match(help.stdout, /sessions effort[^\n]*--operation-id/);
  for (const command of ["show", "tasks", "resume"]) assert.match(help.stdout, new RegExp(`^  ${command}[^\\n]*--json`, "m"));
});

test("effort controls return structured errors without requiring --json", async () => {
  for (const args of [
    ["sessions", "effort", "--session", "absent", "--effort", "max"],
    ["sessions", "effort", "--session", "absent", "--effort", "invalid"],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.ok(error.errorInfo.code);
    assert.equal(error.errorInfo.safeToResubmit, null);
  }
});

test("review requires a verification result but allows explicit unknown warnings", () => {
  const base: ReviewResult = { taskId: "test", status: "done", reply: "reply", lateReply: null,
    error: null, submissionState: "replied", elapsedMs: 1, effortPolicy: { effort: "max", effortFallback: "error" } };
  for (const status of ["done", "failed"] as const) for (const verification of [undefined, null, { status: "unknown", model: null, thinkingEffort: null }] as const) {
    assert.equal(reviewExitCode({ ...base, status, lateReply: status === "failed" ? "late" : null, effortVerification: verification }), verification ? 0 : 2);
  }
  assert.equal(reviewExitCode({ ...base, status: "failed", error: "effort_verification_unknown",
    effortVerification: { status: "unknown", model: null, thinkingEffort: null } }), 0);
  assert.equal(reviewExitCode({ ...base, status: "failed", error: "effort_mismatch",
    effortVerification: { status: "unknown", model: null, thinkingEffort: null } }), 2);
  assert.equal(reviewExitCode({ ...base, effortPolicy: null, status: "failed", lateReply: undefined as any }), 2);
  assert.equal(reviewExitCode({ ...base, status: "cancelled", lateReply: "late", effortVerification: { status: "verified", model: "gpt-6-thinking", thinkingEffort: "max" } }), 2);
});

test("CLI post-hoc verification observes an owned operation and exposes the original task result", async () => {
  const task = fixture({ verification: "unknown" });
  const ids = { submittedUserMessageId: "original-user", assistantMessageId: "original-assistant" };
  const dbTask = handle.store.getTask(task.id)!;
  // fixture captured a legacy null evidence result; use a new identified task.
  const identified = handle.store.createTask({ session: task.session, text: "next audit" });
  handle.store.claimNextTask(task.session);
  handle.store.recordEffortSelection(identified.id, dbTask.effortSelection!);
  handle.store.markTaskProgress(identified.id, "send_attempted");
  handle.store.captureReply(identified.id, "SAVED_REPLY", Date.now(), { ...ids, reason: "timeout", attempts: 3 });
  // Reports go through the existing HTTP diagnostics contract.
  const report = await fetch(`${base}/internal/session-snapshots`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: task.session, owner: "reverify-browser", tabId: 7, protocol: 1 }) });
  assert.equal(report.status, 200);
  const opId = `reverify-cli-${serial++}`;
  const created = await cli(["tasks", "reverify-effort", identified.id, "--operation-id", opId, "--json"]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).state, "queued");
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const { command } = await post("/internal/session-controls/claim", { owner: "reverify-browser" });
  assert.deepEqual(command.target, ids);
  await post(`/internal/session-controls/${opId}/finish`, { owner: command.owner, token: command.token, state: "succeeded",
    result: { ...ids, model: "gpt-6-thinking", thinkingEffort: "max" } });
  const operation = JSON.parse((await cli(["operations", opId, "--json"])).stdout);
  assert.equal(operation.result.status, "verified");
  const shown = JSON.parse((await cli(["show", identified.id, "--json"])).stdout);
  assert.equal(shown.effortVerification.status, "verified");
  assert.equal(shown.reply, "SAVED_REPLY"); assert.equal(shown.requeueCount, 0);
  const legacy = await cli(["tasks", "reverify-effort", task.id, "--operation-id", `legacy-cli-${serial++}`]);
  assert.equal(legacy.code, 1); assert.match(legacy.stderr, /missing_turn_ids/);
});
