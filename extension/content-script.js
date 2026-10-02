// extension/content-script.js
// Runs in chatgpt.com for DOM submission, safety detection, status, recovery, and connectivity.
//
// This layer performs synchronous DOM operations and one poll-reply snapshot.
// Replies are attributed by real message IDs and their order after the submitted
// user message. Virtual scrolling can unmount either side of that relationship.
// textContent is used because innerText depends on layout.
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
      '[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-testid]',
      'div[contenteditable="true"]',
    ],
    sendButton: [
      '[data-testid="send-button"]',
      'button[aria-label*="Send"], button[aria-label*="发送"]',
    ],
    attachment: [
      '[data-composer-attachments][data-visible-attachments]',
      '[data-testid="composer-file-pill"]',
      '[data-testid="file-pill"]',
      '[data-testid="file-thumbnail"]',
      '[data-testid="attachment-pill"]',
      '[data-file-id]',
      '[data-file-name]',
      '[class*="file-pill"]',
      'button[aria-label*="Remove file" i]',
      'button[aria-label*="Remove attachment" i]',
      'button[aria-label*="移除文件"]',
      'button[aria-label*="删除附件"]',
    ],
    attachmentRemoveButton: [
      '[data-composer-attachments] button[aria-label^="移除 "]',
      '[data-composer-attachments] button[aria-label^="Remove "]',
      'button[data-testid*="remove-file" i]',
      'button[data-testid*="remove-attachment" i]',
      'button[aria-label*="Remove file" i]',
      'button[aria-label*="Remove attachment" i]',
      'button[aria-label*="移除文件"]',
      'button[aria-label*="删除附件"]',
    ],
    uploadProgress: [
      '[role="progressbar"]',
      '[data-state="uploading"]',
      '[data-upload-state="uploading"]',
      '[aria-label*="Uploading" i]',
      '[aria-label*="正在上传"]',
    ],
    stopButton: [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop"], button[aria-label*="停止"]',
    ],
    generationActivity: [
      '[role="status"]',
      '[data-testid*="thinking" i]',
      '[data-testid*="reasoning" i]',
      '[data-testid*="tool" i]',
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
  const GENERATION_ACTIVITY_PATTERN = /(thinking|searching|browsing|reading|analyzing|working|running|checking|using tool|思考|搜索|浏览|读取|分析|处理中|运行|检查|使用工具)/i;

  const ACTION_DELAY_MIN = 250;
  const ACTION_DELAY_MAX = 900;
  const INFLIGHT_KEY = "gpt_relay_inflight_v3";
  const FETCH_FAIL_THRESHOLD = 3;
  const RELOAD_COOLDOWN_MS = 60_000;
  // document_idle can precede React hydration. After refresh, wait until the
  // conversation DOM and composer remain stable before accepting new work.
  const PAGE_READY_STABLE_MS = 4000;
  const PAGE_READY_TIMEOUT_MS = 60_000;
  const TEXT_SEND_READY_TIMEOUT_MS = 15_000;
  const ATTACHMENT_UPLOAD_TIMEOUT_MS = 90_000;
  const ATTACHMENT_CLEANUP_TIMEOUT_MS = 7_000;
  const ATTACHMENT_CLEAN_STABLE_MS = 2_000;
  const COMPOSER_RESET_TIMEOUT_MS = 3_000;
  const COMPOSER_RESET_STABLE_MS = 400;
  const LARGE_PASTE_ATTACHMENT_THRESHOLD = 20_000;
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
    const root = getComposerRoot();
    if (!root?.querySelectorAll) return null;
    for (const sel of SELECTORS.sendButton) {
      const b = Array.from(root.querySelectorAll(sel)).find(isVisible);
      if (b) return b;
    }
    return Array.from(root.querySelectorAll('button[type="submit"]')).find(isVisible) ?? null;
  }

  function getComposerRoot(inp = findInput()) {
    return inp?.closest?.('[data-type="unified-composer"]') ??
      inp?.closest?.('form') ?? inp?.parentElement ?? inp ?? null;
  }

  function queryComposerAll(root, selectors) {
    if (!root?.querySelectorAll) return [];
    const found = [];
    for (const selector of selectors) {
      try { found.push(...root.querySelectorAll(selector)); } catch { /* selector drift */ }
    }
    return [...new Set(found)];
  }

  function isSendEnabled() {
    const button = findSendButton();
    return !!button && isVisible(button) && !button.disabled &&
      button.getAttribute("aria-disabled") !== "true";
  }

  function getComposerPayloadState(inp = findInput()) {
    const root = getComposerRoot(inp);
    const attachmentNodes = queryComposerAll(root, SELECTORS.attachment);
    const progressNodes = queryComposerAll(root, SELECTORS.uploadProgress);
    const attachmentText = attachmentNodes
      .map((node) => (node.textContent ?? node.innerText ?? "").trim())
      .filter(Boolean)
      .join(" ");
    const uploadError = queryComposerAll(root, ['[role="alert"]', '[data-testid*="error" i]'])
      .map((node) => (node.textContent ?? node.innerText ?? "").trim())
      .find((value) => /upload|attachment|file|上传|附件|文件/i.test(value)) ?? null;
    const uploading = progressNodes.length > 0 ||
      /uploading|processing|正在上传|上传中|处理中/i.test(attachmentText);
    const textLength = (inp?.textContent || inp?.innerText || "").trim().length;
    const attachmentPresent = attachmentNodes.length > 0;
    return {
      attachmentPresent,
      uploading,
      uploadError,
      textLength,
      sendEnabled: isSendEnabled(),
      clean: textLength === 0 && !attachmentPresent && !uploading,
    };
  }

  function makeRelayError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  }

  let userOwnedComposer = readInflight()?.preserveComposer === true;
  function watchComposerEdits(target, inflight) {
    const types = ['beforeinput', 'input', 'paste', 'cut', 'drop', 'change', 'click'];
    const listener = event => {
      if (!event.isTrusted) return; // Relay injection and React upload updates are not user edits.
      const node = event.target;
      const fileChange = event.type === 'change' && node?.type === 'file';
      const inComposer = node === target.input || target.root?.contains?.(node);
      if (!fileChange && (!inComposer ||
          (event.type === 'click' && !node?.closest?.('button, input[type="file"]')))) return;
      target.userModified = true;
      userOwnedComposer = true;
      inflight.preserveComposer = true;
      writeInflight(inflight);
    };
    types.forEach(type => document.addEventListener(type, listener, true));
    return () => types.forEach(type => document.removeEventListener(type, listener, true));
  }

  // Lexical can represent pasted newlines with separate paragraphs instead of
  // text nodes. Ignore that representation difference, but never other edits.
  const normalizePastedText = text => (text ?? '').replace(/\r|\n/g, '').replace(/\u00a0/g, ' ').trim();
  function assertInjectedText(target) {
    const current = normalizePastedText(target.input.textContent);
    if (current && current !== normalizePastedText(target.sourceText)) {
      userOwnedComposer = true;
      throw makeRelayError('submission_payload_changed', 'Composer text changed during preparation');
    }
  }

  function assertSubmissionTarget(target, checkPayload = false) {
    if (target?.userModified) {
      throw makeRelayError('submission_payload_changed', 'User edited the composer during submission');
    }
    if (!target || getSessionId() !== target.session || location.pathname !== target.path ||
        !target.input?.isConnected || findInput() !== target.input ||
        getComposerRoot(target.input) !== target.root || !isVisible(target.input)) {
      throw makeRelayError("submission_target_changed", "Submission conversation or composer changed");
    }
    if (checkPayload) {
      const attachments = queryComposerAll(target.root, SELECTORS.attachment);
      if (target.input.textContent !== target.text || attachments.length !== target.attachments.length ||
          attachments.some((node, index) => node !== target.attachments[index].node ||
            node.textContent !== target.attachments[index].text)) {
        throw makeRelayError("submission_payload_changed", "Composer payload changed before Send");
      }
    }
  }

  function isGenerating() {
    return SELECTORS.stopButton.some((sel) =>
      Array.from(document.querySelectorAll(sel)).some((button) => isVisible(button)),
    );
  }

  function precedes(a, b) {
    const position = a?.compareDocumentPosition?.(b) ?? 0;
    return !(position & 1) && !!(position & 4); // Connected and following.
  }
  function getMessages(role) {
    const legacy = Array.from(document.querySelectorAll(SELECTORS[`${role}Message`]));
    const marker = role === "assistant" ? '[data-conversation-role="assistant"]' : '[data-user-message-bubble]';
    const modern = Array.from(document.querySelectorAll(marker))
      .map(node => node.closest('[data-content-search-unit-key]')).filter(Boolean);
    // File/image-only turns have no text bubble. Their user unit still carries
    // the role suffix and resolves to a real UUID on its enclosing search unit.
    if (role === "user") modern.push(...document.querySelectorAll('[data-content-search-unit-key$=":user"]'));
    const seen = new Set();
    return [...new Set([...legacy, ...modern])].filter(node => {
      const id = getMessageId(node);
      if (id && seen.has(id)) return false;
      if (id) seen.add(id);
      return true;
    }).sort((a, b) => precedes(a, b) ? -1 : precedes(b, a) ? 1 : 0);
  }
  function getAssistantMessages() {
    return getMessages("assistant");
  }
  function getUserMessages() {
    return getMessages("user");
  }
  function isMessageContent(node) {
    // Modern role headings are siblings of the body. Exclude the containing
    // message/search unit rather than relying on a role heading as an ancestor.
    return !!node.closest('[data-message-author-role], [data-user-message-bubble], ' +
      '[data-conversation-role], [data-content-search-unit-key], ' +
      '[data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]');
  }
  function getMessageId(el) {
    const legacyId = el?.getAttribute("data-message-id");
    if (legacyId) return legacyId;
    const selectionIds = Array.from(el?.querySelectorAll?.('[data-chatgpt-selection-message-id]') ?? [])
      .map(node => node.getAttribute("data-chatgpt-selection-message-id")).filter(Boolean);
    const ownSelectionId = el?.getAttribute("data-chatgpt-selection-message-id");
    if (ownSelectionId) selectionIds.push(ownSelectionId);
    if (selectionIds.length) {
      const ids = [...new Set(selectionIds)];
      return ids.length === 1 ? ids[0] : null;
    }
    // Modern user UUIDs live on the enclosing search unit, outside the bubble.
    const source = el?.closest?.('[data-chatgpt-search-message-ids]');
    if (source && (source === el || source.getAttribute("data-chatgpt-search-unit-key") ===
        el.getAttribute("data-content-search-unit-key"))) {
      const ids = [...new Set((source.getAttribute("data-chatgpt-search-message-ids") ?? "").split(/\s+/).filter(Boolean))];
      if (ids.length === 1) return ids[0];
    }
    // Positional fallback-turn keys are presentation identities, not message IDs.
    return null;
  }
  function findSubmittedUser(users, baseline, expectedId = null) {
    const known = new Set([...(baseline.userIds ?? []), baseline.lastUserId].filter(Boolean));
    if (expectedId) return known.has(expectedId) ? null : users.find(user => getMessageId(user) === expectedId) ?? null;
    const anchor = users.find(user => getMessageId(user) === baseline.lastUserId);
    if (!anchor && (baseline.lastUserId || (baseline.userCount ?? 0) !== 0)) return null;
    // Bind only an unambiguous new user after the baseline, never merely a
    // different last mounted user. Once bound, the worker persists its UUID.
    const candidates = users.filter(user => {
      const id = getMessageId(user);
      return id && !known.has(id) && (!anchor || precedes(anchor, user));
    });
    return candidates.length === 1 ? candidates[0] : null;
  }
  function getReplyMessages(messages, users, submittedUser) {
    if (!submittedUser) return [];
    const nextUser = users.find(user => precedes(submittedUser, user));
    const turnKey = node => (node.getAttribute("data-content-search-unit-key") ??
      node.closest?.('[data-content-search-unit-key]')?.getAttribute("data-content-search-unit-key"))
      ?.match(/^(.*):\d+:(?:user|assistant)$/)?.[1] ?? null;
    const userTurn = turnKey(submittedUser);
    return messages.filter(message => precedes(submittedUser, message) &&
      (!nextUser || precedes(message, nextUser)) &&
      // Grouping keys only corroborate the live relationship; they are never
      // persisted as message IDs. This also rejects gaps from virtual scrolling.
      (!userTurn || turnKey(message) === userTurn));
  }
  function getLastText(msgs) {
    if (!msgs.length) return "";
    const el = msgs[msgs.length - 1];
    const content = el.querySelector?.('[data-chatgpt-selection-message-id]') ?? el;
    // innerText depends on layout and may be empty in frozen tabs; textContent does not.
    const t = (content.textContent ?? content.innerText ?? "").replace(/\u00A0/g, " ").trim();
    return t;
  }
  function getGenerationActivity(msgs) {
    const last = msgs[msgs.length - 1];
    if (!last || typeof last.querySelectorAll !== "function") return null;
    for (const selector of SELECTORS.generationActivity) {
      for (const node of last.querySelectorAll(selector)) {
        const text = getVisibleText(node).replace(/\s+/g, " ").trim();
        if (text && text.length <= 120 && GENERATION_ACTIVITY_PATTERN.test(text)) {
          return text;
        }
      }
    }
    return null;
  }
  function getLastAssistantId(msgs) {
    if (!msgs.length) return null;
    return getMessageId(msgs[msgs.length - 1]);
  }
  function getLastUserId(msgs) {
    if (!msgs.length) return null;
    return getMessageId(msgs[msgs.length - 1]);
  }

  function captureBaseline() {
    const assistants = getAssistantMessages();
    const users = getUserMessages();
    return {
      assistantCount: assistants.length,
      lastAssistantId: getLastAssistantId(assistants),
      lastUserId: getLastUserId(users),
      userCount: users.length,
      assistantIds: assistants.map(getMessageId).filter(Boolean),
      userIds: users.map(getMessageId).filter(Boolean),
      startedAt: Date.now(),
    };
  }

  let pageReadyCandidate = null;

  function getPageReadiness(now = Date.now()) {
    const baseline = captureBaseline();
    const generating = isGenerating();
    const input = findInput();
    const composer = getComposerPayloadState(input);
    const conversationRoute = location.pathname.match(/\/c\/([a-f0-9-]+)/);
    if (composer.clean) userOwnedComposer = false;

    let reason = null;
    if (!managedRouteMatches()) {
      reason = "creation-route-mismatch";
    } else if (document.readyState !== "complete") {
      reason = "document-loading";
    } else if (generating) {
      reason = "generating";
    } else if (!input || !isVisible(input)) {
      reason = "composer-loading";
    } else if (userOwnedComposer && !composer.clean) {
      reason = "composer-user-edit";
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
        session: getSessionId(),
        ready: false,
        reason,
        stableForMs: 0,
        generating,
        baseline,
        composer,
        composerClean: !!input && composer.clean,
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
      session: getSessionId(),
      ready,
      reason: ready ? null : "page-stabilizing",
      stableForMs,
      generating,
      baseline,
      composer,
      composerClean: composer.clean,
    };
  }

  function routeConversation() {
    return location.pathname.match(/\/c\/([a-f0-9-]+)/)?.[1] ?? null;
  }
  function routeProject() {
    return location.pathname.match(/\/g\/(g-p-[a-f0-9]{32})(?:-[^/]*)?(?:\/|$)/i)?.[1].toLowerCase() ?? null;
  }
  function managedSession() {
    try {
      const marker = (location.hash ?? "").match(/^#relay-create=(.+)$/)?.[1];
      const saved = sessionStorage.getItem("gpt_relay_managed");
      if (saved) return JSON.parse(saved);
      if (marker) {
        const m = JSON.parse(decodeURIComponent(marker));
        if (/^sr_[A-Za-z0-9_-]{1,120}$/.test(m.sessionRef) && typeof m.token === "string" && typeof m.owner === "string") {
          sessionStorage.setItem("gpt_relay_managed", JSON.stringify(m));
          return m;
        }
      }
    } catch { /* An invalid marker must not change the page identity. */ }
    return null;
  }
  function managedRouteMatches() {
    const m = managedSession();
    if (!m) return true;
    const project = routeProject();
    const conversation = routeConversation();
    if (project !== m.projectId) return false;
    if (m.boundConversation && conversation !== m.boundConversation) return false;
    if (!conversation && !project && location.pathname !== "/") return false;
    return true;
  }
  function sessionMetadata() {
    const inflight = readInflight();
    const baseline = captureBaseline();
    const managed = managedSession();
    return { session: getSessionId(), managed, conversationId: routeConversation(), projectId: routeProject(),
      hasHistory: baseline.userCount + baseline.assistantCount > 0,
      postSend: !!inflight && inflight.session === getSessionId() &&
        (!managed || inflight.taskId === managed.initialTaskId) && inflight.phase !== "preparing" };
  }
  function configureManagedSession(m) {
    const old = managedSession();
    if (!m || !/^sr_[A-Za-z0-9_-]{1,120}$/.test(m.sessionRef) || typeof m.token !== "string" ||
      typeof m.owner !== "string" || (old && (old.sessionRef !== m.sessionRef || old.token !== m.token))) {
      throw new Error("managed session configuration conflict");
    }
    sessionStorage.setItem("gpt_relay_managed", JSON.stringify({ ...m, boundConversation: m.boundConversation ?? old?.boundConversation }));
    reportSid();
  }
  function getSessionId() {
    const managed = managedSession();
    if (managed && managedRouteMatches()) return managed.sessionRef;
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
  async function waitForPageReady(target)  {
    return waitForCondition(() => {
      if (target) assertSubmissionTarget(target);
      const state = getPageReadiness();
      return state.ready && !state.generating ? state : null;
    }, PAGE_READY_TIMEOUT_MS, 250, "waitForPageReady");
  }
  async function waitForSendReady(target)  { return waitForCondition(() => {
    if (target) assertSubmissionTarget(target, true);
    const b = findSendButton();
    if (b && isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true") return b;
    return null;
  }, 10000, 200, "waitForSendReady"); }

  async function waitForSendEnabledAfterPaste(inp, text, target) {
    const startedAt = Date.now();
    const textDeadline = startedAt + TEXT_SEND_READY_TIMEOUT_MS;
    const attachmentDeadline = startedAt + ATTACHMENT_UPLOAD_TIMEOUT_MS;
    const sourceLength = text.trim().length;
    let state = getComposerPayloadState(inp);
    let attachmentMode = state.attachmentPresent || state.uploading ||
      (sourceLength >= LARGE_PASTE_ATTACHMENT_THRESHOLD &&
        state.textLength < Math.min(10, sourceLength));
    let attachmentObserved = state.attachmentPresent || state.uploading;

    while (true) {
      assertSubmissionTarget(target);
      assertInjectedText(target);
      const block = findSafetyBlock();
      if (block) throw new Error(`check-send-enabled: safety block: ${block.reason}`);
      state = getComposerPayloadState(inp);
      attachmentObserved ||= state.attachmentPresent || state.uploading;
      attachmentMode ||= attachmentObserved ||
        (sourceLength >= LARGE_PASTE_ATTACHMENT_THRESHOLD &&
          state.textLength < Math.min(10, sourceLength));
      if (state.uploadError) {
        throw makeRelayError(
          "attachment_upload_failed",
          `Attachment upload failed: ${state.uploadError}`,
          { attachmentObserved, attachmentLikely: attachmentMode },
        );
      }
      if (state.sendEnabled) {
        return { attachmentMode, attachmentObserved, state };
      }

      const deadline = attachmentMode ? attachmentDeadline : textDeadline;
      if (Date.now() >= deadline) break;
      await delay(200);
    }

    if (attachmentMode) {
      throw makeRelayError(
        "attachment_upload_timeout",
        `Attachment upload did not enable Send within ${ATTACHMENT_UPLOAD_TIMEOUT_MS}ms`,
        { attachmentObserved, attachmentLikely: true },
      );
    }
    return null;
  }

  function clearComposerText(inp) {
    if (!inp) return;
    try {
      inp.focus?.({ preventScroll: true });
      if (document.activeElement === inp) {
        document.execCommand?.("selectAll", false);
        document.execCommand?.("delete", false);
      }
    } catch { /* fall through to DOM cleanup */ }
    try {
      while (inp.firstChild) inp.removeChild(inp.firstChild);
      inp.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "deleteContentBackward",
        data: null,
      }));
    } catch { /* best effort */ }
  }

  async function resetComposer(
    timeoutMs = COMPOSER_RESET_TIMEOUT_MS,
    stableMs = COMPOSER_RESET_STABLE_MS,
    target = null,
  ) {
    if (target) assertSubmissionTarget(target);
    const inp = findInput();
    if (!inp) return { clean: false, attachmentObserved: false };
    const root = getComposerRoot(inp);
    const before = getComposerPayloadState(inp);
    const attachmentObserved = before.attachmentPresent || before.uploading;
    if (before.clean) return { clean: true, attachmentObserved };
    const removeButtons = queryComposerAll(root, SELECTORS.attachmentRemoveButton)
      .filter((button) => isVisible(button));
    for (const button of removeButtons) {
      try { button.click(); } catch { /* best effort */ }
    }
    clearComposerText(inp);

    let cleanSince = null;
    const cleared = await waitForCondition(() => {
      if (target) assertSubmissionTarget(target);
      const state = getComposerPayloadState(inp);
      if (!state.clean) {
        cleanSince = null;
        return null;
      }
      cleanSince ??= Date.now();
      return Date.now() - cleanSince >= stableMs ? state : null;
    }, timeoutMs, 200, "composer-reset").catch(() => null);

    return { clean: !!cleared, attachmentObserved };
  }

  async function cleanupAfterAttachmentFailure(error, target) {
    const result = await resetComposer(
      ATTACHMENT_CLEANUP_TIMEOUT_MS,
      ATTACHMENT_CLEAN_STABLE_MS,
      target,
    );
    // If no attachment/upload DOM was ever observed, an empty composer is not
    // enough to prove that an asynchronous large-paste upload cannot reappear.
    return (error?.attachmentObserved === true || result.attachmentObserved) && result.clean;
  }

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
  async function pasteIntoInput(text, target) {
    await waitForPageReady(target);
    const inp = await waitForInput();
    assertSubmissionTarget(target);

    if (!document.hidden) {
      inp.scrollIntoView({ block: "center", inline: "nearest" });
      await pacedDelay(120, 300);
      assertSubmissionTarget(target);
      inp.click();
    }
    try { inp.focus({ preventScroll: true }); } catch { /* ignore */ }
    await pacedDelay(50, 150);
    assertSubmissionTarget(target);

    // Keep the selection inside the composer for the Lexical paste handler.
    try {
      const sel = getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(inp);
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

    const injected = (inp.textContent || inp.innerText || "").trim();
    // Large pastes may become attachments and leave the composer empty. Keep
    // the normal text budget short, but allow an attachment-aware upload window.
    const sendReady = await waitForSendEnabledAfterPaste(inp, text, target);

    if (!sendReady) {
      const suffix = injected.length === 0
        ? "(composer is empty and no attachment was uploaded)"
        : `(composer DOM length=${injected.length}; Lexical state did not synchronize)`;
      throw new Error(`Prompt injection method ${method} did not enable Send ${suffix}`);
    }

    const asAttachment = sendReady.attachmentMode ||
      injected.length < Math.min(10, text.trim().length);
    console.log(
      `[relay content] injected via ${method}, DOM len=${injected.length}` +
        (asAttachment ? " (likely converted to attachment)" : ""),
    );
    target.text = inp.textContent;
    target.attachments = queryComposerAll(target.root, SELECTORS.attachment)
      .map(node => ({ node, text: node.textContent }));
    return { asAttachment };
  }
  async function clickSend(target) {
    const b = await waitForSendReady(target);
    if (!document.hidden) b.scrollIntoView({ block: "center", inline: "nearest" });
    await pacedDelay(200, 500);
    // No await between this check and the click: SPA navigation, editor remounts,
    // user edits and button replacement during the fence/delay must fail closed.
    assertSubmissionTarget(target, true);
    if (findSendButton() !== b || !isSendEnabled()) {
      throw makeRelayError("submission_target_changed", "Send button changed before submission");
    }
    b.click();
    return true;
  }

  async function waitForSubmissionAccepted(baseline) {
    return waitForCondition(() => {
      const users = getUserMessages();
      const submittedUser = findSubmittedUser(users, baseline);
      if (submittedUser) {
        return {
          kind: "user-message",
          submittedUserMessageId: getMessageId(submittedUser),
        };
      }
      if (isGenerating()) {
        return {
          kind: "generating",
          submittedUserMessageId: null,
        };
      }
      return null;
    }, SUBMISSION_ACCEPT_TIMEOUT_MS, 250, "waitForSubmissionAccepted");
  }

  // Recover the previous in-flight task after page load.
  async function tryRecoverInflight() {
    const rec = readInflight();
    if (!rec) return;
    const currentSession = getSessionId();
    const conversationChanged = rec.session !== currentSession;
    console.log("[relay content] found inflight from previous session", rec);
    updateBanner(`Recovering: ${rec.taskId.slice(0, 8)}…`, "#f39c12");

    try {
      await waitForCondition(() => document.body ? true : null, 10000, 200, "wait body");
      const result = await chrome.runtime.sendMessage({
        type: "recover-inflight",
        taskId: rec.taskId,
        recordedSession: rec.session,
        currentSession,
        conversationChanged,
        baseline: rec.baseline ?? {},
        deliveryPhase: rec.phase ?? "unknown",
        submittedAt: rec.submittedAt,
        submittedUserMessageId: rec.submittedUserMessageId ?? null,
        stopRequestedAt: rec.stopRequestedAt ?? null,
        composerPayloadObservedAfterFailure:
          rec.composerPayloadObservedAfterFailure === true,
      });
      if (result?.error) throw new Error(result.error);
      if (result?.action === "clear" || result?.action === "deferred") {
        clearInflight();
        return;
      }
      if (result?.action === "reattached") {
        const uncertain = result.deliveryPhase === "unknown" ||
          result.deliveryPhase === "send-attempted" ||
          result.deliveryPhase === "send-fenced" ||
          result.deliveryPhase === "send-clicked";
        updateBanner(
          uncertain
            ? `Delivery uncertain; observing: ${rec.taskId.slice(0, 8)}…`
            : `Waiting for reply: ${rec.taskId.slice(0, 8)}…`,
          uncertain ? "#f39c12" : "#3498db",
        );
      }
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
            if (msg.expectedSession && msg.expectedSession !== getSessionId()) {
              sendResponse({
                status: "session-mismatch",
                expectedSession: msg.expectedSession,
                currentSession: getSessionId(),
              });
              return;
            }
            const block = findSafetyBlock();
            if (block) {
              sendResponse({ status: "safety", reason: block.reason });
              return;
            }
            const readiness = getPageReadiness();
            if (!readiness.ready && !readiness.generating) {
              sendResponse({
                status: "page-unready",
                reason: readiness.reason,
                stableForMs: readiness.stableForMs,
                composer: readiness.composer,
                composerClean: readiness.composerClean,
              });
              return;
            }
            const baseline = msg.baseline ?? { assistantCount: 0, lastAssistantText: "", lastAssistantId: null, userCount: 0 };
            const msgs = getAssistantMessages();
            const users = getUserMessages();
            const generating = readiness.generating;
            const expectedUserId = msg.submittedUserMessageId ?? null;
            const submittedUser = findSubmittedUser(users, baseline, expectedUserId);
            const currentUserId = getMessageId(submittedUser);
            const hasNewUser = !!submittedUser;
            const replies = getReplyMessages(msgs, users, submittedUser);
            const lastId = getLastAssistantId(replies);
            const knownAssistantIds = new Set([...(baseline.assistantIds ?? []), baseline.lastAssistantId].filter(Boolean));
            const hasNewAssistant = !!lastId && !knownAssistantIds.has(lastId);
            const lastText = getLastText(replies);
            if (generating) {
              const activity = getGenerationActivity(replies);
              const outputChars = hasNewAssistant
                ? Math.max(0, lastText.length - (activity?.length ?? 0))
                : 0;
              sendResponse({
                status: "generating",
                lastText: lastText,
                activity,
                outputChars,
                assistantCount: msgs.length,
                submittedUserMessageId: hasNewUser ? currentUserId : expectedUserId,
              });
              return;
            }
            if (!hasNewUser && !hasNewAssistant) {
              sendResponse({
                status: "not-started",
                lastText: lastText,
                assistantCount: msgs.length,
                composer: readiness.composer,
                composerClean: readiness.composerClean,
              });
              return;
            }
            if (hasNewAssistant) {
              sendResponse({ status: "reply-ready", reply: lastText, assistantCount: msgs.length,
                assistantMessageId: lastId, submittedUserMessageId: currentUserId });
              return;
            }
            sendResponse({
              status: "posted-no-reply-yet",
              lastText: lastText,
              assistantCount: msgs.length,
              submittedUserMessageId: currentUserId ?? expectedUserId,
            });
          } catch (e) {
            sendResponse({ error: e.message });
          }
          return;
        }
        if (msg.type === "clear-inflight") {
          clearInflight();
          try { updateBanner(`Relay: ${getSessionId().slice(0, 8)}…`, "#10a37f"); } catch {}
          sendResponse({ status: "ok" });
        } else if (msg.type === "reset-composer") {
          const rec = readInflight();
          if (msg.expectedSession && (msg.expectedSession !== getSessionId() ||
              rec?.taskId !== msg.taskId || rec?.preserveComposer)) {
            sendResponse({ clean: false, attachmentObserved: false });
          } else {
            const input = findInput();
            const target = msg.expectedSession ? {
              session: msg.expectedSession, path: location.pathname, input, root: getComposerRoot(input),
            } : null;
            sendResponse(await resetComposer(COMPOSER_RESET_TIMEOUT_MS, COMPOSER_RESET_STABLE_MS, target));
          }
        } else if (msg.type === "configure-session") {
          configureManagedSession(msg.managed);
          sendResponse(sessionMetadata());
        } else if (msg.type === "discover-projects") {
          const projects = [];
          for (const link of document.querySelectorAll('a[href]')) {
            if (!isVisible(link) || isMessageContent(link)) continue;
            let url;
            try { url = new URL(link.getAttribute("href"), "https://chatgpt.com" + location.pathname); }
            catch { continue; }
            const id = url.origin === "https://chatgpt.com" && url.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[^/]+)?\/project\/?$/i)?.[1]?.toLowerCase();
            const name = (link.innerText ?? "").trim().replace(/\s+/g, " ");
            if (id && name && name.length <= 200) projects.push({ projectId: id, name, href: url.origin + url.pathname });
          }
          for (const row of document.querySelectorAll('[data-app-action-sidebar-project-row]')) {
            if (!isVisible(row) || isMessageContent(row)) continue;
            const id = row.getAttribute("data-app-action-sidebar-project-id")?.toLowerCase();
            const label = row.getAttribute("data-app-action-sidebar-project-label")?.trim().replace(/\s+/g, " ");
            const name = row.querySelector('[data-marquee-content]')?.innerText?.trim().replace(/\s+/g, " ");
            if (/^g-p-[a-f0-9]{32}$/.test(id ?? "") && name && name === label && name.length <= 200) {
              projects.push({ projectId: id, name, href: `https://chatgpt.com/g/${id}/project`, kind: "sidebar-row" });
            }
          }
          sendResponse({ url: "https://chatgpt.com" + location.pathname, projects,
            ...(document.readyState !== "complete" ? { error: "page_not_loaded" } : {}) });
        } else if (msg.type === "get-session-id") {
          sendResponse(sessionMetadata());
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
          const target = {
            session: msg.expectedSession ?? getSessionId(),
            path: location.pathname,
            input: findInput(),
            sourceText: msg.text,
          };
          target.root = getComposerRoot(target.input);
          const inflight = {
            taskId: msg.taskId,
            session: getSessionId(),
            submittedAt: Date.now(),
            baseline,
            phase: "preparing",
          };
          writeInflight(inflight);
          const stopWatching = watchComposerEdits(target, inflight);

          try {
            assertSubmissionTarget(target);
            const reset = await resetComposer(COMPOSER_RESET_TIMEOUT_MS, COMPOSER_RESET_STABLE_MS, target);
            if (!reset.clean) {
              if (reset.attachmentObserved) {
                throw makeRelayError(
                  "attachment_cleanup_incomplete",
                  "Composer attachment could not be cleared before submission",
                  { attachmentObserved: true },
                );
              }
              console.warn("[relay content] continuing after incomplete composer reset");
            }
            const pasteResult = await pasteIntoInput(msg.text, target);
            inflight.attachmentMode = pasteResult?.asAttachment === true;
            writeInflight(inflight);
            await pacedDelay(500, 1200);
            assertSubmissionTarget(target, true);
            inflight.phase = "send-attempted";
            inflight.sendAttemptedAt = Date.now();
            writeInflight(inflight);
            const fence = await chrome.runtime.sendMessage({
              type: "send-attempted",
              taskId: msg.taskId,
              baseline,
            });
            if (fence?.status !== "fenced") {
              throw new Error(`send fence failed: ${fence?.error ?? "no acknowledgement"}`);
            }
            inflight.phase = "send-fenced";
            inflight.sendFencedAt = Date.now();
            writeInflight(inflight);
            await clickSend(target);
            inflight.phase = "send-clicked";
            inflight.sendClickedAt = Date.now();
            writeInflight(inflight);
            const acceptance = await waitForSubmissionAccepted(baseline);
            inflight.phase = "accepted";
            inflight.acceptedAt = Date.now();
            inflight.acceptanceKind = acceptance.kind;
            inflight.submittedUserMessageId = acceptance.submittedUserMessageId;
            writeInflight(inflight);
            updateBanner(`Waiting for reply: ${msg.taskId?.slice?.(0, 8) ?? ""}…`, "#3498db");

            // run-task only submits, records the baseline, and returns. The
            // service worker owns all subsequent reply polling.
            sendResponse({
              ...sessionMetadata(),
              status: "submitted",
              baseline,
              submissionState: "accepted",
              acceptanceKind: acceptance.kind,
              submittedUserMessageId: acceptance.submittedUserMessageId,
            });
          } catch (e) {
            console.warn("[relay content] run-task failed", e);
            updateBanner(`Error: ${e.message.slice(0, 40)}`, "#e74c3c");
            const failedComposer = (() => {
              try { assertSubmissionTarget(target); } catch { return null; }
              const input = findInput();
              return input ? getComposerPayloadState(input) : null;
            })();
            const composerPayloadObserved = failedComposer?.clean === false;
            inflight.composerPayloadObservedAfterFailure = composerPayloadObserved;
            inflight.preserveComposer = e.code === "submission_target_changed" ||
              e.code === "submission_payload_changed" || target.userModified === true;
            if (inflight.preserveComposer) userOwnedComposer = true;
            writeInflight(inflight);
            if (inflight.phase !== "preparing") {
              await chrome.runtime.sendMessage({
                type: "submission-failed-evidence",
                taskId: msg.taskId,
                composerPayloadObserved,
              }).catch(() => {});
            }
            const attachmentFailure = e.code === "attachment_upload_timeout" ||
              e.code === "attachment_upload_failed" ||
              e.code === "attachment_cleanup_incomplete";
            const attachmentCleanupConfirmed = attachmentFailure
              ? await cleanupAfterAttachmentFailure(e, target).catch(() => false)
              : null;
            if (!attachmentFailure && !inflight.preserveComposer) {
              const reset = await resetComposer(COMPOSER_RESET_TIMEOUT_MS, COMPOSER_RESET_STABLE_MS, target)
                .catch(() => ({ clean: false }));
              if (!reset.clean) {
                console.warn("[relay content] post-failure composer reset incomplete");
              }
            }
            sendResponse({
              ...sessionMetadata(),
              error: e.message,
              errorCode: typeof e.code === "string" ? e.code : null,
              attachmentCleanupConfirmed,
              composerPayloadObserved,
              baseline,
              submissionState: inflight.phase === "preparing"
                ? "not-submitted"
                : "send-attempted",
            });
          } finally {
            stopWatching();
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
  let lastReportedPath = "";
  function reportSid() {
    const sid = getSessionId();
    const path = location.pathname;
    if (sid === lastReportedSid && path === lastReportedPath) return;
    lastReportedSid = sid;
    lastReportedPath = path;
    chrome.runtime.sendMessage({ type: "session-hello", ...sessionMetadata() })
      .then((response) => {
        const managed = managedSession();
        if (managed && response?.conversationId) {
          managed.boundConversation = response.conversationId;
          sessionStorage.setItem("gpt_relay_managed", JSON.stringify(managed));
        }
        if (response?.status !== "ok" &&
          lastReportedSid === sid && lastReportedPath === path) {
          lastReportedSid = "";
          lastReportedPath = "";
        }
      })
      .catch(() => {
        if (lastReportedSid === sid && lastReportedPath === path) {
          lastReportedSid = "";
          lastReportedPath = "";
        }
      });
    updateBanner(`Relay: ${sid.slice(0, 8)}…`);
  }
  reportSid();
  chrome.runtime.sendMessage({ type: "get-managed-session" }).then(response => {
    if (response?.managed) configureManagedSession(response.managed);
  }).catch(() => {});
  setInterval(reportSid, 3000);

  // Attempt in-flight recovery shortly after page load.
  setTimeout(() => { void tryRecoverInflight(); }, 1500);

  console.log("[relay content] loaded, session=", getSessionId());
})();
