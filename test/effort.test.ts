import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";
import { SessionDiagnostics } from "../server/session-diagnostics.js";
import { SessionControls } from "../server/session-controls.js";
import { parseEffortPolicy, verifyEffort, type EffortSelection } from "../shared/effort.js";
import { validateBusinessArgs } from "../client/cli-options.js";
import fs from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";

const policy = { effort: "max", effortFallback: "error" } as const;
const selection: EffortSelection = { requestedEffort: "max", effectiveEffort: "max", fallbackApplied: false, modelFamily: "GPT-6" };

test("effort values and CLI scope are explicit; no Codex xhigh alias or silent task override", () => {
  assert.equal(parseEffortPolicy({}), null);
  assert.deepEqual(parseEffortPolicy({ effort: "pro" }), { effort: "pro", effortFallback: "error" });
  for (const body of [{ effort: "xhigh" }, { effort: null }, { effortFallback: "lower" }, { effort: "high", effortFallback: "maximum" }])
    assert.throws(() => parseEffortPolicy(body));
  validateBusinessArgs("sessions", ["effort", "--session", "chat", "--effort", "pro"]);
  validateBusinessArgs("review", ["--new-session", "--session-ref", "sr_new", "--no-project", "--text", "test", "--effort", "max"]);
  for (const args of [["effort", "--session", "chat"], ["effort", "--session", "chat", "--effort", "xhigh"]])
    assert.throws(() => validateBusinessArgs("sessions", args));
  assert.throws(() => validateBusinessArgs("review", ["--session", "chat", "--text", "test", "--effort", "max"]));
});

test("session controls persist only verified success; block queued work and operation-ID payload changes", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig()), diag = new SessionDiagnostics(db, store);
    const controls = new SessionControls(db, store, diag);
    store.touchSession("effort-chat");
    diag.report({ session: "effort-chat", owner: "edge", tabId: 1, protocol: 1,
      ready: true, generating: false, composerClean: true, capabilities: { effort: true } });
    const body = { operationId: "effort-operation", kind: "set-effort", session: "effort-chat", ...policy };
    assert.equal(controls.create(body).state, "queued");
    assert.throws(() => controls.create({ ...body, effort: "high" }), /operation_id_conflict/);
    const task = store.createTask({ session: "effort-chat", text: "next" });
    assert.equal(store.claimNextTask("effort-chat"), null);
    const command = controls.claim("edge")!;
    assert.throws(() => controls.finish(command.operationId, { owner: "edge", token: command.token, state: "succeeded", result: selection }), /verification/);
    controls.fence(command.operationId, { owner: "edge", token: command.token, documentId: "document" });
    controls.finish(command.operationId, { owner: "edge", token: command.token, state: "succeeded", result: selection });
    assert.deepEqual(new TaskStore(db, loadConfig()).registry.view(store.registry.get("effort-chat")!).effortPolicy, policy);
    const claimed = store.claimNextTask("effort-chat")!;
    assert.equal(claimed.id, task.id);
    assert.deepEqual(claimed.effortPolicy, policy);
    assert.throws(() => controls.create({ ...body, operationId: "effort-next-one" }), /session_busy/);
    store.recordEffortSelection(task.id, selection);
    store.markTaskProgress(task.id, "send_attempted");
    assert.throws(() => store.recordEffortSelection(task.id, { ...selection, modelFamily: "GPT-5.6 Sol" }), /conflict/);
  } finally { db.close(); }
});

test("effort mismatch/unknown retain captured reply and cannot replay across restart; ordinary tasks unchanged", () => {
  for (const [evidence, error] of [[{ model: "gpt-6-thinking", thinkingEffort: "max" }, null],
      [{ model: "gpt-6-thinking", thinkingEffort: "extended" }, "effort_mismatch"],
      [{ model: "gpt-5.6-thinking", thinkingEffort: "max" }, "effort_mismatch"],
      [null, "effort_verification_unknown"]] as const) {
    const db = openDatabase(":memory:");
    try {
      let store = new TaskStore(db, loadConfig());
      store.touchSession("test");
      store.registry.setEffort("test", policy);
      const task = store.createTask({ session: "test", text: "test" });
      store.claimNextTask("test");
      store.recordEffortSelection(task.id, selection); store.markTaskProgress(task.id, "send_attempted");
      store = new TaskStore(db, loadConfig());
      const result = store.captureReply(task.id, "saved reply", Date.now(), evidence);
      assert.equal(result.task.reply, "saved reply");
      assert.equal(result.task.error, error);
      assert.equal(result.task.status, error ? "failed" : "done");
      store.captureReply(task.id, "replacement", Date.now(), { model: "gpt-6-pro" });
      assert.equal(store.getTask(task.id)!.reply, "saved reply");
      assert.equal(store.claimNextTask("test"), null);
    } finally { db.close(); }
  }
  assert.equal(verifyEffort({ ...selection, effectiveEffort: "pro", requestedEffort: "pro" }, { model: "gpt-6-pro" }).status, "verified");
  assert.equal(verifyEffort({ ...selection, effectiveEffort: "pro", requestedEffort: "pro" }, { model: "gpt-6-thinking", thinkingEffort: "standard" }).status, "mismatch");
});

function dom({ max = 4, pro = true, chinese = false, family = "GPT-6", inertDuplicate = false, ignoreKeys = false, delayedKey = false } = {}) {
  const w = new Window();
  w.document.body.innerHTML = '<form><div contenteditable="true"></div><button id="trigger" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="max" aria-expanded="false">Extra High</button></form>';
  const form = w.document.querySelector("form")!, b = form.querySelector("button")!;
  const rect = () => ({ width: 100, height: 30 } as any);
  Object.defineProperty(w.HTMLElement.prototype, "getBoundingClientRect", { value: rect, configurable: true });
  let index = Math.min(3, max), clock = 0, familyClicks = 0, pendingKey: string | null = null;
  const labels = chinese ? ["即时", "中", "高", "极高", "Pro"] : ["Instant", "Medium", "High", "Extra High", "Pro"];
  const update = () => {
    const menu = w.document.querySelector('[role="menu"]');
    const isPro = pro && index === max;
    b.setAttribute("data-selected-reasoning-effort", isPro ? "medium" : ["none", "medium", "high", "max"][index]!);
    b.textContent = isPro ? "Pro" : labels[index]!;
    menu?.querySelector('[role="slider"]')?.setAttribute("aria-valuenow", String(index));
    menu?.querySelector("[data-maximum]")?.setAttribute("data-maximum", String(isPro));
  };
  update();
  b.addEventListener("click", () => {
    if (w.document.querySelector('[role="menu"]')) return;
    const menu = w.document.createElement("div");
    menu.setAttribute("role", "menu"); menu.setAttribute("data-state", "open"); menu.setAttribute("aria-labelledby", b.id);
    menu.innerHTML = `<div data-model-selected="true">${family}</div><div data-model-picker-view-toggle="true"></div><span data-maximum="false"></span><div data-reasoning-slider><span role="slider" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${index}"></span></div>`;
    menu.querySelector("[data-model-picker-view-toggle]")!.addEventListener("click", () => familyClicks++);
    menu.querySelector("[data-reasoning-slider]")!.addEventListener("keydown", e => {
      if (delayedKey) { pendingKey = (e as any).key; return; }
      if (!ignoreKeys) index = Math.min(max, Math.max(0, index + ((e as any).key === "ArrowRight" ? 1 : -1)));
      update();
    });
    menu.addEventListener("keydown", e => {
      if ((e as any).key === "Escape") { menu.remove(); b.setAttribute("aria-expanded", "false"); update(); }
    });
    w.document.body.appendChild(menu); b.setAttribute("aria-expanded", "true"); update();
  });
  if (inertDuplicate) {
    const copy = b.cloneNode(true) as typeof b, container = w.document.createElement("div");
    container.setAttribute("inert", ""); container.appendChild(copy); form.appendChild(container);
  }
  const context: any = { document: w.document, KeyboardEvent: w.KeyboardEvent };
  vm.runInNewContext(fs.readFileSync(new URL("../extension/effort-controls.js", import.meta.url), "utf8"), context);
  const ctrl = context.GptRelayEffort.create({ root: () => form, sleep: async (ms: number) => {
    clock += ms;
    if (pendingKey) { clock += 13000; index += pendingKey === "ArrowRight" ? 1 : -1; pendingKey = null; update(); }
  }, now: () => clock });
  return { w, b, ctrl, index: () => index, familyClicks: () => familyClicks };
}

test("DOM adapter handles all 25 transitions, both languages, inert duplicates, and never selects a model family", async () => {
  for (const chinese of [false, true]) {
    const h = dom({ chinese, inertDuplicate: true });
    for (const from of ["none", "medium", "high", "max", "pro"])
      for (const to of ["none", "medium", "high", "max", "pro"]) {
        await h.ctrl.set({ effort: from });
        const result = await h.ctrl.set({ effort: to });
        assert.equal(result.effectiveEffort, to);
        await h.ctrl.recheck(); h.ctrl.assertUnchanged();
        assert.equal(h.b.getAttribute("aria-expanded"), "false");
      }
    assert.equal(h.familyClicks(), 0);
  }
});

test("DOM unavailable max fails or explicitly lowers; Pro never silently downgrades; unknown controls fail closed", async () => {
  const h = dom({ max: 2, pro: false });
  await assert.rejects(h.ctrl.set({ effort: "max" }), /effort_unavailable/);
  assert.equal(h.index(), 2);
  const lowered = await h.ctrl.set({ effort: "max", effortFallback: "lower" });
  assert.equal(lowered.effectiveEffort, "high"); assert.equal(lowered.fallbackApplied, true);
  await assert.rejects(h.ctrl.set({ effort: "pro", effortFallback: "lower" }), /effort_unavailable/);
  await assert.rejects(dom({ family: "Unknown" }).ctrl.set({ effort: "high" }), /effort_model_unsupported/);
  await assert.rejects(dom({ ignoreKeys: true }).ctrl.set({ effort: "high" }), /effort_timeout/);
  const normal = dom(); await normal.ctrl.set({ effort: "medium" });
  normal.b.textContent = "Pro";
  assert.throws(() => normal.ctrl.assertUnchanged(), /effort_changed/);
});

test("metadata verifier binds exact turn IDs, never returns credentials, and rejects another conversation/turn", async () => {
  const worker = fs.readFileSync(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  const source = worker.slice(worker.indexOf("async function readEffortEvidence("), worker.indexOf("async function verifyReplyEffort("));
  const calls: any[] = [];
  const context: any = { location: { origin: "https://chatgpt.com", pathname: "/c/our-test" }, AbortController, setTimeout, clearTimeout,
    fetch: async (url: string, init: any) => {
      calls.push({ url, init });
      if (url === "/api/auth/session") return { ok: true, json: async () => ({ accessToken: "SECRET" }) };
      if (!init.headers) return { ok: false, status: 401 };
      return { ok: true, json: async () => ({ messages: [
        { id: "user", author: { role: "user" } },
        { id: "reply", author: { role: "assistant" }, status: "finished_successfully", metadata: { model_slug: "gpt-6-pro" } },
      ] }) };
    } };
  vm.runInNewContext(source, context);
  const result = await context.readEffortEvidence("our-test", "user", "reply");
  assert.equal(result.model, "gpt-6-pro"); assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal((await context.readEffortEvidence("other-test", "user", "reply")).model, null);
  assert.equal((await context.readEffortEvidence("our-test", "another-user", "reply")).model, null);
  assert.ok(calls.every(c => c.url.startsWith("/")));
});

test("additive migration preserves existing tasks, refs and no-effort behavior", () => {
  const db = openDatabase(":memory:");
  try {
    let store = new TaskStore(db, loadConfig());
    const task = store.createTask({ session: "old-chat", text: "existing text" });
    for (const name of ["effort_policy", "effort_selection", "effort_verification"]) db.exec(`ALTER TABLE tasks DROP COLUMN ${name}`);
    db.exec("ALTER TABLE session_refs DROP COLUMN effort_policy");
    store = new TaskStore(db, loadConfig());
    assert.equal(store.getTask(task.id)!.text, "existing text");
    assert.equal(store.claimNextTask("old-chat")!.effortPolicy, null);
    const result = store.captureReply(task.id, "ordinary answer");
    assert.equal(result.task.status, "done"); assert.equal(result.task.effortVerification, null);
    assert.equal(new TaskStore(db, loadConfig()).getTask(task.id)!.reply, "ordinary answer");
  } finally { db.close(); }
});


test("background timer oversleep checks acknowledged DOM state before declaring timeout", async () => {
  const h = dom({ delayedKey: true });
  const result = await h.ctrl.set({ effort: "high" });
  assert.equal(result.effectiveEffort, "high");
  h.ctrl.assertUnchanged();
});

test("oversized/invalid control result cannot commit the desired effort", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig()), diag = new SessionDiagnostics(db, store), controls = new SessionControls(db, store, diag);
    store.touchSession("transaction-chat");
    diag.report({ session: "transaction-chat", owner: "edge", tabId: 1, protocol: 1,
      ready: true, generating: false, composerClean: true, capabilities: { effort: true } });
    controls.create({ operationId: "transaction-effort", kind: "set-effort", session: "transaction-chat", ...policy });
    const command = controls.claim("edge")!;
    const owner = { owner: "edge", token: command.token, documentId: "document" };
    controls.fence(command.operationId, owner);
    assert.throws(() => controls.finish(command.operationId, { ...owner, state: "succeeded",
      result: { ...selection, oversized: "x".repeat(5000) } }), /too_large/);
    assert.equal(store.registry.view(store.registry.get("transaction-chat")!).effortPolicy, null);
    assert.equal(controls.row(command.operationId)!.state, "executing");
    controls.finish(command.operationId, { ...owner, state: "unknown" });
    assert.equal(store.registry.view(store.registry.get("transaction-chat")!).effortPolicy, null);
  } finally { db.close(); }
});

test("queued work prevents a new effort control and late replies carry effort verification", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig()), diag = new SessionDiagnostics(db, store), controls = new SessionControls(db, store, diag);
    store.touchSession("late-effort");
    diag.report({ session: "late-effort", owner: "edge", tabId: 1, protocol: 1,
      ready: true, generating: false, composerClean: true, capabilities: { effort: true } });
    store.registry.setEffort("late-effort", policy);
    const task = store.createTask({ session: "late-effort", text: "late" });
    assert.throws(() => controls.create({ operationId: "queued-effort", kind: "set-effort", session: "late-effort", ...policy }), /session_busy/);
    store.claimNextTask("late-effort"); store.recordEffortSelection(task.id, selection);
    store.markTaskProgress(task.id, "send_attempted");
    store.completeTask(task.id, { error: "submission_outcome_unknown" });
    const result = store.captureReply(task.id, "late answer", Date.now(), { model: "gpt-6-thinking", thinkingEffort: "standard" });
    assert.equal(result.task.error, "submission_outcome_unknown");
    assert.equal(result.task.lateReply, "late answer");
    assert.equal(result.task.effortVerification!.status, "mismatch");
  } finally { db.close(); }
});
