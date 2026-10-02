import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

async function worker(commandState = "claimed", existing = false) {
  const storage: Record<string, any> = { creation_owner: "browser" };
  const operations: string[] = [];
  const meta = { sessionRef: "sr_new", projectId: null, token: "token", owner: "browser", initialTaskId: "task" };
  const marker = `#relay-create=${encodeURIComponent(JSON.stringify(meta))}`;
  const tabs: any[] = existing ? [{ id: 7, url: "https://chatgpt.com/" + marker }] : [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let claimed = false;
  const event = () => ({ addListener() {} });
  const chrome = {
    storage: { local: {
      get: async (key: string) => ({ [key]: structuredClone(storage[key]) }),
      set: async (values: Record<string, unknown>) => Object.assign(storage, values),
    } },
    tabs: {
      query: async () => tabs,
      get: async (id: number) => { const t = tabs.find(t => t.id === id); if (!t) throw new Error("missing"); return t; },
      create: async (options: any) => { operations.push("open-tab"); const tab = { id: 8, ...options }; tabs.push(tab); return tab; },
      sendMessage: async () => ({ session: null }),
      onRemoved: event(), onUpdated: event(),
    },
    alarms: { getAll: async () => [], create: async () => {}, onAlarm: event() },
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, AbortController, URL,
    console: { log() {}, warn() {} },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    fetch: async (url: string, options: any) => {
      const route = new URL(url).pathname;
      operations.push(route);
      let response: any = { status: "ok", tasks: [], sessions: [], task: null };
      if (route.endsWith("/claim")) {
        response = { command: claimed ? null : { ...meta, state: commandState, initialTaskId: "task" } };
        claimed = true;
      }
      if (route.endsWith("/fail")) response.request = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    },
  });
  for (const file of ["lib/config.js", "lib/recovery-policy.js", "service-worker.js"]) {
    const source = fs.readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8")
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, "")
      .replace(/\bexport /g, "");
    vm.runInContext(source, context, { filename: file });
  }
  for (let i = 0; i < 15; i++) await new Promise<void>(resolve => setImmediate(resolve));
  return { operations, tabs, context, timers, storage };
}

test("worker persists the creation open fence before opening one tab", async () => {
  const w = await worker();
  assert.equal(w.operations.filter(x => x === "open-tab").length, 1);
  assert.ok(w.operations.indexOf("/internal/session-creations/sr_new/opening") < w.operations.indexOf("open-tab"));
  assert.ok(w.operations.indexOf("/internal/session-creations/sr_new/attach") > w.operations.indexOf("open-tab"));
  assert.equal(w.tabs[0].active, false);
  assert.match(w.tabs[0].url, /#relay-create=/);
});

test("worker restart finds the previously opened marked tab instead of creating another", async () => {
  const w = await worker("opening", true);
  assert.equal(w.operations.includes("open-tab"), false);
  assert.ok(w.operations.includes("/internal/session-creations/sr_new/attach"));
});

test("ambiguous open with no surviving tab is reported unknown and never replayed", async () => {
  const w = await worker("opening", false);
  assert.equal(w.operations.includes("open-tab"), false);
  assert.ok(w.operations.includes("/internal/session-creations/sr_new/fail"));
});

test("concurrent tab and inflight updates retain all session identities and send evidence", async () => {
  const w = await worker();
  await vm.runInContext(`Promise.all([
    rememberTabSession(11, 'session-A'), rememberTabSession(12, 'session-B'),
    markInflight('session-A', 'task-A', {deliveryPhase:'send-fenced'}),
    markInflight('session-B', 'task-B', {deliveryPhase:'preparing'})
  ])`, w.context);
  assert.equal(w.storage.tab_session_map[11], "session-A");
  assert.equal(w.storage.tab_session_map[12], "session-B");
  assert.equal(w.storage.inflight["session-A"].deliveryPhase, "send-fenced");
  assert.equal(w.storage.inflight["session-B"].taskId, "task-B");
  await vm.runInContext(`Promise.all([clearInflight('session-A'), markInflight('session-B', 'task-B', {deliveryPhase:'accepted'})])`, w.context);
  assert.equal(w.storage.inflight["session-A"], undefined);
  assert.equal(w.storage.inflight["session-B"].deliveryPhase, "accepted");
});
