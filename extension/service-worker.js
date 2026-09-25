// extension/service-worker.js
// MV3 service worker for polling, HTTP, heartbeat, message bridging, and recovery.
// Chrome may suspend it at any time, so durable state lives in chrome.storage.local.

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
  POLL_LATE_REPLY_GRACE_MS,
  SUBMISSION_VERIFICATION_MS,
  RECOVERY_OBSERVATION_INTERVAL_MS,
  TASK_OBSERVATION_CHANGE_INTERVAL_MS,
  TASK_OBSERVATION_HEARTBEAT_INTERVAL_MS,
  ATTACHMENT_BLOCK_CLEAN_STABLE_MS,
  POLL_REPLY_SENDMSG_TIMEOUT_MS,
  RUN_TASK_ACK_TIMEOUT_MS,
  PAGE_STATE_SENDMSG_TIMEOUT_MS,
} from "./lib/config.js";
import {
  classifySubmissionVerification,
  classifyRecoveryAction,
  hasSendFence,
  isRecoverableLateReply,
} from "./lib/recovery-policy.js";

// Development debugging: set DEBUG to true or window.__gptRelayDebug in the popup.
const DEBUG = false;
const dlog = (...args) => { if (DEBUG) console.log(...args); };

// Continuous per-session task dispatch loops.
const dispatchLoops = new Map(); // session -> { tabId, controller }
// taskId to deferred completion waiter.
const pendingCompletion = new Map();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getStorage(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] ?? fallback;
}
async function setStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function listAttachmentBlocks() {
  return getStorage(STORAGE_KEYS.ATTACHMENT_BLOCKS, {});
}

let attachmentBlocksMutation = Promise.resolve();

async function mutateAttachmentBlocks(mutator) {
  const operation = attachmentBlocksMutation.then(async () => {
    const blocks = await listAttachmentBlocks();
    const result = mutator(blocks);
    await setStorage(STORAGE_KEYS.ATTACHMENT_BLOCKS, blocks);
    return result;
  });
  attachmentBlocksMutation = operation.catch(() => {});
  return operation;
}

async function setAttachmentBlock(session, reason) {
  await mutateAttachmentBlocks((blocks) => {
    blocks[session] = { reason, at: Date.now() };
  });
}

async function clearAttachmentBlock(session) {
  await mutateAttachmentBlocks((blocks) => {
    delete blocks[session];
  });
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

// Wake a tab discarded by Chrome background memory reclamation.
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
  // Return cached state because sendMessage can be throttled in background tabs.
  const cached = tabSessionCache.get(tabId);
  if (cached && !opts.forceFresh) return cached;
  // Cold path: query the content script.
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

// Tab-to-session cache. Suspension clears memory, but content scripts report
// session-hello periodically so the next alarm can rebuild the mapping.
const tabSessionCache = new Map();

async function rememberTabSession(tabId, session) {
  const saved = (await getStorage("tab_session_map", {}));
  const previous = tabSessionCache.get(tabId) ?? saved[tabId];
  if (previous && previous !== session && dispatchLoops.get(previous)?.tabId === tabId) {
    stopDispatchLoop(previous);
  }
  tabSessionCache.set(tabId, session);
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
  if (session && dispatchLoops.get(session)?.tabId === tabId) stopDispatchLoop(session);
}

// ── inflight tracking ──
async function markInflight(session, taskId, details = {}) {
  const inflight = (await getStorage(STORAGE_KEYS.INFLIGHT, {}));
  const existing = inflight[session]?.taskId === taskId ? inflight[session] : {};
  inflight[session] = {
    ...existing,
    taskId,
    submittedAt: existing.submittedAt ?? Date.now(),
    ...details,
  };
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

// Offline marker.
const offlineSessions = new Set();

// Tell the content script to clear sessionStorage in-flight state and reset its
// banner after completion, definitive failure, or late-reply-window expiry.
async function notifyTabCleared(tabId) {
  if (!tabId) return;
  // The clear-inflight handler also resets the banner to "Relay: <session>...".
  try {
    await sendTabMessage(
      tabId,
      { type: "clear-inflight" },
      PAGE_STATE_SENDMSG_TIMEOUT_MS,
      "clear-inflight",
    );
  } catch {}
}

async function sendTabMessage(tabId, message, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getPageState(tabId) {
  const state = await sendTabMessage(
    tabId,
    { type: "get-page-state" },
    PAGE_STATE_SENDMSG_TIMEOUT_MS,
    "get-page-state",
  );
  if (
    !state ||
    state.error ||
    typeof state.session !== "string" ||
    typeof state.generating !== "boolean" ||
    typeof state.ready !== "boolean"
  ) {
    throw new Error(state?.error ?? "get-page-state invalid response");
  }
  return state;
}

async function reportTaskProgress(taskId, phase) {
  return httpJson("POST", `/internal/tasks/${taskId}/progress`, { phase }).then(() => true).catch((e) => {
    dlog("[relay sw] progress report failed", taskId.slice(0, 8), phase, e.message);
    return false;
  });
}

async function reportTaskObservation(taskId, rec, observation, now = Date.now()) {
  const normalized = {
    phase: observation.phase,
    activity: typeof observation.activity === "string" && observation.activity.trim().length > 0
      ? observation.activity.replace(/\s+/g, " ").trim().slice(0, 200)
      : null,
    outputChars: Number.isFinite(observation.outputChars)
      ? Math.max(0, Math.floor(observation.outputChars))
      : 0,
  };
  const signature = JSON.stringify(normalized);
  const changed = signature !== rec.lastObservationSignature;
  const lastReportedAt = rec.lastObservationReportedAt ?? 0;
  const interval = changed
    ? TASK_OBSERVATION_CHANGE_INTERVAL_MS
    : TASK_OBSERVATION_HEARTBEAT_INTERVAL_MS;
  if (lastReportedAt > 0 && now - lastReportedAt < interval) return;

  try {
    await httpJson("POST", `/internal/tasks/${taskId}/observation`, normalized);
    rec.lastObservationSignature = signature;
    rec.lastObservationReportedAt = now;
  } catch (e) {
    dlog("[relay sw] observation report failed", taskId.slice(0, 8), e.message);
  }
}

async function reportRecoveryObservation(taskId, rec, now = Date.now()) {
  if (!rec.hardTimedOutAt) return;
  if (
    typeof rec.lastRecoveryProgressAt === "number" &&
    now - rec.lastRecoveryProgressAt < RECOVERY_OBSERVATION_INTERVAL_MS
  ) {
    return;
  }
  await reportTaskProgress(taskId, "recovery_observed");
  rec.lastRecoveryProgressAt = now;
}

async function getSessionPendingReply(session) {
  const pending = await listPendingReplies();
  return Object.values(pending).find((rec) => rec?.session === session) ?? null;
}

async function setClaimPendingReply(
  claim,
  session,
  tabId,
  baseline,
  deliveryPhase,
  details = {},
) {
  const taskId = claim.task.taskId;
  const existing = await getPendingReply(taskId);
  const verificationStartedAt = existing?.sendAttemptedAt ??
    details.sendAttemptedAt ??
    (deliveryPhase === "preparing" ? null : Date.now());
  await setPendingReply(taskId, {
    ...(existing ?? {}),
    session,
    tabId,
    taskId,
    expiresAt: claim.task.expiresAt,
    completionDeadlineAt: claim.task.completionDeadlineAt,
    recoveryDeadlineAt: claim.task.recoveryDeadlineAt,
    lateReplyDeadlineAt: claim.task.lateReplyDeadlineAt,
    baseline: baseline ?? {
      assistantCount: 0,
      lastAssistantText: "",
      lastAssistantId: null,
      lastUserId: null,
      userCount: 0,
    },
    submittedAt: Date.now(),
    lastPollAt: 0,
    notStartedCount: 0,
    stableSampleCount: 0,
    lastSampleText: "",
    wasGenerating: false,
    stoppedNoReplyCount: 0,
    stopRequestedAt: null,
    deliveryPhase,
    ackState: deliveryPhase,
    sendAttemptedAt: verificationStartedAt,
    submissionVerificationDeadlineAt:
      existing?.submissionVerificationDeadlineAt ??
      details.submissionVerificationDeadlineAt ??
      (verificationStartedAt == null
        ? null
        : verificationStartedAt + SUBMISSION_VERIFICATION_MS),
    submissionAcknowledged:
      existing?.submissionAcknowledged === true || deliveryPhase === "accepted",
    submitAcknowledgedProgressReported:
      existing?.submitAcknowledgedProgressReported === true || deliveryPhase === "accepted",
    hardTimedOutAt: null,
    generatingProgressReported: false,
    replyProgressReported: false,
    lastObservationSignature: null,
    lastObservationReportedAt: 0,
    ...details,
  });
}

function inferDeliveryPhase(task, record = {}) {
  if (task?.submitAcknowledgedAt != null) return "accepted";
  if (task?.sendAttemptedAt != null) {
    const localPhase = record.deliveryPhase ?? record.phase ?? record.ackState;
    return localPhase && localPhase !== "preparing" ? localPhase : "send-attempted";
  }
  return record.deliveryPhase ?? record.phase ?? record.ackState ?? "unknown";
}

async function attachPendingFromTask(task, session, tabId, record = {}) {
  const existing = await getPendingReply(task.taskId);
  const baseline = record.baseline ?? existing?.baseline ?? {
    assistantCount: 0,
    lastAssistantText: "",
    lastAssistantId: null,
    lastUserId: null,
    userCount: 0,
  };
  const deliveryPhase = inferDeliveryPhase(task, {
    ...existing,
    ...record,
  });
  const sendAttemptedAt = existing?.sendAttemptedAt ??
    task.sendAttemptedAt ?? record.sendAttemptedAt ??
    (deliveryPhase === "preparing" ? null : Date.now());
  await setPendingReply(task.taskId, {
    ...(existing ?? {}),
    session,
    tabId,
    taskId: task.taskId,
    expiresAt: existing?.expiresAt ?? task.expiresAt,
    completionDeadlineAt: existing?.completionDeadlineAt ?? task.completionDeadlineAt,
    recoveryDeadlineAt: existing?.recoveryDeadlineAt ?? task.recoveryDeadlineAt,
    lateReplyDeadlineAt: existing?.lateReplyDeadlineAt ?? task.lateReplyDeadlineAt,
    baseline,
    submittedAt: existing?.submittedAt ?? record.submittedAt ?? Date.now(),
    lastPollAt: 0,
    notStartedCount: 0,
    stableSampleCount: 0,
    lastSampleText: existing?.lastSampleText ?? "",
    wasGenerating: existing?.wasGenerating ?? task.generatingSeenAt != null,
    stoppedNoReplyCount: existing?.stoppedNoReplyCount ?? 0,
    stopRequestedAt: existing?.stopRequestedAt ?? record.stopRequestedAt ?? null,
    deliveryPhase,
    ackState: deliveryPhase,
    sendAttemptedAt,
    submissionVerificationDeadlineAt:
      task.submissionVerificationDeadlineAt ??
      existing?.submissionVerificationDeadlineAt ??
      record.submissionVerificationDeadlineAt ??
      (sendAttemptedAt == null ? null : sendAttemptedAt + SUBMISSION_VERIFICATION_MS),
    submissionAcknowledged:
      task.submitAcknowledgedAt != null || task.generatingSeenAt != null ||
      existing?.submissionAcknowledged === true || deliveryPhase === "accepted",
    submitAcknowledgedProgressReported:
      task.submitAcknowledgedAt != null || existing?.submitAcknowledgedProgressReported === true ||
      deliveryPhase === "accepted",
    composerPayloadObservedAfterFailure:
      existing?.composerPayloadObservedAfterFailure === true ||
      record.composerPayloadObservedAfterFailure === true,
    submittedUserMessageId:
      record.submittedUserMessageId ?? existing?.submittedUserMessageId ?? null,
    hardTimedOutAt:
      existing?.hardTimedOutAt ??
      (task.status === "recovering"
        ? (task.recoveryStartedAt ?? Date.now())
        : task.status === "failed"
          ? (task.completedAt ?? Date.now())
          : null),
    lastRecoveryProgressAt:
      existing?.lastRecoveryProgressAt ?? task.recoveryObservedAt ?? null,
    generatingProgressReported:
      existing?.generatingProgressReported ?? task.generatingSeenAt != null,
    replyProgressReported:
      existing?.replyProgressReported ?? task.replyDetectedAt != null,
    lastObservationSignature: existing?.lastObservationSignature ?? null,
    lastObservationReportedAt: existing?.lastObservationReportedAt ?? 0,
  });
  await markInflight(session, task.taskId, {
    tabId,
    baseline,
    deliveryPhase,
    submittedUserMessageId:
      record.submittedUserMessageId ?? existing?.submittedUserMessageId ?? null,
    expiresAt: task.expiresAt,
    completionDeadlineAt: task.completionDeadlineAt,
    recoveryDeadlineAt: task.recoveryDeadlineAt,
    lateReplyDeadlineAt: task.lateReplyDeadlineAt,
  });
}

// ── per-session dispatch loop ──
// Each session maintains a continuous long poll. Empty polls restart
// immediately; claimed work blocks the next poll until task completion.
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
    if (existing.tabId === tabId) return; // This tab already has a loop.
    // The tab changed; stop the old loop and start one for the replacement.
    stopDispatchLoop(session);
  }
  const controller = new AbortController();
  dispatchLoops.set(session, { tabId, controller });
  console.log("[relay sw] dispatch loop started", session.slice(0, 8), "tab", tabId);

  try {
    while (!controller.signal.aborted) {
      const existingPending = await getSessionPendingReply(session);
      if (existingPending) {
        void scheduleFastPending();
        await waitForPendingReply(existingPending.taskId, controller.signal);
        continue;
      }

      const durableInflight = await getInflight(session);
      if (durableInflight?.taskId) {
        try {
          const recovered = await recoverInflightForTab(
            {
              ...durableInflight,
              taskId: durableInflight.taskId,
            },
            tabId,
          );
          if (recovered.action === "reattached") {
            await waitForPendingReply(durableInflight.taskId, controller.signal);
            continue;
          }
          if (recovered.action === "wait") {
            await delay(DISPATCH_LOOP_RETRY_MS);
            continue;
          }
        } catch (e) {
          console.warn(
            "[relay sw] durable inflight recovery failed",
            durableInflight.taskId.slice(0, 8),
            e.message,
          );
          await delay(DISPATCH_LOOP_RETRY_MS);
          continue;
        }
      }

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

      const attachmentBlock = (await listAttachmentBlocks())[session];
      if (attachmentBlock) {
        try {
          const state = await getPageState(tabId);
          if (state.composerClean) {
            if (typeof attachmentBlock.cleanSince !== "number") {
              const cleanSince = Date.now();
              attachmentBlock.cleanSince = cleanSince;
              await mutateAttachmentBlocks((blocks) => {
                if (blocks[session]) blocks[session].cleanSince = cleanSince;
              });
              await delay(DISPATCH_LOOP_RETRY_MS);
              continue;
            }
            if (Date.now() - attachmentBlock.cleanSince < ATTACHMENT_BLOCK_CLEAN_STABLE_MS) {
              await delay(DISPATCH_LOOP_RETRY_MS);
              continue;
            }
            await clearAttachmentBlock(session);
            await httpJson(
              "POST",
              `/internal/sessions/${encodeURIComponent(session)}/status`,
              { paused: false },
            ).catch(() => {});
            await sendTabMessage(
              tabId,
              { type: "update-banner", text: `Relay: ${session.slice(0, 8)}…`, color: "#10a37f" },
              PAGE_STATE_SENDMSG_TIMEOUT_MS,
              "attachment block cleared",
            ).catch(() => {});
          } else {
            if (attachmentBlock.cleanSince != null) {
              attachmentBlock.cleanSince = null;
              await mutateAttachmentBlocks((blocks) => {
                if (blocks[session]) blocks[session].cleanSince = null;
              });
            }
            await httpJson(
              "POST",
              `/internal/sessions/${encodeURIComponent(session)}/status`,
              { paused: true, reason: attachmentBlock.reason, preserveQueued: true },
            ).catch(() => {});
            await delay(DISPATCH_LOOP_RETRY_MS);
            continue;
          }
        } catch (e) {
          console.warn("[relay sw] attachment cleanup state unavailable", session.slice(0, 8), e.message);
          await delay(DISPATCH_LOOP_RETRY_MS);
          continue;
        }
      }

      // Preserve the previous handleTab safety and pause checks.
      let safety = null;
      try {
        const r = await sendTabMessage(
          tabId,
          { type: "check-safety" },
          PAGE_STATE_SENDMSG_TIMEOUT_MS,
          "check-safety",
        );
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

      // Do not claim while the page hydrates or finishes prior generation,
      // including a late reply, because React may overwrite a new prompt.
      try {
        const state = await getPageState(tabId);
        if (state.session !== session || !state.ready || state.generating) {
          dlog(
            "[relay sw] page not dispatchable",
            session.slice(0, 8),
            state.session !== session ? "session-mismatch" : state.reason,
            state.stableForMs,
          );
          await delay(DISPATCH_LOOP_RETRY_MS);
          continue;
        }
      } catch (e) {
        console.warn("[relay sw] page state unavailable", session.slice(0, 8), e.message);
        await delay(DISPATCH_LOOP_RETRY_MS);
        continue;
      }

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
        // Restart immediately after an empty long poll.
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
      await markInflight(session, taskId, {
        tabId,
        deliveryPhase: "preparing",
      });

      try {
        let pageState;
        try {
          pageState = await getPageState(tabId);
        } catch (e) {
          await httpJson("POST", `/internal/tasks/${taskId}/defer`, {}).catch(() => {});
          await clearInflight(session);
          await notifyTabCleared(tabId);
          await delay(DISPATCH_LOOP_RETRY_MS);
          continue;
        }
        if (pageState.session !== session || !pageState.ready || pageState.generating) {
          await httpJson("POST", `/internal/tasks/${taskId}/defer`, {}).catch(() => {});
          await clearInflight(session);
          await notifyTabCleared(tabId);
          await delay(DISPATCH_LOOP_RETRY_MS);
          continue;
        }
        await markInflight(session, taskId, {
          tabId,
          baseline: pageState?.baseline,
          deliveryPhase: "preparing",
          expiresAt: claim.task.expiresAt,
          completionDeadlineAt: claim.task.completionDeadlineAt,
          recoveryDeadlineAt: claim.task.recoveryDeadlineAt,
          lateReplyDeadlineAt: claim.task.lateReplyDeadlineAt,
        });
        await reportTaskProgress(taskId, "submit_started");

        let runRes;
        try {
          runRes = await sendTabMessage(
            tabId,
            { type: "run-task", taskId, text, baseline: pageState?.baseline },
            RUN_TASK_ACK_TIMEOUT_MS,
            "run-task acknowledgement",
          );
        } catch (e) {
          console.warn("[relay sw] run-task acknowledgement unknown", taskId.slice(0, 8), e.message);
          await setClaimPendingReply(
            claim,
            session,
            tabId,
            pageState?.baseline,
            "unknown",
          );
          await waitForPendingReply(taskId, controller.signal);
          continue;
        }

        if (runRes?.error) {
          if (
            runRes.errorCode === "attachment_upload_timeout" ||
            runRes.errorCode === "attachment_upload_failed" ||
            runRes.errorCode === "attachment_cleanup_incomplete"
          ) {
            const errorCode = runRes.errorCode;
            if (runRes.attachmentCleanupConfirmed !== true) {
              await setAttachmentBlock(session, `${errorCode}: ${runRes.error}`);
            }
            await httpJson("POST", `/internal/tasks/${taskId}/complete`, {
              error: errorCode,
            }).catch(() => {});
            await clearInflight(session);
            await notifyTabCleared(tabId);
            await setStorage(STORAGE_KEYS.LAST_ERROR, {
              taskId,
              session,
              error: `${errorCode}: ${runRes.error}`,
              at: Date.now(),
            });

            if (runRes.attachmentCleanupConfirmed !== true) {
              console.warn(
                "[relay sw] attachment cleanup incomplete; later dispatch blocked",
                taskId,
              );
            }
            continue;
          }
          if (runRes.submissionState === "not-submitted" && /waitForPageReady/.test(runRes.error)) {
            await httpJson("POST", `/internal/tasks/${taskId}/defer`, {}).catch(() => {});
            await clearInflight(session);
            await notifyTabCleared(tabId);
            await delay(DISPATCH_LOOP_RETRY_MS);
            continue;
          }
          if (runRes.submissionState !== "not-submitted") {
            await setClaimPendingReply(
              claim,
              session,
              tabId,
              runRes.baseline ?? pageState?.baseline,
              "unknown",
              {
                composerPayloadObservedAfterFailure:
                  runRes.composerPayloadObserved === true,
              },
            );
            await waitForPendingReply(taskId, controller.signal);
            continue;
          }
          throw new Error(runRes.error);
        }
        if (runRes?.status !== "submitted") {
          // Compatibility with older content-script versions.
          if (typeof runRes?.reply === "string") {
            await httpJson("POST", `/internal/tasks/${taskId}/complete`, { text: runRes.reply });
            await clearInflight(session);
            console.log("[relay sw] task completed inline", taskId.slice(0, 8), "completionAt", Date.now());
            continue;
          }
          throw new Error("run-task did not acknowledge submission");
        }

        const submitAcknowledgedProgressReported =
          await reportTaskProgress(taskId, "submit_acknowledged");
        await markInflight(session, taskId, {
          deliveryPhase: "accepted",
          submittedUserMessageId: runRes.submittedUserMessageId ?? null,
        });
        await setClaimPendingReply(
          claim,
          session,
          tabId,
          runRes.baseline ?? pageState?.baseline,
          "accepted",
          {
            submittedUserMessageId: runRes.submittedUserMessageId ?? null,
            wasGenerating: runRes.acceptanceKind === "generating",
            submitAcknowledgedProgressReported,
          },
        );

        // Wait until completion, recovery, or requeue removes the pending reply.
        await waitForPendingReply(taskId, controller.signal);
        console.log("[relay sw] task completed", taskId.slice(0, 8), "completionAt", Date.now());
      } catch (e) {
        console.warn("[relay sw] task failed", taskId.slice(0, 8), e.message);
        await httpJson("POST", `/internal/tasks/${taskId}/complete`, { error: e.message }).catch(() => {});
        await clearInflight(session);
        await notifyTabCleared(tabId);
      }
    }
  } finally {
    if (dispatchLoops.get(session)?.controller === controller) {
      dispatchLoops.delete(session);
    }
  }
}

async function restoreDispatchLoops() {
  const saved = await getStorage("tab_session_map", {});
  const tabs = await listChatGPTTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    const session = tabSessionCache.get(tab.id) ?? saved[tab.id];
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
// The service worker actively polls instead of keeping a content-script wait:
//   1) Chrome freezes MutationObserver and setInterval in background tabs.
//   2) Central worker state recovers from page or extension restarts.
//   3) Each poll-reply message requests one synchronous DOM snapshot.
//
// Pending record shape:
//   {
//     session, tabId, taskId, baseline,
//     submittedAt, lastPollAt,
//     deliveryPhase,           // preparing or a durable post-attempt fence.
//     submittedUserMessageId,  // Exact ChatGPT user message when observable.
//     notStartedCount,          // Consecutive "not-started" samples.
//     stableSampleCount,        // Consecutive identical reply-ready samples.
//     lastSampleText,           // Text from the previous sample.
//   }
async function listPendingReplies() {
  return await getStorage(STORAGE_KEYS.PENDING_REPLIES, {});
}
async function setPendingReply(taskId, rec) {
  const map = await listPendingReplies();
  map[taskId] = rec;
  await setStorage(STORAGE_KEYS.PENDING_REPLIES, map);
  // Ensure a completion deferred exists for the dispatch loop.
  if (!pendingCompletion.has(taskId)) {
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    pendingCompletion.set(taskId, deferred);
  }
  // Trigger the non-blocking fast sampler; this is a no-op if already running.
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
  // The task lifetime is a soft deadline. After it passes, the server exposes
  // a non-terminal recovering state while strong page evidence renews a lease.
  const softDeadline = rec.completionDeadlineAt ??
    ((rec.expiresAt ?? rec.submittedAt + POLL_HARD_TIMEOUT_MS) + 60_000);
  const recoveryDeadline = rec.recoveryDeadlineAt ?? rec.lateReplyDeadlineAt ??
    (softDeadline + POLL_LATE_REPLY_GRACE_MS);
  if (now > recoveryDeadline) {
    console.warn("[relay sw] recovery hard deadline expired", taskId);
    await failPending(taskId, rec, "task_recovery_timeout");
    return;
  }
  if (now > softDeadline) {
    if (!rec.hardTimedOutAt) {
      rec.hardTimedOutAt = now;
      console.warn("[relay sw] soft deadline passed; maintaining recovery", taskId);
      await setPendingReply(taskId, rec);
    }
  }

  // Locate the tab.
  let tabInfo = null;
  try { tabInfo = await chrome.tabs.get(rec.tabId); } catch { tabInfo = null; }
  if (!tabInfo) {
    console.warn("[relay sw] pending tab gone; refusing automatic resend", taskId, rec.tabId);
    await failPending(taskId, rec, "submission_outcome_unknown");
    return;
  }
  if (tabInfo.discarded) {
    const ok = await reviveDiscardedTab(tabInfo);
    if (!ok) return; // wait next tick
  }

  // Request one content-script snapshot.
  let snap;
  try {
    snap = await sendTabMessage(
      rec.tabId,
      {
        type: "poll-reply",
        baseline: rec.baseline,
        submittedUserMessageId: rec.submittedUserMessageId ?? null,
        expectedSession: rec.session,
      },
      POLL_REPLY_SENDMSG_TIMEOUT_MS,
      "poll-reply sendMessage",
    );
  } catch (e) {
    console.warn("[relay sw] poll-reply sendMessage failed", taskId, e.message);
    if (
      hasSendFence(rec) &&
      classifySubmissionVerification("page-unready", rec, false, now) === "fail-unknown"
    ) {
      await failPending(taskId, rec, "submission_outcome_unknown");
      return;
    }
    // One sampling failure is non-terminal; the next alarm retries.
    rec.lastPollAt = now;
    await setPendingReply(taskId, rec);
    return;
  }
  rec.lastPollAt = now;

  dlog("[relay sw] poll-reply snap", taskId.slice(0,8), "status=", snap?.status, "err=", snap?.error, "text=", (snap?.reply ?? snap?.lastText ?? "").slice(0,40));
  if (!snap || snap.error) {
    console.warn("[relay sw] poll-reply error", taskId, snap?.error);
    if (
      hasSendFence(rec) &&
      classifySubmissionVerification("page-unready", rec, false, now) === "fail-unknown"
    ) {
      await failPending(taskId, rec, "submission_outcome_unknown");
      return;
    }
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "safety") {
    console.warn("[relay sw] pending hit safety", taskId, snap.reason);
    await httpJson("POST", `/internal/sessions/${encodeURIComponent(rec.session)}/status`, {
      paused: true, reason: snap.reason ?? "safety",
    }).catch(() => {});
    // Fail the task so the agent can observe the problem.
    await failPending(taskId, rec, `safety: ${snap.reason ?? "unknown"}`);
    return;
  }

  if (snap.status === "page-unready") {
    // Loading and hydration are absence of evidence, not evidence that Send
    // failed. They resolve to unknown only when the fixed verification window
    // has elapsed.
    rec.pageUnreadyReason = snap.reason ?? "unknown";
    rec.uncertainIdleSince = null;
    if (
      hasSendFence(rec) &&
      classifySubmissionVerification(snap.status, rec, false, now) === "fail-unknown"
    ) {
      await failPending(taskId, rec, "submission_outcome_unknown");
      return;
    }
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "session-mismatch") {
    console.warn(
      "[relay sw] pending conversation changed; refusing automatic resend",
      taskId,
      snap.currentSession,
    );
    await failPending(taskId, rec, "submission_outcome_unknown");
    return;
  }

  if (rec.submissionAcknowledged && !rec.submitAcknowledgedProgressReported) {
    rec.submitAcknowledgedProgressReported =
      await reportTaskProgress(taskId, "submit_acknowledged");
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
      if (!rec.replyProgressReported) {
        await reportTaskProgress(taskId, "reply_detected");
        rec.replyProgressReported = true;
      }
      try {
        const captured = await httpJson("POST", `/internal/tasks/${taskId}/capture`, { text });
        console.log(
          "[relay sw] reply captured",
          taskId.slice(0, 8),
          captured?.late ? "late" : "on-time",
        );
      } catch (e) {
        console.warn("[relay sw] capture POST failed", taskId, e.message);
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
    // Generation confirms submission, so reset the not-started counter.
    rec.notStartedCount = 0;
    rec.uncertainIdleSince = null;
    rec.wasGenerating = true;
    rec.deliveryPhase = "accepted";
    rec.ackState = "accepted";
    rec.submissionAcknowledged = true;
    rec.stoppedNoReplyCount = 0;
    rec.stableSampleCount = 0;
    rec.lastSampleText = snap.lastText ?? rec.lastSampleText ?? "";
    rec.submittedUserMessageId =
      rec.submittedUserMessageId ?? snap.submittedUserMessageId ?? null;
    if (!rec.generatingProgressReported) {
      rec.generatingProgressReported =
        await reportTaskProgress(taskId, "generating_seen");
    }
    await reportTaskObservation(taskId, rec, {
      phase: (snap.outputChars ?? 0) > 0 ? "answer_streaming" : "generating",
      activity: snap.activity ?? null,
      outputChars: snap.outputChars ?? 0,
    }, now);
    await reportRecoveryObservation(taskId, rec, now);
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "posted-no-reply-yet") {
    // The user message was submitted but generation has not started.
    rec.notStartedCount = 0;
    rec.uncertainIdleSince = null;
    rec.deliveryPhase = "accepted";
    rec.ackState = "accepted";
    rec.submissionAcknowledged = true;
    if (rec.stopRequestedAt || rec.wasGenerating) {
      rec.stoppedNoReplyCount = (rec.stoppedNoReplyCount ?? 0) + 1;
      if (rec.stoppedNoReplyCount >= 2) {
        await cancelPending(taskId, rec, "user stopped before reply");
        return;
      }
    }
    rec.lastSampleText = snap.lastText ?? rec.lastSampleText ?? "";
    rec.submittedUserMessageId =
      rec.submittedUserMessageId ?? snap.submittedUserMessageId ?? null;
    if (!rec.submitAcknowledgedProgressReported) {
      rec.submitAcknowledgedProgressReported =
        await reportTaskProgress(taskId, "submit_acknowledged");
    }
    await reportTaskObservation(taskId, rec, {
      phase: "accepted",
      activity: null,
      outputChars: 0,
    }, now);
    await reportRecoveryObservation(taskId, rec, now);
    await setPendingReply(taskId, rec);
    return;
  }

  if (snap.status === "not-started") {
    if (rec.stopRequestedAt) {
      await cancelPending(taskId, rec, "user stopped before request was sent");
      return;
    }
    if (hasSendFence(rec)) {
      // The task crossed (or may have crossed) the Send boundary. Keep a fixed
      // verification window from the durable fence so a queued successor cannot
      // turn a transient empty DOM into an early terminal failure.
      rec.notStartedCount = 0;
      rec.deliveryUnconfirmedCount = (rec.deliveryUnconfirmedCount ?? 0) + 1;
      rec.uncertainIdleSince ??= now;
      const composerHasPayload = snap.composerClean === false ||
        (snap.composer?.textLength ?? 0) > 0 ||
        snap.composer?.attachmentPresent === true ||
        snap.composer?.uploading === true;
      const verification = classifySubmissionVerification(
        snap.status,
        rec,
        composerHasPayload,
        now,
      );
      if (verification === "fail-not-observed") {
        await failUnobservedPending(taskId, rec);
        return;
      }
      if (verification === "fail-unknown") {
        await failPending(taskId, rec, "submission_outcome_unknown");
        return;
      }
      await setPendingReply(taskId, rec);
      return;
    }
    rec.notStartedCount = (rec.notStartedCount ?? 0) + 1;
    if (rec.hardTimedOutAt && rec.notStartedCount >= 2) {
      await abandonPending(taskId, rec, "server deadline passed before page submission");
      return;
    }
    if (rec.notStartedCount >= POLL_NOT_STARTED_MAX) {
      console.warn("[relay sw] pending never left not-started; failing", taskId);
      await failPending(taskId, rec, "send appears to have failed (no user/assistant message change)");
      return;
    }
    await setPendingReply(taskId, rec);
    return;
  }

  // Persist unknown status conservatively.
  await setPendingReply(taskId, rec);
}

async function resetComposerBestEffort(tabId) {
  if (!tabId) return false;
  const result = await sendTabMessage(
    tabId,
    { type: "reset-composer" },
    PAGE_STATE_SENDMSG_TIMEOUT_MS,
    "reset-composer",
  ).catch((e) => {
    console.warn("[relay sw] composer reset failed", tabId, e.message);
    return null;
  });
  return result?.clean === true;
}

async function failPending(taskId, rec, reason, options = {}) {
  let terminalConfirmed = false;
  try {
    await httpJson("POST", `/internal/tasks/${taskId}/complete`, { error: reason });
    terminalConfirmed = true;
  } catch (e) {
    console.warn("[relay sw] failPending POST failed", taskId, e.message);
    const current = await httpJson("GET", `/v1/tasks/${taskId}`).catch(() => null);
    terminalConfirmed = current != null &&
      ["done", "failed", "cancelled", "expired"].includes(current.status);
  }
  const shouldResetComposer = options.resetComposer === true ||
    reason === "submission_not_observed" ||
    reason === "submission_outcome_unknown";
  if (shouldResetComposer) {
    const clean = await resetComposerBestEffort(rec.tabId);
    if (!clean) {
      console.warn("[relay sw] continuing after incomplete composer reset", taskId);
    }
  }
  if (!terminalConfirmed) {
    await setPendingReply(taskId, rec);
    return false;
  }
  await deletePendingReply(taskId);
  await clearInflight(rec.session);
  await notifyTabCleared(rec.tabId);
  await setStorage(STORAGE_KEYS.LAST_ERROR, {
    taskId, session: rec.session, error: reason, at: Date.now(),
  });
  return true;
}

async function failUnobservedPending(taskId, rec) {
  const reason = "submission_not_observed";
  await failPending(taskId, rec, reason, { resetComposer: true });
}

async function abandonPending(taskId, rec, reason) {
  await deletePendingReply(taskId);
  await clearInflight(rec.session);
  await notifyTabCleared(rec.tabId);
  await setStorage(STORAGE_KEYS.LAST_ERROR, {
    taskId, session: rec.session, error: reason, at: Date.now(),
  });
}

async function cancelPending(taskId, rec, reason) {
  try {
    await httpJson("POST", `/internal/tasks/${taskId}/user-stop`, { reason });
  } catch (e) {
    console.warn("[relay sw] cancelPending POST failed", taskId, e.message);
  }
  await deletePendingReply(taskId);
  await clearInflight(rec.session);
  await notifyTabCleared(rec.tabId);
  await setStorage(STORAGE_KEYS.LAST_ERROR, {
    taskId, session: rec.session, error: reason, at: Date.now(),
  });
}

// Fast sampling scheduler. Chrome alarms have a one-minute minimum, which is
// too coarse for active replies. While pending work exists, FAST_POLL_MS
// setTimeout recursion samples quickly. Alarm and heartbeat provide recovery.
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

// Polling entry point for continuous per-session long polls.
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

// Reconcile orphaned in-flight state whenever the service worker wakes.
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
  // 1) A missing session mapping can be a transient page-refresh condition.
  // Keep the durable record until task-state reconciliation proves it is safe
  // to clear; dropping it here would erase the at-most-once send fence.
  for (const s of Object.keys(inflight)) {
    if (!liveSessions.has(s)) {
      dlog("[relay sw] reconcile: session mapping temporarily missing", s.slice(0, 8));
    }
  }
  // 2) Usually remove terminal tasks. Keep recoverable timeout failures during
  // the late-reply window so they continue blocking the next dispatch.
  const still = await getStorage(STORAGE_KEYS.INFLIGHT, {});
  for (const [session, entry] of Object.entries(still)) {
    if (!entry?.taskId) continue;
    try {
      const t = await httpJson("GET", `/v1/tasks/${entry.taskId}`);
      if (t?.status === "in_progress" || t?.status === "recovering") {
        const action = classifyRecoveryAction(t, entry);
        let tabId = entry.tabId ?? null;
        if (!tabId) {
          for (const [tid, sid] of tabSessionCache.entries()) {
            if (sid === session) { tabId = tid; break; }
          }
        }
        if (action === "reattach" && tabId) {
          await attachPendingFromTask(t, session, tabId, entry);
        } else if (action === "defer") {
          await httpJson("POST", `/internal/tasks/${entry.taskId}/defer`, {}).catch(() => {});
          await clearRecoveredTask(entry.taskId, session, tabId);
        }
        continue;
      }
      const keepForLate = t?.status === "failed" &&
        hasSendFence(entry, t) &&
        !t.lateReply &&
        t.lateReplyDeadlineAt > Date.now() &&
        [
          "task_processing_timeout",
          "submission_outcome_unknown",
          "task_recovery_timeout",
          "task_recovery_lease_expired",
          "session_heartbeat_lost",
          "aborted",
        ].includes(t.error);
      if (keepForLate) {
        const pmap = await listPendingReplies();
        if (!pmap[entry.taskId]) {
          let tabId = entry.tabId ?? null;
          if (!tabId) {
            for (const [tid, sid] of tabSessionCache.entries()) {
              if (sid === session) { tabId = tid; break; }
            }
          }
          let baseline = entry.baseline ?? null;
          if (tabId && !baseline) {
            const pageInflight = await sendTabMessage(
              tabId,
              { type: "get-inflight" },
              PAGE_STATE_SENDMSG_TIMEOUT_MS,
              "get-inflight",
            ).catch(() => null);
            if (pageInflight?.inflight?.taskId === entry.taskId) {
              baseline = pageInflight.inflight.baseline ?? null;
            }
          }
          if (tabId && baseline) {
            await attachPendingFromTask(t, session, tabId, {
              ...entry,
              baseline,
              deliveryPhase: entry.deliveryPhase ?? "unknown",
            });
          }
        }
        continue;
      }
      if (t && ["done", "failed", "cancelled", "expired"].includes(t.status) && !keepForLate) {
        console.log("[relay sw] reconcile: task", entry.taskId.slice(0, 8), "already", t.status, "→ clearing inflight");
        // Find tabId from pending replies, then fall back to the session map.
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
      // Ignore relay unavailability and retry during the next cycle.
    }
  }
}

async function clearRecoveredTask(taskId, session, tabId) {
  await deletePendingReply(taskId);
  await clearInflight(session);
  await notifyTabCleared(tabId);
}

async function recoverInflightForTab(msg, tabId) {
  const task = await httpJson("GET", `/v1/tasks/${msg.taskId}`);
  const session = task.session;
  const record = {
    baseline: msg.baseline,
    deliveryPhase: msg.deliveryPhase ?? msg.phase,
    submittedAt: msg.submittedAt,
    submittedUserMessageId: msg.submittedUserMessageId,
    stopRequestedAt: msg.stopRequestedAt,
    composerPayloadObservedAfterFailure:
      msg.composerPayloadObservedAfterFailure === true,
  };

  if (
    msg.stopRequestedAt &&
    (task.status === "queued" || task.status === "in_progress" || task.status === "recovering")
  ) {
    await httpJson("POST", `/internal/tasks/${task.taskId}/user-stop`, {
      reason: "user stopped before reply",
    });
    await clearRecoveredTask(task.taskId, session, tabId);
    return { action: "clear", status: "cancelled" };
  }

  let action = classifyRecoveryAction(task, record);
  if (msg.conversationChanged) {
    action = hasSendFence(record, task) ? "fail-uncertain" : "defer";
  }

  if (action === "clear") {
    await clearRecoveredTask(task.taskId, session, tabId);
    return { action: "clear", status: task.status };
  }

  if (action === "defer") {
    if (task.status === "in_progress") {
      await httpJson("POST", `/internal/tasks/${task.taskId}/defer`, {});
    }
    await clearRecoveredTask(task.taskId, session, tabId);
    return { action: "deferred", status: "queued" };
  }

  if (action === "fail-uncertain") {
    if (
      task.status === "queued" ||
      task.status === "in_progress" ||
      task.status === "recovering"
    ) {
      await httpJson("POST", `/internal/tasks/${task.taskId}/complete`, {
        error: "submission_outcome_unknown",
      });
    }
    const failed = await httpJson("GET", `/v1/tasks/${task.taskId}`);
    if (!msg.conversationChanged && isRecoverableLateReply(failed)) {
      await attachPendingFromTask(failed, session, tabId, {
        ...record,
        deliveryPhase: "unknown",
      });
      return {
        action: "reattached",
        status: failed.status,
        deliveryPhase: "unknown",
      };
    }
    await clearRecoveredTask(task.taskId, session, tabId);
    return {
      action: "clear",
      status: failed.status,
      error: "submission_outcome_unknown",
    };
  }

  if (action === "reattach") {
    await attachPendingFromTask(task, session, tabId, record);
    void pollPendingReplies();
    startDispatchLoop(session, tabId).catch(() => {});
    return {
      action: "reattached",
      status: task.status,
      deliveryPhase: inferDeliveryPhase(task, record),
    };
  }

  return { action: "wait", status: task.status };
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
    // The alarm is a recovery mechanism that restarts every session dispatch loop.
    void restoreDispatchLoops();
  } else if (alarm.name === HEARTBEAT_ALARM_NAME) {
    void heartbeatOnce();
    setTimeout(() => void heartbeatOnce(), HEARTBEAT_INTERVAL_MS);
    setTimeout(() => void heartbeatOnce(), 2 * HEARTBEAT_INTERVAL_MS);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { void forgetTabSession(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  // Project navigation can change the path without changing the conversation.
  // Keep that dispatch loop; for a different route, query the content script
  // immediately after clearing the old mapping instead of waiting for an alarm.
  let routeSession = null;
  try {
    const url = new URL(info.url);
    if (url.hostname === "chatgpt.com") {
      routeSession = url.pathname.match(/\/c\/([a-f0-9-]+)(?:\/|$)/)?.[1] ?? null;
    }
  } catch { /* invalid navigation URL */ }
  if (routeSession && routeSession === tabSessionCache.get(tabId)) return;
  void forgetTabSession(tabId).then(() => handleTab(tabId));
});

chrome.runtime.onInstalled.addListener(() => { void ensureAlarms(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarms(); });
void ensureAlarms();
void loadTabSessionCache();
void reconcileInflight();
void pollPendingReplies();
void restoreDispatchLoops();

// Message bridge.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

 if (type === "session-hello") {
   if (sender.tab?.id && msg.session) {
     rememberTabSession(sender.tab.id, msg.session).then(() => {
        void startDispatchLoop(msg.session, sender.tab.id).catch((e) =>
          console.warn("[relay sw] hello dispatch loop failed", e),
        );
        sendResponse({ status: "ok" });
      }).catch((e) => sendResponse({ error: e.message }));
   } else {
     sendResponse({ error: "missing session or tab" });
    }
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
    // The content script will reload; remove the session to prevent false recovery.
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

  if (type === "send-attempted") {
    (async () => {
      try {
        if (!sender.tab?.id) {
          sendResponse({ error: "no tab for send fence" });
          return;
        }
        const sid = await getTabSession(sender.tab.id);
        if (!sid) {
          sendResponse({ error: "no session for send fence" });
          return;
        }
        const task = await httpJson("GET", `/v1/tasks/${msg.taskId}`);
        if (task.session !== sid || task.status !== "in_progress") {
          sendResponse({
            error: `cannot fence task in ${task.status} for session ${sid}`,
          });
          return;
        }

        // Write the browser-side fence first, then persist the same boundary in
        // SQLite. The content script must not click Send until this round trip
        // succeeds.
        await markInflight(sid, msg.taskId, {
          tabId: sender.tab.id,
          baseline: msg.baseline,
          deliveryPhase: "send-attempted",
        });
        await httpJson("POST", `/internal/tasks/${msg.taskId}/progress`, {
          phase: "send_attempted",
        });
        const fencedTask = await httpJson("GET", `/v1/tasks/${msg.taskId}`);
        await attachPendingFromTask(fencedTask, sid, sender.tab.id, {
          baseline: msg.baseline,
          deliveryPhase: "send-attempted",
        });
        sendResponse({ status: "fenced", taskId: msg.taskId });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (type === "submission-failed-evidence") {
    (async () => {
      try {
        if (!sender.tab?.id) {
          sendResponse({ error: "no tab for submission failure evidence" });
          return;
        }
        const rec = await getPendingReply(msg.taskId);
        if (!rec || rec.tabId !== sender.tab.id || !hasSendFence(rec)) {
          sendResponse({ error: "no matching fenced task" });
          return;
        }
        rec.composerPayloadObservedAfterFailure =
          rec.composerPayloadObservedAfterFailure === true ||
          msg.composerPayloadObserved === true;
        await setPendingReply(msg.taskId, rec);
        sendResponse({ status: "recorded" });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (type === "recover-inflight") {
    (async () => {
      try {
        if (!sender.tab?.id) {
          sendResponse({ error: "no tab for recovery" });
          return;
        }
        const result = await recoverInflightForTab(msg, sender.tab.id);
        sendResponse(result);
      } catch (e) {
        console.warn("[relay sw] recover-inflight failed", msg.taskId, e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (type === "reattach-pending") {
    (async () => {
      try {
        if (!sender.tab?.id) { sendResponse({ error: "no tab" }); return; }
        const result = await recoverInflightForTab({
          ...msg,
          deliveryPhase: msg.submissionState ?? "unknown",
        }, sender.tab.id);
        sendResponse({ status: "ok", ...result });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (type === "user-stop-requested") {
    (async () => {
      try {
        const rec = await getPendingReply(msg.taskId);
        if (!rec) {
          await httpJson("POST", `/internal/tasks/${msg.taskId}/user-stop`, {
            reason: "user stopped before reply",
          }).catch(() => {});
          sendResponse({ status: "cancelled" });
          return;
        }
        rec.stopRequestedAt = Date.now();
        rec.stoppedNoReplyCount = 0;
        await setPendingReply(msg.taskId, rec);
        setTimeout(() => { void pollPendingReplies(); }, 400);
        sendResponse({ status: "stop-requested" });
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
        // Find the session and clear its in-flight state.
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

  if (type === "popup-poll-now") {
    restoreDispatchLoops().then(() => sendResponse({ status: "ok" })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (type === "popup-get-state") {
    (async () => {
      const [inflight, cfg, lastError, pendingReplies, attachmentBlocks] = await Promise.all([
        getStorage(STORAGE_KEYS.INFLIGHT, {}),
        getStorage("config", {}),
        getStorage(STORAGE_KEYS.LAST_ERROR, null),
        getStorage(STORAGE_KEYS.PENDING_REPLIES, {}),
        listAttachmentBlocks(),
      ]);
      const tabs = await listChatGPTTabs();
      const tabsInfo = await Promise.all(tabs.map(async (t) => {
        if (!t.id) return null;
        const freshSid = await getTabSession(t.id, { forceFresh: true });
        const sid = freshSid ?? tabSessionCache.get(t.id) ?? null;
        const page = freshSid ? await getPageState(t.id).catch(() => null) : null;
        return {
          tabId: t.id, url: t.url, title: t.title, session: sid,
          page: page ? {
            session: page.session,
            ready: page.ready,
            reason: page.reason,
            userCount: page.baseline?.userCount ?? 0,
            assistantCount: page.baseline?.assistantCount ?? 0,
            attachmentPresent: page.composer?.attachmentPresent === true,
            uploading: page.composer?.uploading === true,
            sendEnabled: page.composer?.sendEnabled === true,
          } : null,
          offline: sid ? offlineSessions.has(sid) : false,
        };
      }));
      sendResponse({
        inflight, cfg, lastError, attachmentBlocks, tabs: tabsInfo.filter(Boolean),
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
      const attachmentBlocks = await listAttachmentBlocks();
      await setStorage(STORAGE_KEYS.INFLIGHT, {});
      await setStorage(STORAGE_KEYS.PENDING_REPLIES, {});
      await mutateAttachmentBlocks((blocks) => {
        for (const session of Object.keys(blocks)) delete blocks[session];
      });
      for (const session of Object.keys(attachmentBlocks)) {
        await httpJson(
          "POST",
          `/internal/sessions/${encodeURIComponent(session)}/status`,
          { paused: false },
        ).catch(() => {});
      }
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
