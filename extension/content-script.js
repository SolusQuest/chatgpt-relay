// extension/content-script.js
// Runs in chatgpt.com for DOM submission, safety detection, status, recovery, and connectivity.
//
// This layer performs synchronous DOM operations and one poll-reply snapshot.
// New replies are detected by data-message-id because virtual scrolling can
// unmount old messages. textContent is used because innerText depends on layout.
//
// Long-running reply waits live in the service worker pending-reply state
// machine. Chrome can freeze MutationObserver and setInterval in background or
// unrendered tabs, so the worker requests active snapshots instead. This also
// simplifies recovery after page and service-worker restarts.

(() => {
  "use strict";
  if (window.__gptRelayContentLoaded) return;
  window.__gptRelayContentLoaded = true;

  // Selectors and safety patterns.
  const SELECTORS = {
    input: [
      "#prompt-textarea",
      '[contenteditable="true"][data-testid]',
      'div[contenteditable="true"]',
    ],
    sendButton: [
      '[data-testid="send-button"]',
      'button[aria-label*="Send"], button[aria-label*="发送"]',
    ],
    stopButton: [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop"], button[aria-label*="停止"]',
    ],
    assistantMessage: '[data-message-author-role="assistant"]',
    userMessage: '[data-message-author-role="user"]',
    safetyAlerts: [
      '[role="alert"]',
      '[role="dialog"]',
      '[data-testid*="toast"]',
      '[data-testid*="error"]',
      '[data-testid*="banner"]',
    ],
  };

  const SAFETY_PATTERNS = [
    { reason: "Human verification required", pattern: /captcha|verify (that )?(you['\u2019]?re|you are) human|verify you are human|human verification|请验证|人机验证|验证码/i },
    { reason: "Unusual activity warning detected", pattern: /unusual activity|suspicious activity|异常活动|可疑活动/i },
    { reason: "Too many requests warning detected", pattern: /too many requests|request limit|rate limit|频率限制|请求过多/i },
    { reason: "Usage limit warning detected", pattern: /message cap|usage limit|(you['\u2019]?ve|you have) reached (the )?(current )?(usage )?limit|reached.*limit|使用上限|消息上限|达到.*限制/i },
    { reason: "Try again later warning detected", pattern: /try again later|please try again later|稍后再试|请稍后/i },
    { reason: "Account or access restriction detected", pattern: /access denied|account.*disabled|account.*deactivated|访问被拒绝|账号.*停用|账户.*停用/i },
  ];

  // ChatGPT connectivity warnings trigger a reload instead of a safety pause.
  const RECOVERY_PATTERNS = [
    /connection (was |is )?(lost|interrupted)/i,
    /reconnecting/i,
    /you appear to be offline/i,
    /连接.*(中断|已断开|失败)/,
    /重新连接/,
    /网络异常/,
  ];

  const ACTION_DELAY_MIN = 250;
  const ACTION_DELAY_MAX = 900;
  const INFLIGHT_KEY = "gpt_relay_inflight_v3";
  const FETCH_FAIL_THRESHOLD = 3;
  const RELOAD_COOLDOWN_MS = 60_000;
  // document_idle can precede React hydration. After refresh, wait until the
  // conversation DOM and composer remain stable before accepting new work.
  const PAGE_READY_STABLE_MS = 4000;
  const PAGE_READY_TIMEOUT_MS = 60_000;
  const SUBMISSION_ACCEPT_TIMEOUT_MS = 15_000;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const randBetween = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const pacedDelay = (a = ACTION_DELAY_MIN, b = ACTION_DELAY_MAX) => delay(randBetween(a, b));

  function getVisibleText(el) {
    if (!el || !isVisible(el)) return "";
    return (el.innerText || el.textContent || "").trim();
  }
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }

  function scanAlerts() {
    const found = [];
    for (const sel of SELECTORS.safetyAlerts) {
      for (const el of document.querySelectorAll(sel)) {
        const text = getVisibleText(el);
        if (!text) continue;
        found.push(text);
      }
    }
    return found;
  }

  function findSafetyBlock() {
    for (const text of scanAlerts()) {
      for (const item of SAFETY_PATTERNS) {
        if (item.pattern.test(text)) {
          return { reason: item.reason, text: text.slice(0, 240).replace(/\s+/g, " ") };
        }
      }
    }
    return null;
  }

  function findRecoveryHint() {
    for (const text of scanAlerts()) {
      for (const p of RECOVERY_PATTERNS) if (p.test(text)) return text.slice(0, 200);
    }
    return null;
  }

  function findInput() {
    let fallback = null;
    for (const sel of SELECTORS.input) {
      for (const el of document.querySelectorAll(sel)) {
        fallback ??= el;
        if (isVisible(el)) return el;
      }
    }
    return fallback;
  }

  function findSendButton() {
    for (const sel of SELECTORS.sendButton) {
      const b = document.querySelector(sel);
      if (b) return b;
    }
    const inp = findInput();
    if (inp) {
      const form = inp.closest("form");
      if (form) return form.querySelector('button[type="submit"], button:last-of-type');
    }
    return null;
  }

  function isGenerating() {
    return SELECTORS.stopButton.some((sel) =>
      Array.from(document.querySelectorAll(sel)).some((button) => isVisible(button)),
    );
  }

  function getAssistantMessages() { return Array.from(document.querySelectorAll(SELECTORS.assistantMessage)); }
  function getUserMessages()      { return Array.from(document.querySelectorAll(SELECTORS.userMessage)); }
  function getLastText(msgs) {
    if (!msgs.length) return "";
    const el = msgs[msgs.length - 1];
    // innerText depends on layout and may be empty in frozen tabs; textContent does not.
    const t = (el.textContent ?? el.innerText ?? "").replace(/\u00A0/g, " ").trim();
    return t;
  }
  function getLastAssistantId(msgs) {
    if (!msgs.length) return null;
    return msgs[msgs.length - 1].getAttribute("data-message-id") || null;
  }
  function getLastUserId(msgs) {
    if (!msgs.length) return null;
    return msgs[msgs.length - 1].getAttribute("data-message-id") || null;
  }

  function captureBaseline() {
    const assistants = getAssistantMessages();
    const users = getUserMessages();
    return {
      assistantCount: assistants.length,
      lastAssistantId: getLastAssistantId(assistants),
      lastUserId: getLastUserId(users),
      userCount: users.length,
      startedAt: Date.now(),
    };
  }

  let pageReadyCandidate = null;

  function getPageReadiness(now = Date.now()) {
    const baseline = captureBaseline();
    const generating = isGenerating();
    const input = findInput();
    const conversationRoute = location.pathname.match(/\/c\/([a-f0-9-]+)/);

    let reason = null;
    if (document.readyState !== "complete") {
      reason = "document-loading";
    } else if (generating) {
      reason = "generating";
    } else if (!input || !isVisible(input)) {
      reason = "composer-loading";
    } else if (
      conversationRoute &&
      baseline.userCount + baseline.assistantCount === 0
    ) {
      // /c/<id> identifies an existing conversation. No messages means React is
      // still hydrating history and may replace the composer after submission.
      reason = "conversation-hydrating";
    }

    if (reason) {
      pageReadyCandidate = null;
      return {
        ready: false,
        reason,
        stableForMs: 0,
        generating,
        baseline,
      };
    }

    const signature = [
      location.pathname,
      baseline.userCount,
      baseline.lastUserId ?? "",
      baseline.assistantCount,
      baseline.lastAssistantId ?? "",
    ].join("|");

    if (
      !pageReadyCandidate ||
      pageReadyCandidate.signature !== signature ||
      pageReadyCandidate.input !== input
    ) {
      pageReadyCandidate = { signature, input, since: now };
    }

    const stableForMs = Math.max(0, now - pageReadyCandidate.since);
    const ready = stableForMs >= PAGE_READY_STABLE_MS;
    return {
      ready,
      reason: ready ? null : "page-stabilizing",
      stableForMs,
      generating,
      baseline,
    };
  }

  function getSessionId() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/);
    if (m) return m[1];
    let sid = sessionStorage.getItem("gpt_relay_session_id");
    if (!sid) {
      sid = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      sessionStorage.setItem("gpt_relay_session_id", sid);
    }
    return sid;
  }

  // ── banner ──
  const banner = document.createElement("div");
  banner.style.cssText = `
    position: fixed; top: 0; left: 50%; transform: translateX(-50%);
    background: #10a37f; color: white; padding: 4px 16px;
    border-radius: 0 0 8px 8px; font-size: 13px; z-index: 999999;
    font-family: monospace; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    pointer-events: none;
  `;
  function updateBanner(text, color) {
    banner.textContent = text;
    banner.style.background = color || "#10a37f";
  }
  function attachBanner() {
    if (!document.body) return;
    if (!banner.isConnected) document.body.appendChild(banner);
  }
  updateBanner(`Relay: ${getSessionId().slice(0, 8)}…`);
  if (document.body) attachBanner();
  else document.addEventListener("DOMContentLoaded", attachBanner);

  // In-flight state that survives page refresh.
  function readInflight() {
    try { return JSON.parse(sessionStorage.getItem(INFLIGHT_KEY) ?? "null"); }
    catch { return null; }
  }
  function writeInflight(rec) {
    sessionStorage.setItem(INFLIGHT_KEY, JSON.stringify(rec));
  }
  function clearInflight() {
    sessionStorage.removeItem(INFLIGHT_KEY);
  }

  // A Stop click records intent; later DOM sampling confirms actual cancellation.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest(SELECTORS.stopButton.join(","))
      : null;
    const rec = readInflight();
    if (!target || !rec?.taskId) return;
    rec.stopRequestedAt = Date.now();
    writeInflight(rec);
    chrome.runtime.sendMessage({
      type: "user-stop-requested",
      taskId: rec.taskId,
    }).catch(() => {});
  }, true);

  // ── waitForCondition helper ──
  async function waitForCondition(pred, timeoutMs, checkEveryMs, ctx) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const block = findSafetyBlock();
      if (block) throw new Error(`${ctx}: safety block: ${block.reason}`);
      const v = pred();
      if (v) return v;
      await delay(checkEveryMs);
    }
    throw new Error(`${ctx}: timeout ${timeoutMs}ms`);
  }

  async function waitForInput()      { return waitForCondition(() => { const i = findInput(); return i && isVisible(i) ? i : null; }, 15000, 200, "waitForInput"); }
  async function waitForPageReady()  {
    return waitForCondition(() => {
      const state = getPageReadiness();
      return state.ready && !state.generating ? state : null;
    }, PAGE_READY_TIMEOUT_MS, 250, "waitForPageReady");
  }
  async function waitForSendReady()  { return waitForCondition(() => {
    const b = findSendButton();
    if (b && isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true") return b;
    return null;
  }, 10000, 200, "waitForSendReady"); }

  // Background-friendly prompt injection that does not require focus.
  //
  // The ChatGPT composer is controlled by Lexical/ProseMirror, so direct DOM
  // mutation is insufficient. Injection paths in reliability order:
  //   1) ClipboardEvent('paste') with DataTransfer, handled directly by Lexical
  //      and effective without focus.
  //   2) execCommand('insertText'), reliable in a focused foreground tab.
  //   3) Range replacement with beforeinput/input as a final DOM-level fallback.
  //
  // Dispatch change/input events after injection. If Send remains disabled,
  // state did not synchronize and the caller should retry or fail explicitly.
  async function pasteIntoInput(text) {
    await waitForPageReady();
    const inp = await waitForInput();

    if (!document.hidden) {
      inp.scrollIntoView({ block: "center", inline: "nearest" });
      await pacedDelay(120, 300);
      inp.click();
    }
    try { inp.focus({ preventScroll: true }); } catch { /* ignore */ }
    await pacedDelay(50, 150);

    // Keep the selection inside the composer for the Lexical paste handler.
    try {
      const sel = getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(inp);
        range.collapse(false);
        sel.addRange(range);
      }
    } catch { /* ignore */ }

    let injectedOk = false;
    let method = "none";

    // Path 1: ClipboardEvent paste, most reliable for Lexical without focus.
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      if (!pasteEvent.clipboardData) {
        Object.defineProperty(pasteEvent, "clipboardData", { value: dt });
      }
      inp.dispatchEvent(pasteEvent);
      injectedOk = true;
      method = "paste";
    } catch (e) {
      console.warn("[relay content] Path 1 (paste event) failed", e);
    }

    // Path 2: execCommand insertText, most reliable in a focused foreground tab.
    if (!injectedOk && document.activeElement === inp) {
      try {
        const ok = document.execCommand("insertText", false, text);
        if (ok) { injectedOk = true; method = "execCommand"; }
      } catch { /* ignore */ }
    }

    // Path 3: Range replacement plus beforeinput/input as the final fallback.
    if (!injectedOk) {
      try {
        while (inp.firstChild) inp.removeChild(inp.firstChild);
        const p = document.createElement("p");
        p.appendChild(document.createTextNode(text));
        inp.appendChild(p);
        try {
          inp.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true, cancelable: true, inputType: "insertText", data: text,
          }));
        } catch { /* ignore */ }
        inp.dispatchEvent(new InputEvent("input", {
          bubbles: true, cancelable: true, inputType: "insertText", data: text,
        }));
        injectedOk = true;
        method = "dom-fallback";
      } catch (e) {
        console.warn("[relay content] Path 3 (DOM fallback) failed", e);
      }
    }

    await pacedDelay(300, 600);

    const injected = inp.innerText.trim();
    // ChatGPT may convert long text into an attachment, leaving the composer
    // empty. Treat an enabled Send button as success and allow time for upload.
    const sendReady = await waitForCondition(() => {
      const b = findSendButton();
      if (!b) return null;
      if (b.disabled) return null;
      if (b.getAttribute("aria-disabled") === "true") return null;
      return b;
    }, 15000, 200, "check-send-enabled").catch(() => null);

    if (!sendReady) {
      const suffix = injected.length === 0
        ? "(composer is empty and no attachment was uploaded)"
        : `(composer DOM length=${injected.length}; Lexical state did not synchronize)`;
      throw new Error(`Prompt injection method ${method} did not enable Send ${suffix}`);
    }

    const asAttachment = injected.length < Math.min(10, text.trim().length);
    console.log(
      `[relay content] injected via ${method}, DOM len=${injected.length}` +
        (asAttachment ? " (likely converted to attachment)" : ""),
    );
  }
  async function clickSend() {
    const b = await waitForSendReady();
    if (!document.hidden) b.scrollIntoView({ block: "center", inline: "nearest" });
    await pacedDelay(200, 500);
    b.click();
    return true;
  }

  async function waitForSubmissionAccepted(baseline) {
    return waitForCondition(() => {
      const users = getUserMessages();
      const lastUserId = getLastUserId(users);
      const hasNewUser = baseline.lastUserId != null
        ? !!lastUserId && lastUserId !== baseline.lastUserId
        : users.length > (baseline.userCount ?? 0);
      if (hasNewUser || isGenerating()) return true;
      return null;
    }, SUBMISSION_ACCEPT_TIMEOUT_MS, 250, "waitForSubmissionAccepted");
  }

  // Recover the previous in-flight task after page load.
  async function tryRecoverInflight() {
    const rec = readInflight();
    if (!rec) return;
    if (rec.session !== getSessionId()) {
      // The conversation changed, so the pending task cannot be mapped safely.
      clearInflight();
      return;
    }
    console.log("[relay content] found inflight from previous session", rec);
    updateBanner(`Recovering: ${rec.taskId.slice(0, 8)}…`, "#f39c12");

    try {
      await waitForCondition(() => document.body ? true : null, 10000, 200, "wait body");
      await delay(1500);
      const now = getAssistantMessages();
      const users = getUserMessages();
      const currentAssistantId = getLastAssistantId(now);
      const currentUserId = getLastUserId(users);
      const hasNew = rec.baseline?.lastAssistantId != null
        ? !!currentAssistantId && currentAssistantId !== rec.baseline.lastAssistantId
        : now.length > (rec.baseline?.assistantCount ?? 0);
      const hasNewUser = rec.baseline?.lastUserId != null
        ? !!currentUserId && currentUserId !== rec.baseline.lastUserId
        : users.length > (rec.baseline?.userCount ?? 0);

      if (hasNew && !isGenerating()) {
        const last = getLastText(now);
        if (last) {
          console.log("[relay content] recovered reply from DOM:", last.slice(0, 50));
          const r = await chrome.runtime.sendMessage({
            type: "recover-task",
            taskId: rec.taskId,
            text: last,
          });
          if (r?.recovered) updateBanner(`Recovered: ${rec.taskId.slice(0, 8)}`, "#27ae60");
          clearInflight();
          return;
        }
      }
      if (rec.stopRequestedAt) {
        chrome.runtime.sendMessage({
          type: "user-stop-requested",
          taskId: rec.taskId,
        }).catch(() => {});
        return;
      }
      if (isGenerating()) {
        // Generation continues; let the service worker actively sample the page.
        updateBanner(`Recovering (generating): ${rec.taskId.slice(0, 8)}`, "#f39c12");
        chrome.runtime.sendMessage({
          type: "reattach-pending",
          taskId: rec.taskId,
          baseline: rec.baseline ?? {
            assistantCount: 0, lastAssistantText: "", userCount: 0, startedAt: Date.now(),
          },
        }).catch(() => {});
        return;
      }
      if (hasNewUser) {
        // The user message was sent but no assistant message exists yet; do not resubmit.
        chrome.runtime.sendMessage({
          type: rec.stopRequestedAt ? "user-stop-requested" : "reattach-pending",
          taskId: rec.taskId,
          baseline: rec.baseline ?? {},
        }).catch(() => {});
        return;
      }
      if (rec.phase === "send-attempted" || rec.phase === "send-clicked") {
        // A refresh near the click boundary makes submission uncertain. Sample
        // conservatively rather than risk sending the prompt twice.
        chrome.runtime.sendMessage({
          type: "reattach-pending",
          taskId: rec.taskId,
          baseline: rec.baseline ?? {},
          submissionState: rec.phase,
        }).catch(() => {});
        return;
      }
      console.log("[relay content] no new reply found; requeuing", rec.taskId);
      await chrome.runtime.sendMessage({ type: "requeue-task", taskId: rec.taskId });
      clearInflight();
    } catch (e) {
      console.warn("[relay content] recover failed", e);
    }
  }

  // Connectivity detection through online/offline events and a fetch hook.
  let consecutiveFetchFail = 0;
  let lastReloadAt = 0;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try {
      const res = await origFetch(...args);
      const url = String(args[0]);
      if (url.includes("chatgpt.com") && !url.includes("localhost")) {
        if (res.ok) consecutiveFetchFail = 0;
        else if (res.status >= 500 || res.status === 429) consecutiveFetchFail++;
      }
      if (consecutiveFetchFail >= FETCH_FAIL_THRESHOLD) maybeReload("chatgpt fetch failures");
      return res;
    } catch (e) {
      const url = String(args[0]);
      if (url.includes("chatgpt.com")) {
        consecutiveFetchFail++;
        if (consecutiveFetchFail >= FETCH_FAIL_THRESHOLD) maybeReload("chatgpt fetch throw");
      }
      throw e;
    }
  };

  function maybeReload(reason) {
    if (Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) return;
    lastReloadAt = Date.now();
    console.warn("[relay content] reloading page:", reason);
    updateBanner(`Reloading: ${reason.slice(0, 30)}`, "#e67e22");
    // Tell the extension about the reload so it does not dispatch new work.
    chrome.runtime.sendMessage({ type: "network-reload", reason }).catch(() => {});
    setTimeout(() => location.reload(), 1500);
  }

  window.addEventListener("offline", () => {
    updateBanner("Offline", "#95a5a6");
    chrome.runtime.sendMessage({ type: "offline" }).catch(() => {});
  });
  window.addEventListener("online", async () => {
    updateBanner(`Relay: ${getSessionId().slice(0, 8)}… (recovered)`, "#10a37f");
    chrome.runtime.sendMessage({ type: "online" }).catch(() => {});
    await delay(3000);
    // Reload when the page already shows a connectivity warning.
    const hint = findRecoveryHint();
    if (hint) maybeReload(`recovery hint: ${hint.slice(0, 40)}`);
  });

  // Periodically scan for recovery warnings that may not accompany fetch failures.
  setInterval(() => {
    const hint = findRecoveryHint();
    if (hint) maybeReload(`chatgpt recovery banner: ${hint.slice(0, 40)}`);
  }, 15_000);

  // Message handling.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "poll-reply") {
          try {
            const block = findSafetyBlock();
            if (block) {
              sendResponse({ status: "safety", reason: block.reason });
              return;
            }
            const baseline = msg.baseline ?? { assistantCount: 0, lastAssistantText: "", lastAssistantId: null, userCount: 0 };
            const msgs = getAssistantMessages();
            const users = getUserMessages();
            const generating = isGenerating();
            const lastId = getLastAssistantId(msgs);
            // Virtual scrolling makes counts unreliable. Compare message IDs;
            // a null lastId means the page has not inserted a placeholder.
            const hasNewAssistant = !!lastId && lastId !== baseline.lastAssistantId;
            // User messages can also be unmounted. This count only distinguishes
            // a completely ineffective submission in the most conservative way.
            const currentUserId = getLastUserId(users);
            const hasNewUser = baseline.lastUserId != null
              ? !!currentUserId && currentUserId !== baseline.lastUserId
              : users.length > (baseline.userCount ?? 0);
            const lastText = getLastText(msgs);
            if (generating) {
              sendResponse({ status: "generating", lastText: lastText, assistantCount: msgs.length });
              return;
            }
            if (!hasNewUser && !hasNewAssistant) {
              sendResponse({ status: "not-started", lastText: lastText, assistantCount: msgs.length });
              return;
            }
            if (hasNewAssistant) {
              sendResponse({ status: "reply-ready", reply: lastText, assistantCount: msgs.length });
              return;
            }
            sendResponse({ status: "posted-no-reply-yet", lastText: lastText, assistantCount: msgs.length });
          } catch (e) {
            sendResponse({ error: e.message });
          }
          return;
        }
        if (msg.type === "clear-inflight") {
          clearInflight();
          try { updateBanner(`Relay: ${getSessionId().slice(0, 8)}…`, "#10a37f"); } catch {}
          sendResponse({ status: "ok" });
        } else if (msg.type === "get-session-id") {
          sendResponse({ session: getSessionId() });
        } else if (msg.type === "get-inflight") {
          sendResponse({ inflight: readInflight() });
        } else if (msg.type === "get-page-state") {
          sendResponse(getPageReadiness());
        } else if (msg.type === "check-safety") {
          sendResponse({ block: findSafetyBlock() });
        } else if (msg.type === "update-banner") {
          updateBanner(msg.text, msg.color);
          sendResponse({});
        } else if (msg.type === "run-task") {
          const block = findSafetyBlock();
          if (block) throw new Error(`safety: ${block.reason}`);
          updateBanner(`Submitting: ${msg.taskId?.slice?.(0, 8) ?? ""}…`, "#e67e22");

          // Save the baseline and in-flight state for refresh recovery.
          const baseline = msg.baseline ?? captureBaseline();
          const inflight = {
            taskId: msg.taskId,
            session: getSessionId(),
            submittedAt: Date.now(),
            baseline,
            phase: "preparing",
          };
          writeInflight(inflight);

          try {
            await pasteIntoInput(msg.text);
            await pacedDelay(500, 1200);
            inflight.phase = "send-attempted";
            inflight.sendAttemptedAt = Date.now();
            writeInflight(inflight);
            await clickSend();
            inflight.phase = "send-clicked";
            inflight.sendClickedAt = Date.now();
            writeInflight(inflight);
            await waitForSubmissionAccepted(baseline);
            inflight.phase = "accepted";
            inflight.acceptedAt = Date.now();
            writeInflight(inflight);
            updateBanner(`Waiting for reply: ${msg.taskId?.slice?.(0, 8) ?? ""}…`, "#3498db");

            // run-task only submits, records the baseline, and returns. The
            // service worker owns all subsequent reply polling.
            sendResponse({ status: "submitted", baseline, submissionState: "accepted" });
          } catch (e) {
            console.warn("[relay content] run-task failed", e);
            updateBanner(`Error: ${e.message.slice(0, 40)}`, "#e74c3c");
            sendResponse({
              error: e.message,
              baseline,
              submissionState: inflight.phase === "preparing"
                ? "not-submitted"
                : "send-attempted",
            });
          }
        } else {
          sendResponse({ error: `unknown message type: ${msg.type}` });
        }
      } catch (e) {
        console.warn("[relay content] error handling", msg.type, e);
        updateBanner(`Error: ${e.message.slice(0, 40)}`, "#e74c3c");
        setTimeout(() => updateBanner(`Relay: ${getSessionId().slice(0, 8)}…`, "#10a37f"), 5000);
        // Keep in-flight state so a later refresh can attempt recovery.
        sendResponse({ error: e.message });
      }
    })();
    return true;
  });

  // Report the session ID to the service worker on load and URL changes.
  let lastReportedSid = "";
  function reportSid() {
    const sid = getSessionId();
    if (sid === lastReportedSid) return;
    lastReportedSid = sid;
    chrome.runtime.sendMessage({ type: "session-hello", session: sid }).catch(() => {});
    updateBanner(`Relay: ${sid.slice(0, 8)}…`);
  }
  reportSid();
  setInterval(reportSid, 3000);

  // Attempt in-flight recovery shortly after page load.
  setTimeout(() => { void tryRecoverInflight(); }, 1500);

  console.log("[relay content] loaded, session=", getSessionId());
})();
