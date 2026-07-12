// extension/service-worker.js
// MV3 Service Worker: 驱动轮询、HTTP、心跳；用 chrome.tabs.sendMessage 唤醒 content-script。
// SW 会被 Chrome 主动休眠，全部长期状态放 chrome.storage.local。

import {
  DEFAULT_BASE,
  POLL_ALARM_NAME,
  HEARTBEAT_ALARM_NAME,
  POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  NEXT_TASK_WAIT_MS,
  STORAGE_KEYS,
} from "./lib/config.js";

// ── storage helpers ──
async function getStorage(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] ?? fallback;
}
async function setStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ── 配置 ──
async function getBaseUrl() {
  const cfg = await getStorage("config", {});
  return cfg.baseUrl || DEFAULT_BASE;
}

// ── HTTP ──
async function httpJson(method, url, body, timeoutMs = 30_000) {
  const base = await getBaseUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = json?.message ?? json?.error ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ── tab 管理 ──
async function listChatGPTTabs() {
  return chrome.tabs.query({ url: "https://chatgpt.com/*" });
}

async function getTabSession(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "get-session-id" });
    return r?.session ?? null;
  } catch {
    return null;
  }
}

// ── inflight tracking（Phase 3 只做基本；Phase 4 会加恢复） ──
async function markInflight(session, taskId) {
  const inflight = (await getStorage(STORAGE_KEYS.INFLIGHT, {}));
  inflight[session] = { taskId, submittedAt: Date.now() };
  await setStorage(STORAGE_KEYS.INFLIGHT, inflight);
}
async function clearInflight(session) {
  const inflight = (await getStorage(STORAGE_KEYS.INFLIGHT, {}));
  delete inflight[session];
  await setStorage(STORAGE_KEYS.INFLIGHT, inflight);
}

// ── 轮询：一次遍历所有 chatgpt tab，尝试认领 & 执行任务 ──
let pollInProgress = false;
async function pollOnce() {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const tabs = await listChatGPTTabs();
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await handleTab(tab.id);
      } catch (e) {
        console.warn("[cgcon sw] handleTab failed", tab.id, e);
      }
    }
  } finally {
    pollInProgress = false;
  }
}

async function handleTab(tabId) {
  const session = await getTabSession(tabId);
  if (!session) return; // content-script 未就绪

  // 检查该 session 是否已有 inflight（避免同 session 并发派任务）
  const inflight = await getStorage(STORAGE_KEYS.INFLIGHT, {});
  if (inflight[session]) return;

  // 询问 content-script safety
  let safety = null;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "check-safety" });
    safety = r?.block ?? null;
  } catch { /* content 消失 */ }

  if (safety) {
    await httpJson("POST", `/internal/sessions/${encodeURIComponent(session)}/status`, {
      paused: true, reason: `${safety.reason}: ${safety.text}`,
    }).catch(() => {});
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "update-banner",
        text: `暂停: ${safety.reason}`,
        color: "#8e44ad",
      });
    } catch {}
    return;
  }

  // 正常状态：上报 & long-poll 认领
  await httpJson("POST", `/internal/sessions/${encodeURIComponent(session)}/status`, {
    paused: false,
  }).catch(() => {});

  let claim;
  try {
    claim = await httpJson(
      "GET",
      `/internal/next_task?session=${encodeURIComponent(session)}&wait=${NEXT_TASK_WAIT_MS}`,
      undefined,
      NEXT_TASK_WAIT_MS + 5000,
    );
  } catch (e) {
    console.warn("[cgcon sw] next_task failed", session, e.message);
    return;
  }
  if (!claim?.task) return;

  const { taskId, text } = claim.task;
  console.log("[cgcon sw] claimed", taskId.slice(0, 8), "session", session.slice(0, 8));
  await markInflight(session, taskId);

  try {
    const runRes = await chrome.tabs.sendMessage(tabId, {
      type: "run-task",
      taskId,
      text,
    });
    if (runRes?.error) throw new Error(runRes.error);
    if (typeof runRes?.reply !== "string") throw new Error("no reply from content-script");
    await httpJson("POST", `/internal/tasks/${taskId}/complete`, { text: runRes.reply });
  } catch (e) {
    console.warn("[cgcon sw] task failed", taskId, e);
    await httpJson("POST", `/internal/tasks/${taskId}/complete`, { error: e.message }).catch(() => {});
    await setStorage(STORAGE_KEYS.LAST_ERROR, {
      taskId, session, error: e.message, at: Date.now(),
    });
  } finally {
    await clearInflight(session);
  }
}

// ── 心跳：给每个活跃 chatgpt tab 的 session 都发一次 ──
async function heartbeatOnce() {
  const tabs = await listChatGPTTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    const session = await getTabSession(tab.id);
    if (!session) continue;
    await httpJson("POST", "/internal/heartbeat", { session }).catch(() => {});
  }
}

// ── alarm handler：Chrome 会 wake up SW 触发 alarm；alarm 最小间隔 1min。
// 我们只用 alarm 触发即时任务；短周期靠 alarm 内递归的 setTimeout（Chrome 允许，
// 只要 SW 未 idle。alarm 到达时 SW 一定会被唤醒）。
async function ensureAlarms() {
  const list = await chrome.alarms.getAll();
  const names = new Set(list.map((a) => a.name));
  if (!names.has(POLL_ALARM_NAME)) {
    await chrome.alarms.create(POLL_ALARM_NAME, { periodInMinutes: 1 });
  }
  if (!names.has(HEARTBEAT_ALARM_NAME)) {
    await chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 1 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    void pollOnce();
    // 追加两次短周期 poll 让 alarm 一次唤醒能覆盖多个 poll interval
    setTimeout(() => void pollOnce(), POLL_INTERVAL_MS);
    setTimeout(() => void pollOnce(), 2 * POLL_INTERVAL_MS);
  } else if (alarm.name === HEARTBEAT_ALARM_NAME) {
    void heartbeatOnce();
    setTimeout(() => void heartbeatOnce(), HEARTBEAT_INTERVAL_MS);
    setTimeout(() => void heartbeatOnce(), 2 * HEARTBEAT_INTERVAL_MS);
  }
});

chrome.runtime.onInstalled.addListener(() => { void ensureAlarms(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarms(); });
void ensureAlarms();

// ── content-script → SW 消息（"session-hello" 触发一次即时 poll） ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "session-hello") {
    // 立即尝试一次 poll，让新打开 tab 快速接单
    if (sender.tab?.id) {
      handleTab(sender.tab.id).catch((e) => console.warn("[cgcon sw] hello poll failed", e));
    }
    sendResponse({ status: "ok" });
    return true;
  }
  if (msg?.type === "popup-poll-now") {
    pollOnce().then(() => sendResponse({ status: "ok" })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === "popup-get-state") {
    (async () => {
      const [inflight, cfg, lastError] = await Promise.all([
        getStorage(STORAGE_KEYS.INFLIGHT, {}),
        getStorage("config", {}),
        getStorage(STORAGE_KEYS.LAST_ERROR, null),
      ]);
      const tabs = await listChatGPTTabs();
      const tabsInfo = [];
      for (const t of tabs) {
        if (!t.id) continue;
        const sid = await getTabSession(t.id);
        tabsInfo.push({ tabId: t.id, url: t.url, title: t.title, session: sid });
      }
      sendResponse({ inflight, cfg, lastError, tabs: tabsInfo, baseUrl: cfg.baseUrl || DEFAULT_BASE });
    })();
    return true;
  }
  if (msg?.type === "popup-set-base-url") {
    (async () => {
      const cfg = await getStorage("config", {});
      cfg.baseUrl = msg.baseUrl;
      await setStorage("config", cfg);
      sendResponse({ status: "ok" });
    })();
    return true;
  }
  return false;
});

console.log("[cgcon sw] loaded");