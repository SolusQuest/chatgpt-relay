// Isolated, local-only Relay status display. Never reads or changes the composer.
(() => {
  "use strict";
  const POSITION_KEY = "gpt_relay_widget_position_v1";
  const SIZE = 44, MARGIN = 12, GAP = 10;

  function create({ document, window, storage }) {
    const host = document.createElement("div");
    host.id = "gpt-relay-status";
    host.style.cssText = "all:initial!important;position:fixed!important;width:44px!important;height:44px!important;z-index:2147483647!important;pointer-events:none!important;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { color-scheme: light dark; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button { font: inherit; cursor: pointer; }
        .orb {
          --relay-color: #10a37f;
          position: relative; display: grid; place-items: center; width: 44px; height: 44px;
          padding: 0; border: 1px solid #ffffff24; border-radius: 50%;
          background: #202524; color: #f0f5f3; pointer-events: auto; touch-action: none;
          box-shadow: 0 4px 18px #0003, 0 1px 3px #0002; user-select: none;
          transition: box-shadow 150ms, background 150ms;
        }
        .orb:hover { background: #303936; box-shadow: 0 5px 22px #0004; }
        .orb:focus-visible, .close:focus-visible { outline: 2px solid #3498db; outline-offset: 4px; }
        .orb[data-dragging="true"] { cursor: grabbing; }
        .orb::before {
          content: ""; position: absolute; inset: 3px; border: 2px solid transparent;
          border-top-color: var(--relay-color); border-right-color: var(--relay-color);
          border-radius: 50%; opacity: 0;
        }
        .orb[data-busy="true"]::before { opacity: .85; animation: spin 1.8s linear infinite; }
        .dot {
          position: absolute; width: 10px; height: 10px; right: 0; bottom: 1px;
          border-radius: 50%; background: var(--relay-color); border: 2px solid #202524;
        }
        svg { width: 21px; height: 21px; pointer-events: none; }
        .panel {
          position: fixed; width: 300px; padding: 16px; border: 1px solid #dedfdb;
          border-radius: 16px; background: #fafbf8; color: #252b28; pointer-events: auto;
          box-shadow: 0 12px 40px #0002, 0 2px 6px #0001; overflow: auto;
          font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        strong { font-size: 14px; font-weight: 650; letter-spacing: -.2px; }
        .close { width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #79837d; font-size: 21px; line-height: 1; }
        .close:hover { background: #0000000a; }
        .status { margin: 12px 0 14px; overflow-wrap: anywhere; }
        dl { margin: 0; padding-top: 12px; border-top: 1px solid #00000012; }
        dt { color: #79837d; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; }
        dd { margin: 0 0 10px; font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; user-select: text; }
        dd:last-child { margin-bottom: 0; }
        footer { margin-top: 14px; color: #79837d; font-size: 11px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .orb[data-busy="true"]::before { animation: none; } }
        @media (prefers-color-scheme: dark) {
          .panel { background: #202524; color: #e9eeeb; border-color: #ffffff20; }
          dl { border-color: #ffffff16; }
          dt, footer, .close { color: #a0ada5; }
          .close:hover { background: #ffffff0d; }
        }
      </style>
      <button class="orb" type="button" aria-label="Relay status" aria-expanded="false" aria-controls="relay-panel" title="Relay status · Click to expand · Drag to move">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 7h9a3 3 0 0 1 0 6H9m9 4H9a3 3 0 0 1 0-6h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <circle cx="6" cy="7" r="2" fill="currentColor"/><circle cx="18" cy="17" r="2" fill="currentColor"/>
        </svg><span class="dot"></span>
      </button>
      <section id="relay-panel" class="panel" role="region" aria-label="Relay status details" hidden>
        <header><strong>Relay</strong><button class="close" type="button" aria-label="Close Relay status">×</button></header>
        <p class="status" role="status" aria-live="polite" aria-atomic="true"></p>
        <dl><dt>Session</dt><dd class="session"></dd><dt class="task-label" hidden>Task</dt><dd class="task" hidden></dd></dl>
        <footer>Drag to move · Arrow keys to position · Esc to close</footer>
      </section>`;
    const orb = shadow.querySelector(".orb"), panel = shadow.querySelector(".panel");
    const status = shadow.querySelector(".status"), session = shadow.querySelector(".session");
    const task = shadow.querySelector(".task"), taskLabel = shadow.querySelector(".task-label");
    let position = null, drag = null, suppressClickUntil = 0;

    const viewport = () => ({ width: window.innerWidth || 1024, height: window.innerHeight || 768 });
    function clamp(point) {
      const { width, height } = viewport();
      return { x: Math.min(Math.max(MARGIN, point.x), Math.max(MARGIN, width - SIZE - MARGIN)),
        y: Math.min(Math.max(MARGIN, point.y), Math.max(MARGIN, height - SIZE - MARGIN)) };
    }
    function save() {
      try { storage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* Storage may be disabled. */ }
    }
    function placePanel() {
      if (panel.hidden) return;
      const { width, height } = viewport();
      const panelWidth = Math.min(300, Math.max(0, width - MARGIN * 2));
      panel.style.width = `${panelWidth}px`;
      panel.style.maxHeight = `${Math.max(40, height - SIZE - GAP - MARGIN * 2)}px`;
      const panelHeight = panel.getBoundingClientRect().height;
      panel.style.left = `${Math.max(MARGIN, Math.min(position.x + SIZE - panelWidth, width - panelWidth - MARGIN))}px`;
      const above = position.y - panelHeight - GAP;
      panel.style.top = `${above >= MARGIN ? above : Math.max(MARGIN, Math.min(position.y + SIZE + GAP, height - panelHeight - MARGIN))}px`;
    }
    function place(point) {
      position = clamp(point);
      host.style.setProperty("left", `${position.x}px`, "important");
      host.style.setProperty("top", `${position.y}px`, "important");
      placePanel();
    }
    function expand(open) {
      panel.hidden = !open;
      orb.setAttribute("aria-expanded", String(open));
      placePanel();
    }
    const { width, height } = viewport();
    let restored;
    try { restored = JSON.parse(storage.getItem(POSITION_KEY)); } catch { /* Use the default position. */ }
    place(Number.isFinite(restored?.x) && Number.isFinite(restored?.y) ? restored :
      { x: width - SIZE - 24, y: height - SIZE - 96 });

    orb.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...position }, moved: false };
      try { orb.setPointerCapture(event.pointerId); } catch { /* Unsupported in DOM test environments. */ }
      event.stopPropagation();
    });
    orb.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      orb.setAttribute("data-dragging", "true");
      expand(false);
      place({ x: drag.origin.x + dx, y: drag.origin.y + dy });
      event.preventDefault();
      event.stopPropagation();
    });
    function endDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (drag.moved) {
        if (event.type === "pointerup") suppressClickUntil = Date.now() + 300;
        save();
      }
      drag = null;
      orb.removeAttribute("data-dragging");
      try { orb.releasePointerCapture(event.pointerId); } catch { /* Capture may already be released. */ }
    }
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) orb.addEventListener(type, endDrag);
    orb.addEventListener("click", event => {
      event.stopPropagation();
      if (event.detail !== 0 && Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
      expand(panel.hidden);
    });
    orb.addEventListener("keydown", event => {
      const step = event.shiftKey ? 40 : 10;
      const offsets = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const offset = offsets[event.key];
      if (!offset) return;
      event.preventDefault(); event.stopPropagation();
      place({ x: position.x + offset[0], y: position.y + offset[1] });
      save();
    });
    shadow.querySelector(".close").addEventListener("click", () => { expand(false); orb.focus(); });
    document.addEventListener("pointerdown", event => {
      if (!panel.hidden && !event.composedPath().includes(host)) expand(false);
    }, true);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) { expand(false); orb.focus(); event.stopPropagation(); }
    }, true);
    window.addEventListener("resize", () => { place(position); save(); });
    function attach() {
      if (document.body && !host.isConnected) { document.body.appendChild(host); placePanel(); }
    }
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });

    return { update(text, color = "#10a37f", details = {}) {
      status.textContent = text;
      orb.style.setProperty("--relay-color", color);
      orb.setAttribute("data-busy", String(color === "#3498db" || color === "#e67e22" || color === "#f39c12"));
      orb.setAttribute("aria-label", `Relay: ${text}`);
      orb.title = `${text} · Click to expand · Drag to move`;
      session.textContent = details.session ?? "—";
      task.textContent = details.taskId ?? "";
      task.hidden = taskLabel.hidden = !details.taskId;
      placePanel();
    } };
  }
  globalThis.GptRelayStatus = { create };
})();
