// ==UserScript==
// @name         ChatGPT Auto Relay
// @namespace    cgcon
// @version      2.2
// @description  自动接收本地中继服务的任务，填入 ChatGPT 并提交回复
// @match        https://chatgpt.com/*
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    const BASE = 'http://localhost:8765';
    const POLL_INTERVAL = 3000;
    const REPLY_STABLE_MS = 2000;

    // ── Session ID 提取 ──
    function getSessionId() {
        const url = window.location.pathname;
        const chatgptMatch = url.match(/\/c\/([a-f0-9-]+)/);
        if (chatgptMatch) return chatgptMatch[1];
        const deepseekMatch = url.match(/\/s\/([a-f0-9-]+)/);
        if (deepseekMatch) return deepseekMatch[1];
        let sid = sessionStorage.getItem('relay_session_id');
        if (!sid) {
            sid = crypto.randomUUID();
            sessionStorage.setItem('relay_session_id', sid);
        }
        return sid;
    }

    let sessionId = getSessionId();
    let isProcessing = false;
    function getAssistantMessages() {
        return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    }

    function getUserMessages() {
        return Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
    }

    function getLastMessageText(messages) {
        if (messages.length === 0) return '';
        return messages[messages.length - 1].innerText.trim();
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

    // ── 文本注入（execCommand，正确处理 Unicode/CJK）──
    async function pasteIntoInput(text) {
        const input = document.getElementById('prompt-textarea')
            || document.querySelector('[contenteditable="true"][data-testid]')
            || document.querySelector('div[contenteditable="true"]');

        if (!input) throw new Error('找不到输入框');

        input.focus();

        // 选中所有已有内容
        const sel = window.getSelection();
        sel.selectAllChildren(input);

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

        await new Promise(r => setTimeout(r, 300));

        // 验证注入结果
        if (input.innerText.trim().length < 10) {
            throw new Error('文本注入失败，输入框内容为空');
        }
    }

    // ── 点击发送 ──
    function clickSend() {
        let btn = document.querySelector('[data-testid="send-button"]');
        if (!btn) btn = document.querySelector('button[aria-label*="Send"], button[aria-label*="发送"]');
        if (!btn) {
            const input = document.getElementById('prompt-textarea');
            if (input) {
                const form = input.closest('form');
                if (form) btn = form.querySelector('button[type="submit"], button:last-of-type');
            }
        }
        if (btn && !btn.disabled) {
            btn.click();
            return true;
        }
        return false;
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
                const stopBtn = document.querySelector('[data-testid="stop-button"]')
                    || document.querySelector('button[aria-label*="Stop"]');
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
        if (isProcessing) return;

        const newSid = getSessionId();
        if (newSid !== sessionId) {
            sessionId = newSid;
            banner.textContent = `Relay: ${sessionId.slice(0, 8)}...`;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: `${BASE}/get_task?session=${sessionId}`,
            headers: { 'Accept': 'application/json; charset=utf-8' },
            overrideMimeType: 'application/json; charset=utf-8',
            onload: function(res) {
                try {
                    const data = JSON.parse(res.responseText);
                    if (data.text && data.taskId) {
                        processTask(data.taskId, data.text);
                    }
                } catch (e) {
                    console.error('[Relay] 解析任务失败:', e);
                }
            },
            onerror: function() {}
        });
    }

    async function processTask(taskId, text) {
        isProcessing = true;
        console.log(`[Relay] 收到任务 ${taskId}, 文本长度 ${text.length}, 前20字: ${text.slice(0, 20)}`);
        updateBanner(`处理中: ${taskId}`, '#e67e22');

        try {
            await pasteIntoInput(text);
            await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));

            // 验证注入内容
            const inputEl = document.getElementById('prompt-textarea')
                || document.querySelector('[contenteditable="true"][data-testid]')
                || document.querySelector('div[contenteditable="true"]');
            const injected = inputEl ? inputEl.innerText.slice(0, 30) : '(null)';
            console.log(`[Relay] 注入后输入框内容: "${injected}"`);

            const assistantMessages = getAssistantMessages();
            const baseline = {
                assistantCount: assistantMessages.length,
                lastAssistantText: getLastMessageText(assistantMessages),
                userCount: getUserMessages().length,
                startedAt: Date.now()
            };
            const sent = clickSend();
            if (!sent) throw new Error('发送按钮不可用或已禁用');

            updateBanner(`等待回复: ${taskId}`, '#3498db');
            const reply = await waitForReply(baseline);

            GM_xmlhttpRequest({
                method: 'POST',
                url: `${BASE}/reply`,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                data: JSON.stringify({ session: sessionId, taskId, text: reply })
            });

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
            isProcessing = false;
        }
    }

    setInterval(pollTask, POLL_INTERVAL);
    console.log(`[Relay] 已启动, session: ${sessionId}`);
})();
