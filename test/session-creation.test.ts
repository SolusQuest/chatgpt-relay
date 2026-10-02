import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { review, listPending, resumePending, clearPending } from "../client/agent-client.js";

async function fixture(run: (f: any) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-create-"));
  const pending = path.join(dir, "pending");
  const oldPending = process.env.GPT_RELAY_PENDING_DIR;
  process.env.GPT_RELAY_PENDING_DIR = pending;
  const config = { ...loadConfig(), dbFile: path.join(dir, "state.db"), maxTaskTextBytes: 1024 };
  const handle = createApp(config);
  const server = handle.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const api = async (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try { await run({ api, base, handle, config, pending }); }
  finally {
    handle.stopMaintenance();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldPending === undefined) delete process.env.GPT_RELAY_PENDING_DIR;
    else process.env.GPT_RELAY_PENDING_DIR = oldPending;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may retain its file on Windows. */ }
  }
}
const ref = () => `sr_${randomUUID()}`;
const project = "g-p-" + "a".repeat(32);

test("creation requires ref, first text and explicit project selection; invalid requests allocate nothing", async () => fixture(async ({ api, handle }: any) => {
  for (const body of [{ text: "first", projectId: null }, { sessionRef: ref(), text: "first" },
    { sessionRef: ref(), projectId: null, text: " " }, { sessionRef: ref(), projectId: "none", text: "first" }]) {
    assert.equal((await api("/v1/sessions", body)).status, 400);
  }
  const r = ref();
  assert.equal((await api("/v1/sessions", { sessionRef: r, projectId: null, text: "x".repeat(1025) })).status, 413);
  assert.equal(handle.store.registry.get(r), null, "oversized first task rolls back its ref and command");
}));

test("creation retry retains the first task across restart and rejects changed parameters", async () => fixture(async ({ api, handle, config }: any) => {
  const r = ref(), input = { sessionRef: r, projectId: null, text: "first" };
  const first = await api("/v1/sessions", input);
  assert.equal(first.status, 201);
  assert.equal(first.body.creationStatus, "pending");
  assert.equal((await api("/v1/sessions", input)).body.taskId, first.body.taskId);
  assert.equal((await api("/v1/sessions", { ...input, text: "different" })).status, 409);
  assert.equal((await api("/v1/sessions", { ...input, projectId: project })).status, 409);
  const reopened = createApp(config);
  try { assert.equal(reopened.store.registry.requireRef(r).initial_task, first.body.taskId); }
  finally { reopened.stopMaintenance(); }
  assert.equal(handle.store.listTasks({ session: r }).length, 1);
}));

test("command ownership, tab and project checks prevent cross-window binding", async () => fixture(async ({ api }: any) => {
  const r = ref();
  await api("/v1/sessions", { sessionRef: r, projectId: project, text: "first" });
  assert.equal((await api(`/internal/next_task?session=${r}`)).body.task, null);
  const command = (await api("/internal/session-creations/claim", { owner: "browser-A" })).body.command;
  assert.equal((await api("/internal/session-creations/claim", { owner: "browser-B" })).body.command, null);
  const own = { owner: "browser-A", token: command.token };
  const action = (a: string, extra = {}) => api(`/internal/session-creations/${r}/${a}`, { ...own, ...extra });
  assert.equal((await action("opening")).status, 200);
  assert.equal((await action("attach", { tabId: 1 })).status, 200);
  assert.equal((await action("attach", { tabId: 2 })).status, 409);
  const conversationId = randomUUID();
  assert.equal((await action("bind", { tabId: 1, conversationId, projectId: null })).status, 409);
  assert.equal((await action("bind", { tabId: 1, conversationId, projectId: project })).status, 200);
  assert.equal((await action("bind", { tabId: 1, conversationId: randomUUID(), projectId: project })).status, 409);
}));

test("bound creation survives first-task failure and legacy/ref aliases share message dedup and active slot", async () => fixture(async ({ api, handle }: any) => {
  const r = ref();
  const first = (await api("/v1/sessions", { sessionRef: r, projectId: null, text: "first" })).body;
  const cmd = (await api("/internal/session-creations/claim", { owner: "browser" })).body.command;
  const own = { owner: "browser", token: cmd.token, tabId: 1 };
  await api(`/internal/session-creations/${r}/opening`, own);
  await api(`/internal/session-creations/${r}/attach`, own);
  assert.equal((await api(`/internal/next_task?session=${r}`)).body.task.taskId, first.taskId);
  const conversationId = randomUUID();
  await api(`/internal/session-creations/${r}/bind`, { ...own, conversationId, projectId: null });
  await api(`/internal/tasks/${first.taskId}/complete`, { error: "first_message_failed" });
  assert.equal((await api(`/v1/sessions/${r}`)).body.creationStatus, "created");
  assert.equal((await api(`/internal/session-creations/${r}/attach`, own)).status, 200);
  const next = (await api("/v1/tasks", { sessionRef: r, text: "continue", clientRequestId: "next" })).body;
  const alias = await api("/v1/tasks", { session: conversationId, text: "continue", clientRequestId: "next" });
  assert.equal(alias.body.taskId, next.taskId);
  assert.equal((await api("/v1/tasks", { session: conversationId, text: "changed", clientRequestId: "next" })).status, 409);
  assert.equal(handle.store.claimNextTask(conversationId).id, next.taskId);
  assert.equal(handle.store.claimNextTask(r), null);
  const view = (await api(`/v1/tasks/${next.taskId}`)).body;
  assert.equal(view.sessionRef, r);
  assert.equal(view.conversationId, conversationId);
}));

test("unknown open cannot be reclaimed or replayed but late binding can establish the session", async () => fixture(async ({ api }: any) => {
  const r = ref();
  const first = (await api("/v1/sessions", { sessionRef: r, projectId: null, text: "first" })).body;
  const cmd = (await api("/internal/session-creations/claim", { owner: "browser" })).body.command;
  const own = { owner: "browser", token: cmd.token, tabId: 1 };
  await api(`/internal/session-creations/${r}/opening`, own);
  await api(`/internal/session-creations/${r}/fail`, { ...own, error: "session_open_outcome_unknown", unknown: true });
  assert.equal((await api(`/v1/sessions/${r}`)).body.creationStatus, "unknown");
  assert.equal((await api("/internal/session-creations/claim", { owner: "browser" })).body.command, null);
  assert.equal((await api("/v1/tasks", { sessionRef: r, text: "next" })).status, 409);
  assert.equal((await api("/v1/sessions", { sessionRef: r, projectId: null, text: "first" })).body.taskId, first.taskId);
  await api(`/internal/session-creations/${r}/attach`, own);
  await api(`/internal/session-creations/${r}/bind`, { ...own, conversationId: randomUUID(), projectId: null });
  assert.equal((await api(`/v1/sessions/${r}`)).body.creationStatus, "created");
}));

test("project metadata is local, updates by stable ID and preserves omitted descriptions", async () => fixture(async ({ api }: any) => {
  assert.equal((await api(`/v1/projects/${project}`, { name: "Old", description: "purpose" }, "PUT")).status, 200);
  await api(`/v1/projects/${project}-renamed`, { name: "New" }, "PUT");
  const rows = (await api("/v1/projects")).body.projects;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "New");
  assert.equal(rows[0].description, "purpose");
  await api(`/v1/projects/${project}`, { name: "New", description: null }, "PUT");
  assert.equal((await api("/v1/projects")).body.projects[0].description, null);
  await api(`/v1/projects/${project}`, undefined, "DELETE");
  assert.deepEqual((await api("/v1/projects")).body.projects, []);
}));

test("expired first task after the open fence remains unknown and permits late owned binding", async () => fixture(async ({ api, handle }: any) => {
  const r = ref();
  const first = (await api("/v1/sessions", { sessionRef: r, projectId: null, text: "first", timeout: 1000 })).body;
  const cmd = (await api("/internal/session-creations/claim", { owner: "browser" })).body.command;
  const own = { owner: "browser", token: cmd.token, tabId: 4 };
  await api(`/internal/session-creations/${r}/opening`, own);
  handle.store.expireDueTasks(handle.store.getTask(first.taskId).expiresAt + 1);
  assert.equal((await api(`/v1/sessions/${r}`)).body.creationStatus, "unknown");
  assert.equal((await api(`/internal/session-creations/${r}/attach`, own)).status, 200);
  assert.equal((await api(`/internal/session-creations/${r}/bind`, { ...own, conversationId: randomUUID(), projectId: null })).status, 200);
  assert.equal((await api(`/v1/sessions/${r}`)).body.creationStatus, "created");
}));

test("tab restoration requires the old tab identity and does not accept stale ownership", async () => fixture(async ({ api }: any) => {
  const r = ref();
  await api("/v1/sessions", { sessionRef: r, projectId: null, text: "first" });
  const cmd = (await api("/internal/session-creations/claim", { owner: "browser" })).body.command;
  const own = { owner: "browser", token: cmd.token };
  await api(`/internal/session-creations/${r}/opening`, own);
  await api(`/internal/session-creations/${r}/attach`, { ...own, tabId: 1 });
  assert.equal((await api(`/internal/session-creations/${r}/reattach`, { ...own, previousTabId: 1, tabId: 2 })).status, 400);
  assert.equal((await api(`/internal/session-creations/${r}/reattach`, { ...own, previousTabId: 1, tabId: 2, previousTabMissing: true })).status, 200);
  assert.equal((await api(`/internal/session-creations/${r}/bind`, { ...own, tabId: 1, conversationId: randomUUID(), projectId: null })).status, 409);
}));

test("message retry returns the accepted task after pause; a new request is still blocked", async () => fixture(async ({ api }: any) => {
  const input = { session: "paused-retry", text: "once", clientRequestId: "stable" };
  const first = (await api("/v1/tasks", input)).body;
  await api("/v1/sessions/paused-retry/pause", {});
  assert.equal((await api("/v1/tasks", input)).body.taskId, first.taskId);
  assert.equal((await api("/v1/tasks", { ...input, clientRequestId: "new" })).status, 409);
  assert.equal((await api("/v1/tasks", { ...input, clientRequestId: "" })).status, 400);
  assert.equal((await api("/v1/tasks?session=paused-retry&clientRequestId=")).status, 400);
}));

test("client recovers a lost creation retry by ref even with a different message key", async () => fixture(async ({ api, base }: any) => {
  const r = ref();
  const first = (await api("/v1/sessions", { sessionRef: r, projectId: null, text: "bootstrap", clientRequestId: "original-key" })).body;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await original(...args);
    if (String(args[0]).endsWith("/v1/sessions") && args[1]?.method === "POST") throw new Error("creation response lost");
    return response;
  };
  try { await assert.rejects(review("bootstrap", { sessionRef: r, newSession: true, projectId: null, baseUrl: base, wait: false }), /response lost/); }
  finally { globalThis.fetch = original; }
  assert.equal(listPending()[0]?.sessionRef, r);
  const rows = await resumePending(base);
  assert.equal(rows[0]!.task?.text, "bootstrap");
  assert.equal(rows[0]!.task?.sessionRef, r);
  assert.equal(rows[0]!.task?.taskId, first.taskId);
  assert.equal(rows[0]!.record.requestOnly, false);
}));

test("client generates independent message keys and resume finds an accepted request with no task ID", async () => fixture(async ({ api, base }: any) => {
  const a = await review("one", { session: "existing", baseUrl: base, wait: false });
  const b = await review("two", { session: "existing", baseUrl: base, wait: false });
  assert.notEqual(a.taskId, b.taskId);
  const pending = listPending();
  assert.equal(pending.length, 2);
  assert.ok(pending.every(r => r.clientRequestId));
  for (const r of pending) clearPending(r.taskId);
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await original(...args);
    if (String(args[0]).endsWith("/v1/tasks") && args[1]?.method === "POST") throw new Error("response lost");
    return response;
  };
  try { await assert.rejects(review("lost", { session: "existing", baseUrl: base, wait: false }), /response lost/); }
  finally { globalThis.fetch = original; }
  assert.equal(listPending()[0]?.requestOnly, true);
  const resumed = await resumePending(base);
  assert.equal(resumed.length, 1);
  assert.ok(resumed[0]!.task?.taskId);
  assert.equal(resumed[0]!.task?.text, "lost");
  assert.equal(resumed[0]!.record.requestOnly, false);
  const rows = (await api("/v1/tasks?session=existing")).body.tasks;
  assert.equal(rows.length, 3, "resume queries the accepted request and never submits again");
}));

test("Project discovery previews and merges observed names while preserving descriptions and unseen entries", async () => fixture(async ({ api }: any) => {
  const unseen = "g-p-" + "d".repeat(32);
  await api(`/v1/projects/${project}`, { name: "Old", description: "Manual purpose" }, "PUT");
  await api(`/v1/projects/${unseen}`, { name: "Unseen" }, "PUT");
  const sources = [{ url: "https://chatgpt.com/c/example", projects: [
    { projectId: project, name: "Renamed", href: `https://chatgpt.com/g/${project}/project` },
    { projectId: unseen, name: "Bad", href: `https://evil.test/g/${unseen}/project` },
    { projectId: unseen, name: "Chat title", href: `https://chatgpt.com/g/${unseen}/c/example` },
  ] }];
  for (const save of [false, true]) {
    const id = (await api("/v1/projects/discover", { save })).body.discoveryId;
    const claim = (await api("/internal/project-discoveries/claim", { owner: "browser" })).body.command;
    assert.equal(claim.discoveryId, id);
    assert.equal((await api(`/internal/project-discoveries/${id}/complete`, { ...claim, owner: "other", sources })).status, 409);
    const body = { ...claim, owner: "browser", sources };
    const result = (await api(`/internal/project-discoveries/${id}/complete`, body)).body;
    assert.equal(result.status, "done"); assert.equal(result.complete, false); assert.equal(result.saved, save);
    assert.deepEqual(result.projects, [{ projectId: project, name: "Renamed" }]);
    assert.deepEqual((await api(`/internal/project-discoveries/${id}/complete`, body)).body, result);
    const rows = (await api("/v1/projects")).body.projects;
    assert.equal(rows.find((p: any) => p.projectId === project).name, save ? "Renamed" : "Old");
    assert.equal(rows.find((p: any) => p.projectId === project).description, "Manual purpose");
    assert.equal(rows.find((p: any) => p.projectId === unseen).name, "Unseen");
  }
}));

test("discovery resumes read-only commands, skips conflicting names and rejects expired completion", async () => fixture(async ({ api, config }: any) => {
  const id = (await api("/v1/projects/discover", { save: true })).body.discoveryId;
  const claim = (await api("/internal/project-discoveries/claim", { owner: "browser" })).body.command;
  assert.deepEqual((await api("/internal/project-discoveries/claim", { owner: "browser" })).body.command, claim);
  assert.equal((await api("/internal/project-discoveries/claim", { owner: "other" })).body.command, null);
  const sources = ["First", "Second"].map(name => ({ url: "https://chatgpt.com/", projects: [
    { projectId: project, name, href: `/g/${project}/project` },
  ] }));
  const result = (await api(`/internal/project-discoveries/${id}/complete`, { ...claim, owner: "browser", sources })).body;
  assert.deepEqual(result.projects, []);
  assert.ok(result.warnings.includes(`conflicting_names:${project}`));
  assert.deepEqual((await api("/v1/projects")).body.projects, []);
  const next = (await api("/v1/projects/discover", {})).body.discoveryId;
  const second = (await api("/internal/project-discoveries/claim", { owner: "browser" })).body.command;
  assert.ok(second);
  const failed = (await api(`/internal/project-discoveries/${next}/complete`, { ...second, owner: "browser", sources: [] })).body;
  assert.equal(failed.status, "failed"); assert.equal(failed.error, "no_readable_chatgpt_tabs");
  assert.equal((await api(`/internal/project-discoveries/${next}/complete`, { ...second, owner: "browser", sources })).status, 409);
  const expired = (await api("/v1/projects/discover", {})).body.discoveryId;
  const third = (await api("/internal/project-discoveries/claim", { owner: "browser" })).body.command;
  const { openDatabase } = await import("../server/db.js");
  const db = openDatabase(config.dbFile);
  db.prepare("UPDATE project_discoveries SET expires_at=0 WHERE id=?").run(expired);
  db.close();
  assert.equal((await api(`/v1/projects/discover/${expired}`)).body.error, "discovery_timeout");
  assert.equal((await api(`/internal/project-discoveries/${expired}/complete`, { ...third, owner: "browser", sources })).status, 409);
}));
