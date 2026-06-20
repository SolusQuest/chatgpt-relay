// ==UserScript==
// @name         ChatGPT Auto Relay
// @namespace    cgcon
// @version      2.5
// @description  自动接收本地中继服务的任务，填入 ChatGPT 并提交回复
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    const BASE = 'http://localhost:8765';
    const POLL_IDLE_MIN_MS = 2500;
    const POLL_IDLE_MAX_MS = 5500;
    const POLL_BUSY_MIN_MS = 5000;
    const POLL_BUSY_MAX_MS = 9000;
    const POLL_ERROR_MIN_MS = 8000;
    const POLL_ERROR_MAX_MS = 20000;
    const SAFETY_PAUSE_MIN_MS = 60000;
    const SAFETY_PAUSE_MAX_MS = 120000;
    const STATUS_REPORT_MIN_MS = 15000;
    const ACTION_DELAY_MIN_MS = 250;
    const ACTION_DELAY_MAX_MS = 900;
    const REPLY_STABLE_MS = 2000;
    const HEARTBEAT_MS = 25000;
    const SAFETY_PATTERNS = [
        { reason: '页面要求人机验证', pattern: /captcha|verify (that )?(you['’]?re|you are) human|verify you are human|human verification|请验证|人机验证|验证码/i },
        { reason: '页面提示异常活动', pattern: /unusual activity|suspicious activity|异常活动|可疑活动/i },
        { reason: '页面提示请求过多', pattern: /too many requests|request limit|rate limit|频率限制|请求过多/i },
        { reason: '页面提示使用限制', pattern: /message cap|usage limit|(you['’]?ve|you have) reached (the )?(current )?(usage )?limit|reached.*limit|使用上限|消息上限|达到.*限制/i },
        { reason: '页面提示稍后再试', pattern: /try again later|please try again later|稍后再试|请稍后/i },
        { reason: '页面提示账号或访问受限', pattern: /access denied|account.*disabled|account.*deactivated|访问被拒绝|账号.*停用|账户.*停用/i }
    ];

    // ── DOM 选择器集中配置 ──
    const SELECTORS = {
        input: [
            '#prompt-textarea',
            '[contenteditable="true"][data-testid]',
            'div[contenteditable="true"]'
        ],
        sendButton: [
            '[data-testid="send-button"]',
            'button[aria-label*="Send"], button[aria-label*="发送"]'
        ],
        stopButton: [
            '[data-testid="stop-button"]',
            'button[aria-label*="Stop"], button[aria-label*="停止"]'
        ],
        assistantMessage: '[data-message-author-role="assistant"]',
        userMessage: '[data-message-author-role="user"]',
        safetyAlerts: [
            '[role="alert"]',
            '[role="dialog"]',
            '[aria-live="assertive"]',
            '[aria-live="polite"]',
            '[data-testid*="toast"]',
            '[data-testid*="error"]',
            '[data-testid*="banner"]',
            '[class*="toast"]',
            '[class*="error"]',
            '[class*="banner"]'
        ]
    };

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function randomBetween(min, max) {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    function pacedDelay(min = ACTION_DELAY_MIN_MS, max = ACTION_DELAY_MAX_MS) {
        return delay(randomBetween(min, max));
    }

    let heartbeatTimer = null;
    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
            reportSessionStatus(false);
        }, HEARTBEAT_MS);
    }
    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    // ── Session ID 提取 ──
    function getSessionId() {
        const url = window.location.pathname;
        const chatgptMatch = url.match(/\/c\/([a-f0-9-]+)/);
        if (chatgptMatch) return chatgptMatch[1];
        let sid = sessionStorage.getItem('relay_session_id');
        if (!sid) {
            sid = crypto.randomUUID();
            sessionStorage.setItem('relay_session_id', sid);
        }
        return sid;
    }

    let sessionId = getSessionId();
    let isProcessing = false;
    let isPolling = false;
    let pollTimer = null;
    let pollErrorCount = 0;
    let lastStatusReportKey = '';
    let lastStatusReportAt = 0;

    function schedulePoll(min = POLL_IDLE_MIN_MS, max = POLL_IDLE_MAX_MS) {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(pollTask, randomBetween(min, max));
    }

    function getAssistantMessages() {
        return Array.from(document.querySelectorAll(SELECTORS.assistantMessage));
    }

    function getUserMessages() {
        return Array.from(document.querySelectorAll(SELECTORS.userMessage));
    }

    function getLastMessageText(messages) {
        if (messages.length === 0) return '';
        return messages[messages.length - 1].innerText.trim();
    }

    function getVisibleText(el) {
        if (!el || !isElementVisible(el)) return '';
        return (el.innerText || el.textContent || '').trim();
    }

    function findSafetyBlock() {
        const inputEl = findInput();
        for (const selector of SELECTORS.safetyAlerts) {
            for (const el of document.querySelectorAll(selector)) {
                // 跳过包含输入框的容器，避免注入的 prompt 文本触发误报
                if (inputEl && el.contains(inputEl)) continue;
                const text = getVisibleText(el);
                if (!text) continue;
                for (const item of SAFETY_PATTERNS) {
                    if (item.pattern.test(text)) {
                        return {
                            reason: item.reason,
                            text: text.slice(0, 240).replace(/\s+/g, ' ')
                        };
                    }
                }
            }
        }
        return null;
    }

    function assertNoSafetyBlock(context) {
        const block = findSafetyBlock();
        if (!block) return;
        reportSessionStatus(true, `${block.reason}: ${block.text}`);
        throw new Error(`${context}: ${block.reason}，已停止自动操作。提示: ${block.text}`);
    }

    function findInput() {
        for (const sel of SELECTORS.input) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    function findSendButton() {
        let btn = null;
        for (const sel of SELECTORS.sendButton) {
            btn = document.querySelector(sel);
            if (btn) break;
        }
        if (!btn) {
            const input = findInput();
            if (input) {
                const form = input.closest('form');
                if (form) btn = form.querySelector('button[type="submit"], button:last-of-type');
            }
        }
        return btn;
    }

    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0
            && rect.height > 0
            && style.visibility !== 'hidden'
            && style.display !== 'none';
    }

    function isGenerating() {
        return Boolean(SELECTORS.stopButton.some(sel => document.querySelector(sel)));
    }

    async function waitForInput(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            assertNoSafetyBlock('等待输入框时检测到限制');
            const input = findInput();
            if (input && isElementVisible(input)) return input;
            await delay(200);
        }
        throw new Error('找不到输入框');
    }

    async function waitForPageReady(timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            assertNoSafetyBlock('等待页面空闲时检测到限制');
            if (!isGenerating()) return;
            await delay(500);
        }
        throw new Error('页面仍在生成上一条回复');
    }

    async function waitForSendButton(timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            assertNoSafetyBlock('等待发送按钮时检测到限制');
            const btn = findSendButton();
            if (btn && isElementVisible(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                return btn;
            }
            await delay(200);
        }
        return null;
    }

    // ── UI Banner ──
    const banner = document.createElement('div');
    banner.style.cssText = `
        position: fixed; top: 0; left: 50%; transform: translateX(-50%);
        background: #10a37f; color: white; padding: 4px 16px; border-radius: 0 0 8px 8px;
        font-size: 13px; z-index: 99999; font-family: monospace;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3); pointer-events: none;
    `;
    banner.textContent = `Relay: ${sessionId.slice(0, 8)}...`;
    document.body.appendChild(banner);

    function updateBanner(text, color) {
        banner.textContent = text;
        banner.style.background = color || '#10a37f';
    }

    function reportSessionStatus(paused, reason = null) {
        const now = Date.now();
        const key = `${sessionId}|${paused ? 'paused' : 'ready'}|${reason || ''}`;
        if (key === lastStatusReportKey && now - lastStatusReportAt < STATUS_REPORT_MIN_MS) return;

        lastStatusReportKey = key;
        lastStatusReportAt = now;

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${BASE}/session_status`,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            data: JSON.stringify({ session: sessionId, paused, reason }),
            onerror: function() {
                console.warn('[Relay] session 状态上报失败');
            }
        });
    }

    // ── 文本注入（execCommand，正确处理 Unicode/CJK）──
    async function pasteIntoInput(text) {
        assertNoSafetyBlock('注入文本前检测到限制');
        await waitForPageReady();
        const input = await waitForInput();

        input.scrollIntoView({ block: 'center', inline: 'nearest' });
        await pacedDelay(150, 450);
        input.click();
        input.focus();
        await pacedDelay(80, 220);

        // 选中所有已有内容
        const sel = window.getSelection();
        if (sel) sel.selectAllChildren(input);
        await pacedDelay(80, 200);

        // 用 execCommand 替换选区内容，正确处理 Unicode
        const ok = document.execCommand('insertText', false, text);

        if (!ok) {
            // fallback: 通过剪贴板 API
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            input.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt
            }));
        }

        try {
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        } catch {
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await pacedDelay(300, 700);

        // 验证注入结果
        const injected = input.innerText.trim();
        if (injected.length < Math.min(10, text.trim().length)) {
            throw new Error('文本注入失败，输入框内容为空');
        }
        assertNoSafetyBlock('注入文本后检测到限制');
    }

    // ── 点击发送 ──
    async function clickSend() {
        const btn = await waitForSendButton();
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center', inline: 'nearest' });
        await pacedDelay(250, 850);
        btn.click();
        return true;
    }

    // ── 检测回复完成 ──
    function waitForReply(baseline) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                observer.disconnect();
                reject(new Error('等待回复超时 (3 分钟)'));
            }, 180000);

            let stableTimer = null;
            let lastCandidateText = '';

            function checkStable() {
                try {
                    assertNoSafetyBlock('等待回复时检测到限制');
                } catch (e) {
                    cleanupAndReject(e);
                    return;
                }

                const stopBtn = SELECTORS.stopButton.reduce((found, sel) =>
                    found || document.querySelector(sel), null);
                if (stopBtn) {
                    if (stableTimer) {
                        clearTimeout(stableTimer);
                        stableTimer = null;
                    }
                    return;
                }

                const msgs = getAssistantMessages();
                const userMsgs = getUserMessages();
                if (msgs.length === 0) return;

                const lastMsg = getLastMessageText(msgs);
                if (!lastMsg) return;

                const hasNewAssistantNode = msgs.length > baseline.assistantCount;
                const hasSubmittedUserMessage = userMsgs.length > baseline.userCount
                    || Date.now() - baseline.startedAt > 2000;
                const hasChangedLastAssistant = lastMsg !== baseline.lastAssistantText;
                if (!hasNewAssistantNode && !(hasSubmittedUserMessage && hasChangedLastAssistant)) return;

                if (lastMsg !== lastCandidateText) {
                    lastCandidateText = lastMsg;
                    if (stableTimer) clearTimeout(stableTimer);
                    stableTimer = setTimeout(() => {
                        observer.disconnect();
                        clearTimeout(timeout);
                        resolve(lastMsg);
                    }, REPLY_STABLE_MS);
                } else if (!stableTimer) {
                    stableTimer = setTimeout(() => {
                        observer.disconnect();
                        clearTimeout(timeout);
                        resolve(lastMsg);
                    }, REPLY_STABLE_MS);
                }
            }

            function cleanupAndReject(error) {
                if (stableTimer) clearTimeout(stableTimer);
                observer.disconnect();
                clearTimeout(timeout);
                reject(error);
            }

            const target = document.querySelector('main') || document.body;
            const observer = new MutationObserver(() => checkStable());
            observer.observe(target, { childList: true, subtree: true, characterData: true });

            try {
                checkStable();
            } catch (e) {
                cleanupAndReject(e);
            }
        });
    }

    // ── 主循环：轮询任务 ──
    function pollTask() {
        if (isProcessing || isPolling) {
            schedulePoll(POLL_BUSY_MIN_MS, POLL_BUSY_MAX_MS);
            return;
        }

        const safetyBlock = findSafetyBlock();
        if (safetyBlock) {
            reportSessionStatus(true, `${safetyBlock.reason}: ${safetyBlock.text}`);
            updateBanner(`暂停: ${safetyBlock.reason}`, '#8e44ad');
            console.warn('[Relay] 检测到限制提示，暂停自动操作:', safetyBlock);
            schedulePoll(SAFETY_PAUSE_MIN_MS, SAFETY_PAUSE_MAX_MS);
            return;
        }

        const newSid = getSessionId();
        if (newSid !== sessionId) {
            sessionId = newSid;
            lastStatusReportKey = '';
            banner.textContent = `Relay: ${sessionId.slice(0, 8)}...`;
        }

        reportSessionStatus(false);

        GM_xmlhttpRequest({
            method: 'GET',
            url: `${BASE}/get_task?session=${sessionId}`,
            headers: { 'Accept': 'application/json; charset=utf-8' },
            overrideMimeType: 'application/json; charset=utf-8',
            onload: function(res) {
                isPolling = false;
                try {
                    const data = JSON.parse(res.responseText);
                    pollErrorCount = 0;
                    if (data.paused) {
                        updateBanner(`暂停: ${data.pauseReason || 'server paused'}`, '#8e44ad');
                        schedulePoll(POLL_IDLE_MIN_MS, POLL_IDLE_MAX_MS);
                        return;
                    }
                    if (data.text && data.taskId) {
                        processTask(data.taskId, data.text);
                        return;
                    }
                } catch (e) {
                    console.error('[Relay] 解析任务失败:', e);
                    pollErrorCount++;
                }
                schedulePoll();
            },
            onerror: function() {
                isPolling = false;
                pollErrorCount++;
                const backoff = Math.min(POLL_ERROR_MAX_MS, POLL_ERROR_MIN_MS + pollErrorCount * 2000);
                schedulePoll(backoff, backoff + 4000);
            }
        });
        isPolling = true;
    }

    async function processTask(taskId, text) {
        isProcessing = true;
        startHeartbeat();
        console.log(`[Relay] 收到任务 ${taskId}, 文本长度 ${text.length}, 前20字: ${text.slice(0, 20)}`);
        updateBanner(`处理中: ${taskId}`, '#e67e22');

        try {
            assertNoSafetyBlock('处理任务前检测到限制');
            await pasteIntoInput(text);
            await pacedDelay(700, 1600);
            assertNoSafetyBlock('发送任务前检测到限制');

            // 验证注入内容
            const inputEl = findInput();
            const injected = inputEl ? inputEl.innerText.slice(0, 30) : '(null)';
            console.log(`[Relay] 注入后输入框内容: "${injected}"`);

            const assistantMessages = getAssistantMessages();
            const baseline = {
                assistantCount: assistantMessages.length,
                lastAssistantText: getLastMessageText(assistantMessages),
                userCount: getUserMessages().length,
                startedAt: Date.now()
            };
            const sent = await clickSend();
            if (!sent) throw new Error('发送按钮不可用或已禁用');

            updateBanner(`等待回复: ${taskId}`, '#3498db');
            const reply = await waitForReply(baseline);
            assertNoSafetyBlock('提交回复前检测到限制');

            GM_xmlhttpRequest({
                method: 'POST',
                url: `${BASE}/reply`,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                data: JSON.stringify({ session: sessionId, taskId, text: reply })
            });
            reportSessionStatus(false);

            updateBanner(`Relay: ${sessionId.slice(0, 8)}...`, '#10a37f');

        } catch (e) {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${BASE}/reply`,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                data: JSON.stringify({ session: sessionId, taskId, error: e.message })
            });
            updateBanner(`错误: ${e.message}`, '#e74c3c');
            setTimeout(() => updateBanner(`Relay: ${sessionId.slice(0, 8)}...`, '#10a37f'), 5000);
        } finally {
            stopHeartbeat();
            isProcessing = false;
            schedulePoll(POLL_IDLE_MIN_MS, POLL_IDLE_MAX_MS);
        }
    }

    schedulePoll(1000, 2000);
    console.log(`[Relay] 已启动, session: ${sessionId}`);
})();
