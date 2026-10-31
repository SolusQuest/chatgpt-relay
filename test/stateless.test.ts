import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { createApp, type AppHandle } from "../server/app.js";
import { loadConfig } from "../server/config.js";

let root: string, state: string, baseUrl: string, guard: string;
let server: http.Server, app: AppHandle;
let requests: { method: string; url: string }[];
let dropNextSubmit: boolean;
let failProbes: boolean;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stateless-"));
  state = path.join(root, "client-state");
  guard = path.join(root, "deny-client-state.mjs");
  // Detect attempted writes even if optional logging catches EACCES. Also forbid
  // pending reads: stateless must not inspect, migrate or delete other clients' work.
  fs.writeFileSync(guard, `import fs from 'node:fs'; import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const state=process.env.RELAY_STATELESS_TEST_STATE, pending=path.join(state,'pending'), touched=[];
    if(process.env.RELAY_STATELESS_GUARD!=='0') {
      for(const name of ['mkdirSync','writeFileSync','appendFileSync','renameSync','unlinkSync','rmSync','openSync',
          'existsSync','readFileSync','readdirSync']) {
        const original=fs[name];
        fs[name]=function(...args){
          const reads=['existsSync','readFileSync','readdirSync'].includes(name);
          const file=typeof args[0]==='string'?path.resolve(args[0]):'';
          const denied=reads ? file===pending||file.startsWith(pending+path.sep) : file===state||file.startsWith(state+path.sep);
          if(denied){touched.push(name);throw Object.assign(new Error('client state denied'),{code:'EACCES'});}
          return original.apply(this,args);
        };
      }
      syncBuiltinESMExports();
      process.on('exit',()=>{if(touched.length){process.stderr.write(JSON.stringify({forbiddenStateAccess:touched})+'\\n');process.exitCode=98;}});
    }
  `);
  requests = []; dropNextSubmit = false; failProbes = false;
  app = createApp({ ...loadConfig(), dataDir: root, dbFile: path.join(root, "test.db"), logDir: path.join(root, "server-logs") });
  server = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url! });
    if (failProbes && req.url === "/v1/server") {
      res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"unavailable"}'); return;
    }
    if (dropNextSubmit && req.method === "POST" && ["/v1/tasks", "/v1/sessions"].includes(req.url!)) {
      dropNextSubmit = false;
      res.end = (() => { res.destroy(); return res; }) as typeof res.end;
    }
    app.app(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  app.stopMaintenance(); app.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("bin/gpt-relay.mjs"), ...args], {
      cwd: root,
      env: { ...process.env, GPT_RELAY_URL: "", GPT_RELAY_DISCOVERY: "0", GPT_RELAY_LEGACY_FALLBACK: "0",
        GPT_RELAY_CLIENT_CONFIG: path.join(state, "client.json"), GPT_RELAY_PENDING_DIR: path.join(state, "pending"),
        GPT_RELAY_LOG_DIR: path.join(state, "logs"), GPT_RELAY_REGISTRY_DIR: path.join(state, "servers"),
        RELAY_STATELESS_TEST_STATE: state, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`, ...extraEnv },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.stdin.end();
    const timer = setTimeout(() => { child.kill(); reject(new Error("stateless CLI test timed out")); }, 12000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const options = () => ["--stateless", "--server", baseUrl, "--json"];
const reviewArgs = (session = "test-session", key = "stable-key") =>
  ["review", "--session", session, "--cri", key, "--text", "test prompt", "--no-wait", ...options()];
const errorResult = (stderr: string) => JSON.parse(stderr.trim().split("\n").at(-1)!);
function complete(taskId: string) {
  const task = app.store.getTask(taskId)!;
  assert.equal(app.store.claimNextTask(task.session)?.id, taskId);
  app.store.completeTask(taskId, { text: "test reply" });
}

test("stateless submit and same-key retry use no client files and preserve server deduplication", async () => {
  const first = await cli(reviewArgs());
  assert.equal(first.code, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.recovery.serverId, app.identity.serverId);
  assert.equal(result.recovery.baseUrl, baseUrl);
  assert.equal(result.recovery.session, "test-session");
  assert.equal(result.recovery.clientRequestId, "stable-key");
  assert.equal(result.recovery.taskId, result.taskId);
  const events = first.stderr.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.recovery.taskId), [null, result.taskId]);
  const retry = await cli(reviewArgs());
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).taskId, result.taskId);
  assert.equal(app.store.listTasks().length, 1);
  assert.equal(fs.existsSync(state), false);
});

test("changed payload with the same request key conflicts without changing the original task", async () => {
  const first = await cli(reviewArgs());
  const args = reviewArgs(); args[args.indexOf("--text") + 1] = "different prompt";
  const conflict = await cli(args);
  assert.equal(conflict.code, 1, conflict.stderr);
  assert.equal(errorResult(conflict.stderr).recovery.clientRequestId, "stable-key");
  assert.equal(errorResult(conflict.stderr).error, "duplicate_request");
  assert.equal(app.store.getTask(JSON.parse(first.stdout).taskId)?.text, "test prompt");
  assert.equal(app.store.listTasks().length, 1);
});

test("new-session stateless creation is recoverable and idempotent with its original ref and key", async () => {
  const args = ["review", "--new-session", "--session-ref", "sr_stateless_new", "--no-project",
    "--cri", "new-key", "--text", "new prompt", "--no-wait", ...options()];
  const first = await cli(args), again = await cli(args);
  assert.equal(first.code, 0, first.stderr); assert.equal(again.code, 0, again.stderr);
  const taskId = JSON.parse(first.stdout).taskId;
  assert.equal(JSON.parse(again.stdout).taskId, taskId);
  const lookup = await cli(["tasks", "--session-ref", "sr_stateless_new", "--cri", "new-key", ...options()]);
  assert.equal(lookup.code, 0, lookup.stderr);
  assert.equal(JSON.parse(lookup.stdout).tasks[0].taskId, taskId);
  assert.equal(app.store.listTasks().length, 1);
  assert.equal(fs.existsSync(state), false);
});

test("lost submit response can be looked up and waited on without another POST", async () => {
  dropNextSubmit = true;
  const lost = await cli(reviewArgs());
  assert.equal(lost.code, 1, lost.stderr);
  const identity = errorResult(lost.stderr).recovery;
  assert.equal(identity.taskId, null); assert.equal(identity.clientRequestId, "stable-key");
  assert.equal(identity.serverId, app.identity.serverId);
  const lookup = await cli(["tasks", "--session", "test-session", "--cri", "stable-key", ...options()]);
  assert.equal(lookup.code, 0, lookup.stderr);
  const tasks = JSON.parse(lookup.stdout).tasks;
  assert.equal(tasks.length, 1);
  complete(tasks[0].taskId);
  const waited = await cli(["wait", "--session", "test-session", "--cri", "stable-key", "--server-id", identity.serverId, ...options()]);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).reply, "test reply");
  assert.equal(JSON.parse(waited.stdout).recovery.taskId, tasks[0].taskId);
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
  assert.equal(fs.existsSync(state), false);
});

test("waiting timeout retains recovery identifiers and a later task-ID wait returns the same reply", async () => {
  const args = reviewArgs().filter(a => a !== "--no-wait");
  const timedOut = await cli([...args, "--wait-timeout", "40"]);
  assert.equal(timedOut.code, 1, timedOut.stderr);
  const identity = errorResult(timedOut.stderr).recovery;
  assert.ok(identity.taskId); assert.match(timedOut.stderr, /waitForTask timeout/);
  complete(identity.taskId);
  const waited = await cli(["wait", identity.taskId, "--server-id", identity.serverId, ...options()]);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).taskId, identity.taskId);
  assert.equal(JSON.parse(waited.stdout).reply, "test reply");
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
});

test("wait observes a task that becomes terminal while long-polling", async () => {
  const submitted = await cli(reviewArgs());
  const taskId = JSON.parse(submitted.stdout).taskId;
  const waiting = cli(["wait", taskId, "--wait-timeout", "3000", ...options()]);
  const timer = setTimeout(() => complete(taskId), 400);
  try {
    const result = await waiting;
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).reply, "test reply");
  } finally { clearTimeout(timer); }
});

test("request lookup remains scoped to a session and missing requests never submit", async () => {
  await cli(reviewArgs("first-session")); await cli(reviewArgs("second-session"));
  const before = requests.filter(r => r.method === "POST").length;
  const listed = await cli(["tasks", "--session", "first-session", "--cri", "stable-key", ...options()]);
  const tasks = JSON.parse(listed.stdout).tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].session, "first-session");
  const missing = await cli(["wait", "--session", "first-session", "--cri", "absent", ...options()]);
  assert.equal(missing.code, 1); assert.equal(errorResult(missing.stderr).error, "request_not_found");
  assert.equal(errorResult(missing.stderr).recovery.clientRequestId, "absent");
  assert.equal(requests.filter(r => r.method === "POST").length, before);
});

test("server identity pin refuses a different backend before lookup or submission", async () => {
  const wrong = randomUUID();
  for (const args of [reviewArgs(), ["wait", "--session", "test-session", "--cri", "stable-key", ...options()]]) {
    const result = await cli([...args, "--server-id", wrong]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(errorResult(result.stderr).error, "backend_identity_mismatch");
  }
  assert.ok(requests.every(r => r.url === "/v1/server"));
  assert.equal(fs.existsSync(state), false);
});

test("existing binding and pending records remain byte-for-byte unchanged", async () => {
  fs.mkdirSync(path.join(state, "pending"), { recursive: true });
  const config = JSON.stringify({ schemaVersion: 1, backend: { ...app.identity, baseUrl } });
  fs.writeFileSync(path.join(state, "client.json"), config);
  const record = '{"taskId":"untouched","session":"other","textPreview":"keep","submittedAt":1}';
  fs.writeFileSync(path.join(state, "pending", "untouched.json"), record);
  const args = reviewArgs(); args.splice(args.indexOf("--server"), 2);
  const result = await cli(args);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(state, "client.json"), "utf8"), config);
  assert.equal(fs.readFileSync(path.join(state, "pending", "untouched.json"), "utf8"), record);
  assert.deepEqual(fs.readdirSync(path.join(state, "pending")), ["untouched.json"]);
  assert.deepEqual(fs.readdirSync(state).sort(), ["client.json", "pending"]);
});

test("stateless mode does not auto-discover or save a missing binding", async () => {
  fs.mkdirSync(path.join(state, "servers"), { recursive: true });
  fs.writeFileSync(path.join(state, "servers", "local.json"), JSON.stringify({ baseUrl, serverId: app.identity.serverId, pid: process.pid }));
  const result = await cli(["health", "--stateless", "--json"]);
  assert.equal(result.code, 1); assert.equal(errorResult(result.stderr).error, "backend_not_configured");
  assert.equal(requests.length, 0);
  const explicitLocal = await cli(["health", "--stateless", "--local"]);
  assert.equal(explicitLocal.code, 0, explicitLocal.stderr);
  assert.equal(fs.existsSync(path.join(state, "client.json")), false);
});

test("explicit environment backend works without reading a broken binding", async () => {
  fs.mkdirSync(state); fs.writeFileSync(path.join(state, "client.json"), "invalid");
  const args = reviewArgs(); args.splice(args.indexOf("--server"), 2);
  const result = await cli(args, { GPT_RELAY_URL: baseUrl });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(state, "client.json"), "utf8"), "invalid");
});

test("failed probes retain diagnostics on stderr without attempting local logs", async () => {
  failProbes = true;
  const result = await cli(reviewArgs());
  assert.equal(result.code, 1, result.stderr);
  const error = errorResult(result.stderr);
  assert.equal(error.error, "backend_unreachable"); assert.equal(error.probe.attempts.length, 3);
  assert.equal(error.probe.logFile, undefined);
  assert.equal(fs.existsSync(state), false);
});

test("invalid stateless and lookup arguments fail before any request", async () => {
  for (const args of [
    ["review", "--stateless", "--session", "s", "--text", "test", "--no-wait"],
    ["review", "--stateless", "--session", "s", "--text", "test", "--cri", " "],
    ["resume", "--stateless"], ["bind", "--clear", "--stateless"], ["detect", "--stateless"],
    ["tasks", "--cri", "key"], ["wait"], ["wait", "--session", "s"],
    ["tasks", "--session", "", "--cri", "key"],
    ["wait", "task", "--session", "s", "--cri", "key"], ["health", "--stateless", "--stateless"],
  ]) {
    const result = await cli([...args, "--server", baseUrl, "--json"]);
    assert.equal(result.code, 64, result.stderr);
  }
  assert.equal(requests.length, 0); assert.equal(fs.existsSync(state), false);
});

test("literal stateless text remains a payload and terminal failure keeps review exit semantics", async () => {
  const args = reviewArgs(); args[args.indexOf("--text") + 1] = "--stateless";
  const submitted = await cli(args);
  assert.equal(submitted.code, 0, submitted.stderr);
  const taskId = JSON.parse(submitted.stdout).taskId;
  assert.equal(app.store.getTask(taskId)?.text, "--stateless");
  app.store.completeTask(taskId, { error: "test_failure" });
  const failed = await cli(["wait", taskId, ...options()]);
  assert.equal(failed.code, 2, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).status, "failed");
  assert.equal(JSON.parse(failed.stdout).recovery.taskId, taskId);
});

test("stateless still honors an explicit workspace --output file", async () => {
  const target = path.join(root, "result.json");
  const result = await cli([...reviewArgs(), "--output", target]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), result.stdout);
  assert.equal(fs.existsSync(state), false);
});

test("ordinary mode still persists pending tasks and probe logs", async () => {
  const args = reviewArgs().filter(a => a !== "--stateless");
  const result = await cli(args, { RELAY_STATELESS_GUARD: "0" });
  assert.equal(result.code, 0, result.stderr);
  const taskId = JSON.parse(result.stdout).taskId;
  const records = fs.readdirSync(path.join(state, "pending")).map(name => JSON.parse(fs.readFileSync(path.join(state, "pending", name), "utf8")));
  assert.equal(records.length, 1); assert.equal(records[0].taskId, taskId);
  assert.ok(fs.existsSync(path.join(state, "logs", "client-probes.jsonl")));
});
