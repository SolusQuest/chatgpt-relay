import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

async function worker(commandState = "claimed", existing = false, discovery = false) {
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
      sendMessage: async (_id: number, message: any) => message.type === "discover-projects"
        ? { url: "https://chatgpt.com/", projects: [{ projectId: "g-p-" + "a".repeat(32), name: "Project", href: "/g/g-p-" + "a".repeat(32) + "/project" }] }
        : { session: null },
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
      if (route === "/internal/project-discoveries/claim") {
        response = { command: discovery ? { discoveryId: "scan", token: "scan-token" } : null };
      } else if (route.endsWith("/claim")) {
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

test("worker scans existing tabs without opening discovery tabs or sending chat messages", async () => {
  const w = await worker("opening", true, true);
  assert.equal(w.operations.includes("open-tab"), false);
  assert.ok(w.operations.includes("/internal/project-discoveries/scan/complete"));
});

test("reply completion requires the same user and assistant identities across samples", async () => {
  const w = await worker("opening", true);
  w.context.sample = { status: "reply-ready", reply: "same text" };
  w.context.pending = { session: "conversation", tabId: 7, submittedAt: Date.now(),
    submittedUserMessageId: "expected-user", baseline: {}, completionDeadlineAt: Date.now() + 60000 };
  await vm.runInContext("chrome.tabs.sendMessage = async () => sample", w.context);
  const poll = () => vm.runInContext("pollOnePending('review-task', pending)", w.context);
  const captured = () => w.operations.filter(x => x === "/internal/tasks/review-task/capture").length;
  await poll();
  assert.equal(captured(), 0, "legacy uncorrelated snapshots cannot complete a task");
  w.context.sample = { status: "reply-ready", reply: "same text", submittedUserMessageId: "wrong-user", assistantMessageId: "a1" };
  await poll(); assert.equal(captured(), 0);
  w.context.sample.submittedUserMessageId = "expected-user";
  await poll(); assert.equal(captured(), 0);
  w.context.sample.assistantMessageId = "a2";
  await poll(); assert.equal(captured(), 0, "equal text on a different message resets stability");
  await poll(); assert.equal(captured(), 1);
});
