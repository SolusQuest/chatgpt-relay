import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { Service, type ServiceConfig, type Bonjour, type Browser } from "bonjour-service";
import { createBonjour } from "../shared/mdns.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { announceServer } from "../server/discovery.js";
import { normalizeUrl, probeBackend, BackendError } from "../client/backend.js";
import { resolveBackend } from "../client/backend-resolver.js";
import { readBinding, saveBinding, clearBinding } from "../client/backend-config.js";
import { browseNetwork, discoverBackends, verifyCandidates, isLocalAddress } from "../client/discovery.js";
import { parseGlobalOptions, validateBusinessArgs } from "../client/cli-options.js";
import { registerLocal, localRegistrations } from "../shared/local-registry.js";
import { writePending, listPending, resumePending, clearPending, review } from "../client/agent-client.js";
import { http as clientHttp, HttpError } from "../client/http.js";

let directory: string;
let savedEnv: NodeJS.ProcessEnv;
let cleanup: (() => void | Promise<void>)[];
beforeEach(() => {
  savedEnv = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-backend-"));
  cleanup = [];
  process.env.GPT_RELAY_CLIENT_CONFIG = path.join(directory, "client", "config.json");
  process.env.GPT_RELAY_REGISTRY_DIR = path.join(directory, "registry");
  process.env.GPT_RELAY_PENDING_DIR = path.join(directory, "pending");
  process.env.GPT_RELAY_LOG_DIR = path.join(directory, "logs");
  process.env.GPT_RELAY_DISCOVERY = "0";
  process.env.GPT_RELAY_LEGACY_FALLBACK = "0";
  delete process.env.GPT_RELAY_URL;
});
afterEach(async () => {
  for (const stop of cleanup.reverse()) await stop();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(directory, { recursive: true, force: true });
});

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  cleanup.push(close);
  return { baseUrl, close };
}

async function relay(name: string, dbFile = path.join(directory, `${name}.db`)) {
  const config = { ...loadConfig(), dataDir: directory, dbFile, logDir: path.join(directory, "logs") };
  const handle = createApp(config);
  let reads = 0;
  // Count task reads at the transport boundary, including requests to an unknown ID.
  const transport = await listen((req, res) => {
    if (req.url?.startsWith("/v1/tasks")) reads++;
    handle.app(req, res);
  });
  const closeHttp = transport.close;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeHttp(); handle.stopMaintenance(); handle.closeDatabase();
  };
  cleanup.push(close);
  const backend = await probeBackend(transport.baseUrl);
  return { ...transport, ...handle, backend, close, reads: () => reads };
}

function advertise(service: Awaited<ReturnType<typeof relay>>) {
  const stop = registerLocal({ baseUrl: service.backend.baseUrl, serverId: service.identity.serverId, pid: process.pid });
  cleanup.push(stop);
  return stop;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("bin/gpt-relay.mjs"), ...args], { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.stdin.end();
    const timer = setTimeout(() => { child.kill(); reject(new Error("backend CLI test timed out")); }, 10000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const hasCode = (code: string) => (error: unknown) => error instanceof BackendError && error.code === code;

test("show JSON exposes failed pre-command probe details without reading the task", async () => {
  let probes = 0, taskReads = 0;
  const server = await listen((req, res) => {
    if (req.url === "/v1/server") probes++;
    else taskReads++;
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end('{"error":"temporarily_unavailable"}');
  });
  const result = await runCli(["show", "existing-task", "--server", server.baseUrl, "--json"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr);
  assert.equal(error.error, "backend_unreachable");
  assert.equal(error.errorInfo.deliveryState, "unknown");
  assert.equal(error.errorInfo.safeToResubmit, null);
  assert.equal(error.probe.baseUrl, server.baseUrl);
  assert.equal(error.probe.attempts.length, 3);
  assert.ok(error.probe.elapsedMs >= 600);
  assert.ok(error.probe.attempts.every((attempt: any) => attempt.path === "/v1/server" && attempt.errors[0].status === 503));
  assert.equal(probes, 3);
  assert.equal(taskReads, 0);
});

test("show retries a failed probe, then reads the task exactly once with clean JSON output", async () => {
  let probes = 0, taskReads = 0;
  const serverId = randomUUID();
  const server = await listen((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Gpt-Relay-Server-Id", serverId);
    if (req.url === "/v1/server") {
      if (++probes === 1) { res.statusCode = 503; res.end('{"error":"busy"}'); }
      else res.end(JSON.stringify({ product: "gpt-relay", apiVersion: 1, serverId, name: "test", version: "1.0.1" }));
    } else {
      taskReads++;
      res.end(JSON.stringify({ taskId: "existing-task", status: "completed" }));
    }
  });
  const result = await runCli(["show", "existing-task", "--server", server.baseUrl, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).taskId, "existing-task");
  assert.equal(probes, 2);
  assert.equal(taskReads, 1);
  const rows = fs.readFileSync(path.join(process.env.GPT_RELAY_LOG_DIR!, "client-probes.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.outcome), ["failure", "success"]);
});

test("server identity persists across database restart and is independent of listener address", async () => {
  const db = path.join(directory, "durable.db");
  const first = await relay("first", db);
  const id = first.identity.serverId;
  await first.close();
  const restarted = await relay("restarted", db);
  const other = await relay("other");
  assert.equal(restarted.identity.serverId, id);
  assert.notEqual(other.identity.serverId, id);
  assert.equal(restarted.backend.serverId, id);
  assert.equal(restarted.identity.product, "gpt-relay");
  assert.equal(restarted.identity.apiVersion, 1);
});

test("expected server identity rejects a mutation before any project is written", async () => {
  const server = await relay("fenced");
  const project = "g-p-" + "a".repeat(32);
  await assert.rejects(clientHttp.put(`/v1/projects/${project}`, { name: "Should not exist" }, {
    baseUrl: server.baseUrl, serverId: randomUUID(),
  }), error => error instanceof HttpError && error.code === "backend_identity_mismatch");
  const projects = await clientHttp.get<{ projects: unknown[] }>("/v1/projects", { baseUrl: server.baseUrl });
  assert.deepEqual(projects.projects, []);
  await clientHttp.put(`/v1/projects/${project}`, { name: "Accepted" }, { baseUrl: server.baseUrl, serverId: server.identity.serverId });
});

test("backend addresses have clear port semantics and reject paths or credentials", () => {
  assert.equal(normalizeUrl("relay-host"), "http://relay-host:8765");
  assert.equal(normalizeUrl("relay-host:9123"), "http://relay-host:9123");
  assert.equal(normalizeUrl("http://relay-host"), "http://relay-host");
  assert.equal(normalizeUrl("https://relay-host:9123/"), "https://relay-host:9123");
  assert.equal(normalizeUrl("[::1]:9123"), "http://[::1]:9123");
  for (const address of ["ftp://host", "http://user:secret@host", "http://host/api", "http://host/?a=b", "http://host/#hash"]) {
    assert.throws(() => normalizeUrl(address), hasCode("invalid_backend"));
  }
  assert.equal(isLocalAddress("127.0.0.1"), true);
  assert.equal(isLocalAddress("127.example.com"), false);
});

test("discovery verifies actual ports, deduplicates identities and excludes stale or unrelated services", async () => {
  const a = await relay("a"), b = await relay("b");
  advertise(a); advertise(a); advertise(b);
  const stale = registerLocal({ baseUrl: a.baseUrl, serverId: randomUUID(), pid: process.pid }); cleanup.push(stale);
  const generic = await listen((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"status":"ok"}'); });
  const found = await verifyCandidates([...localRegistrations(), { baseUrl: generic.baseUrl }, { baseUrl: "bad/path" }, { baseUrl: "http://127.0.0.1:1" }]);
  // A stale record at the same URL never validates against a different server ID.
  assert.deepEqual(new Set(found.map(server => server.serverId)), new Set([a.identity.serverId, b.identity.serverId]));
  stale();
  assert.deepEqual(new Set((await discoverBackends(true)).map(server => server.serverId)), new Set([a.identity.serverId, b.identity.serverId]));
});

test("automatic resolution binds only a unique result and preserves an existing binding on failure", async () => {
  await assert.rejects(resolveBackend(), hasCode("backend_not_found"));
  const a = await relay("a"), b = await relay("b");
  advertise(a);
  assert.equal((await resolveBackend()).serverId, a.identity.serverId);
  assert.equal(readBinding()!.serverId, a.identity.serverId);
  advertise(b);
  assert.equal((await resolveBackend()).serverId, a.identity.serverId);
  await a.close();
  await assert.rejects(resolveBackend(), hasCode("backend_unreachable"));
  assert.equal(readBinding()!.serverId, a.identity.serverId);
  await clearBinding();
  assert.equal((await resolveBackend()).serverId, b.identity.serverId);
});

test("multiple discovered backends fail without binding or preferring loopback", async () => {
  const a = await relay("a"), b = await relay("b");
  advertise(a); advertise(b);
  await assert.rejects(resolveBackend(), hasCode("backend_ambiguous"));
  assert.equal(readBinding(), null);
});

test("explicit server and local overrides precede environment and binding without persisting", async () => {
  const a = await relay("a"), b = await relay("b"), c = await relay("c");
  advertise(c);
  await saveBinding(a.backend);
  process.env.GPT_RELAY_URL = b.baseUrl;
  assert.equal((await resolveBackend()).serverId, b.identity.serverId);
  assert.equal((await resolveBackend({ server: a.baseUrl })).serverId, a.identity.serverId);
  assert.equal((await resolveBackend({ local: true })).serverId, c.identity.serverId);
  assert.equal(readBinding()!.serverId, a.identity.serverId);
  process.env.GPT_RELAY_URL = "http://127.0.0.1:1";
  await assert.rejects(resolveBackend(), hasCode("backend_unreachable"));
  await assert.rejects(resolveBackend({ server: "http://127.0.0.1:1" }), hasCode("backend_unreachable"));
  delete process.env.GPT_RELAY_URL;
  await saveBinding({ ...a.backend, serverId: randomUUID() });
  await assert.rejects(resolveBackend(), hasCode("backend_identity_mismatch"));
});

test("automatic binding cannot overwrite an explicit binding written concurrently", async () => {
  const a = await relay("a"), b = await relay("b");
  await Promise.all([saveBinding(a.backend), saveBinding(b.backend, true)]);
  assert.equal(readBinding()!.serverId, a.identity.serverId);
  writePending({ taskId: "pending", session: "s", textPreview: "text", submittedAt: Date.now(), serverId: a.identity.serverId });
  await clearBinding();
  assert.equal(readBinding(), null);
  assert.equal(listPending().length, 1);
  fs.writeFileSync(process.env.GPT_RELAY_CLIENT_CONFIG!, "bad config");
  assert.throws(readBinding, hasCode("backend_config_invalid"));
  await clearBinding();
  assert.equal(readBinding(), null);
});

test("concurrent CLI discovery preserves an explicit binding from another process", async () => {
  const a = await relay("a"), b = await relay("b");
  advertise(a);
  const results = await Promise.all([runCli(["health"]), runCli(["bind", b.baseUrl])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(readBinding()!.serverId, b.identity.serverId);
});

test("a crashed config writer is recoverable without stealing a live writer's lock", async () => {
  const a = await relay("a"), b = await relay("b");
  const writer = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
  await new Promise<void>(resolve => writer.once("exit", () => resolve()));
  const file = process.env.GPT_RELAY_CLIENT_CONFIG!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, String(writer.pid));
  await Promise.all([saveBinding(a.backend), saveBinding(b.backend, true)]);
  assert.equal(readBinding()!.serverId, a.identity.serverId);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(fs.existsSync(`${file}.lock.reap`), false);
  fs.writeFileSync(`${file}.lock`, String(process.pid));
  await assert.rejects(saveBinding(b.backend), hasCode("backend_config_busy"));
  assert.equal(readBinding()!.serverId, a.identity.serverId);
});

test("CLI bind, detect list, local override and clear use isolated client state", async () => {
  const a = await relay("a"), b = await relay("b");
  advertise(a);
  let result = await runCli(["detect", "--local", "--list", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).candidates[0].serverId, a.identity.serverId);
  assert.equal(readBinding(), null);
  result = await runCli(["detect", "--local", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readBinding()!.serverId, a.identity.serverId);
  result = await runCli(["bind", b.baseUrl]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readBinding()!.serverId, b.identity.serverId);
  result = await runCli(["health", "--local"], { GPT_RELAY_URL: "http://127.0.0.1:1" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(a.baseUrl));
  assert.equal(readBinding()!.serverId, b.identity.serverId);
  result = await runCli(["bind"], { GPT_RELAY_URL: a.baseUrl });
  assert.equal(JSON.parse(result.stdout).source, "environment");
  assert.equal(JSON.parse(result.stdout).binding.serverId, b.identity.serverId);
  result = await runCli(["bind", "--clear"]);
  assert.equal(result.code, 0, result.stderr);
  result = await runCli(["bind", "--local"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readBinding()!.serverId, a.identity.serverId);
  advertise(b);
  const previous = fs.readFileSync(process.env.GPT_RELAY_CLIENT_CONFIG!, "utf8");
  result = await runCli(["detect", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error, "backend_ambiguous");
  assert.equal(fs.readFileSync(process.env.GPT_RELAY_CLIENT_CONFIG!, "utf8"), previous);
});

test("CLI invalid options fail before any discovery and literal text is not parsed as a flag", async () => {
  for (const args of [["health", "--server", "host", "--local"], ["bind", "host", "--local"], ["detect", "--list", "--list"],
    ["review", "--session", "s", "--no-wait"], ["review", "--text", "--session-ref", "--no-wait"], ["health", "--unknown"]]) {
    const result = await runCli(args);
    assert.equal(result.code, 64, result.stderr);
    assert.match(result.stderr, /invalid_arguments/);
    assert.equal(readBinding(), null);
  }
  const parsed = parseGlobalOptions(["review", "--session", "s", "--text", "--local", "--server", "host:9999"]);
  assert.deepEqual(parsed.options, { server: "host:9999" });
  validateBusinessArgs("review", parsed.args.slice(1));
  const a = await relay("a");
  const result = await runCli(["review", "--new-session", "--session-ref", "sr_literal-input", "--no-project", "--text", "--local", "--no-wait", "--server", a.baseUrl]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(a.store.listTasks()[0]!.text, "--local");
});

test("pending task IDs are namespaced and resume never queries a different backend", async () => {
  const a = await relay("a"), b = await relay("b");
  for (const server of [a, b]) writePending({ taskId: "same-task", session: "s", submittedAt: Date.now(), textPreview: "text", baseUrl: server.baseUrl, serverId: server.identity.serverId });
  assert.equal(listPending().length, 2);
  assert.throws(() => clearPending("same-task"), hasCode("pending_ambiguous"));
  const rows = await resumePending(b.baseUrl);
  assert.equal(rows.find(row => row.record.serverId === a.identity.serverId)!.reason, "other_backend");
  assert.equal(rows.find(row => row.record.serverId === b.identity.serverId)!.reason, "not_found_retained");
  assert.equal(a.reads(), 0);
  assert.equal(b.reads(), 1);
  assert.equal(listPending().length, 2);
  clearPending("same-task", b.identity.serverId);
  assert.equal(listPending()[0]!.serverId, a.identity.serverId);
});

test("legacy pending migration requires origin and matching task evidence; mismatches remain untouched", async () => {
  const server = await relay("a");
  const task = await review("legacy prompt", { sessionRef: "sr_legacy-ref", newSession: true, projectId: null, wait: false, baseUrl: server.baseUrl });
  const record = listPending()[0]!;
  clearPending(task.taskId, server.identity.serverId);
  writePending({ ...record, serverId: undefined });
  writePending({ taskId: "no-origin", session: "s", textPreview: "text", submittedAt: Date.now() });
  writePending({ taskId: "bad-origin", session: "s", textPreview: "text", submittedAt: Date.now(), baseUrl: "bad/path" });
  const resumed = await resumePending(server.baseUrl);
  assert.equal(resumed.find(row => row.record.taskId === task.taskId)!.task!.taskId, task.taskId);
  assert.equal(listPending().find(row => row.taskId === task.taskId)!.serverId, server.identity.serverId);
  assert.equal(resumed.filter(row => row.reason === "other_backend").length, 2);
  const mismatched = { ...record, taskId: "request_wrong", requestOnly: true, serverId: undefined, textPreview: "different prompt" };
  writePending(mismatched);
  const previous = fs.readFileSync(path.join(process.env.GPT_RELAY_PENDING_DIR!, "request_wrong.json"), "utf8");
  const result = await resumePending(server.baseUrl);
  assert.equal(result.find(row => row.record.taskId === "request_wrong")!.reason, "task_identity_mismatch");
  assert.equal(fs.readFileSync(path.join(process.env.GPT_RELAY_PENDING_DIR!, "request_wrong.json"), "utf8"), previous);
});

test("a moved backend can recover accepted requests by identity without resubmitting", async () => {
  const db = path.join(directory, "moving.db");
  const first = await relay("first", db);
  const task = await review("original prompt", { sessionRef: "sr_moving-ref", newSession: true, projectId: null, clientRequestId: "moving-request", wait: false, baseUrl: first.baseUrl });
  const record = listPending()[0]!;
  clearPending(task.taskId, first.identity.serverId);
  writePending({ ...record, taskId: "request_lost", requestOnly: true });
  await first.close();
  const moved = await relay("moved", db);
  const rows = await resumePending(moved.baseUrl, moved.identity.serverId);
  assert.equal(rows[0]!.task!.taskId, task.taskId);
  assert.equal(rows[0]!.record.baseUrl, moved.baseUrl);
  assert.equal(moved.store.listTasks({}).length, 1);
  assert.equal(listPending().length, 1);
});

test("old running servers remain usable via explicit URL without being persisted as stable bindings", async () => {
  const legacy = await listen((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/doctor") res.end(JSON.stringify({ server: { version: "old", controlProtocol: 1 }, instances: [], checks: [] }));
    else if (req.url === "/health") res.end('{"status":"ok"}');
    else { res.statusCode = 404; res.setHeader("Content-Type", "text/html"); res.end("<html><body>Cannot GET /v1/server</body></html>"); }
  });
  const backend = await resolveBackend({ server: legacy.baseUrl });
  assert.equal(backend.legacy, true);
  const result = await runCli(["health", "--server", legacy.baseUrl]);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(probeBackend(legacy.baseUrl), hasCode("backend_incompatible"));
  await assert.rejects(saveBinding(backend), hasCode("backend_incompatible"));
  process.env.GPT_RELAY_LEGACY_FALLBACK = "1";
  process.env.GPT_RELAY_PORT = new URL(legacy.baseUrl).port;
  assert.equal((await resolveBackend()).legacy, true);
  assert.equal(readBinding(), null);
});

test("mDNS browsing uses the service port and releases the browser and socket on completion or error", async () => {
  let stopCount = 0, destroyCount = 0;
  const client = {
    find(_options: unknown, onUp: (service: Service) => void) {
      onUp({ port: 9123, addresses: ["127.0.0.1", "192.0.2.10"], txt: { serverId: "advertised" } } as Service);
      onUp({ port: 0, addresses: ["192.0.2.10"] } as Service);
      return { stop() { stopCount++; } } as Browser;
    },
    destroy() { destroyCount++; },
  } as Pick<Bonjour, "find" | "destroy">;
  assert.deepEqual(await browseNetwork(true, 1, () => client), [{ baseUrl: "http://127.0.0.1:9123", serverId: "advertised" }]);
  assert.equal(stopCount, 1);
  assert.equal(destroyCount, 1);
  await assert.rejects(browseNetwork(false, 1, onError => { onError(new Error("no multicast")); return client; }), hasCode("discovery_unavailable"));
  assert.equal(destroyCount, 2);
});

test("local server announcements are removed without changing client bindings", async () => {
  const server = await relay("local");
  await saveBinding(server.backend);
  const stop = announceServer(server.identity, "0.0.0.0", Number(new URL(server.baseUrl).port));
  cleanup.push(stop);
  assert.equal(localRegistrations()[0]!.baseUrl, server.baseUrl);
  stop();
  assert.deepEqual(localRegistrations(), []);
  assert.equal(readBinding()!.serverId, server.identity.serverId);
});

test("multi-interface announcements own a stable host instead of claiming the OS Bonjour name", async () => {
  const server = await relay("multi-interface");
  process.env.GPT_RELAY_DISCOVERY = "1";
  const hostname = mock.method(os, "hostname", () => "Yues-Mac-mini.local");
  const interfaces = mock.method(os, "networkInterfaces", () => ({
    lo0: [{ address: "127.0.0.1", family: "IPv4", netmask: "255.255.255.0", cidr: null, internal: true, mac: "00:00:00:00:00:00" }],
    en0: [{ address: "192.0.2.10", family: "IPv4", netmask: "255.255.255.0", cidr: null, internal: false, mac: "02:00:00:00:00:01" }],
    en1: [{ address: "198.51.100.10", family: "IPv4", netmask: "255.255.255.0", cidr: null, internal: false, mac: "02:00:00:00:00:02" }],
    bridge0: [
      { address: "203.0.113.10", family: "IPv4", netmask: "255.255.255.0", cidr: null, internal: false, mac: "02:00:00:00:00:03" },
      { address: "2001:db8::10", family: "IPv6", netmask: "ffff:ffff:ffff:ffff::", cidr: null, scopeid: 0, internal: false, mac: "02:00:00:00:00:03" },
    ],
  }) satisfies NodeJS.Dict<os.NetworkInterfaceInfo[]>);
  const services: Service[] = [];
  // Exercise the real dependency's record generation without LAN broadcasts.
  const client = {
    publish(options: ServiceConfig) {
      const service = new Service(options, () => {}, () => {});
      services.push(service);
      return service;
    },
    unpublishAll(callback: () => void) { callback(); },
    destroy() {},
  } as unknown as Bonjour;
  try {
    for (const systemName of ["Yues-Mac-mini.local", "Yues-Mac-mini-2.local"]) {
      hostname.mock.mockImplementation(() => systemName);
      const stop = announceServer(server.identity, "0.0.0.0", 9123, () => client);
      cleanup.push(stop);
      const records = services.at(-1)!.records();
      const target = `gpt-relay-${server.identity.serverId}.local`;
      const addresses = records.filter(record => ["A", "AAAA"].includes(record.type));
      assert.equal(addresses.length, 4);
      assert.ok(addresses.every(record => record.name === target));
      assert.deepEqual(addresses.map(record => record.data).sort(),
        ["192.0.2.10", "198.51.100.10", "203.0.113.10", "2001:db8::10"].sort());
      assert.equal(records.find(record => record.type === "SRV")!.data.target, target);
      assert.equal(records.find(record => record.type === "SRV")!.data.port, 9123);
      assert.ok(records.every(record => record.name !== systemName));
      stop();
    }
    assert.equal(services[0]!.host, services[1]!.host);
  } finally {
    hostname.mock.restore(); interfaces.mock.restore();
  }
});

test("DNS-SD announcements round-trip through isolated UDP sockets and verify the advertised HTTP port", async () => {
  const relayServer = await relay("udp-discovery");
  const sockets: dgram.Socket[] = [];
  async function socket() {
    const value = dgram.createSocket("udp4");
    await new Promise<void>(resolve => value.bind(0, "127.0.0.1", resolve));
    sockets.push(value);
    return value;
  }
  const publisherSocket = await socket(), browserSocket = await socket();
  const publisherPort = publisherSocket.address().port, browserPort = browserSocket.address().port;
  const records = Service.prototype.records;
  const override = mock.method(Service.prototype, "records", function(this: Service) {
    return records.call(this).filter((record: { type: string }) => !["A", "AAAA"].includes(record.type))
      .concat([{ name: this.host, type: "A", ttl: 120, data: "127.0.0.1" }]);
  });
  process.env.GPT_RELAY_DISCOVERY = "1";
  let publisher: Bonjour | undefined;
  const found = browseNetwork(false, 1000, onError => createBonjour(onError, {
    socket: browserSocket, port: publisherPort, ip: "127.0.0.1", multicast: false, bind: false,
  }));
  const stop = announceServer(relayServer.identity, "0.0.0.0", Number(new URL(relayServer.baseUrl).port), onError => {
    publisher = createBonjour(onError, { socket: publisherSocket, port: browserPort, ip: "127.0.0.1", multicast: false, bind: false });
    const publish = publisher.publish.bind(publisher);
    publisher.publish = options => publish({ ...options, probe: false });
    return publisher;
  });
  try {
    const candidates = await found;
    assert.ok(candidates.some(candidate => candidate.baseUrl === relayServer.baseUrl && candidate.serverId === relayServer.identity.serverId));
    assert.equal((await verifyCandidates(candidates))[0]!.serverId, relayServer.identity.serverId);
  } finally {
    stop(); override.mock.restore();
    // Close test sockets even when a setup assertion fails. destroy is idempotent.
    publisher?.destroy();
    for (const value of sockets) { try { value.close(); } catch { /* Already closed by Bonjour. */ } }
  }
});

test("mDNS bind errors are reported and an unbound UDP socket can be cleaned up", async () => {
  const occupied = dgram.createSocket("udp4");
  await new Promise<void>(resolve => occupied.bind(0, "127.0.0.1", resolve));
  cleanup.push(() => { occupied.close(); });
  let client: Bonjour | undefined;
  let fail: (error: Error) => void;
  const error = new Promise<unknown>((resolve, reject) => {
    fail = reject;
    client = createBonjour(resolve, { port: occupied.address().port, bind: "127.0.0.1", multicast: false });
  });
  const timer = setTimeout(() => { client?.destroy(); fail(new Error("mDNS bind error was not reported")); }, 2000);
  try {
    assert.ok(["EADDRINUSE", "EACCES"].includes((await error as NodeJS.ErrnoException).code!));
    assert.doesNotThrow(() => client!.destroy());
  } finally { clearTimeout(timer); client?.destroy(); }
});

test("foreground startup registers its actual port and graceful shutdown removes only its registration", async () => {
  const entry = pathToFileURL(path.resolve("server/index.ts")).href;
  const script = `await import(${JSON.stringify(entry)}); process.on('message', () => { process.disconnect(); process.emit('SIGTERM'); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    env: { ...process.env, GPT_RELAY_HOST: "127.0.0.1", GPT_RELAY_PORT: "0", GPT_RELAY_DATA_DIR: path.join(directory, "foreground"),
      GPT_RELAY_DB_FILE: path.join(directory, "foreground", "state.db") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "", errors = "";
  child.stdout!.on("data", data => { output += data; });
  child.stderr!.on("data", data => { errors += data; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const deadline = Date.now() + 5000;
  while (!output.includes("gpt-relay listening") && child.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(output, /gpt-relay listening/, errors);
  const registrations = localRegistrations();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]!.pid, child.pid);
  assert.notEqual(new URL(registrations[0]!.baseUrl).port, "0");
  const backend = await probeBackend(registrations[0]!.baseUrl);
  await saveBinding(backend);
  child.send("shutdown");
  const timer = setTimeout(() => child.kill(), 5000);
  try { assert.equal(await exited, 0, errors); } finally { clearTimeout(timer); }
  assert.deepEqual(localRegistrations(), []);
  assert.equal(readBinding()!.serverId, backend.serverId);
});
