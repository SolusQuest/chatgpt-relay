import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";

const source = fs.readFileSync(new URL("../extension/status-widget.js", import.meta.url), "utf8");

function harness(saved?: string, storageFails = false) {
  const window = new Window({ width: 900, height: 700 });
  const values = new Map(saved ? [["gpt_relay_widget_position_v1", saved]] : []);
  const storage = {
    getItem: (key: string) => { if (storageFails) throw new Error("disabled"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (storageFails) throw new Error("disabled"); values.set(key, value); },
  };
  const context = vm.createContext({ document: window.document, window, storage });
  vm.runInContext(source, context);
  const widget = vm.runInContext("GptRelayStatus.create({document,window,storage})", context);
  const host = window.document.querySelector("#gpt-relay-status")!;
  const shadow = host.shadowRoot!;
  const orb = shadow.querySelector(".orb")!;
  const panel = shadow.querySelector(".panel")!;
  const pointer = (type: string, x: number, y: number, id = 1) => orb.dispatchEvent(
    new window.PointerEvent(type, { pointerId: id, isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true }),
  );
  const click = (detail = 1) => orb.dispatchEvent(new window.MouseEvent("click", { detail, bubbles: true, composed: true }));
  const position = () => ({ x: parseFloat((host as any).style.left), y: parseFloat((host as any).style.top) });
  return { window, widget, host, shadow, orb, panel, pointer, click, position, values };
}

test("widget updates safely inside its shadow tree and supports click, outside click and Escape", async () => {
  const h = harness();
  try {
    assert.equal((h.panel as any).hidden, true);
    assert.equal(h.window.document.querySelector(".status"), null);
    h.widget.update("Waiting for reply: <img src=x>", "#3498db", { session: "sr_test", taskId: "task-A" });
    assert.equal(h.shadow.querySelector(".status")!.textContent, "Waiting for reply: <img src=x>");
    assert.equal(h.shadow.querySelector("img"), null);
    assert.equal(h.orb.getAttribute("data-busy"), "true");
    assert.equal(h.shadow.querySelector(".task")!.textContent, "task-A");
    assert.equal(h.orb.getAttribute("aria-expanded"), "false");
    h.click();
    assert.equal((h.panel as any).hidden, false);
    assert.equal(h.orb.getAttribute("aria-expanded"), "true");
    assert.ok(parseFloat((h.panel as any).style.left) >= 12);
    h.window.document.body.dispatchEvent(new h.window.PointerEvent("pointerdown", { bubbles: true, composed: true }));
    assert.equal((h.panel as any).hidden, true);
    h.click(0);
    h.window.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal((h.panel as any).hidden, true);
    h.click();
    (h.shadow.querySelector(".close")! as any).click();
    assert.equal((h.panel as any).hidden, true);
    h.widget.update("Relay: sr_test", "#10a37f", { session: "sr_test" });
    assert.equal(h.orb.getAttribute("data-busy"), "false");
    assert.equal((h.shadow.querySelector(".task")! as any).hidden, true);
  } finally { await h.window.happyDOM.close(); }
});

test("drag clamps to the viewport, persists across reloads and does not open the panel", async () => {
  const h = harness();
  try {
    const start = h.position();
    h.pointer("pointerdown", start.x + 20, start.y + 20);
    h.pointer("pointermove", -100, -100, 2);
    assert.deepEqual(h.position(), start, "a second pointer cannot move the widget");
    h.pointer("pointermove", -100, -100);
    h.pointer("pointerup", -100, -100);
    h.click();
    assert.equal((h.panel as any).hidden, true, "the browser click following a drag is suppressed");
    assert.deepEqual(h.position(), { x: 12, y: 12 });
    const saved = h.values.get("gpt_relay_widget_position_v1")!;
    const reloaded = harness(saved);
    try { assert.deepEqual(reloaded.position(), h.position()); }
    finally { await reloaded.window.happyDOM.close(); }
    h.pointer("pointerdown", 32, 32);
    h.pointer("pointermove", 5000, 5000);
    h.pointer("pointerup", 5000, 5000);
    assert.deepEqual(h.position(), { x: 844, y: 644 });
    h.click(0); // Keyboard activation still works immediately after a drag.
    assert.equal((h.panel as any).hidden, false);
    h.window.innerWidth = 360; h.window.innerHeight = 280;
    h.window.dispatchEvent(new h.window.Event("resize"));
    assert.deepEqual(h.position(), { x: 304, y: 224 });
    assert.ok(parseFloat((h.panel as any).style.left) + parseFloat((h.panel as any).style.width) <= 348);
  } finally { await h.window.happyDOM.close(); }
});

test("small movements remain clicks, cancelled drags recover, and keyboard movement stays bounded", async () => {
  const h = harness();
  try {
    const start = h.position();
    h.pointer("pointerdown", 20, 20);
    h.pointer("pointermove", 22, 22);
    h.pointer("pointerup", 22, 22);
    h.click();
    assert.deepEqual(h.position(), start);
    assert.equal((h.panel as any).hidden, false);
    h.pointer("pointerdown", 20, 20);
    h.pointer("pointermove", 60, 60);
    h.pointer("pointercancel", 60, 60);
    assert.equal(h.orb.hasAttribute("data-dragging"), false);
    h.click();
    assert.equal((h.panel as any).hidden, false);
    h.orb.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    assert.equal(h.position().x, 804);
    assert.ok(h.values.has("gpt_relay_widget_position_v1"));
  } finally { await h.window.happyDOM.close(); }
});

for (const saved of ["bad JSON", '{"x":"wrong","y":20}', '{"x":99999,"y":-200}']) {
  test(`invalid or obsolete saved positions remain reachable: ${saved}`, async () => {
    const h = harness(saved);
    try {
      assert.ok(h.position().x >= 12 && h.position().x <= 844);
      assert.ok(h.position().y >= 12 && h.position().y <= 644);
    } finally { await h.window.happyDOM.close(); }
  });
}

test("unavailable position storage does not break status updates or dragging", async () => {
  const h = harness(undefined, true);
  try {
    h.widget.update("Error: conversation_blocked", "#e74c3c", { session: "sr_error" });
    h.pointer("pointerdown", 20, 20);
    h.pointer("pointermove", -200, -200);
    h.pointer("pointerup", -200, -200);
    assert.equal(h.shadow.querySelector(".status")!.textContent, "Error: conversation_blocked");
  } finally { await h.window.happyDOM.close(); }
});
