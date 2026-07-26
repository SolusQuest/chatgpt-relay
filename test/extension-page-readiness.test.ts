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
  };
  const storage = new Map<string, string>();
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
      if (selector === "#prompt-textarea") return state.input ? [state.input] : [];
      return [];
    },
  };
  const location = {
    pathname: "/c/6a61e3cc-3160-83ee-9aa7-f79a39d93b3e",
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
      sendMessage: async () => ({ status: "ok" }),
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
    setInterval: () => 0,
    clearTimeout() {},
    clearInterval() {},
  });

  assert.ok(onMessage, "content script did not register onMessage");
  return {
    state,
    async pageState() {
      return new Promise<Record<string, unknown>>((resolve) => {
        onMessage?.({ type: "get-page-state" }, {}, (value) => {
          resolve(value as Record<string, unknown>);
        });
      });
    },
  };
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
