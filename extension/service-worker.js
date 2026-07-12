// extension/service-worker.js
// MV3 Service Worker: 驱动轮询、HTTP、心跳、消息桥接、恢复。
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

async function getStorage(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] ?? fallback;
}
async function setStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function getBaseUrl() {
  const cfg = await getStorage("config", {});
  return cfg.baseUrl || DEFAULT_BASE;
}

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
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

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

// ── inflight tracking ──
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
async function getInflight(session) {
  const inflight = (await getStorage(STORAGE_KEYS.INFLIGHT, {}));
  return inflight[session] ?? null;
}

// ── offline 标记 ──
const offlineSessions = new Set();

// ── 轮询 ──
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
  if (!session) return;
  if (offlineSessions.has(session)) return;

  const inflight = await getInflight(session);
  if (inflight) return;

  let safety = null;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "check-safety" });
    safety = r?.block ?? null;
  } catch { /* content script gone */ }

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
      type: "run-task", taskId, text,
    });
    if (runRes?.error) throw new Error(runRes.error);
    if (typeof runRes?.reply !== "string") throw new Error("no reply from content-script");
    await httpJson("POST", `/internal/tasks/${taskId}/complete`, { text: runRes.reply });
    await clearInflight(session);
  } catch (e) {
    console.warn("[cgcon sw] task failed", taskId, e);
    // 注意：不立即 clearInflight，让 content-script 的 sessionStorage 有机会走 recover 流程
    await httpJson("POST", `/internal/tasks/${taskId}/complete`, { error: e.message }).catch(() => {});
    await setStorage(STORAGE_KEYS.LAST_ERROR, {
      taskId, session, error: e.message, at: Date.now(),
    });
    await clearInflight(session);
  }
}

async function heartbeatOnce() {
  const tabs = await listChatGPTTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    const session = await getTabSession(tab.id);
    if (!session) continue;
    await httpJson("POST", "/internal/heartbeat", { session }).catch(() => {});
  }
}

// ── SW 唤醒时扫孤儿 inflight（page 已刷新但 SW 侧还残留） ──
async function reconcileInflight() {
  const inflight = await getStorage(STORAGE_KEYS.INFLIGHT, {});
  if (Object.keys(inflight).length === 0) return;
  const tabs = await listChatGPTTabs();
  const liveSessions = new Set();
  for (const t of tabs) {
    if (!t.id) continue;
    const sid = await getTabSession(t.id);
    if (sid) liveSessions.add(sid);
  }
  // 该 session 的 tab 消失了 → 清理 inflight（防止内存泄漏）
  const stale = Object.keys(inflight).filter((s) => !liveSessions.has(s));
  for (const s of stale) {
    console.log("[cgcon sw] reconcile: dropping inflight for missing session", s);
    await clearInflight(s);
  }
}

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
    void reconcileInflight();
    void pollOnce();
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
void reconcileInflight();

// ── 消息桥接 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

  if (type === "session-hello") {
    if (sender.tab?.id) {
      handleTab(sender.tab.id).catch((e) => console.warn("[cgcon sw] hello poll failed", e));
    }
    sendResponse({ status: "ok" });
    return true;
  }

  if (type === "offline") {
    if (sender.tab?.id) {
      (async () => {
        const sid = await getTabSession(sender.tab.id);
        if (sid) offlineSessions.add(sid);
        sendResponse({ status: "ok" });
      })();
      return true;
    }
    return false;
  }

  if (type === "online") {
    if (sender.tab?.id) {
      (async () => {
        const sid = await getTabSession(sender.tab.id);
        if (sid) offlineSessions.delete(sid);
        sendResponse({ status: "ok" });
      })();
      return true;
    }
    return false;
  }

  if (type === "network-reload") {
    // Content script 即将 reload；把此 session 从 inflight 摘除避免误 recover
    if (sender.tab?.id) {
      (async () => {
        const sid = await getTabSession(sender.tab.id);
        if (sid) offlineSessions.add(sid);
        setTimeout(() => sid && offlineSessions.delete(sid), 15_000);
        sendResponse({ status: "ok" });
      })();
      return true;
    }
    return false;
  }

  if (type === "recover-task") {
    (async () => {
      try {
        const r = await httpJson("POST", `/internal/tasks/${msg.taskId}/recover`, { text: msg.text });
        // 找到该 session 并清 inflight
        if (sender.tab?.id) {
          const sid = await getTabSession(sender.tab.id);
          if (sid) await clearInflight(sid);
        }
        sendResponse({ recovered: r?.recovered ?? false, status: r?.status });
      } catch (e) {
        console.warn("[cgcon sw] recover-task failed", e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (type === "requeue-task") {
    (async () => {
      try {
        await httpJson("POST", `/internal/tasks/${msg.taskId}/requeue`, {});
        if (sender.tab?.id) {
          const sid = await getTabSession(sender.tab.id);
          if (sid) await clearInflight(sid);
        }
        sendResponse({ status: "ok" });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (type === "popup-poll-now") {
    pollOnce().then(() => sendResponse({ status: "ok" })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (type === "popup-get-state") {
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
        tabsInfo.push({
          tabId: t.id, url: t.url, title: t.title, session: sid,
          offline: sid ? offlineSessions.has(sid) : false,
        });
      }
      sendResponse({
        inflight, cfg, lastError, tabs: tabsInfo,
        baseUrl: cfg.baseUrl || DEFAULT_BASE,
        offlineSessionCount: offlineSessions.size,
      });
    })();
    return true;
  }

  if (type === "popup-set-base-url") {
    (async () => {
      const cfg = await getStorage("config", {});
      cfg.baseUrl = msg.baseUrl;
      await setStorage("config", cfg);
      sendResponse({ status: "ok" });
    })();
    return true;
  }

  if (type === "popup-clear-inflight") {
    (async () => {
      await setStorage(STORAGE_KEYS.INFLIGHT, {});
      sendResponse({ status: "ok" });
    })();
    return true;
  }

  return false;
});

console.log("[cgcon sw] loaded");