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
  isConnected: boolean;
  style: Record<string, string>;
  textContent: string;
  innerText: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  closest?(selector: string): FakeElement | null;
  querySelector?(selector: string): FakeElement | null;
  querySelectorAll?(selector: string): FakeElement[];
};

function element(id: string, text = ""): FakeElement {
  return {
    id,
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
  };
}

function createHarness() {
  const state = {
    now: 10_000,
    readyState: "loading",
    input: element("input-1") as FakeElement | null,
    users: [] as FakeElement[],
    assistants: [] as FakeElement[],
    modernUserBubbles: [] as FakeElement[],
    modernAssistantHeadings: [] as FakeElement[],
    unrelatedSendButtons: [] as FakeElement[],
    stopButtons: [] as FakeElement[],
    pathname: "/c/6a61e3cc-3160-83ee-9aa7-f79a39d93b3e",
    helloAcknowledged: true,
  };
  const storage = new Map<string, string>();
  const sentMessages: unknown[] = [];
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
    addEventListener() {},
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-message-author-role="user"]') return state.users;
      if (selector === '[data-message-author-role="assistant"]') return state.assistants;
      if (selector === '[data-user-message-bubble]') return state.modernUserBubbles;
      if (selector === '[data-conversation-role="assistant"]') return state.modernAssistantHeadings;
      if (selector === '[data-testid="send-button"]') return state.unrelatedSendButtons;
      if (selector === '[data-testid="stop-button"]') return state.stopButtons;
      if (selector === "#prompt-textarea") return state.input ? [state.input] : [];
      return [];
    },
  };
  const location = {
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
        return state.helloAcknowledged ? { status: "ok" } : { error: "worker unavailable" };
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
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    Date: FakeDate,
    Math,
    JSON,
    Promise,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
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
    async pageState() {
      return new Promise<Record<string, unknown>>((resolve) => {
        onMessage?.({ type: "get-page-state" }, {}, (value) => {
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

function modernMessage(role: "user" | "assistant", id: string, text: string) {
  const unit = element(id, role === "assistant" ? `Assistant${text}` : text);
  unit.getAttribute = (name: string) =>
    name === "data-content-search-unit-key" ? id : null;
  const marker = element(`${id}-marker`);
  marker.closest = (selector: string) =>
    selector === "[data-content-search-unit-key]" ? unit : null;
  if (role === "assistant") {
    const content = element(`${id}-content`, text);
    unit.querySelector = (selector: string) =>
      selector === "[data-chatgpt-selection-message-id]" ? content : null;
  }
  return { unit, marker };
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
  harness.state.users = [element("user-2", "new prompt")];
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
