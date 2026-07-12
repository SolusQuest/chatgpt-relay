// extension/service-worker.js
// MV3 Service Worker: 驱动轮询、HTTP、心跳、消息桥接、恢复。
// SW 会被 Chrome 主动休眠，全部长期状态放 chrome.storage.local。

import {
  DEFAULT_BASE,
  POLL_ALARM_NAME,
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_INTERVAL_MS,
  NEXT_TASK_WAIT_MS,
  DISPATCH_LOOP_RETRY_MS,
  STORAGE_KEYS,
  POLL_REPLY_STABLE_SAMPLES,
  POLL_NOT_STARTED_MAX,
  POLL_HARD_TIMEOUT_MS,
  POLL_REPLY_SENDMSG_TIMEOUT_MS,
} from "./lib/config.js";

// 开发调试：把 DEBUG 改成 true 或在 popup 里设置 window.__gptRelayDebug = true
const DEBUG = false;
const dlog = (...args) => { if (DEBUG) console.log(...args); };

// per-session 持续任务分发 loop
const dispatchLoops = new Map(); // session -> { tabId, controller }
// taskId -> 等待该任务完成的 deferred
const pendingCompletion = new Map();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function httpJson(method, url, body, timeoutMs = 30_000, signal) {
  const base = await getBaseUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
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

// 唤醒被 Chrome 丢弃的 tab（后台内存回收会把 tab discard，content-script 随之消失）
async function reviveDiscardedTab(tab) {
  if (!tab.id) return false;
  if (!tab.discarded) return true;
  console.log("[relay sw] reviving discarded tab", tab.id);
  try {
    await chrome.tabs.reload(tab.id);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: "get-session-id" });
        if (r?.session) { console.log("[relay sw] revived tab", tab.id, "session", r.session.slice(0, 8)); return true; }
      } catch { /* still loading */ }
    }
    console.warn("[relay sw] revived tab did not report session in 8s", tab.id);
    return false;
  } catch (e) {
    console.warn("[relay sw] reload failed", tab.id, e);
    return false;
  }
}

async function listChatGPTTabs() {
  return chrome.tabs.query({ url: "https://chatgpt.com/*" });
}

async function getTabSession(tabId, opts = {}) {
  // 缓存命中直接返回（后台 tab 里 sendMessage 会被节流甚至阻塞）
  const cached = tabSessionCache.get(tabId);
  if (cached && !opts.forceFresh) return cached;
  // 冷路径：真的问 content-script
  try {
    const r = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "get-session-id" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("sendMessage timeout")), 3000)),
    ]);
    if (r?.session) {
      await rememberTabSession(tabId, r.session);
      return r.session;
    }
    return null;
  } catch {
    return null;
  }
}

// ── tab -> session 缓存 ──
// SW 会休眠，重启时缓存丢失；但 content-script 每 3s 会 session-hello 重新报，
// 所以下一轮 alarm 时就能重建。
const tabSessionCache = new Map();

async function rememberTabSession(tabId, session) {
  tabSessionCache.set(tabId, session);
  const saved = (await getStorage("tab_session_map", {}));
  saved[tabId] = session;
  await setStorage("tab_session_map", saved);
}
async function loadTabSessionCache() {
  const saved = (await getStorage("tab_session_map", {}));
  for (const [k, v] of Object.entries(saved)) tabSessionCache.set(Number(k), v);
}
async function forgetTabSession(tabId) {
  const session = tabSessionCache.get(tabId) ?? (await getStorage("tab_session_map", {}))[tabId];
  tabSessionCache.delete(tabId);
  const saved = (await getStorage("tab_session_map", {}));
  delete saved[tabId];
  await setStorage("tab_session_map", saved);
  if (session) stopDispatchLoop(session);
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

// 通知 content-script 清 sessionStorage 里的 inflight 并复位 banner。
// task 完成 / 失败 / 服务端强制超时 均走这里，避免 banner 卡在"等待回复"蓝色。
async function notifyTabCleared(tabId) {
  if (!tabId) return;
  // clear-inflight handler 里会同步复位 banner 到 "Relay: <sess8>…"
  try { await chrome.tabs.sendMessage(tabId, { type: "clear-inflight" }); } catch {}
}

// ── per-session dispatch loop ──
// 每个 session 独立维护一个持续 long-poll：无任务时立即重新 long-poll，
// 有任务时执行 run-task，等待任务完成后再继续 long-poll。
function stopDispatchLoop(session) {
  const loop = dispatchLoops.get(session);
  if (!loop) return;
  loop.controller.abort();
  dispatchLoops.delete(session);
  console.log("[relay sw] dispatch loop stopped", session.slice(0, 8));
}

async function startDispatchLoop(session, tabId) {
  const existing = dispatchLoops.get(session);
  if (existing) {
    if (existing.tabId === tabId) return; // 已经在为这个 tab 跑
    // tab 变了：停掉旧的，用新的重新跑
    stopDispatchLoop(session);
  }
  const controller = new AbortController();
  dispatchLoops.set(session, { tabId, controller });
  console.log("[relay sw] dispatch loop started", session.slice(0, 8), "tab", tabId);

  try {
    while (!controller.signal.aborted) {
      const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
      if (!tabInfo) {
        console.log("[relay sw] dispatch loop exit: tab gone", session.slice(0, 8));
        break;
      }
      if (tabInfo.discarded) {
        const ok = await reviveDiscardedTab(tabInfo);
        if (!ok) {
          console.log("[relay sw] dispatch loop exit: revive failed", session.slice(0, 8));
          break;
        }
      }
      if (offlineSessions.has(session)) {
        console.log("[relay sw] dispatch loop exit: offline", session.slice(0, 8));
        break;
      }

      // safety / pause 检查：与旧 handleTab 行为保持一致
      let safety = null;
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: "check-safety" });
        safety = r?.block ?? null;
      } catch { /* content script gone */ }
      if (safety) {
        await httpJson("POST", `/internal/sessions/${encodeURIComponent(session)}/status`, {
          paused: true, reason: `${safety.reason}: ${safety.text}`,
        }).catch(() => {});
        console.log("[relay sw] dispatch loop exit: safety", session.slice(0, 8), safety.reason);
        break;
      }
      await httpJson("POST", `/internal/sessions/${encodeURIComponent(session)}/status`, {
        paused: false,
      }).catch(() => {});

      const loopStart = Date.now();
      let claim;
      try {
        claim = await httpJson(
          "GET",
          `/internal/next_task?session=${encodeURIComponent(session)}&wait=${NEXT_TASK_WAIT_MS}`,
          undefined,
          NEXT_TASK_WAIT_MS + 8000,
          controller.signal,
        );
      } catch (e) {
        if (controller.signal.aborted) {
          console.log("[relay sw] dispatch loop abort", session.slice(0, 8));
          break;
        }
        console.warn("[relay sw] next_task error", session.slice(0, 8), e.message);
        await delay(DISPATCH_LOOP_RETRY_MS);
        continue;
      }

      if (!claim?.task) {
        // long-poll 超时，立即继续下一轮
        continue;
      }

      const { taskId, text } = claim.task;
      const dispatchAt = Date.now();
      console.log(
        "[relay sw] dispatch task", taskId.slice(0, 8),
        "session", session.slice(0, 8),
        "dispatchAt", dispatchAt,
        "waitMs", dispatchAt - loopStart,
      );
      await markInflight(session, taskId);

      try {
        const runRes = await chrome.tabs.sendMessage(tabId, { type: "run-task", taskId, text });
        if (runRes?.error) throw new Error(runRes.error);
        if (runRes?.status !== "submitted") {
          // content-script 老版本兼容
          if (typeof runRes?.reply === "string") {
            await httpJson("POST", `/internal/tasks/${taskId}/complete`, { text: runRes.reply });
            await clearInflight(session);
            console.log("[relay sw] task completed inline", taskId.slice(0, 8), "completionAt", Date.now());
            continue;
          }
          throw new Error("run-task did not acknowledge submission");
        }

        await setPendingReply(taskId, {
          session,
          tabId,
          taskId,
          baseline: runRes.baseline ?? { assistantCount: 0, lastAssistantText: "", userCount: 0 },
          submittedAt: Date.now(),
          lastPollAt: 0,
          notStartedCount: 0,
          stableSampleCount: 0,
          lastSampleText: "",
        });

        // 等待当前任务完成（done/failed/recover/requeue 都会 deletePendingReply）
        await waitForPendingReply(taskId, controller.signal);
        console.log("[relay sw] task completed", taskId.slice(0, 8), "completionAt", Date.now());
      } catch (e) {
        console.warn("[relay sw] task failed", taskId.slice(0, 8), e.message);
        await httpJson("POST", `/internal/tasks/${taskId}/complete`, { error: e.message }).catch(() => {});
        await clearInflight(session);
      }
    }
  } finally {
    dispatchLoops.delete(session);
  }
}

async function restoreDispatchLoops() {
  const saved = await getStorage("tab_session_map", {});
  const tabs = await listChatGPTTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    const session = saved[tab.id] ?? tabSessionCache.get(tab.id);
    if (!session) continue;
    if (offlineSessions.has(session)) continue;
    startDispatchLoop(session, tab.id).catch((e) =>
      console.warn("[relay sw] restore loop failed", session.slice(0, 8), e),
    );
  }
}

async function waitForPendingReply(taskId, signal) {
  let deferred = pendingCompletion.get(taskId);
  if (!deferred) {
    deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    pendingCompletion.set(taskId, deferred);
  }
  if (signal?.aborted) return;
  return Promise.race([
    deferred.promise,
    new Promise((_, reject) => {
      const handler = () => reject(new Error("aborted"));
      if (signal.aborted) handler();
      else signal.addEventListener("abort", handler, { once: true });
    }),
  ]);
}

// ── pending-reply state machine ──
// SW 主动 poll 而非 content-script 长期 await。原因：
//   1) Chrome 冻结后台 tab 的 MutationObserver / setInterval；
//   2) 状态在 SW 一处，页面 F5 或扩展 reload 都能自愈；
//   3) SW 每次 alarm tick 通过 chrome.tabs.sendMessage(poll-reply) 唤醒 content
//      script 做单次同步 DOM 快照。
//
// 记录形如：
//   {
//     session, tabId, taskId, baseline,
//     submittedAt, lastPollAt,
//     notStartedCount,          // 连续 "not-started" 次数
//     stableSampleCount,        // 连续文本相同次数（reply-ready 时用）
//     lastSampleText,           // 上次采样到的文本
//   }
async function listPendingReplies() {
  return await getStorage(STORAGE_KEYS.PENDING_REPLIES, {});
}
async function setPendingReply(taskId, rec) {
  const map = await listPendingReplies();
  map[taskId] = rec;
  await setStorage(STORAGE_KEYS.PENDING_REPLIES, map);
  // 确保 completion deferred 存在，供 dispatch loop 等待
  if (!pendingCompletion.has(taskId)) {
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    pendingCompletion.set(taskId, deferred);
  }
  // 触发快速采样循环（非阻塞，若已在跑就是 no-op）
  void scheduleFastPending();
}
async function deletePendingReply(taskId) {
  const map = await listPendingReplies();
  delete map[taskId];
  await setStorage(STORAGE_KEYS.PENDING_REPLIES, map);
  const deferred = pendingCompletion.get(taskId);
  if (deferred) {
    deferred.resolve();
    pendingCompletion.delete(taskId);
  }
}
async function getPendingReply(taskId) {
  const map = await listPendingReplies();
  return map[taskId] ?? null;
}

async function pollPendingReplies() {
  const map = await listPendingReplies();
  const ids = Object.keys(map);
  if (ids.length === 0) return;
  dlog("[relay sw] pollPendingReplies pending=", ids.length);

  for (const taskId of ids) {
    const rec = map[taskId];
    if (!rec) continue;
    try {
      await pollOnePending(taskId, rec);
    } catch (e) {
      console.warn("[relay sw] pollOnePending failed", taskId, e);
    }
  }
}

async function pollOnePending(taskId, rec) {
  const now = Date.now();
  dlog("[relay sw] pollOnePending", taskId.slice(0,8), "tab=", rec.tabId, "session=", rec.session?.slice?.(0,8), "notStarted=", rec.notStartedCount, "stable=", rec.stableSampleCount);
  // 硬超时
  if (now - rec.submittedAt > POLL_HARD_TIMEOUT_MS) {
    console.warn("[relay sw] pending reply hard timeout", taskId);
    await failPending(taskId, rec, "pending reply hard timeout");
    return;
  }

  // 定位 tab
  let tabInfo = null;
  try { tabInfo = await chrome.tabs.get(rec.tabId); } catch { tabInfo = null; }
  if (!tabInfo) {
    console.warn("[relay sw] pending tab gone; requeueing", taskId, rec.tabId);
    await requeuePending(taskId, rec);
    return;
  }
  if (tabInfo.discarded) {
    const ok = await reviveDiscardedTab(tabInfo);
    if (!ok) return; // wait next tick
  }

  // 调 content-script 单次快照
  let snap;
  try {
    snap = await Promise.race([
      chrome.tabs.sendMessage(rec.tabId, { type: "poll-reply", baseline: rec.baseline }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("poll-reply sendMessage timeout")), POLL_REPLY_SENDMSG_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.warn("[relay sw] poll-reply sendMessage failed", taskId, e.message);
    // 一次失败不结算；下次 alarm 再试。
    rec.lastPollAt = now;
    await setPendingReply(taskId, rec);
    return;
  }
  rec.lastPollAt = now;

  dlog("[relay sw] poll-reply snap", taskId.slice(0,8), "status=", snap?.status, "err=", snap?.error, "text=", (snap?.reply ?? snap?.lastText ?? "").slice(0,40));
  if (!snap || snap.error) {
    console.warn("[relay sw] poll-reply error", taskId, snap?.error);
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "safety") {
    console.warn("[relay sw] pending hit safety", taskId, snap.reason);
    await httpJson("POST", `/internal/sessions/${encodeURIComponent(rec.session)}/status`, {
      paused: true, reason: snap.reason ?? "safety",
    }).catch(() => {});
    // task 判失败，让 agent 感知
    await failPending(taskId, rec, `safety: ${snap.reason ?? "unknown"}`);
    return;
  }

  if (snap.status === "reply-ready") {
    const text = snap.reply ?? "";
    if (text === rec.lastSampleText) {
      rec.stableSampleCount = (rec.stableSampleCount ?? 0) + 1;
    } else {
      rec.stableSampleCount = 1;
      rec.lastSampleText = text;
    }
    if (rec.stableSampleCount >= POLL_REPLY_STABLE_SAMPLES && text.length > 0) {
      console.log("[relay sw] pending complete", taskId, "len=", text.length);
      try {
        await httpJson("POST", `/internal/tasks/${taskId}/complete`, { text });
      } catch (e) {
        console.warn("[relay sw] complete POST failed", taskId, e.message);
        await setPendingReply(taskId, rec);
        return;
      }
      await deletePendingReply(taskId);
      await clearInflight(rec.session);
      await notifyTabCleared(rec.tabId);
      return;
    }
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "generating") {
    // 进入生成中说明提交成功；重置 not-started 计数
    rec.notStartedCount = 0;
    rec.stableSampleCount = 0;
    rec.lastSampleText = snap.lastText ?? rec.lastSampleText ?? "";
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "posted-no-reply-yet") {
    // 用户已发出去但还没生成
    rec.notStartedCount = 0;
    rec.lastSampleText = snap.lastText ?? rec.lastSampleText ?? "";
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "not-started") {
    rec.notStartedCount = (rec.notStartedCount ?? 0) + 1;
    if (rec.notStartedCount >= POLL_NOT_STARTED_MAX) {
      console.warn("[relay sw] pending never left not-started; failing", taskId);
      await failPending(taskId, rec, "send appears to have failed (no user/assistant message change)");
      return;
    }
    await setPendingReply(taskId, rec);
    return;
  }

  // 未知 status：保守回写
  await setPendingReply(taskId, rec);
}

async function failPending(taskId, rec, reason) {
  try {
    await httpJson("POST", `/internal/tasks/${taskId}/complete`, { error: reason });
  } catch (e) {
    console.warn("[relay sw] failPending POST failed", taskId, e.message);
  }
  await deletePendingReply(taskId);
  await clearInflight(rec.session);
  await notifyTabCleared(rec.tabId);
  await setStorage(STORAGE_KEYS.LAST_ERROR, {
    taskId, session: rec.session, error: reason, at: Date.now(),
  });
}

async function requeuePending(taskId, rec) {
  try {
    await httpJson("POST", `/internal/tasks/${taskId}/requeue`, {});
  } catch (e) {
    console.warn("[relay sw] requeuePending POST failed", taskId, e.message);
  }
  await deletePendingReply(taskId);
  await clearInflight(rec.session);
  await notifyTabCleared(rec.tabId);
}

// ── 快速采样调度 ──
// chrome.alarms 最小周期 1 分钟；对已有 pending 任务这个粒度太粗（用户等 ~60s
// 才能拿到已经生成完的 reply）。pending 非空时用 setTimeout 快速循环
// (FAST_POLL_MS) 加速采样，pending 清空后自然退出，靠 alarm + heartbeat 兜底
// 保证 SW 不被休眠。
const FAST_POLL_MS = 2000;
let fastPollScheduled = false;
async function scheduleFastPending() {
  if (fastPollScheduled) return;
  const map = await listPendingReplies();
  if (Object.keys(map).length === 0) return;
  fastPollScheduled = true;
  const tick = async () => {
    try { await pollPendingReplies(); } catch (e) { console.warn("[relay sw] fast tick failed", e); }
    const cur = await listPendingReplies();
    if (Object.keys(cur).length > 0) {
      setTimeout(tick, FAST_POLL_MS);
    } else {
      fastPollScheduled = false;
    }
  };
  setTimeout(tick, FAST_POLL_MS);
}

// ── 轮询 ──
// handleTab 已重构为 per-session 持续 long-poll 的入口。
async function handleTab(tabId) {
  const session = await getTabSession(tabId);
  if (!session) {
    dlog("[relay sw] tab", tabId, "has no known session; skipping");
    return;
  }
  startDispatchLoop(session, tabId).catch((e) =>
    console.warn("[relay sw] startDispatchLoop failed", session.slice(0, 8), e),
  );
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
  // 1) 该 session 的 tab 消失了 → 清理 inflight
  for (const s of Object.keys(inflight)) {
    if (!liveSessions.has(s)) {
      console.log("[relay sw] reconcile: dropping inflight for missing session", s.slice(0, 8));
      await clearInflight(s);
    }
  }
  // 2) 若 task 已经 terminal（server 判 failed/expired 等），也清 inflight + pending
  const still = await getStorage(STORAGE_KEYS.INFLIGHT, {});
  for (const [session, entry] of Object.entries(still)) {
    if (!entry?.taskId) continue;
    try {
      const t = await httpJson("GET", `/v1/tasks/${entry.taskId}`);
      if (t && ["done", "failed", "cancelled", "expired"].includes(t.status)) {
        console.log("[relay sw] reconcile: task", entry.taskId.slice(0, 8), "already", t.status, "→ clearing inflight");
        // 找到对应 tabId（优先从 pendingReplies 拿，回退到反查 tab_session_map）
        let tabId = null;
        const pmap = await listPendingReplies();
        if (pmap[entry.taskId]?.tabId) tabId = pmap[entry.taskId].tabId;
        if (!tabId) {
          for (const [tid, sid] of tabSessionCache.entries()) {
            if (sid === session) { tabId = tid; break; }
          }
        }
       await clearInflight(session);
       await deletePendingReply(entry.taskId);
       await notifyTabCleared(tabId);
      }
    } catch (e) {
      // server 不可达就算了，下一轮再试
    }
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
    void pollPendingReplies();
    // alarm 仅作为 SW 被唤醒后的恢复机制：恢复每个 session 的 dispatch loop
    void restoreDispatchLoops();
  } else if (alarm.name === HEARTBEAT_ALARM_NAME) {
    void heartbeatOnce();
    setTimeout(() => void heartbeatOnce(), HEARTBEAT_INTERVAL_MS);
    setTimeout(() => void heartbeatOnce(), 2 * HEARTBEAT_INTERVAL_MS);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { void forgetTabSession(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // URL 变化时清缓存，让 content-script 重新报 session id
  if (info.url) void forgetTabSession(tabId);
});

chrome.runtime.onInstalled.addListener(() => { void ensureAlarms(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarms(); });
void ensureAlarms();
void loadTabSessionCache();
void reconcileInflight();
void pollPendingReplies();
void restoreDispatchLoops();

// ── 消息桥接 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

 if (type === "session-hello") {
   if (sender.tab?.id && msg.session) {
     rememberTabSession(sender.tab.id, msg.session).then(() => {
        startDispatchLoop(msg.session, sender.tab.id).catch((e) =>
          console.warn("[relay sw] hello dispatch loop failed", e),
        );
      });
    }
    sendResponse({ status: "ok" });
    return true;
  }

 if (type === "offline") {
    if (sender.tab?.id) {
      (async () => {
        const sid = await getTabSession(sender.tab.id);
        if (sid) {
          offlineSessions.add(sid);
          stopDispatchLoop(sid);
        }
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
        if (sid) {
          offlineSessions.delete(sid);
          startDispatchLoop(sid, sender.tab.id).catch(() => {});
        }
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
        if (sid) {
          offlineSessions.add(sid);
          stopDispatchLoop(sid);
          setTimeout(() => {
            offlineSessions.delete(sid);
            startDispatchLoop(sid, sender.tab.id).catch(() => {});
          }, 15_000);
        } else {
          setTimeout(() => sid && offlineSessions.delete(sid), 15_000);
        }
        sendResponse({ status: "ok" });
      })();
      return true;
    }
    return false;
  }

  if (type === "reattach-pending") {
    (async () => {
      try {
        if (!sender.tab?.id) { sendResponse({ error: "no tab" }); return; }
        const sid = await getTabSession(sender.tab.id);
        if (!sid) { sendResponse({ error: "no session for tab" }); return; }
        await setPendingReply(msg.taskId, {
          session: sid,
          tabId: sender.tab.id,
          taskId: msg.taskId,
          baseline: msg.baseline ?? { assistantCount: 0, lastAssistantText: "", userCount: 0 },
          submittedAt: Date.now(),
          lastPollAt: 0,
          notStartedCount: 0,
          stableSampleCount: 0,
          lastSampleText: "",
        });
        await markInflight(sid, msg.taskId);
        // 立即触发一次采样
        void pollPendingReplies();
        startDispatchLoop(sid, sender.tab.id).catch(() => {});
        sendResponse({ status: "ok" });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
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
        await deletePendingReply(msg.taskId);
        sendResponse({ recovered: r?.recovered ?? false, status: r?.status });
      } catch (e) {
        console.warn("[relay sw] recover-task failed", e);
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
        await deletePendingReply(msg.taskId);
        sendResponse({ status: "ok" });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (type === "popup-poll-now") {
    restoreDispatchLoops().then(() => sendResponse({ status: "ok" })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (type === "popup-get-state") {
    (async () => {
      const [inflight, cfg, lastError, pendingReplies] = await Promise.all([
        getStorage(STORAGE_KEYS.INFLIGHT, {}),
        getStorage("config", {}),
        getStorage(STORAGE_KEYS.LAST_ERROR, null),
        getStorage(STORAGE_KEYS.PENDING_REPLIES, {}),
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
        pendingReplyCount: Object.keys(pendingReplies).length,
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
      await setStorage(STORAGE_KEYS.PENDING_REPLIES, {});
      for (const session of dispatchLoops.keys()) {
        stopDispatchLoop(session);
      }
      for (const deferred of pendingCompletion.values()) {
        deferred.resolve();
      }
      pendingCompletion.clear();
      sendResponse({ status: "ok" });
    })();
    return true;
  }

  return false;
});

console.log("[relay sw] loaded");
