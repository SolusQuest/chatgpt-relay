// extension/content-script.js
// 注入到 chatgpt.com 页面：DOM 操作 + safety 探测 + banner。
// 与 service-worker 通过 chrome.runtime.sendMessage 通信。SW 负责所有 HTTP。

(() => {
  "use strict";
  if (window.__cgconContentLoaded) return;
  window.__cgconContentLoaded = true;

  // ── 选择器 & safety pattern（在此重复定义避免 ES import 限制）────
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
    { reason: "页面要求人机验证", pattern: /captcha|verify (that )?(you['\u2019]?re|you are) human|verify you are human|human verification|请验证|人机验证|验证码/i },
    { reason: "页面提示异常活动", pattern: /unusual activity|suspicious activity|异常活动|可疑活动/i },
    { reason: "页面提示请求过多", pattern: /too many requests|request limit|rate limit|频率限制|请求过多/i },
    { reason: "页面提示使用限制", pattern: /message cap|usage limit|(you['\u2019]?ve|you have) reached (the )?(current )?(usage )?limit|reached.*limit|使用上限|消息上限|达到.*限制/i },
    { reason: "页面提示稍后再试", pattern: /try again later|please try again later|稍后再试|请稍后/i },
    { reason: "页面提示账号或访问受限", pattern: /access denied|account.*disabled|account.*deactivated|访问被拒绝|账号.*停用|账户.*停用/i },
  ];

  const ACTION_DELAY_MIN = 250;
  const ACTION_DELAY_MAX = 900;
  const REPLY_STABLE_MS = 2500;
  const REPLY_TIMEOUT_MS = 10 * 60 * 1000;

  // ── util ──
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

  function findSafetyBlock() {
    for (const sel of SELECTORS.safetyAlerts) {
      for (const el of document.querySelectorAll(sel)) {
        const text = getVisibleText(el);
        if (!text) continue;
        for (const item of SAFETY_PATTERNS) {
          if (item.pattern.test(text)) {
            return { reason: item.reason, text: text.slice(0, 240).replace(/\s+/g, " ") };
          }
        }
      }
    }
    return null;
  }

  function findInput() {
    for (const sel of SELECTORS.input) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
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
    return SELECTORS.stopButton.some((sel) => document.querySelector(sel));
  }

  function getAssistantMessages() { return Array.from(document.querySelectorAll(SELECTORS.assistantMessage)); }
  function getUserMessages()      { return Array.from(document.querySelectorAll(SELECTORS.userMessage)); }
  function getLastText(msgs)      { return msgs.length ? msgs[msgs.length - 1].innerText.trim() : ""; }

  // Session id: 优先取 URL /c/<uuid>；否则 sessionStorage 生成
  function getSessionId() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/);
    if (m) return m[1];
    let sid = sessionStorage.getItem("cgcon_relay_session_id");
    if (!sid) {
      sid = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      sessionStorage.setItem("cgcon_relay_session_id", sid);
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

  // ── DOM 操作 ──

  async function waitForCondition(pred, timeoutMs, checkEveryMs = 200, ctx = "wait") {
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

  async function waitForInput() {
    return waitForCondition(() => {
      const inp = findInput();
      return inp && isVisible(inp) ? inp : null;
    }, 15000, 200, "waitForInput");
  }

  async function waitForPageReady() {
    return waitForCondition(() => (!isGenerating() ? true : null), 30000, 500, "waitForPageReady");
  }

  async function waitForSendReady() {
    return waitForCondition(() => {
      const b = findSendButton();
      if (b && isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true") return b;
      return null;
    }, 10000, 200, "waitForSendReady");
  }

  async function pasteIntoInput(text) {
    await waitForPageReady();
    const inp = await waitForInput();
    inp.scrollIntoView({ block: "center", inline: "nearest" });
    await pacedDelay(150, 400);
    inp.click();
    inp.focus();
    await pacedDelay(80, 200);
    const sel = getSelection();
    if (sel) sel.selectAllChildren(inp);
    await pacedDelay(80, 200);
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      // fallback: paste event with DataTransfer
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      inp.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    }
    try {
      inp.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } catch {
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await pacedDelay(300, 600);
    const injected = inp.innerText.trim();
    if (injected.length < Math.min(10, text.trim().length)) {
      throw new Error("文本注入失败，输入框内容为空");
    }
  }

  async function clickSend() {
    const b = await waitForSendReady();
    b.scrollIntoView({ block: "center", inline: "nearest" });
    await pacedDelay(250, 700);
    b.click();
    return true;
  }

  function waitForReply(baseline) {
    return new Promise((resolve, reject) => {
      let stableTimer = null;
      let lastText = "";
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForReply timeout ${REPLY_TIMEOUT_MS}ms`));
      }, REPLY_TIMEOUT_MS);

      function check() {
        try {
          const block = findSafetyBlock();
          if (block) { cleanup(); reject(new Error(`waitForReply safety: ${block.reason}`)); return; }
        } catch (e) { cleanup(); reject(e); return; }
        if (isGenerating()) {
          if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
          return;
        }
        const msgs = getAssistantMessages();
        const users = getUserMessages();
        if (msgs.length === 0) return;
        const last = getLastText(msgs);
        if (!last) return;
        const hasNewAssistant = msgs.length > baseline.assistantCount;
        const hasNewUser = users.length > baseline.userCount || Date.now() - baseline.startedAt > 2000;
        const changed = last !== baseline.lastAssistantText;
        if (!(hasNewAssistant || (hasNewUser && changed))) return;

        if (last === lastText) return; // still waiting for stability window
        lastText = last;
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          cleanup();
          resolve(last);
        }, REPLY_STABLE_MS);
      }

      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const iv = setInterval(check, 500);
      function cleanup() {
        observer.disconnect();
        clearInterval(iv);
        clearTimeout(timeout);
        if (stableTimer) clearTimeout(stableTimer);
      }
      check();
    });
  }

  // ── 消息处理 ──
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "get-session-id") {
          sendResponse({ session: getSessionId() });
        } else if (msg.type === "check-safety") {
          sendResponse({ block: findSafetyBlock() });
        } else if (msg.type === "update-banner") {
          updateBanner(msg.text, msg.color);
          sendResponse({});
        } else if (msg.type === "run-task") {
          const block = findSafetyBlock();
          if (block) throw new Error(`safety: ${block.reason}`);
          updateBanner(`处理中: ${msg.taskId?.slice?.(0, 8) ?? ""}…`, "#e67e22");
          await pasteIntoInput(msg.text);
          await pacedDelay(500, 1200);
          const baseline = {
            assistantCount: getAssistantMessages().length,
            lastAssistantText: getLastText(getAssistantMessages()),
            userCount: getUserMessages().length,
            startedAt: Date.now(),
          };
          await clickSend();
          updateBanner(`等待回复: ${msg.taskId?.slice?.(0, 8) ?? ""}…`, "#3498db");
          const reply = await waitForReply(baseline);
          updateBanner(`Relay: ${getSessionId().slice(0, 8)}…`, "#10a37f");
          sendResponse({ reply });
        } else {
          sendResponse({ error: `unknown message type: ${msg.type}` });
        }
      } catch (e) {
        console.warn("[cgcon content] error handling", msg.type, e);
        updateBanner(`错误: ${e.message.slice(0, 40)}`, "#e74c3c");
        setTimeout(() => updateBanner(`Relay: ${getSessionId().slice(0, 8)}…`, "#10a37f"), 5000);
        sendResponse({ error: e.message });
      }
    })();
    return true; // async response
  });

  // 主动上报 session id 给 SW（首次加载 + URL 变化）
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

  console.log("[cgcon content] loaded, session=", getSessionId());
})();