import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

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

function createHarness({ advanceTimers = false, managed = null as null | Record<string, unknown> } = {}) {
  const state = {
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
  const document = {
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
  const location = {
    get hash() { return state.hash; },
    get pathname() {
      return state.pathname;
    },
    reload() {},
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
    Element: class {},
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

test("managed creation retains its ref after first navigation and rejects later conversation changes", async () => {
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
  assert.equal((await h.pageState()).reason, "creation-route-mismatch");
  assert.notEqual(await h.sessionId(), "sr_test");
});

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

for (const scenario of ["unchanged", "attachment-unchanged", "wrong-session", "navigation", "remount", "edit", "attachment", "delayed-navigation", "disabled-send", "replaced-send"] as const) {
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
    send.click = () => { clicks.push("A"); h.state.users.push(element("user-new", "prompt")); };
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
    if (scenario === "unchanged" || scenario === "attachment-unchanged") {
      assert.deepEqual(clicks, ["A"]);
      assert.equal(result.status, "submitted");
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

for (const kind of ["pasted-text", "file", "image", "mixed-text-and-file"]) {
  test(`attachment-only user identity supports reply capture and recovery: ${kind}`, async () => {
    const h = createHarness(); h.state.readyState = "complete";
    const oldUser = modernMessage("user", "previous-user", "old text", "fallback-turn-0:0:user");
    const oldReply = modernMessage("assistant", "previous-reply", "old reply", "fallback-turn-0:1:assistant");
    h.state.modernUserBubbles = [oldUser.marker]; h.state.modernUserUnits = [oldUser.unit];
    h.state.modernAssistantHeadings = [oldReply.marker];
    await h.pageState(); h.state.now += 4000;
    const baseline = (await h.pageState()).baseline as any;
    const attachment = modernMessage("user", "attachment-user", kind, "fallback-turn-1:0:user");
    const reply = modernMessage("assistant", "attachment-reply", "ATTACHMENT_OK", "fallback-turn-1:2:assistant");
    h.state.modernUserUnits.push(attachment.unit);
    if (kind === "mixed-text-and-file") h.state.modernUserBubbles.push(attachment.marker);
    h.state.modernAssistantHeadings.push(reply.marker);
    await h.pageState(); h.state.now += 4000;
    const page = await h.pageState();
    assert.equal((page.baseline as any).userCount, 2, "each message counted once, even with both markers");
    assert.equal((page.baseline as any).lastUserId, "attachment-user");
    const result = await h.pollReply(baseline);
    assert.equal(result.status, "reply-ready"); assert.equal(result.reply, "ATTACHMENT_OK");
    assert.equal(result.submittedUserMessageId, "attachment-user");
    h.state.modernUserBubbles = []; h.state.modernUserUnits = [attachment.unit];
    h.state.modernAssistantHeadings = [reply.marker];
    await h.pageState(); h.state.now += 4000;
    assert.equal((await h.message({ type: "poll-reply", baseline, submittedUserMessageId: "attachment-user" })).reply, "ATTACHMENT_OK");
  });
}

test("an attachment-only first turn satisfies conversation hydration", async () => {
  const h = createHarness(); h.state.readyState = "complete";
  const attachment = modernMessage("user", "first-attachment", "file", "fallback-turn-0:0:user");
  h.state.modernUserUnits = [attachment.unit];
  await h.pageState(); h.state.now += 4000;
  assert.equal((await h.pageState()).ready, true);
});
