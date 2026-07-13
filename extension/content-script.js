// extension/content-script.js
// 注入到 chatgpt.com 页面：DOM 注入 + 提交 + safety 探测 + banner + inflight 恢复 + 断网检测。
//
// 架构：这一层只做同步 DOM 操作 + 单次 poll-reply 快照。判定"是否有新回复"用
// data-message-id（不用 count；ChatGPT 会虚拟滚动 unmount 老消息）。文本读取
// 用 textContent（不用 innerText，后者依赖 layout）。
//
// 长跑的"等回复"逻辑不在这里，改由 service-worker.js 的 pending-reply 状态机
// 每次 alarm 周期主动通过 sendMessage(poll-reply) 采样。原因是 Chrome 会冻结
// 后台/未渲染 tab 里的 MutationObserver 和 setInterval，无法用长跑 observer。
// 即便前台运行，主动采样架构也让"页面 F5 刷新"和"SW 重启"的 recovery 简单。

(() => {
  "use strict";
  if (window.__gptRelayContentLoaded) return;
  window.__gptRelayContentLoaded = true;

  // ── 选择器 & safety pattern ─────────────────────────────
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

  // ChatGPT 显示"连接中断"提示的关键词。命中时不是 pause，而是 reload。
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
  function getLastText(msgs) {
    if (!msgs.length) return "";
    const el = msgs[msgs.length - 1];
    // 后台 tab 的 innerText 依赖 layout，Chrome 冻结后返回空串；textContent 不受影响。
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

  // ── inflight 状态（页面刷新可读） ──
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

  // Stop 点击只记录用户意图；最终是否停止由后续 DOM 状态采样确认。
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
  async function waitForPageReady()  { return waitForCondition(() => (!isGenerating() ? true : null), 30000, 500, "waitForPageReady"); }
  async function waitForSendReady()  { return waitForCondition(() => {
    const b = findSendButton();
    if (b && isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true") return b;
    return null;
  }, 10000, 200, "waitForSendReady"); }

  // ── 后台友好的注入（不依赖 focus） ──
  //
  // ChatGPT 的输入框是 Lexical/ProseMirror 受控组件：改 DOM 无用，必须走 Lexical
  // 认识的事件流。策略（按可靠性排序）：
  //   1) 主路径：ClipboardEvent('paste') + DataTransfer。Lexical 有 dedicated
  //      paste handler，最"官方"的注入方式，且不需要 focus 生效。
  //   2) 回退：execCommand('insertText')。需要 focus，前台 tab 有效。
  //   3) 最后兜底：Range 替换 + beforeinput/input 序列。可能只改 DOM 不改 state，
  //      但作为最后一根稻草仍试一下。
  //
  // 注入后主动派发 'change'/'input' 事件通知 React；如果发现 send 按钮持续
  // disabled，说明状态未同步，抛错让上层重试或明确失败。
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

    // 确保 selection 落在输入框内（Lexical paste handler 会检查这个）
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

    // Path 1: ClipboardEvent paste（对 Lexical 最可靠，且不要求 focus）
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

    // Path 2: execCommand insertText（前台 tab focused 时最可靠）
    if (!injectedOk && document.activeElement === inp) {
      try {
        const ok = document.execCommand("insertText", false, text);
        if (ok) { injectedOk = true; method = "execCommand"; }
      } catch { /* ignore */ }
    }

    // Path 3: Range 替换 + beforeinput / input（DOM-level 最后兜底）
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
    // 长文本可能被 ChatGPT 自动转为文本附件（编辑器留空、附件 chip 出现、
    // 上传完成后 send 按钮 enabled）。因此不再以"编辑器有文字"为通过标准，
    // 改以 send 按钮是否 enabled 作为最终判据；上传耗时较久，wait 拉长到 15s。
    const sendReady = await waitForCondition(() => {
      const b = findSendButton();
      if (!b) return null;
      if (b.disabled) return null;
      if (b.getAttribute("aria-disabled") === "true") return null;
      return b;
    }, 15000, 200, "check-send-enabled").catch(() => null);

    if (!sendReady) {
      const suffix = injected.length === 0
        ? "（编辑器为空，也未上传附件）"
        : `（编辑器 DOM len=${injected.length}，Lexical state 未同步）`;
      throw new Error(`文本注入方法 ${method} 未激活 send 按钮 ${suffix}`);
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

  // ── 页面加载后尝试回捞上次的 inflight ──
  async function tryRecoverInflight() {
    const rec = readInflight();
    if (!rec) return;
    if (rec.session !== getSessionId()) {
      // conversation 换了，pending 无法映射
      clearInflight();
      return;
    }
    console.log("[relay content] found inflight from previous session", rec);
    updateBanner(`回捞中: ${rec.taskId.slice(0, 8)}…`, "#f39c12");

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
          if (r?.recovered) updateBanner(`已回捞: ${rec.taskId.slice(0, 8)}`, "#27ae60");
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
        // 还在生成中：改由 SW 通过 poll-reply 主动采样，避免后台 tab observer 冻结。
        updateBanner(`回捞（生成中）: ${rec.taskId.slice(0, 8)}`, "#f39c12");
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
        // user message 已经发送，但 assistant 尚未出现：不要重发 prompt。
        chrome.runtime.sendMessage({
          type: rec.stopRequestedAt ? "user-stop-requested" : "reattach-pending",
          taskId: rec.taskId,
          baseline: rec.baseline ?? {},
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

  // ── 网络检测（online/offline + fetch hook） ──
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
    updateBanner(`重新加载: ${reason.slice(0, 30)}`, "#e67e22");
    // 让扩展知道正在 reload，避免此时派发新任务
    chrome.runtime.sendMessage({ type: "network-reload", reason }).catch(() => {});
    setTimeout(() => location.reload(), 1500);
  }

  window.addEventListener("offline", () => {
    updateBanner("离线", "#95a5a6");
    chrome.runtime.sendMessage({ type: "offline" }).catch(() => {});
  });
  window.addEventListener("online", async () => {
    updateBanner(`Relay: ${getSessionId().slice(0, 8)}… (recovered)`, "#10a37f");
    chrome.runtime.sendMessage({ type: "online" }).catch(() => {});
    await delay(3000);
    // 若页面已有连接中断提示，reload
    const hint = findRecoveryHint();
    if (hint) maybeReload(`recovery hint: ${hint.slice(0, 40)}`);
  });

  // 周期扫描恢复提示（有些提示不伴随 fetch 失败）
  setInterval(() => {
    const hint = findRecoveryHint();
    if (hint) maybeReload(`chatgpt recovery banner: ${hint.slice(0, 40)}`);
  }, 15_000);

  // ── 消息处理 ──
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
            // 虚拟滚动会 unmount 老消息，所以 count 不可靠；用 data-message-id 判定"是否是新一条"。
            // 若 lastId 为 null（页面还没插占位）视为无新回复。
            const hasNewAssistant = !!lastId && lastId !== baseline.lastAssistantId;
            // user 消息也可能被虚拟滚动 unmount，同样不能靠 count。只用来在极端情况下
            // 分辨"提交都没生效"（既没有新 assistant 也完全没有 user）。保守：只要页面
            // 有任何 user 消息就认为提交生效了。
            const hasNewUser = users.length > 0;
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
        } else if (msg.type === "check-safety") {
          sendResponse({ block: findSafetyBlock() });
        } else if (msg.type === "update-banner") {
          updateBanner(msg.text, msg.color);
          sendResponse({});
        } else if (msg.type === "run-task") {
          const block = findSafetyBlock();
          if (block) throw new Error(`safety: ${block.reason}`);
          updateBanner(`处理中: ${msg.taskId?.slice?.(0, 8) ?? ""}…`, "#e67e22");

          // 记录 baseline + inflight，供刷新恢复用
          const _msgsAtSubmit = getAssistantMessages();
          const baseline = {
            assistantCount: _msgsAtSubmit.length,
            lastAssistantText: getLastText(_msgsAtSubmit),
            lastAssistantId: getLastAssistantId(_msgsAtSubmit),
            lastUserId: getLastUserId(getUserMessages()),
            userCount: getUserMessages().length,
            startedAt: Date.now(),
          };
          writeInflight({
            taskId: msg.taskId,
            session: getSessionId(),
            submittedAt: Date.now(),
            baseline,
          });

          await pasteIntoInput(msg.text);
          await pacedDelay(500, 1200);
          await clickSend();
          updateBanner(`等待回复: ${msg.taskId?.slice?.(0, 8) ?? ""}…`, "#3498db");

          // run-task 只做提交：注入 → click send → 记 baseline 到 sessionStorage → 立即返回。
          // 后续 poll 由 SW 的 pending-reply 状态机负责（见 service-worker.js）。
          sendResponse({ status: "submitted", baseline });
        } else {
          sendResponse({ error: `unknown message type: ${msg.type}` });
        }
      } catch (e) {
        console.warn("[relay content] error handling", msg.type, e);
        updateBanner(`错误: ${e.message.slice(0, 40)}`, "#e74c3c");
        setTimeout(() => updateBanner(`Relay: ${getSessionId().slice(0, 8)}…`, "#10a37f"), 5000);
        // 不 clear inflight：让下次刷新有机会回捞
        sendResponse({ error: e.message });
      }
    })();
    return true;
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

  // 页面加载后 1.5s 尝试 inflight 恢复
  setTimeout(() => { void tryRecoverInflight(); }, 1500);

  console.log("[relay content] loaded, session=", getSessionId());
})();
