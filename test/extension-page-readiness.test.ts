import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentScript = fs.readFileSync(
  path.resolve(__dirname, "..", "extension", "content-script.js"),
  "utf8",
);

type FakeElement = {
  id: string;
  order: number;
  isConnected: boolean;
  style: Record<string, string>;
  textContent: string;
  innerText: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  compareDocumentPosition(other: FakeElement): number;
  closest?(selector: string): FakeElement | null;
  querySelector?(selector: string): FakeElement | null;
  querySelectorAll?(selector: string): FakeElement[];
};

let elementOrder = 0;
function element(id: string, text = ""): FakeElement {
  return {
    id,
    order: ++elementOrder,
    isConnected: false,
    style: {},
    textContent: text,
    innerText: text,
    getAttribute(name: string) {
      return name === "data-message-id" ? id : null;
    },
    getBoundingClientRect() {
      return { width: 100, height: 30 };
    },
    compareDocumentPosition(other: FakeElement) {
      return this === other ? 0 : this.order < other.order ? 4 : 2;
    },
  };
}

function createHarness({ advanceTimers = false, managed = null as null | Record<string, unknown>, html = undefined as string | undefined } = {}) {
  const state = {
    reloads: 0,
    now: 10_000,
    readyState: "loading",
    input: element("input-1") as FakeElement | null,
    users: [] as FakeElement[],
    assistants: [] as FakeElement[],
    modernUserBubbles: [] as FakeElement[],
    modernUserUnits: [] as FakeElement[],
    modernAssistantHeadings: [] as FakeElement[],
    unrelatedSendButtons: [] as FakeElement[],
    projectLinks: [] as FakeElement[],
    projectRows: [] as FakeElement[],
    stopButtons: [] as FakeElement[],
    pathname: "/c/6a61e3cc-3160-83ee-9aa7-f79a39d93b3e",
    hash: managed ? `#relay-create=${encodeURIComponent(JSON.stringify(managed))}` : "",
    helloConversationId: null as string | null,
    helloAcknowledged: true,
    onSendMessage: null as null | ((message: any) => any),
    onTimer: null as null | ((ms: number) => void),
  };
  const storage = new Map<string, string>();
  const sentMessages: unknown[] = [];
  const listeners = new Map<string, Set<(event: any) => void>>();
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  let onMessage:
    | ((message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean)
    | undefined;

  const body = {
    appendChild(node: FakeElement) {
      node.isConnected = true;
    },
  };
  const mockDocument = {
    get readyState() {
      return state.readyState;
    },
    body,
    hidden: true,
    activeElement: null,
    createElement(tag: string) {
      return element(tag);
    },
    createTextNode(text: string) {
      return { textContent: text };
    },
    addEventListener(type: string, callback: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(callback);
    },
    removeEventListener(type: string, callback: (event: any) => void) {
      listeners.get(type)?.delete(callback);
    },
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string) {
      if (selector === 'a[href]') return state.projectLinks;
      if (selector === '[data-app-action-sidebar-project-row]') return state.projectRows;
      if (selector === '[data-message-author-role="user"]') return state.users;
      if (selector === '[data-message-author-role="assistant"]') return state.assistants;
      if (selector === '[data-user-message-bubble]') return state.modernUserBubbles;
      if (selector === '[data-content-search-unit-key$=":user"]') return state.modernUserUnits;
      if (selector === '[data-conversation-role="assistant"]') return state.modernAssistantHeadings;
      if (selector === '[data-testid="send-button"]') return state.unrelatedSendButtons;
      if (selector === '[data-testid="stop-button"]') return state.stopButtons;
      if (selector === "#prompt-textarea") return state.input ? [state.input] : [];
      return [];
    },
  };
  const dom = html === undefined ? null : new Window({ settings: {
    enableJavaScriptEvaluation: false,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
  } });
  if (dom) {
    dom.document.write(html!);
    Object.defineProperty(dom.document, "readyState", { get: () => state.readyState });
    // Only layout is simulated; selectors, ancestry, order and IDs use the parsed DOM.
    Object.defineProperty(dom.HTMLElement.prototype, "getBoundingClientRect", {
      value: () => ({ width: 100, height: 30 }), configurable: true,
    });
  }
  const document = dom?.document ?? mockDocument;
  const location = {
    get hash() { return state.hash; },
    get pathname() {
      return state.pathname;
    },
    reload() { state.reloads++; },
  };
  const sessionStorage = {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
  };
  class FakeDate extends Date {
    static override now() {
      return state.now;
    }
  }
  const window = {
    fetch: async () => ({ ok: true, status: 200 }),
    addEventListener() {},
  };
  const chrome = {
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
        const override = state.onSendMessage?.(message);
        if (override) return override;
        return state.helloAcknowledged ? { status: "ok", conversationId: state.helloConversationId } : { error: "worker unavailable" };
      },
      onMessage: {
        addListener(listener: typeof onMessage) {
          onMessage = listener;
        },
      },
    },
  };

  vm.runInNewContext(contentScript, {
    window,
    document,
    location,
    sessionStorage,
    chrome,
    crypto: { randomUUID: () => "fallback-session" },
    URL,
    Element: class { static [Symbol.hasInstance](value:any) {return typeof value?.closest==='function';} },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    Date: FakeDate,
    Math,
    JSON,
    Promise,
    DataTransfer: class {
      value = "";
      setData(_type: string, value: string) { this.value = value; }
    },
    ClipboardEvent: class {
      type: string; clipboardData: any;
      constructor(type: string, options: any) { this.type = type; this.clipboardData = options.clipboardData; }
    },
    InputEvent: class {
      constructor(public type: string, options: any) { Object.assign(this, options); }
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback: () => void, ms: number) => {
      if (advanceTimers) {
        queueMicrotask(() => {
          state.now += ms;
          state.onTimer?.(ms);
          callback();
        });
      }
      return 0;
    },
    setInterval: (callback: () => void, ms: number) => {
      intervals.push({ callback, ms });
      return 0;
    },
    clearTimeout() {},
    clearInterval() {},
  });

  assert.ok(onMessage, "content script did not register onMessage");
  return {
    state,
    dom,
    seedInflight(record: Record<string, unknown>) { storage.set("gpt_relay_inflight_v3", JSON.stringify(record)); },
    sentMessages,
    userEvent(type: string, target: any) {
      for (const callback of listeners.get(type) ?? []) callback({type, target, isTrusted:true});
    },
    tickInterval(ms: number) {
      for (const interval of intervals) {
        if (interval.ms === ms) interval.callback();
      }
    },
    async sessionId() {
      return new Promise<string>((resolve) => {
        onMessage?.({ type: "get-session-id" }, {}, (value) => {
          resolve((value as { session: string }).session);
        });
      });
    },
    async message(message: Record<string, unknown>) {
      return new Promise<Record<string, unknown>>(resolve => {
        onMessage?.(message, {}, value => resolve(value as Record<string, unknown>));
      });
    },
    async pageState() {
      return new Promise<Record<string, unknown>>((resolve) => {
        onMessage?.({ type: "get-page-state" }, {}, (value) => {
          resolve(value as Record<string, unknown>);
        });
      });
    },
    async resetComposer() {
      return new Promise<Record<string, unknown>>((resolve) => {
        onMessage?.({ type: "reset-composer" }, {}, (value) => {
          resolve(value as Record<string, unknown>);
        });
      });
    },
    async pollReply(
      baseline: Record<string, unknown>,
      expectedSession?: string,
    ) {
      return new Promise<Record<string, unknown>>((resolve) => {
        onMessage?.({ type: "poll-reply", baseline, expectedSession }, {}, (value) => {
          resolve(value as Record<string, unknown>);
        });
      });
    },
  };
}

function modernMessage(role: "user" | "assistant", id: string, text: string, key = `unit-${id}`) {
  const unit = element(id, role === "assistant" ? `Assistant${text}` : text);
  unit.getAttribute = (name: string) =>
    name === "data-content-search-unit-key" ? key : null;
  const marker = element(`${id}-marker`);
  marker.closest = (selector: string) =>
    selector === "[data-content-search-unit-key]" ? unit : null;
  if (role === "assistant") {
    const content = element(`${id}-content`, text);
    content.getAttribute = name => name === "data-chatgpt-selection-message-id" ? id : null;
    unit.querySelector = (selector: string) =>
      selector === "[data-chatgpt-selection-message-id]" ? content : null;
    unit.querySelectorAll = selector => selector === "[data-chatgpt-selection-message-id]" ? [content] : [];
  } else {
    const source = element(`${id}-search-unit`);
    source.getAttribute = name => name === "data-chatgpt-search-message-ids" ? id :
      name === "data-chatgpt-search-unit-key" ? key : null;
    unit.closest = selector => selector === "[data-chatgpt-search-message-ids]" ? source : null;
  }
  return { unit, marker };
}

function conversationErrorPage(text: string) {
  // Sanitized structure observed on a real length-limited Project conversation.
  return `<main><div data-content-search-turn-key="fallback-turn-11">
    <div data-chatgpt-search-unit-key="fallback-turn-11:0:user" data-chatgpt-search-message-ids="user-id">
      <div data-user-message-bubble>Last prompt</div>
    </div>
    <div><aside class="border-text-danger/20 text-danger" role="alert">
      <div>${text}</div><button type="button">↗</button>
    </aside></div>
  </div></main><form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">PRIVATE DRAFT</div></form>`;
}

for (const text of [
  "你已达到此对话的长度上限，你可以开始新聊天以继续对话。",
  "You have reached the maximum length for this conversation.",
  "この会話の長さの上限に達しました。",
  "لقد وصلت إلى الحد الأقصى لطول هذه المحادثة.",
  "Unrecognized localized error",
]) {
  test(`conversation error detection is independent of UI language: ${text}`, async () => {
    const h = createHarness({ html: conversationErrorPage(text) });
    h.state.readyState = "complete";
    const page = await h.pageState();
    assert.equal(page.ready, false);
    assert.equal(page.reason, "conversation_blocked");
    assert.equal((page.block as any).code, "conversation_blocked");
    assert.ok((page.block as any).text.includes(text));
    const safety = await h.message({ type: "check-safety" });
    assert.equal((safety.block as any).code, "conversation_blocked");
    const poll = await h.pollReply({});
    assert.equal(poll.status, "safety");
    assert.equal(poll.code, "conversation_blocked");
    const run = await h.message({ type: "run-task", taskId: "blocked", text: "must not send" });
    assert.equal(run.errorCode, "conversation_blocked");
    assert.equal(run.submissionState, "not-submitted");
    assert.equal(h.dom!.document.querySelector("#prompt-textarea")!.textContent, "PRIVATE DRAFT");
    assert.ok(!h.sentMessages.some((m: any) => m.type === "send-attempted"));
    await h.dom!.happyDOM.close();
  });
}

for (const mode of ["historical", "quoted-user", "quoted-assistant", "hidden", "non-danger", "unrelated", "new-chat"]) {
  test(`conversation error detection ignores ${mode} alerts`, async () => {
    const h = createHarness({ html: conversationErrorPage("Localized error") });
    const doc = h.dom!.document;
    const alert = doc.querySelector("aside")!;
    const turn = doc.querySelector("[data-content-search-turn-key]")!;
    if (mode === "historical") turn.insertAdjacentHTML("afterend", '<div data-content-search-turn-key="next"><div data-message-author-role="assistant">Later answer</div></div>');
    if (mode === "quoted-user") doc.querySelector("[data-user-message-bubble]")!.appendChild(alert);
    if (mode === "quoted-assistant") {
      const message = doc.createElement("div");
      message.setAttribute("data-message-author-role", "assistant");
      turn.appendChild(message); message.appendChild(alert);
    }
    if (mode === "hidden") Object.defineProperty(alert, "getBoundingClientRect", { value: () => ({ width: 0, height: 0 }) });
    if (mode === "non-danger") alert.className = "text-default";
    if (mode === "unrelated") doc.body.appendChild(alert);
    if (mode === "new-chat") h.state.pathname = "/";
    assert.equal((await h.message({ type: "check-safety" })).block, null);
    assert.equal((await h.pageState()).block, null);
    await h.dom!.happyDOM.close();
  });
}

test("close preflight rejects changed documents, drafts and local in-flight work", async () => {
  const h = createHarness();
  h.state.readyState = "complete";
  h.state.users = [element("original-user")];
  const page = await h.pageState();
  const request = { type: "check-close", expectedSession: page.session, documentId: page.documentId };
  h.state.now += 5000;
  assert.equal((await h.message(request)).closeAllowed, true);
  assert.equal((await h.message({ ...request, documentId: "different" })).error, "session_identity_changed");
  h.state.input!.textContent = "keep my draft";
  assert.equal((await h.message(request)).error, "composer_not_clean");
  h.state.input!.textContent = "";
  await h.pageState(); h.state.now += 5000;
  h.seedInflight({ taskId: "original-task", session: page.session, phase: "accepted" });
  assert.equal((await h.message(request)).error, "page_not_idle");
  assert.equal(h.state.reloads, 0);
});

test("refresh validates identity and the latest composer before reloading", async () => {
  const h = createHarness();
  h.state.readyState = "complete";
  h.state.users = [element("existing-user", "hello")];
  await h.pageState();
  h.state.now += 5000;
  const page = await h.pageState();
  const request = { type: "refresh-page", expectedSession: page.session, documentId: page.documentId };
  assert.match(String((await h.message({ ...request, documentId: "wrong" })).error), /identity/);
  h.state.input!.textContent = "new draft";
  assert.match(String((await h.message(request)).error), /composer_not_clean/);
  assert.equal(h.state.reloads, 0);
  h.state.input!.textContent = "";
  await h.pageState(); h.state.now += 5000;
  assert.equal((await h.message(request)).reloading, true);
  assert.equal(h.state.reloads, 1);
});

test("Stop targets only the original last user turn and persists intent before clicking", async () => {
  const h = createHarness();
  const session = await h.sessionId();
  h.state.users = [element("original-user")];
  h.seedInflight({ taskId: "original-task", session, phase: "accepted", submittedUserMessageId: "original-user" });
  const request = { type: "stop-generation", expectedSession: session, taskId: "original-task", submittedUserMessageId: "original-user" };
  let clicks = 0;
  const stop = element("stop") as any;
  stop.click = () => { clicks++; h.state.stopButtons = []; };
  h.state.stopButtons = [stop];
  assert.match(String((await h.message({ ...request, taskId: "other" })).error), /stop_identity_mismatch/);
  h.state.users.push(element("newer-user"));
  assert.match(String((await h.message(request)).error), /stop_identity_mismatch/);
  assert.equal(clicks, 0);
  h.state.users.pop();
  const response = await h.message(request);
  assert.equal(response.clicked, true);
  assert.equal(response.generating, false);
  assert.equal(clicks, 1);
  assert.ok((await h.message({ type: "get-inflight" }) as any).inflight.stopRequestedAt);
  assert.equal((await h.message(request)).clicked, false);
  assert.equal(clicks, 1);
});

for (const action of ["poll-reply", "refresh-page", "stop-generation"]) {
  test(`${action} persists a user ID that appears after generation starts`, async () => {
    const h = createHarness();
    h.state.readyState = "complete";
    h.state.users = [element("baseline-user")];
    const page = await h.pageState();
    const baseline = page.baseline;
    h.seedInflight({ taskId: "task", session: page.session, phase: "accepted", baseline, submittedUserMessageId: null });
    let clicks = 0;
    const stop = element("stop") as any;
    stop.click = () => { clicks++; h.state.stopButtons = []; };
    h.state.stopButtons = [stop];
    const request = { type: action, taskId: "task", expectedSession: page.session,
      documentId: page.documentId, baseline, ...(action === "stop-generation" ? { submittedUserMessageId: "late-user" } : {}) };
    await h.message(request);
    assert.equal((await h.message({ type: "get-inflight" }) as any).inflight.submittedUserMessageId, null);
    assert.equal(clicks, 0); assert.equal(h.state.reloads, 0);
    h.state.users.push(element("late-user"));
    const result = await h.message(request);
    assert.equal(result.error, undefined);
    assert.equal((await h.message({ type: "get-inflight" }) as any).inflight.submittedUserMessageId, "late-user");
    if (action === "poll-reply") {
      assert.equal(result.submittedUserMessageId, "late-user");
      assert.equal((await h.message({ ...request, type: "refresh-page" })).reloading, true);
      assert.equal((await h.message({ ...request, type: "stop-generation", submittedUserMessageId: "late-user" })).clicked, true);
    } else if (action === "refresh-page") assert.equal(result.reloading, true);
    else assert.equal(result.clicked, true);
  });

  for (const fault of ["foreign-task", "foreign-session", "wrong-id", "ambiguous", "missing-anchor", "missing-baseline", "preparing", "existing-id"]) {
    test(`${action} does not learn a late user ID with ${fault}`, async () => {
      const h = createHarness();
      h.state.readyState = "complete";
      h.state.users = [element("baseline-user")];
      const page = await h.pageState();
      const baseline = page.baseline;
      const originalId = fault === "existing-id" ? "different-bound-user" : null;
      h.seedInflight({ taskId: "task", session: page.session, phase: fault === "preparing" ? "preparing" : "accepted",
        ...(fault === "missing-baseline" ? {} : { baseline }), submittedUserMessageId: originalId });
      h.state.users.push(element("late-user"));
      if (fault === "ambiguous") h.state.users.push(element("newer-user"));
      if (fault === "missing-anchor") h.state.users.shift();
      let clicks = 0;
      const stop = element("stop") as any;
      stop.click = () => { clicks++; };
      h.state.stopButtons = [stop];
      const result = await h.message({ type: action, taskId: fault === "foreign-task" ? "other" : "task",
        expectedSession: fault === "foreign-session" ? "other" : page.session,
        documentId: page.documentId, baseline,
        submittedUserMessageId: fault === "wrong-id" ? "wrong" : "late-user" });
      assert.equal((await h.message({ type: "get-inflight" }) as any).inflight.submittedUserMessageId, originalId);
      assert.equal(clicks, 0); assert.equal(h.state.reloads, 0);
      if (action !== "poll-reply") assert.ok(result.error);
    });
  }
}

test("managed creation retains its ref after first navigation and releases later manual conversations", async () => {
  const h = createHarness({ managed: { sessionRef: "sr_test", token: "owner-token", owner: "browser", projectId: null } });
  h.state.pathname = "/";
  h.state.readyState = "complete";
  assert.equal(await h.sessionId(), "sr_test");
  const id = "6ab53993-e114-83ee-9b06-3859506fe3e2";
  h.state.pathname = `/c/${id}`;
  h.state.users = [element("first-user", "first")];
  h.state.helloConversationId = id;
  h.tickInterval(3000);
  await Promise.resolve();
  assert.equal(await h.sessionId(), "sr_test");
  h.state.pathname = "/c/6ab53993-e114-83ee-9b06-3859506fe3e3";
  assert.notEqual((await h.pageState()).reason, "creation-route-mismatch");
  assert.equal(await h.sessionId(), "6ab53993-e114-83ee-9b06-3859506fe3e3");
  assert.equal((await h.message({ type: "get-session-id" })).managed, null);
});

for (const target of ["/", "/c/6ac0da0c-f304-83e8-ac0f-25235ca1d760",
  "/g/g-p-" + "a".repeat(32) + "/project", "/g/g-p-" + "a".repeat(32) + "/c/6ac0da0c-f304-83e8-ac0f-25235ca1d760"]) {
  test(`a bound managed tab registers manual navigation independently: ${target}`, async () => {
    const bound = "6ab53993-e114-83ee-9b06-3859506fe3e2";
    const h = createHarness({ managed: { sessionRef: "sr_original", token: "t", owner: "b", projectId: null,
      boundConversation: bound } });
    h.state.pathname = `/c/${bound}`;
    h.state.readyState = "complete";
    h.state.users = [element("original-user")];
    h.seedInflight({ taskId: "original-task", session: "sr_original", phase: "accepted", submittedUserMessageId: "original-user" });
    assert.equal(await h.sessionId(), "sr_original");
    h.state.pathname = target;
    h.state.users = [element("manual-user")];
    h.tickInterval(3000);
    const metadata = await h.message({ type: "get-session-id" });
    assert.equal(metadata.managed, null);
    assert.notEqual(metadata.session, "sr_original");
    assert.equal(metadata.postSend, false);
    assert.equal((h.sentMessages.at(-1) as any).managed, null);
    await h.pageState(); h.state.now += 5000;
    assert.equal((await h.pageState()).ready, true);
    assert.equal((await h.message({ type: "get-inflight" }) as any).inflight.taskId, "original-task");
    h.state.pathname = `/c/${bound}`;
    assert.equal(await h.sessionId(), "sr_original");
    assert.equal((await h.message({ type: "get-session-id" }) as any).managed.boundConversation, bound);
  });
}

test("managed project creation blocks fallback into an ordinary conversation", async () => {
  const projectId = "g-p-" + "a".repeat(32);
  const h = createHarness({ managed: { sessionRef: "sr_project", token: "t", owner: "b", projectId } });
  h.state.readyState = "complete";
  h.state.pathname = `/g/${projectId}-name/project`;
  assert.equal(await h.sessionId(), "sr_project");
  h.state.pathname = "/";
  assert.equal((await h.pageState()).reason, "creation-route-mismatch");
});

test("worker configuration restores the stable ref when the initial URL marker was stripped", async () => {
  const h = createHarness();
  h.state.pathname = "/";
  const configured = await h.message({ type: "configure-session", managed: {
    sessionRef: "sr_configured", token: "token", owner: "browser", projectId: null, initialTaskId: "first-task",
  } });
  assert.equal(configured.session, "sr_configured");
  assert.equal(await h.sessionId(), "sr_configured");
});

test("a reopened conversation restores its canonical identity without creation credentials", async () => {
  const h = createHarness();
  const conversationId = await h.sessionId();
  const request = { type: "configure-session-identity", expectedSession: conversationId,
    session: "sr_original", conversationId };
  const restored = await h.message(request);
  assert.equal(restored.session, "sr_original");
  assert.equal(restored.managed, null);
  assert.equal((await h.message(request)).session, "sr_original", "concurrent registration is idempotent");
  assert.equal(await h.sessionId(), "sr_original");
  assert.equal((h.sentMessages.at(-1) as any).session, "sr_original");
  h.state.pathname = "/c/6ac0da0c-f304-83e8-ac0f-25235ca1d760";
  assert.equal(await h.sessionId(), "6ac0da0c-f304-83e8-ac0f-25235ca1d760");
  assert.ok((await h.message(request)).error, "a delayed response cannot bind another conversation");
  h.state.pathname = `/c/${conversationId}`;
  assert.equal(await h.sessionId(), "sr_original");
  assert.ok((await h.message({ ...request, session: "sr_conflicting" })).error);
});

for (const fault of ["invalid-ref", "wrong-conversation", "wrong-current-session", "unbound-creation"]) {
  test(`canonical identity restoration rejects ${fault}`, async () => {
    const h = createHarness(fault === "unbound-creation" ? { managed: {
      sessionRef: "sr_creating", token: "token", owner: "browser", projectId: null,
    } } : {});
    const currentSession = await h.sessionId();
    const conversationId = h.state.pathname.split("/").at(-1);
    const response = await h.message({ type: "configure-session-identity",
      expectedSession: fault === "wrong-current-session" ? "other" : currentSession,
      conversationId: fault === "wrong-conversation" ? "different" : conversationId,
      session: fault === "invalid-ref" ? "invalid" : "sr_original" });
    assert.ok(response.error);
    assert.equal(await h.sessionId(), currentSession);
  });
}

test("project conversation path reports its conversation ID and re-registers on same-ID navigation", async () => {
  const harness = createHarness();
  const id = "6ab53993-e114-83ee-9b06-3859506fe3e2";
  harness.state.pathname = `/g/g-p-6a4e822d22688191a382c7985c756fda-agentic-pr-review/c/${id}`;
  harness.tickInterval(3000);
  assert.equal(await harness.sessionId(), id);
  assert.equal((harness.sentMessages.at(-1) as { session: string }).session, id);

  const count = harness.sentMessages.length;
  harness.tickInterval(3000);
  assert.equal(harness.sentMessages.length, count, "unchanged path must not flood the worker");

  harness.state.pathname = `/g/g-p-renamed-project/c/${id}`;
  harness.tickInterval(3000);
  assert.equal(harness.sentMessages.length, count + 1);
  assert.equal((harness.sentMessages.at(-1) as { session: string }).session, id);
});

test("project conversation does not dispatch before its message history stabilizes", async () => {
  const harness = createHarness();
  const id = "6ab53993-e114-83ee-9b06-3859506fe3e2";
  harness.state.pathname = `/g/g-p-example/c/${id}`;
  harness.state.readyState = "complete";
  const hydrating = await harness.pageState();
  assert.equal(hydrating.session, id);
  assert.equal(hydrating.reason, "conversation-hydrating");

  harness.state.users = [element("user-1", "existing prompt")];
  await harness.pageState();
  harness.state.now += 4_000;
  const stable = await harness.pageState();
  assert.equal(stable.ready, true);
  assert.equal(stable.session, id);
});

test("new ChatGPT message containers provide stable IDs and reply text", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";
  const oldUser = modernMessage("user", "user-unit-1", "existing prompt");
  const oldAssistant = modernMessage("assistant", "assistant-unit-1", "existing reply");
  harness.state.modernUserBubbles = [oldUser.marker];
  harness.state.modernAssistantHeadings = [oldAssistant.marker];

  await harness.pageState();
  harness.state.now += 4_000;
  const ready = await harness.pageState();
  assert.equal(ready.ready, true);
  assert.equal((ready.baseline as any).lastUserId, "user-unit-1");
  assert.equal((ready.baseline as any).lastAssistantId, "assistant-unit-1");

  const newUser = modernMessage("user", "user-unit-2", "new prompt");
  const newAssistant = modernMessage("assistant", "assistant-unit-2", "new answer");
  harness.state.modernUserBubbles.push(newUser.marker);
  harness.state.modernAssistantHeadings.push(newAssistant.marker);
  await harness.pageState();
  harness.state.now += 4_000;
  const snapshot = await harness.pollReply(ready.baseline as Record<string, unknown>);
  assert.equal(snapshot.status, "reply-ready");
  assert.equal(snapshot.reply, "new answer");
});

test("an empty composer voice button is not mistaken for Send", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";
  harness.state.users = [element("user-1", "existing prompt")];
  const voiceButton = element("voice-button");
  harness.state.unrelatedSendButtons = [element("other-send-button")];
  (harness.state.input as any).closest = () => ({
    querySelector(selector: string) {
      return selector === "button:last-of-type" ? voiceButton : null;
    },
    querySelectorAll() { return []; },
  });
  const state = await harness.pageState();
  assert.equal((state.composer as { sendEnabled: boolean }).sendEnabled, false);
});

test("a background composer draft remains visible to payload checks", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";
  harness.state.users = [element("user-1", "existing prompt")];
  const input = harness.state.input as FakeElement;
  input.textContent = "unsent draft";
  input.innerText = "";
  const state = await harness.pageState();
  assert.equal((state.composer as { clean: boolean }).clean, false);
  assert.equal(state.composerClean, false);
});

test("session registration retries after the worker rejects a hello", async () => {
  const harness = createHarness();
  harness.state.helloAcknowledged = false;
  harness.state.pathname = "/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  harness.tickInterval(3000);
  await Promise.resolve();
  const count = harness.sentMessages.length;

  harness.state.helloAcknowledged = true;
  harness.tickInterval(3000);
  assert.equal(harness.sentMessages.length, count + 1);
  assert.equal((harness.sentMessages.at(-1) as { session: string }).session,
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

for (const projectId of [null, "g-p-" + "a".repeat(32)]) {
  test(`first-message registration preserves the active banner (project: ${!!projectId})`, async () => {
    const managed = { sessionRef: "sr_banner", owner: "browser", token: "token", projectId, initialTaskId: "first-task" };
    const h = createHarness({ managed, html: "<main></main>" });
    const banner = h.dom!.document.body.lastElementChild! as any;
    const idleColor = banner.style.background;
    const conversationId = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
    h.state.pathname = projectId ? `/g/${projectId}/project` : "/";
    h.tickInterval(3000);
    for (const [phase, text, color] of [
      ["preparing", "Submitting: first-ta…", "#e67e22"],
      ["accepted", "Waiting for reply: first-ta…", "#3498db"],
    ]) {
      h.seedInflight({ taskId: "first-task", session: managed.sessionRef, phase });
      await h.message({ type: "update-banner", text, color });
      const expectedColor = banner.style.background;
      // Simulate the SPA URL change and worker binding after the first Send.
      h.state.pathname = projectId ? `/g/${projectId}/c/${conversationId}` : `/c/${conversationId}`;
      h.tickInterval(3000);
      await h.message({ type: "configure-session", managed: { ...managed, boundConversation: conversationId } });
      assert.equal(banner.textContent, text);
      assert.equal(banner.style.background, expectedColor);
      assert.equal((h.sentMessages.at(-1) as any).conversationId, conversationId);
      assert.equal((h.sentMessages.at(-1) as any).session, managed.sessionRef);
      // A rejected registration must also retain the task state when retried.
      h.state.helloAcknowledged = false;
      h.state.pathname += "/";
      h.tickInterval(3000);
      await Promise.resolve();
      h.state.helloAcknowledged = true;
      h.tickInterval(3000);
      assert.equal(banner.textContent, text);
      assert.equal(banner.style.background, expectedColor);
    }
    await h.message({ type: "clear-inflight", taskId: "first-task", expectedSession: managed.sessionRef });
    assert.match(banner.textContent, /^Relay:/);
    assert.equal(banner.style.background, idleColor);
    // The active task belongs to its conversation, not a later manual navigation.
    h.seedInflight({ taskId: "first-task", session: managed.sessionRef, phase: "accepted" });
    await h.message({ type: "update-banner", text: "Waiting for reply", color: "#3498db" });
    h.state.pathname = "/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    h.tickInterval(3000);
    assert.match(banner.textContent, /^Relay: aaaaaaaa/);
    assert.equal(banner.style.background, idleColor);
    await h.dom!.happyDOM.close();
  });
}

test("refreshed conversation is not ready until history and composer stabilize", async () => {
  const harness = createHarness();

  let page = await harness.pageState();
  assert.equal(page.ready, false);
  assert.equal(page.reason, "document-loading");

  harness.state.readyState = "complete";
  page = await harness.pageState();
  assert.equal(page.ready, false);
  assert.equal(page.reason, "conversation-hydrating");

  harness.state.users = [element("user-1", "existing prompt")];
  page = await harness.pageState();
  assert.equal(page.ready, false);
  assert.equal(page.reason, "page-stabilizing");

  harness.state.now += 3_999;
  page = await harness.pageState();
  assert.equal(page.ready, false);

  harness.state.now += 1;
  page = await harness.pageState();
  assert.equal(page.ready, true);

  harness.state.input = element("input-2");
  page = await harness.pageState();
  assert.equal(page.ready, false);
  assert.equal(page.reason, "page-stabilizing");
});

for (const payload of ['text', 'attachment', 'upload']) {
  test(`a new ${payload} draft blocks dispatch but not observation of the original reply`, async () => {
    const h=createHarness(); h.state.readyState='complete';
    h.state.users=[element('old-user','old prompt')];
    await h.pageState(); h.state.now+=5000;
    const baseline=(await h.pageState()).baseline;
    h.state.users.push(element('sent-user','sent prompt'));
    h.state.assistants=[element('new-answer','COMPLETE_REPLY')];
    const input=h.state.input as any;
    input.textContent=payload==='text'?'next unsent draft':'';
    const attachment=element('draft-file','Private attachment');
    const root={querySelectorAll:(selector:string)=>
      selector==='[data-composer-attachments][data-visible-attachments]'&&payload==='attachment'?[attachment]:
      selector==='[role="progressbar"]'&&payload==='upload'?[element('upload')]:[]};
    input.closest=()=>root;
    await h.pageState(); h.state.now+=5000;
    const page=await h.pageState();
    assert.equal(page.ready,false);
    assert.equal(page.composerClean,false);
    const request={type:'poll-reply',baseline,submittedUserMessageId:'sent-user'};
    const reply=await h.message(request);
    assert.equal(reply.status,'reply-ready');
    assert.equal(reply.reply,'COMPLETE_REPLY');
    assert.equal(input.textContent,payload==='text'?'next unsent draft':'');
    h.state.readyState='loading';
    assert.equal((await h.message(request)).status,'page-unready');
    assert.equal((await h.pageState()).ready,false);
  });
}

test("reply polling reports page-unready while refreshed history is hydrating", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";

  const snapshot = await harness.pollReply({
    userCount: 1,
    lastUserId: "user-1",
    assistantCount: 1,
    lastAssistantId: "assistant-1",
  });
  assert.equal(snapshot.status, "page-unready");
  assert.equal(snapshot.reason, "conversation-hydrating");
});

test("reply polling rejects snapshots from a different conversation", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";
  harness.state.pathname = "/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  const snapshot = await harness.pollReply(
    {
      userCount: 1,
      lastUserId: "user-1",
      assistantCount: 1,
      lastAssistantId: "assistant-1",
    },
    "11111111-2222-3333-4444-555555555555",
  );
  assert.equal(snapshot.status, "session-mismatch");
  assert.equal(snapshot.currentSession, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("reply polling exposes bounded provisional generation metadata", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";
  harness.state.users = [element("user-1", "old prompt"), element("user-2", "new prompt")];
  harness.state.stopButtons = [element("stop", "Stop")];
  const activity = element("activity", "  Reading\nfiles  ");
  const assistant = element("assistant-2", "Reading filesDraft answer");
  assistant.querySelectorAll = (selector: string) =>
    selector === '[role="status"]' ? [activity] : [];
  harness.state.assistants = [assistant];

  const snapshot = await harness.pollReply({
    userCount: 1,
    lastUserId: "user-1",
    assistantCount: 1,
    lastAssistantId: "assistant-1",
  });
  assert.equal(snapshot.status, "generating");
  assert.equal(snapshot.activity, "Reading files");
  assert.equal(snapshot.outputChars, "Draft answer".length);
  assert.equal(snapshot.reply, undefined);
});

test("page state reports an attachment payload as not clean", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";
  harness.state.users = [element("user-1", "existing prompt")];
  const attachment = element("attachment-1", "Pasted Text");
  const composerRoot = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector: string) {
      return selector === "[data-file-id]" ? [attachment] : [];
    },
  };
  (harness.state.input as any).closest = () => composerRoot;

  await harness.pageState();
  harness.state.now += 4_000;
  const page = await harness.pageState();
  assert.equal((page.composer as any).attachmentPresent, true);
  assert.equal(page.composerClean, false);
});

test("new pasted-text attachment stays occupied with an empty editor and enabled Send", async () => {
  const harness = createHarness();
  harness.state.readyState = "complete";
  harness.state.users = [element("user-1", "existing prompt")];
  const attachment = element("visible-attachment", "Pasted Text");
  const submit = element("send");
  const composerRoot = {
    querySelectorAll(selector: string) {
      if (selector === '[data-composer-attachments][data-visible-attachments]') {
        return [attachment];
      }
      if (selector === 'button[type="submit"]') return [submit];
      return [];
    },
  };
  (harness.state.input as any).closest = () => composerRoot;

  await harness.pageState();
  harness.state.now += 4_000;
  const page = await harness.pageState();
  assert.equal((page.composer as any).attachmentPresent, true);
  assert.equal((page.composer as any).textLength, 0);
  assert.equal((page.composer as any).sendEnabled, true);
  assert.equal(page.composerClean, false);
});

test("new pasted-text attachment can be removed before another submission", async () => {
  const harness = createHarness({ advanceTimers: true });
  const attachment = element("visible-attachment", "Pasted Text");
  const remove = element("remove-attachment");
  let attached = true;
  (remove as any).click = () => { attached = false; };
  const composerRoot = {
    querySelectorAll(selector: string) {
      if (selector === '[data-composer-attachments][data-visible-attachments]') {
        return attached ? [attachment] : [];
      }
      if (selector === '[data-composer-attachments] button[aria-label^="\u79fb\u9664 "]') {
        return attached ? [remove] : [];
      }
      return [];
    },
  };
  (harness.state.input as any).closest = () => composerRoot;

  const result = await harness.resetComposer();
  assert.equal(result.attachmentObserved, true);
  assert.equal(result.clean, true);
  assert.equal(attached, false);
});

test("an attachment that remains after removal is not reported clean", async () => {
  const harness = createHarness({ advanceTimers: true });
  const attachment = element("visible-attachment", "Pasted Text");
  const remove = element("remove-attachment");
  (remove as any).click = () => {};
  const composerRoot = {
    querySelectorAll(selector: string) {
      if (selector === '[data-composer-attachments][data-visible-attachments]') {
        return [attachment];
      }
      if (selector === '[data-composer-attachments] button[aria-label^="\u79fb\u9664 "]') {
        return [remove];
      }
      return [];
    },
  };
  (harness.state.input as any).closest = () => composerRoot;

  const result = await harness.resetComposer();
  assert.equal(result.attachmentObserved, true);
  assert.equal(result.clean, false);
});

test("discovery extracts visible Project entry IDs and names, excluding chats and off-site links", async () => {
  const h = createHarness();
  h.state.readyState = "complete";
  const id = "g-p-" + "c".repeat(32);
  const link = (href: string, name: string, hidden = false, message = false) => {
    const e = element("link", name);
    e.getAttribute = attr => attr === "href" ? href : null;
    e.getBoundingClientRect = () => ({ width: hidden ? 0 : 100, height: 30 });
    e.closest = () => message ? element("chat-message") : null;
    return e;
  };
  h.state.projectLinks = [link(`/g/${id}/project`, " My   Project "),
    link(`/g/${id}/c/conversation`, "Chat title"), link(`https://evil.test/g/${id}/project`, "Fake"),
    link(`/g/${id}/project`, "Hidden", true), link(`/g/${id}/project`, "Pasted link", false, true),
    link(`/g/${id}/project`, "")];
  const result = await h.message({ type: "discover-projects" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.projects)), [{ projectId: id, name: "My Project", href: `https://chatgpt.com/g/${id}/project` }]);
  h.state.readyState = "loading";
  assert.equal((await h.message({ type: "discover-projects" })).error, "page_not_loaded");
});

test("discovery supports modern sidebar rows with matching visible labels", async () => {
  const h = createHarness(); h.state.readyState = "complete";
  const id = "g-p-" + "e".repeat(32);
  const row = element("project-row");
  row.closest = () => null;
  row.getAttribute = attr => attr === "data-app-action-sidebar-project-id" ? id : attr === "data-app-action-sidebar-project-label" ? "cgcon" : null;
  row.querySelector = () => element("label", "cgcon");
  h.state.projectRows = [row];
  assert.deepEqual(JSON.parse(JSON.stringify((await h.message({ type: "discover-projects" })).projects)),
    [{ projectId: id, name: "cgcon", href: `https://chatgpt.com/g/${id}/project`, kind: "sidebar-row" }]);
  row.querySelector = () => element("label", "Other name");
  assert.deepEqual(JSON.parse(JSON.stringify((await h.message({ type: "discover-projects" })).projects)), []);
});

for (const payload of ["text", "attachment", "upload"] as const) {
  for (const timing of ["idle", "after-preflight", "hydration", "before-paste"] as const) {
    test(`existing draft is preserved: ${payload}, ${timing}`, async () => {
      const h = createHarness({ advanceTimers: true });
      h.state.readyState = "complete";
      h.state.users = [element("old-user", "history")];
      const input = h.state.input as any;
      input.isConnected = true;
      input.focus = () => {};
      let mutations = 0;
      let attachments: FakeElement[] = [];
      let progress: FakeElement[] = [];
      input.dispatchEvent = () => { mutations++; };
      input.removeChild = () => { mutations++; input.textContent = ""; };
      const root = { querySelectorAll: (selector: string) => {
        if (selector === '[data-composer-attachments][data-visible-attachments]') return attachments;
        if (selector === '[role="progressbar"]') return progress;
        return [];
      } };
      input.closest = () => root;
      const populate = () => {
        if (payload === "text") input.textContent = "EXISTING HUMAN DRAFT";
        if (payload === "attachment") attachments = [element("private-file", "Private file")];
        if (payload === "upload") progress = [element("upload", "Uploading")];
      };
      if (timing === "idle") populate();
      await h.pageState(); h.state.now += 5000;
      const preflight = await h.pageState();
      assert.equal(preflight.ready, timing !== "idle");
      if (timing === "after-preflight") populate();
      if (timing === "hydration") {
        h.state.readyState = "loading";
        h.state.onTimer = () => { populate(); h.state.readyState = "complete"; h.state.onTimer = null; };
      }
      if (timing === "before-paste") input.focus = populate;
      const result = await h.message({ type: "run-task", taskId: "new-task", text: "RELAY PROMPT",
        expectedSession: await h.sessionId() });
      assert.equal(result.errorCode, "composer_not_clean");
      assert.equal(result.submissionState, "not-submitted");
      assert.equal(mutations, 0);
      if (payload === "text") assert.equal(input.textContent, "EXISTING HUMAN DRAFT");
      if (payload === "attachment") assert.equal(attachments[0]?.textContent, "Private file");
      if (payload === "upload") assert.equal(progress.length, 1);
      assert.equal((await h.pageState()).ready, false);
      if (timing === "idle" || timing === "after-preflight") {
        assert.equal((await h.message({ type: "get-inflight" })).inflight, null);
      }
      input.textContent = ""; attachments = []; progress = [];
      await h.pageState(); h.state.now += 5000;
      assert.equal((await h.pageState()).ready, true);
    });
  }
}

for (const scenario of ["unchanged", "attachment-unchanged", "delayed-user", "wrong-session", "navigation", "remount", "edit", "attachment", "delayed-navigation", "disabled-send", "replaced-send"] as const) {
  test(`submission stays bound to its session, composer and payload: ${scenario}`, async () => {
    const h = createHarness({ advanceTimers: true });
    h.state.readyState = "complete";
    h.state.users = [element("user-A", "old prompt")];
    h.state.assistants = [element("assistant-A", "old answer")];
    const input = h.state.input as any;
    input.isConnected = true;
    input.focus = () => {};
    const attachment = element("attachment", "Pasted text");
    let attachments: FakeElement[] = [];
    input.dispatchEvent = (event: any) => {
      if (event.type === "paste") {
        input.textContent = scenario.startsWith("attachment") ? "" : event.clipboardData.value;
        if (scenario.startsWith("attachment")) attachments = [attachment];
      }
    };
    const clicks: string[] = [];
    let send = element("send-A") as any;
    send.click = () => {
      clicks.push("A");
      if (scenario === "delayed-user") h.state.stopButtons = [element("stop")];
      else h.state.users.push(element("user-new", "prompt"));
    };
    const root = { querySelectorAll: (selector: string) => {
      if (selector === 'button[type="submit"]' && (input.textContent || attachments.length)) return [send];
      if (selector === '[data-composer-attachments][data-visible-attachments]') return attachments;
      return [];
    } };
    input.closest = () => root;
    const replacement = element("input-B", "private draft") as any;
    replacement.isConnected = true;
    const otherSend = element("send-B") as any;
    otherSend.click = () => clicks.push("B");
    const otherRoot = { querySelectorAll: (selector: string) => selector === 'button[type="submit"]' ? [otherSend] : [] };
    replacement.closest = () => otherRoot;
    const navigate = () => {
      h.state.pathname = "/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      h.state.input = replacement;
    };
    h.state.onSendMessage = message => {
      if (message.type !== "send-attempted") return null;
      if (scenario === "navigation") navigate();
      if (scenario === "remount") h.state.input = replacement;
      if (scenario === "edit") input.textContent = "edited by user";
      if (scenario === "attachment") attachments = [element("replacement-attachment", "Other file")];
      if (["delayed-navigation", "disabled-send", "replaced-send"].includes(scenario)) {
        h.state.onTimer = () => {
          h.state.onTimer = null;
          if (scenario === "delayed-navigation") navigate();
          if (scenario === "disabled-send") send.disabled = true;
          if (scenario === "replaced-send") send = otherSend;
        };
      }
      return { status: "fenced" };
    };
    const result = await h.message({ type: "run-task", taskId: "task-A", text: "intended prompt",
      expectedSession: scenario === "wrong-session" ? "different-session" : await h.sessionId() });
    if (scenario === "unchanged" || scenario === "attachment-unchanged" || scenario === "delayed-user") {
      assert.deepEqual(clicks, ["A"]);
      assert.equal(result.status, "submitted");
      if (scenario === "delayed-user") {
        assert.equal(result.submittedUserMessageId, null);
        h.state.users.push(element("user-new", "prompt"));
        const learned = await h.message({ type: "poll-reply", taskId: "task-A", baseline: result.baseline,
          expectedSession: await h.sessionId() });
        assert.equal(learned.submittedUserMessageId, "user-new");
        assert.equal((await h.message({ type: "get-inflight" }) as any).inflight.submittedUserMessageId, "user-new");
      }
      const stop = element('stop') as any;
      stop.closest = (selector:string)=>selector.includes('stop-button')?stop:null;
      h.userEvent('click',stop);
      const stopped = (await h.message({type:'get-inflight'}) as any).inflight;
      assert.ok(stopped.stopRequestedAt);
      assert.equal(stopped.submittedUserMessageId,'user-new');
      const snapshot=await h.message({type:'poll-reply',taskId:'task-A',baseline:result.baseline,
        expectedSession:await h.sessionId(),submittedUserMessageId:'user-new'});
      assert.equal(snapshot.stopRequestedAt,stopped.stopRequestedAt);
      assert.equal((await h.message({type:'poll-reply',taskId:'other-task',baseline:result.baseline})).stopRequestedAt,undefined);
      for (const stale of [{}, {taskId:'old-task',expectedSession:await h.sessionId()},
          {taskId:'task-A',expectedSession:'old-session'}]) {
        assert.equal((await h.message({type:'clear-inflight',...stale})).cleared,false);
        assert.equal((await h.message({type:'get-inflight'}) as any).inflight.taskId,'task-A');
      }
      assert.equal((await h.message({type:'clear-inflight',taskId:'task-A',expectedSession:await h.sessionId()})).cleared,true);
      assert.equal((await h.message({type:'get-inflight'})).inflight,null);
    } else {
      assert.deepEqual(clicks, []);
      assert.match(String(result.errorCode), /^submission_(target|payload)_changed$/);
      const lateCleanup = await h.message({ type: "reset-composer", expectedSession: await h.sessionId(), taskId: "task-A" });
      assert.equal(lateCleanup.clean, false, "delayed worker cleanup must preserve a changed composer");
      assert.equal(replacement.textContent, "private draft", "failure cleanup must not touch a foreign composer");
      if (scenario === "edit") assert.equal(input.textContent, "edited by user");
      if (scenario === "attachment") assert.equal(attachments[0]?.textContent, "Other file");
      if (scenario === "wrong-session") assert.equal(input.textContent, "", "reject before injection");
    }
  });
}

for (const scenario of ['early-edit', 'upload-edit', 'upload-remove', 'upload-file-change', 'normal-upload', 'normal-multiline'] as const) {
  test(`preparation preserves user ownership: ${scenario}`, async () => {
    const h = createHarness({advanceTimers:true});
    h.state.readyState = 'complete';
    h.state.users = [element('old-user','old prompt')];
    const input = h.state.input as any;
    input.isConnected = true; input.focus = () => {};
    const isUpload = scenario.includes('upload');
    const text = isUpload ? 'x'.repeat(25000) : 'authorized\nmultiline prompt';
    let attachments: FakeElement[] = [];
    let uploading = false;
    const send = element('send') as any;
    const sent: string[] = [];
    send.click = () => { sent.push(input.textContent); h.state.users.push(element('new-user',text)); };
    const root = {contains:(node: any)=>node===input||node===remove, querySelectorAll:(selector:string) => {
      if (selector === 'button[type="submit"]' && !uploading && (input.textContent||attachments.length)) return [send];
      if (selector === '[data-composer-attachments][data-visible-attachments]') return attachments;
      if (selector === '[role="progressbar"]' && uploading) return [element('progress')];
      return [];
    }};
    const remove = {closest:()=>remove};
    input.closest = () => root;
    input.dispatchEvent = (event:any) => {
      if (event.type !== 'paste') return;
      input.textContent = isUpload ? '' : text.replace(/\n/g,'');
      if (isUpload) { attachments=[element('file','Uploading')]; uploading=true; }
      let ticks=0;
      h.state.onTimer = () => {
        ticks++;
        if (scenario==='early-edit') input.textContent='private draft';
        if (ticks===2 && scenario==='upload-edit') {
          h.userEvent('beforeinput',input); input.textContent='private draft';
        }
        if (ticks===2 && scenario==='upload-remove') {
          h.userEvent('click',remove); attachments=[element('replacement','Private file')];
        }
        if (ticks===2 && scenario==='upload-file-change') {
          h.userEvent('change',{type:'file',files:[{}]}); attachments=[element('replacement','Private file')];
        }
        if (ticks>=3 || !isUpload) {
          uploading=false;
          if (scenario==='normal-upload') attachments=[element('ready-file','Pasted text')];
          h.state.onTimer=null;
        }
      };
    };
    h.state.onSendMessage = msg => msg.type==='send-attempted'?{status:'fenced'}:null;
    const session = await h.sessionId();
    const result = await h.message({type:'run-task',taskId:'task',text,expectedSession:session});
    if (scenario.startsWith('normal')) {
      assert.equal(result.status,'submitted'); assert.equal(sent.length,1);
    } else {
      assert.equal(sent.length,0);
      assert.equal(result.errorCode,'submission_payload_changed');
      assert.equal((await h.message({type:'reset-composer',expectedSession:session,taskId:'task'})).clean,false);
      if (scenario.endsWith('edit')) assert.equal(input.textContent,'private draft');
      else assert.equal(attachments[0]?.textContent,'Private file');
      assert.equal((await h.pageState()).ready,false,'queued successors must not erase the preserved draft');
    }
  });
}

for (const modern of [false, true]) {
  for (const scenario of ["normal", "history-only", "user-unmounted", "reply-before-user", "later-turn", "later-turn-user-unmounted", "missing-anchor", "initial-chat", "missing-id"] as const) {
    test(`reply attribution (${modern ? "modern" : "legacy"}): ${scenario}`, async () => {
      const h = createHarness(); h.state.readyState = "complete";
      const make = (role: "user" | "assistant", id: string, text: string, turn: number) => modern
        ? modernMessage(role, id, text, `fallback-turn-${turn}:${role === "user" ? 0 : 1}:${role}`)
        : { unit: element(id, text), marker: element("unused") };
      const oldUser = make("user", "old-user", "old prompt", 0);
      const oldReply = make("assistant", "old-reply", "OLD ANSWER", 0);
      const anchorUser = make("user", "anchor-user", "anchor prompt", 1);
      const anchorReply = make("assistant", "anchor-reply", "anchor answer", 1);
      const mount = (users: typeof oldUser[], replies: typeof oldReply[]) => {
        if (modern) { h.state.modernUserBubbles = users.map(x => x.marker); h.state.modernAssistantHeadings = replies.map(x => x.marker); }
        else { h.state.users = users.map(x => x.unit); h.state.assistants = replies.map(x => x.unit); }
      };
      mount([oldUser, anchorUser], [oldReply, anchorReply]);
      await h.pageState(); h.state.now += 4000;
      let baseline = (await h.pageState()).baseline;
      const submitted = make("user", "submitted-user", "new prompt", 2);
      const answer = make("assistant", "new-reply", "NEW ANSWER", 2);
      const laterUser = make("user", "later-user", "later prompt", 3);
      const laterReply = make("assistant", "later-reply", "WRONG LATER ANSWER", 3);
      let expectedId: string | null = "submitted-user";
      mount([oldUser, anchorUser, submitted], [oldReply, anchorReply, answer]);
      if (scenario === "history-only") mount([oldUser], [oldReply]);
      if (scenario === "user-unmounted") mount([oldUser], [oldReply, answer]);
      if (scenario === "reply-before-user") { answer.unit.order = submitted.unit.order - 0.5; }
      if (scenario === "later-turn") mount([oldUser, anchorUser, submitted, laterUser], [oldReply, anchorReply, laterReply]);
      if (scenario === "later-turn-user-unmounted") {
        if (!modern) return; // Modern grouping metadata provides this extra evidence.
        mount([submitted], [laterReply]);
      }
      if (scenario === "missing-anchor") { expectedId = null; mount([submitted], [answer]); }
      if (scenario === "initial-chat") {
        baseline = { userCount: 0, assistantCount: 0, userIds: [], assistantIds: [] };
        expectedId = null; mount([submitted], [answer]);
      }
      if (scenario === "missing-id") {
        answer.unit.getAttribute = () => null;
        answer.unit.querySelectorAll = () => [];
        answer.unit.closest = () => null;
      }
      await h.pageState(); h.state.now += 4000;
      const result = await h.message({ type: "poll-reply", baseline, submittedUserMessageId: expectedId });
      if (scenario === "normal" || scenario === "initial-chat") {
        assert.equal(result.status, "reply-ready"); assert.equal(result.reply, "NEW ANSWER");
        assert.equal(result.assistantMessageId, "new-reply");
        assert.equal(result.submittedUserMessageId, "submitted-user");
      } else {
        assert.notEqual(result.status, "reply-ready");
      }
      if (scenario === "user-unmounted") {
        mount([submitted], [answer]);
        await h.pageState(); h.state.now += 4000;
        assert.equal((await h.message({ type: "poll-reply", baseline, submittedUserMessageId: expectedId })).reply, "NEW ANSWER");
      }
    });
  }
}

test("real UUIDs survive positional rekeys and mixed legacy/modern wrappers", async () => {
  const h = createHarness(); h.state.readyState = "complete";
  const user = modernMessage("user", "user-uuid", "prompt", "fallback-turn-0:0:user");
  const answer = modernMessage("assistant", "answer-uuid", "answer", "fallback-turn-0:1:assistant");
  h.state.modernUserBubbles = [user.marker, user.marker];
  h.state.modernAssistantHeadings = [answer.marker, answer.marker];
  const legacyAnswer = element("answer-uuid", "answer"); legacyAnswer.order = answer.unit.order;
  legacyAnswer.closest = selector => selector === '[data-content-search-unit-key]' ? answer.unit : null;
  h.state.assistants = [legacyAnswer];
  await h.pageState(); h.state.now += 4000;
  const baseline = (await h.pageState()).baseline as any;
  assert.equal(baseline.userCount, 1); assert.equal(baseline.assistantCount, 1);
  assert.equal(baseline.lastUserId, "user-uuid"); assert.equal(baseline.lastAssistantId, "answer-uuid");
  answer.unit.getAttribute = name => name === "data-content-search-unit-key" ? "fallback-turn-0:3:assistant" : null;
  h.state.assistants = [];
  await h.pageState(); h.state.now += 4000;
  assert.notEqual((await h.pollReply(baseline)).status, "reply-ready");
  assert.equal(((await h.pageState()).baseline as any).lastAssistantId, "answer-uuid");
});

for (const ancestor of ["data-content-search-unit-key", "data-chatgpt-selection-message-id", "data-chatgpt-search-message-ids", "data-message-author-role", "data-user-message-bubble"]) {
  test(`project discovery excludes message content under ${ancestor}`, async () => {
    const h = createHarness(); h.state.readyState = "complete";
    const id = "g-p-" + "f".repeat(32);
    const message = element("message");
    const replyLink = element("reply-link", "Wrong name from a reply");
    replyLink.getAttribute = name => name === "href" ? `/g/${id}/project` : null;
    replyLink.closest = selector => selector.includes(`[${ancestor}]`) ? message : null;
    const replyRow = element("reply-row");
    replyRow.getAttribute = name => name === "data-app-action-sidebar-project-id" ? id :
      name === "data-app-action-sidebar-project-label" ? "Wrong name from a reply" : null;
    replyRow.querySelector = () => element("label", "Wrong name from a reply");
    replyRow.closest = replyLink.closest;
    const breadcrumb = element("breadcrumb", "Real Project");
    breadcrumb.getAttribute = name => name === "href" ? `/g/${id}/project` : null;
    breadcrumb.closest = () => null;
    const sidebar = element("sidebar-row");
    sidebar.getAttribute = name => name === "data-app-action-sidebar-project-id" ? id :
      name === "data-app-action-sidebar-project-label" ? "Real Project" : null;
    sidebar.querySelector = () => element("label", "Real Project");
    sidebar.closest = () => null;
    h.state.projectLinks = [replyLink, breadcrumb]; h.state.projectRows = [replyRow, sidebar];
    const projects = (await h.message({ type: "discover-projects" })).projects as any[];
    assert.equal(projects.length, 2, "keep both real navigation entries");
    assert.ok(projects.every(project => project.name === "Real Project" && project.projectId === id));
  });
}

function createAttachmentDomHarness() {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "chatgpt-attachment-turn.html"), "utf8");
  const h = createHarness({ html });
  h.state.readyState = "complete";
  const doc = h.dom!.document;
  const main = doc.querySelector("main")!;
  const history = doc.getElementById("history-turn")!;
  const turn = doc.getElementById("attachment-turn")!;
  const user = doc.getElementById("attachment-user")!;
  const reply = doc.getElementById("attachment-reply")!;
  turn.remove();
  return { h, doc, main, history, turn, user, reply };
}

async function settledPage(h: ReturnType<typeof createHarness>) {
  await h.pageState();
  h.state.now += 4000;
  return h.pageState();
}

for (const kind of ["pasted-text", "file", "image", "mixed-text-and-file"]) {
  test(`parsed attachment DOM supports reply capture and recovery: ${kind}`, async () => {
    const { h, main, history, turn, user, reply } = createAttachmentDomHarness();
    const baseline = (await settledPage(h)).baseline as Record<string, unknown>;
    assert.equal(baseline.userCount, 1);
    if (kind === "file") user.innerHTML = '<div><button aria-label="document.pdf">document.pdf</button></div>';
    if (kind === "image") user.innerHTML = '<div><img alt="Uploaded image"></div>';
    if (kind === "mixed-text-and-file") {
      user.insertAdjacentHTML("beforeend", '<div data-content-search-unit-key="fallback-turn-1:0:user"><div data-user-message-bubble>Read the attachment</div></div>');
    } else {
      assert.equal(user.querySelector('[data-user-message-bubble], [data-content-search-unit-key]'), null);
      assert.equal(user.hasAttribute("data-content-search-unit-key"), false);
    }
    main.append(turn);
    const page = await settledPage(h);
    assert.equal((page.baseline as any).userCount, 2, "count inner and outer wrappers only once");
    assert.equal((page.baseline as any).lastUserId, "attachment-user");
    const result = await h.pollReply(baseline);
    assert.equal(result.status, "reply-ready");
    assert.equal(result.reply, "ATTACHMENT_OK");
    assert.equal(result.assistantMessageId, "attachment-reply");
    assert.equal(result.submittedUserMessageId, "attachment-user");

    // Virtual scrolling removes the original anchor and rekeys the remaining turn.
    history.remove();
    for (const node of [turn, ...turn.querySelectorAll("*")]) {
      for (const attr of ["data-content-search-unit-key", "data-chatgpt-search-unit-key", "data-content-search-turn-key"]) {
        const key = node.getAttribute(attr);
        if (key) node.setAttribute(attr, key.replace("fallback-turn-1", "fallback-turn-0"));
      }
    }
    // Duplicate copies of the same UUID are one identity, as in the actual assistant wrapper.
    user.setAttribute("data-chatgpt-search-message-ids", "attachment-user attachment-user");
    await settledPage(h);
    const recovered = await h.message({ type: "poll-reply", baseline, submittedUserMessageId: "attachment-user" });
    assert.equal(recovered.reply, "ATTACHMENT_OK");
    assert.equal(recovered.assistantMessageId, "attachment-reply");
    assert.equal(reply.getAttribute("data-content-search-unit-key"), "fallback-turn-0:2:assistant");
  });
}

for (const scenario of ["user-unmounted", "missing-anchor", "missing-id", "ambiguous-id", "later-turn", "later-user-unmounted"] as const) {
  test(`parsed attachment DOM preserves reply attribution: ${scenario}`, async () => {
    const { h, main, history, turn, user, reply } = createAttachmentDomHarness();
    const baseline = (await settledPage(h)).baseline;
    main.append(turn);
    let expectedId: string | null = "attachment-user";
    if (scenario === "user-unmounted") user.remove();
    if (scenario === "missing-anchor") { history.remove(); expectedId = null; }
    if (scenario === "missing-id") user.removeAttribute("data-chatgpt-search-message-ids");
    if (scenario === "ambiguous-id") user.setAttribute("data-chatgpt-search-message-ids", "attachment-user other-user");
    if (scenario === "later-turn" || scenario === "later-user-unmounted") {
      const later = turn.cloneNode(true) as typeof turn;
      for (const node of [later, ...later.querySelectorAll("*")]) {
        for (const attr of ["id", "data-content-search-unit-key", "data-chatgpt-search-unit-key", "data-chatgpt-search-message-ids", "data-chatgpt-selection-message-id"]) {
          const value = node.getAttribute(attr);
          if (value) node.setAttribute(attr, value.replaceAll("attachment-", "later-").replaceAll("fallback-turn-1", "fallback-turn-2"));
        }
      }
      if (scenario === "later-user-unmounted") later.querySelector("#later-user")!.remove();
      main.append(later);
      reply.remove();
    }
    await settledPage(h);
    const result = await h.message({ type: "poll-reply", baseline, submittedUserMessageId: expectedId });
    assert.notEqual(result.status, "reply-ready");
    if (scenario === "user-unmounted") {
      turn.prepend(user);
      await settledPage(h);
      assert.equal((await h.message({ type: "poll-reply", baseline, submittedUserMessageId: expectedId })).reply, "ATTACHMENT_OK");
    }
  });
}

test("a parsed attachment-only first turn satisfies conversation hydration", async () => {
  const { h, main, history, turn, reply } = createAttachmentDomHarness();
  history.remove(); reply.remove(); main.append(turn);
  const page = await settledPage(h);
  assert.equal(page.ready, true);
  assert.equal((page.baseline as any).lastUserId, "attachment-user");
});

function newSessionDraftHarness(projectId: string | null = null) {
  const managed = {sessionRef:'sr_new',owner:'browser',token:'creation-token',initialTaskId:'first-task',projectId};
  const h = createHarness({advanceTimers:true,managed});
  h.state.pathname = projectId ? `/g/${projectId}/project` : '/';
  h.state.readyState = 'complete';
  const input = h.state.input as any;
  input.isConnected = true;
  input.textContent = 'CACHED OLD PROMPT';
  input.focus = () => {};
  let removals = 0;
  const savedDrafts: string[] = [], sentPrompts: string[] = [];
  const attachments: FakeElement[] = [], uploads: FakeElement[] = [];
  Object.defineProperty(input, 'firstChild', {get:() => input.textContent ? {} : null});
  input.removeChild = () => { removals++; input.textContent = ''; };
  input.dispatchEvent = (event: any) => {
    if (event.type === 'paste') input.textContent = event.clipboardData.value;
    if (event.type === 'input') savedDrafts.push(input.textContent);
  };
  const send = element('send') as any;
  send.click = () => {
    sentPrompts.push(input.textContent);
    input.textContent = '';
    h.state.users.push(element('new-user', sentPrompts.at(-1)));
  };
  const root = {
    contains:(node: unknown) => node === input,
    querySelectorAll:(selector: string) => {
      if (selector === '[data-testid="send-button"]' && input.textContent) return [send];
      if (selector === '[data-composer-attachments][data-visible-attachments]') return attachments;
      if (selector === '[role="progressbar"]') return uploads;
      return [];
    },
  };
  input.closest = () => root;
  h.state.onSendMessage = msg => msg.type === 'send-attempted' ? {status:'fenced'} : null;
  return {...h,input,attachments,uploads,savedDrafts,sentPrompts,removals:() => removals,
    async request() {
      await h.pageState(); h.state.now += 5000;
      const page = await h.pageState();
      return {type:'run-task',taskId:'first-task',text:'FRESH PROMPT',expectedSession:managed.sessionRef,
        initializeComposer:{token:managed.token,documentId:page.documentId}};
    }};
}

for (const project of [null, 'g-p-' + 'a'.repeat(32)]) {
  test(`owned new session clears restored text through the editor and sends only its first prompt: ${project}`, async () => {
    const h = newSessionDraftHarness(project);
    const request = await h.request();
    assert.equal((await h.pageState()).ready, false);
    assert.equal((await h.pageState()).observationReady, true);
    const result = await h.message(request);
    assert.equal(result.status, 'submitted');
    assert.equal(h.savedDrafts[0], '', 'deletion must notify the editor, not only remove DOM text');
    assert.deepEqual(h.sentPrompts, ['FRESH PROMPT']);
    assert.equal(h.removals(), 1);
    assert.equal((await h.message(request)).errorCode, 'new_session_initialization_blocked');
    assert.deepEqual(h.sentPrompts, ['FRESH PROMPT'], 'initialization cannot replay a sent first task');
  });
}

for (const scenario of ['wrong-task','wrong-token','wrong-document','history','existing-conversation',
  'prior-send','user-before-dispatch','user-on-focus','user-during-reset','restored-again','restored-before-paste','attachment','upload'] as const) {
  test(`new session initialization preserves protected payloads and never sends: ${scenario}`, async () => {
    const h = newSessionDraftHarness();
    const request = await h.request();
    if (scenario === 'wrong-task') request.taskId = 'other-task';
    if (scenario === 'wrong-token') request.initializeComposer.token = 'other-token';
    if (scenario === 'wrong-document') request.initializeComposer.documentId = 'other-document';
    if (scenario === 'history') h.state.users.push(element('old-user', 'old prompt'));
    if (scenario === 'existing-conversation') h.state.pathname = '/c/6a61e3cc-3160-83ee-9aa7-f79a39d93b3e';
    if (scenario === 'prior-send') h.seedInflight({taskId:'first-task',session:'sr_new',phase:'send-fenced'});
    const userEdit = () => { h.input.textContent = 'HUMAN DRAFT'; h.userEvent('input', h.input); };
    if (scenario === 'user-before-dispatch') userEdit();
    if (scenario === 'user-on-focus') h.input.focus = userEdit;
    if (scenario === 'restored-before-paste') {
      let focuses = 0;
      h.input.focus = () => { if (++focuses === 2) h.input.textContent = 'RESTORED AGAIN'; };
    }
    if (scenario === 'user-during-reset' || scenario === 'restored-again') h.state.onTimer = () => {
      h.state.onTimer = null;
      if (scenario === 'user-during-reset') userEdit();
      else h.input.textContent = 'RESTORED AGAIN';
    };
    if (scenario === 'attachment') h.attachments.push(element('file', 'Private file'));
    if (scenario === 'upload') h.uploads.push(element('upload', 'Uploading'));
    const result = await h.message(request);
    assert.equal(result.submissionState, 'not-submitted');
    assert.deepEqual(h.sentPrompts, []);
    if (scenario === 'restored-again' || scenario === 'restored-before-paste') {
      assert.equal(result.errorCode, 'new_session_initialization_failed');
      assert.equal(h.input.textContent, 'RESTORED AGAIN');
    } else if (scenario.startsWith('user-')) {
      assert.equal(h.input.textContent, 'HUMAN DRAFT');
    } else {
      assert.equal(result.errorCode, 'new_session_initialization_blocked');
      assert.equal(h.input.textContent, 'CACHED OLD PROMPT');
    }
    assert.equal(h.removals(), ['user-during-reset','restored-again','restored-before-paste'].includes(scenario) ? 1 : 0);
  });
}
