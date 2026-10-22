import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeBackend, BackendError } from "../client/backend.js";

const info = { product: "gpt-relay", apiVersion: 1, serverId: "12345678-1234-1234-1234-123456789abc",
  name: "test", version: "1.0.1" };
let directory: string;
let savedLogDir: string | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-probe-"));
  savedLogDir = process.env.GPT_RELAY_LOG_DIR;
  process.env.GPT_RELAY_LOG_DIR = directory;
});
afterEach(() => {
  mock.restoreAll();
  if (savedLogDir === undefined) delete process.env.GPT_RELAY_LOG_DIR;
  else process.env.GPT_RELAY_LOG_DIR = savedLogDir;
  fs.rmSync(directory, { recursive: true, force: true });
});
const records = () => fs.readFileSync(path.join(directory, "client-probes.jsonl"), "utf8")
  .trim().split("\n").map(line => JSON.parse(line));

test("a transient connection reset retries only the probe and logs recovery with the same ID", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "http://relay:8765/v1/server");
    assert.equal(init.method, "GET");
    if (++calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket reset"),
      { code: "ECONNRESET", syscall: "read", address: "10.88.88.2", port: 8765 }) });
    return Response.json(info);
  });
  assert.equal((await probeBackend("relay")).serverId, info.serverId);
  const rows = records();
  assert.equal(calls, 2);
  assert.deepEqual(rows.map(row => row.outcome), ["failure", "success"]);
  assert.equal(rows[0].probeId, rows[1].probeId);
  assert.equal(rows[1].status, 200);
  assert.equal(rows[0].errors[1].code, "ECONNRESET");
  assert.equal(rows[0].errors[1].address, "10.88.88.2");
  assert.ok(rows.every(row => row.elapsedMs >= 0 && !Number.isNaN(Date.parse(row.timestamp))));
});

test("exhausted timeouts retain all attempts, elapsed time and the original cause", async () => {
  mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  await assert.rejects(probeBackend("relay", { timeoutMs: 15 }), error => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.code, "backend_unreachable");
    assert.ok(error.cause instanceof Error);
    assert.equal(error.probe!.attempts.length, 3);
    assert.ok(error.probe!.elapsedMs >= 600);
    assert.ok(error.probe!.attempts.every(attempt => attempt.timeoutMs === 15 &&
      attempt.elapsedMs >= 10 && attempt.errors![0]!.name === "AbortError"));
    assert.equal(error.probe!.logFile, path.join(directory, "client-probes.jsonl"));
    return true;
  });
  assert.equal(records().length, 3);
});

test("temporary HTTP failures retry at most three times and retain their status", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await assert.rejects(probeBackend("relay"), error => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.probe!.attempts.length, 3);
    assert.ok(error.probe!.attempts.every(attempt => attempt.status === 503 && attempt.errors![0]!.status === 503));
    return true;
  });
  assert.equal(fetch.mock.callCount(), 3);
});

test("permanent HTTP and DNS errors, invalid JSON and identity errors do not retry", async () => {
  const cases = [
    { response: () => Response.json({}, { status: 401 }), code: "backend_unreachable", status: 401 },
    { response: () => Response.json({}, { status: 404 }), code: "backend_incompatible", status: 404 },
    { response: () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("not found"), { code: "ENOTFOUND" }) }); }, code: "backend_unreachable", status: undefined },
    { response: () => new Response("invalid json"), code: "backend_unreachable", status: 200 },
    { response: () => Response.json({ ...info, product: "other" }), code: "backend_incompatible", status: 200 },
    { response: () => Response.json(info), code: "backend_identity_mismatch", status: 200 },
  ];
  for (const scenario of cases) {
    const fetch = mock.method(globalThis, "fetch", async () => scenario.response());
    try {
      await assert.rejects(probeBackend("relay", { expectedId: "different" }), error => {
        assert.ok(error instanceof BackendError);
        assert.equal(error.code, scenario.code);
        assert.equal(error.probe!.attempts.length, 1);
        assert.equal(error.probe!.attempts[0]!.status, scenario.status);
        return true;
      });
      assert.equal(fetch.mock.callCount(), 1);
    } finally { fetch.mock.restore(); }
  }
});

test("single-attempt scans retain diagnostics without extending their retry budget", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); });
  await assert.rejects(probeBackend("relay", { timeoutMs: 500, maxAttempts: 1 }), error => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.probe!.attempts.length, 1);
    assert.equal(error.probe!.attempts[0]!.errors![0]!.code, "ECONNREFUSED");
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("legacy compatibility probes retry transient failures and preserve both paths", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    calls++;
    if (url.endsWith("/v1/server")) return Response.json({}, { status: 404 });
    if (calls === 2) return Response.json({}, { status: 502 });
    return Response.json({ server: { version: "old", controlProtocol: 1 }, instances: [], checks: [] });
  });
  assert.equal((await probeBackend("relay", { allowLegacy: true })).legacy, true);
  assert.deepEqual(records().map(row => row.path), ["/v1/server", "/v1/doctor", "/v1/doctor"]);
});

test("log rotation is bounded and an unwritable log does not affect probe results", async () => {
  mock.method(globalThis, "fetch", async () => Response.json(info));
  const file = path.join(directory, "client-probes.jsonl");
  fs.writeFileSync(file, "x".repeat(1024 * 1024));
  await probeBackend("relay");
  assert.equal(fs.statSync(`${file}.1`).size, 1024 * 1024);
  assert.equal(records().length, 1);
  process.env.GPT_RELAY_LOG_DIR = file; // A regular file cannot contain a log.
  assert.equal((await probeBackend("relay")).serverId, info.serverId);
});
