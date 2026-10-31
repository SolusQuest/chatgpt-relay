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
import { DispatchClient, RequestPool } from "./lib/dispatch-client.js";
import { createPageManager } from "./lib/page-manager.js";

// Development debugging: set DEBUG to true or window.__gptRelayDebug in the popup.
const DEBUG = false;
const dlog = (...args) => { if (DEBUG) console.log(...args); };

// Continuous per-session task dispatch loops.
const dispatchLoops = new Map(); // session -> { tabId, controller }
// Unlike dispatchLoops, ownership survives an abort until run-task settles.
// This is intentionally ephemeral: after a worker restart all records are orphans.
const activeDispatchTasks = new Set();
// taskId to deferred completion waiter.
const pendingCompletion = new Map();
const stopRequests = new Map(); // Immediate intent while its storage write is pending.
const pendingPolls = new Map(); // Alarm, fast sampler and Stop may overlap.
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const requestPool = new RequestPool();
let dispatchMode = null;
let dispatchSetup = null;
let dispatchClient = null;
let dispatchState = { state: "connecting", lastConnectedAt: null, lastError: null };
const dispatchPages = new Map();
const dispatchWork = new Map();
const registrationCache = new Map();
const registrationPending = new Map();
const registrationEpochs = new Map();
const registrationResults = new WeakMap();
const capacityWaiting = new Set();
const reopenPending = new Map();
let snapshotRevision = 0;
let pageManager;
let backendChanging = false;
let backendIdentityRestore;
const acknowledgedPages = new Map();
const executingControls = new Map();

function getPageManager() {
  pageManager ??= createPageManager({
    storageGet: key => getStorage(key, {}), storageSet: setStorage,
    listTabs: () => chrome.tabs.query({}), getPageState,
    inspectSession: async session => {
      const view = await httpJson("GET", `/v1/sessions/${encodeURIComponent(session)}/inspect`, undefined, 5000);
      return { safeIdle: view.page?.ready === true, queued: view.queuedTasks > 0,
        activeTask: !!view.activeTaskId, recovery: view.activeTaskStatus === "recovering",
        latePending: view.latePending, controlsPending: view.controlsPending };
    },
    listPending: async () => {
      const [pending, inflight] = await Promise.all([listPendingReplies(), getStorage(STORAGE_KEYS.INFLIGHT, {})]);
      return [...Object.values(pending), ...Object.entries(inflight).map(([session, entry]) => ({ ...entry, session }))];
    },
    closePage: async (record, state) => {
      await reportSessionSnapshots();
      await reportBrowserInventory();
      const operationId = crypto.randomUUID();
      await httpJson("POST", "/v1/session-controls", { operationId, session: record.session, kind: "close", automatic: true });
      const { command } = await httpJson("POST", "/internal/session-controls/claim", { owner: await creationOwner(), operationId });
      if (!command) throw new Error("automatic_close_unavailable");
      command.expectedActivityRevision = state.activityRevision;
      const outcome = await runControlOnce(command);
      if (outcome.state !== "succeeded") throw new Error(outcome.error ?? "automatic_close_failed");
    },
  });
  return pageManager;
}
async function maxManagedTabs() {
  const value = (await getStorage("config", {})).maxManagedTabs;
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 6;
}
async function dispatchMembership() {
  const tabs = await listChatGPTTabs();
  const ids = new Set(tabs.map(tab => tab.id));
  const grouped = new Map();
  for (const page of dispatchPages.values()) {
    if (!ids.has(page.tabId)) continue;
    const matches = grouped.get(page.session) ?? [];
    matches.push(page); grouped.set(page.session, matches);
  }
  // Multiple tabs of one conversation are deliberately not auto-selected.
  const pages = [...grouped.values()].filter(matches => matches.length === 1).flat();
  const parked = await getStorage("parked_sessions", {});
  for (const record of Object.values(parked)) {
    if (grouped.has(record.session) || record.status !== "closed") continue;
    pages.push({ session: record.session, tabId: null, documentId: null });
  }
  return pages;
}
async function ensureDispatch() {
  if (!await restoreBackendIdentities()) throw new Error("backend_identity_recovery_pending");
  if (dispatchMode) return dispatchMode;
  if (dispatchSetup) return dispatchSetup;
  dispatchSetup = (async () => {
    const info = await httpJson("GET", "/v1/server", undefined, 5000);
    dispatchMode = info?.capabilities?.dispatchV2 === true ? "v2" : "legacy";
    if (dispatchMode === "legacy") {
      dispatchState = { state: "legacy", lastConnectedAt: Date.now(), lastError: null };
      return dispatchMode;
    }
    dispatchClient = new DispatchClient({
      membership: dispatchMembership,
      watch: async (request, signal) => {
        const result = await httpJson("POST", "/internal/dispatch/watch", { ...request,
          owner: await creationOwner(), generation: String(await inventoryGeneration()) }, 26000, signal);
        if (!signal.aborted) {
          acknowledgedPages.clear();
          const blocked = new Set((result.blockedSessions ?? []).map(entry => entry.session));
          dispatchState = { ...dispatchState, blockedSessions: result.blockedSessions ?? [] };
          for (const page of request.sessions) if (!blocked.has(page.session)) acknowledgedPages.set(page.session, page);
        }
        return result;
      },
      onState: state => { dispatchState = { ...dispatchState, ...state }; },
      onSnapshot: async snapshot => {
        dispatchWork.clear();
        for (const work of snapshot.sessions ?? []) {
          dispatchWork.set(work.session, work);
          if (!work.activeTaskId && ((!work.queuedTasks && !work.paused) || work.suspended)) continue;
          const page = acknowledgedPages.get(work.session);
          if (page?.tabId != null) void startDispatchLoop(work.session, page.tabId).catch(error => dlog("dispatch", error));
          else if (work.queuedTasks && !work.suspended && !work.paused) void reopenParkedSession(work.session);
        }
        if (snapshot.pendingCommands?.sessionCreation) void processSessionCreations();
        if (snapshot.pendingCommands?.sessionControl) void processSessionControls();
        if (snapshot.pendingCommands?.projectDiscovery) void processProjectDiscoveries();
      },
    });
    void dispatchClient.start();
    return dispatchMode;
  })().catch(error => {
    dispatchState = { ...dispatchState, state: "disconnected", lastError: error.message };
    throw error;
  }).finally(() => { dispatchSetup = null; });
  return dispatchSetup;
}
async function reopenParkedSession(session) {
  if (reopenPending.has(session)) return reopenPending.get(session);
  const operation = (async () => {
    const parked = (await getStorage("parked_sessions", {}))[session];
    if (parked?.status !== "closed") return;
    try {
      const operations = await getStorage("reopen_operations", {});
      let operationId = operations[session];
      if (operationId) {
        const prior = await httpJson("GET", `/v1/operations/${operationId}`);
        if (["queued", "claimed", "executing", "unknown"].includes(prior.state)) return;
        if (prior.state === "succeeded") { await mutateStorageMap("parked_sessions", map => { delete map[session]; }); return; }
      }
      operationId = crypto.randomUUID();
      await mutateStorageMap("reopen_operations", map => { map[session] = operationId; });
      await httpJson("POST", "/v1/session-controls", { operationId, session, kind: "open", instanceId: await creationOwner() });
      void processSessionControls();
    } catch (error) { dlog("reopen parked session", error.message); }
  })().finally(() => reopenPending.delete(session));
  reopenPending.set(session, operation);
  return operation;
}

async function claimForPage(session, tabId, state, signal) {
  if (dispatchMode !== "v2") return httpJson("GET", `/internal/next_task?session=${encodeURIComponent(session)}&wait=0`, undefined, 8000, signal);
  const page = acknowledgedPages.get(session);
  if (page?.tabId !== tabId || page.documentId !== state.documentId) { dispatchClient?.wake(); return { task: null }; }
  const baseUrl = await getBaseUrl();
  let intent = (await getStorage("dispatch_claim_intents", {}))[session];
  if (intent && intent.baseUrl !== baseUrl) throw new Error("dispatch_backend_changed");
  if (!intent) {
    intent = { baseUrl, request: { owner: await creationOwner(), generation: String(await inventoryGeneration()),
      session, tabId, documentId: state.documentId, requestId: crypto.randomUUID() } };
    await mutateStorageMap("dispatch_claim_intents", map => { map[session] = intent; });
  }
  const generation = String(await inventoryGeneration());
  const resume = intent.request.generation !== generation || intent.request.tabId !== tabId || intent.request.documentId !== state.documentId;
  if (resume && (intent.resume?.generation !== generation || intent.resume?.tabId !== tabId || intent.resume?.documentId !== state.documentId)) {
    intent.resume = { generation, tabId, documentId: state.documentId, requestId: crypto.randomUUID() };
    await mutateStorageMap("dispatch_claim_intents", map => { map[session] = intent; });
  }
  const request = resume ? { ...intent.request, generation, originalGeneration: intent.request.generation,
    tabId, documentId: state.documentId, resumeRequestId: intent.resume.requestId } : intent.request;
  const claim = await httpJson("POST", resume ? "/internal/dispatch/resume" : "/internal/dispatch/claim", request, 8000, signal);
  await mutateTaskStorage(async () => {
    const intents = await getStorage("dispatch_claim_intents", {});
    const tokens = await getStorage("dispatch_task_tokens", {});
    if (claim.task) {
      tokens[claim.task.taskId] = { baseUrl, claimToken: claim.task.claimToken, session, tabId, documentId: state.documentId,
        expiresAt: claim.task.lateReplyDeadlineAt ?? claim.task.expiresAt };
      intents[session] = { baseUrl, taskId: claim.task.taskId, request: { ...request } };
      delete intents[session].request.originalGeneration;
      delete intents[session].request.resumeRequestId;
      if (resume) intents[session].request.requestId = request.resumeRequestId;
      // Post-Send resume does not create a new claim request. Keep its original identity.
      if (resume && claim.task.sendAttemptedAt != null) intents[session].request = intent.request;
    } else delete intents[session];
    await chrome.storage.local.set({ dispatch_claim_intents: intents, dispatch_task_tokens: tokens });
  });
  return claim;
}

async function getStorage(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] ?? fallback;
}
async function setStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
const storageMutations = new Map();
// All writes to task ownership and pending observations share one queue. Epochs
// fence asynchronous readers in this worker; no old reader survives a restart.
let taskStorageMutation = Promise.resolve();
const taskEpochs = new Map();
const retiredTasks = new Set();
function mutateTaskStorage(mutate) {
  const operation = taskStorageMutation.then(mutate);
  taskStorageMutation = operation.catch(() => {});
  return operation;
}
function captureTaskEpochs() {
  return mutateTaskStorage(() => new Map(taskEpochs));
}
function bumpTaskEpoch(session) {
  taskEpochs.set(session, (taskEpochs.get(session) ?? 0) + 1);
}
function mutateStorageMap(key, mutate) {
  const run = async () => {
    const map = await getStorage(key, {});
    const result = mutate(map);
    await setStorage(key, map);
    return result;
  };
  if (key === STORAGE_KEYS.INFLIGHT || key === STORAGE_KEYS.PENDING_REPLIES) return mutateTaskStorage(run);
  const operation = (storageMutations.get(key) ?? Promise.resolve()).then(run);
  storageMutations.set(key, operation.catch(() => {}));
  return operation;
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

async function httpJson(method, url, body, timeoutMs = 8000, signal) {
  const base = await getBaseUrl();
  const taskId = method === "POST" && url.match(/^\/internal\/tasks\/([^/]+)\//)?.[1];
  if (taskId) {
    const token = (await getStorage("dispatch_task_tokens", {}))[taskId];
    if (token?.baseUrl === base && !Object.hasOwn(body ?? {}, "claimToken")) body = { ...body, claimToken: token.claimToken };
  }
  const operation = () => fetchJson(base, method, url, body, timeoutMs, signal);
  if (url === "/internal/dispatch/watch") return operation();
  return requestPool.run(operation, { signal, background: /session-snapshots|browser-inventory/.test(url) });
}
async function fetchJson(base, method, url, body, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const abort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", abort, { once: true });
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
    signal?.removeEventListener("abort", abort);
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
  if (cached && verifiedTabSessions.has(tabId) && !opts.forceFresh) return cached;
  // Cold path: query the content script.
  try {
    const r = await sendTabMessage(tabId, { type: "get-session-id" }, 3000, "get-session-id");
    if (r?.session) {
      const page = await registerPageSession(tabId, r);
      await rememberTabSession(tabId, page.session, registrationResults.get(page));
      return page.session;
    }
    if (r?.session === null) await handleNullPage(tabId, r);
    return null;
  } catch {
    return null;
  }
}

// Tab-to-session cache. Suspension clears memory, but content scripts report
// session-hello periodically so the next alarm can rebuild the mapping.
const tabSessionCache = new Map();
const verifiedTabSessions = new Set(); // Persisted mappings require fresh page registration after worker restart.

let ownerPromise;
function creationOwner() {
  ownerPromise ??= (async () => {
    const saved = await getStorage("creation_owner", null);
    if (saved) return saved;
    const owner = crypto.randomUUID();
    await setStorage("creation_owner", owner);
    return owner;
  })();
  return ownerPromise;
}

let inventoryGenerationPromise;
function inventoryGeneration() {
  inventoryGenerationPromise ??= (async () => {
    const previous = await getStorage("browser_inventory_generation", 0);
    const generation = Number.isSafeInteger(previous) ? previous + 1 : 1;
    await setStorage("browser_inventory_generation", generation);
    return generation;
  })();
  return inventoryGenerationPromise;
}
function tabRoute(tab) {
  try {
    const url = new URL(tab.pendingUrl || tab.url);
    if (url.origin !== "https://chatgpt.com") return null;
    const match = url.pathname.match(/^(?:\/g\/(g-[A-Za-z0-9-]+))?\/c\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i);
    const project = match?.[1]?.match(/^(g-p-[a-f0-9]{32})(?:-|$)/i)?.[1] ?? match?.[1] ?? null;
    return { conversationId: match?.[2] ?? null, projectId: project?.toLowerCase() ?? null };
  } catch { return null; }
}
let inventoryRevision = 0;
let inventoryRunning = null;
function reportBrowserInventory() {
  if (backendChanging) return Promise.resolve();
  if (inventoryRunning) return inventoryRunning;
  inventoryRunning = (async () => {
    const owner = await creationOwner(), generation = await inventoryGeneration();
    const lifecycle = await getStorage("page_lifecycle", {});
    const tabs = (await listChatGPTTabs()).filter(tab => tab.id != null).map(tab => ({
      tabId: tab.id, ...tabRoute(tab), loading: tab.status === "loading", discarded: tab.discarded ?? null,
      lifecyclePolicy: lifecycle[tab.id]?.lifecyclePolicy ?? "protected",
    }));
    await httpJson("POST", "/internal/browser-inventory", { owner, generation, revision: ++inventoryRevision,
      observedAt: Date.now(), dispatch: { ...dispatchState, waitingSessions: [...capacityWaiting] },
      version: chrome.runtime.getManifest?.().version ?? null, controls: ["open", "close"], tabs }, 5000);
  })().finally(() => { inventoryRunning = null; });
  return inventoryRunning;
}
async function pollBrowserInventory() {
  try { await reportBrowserInventory(); } catch (error) { dlog("browser inventory", error); }
  finally { setTimeout(() => void pollBrowserInventory(), 10000); }
}
async function creationAction(meta, action, extra = {}) {
  return httpJson("POST", `/internal/session-creations/${encodeURIComponent(meta.sessionRef)}/${action}`,
    { owner: await creationOwner(), token: meta.token, ...extra });
}
async function registerManagedPage(tabId, page, assertCurrent = () => {}) {
  const m = page.managed;
  if (m.owner !== await creationOwner()) {
    throw new Error("creation page identity mismatch");
  }
  let attached;
  try { attached = await creationAction(m, "attach", { tabId }); }
  catch (e) {
    if (e.status !== 409) throw e;
    const saved = await creationAction(m, "inspect");
    if (saved.tabId == null || saved.tabId === tabId) throw e;
    let oldPresent = false;
    try { await chrome.tabs.get(saved.tabId); oldPresent = true; } catch { /* A restored tab can receive a new browser ID. */ }
    if (oldPresent) throw e;
    await creationAction(m, "reattach", { tabId, previousTabId: saved.tabId, previousTabMissing: true });
    attached = await creationAction(m, "attach", { tabId });
  }
  if (page.session !== m.sessionRef || page.projectId !== m.projectId) {
    if (attached.creationStatus !== "created") await creationAction(m, "fail", { error: "creation_route_mismatch" });
    throw new Error("creation page identity mismatch");
  }
  if (page.conversationId) {
    if (attached.creationStatus !== "created" && page.hasHistory && !page.postSend) {
      await creationAction(m, "fail", { error: "unexpected_existing_conversation" });
      throw new Error("creation navigated into existing history before Send");
    }
    const bound = await creationAction(m, "bind", { tabId, conversationId: page.conversationId, projectId: page.projectId });
    const config = { ...m, boundConversation: bound.conversationId };
    assertCurrent();
    await mutateStorageMap("creation_tabs", map => { assertCurrent(); map[tabId] = config; });
    assertCurrent();
    try { await sendTabMessage(tabId, { type: "configure-session", managed: config }, 5000, "configure-session"); }
    catch { /* The next page registration can restore this binding. */ }
    return bound;
  }
  return { status: "ok" };
}
async function registerPageSession(tabId, page) {
  const signature = JSON.stringify([page.session, page.conversationId, page.projectId, page.managed, page.postSend, page.documentId]);
  const pending = registrationPending.get(tabId);
  if (pending?.signature === signature) return pending.promise;
  const epoch = (registrationEpochs.get(tabId) ?? 0) + 1;
  registrationEpochs.set(tabId, epoch);
  const assertCurrent = () => {
    if (registrationEpochs.get(tabId) !== epoch || backendChanging) throw new Error("registration_superseded");
  };
  const promise = (async () => {
    if (backendChanging) throw new Error("backend_change_in_progress");
    if (!await restoreBackendIdentities()) throw new Error("backend_identity_recovery_pending");
    assertCurrent();
    const saved = registrationCache.get(tabId);
    if (saved?.signature === signature && Date.now() - saved.at < 60000) {
      registrationResults.set(saved.page, epoch);
      return saved.page;
    }
    const registered = await registerPageIdentity(tabId, page, assertCurrent);
    assertCurrent();
    // The response may belong to a document that navigated while HTTP binding
    // was outstanding. Observe the document directly before applying authority.
    if (page.documentId) {
      const fresh = await sendTabMessage(tabId, { type: "get-session-id" }, 3000, "registration validation");
      assertCurrent();
      if (fresh?.documentId !== page.documentId || fresh.session !== page.session ||
          fresh.conversationId !== page.conversationId) throw new Error("registration_superseded");
    }
    const previous = (await getStorage("page_lifecycle", {}))[tabId];
    assertCurrent();
    // A delayed pre-binding response cannot regress this same creation's binding.
    if (previous?.session === registered.session && previous.conversationId && !registered.conversationId)
      throw new Error("registration_superseded");
    await getPageManager().remember(tabId, { session: registered.session,
      conversationId: registered.conversationId ?? null, projectId: registered.projectId ?? null,
      ...(previous?.conversationId && previous.conversationId !== registered.conversationId
        ? { lifecyclePolicy: "protected", provenance: "manual", managementGranted: false } : {}) },
      () => registrationEpochs.get(tabId) === epoch && !backendChanging);
    assertCurrent();
    registrationResults.set(registered, epoch);
    registrationCache.set(tabId, { signature, page: registered, at: Date.now() });
    return registered;
  })().finally(() => { if (registrationPending.get(tabId)?.promise === promise) registrationPending.delete(tabId); });
  registrationPending.set(tabId, { signature, promise });
  return promise;
}
// Null is authoritative discovery only when a fresh observation agrees. A
// token-matching, still-unbound creation retains its reserved capacity across
// transient SPA routes, without becoming dispatchable on those routes.
async function handleNullPage(tabId, page) {
  const epoch = registrationEpochs.get(tabId) ?? 0;
  const fresh = await sendTabMessage(tabId, { type: "get-session-id" }, 3000, "null identity validation");
  if (page.documentId && fresh?.documentId !== page.documentId) return;
  if (fresh?.session !== null) return;
  const known = (await getStorage("creation_tabs", {}))[tabId];
  const lifecycle = (await getStorage("page_lifecycle", {}))[tabId];
  const managed = fresh?.managed;
  if ((registrationEpochs.get(tabId) ?? 0) !== epoch) return;
  if (known && !known.boundConversation && !lifecycle?.conversationId && managed &&
      managed.sessionRef === known.sessionRef && managed.token === known.token &&
      managed.owner === known.owner && lifecycle?.session === known.sessionRef) return;
  const forgetting = forgetTabSession(tabId);
  const forgettingEpoch = registrationEpochs.get(tabId);
  await forgetting;
  await getPageManager().forget(tabId, () => registrationEpochs.get(tabId) === forgettingEpoch);
}
async function registerPageIdentity(tabId, page, assertCurrent = () => {}) {
  if (page.managed) {
    const registered = await registerManagedPage(tabId, page, assertCurrent);
    return { ...page, conversationId: registered.conversationId ?? page.conversationId };
  }
  if (!page.conversationId) return page;
  let identity;
  try {
    identity = await httpJson("GET", `/v1/sessions/${encodeURIComponent(page.conversationId)}/inspect`);
  } catch (e) {
    // New manual chats have no registry row yet. Existing canonical identities
    // must be verified, and a network failure must not fall back to another ID.
    if (e.status === 404 && page.session === page.conversationId) return page;
    throw e;
  }
  if (identity?.conversationId !== page.conversationId || identity.creationStatus !== "created" ||
      typeof identity.session !== "string") throw new Error("session_identity_unavailable");
  if (identity.session === page.session) return page;
  if (page.session !== page.conversationId || identity.session !== identity.sessionRef ||
      !/^sr_[A-Za-z0-9_-]{1,120}$/.test(identity.session)) throw new Error("session_identity_conflict");
  const restored = await sendTabMessage(tabId, {
    type: "configure-session-identity", expectedSession: page.session,
    session: identity.session, conversationId: page.conversationId,
  }, PAGE_STATE_SENDMSG_TIMEOUT_MS, "restore session identity");
  if (restored?.error || restored?.session !== identity.session ||
      restored.conversationId !== page.conversationId || restored.managed) {
    throw new Error(restored?.error ?? "session_identity_changed");
  }
  return restored;
}
let creationPolling = false;
let discoveryPolling = false;
async function processProjectDiscoveries() {
  if (discoveryPolling) return;
  discoveryPolling = true;
  try {
    const owner = await creationOwner();
    const { command } = await httpJson("POST", "/internal/project-discoveries/claim", { owner });
    if (!command) return;
    const sources = [];
    for (const tab of (await listChatGPTTabs()).slice(0, 100)) {
      try {
        const scan = await sendTabMessage(tab.id, { type: "discover-projects" }, 5000, "project scan");
        if (!scan || !Array.isArray(scan.projects) || typeof scan.url !== "string") throw new Error("scanner_unavailable");
        sources.push(scan);
      } catch {
        sources.push({ url: tab.url, projects: [], error: "scanner_unavailable" });
      }
    }
    await httpJson("POST", `/internal/project-discoveries/${command.discoveryId}/complete`, {
      owner, token: command.token, sources,
    });
    dispatchClient?.wake();
  } catch (e) { dlog("project discovery deferred", e.message); }
  finally { discoveryPolling = false; }
}
async function processSessionCreations() {
  if (backendChanging) return;
  if (!await restoreBackendIdentities()) return;
  if (creationPolling) return;
  creationPolling = true;
  let advanced = false;
  try {
    if (dispatchMode !== "v2") void processProjectDiscoveries();
    const owner = await creationOwner();
    const { command } = await httpJson("POST", "/internal/session-creations/claim", { owner });
    if (!command) return;
    const meta = { sessionRef: command.sessionRef, projectId: command.projectId, token: command.token, owner,
      initialTaskId: command.initialTaskId };
    const marker = `#relay-create=${encodeURIComponent(JSON.stringify(meta))}`;
    let tab;
    if (command.state === "claimed") {
      try {
        tab = await getPageManager().withSlot(async () => {
          // Capacity is reserved before the durable open fence.
          await creationAction(meta, "opening");
          const url = meta.projectId ? `https://chatgpt.com/g/${meta.projectId}/project` : "https://chatgpt.com/";
          const created = await chrome.tabs.create({ url: url + marker, active: false });
          await getPageManager().remember(created.id, { session: meta.sessionRef, conversationId: null,
            projectId: meta.projectId, provenance: "relay", lifecyclePolicy: "reclaimable" });
          return created;
        }, await maxManagedTabs());
        capacityWaiting.delete(meta.sessionRef);
      } catch (error) {
        if (error.message === "waiting_for_capacity") { capacityWaiting.add(meta.sessionRef); return; }
        throw error;
      }
    } else {
      const tabs = await listChatGPTTabs();
      tab = tabs.find(t => (t.url ?? "").endsWith(marker));
      if (!tab) {
        // The page may have stripped its marker; ask existing content scripts.
        for (const candidate of tabs) {
          try {
            const page = await sendTabMessage(candidate.id, { type: "get-session-id" }, 3000, "creation recovery");
            if (page.managed?.sessionRef === meta.sessionRef && page.managed?.token === meta.token) {
              tab = candidate; break;
            }
          } catch { /* Keep observing other tabs. */ }
        }
      }
      if (!tab) {
        await creationAction(meta, "fail", { error: "session_open_outcome_unknown", unknown: true });
        advanced = true;
        return;
      }
    }
    await mutateStorageMap("creation_tabs", map => { map[tab.id] = meta; });
    await creationAction(meta, "attach", { tabId: tab.id });
    advanced = true;
    try { await sendTabMessage(tab.id, { type: "configure-session", managed: meta }, 5000, "configure-session"); }
    catch { /* The content script also requests its configuration on load. */ }
    void handleTab(tab.id);
  } catch (e) {
    console.warn("[relay sw] session creation observation failed", e.message);
  } finally {
    creationPolling = false;
    if (advanced) dispatchClient?.wake();
    if (dispatchMode !== "v2") setTimeout(() => void processSessionCreations(), 5000);
  }
}

async function rememberTabSession(tabId, session, expectedEpoch) {
  return mutateStorageMap("tab_session_map", saved => {
  if (expectedEpoch !== undefined && registrationEpochs.get(tabId) !== expectedEpoch) throw new Error("registration_superseded");
  const previous = tabSessionCache.get(tabId) ?? saved[tabId];
  if (previous && previous !== session && dispatchLoops.get(previous)?.tabId === tabId) {
    stopDispatchLoop(previous);
  }
  tabSessionCache.set(tabId, session);
  verifiedTabSessions.add(tabId);
  saved[tabId] = session;
  });
}
async function loadTabSessionCache() {
  const saved = (await getStorage("tab_session_map", {}));
  for (const [k, v] of Object.entries(saved)) {
    if (!tabSessionCache.has(Number(k))) tabSessionCache.set(Number(k), v);
  }
}
async function forgetTabSession(tabId) {
  registrationEpochs.set(tabId, (registrationEpochs.get(tabId) ?? 0) + 1);
  registrationPending.delete(tabId);
  const forgettingEpoch = registrationEpochs.get(tabId);
  registrationCache.delete(tabId);
  dispatchPages.delete(tabId);
  dispatchClient?.wake();
  return mutateStorageMap("tab_session_map", saved => {
  if (registrationEpochs.get(tabId) !== forgettingEpoch) return;
  const session = tabSessionCache.get(tabId) ?? saved[tabId];
  tabSessionCache.delete(tabId);
  verifiedTabSessions.delete(tabId);
  delete saved[tabId];
  if (session && dispatchLoops.get(session)?.tabId === tabId) stopDispatchLoop(session);
  });
}

// ── inflight tracking ──
function mergeTaskEvidence(previous, incoming) {
  const merged = { ...previous, ...incoming };
  // An acknowledgement and a sampler can both hold snapshots of the same
  // task. Once learned, these facts must survive an older snapshot's write.
  for (const key of ["baseline", "submittedAt", "sendAttemptedAt", "submittedUserMessageId", "stopRequestedAt",
    "submissionVerificationDeadlineAt"]) {
    if (previous[key] != null) merged[key] = previous[key];
  }
  for (const key of ["wasGenerating", "submissionAcknowledged", "submitAcknowledgedProgressReported",
    "generatingProgressReported", "replyProgressReported", "composerPayloadObservedAfterFailure"]) {
    if (previous[key] === true) merged[key] = true;
  }
  if (previous.deliveryPhase === "accepted" || merged.deliveryPhase === "accepted" ||
      merged.submissionAcknowledged || merged.wasGenerating) {
    merged.deliveryPhase = "accepted";
    merged.ackState = "accepted";
  }
  return merged;
}
async function markInflight(session, taskId, details = {}, epochs = null) {
  return mutateStorageMap(STORAGE_KEYS.INFLIGHT, async inflight => {
  if (details.claimToken && (await getStorage("dispatch_task_tokens", {}))[taskId]?.claimToken !== details.claimToken) return false;
  if (epochs && (epochs.get(session) ?? 0) !== (taskEpochs.get(session) ?? 0)) return false;
  const acquiring = details.deliveryPhase === "preparing";
  if (!acquiring && (retiredTasks.has(taskId) || (inflight[session] && inflight[session].taskId !== taskId))) return false;
  if (acquiring) retiredTasks.delete(taskId);
  bumpTaskEpoch(session);
  const existing = inflight[session]?.taskId === taskId ? inflight[session] : {};
  if (existing.submittedUserMessageId && details.submittedUserMessageId &&
      existing.submittedUserMessageId !== details.submittedUserMessageId) return false;
  inflight[session] = mergeTaskEvidence(existing, {
    taskId,
    submittedAt: existing.submittedAt ?? Date.now(),
    ...details,
  });
  return true;
  });
}
async function clearInflight(session, expectedTaskId) {
  return mutateStorageMap(STORAGE_KEYS.INFLIGHT, inflight => {
    if (!expectedTaskId) return false;
    retiredTasks.add(expectedTaskId);
    if (inflight[session] && inflight[session].taskId !== expectedTaskId) return false;
    bumpTaskEpoch(session);
    if (!inflight[session]) return false;
    delete inflight[session];
    return true;
  });
}
async function getInflight(session) {
  const inflight = (await getStorage(STORAGE_KEYS.INFLIGHT, {}));
  return inflight[session] ?? null;
}

// Offline marker.
const offlineSessions = new Set();

// Tell the content script to clear sessionStorage in-flight state and reset its
// banner after completion, definitive failure, or late-reply-window expiry.
async function notifyTabCleared(tabId, session, taskId, claimToken) {
  if (!tabId || !session || !taskId) return;
  // The clear-inflight handler also resets the banner to "Relay: <session>...".
  try {
    await sendTabMessage(
      tabId,
      { type: "clear-inflight", expectedSession: session, taskId, claimToken },
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
    (typeof state.session !== "string" && state.session !== null) ||
    typeof state.generating !== "boolean" ||
    typeof state.ready !== "boolean"
  ) {
    throw new Error(state?.error ?? "get-page-state invalid response");
  }
  if (dispatchMode === "v2" && state.session && state.dispatchProtocol !== 2) {
    state.ready = false;
    state.reason = "reload_extension_and_page";
  }
  if (state.session && state.documentId && tabSessionCache.get(tabId) === state.session) {
    const previous = dispatchPages.get(tabId);
    dispatchPages.set(tabId, { session: state.session, tabId, documentId: state.documentId });
    if (previous?.session !== state.session || previous?.documentId !== state.documentId) dispatchClient?.wake();
  }
  return state;
}

async function initialCreationForDispatch(state, session, tabId, taskId = null) {
  const managed = state.initialCreation;
  if (state.session !== session || !state.observationReady || state.generating ||
      typeof state.documentId !== 'string' || !managed || managed.sessionRef !== session ||
      managed.owner !== await creationOwner() || (taskId && managed.initialTaskId !== taskId)) return null;
  const creation = await creationAction(managed, 'inspect');
  if (creation.tabId !== tabId || creation.projectId !== managed.projectId ||
      creation.creationStatus !== 'pending' || creation.conversationId != null ||
      creation.initialTaskId !== managed.initialTaskId ||
      creation.initialTaskStatus !== (taskId ? 'in_progress' : 'queued')) return null;
  return managed;
}

// Independent of task dispatch: a busy conversation must remain diagnosable.
let snapshotsRunning = false;
async function reportSessionSnapshots() {
  if (backendChanging) return;
  if (snapshotsRunning) return;
  snapshotsRunning = true;
  try {
    const owner = await creationOwner();
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    const generation = await inventoryGeneration();
    const reports = await Promise.all(tabs.map(async tab => {
      if (tab.id == null) return;
      const state = await getPageState(tab.id).catch(() => null);
      // Diagnostics never wait for HTTP identity registration. Discovery is not
      // a session; an unknown identity is registered independently by handleTab.
      const session = state?.session ?? tabSessionCache.get(tab.id);
      if (!session || state?.session === null) return;
      if (state && state.session !== session) return;
      return {
        owner, generation, tabId: tab.id, session, protocol: state?.controlProtocol ?? null,
        dispatchProtocol: state?.dispatchProtocol ?? null,
        observedAt: Date.now(), revision: ++snapshotRevision, documentId: state?.documentId ?? null,
        probe: { ok: !!state, ...(!state ? { code: "page_probe_failed" } : {}) },
        conversationId: state ? tabRoute(tab)?.conversationId : null, projectId: state ? tabRoute(tab)?.projectId : null,
        version: chrome.runtime.getManifest?.().version ?? null,
        ready: state?.ready ?? null, generating: state?.generating ?? null,
        composerClean: state?.composerClean ?? null, reason: state ? state.reason ?? null : "page_unreachable",
        block: state?.block ?? null,
        capabilities: state?.capabilities,
      };
    }));
    const valid = reports.filter(Boolean);
    if (dispatchMode === "v2") {
      if (valid.length) await httpJson("POST", "/internal/session-snapshots/batch", { owner, generation, reports: valid }, 5000);
    } else await Promise.allSettled(valid.map(report => httpJson("POST", "/internal/session-snapshots", report, 5000)));
  } catch (err) { dlog("session snapshots", err); }
  finally { snapshotsRunning = false; }
}
async function pollSessionSnapshots() {
  await reportSessionSnapshots();
  setTimeout(() => void pollSessionSnapshots(), 10000);
}
void pollSessionSnapshots();
void pollBrowserInventory();

function controlRouteMatches(tab, target) {
  const route = tabRoute(tab);
  return route?.conversationId === target.conversationId &&
    (target.projectId == null || route.projectId === target.projectId);
}
async function verifyOpenPage(command, tabId, created) {
  const deadline = Math.min(command.expiresAt, Date.now() + 30000);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !controlRouteMatches(tab, command.target)) throw new Error("session_identity_changed");
    const session = await getTabSession(tabId, { forceFresh: true });
    if (session === command.session) {
      const state = await getPageState(tabId).catch(() => null);
      if (state?.session === session && state.documentId) {
        await reportBrowserInventory();
        return { action: created ? "page_opened" : "page_reused", tabId,
          documentId: state.documentId, relayReady: state.ready === true };
      }
    }
    await delay(500);
  }
  throw new Error("open_outcome_unknown");
}
async function executeOpenControl(command) {
  const generation = await inventoryGeneration();
  const tabs = await listChatGPTTabs();
  const marker = `#relay-open=${encodeURIComponent(command.operationId)}`;
  if (command.state === "executing") {
    // An execution fence never permits a second create, even if the first call
    // or its tab checkpoint was interrupted. A marked tab can prove the action.
    const recorded = command.tabId != null ? tabs.find(tab => tab.id === command.tabId && generation === command.target.generation) : null;
    const marked = tabs.filter(tab => tab.url?.endsWith(marker) && controlRouteMatches(tab, command.target));
    const tab = recorded ?? (marked.length === 1 ? marked[0] : null);
    if (!tab) throw new Error("open_outcome_unknown");
    return verifyOpenPage(command, tab.id, true);
  }
  if (generation !== command.target.generation) throw new Error("instance_generation_changed");
  const matches = tabs.filter(tab => controlRouteMatches(tab, command.target));
  if (matches.length > 1) throw new Error("page_ambiguous");
  if (matches.length === 1) return verifyOpenPage(command, matches[0].id, false);
  const tab = await getPageManager().withSlot(async () => {
    const currentMatches = (await listChatGPTTabs()).filter(candidate => controlRouteMatches(candidate, command.target));
    if (currentMatches.length > 1) throw new Error("page_ambiguous");
    if (currentMatches.length === 1) return { ...currentMatches[0], reused: true };
    await reportBrowserInventory();
    command.executionFenced = true;
    const fence = await httpJson("POST", `/internal/session-controls/${encodeURIComponent(command.operationId)}/fence`,
      { owner: command.owner, token: command.token, generation });
    if (!fence.execute) throw new Error("open_outcome_unknown");
    if (Date.now() >= command.expiresAt) throw new Error("open_outcome_unknown");
    const project = command.target.projectId ? `/g/${encodeURIComponent(command.target.projectId)}` : "";
    const created = await chrome.tabs.create({ url: `https://chatgpt.com${project}/c/${command.target.conversationId}${marker}`, active: false });
    const parked = (await getStorage("parked_sessions", {}))[command.session];
    await getPageManager().remember(created.id, { session: command.session, conversationId: command.target.conversationId,
      projectId: command.target.projectId, provenance: parked?.provenance ?? "relay",
      managementGranted: parked?.managementGranted ?? false, lifecyclePolicy: parked?.lifecyclePolicy ?? "protected" });
    return created;
  }, await maxManagedTabs());
  capacityWaiting.delete(command.session);
  if (tab.reused) {
    await mutateStorageMap("parked_sessions", map => { delete map[command.session]; });
    return verifyOpenPage(command, tab.id, false);
  }
  if (tab.id == null) throw new Error("open_outcome_unknown");
  command.tabId = tab.id;
  await httpJson("POST", `/internal/session-controls/${encodeURIComponent(command.operationId)}/record-tab`,
    { owner: command.owner, token: command.token, tabId: tab.id });
  const result = await verifyOpenPage(command, tab.id, true);
  await mutateStorageMap("parked_sessions", map => { delete map[command.session]; });
  dispatchClient?.wake();
  return result;
}
async function executeCloseControl(command) {
  const generation = await inventoryGeneration();
  if (generation !== command.target.generation)
    throw new Error(command.state === "executing" ? "close_outcome_unknown" : "instance_generation_changed");
  let tab = await chrome.tabs.get(command.tabId).catch(() => null);
  if (command.state === "executing") {
    if (!tab) { await reportBrowserInventory(); return { action: "page_closed", suspended: true, tabId: command.tabId }; }
    // Do not repeat removal after an uncertain fence.
    throw new Error("close_outcome_unknown");
  }
  if (!tab || !controlRouteMatches(tab, command.target)) throw new Error("session_identity_changed");
  const matches = (await listChatGPTTabs()).filter(candidate => controlRouteMatches(candidate, command.target));
  if (matches.length !== 1) throw new Error("page_ambiguous");
  if (await getTabSession(command.tabId, { forceFresh: true }) !== command.session) throw new Error("session_identity_changed");
  const state = await getPageState(command.tabId);
  if (state.session !== command.session || !state.documentId) throw new Error("page_identity_unavailable");
  if (state.composerClean !== true) throw new Error("composer_not_clean");
  if (!state.ready || state.generating) throw new Error("page_not_idle");
  if (command.target.automatic && (tab.pinned || tab.active ||
      (command.expectedActivityRevision != null && command.expectedActivityRevision !== state.activityRevision))) throw new Error("page_in_use");
  await reportBrowserInventory();
  command.executionFenced = true;
  const fence = await httpJson("POST", `/internal/session-controls/${encodeURIComponent(command.operationId)}/fence`,
    { owner: command.owner, token: command.token, generation, documentId: state.documentId });
  if (!fence.execute) throw new Error("close_outcome_unknown");
  tab = await chrome.tabs.get(command.tabId).catch(() => null);
  if (!tab || !controlRouteMatches(tab, command.target)) throw Object.assign(new Error("session_identity_changed"), { definitelyBlocked: true });
  const check = await sendTabMessage(command.tabId, { type: "check-close", expectedSession: command.session,
    documentId: state.documentId, ...(command.target.automatic ? { automatic: true, expectedActivityRevision: state.activityRevision } : {}) }, PAGE_STATE_SENDMSG_TIMEOUT_MS, "check-close");
  if (check?.error || check?.closeAllowed !== true) throw Object.assign(new Error(check?.error ?? "page_identity_unavailable"), { definitelyBlocked: true });
  if (Date.now() >= command.expiresAt) throw new Error("close_outcome_unknown");
  if (command.target.automatic) {
    const latest = await chrome.tabs.get(command.tabId);
    const policy = (await getStorage("page_lifecycle", {}))[command.tabId];
    if (latest.active || latest.pinned || policy?.lifecyclePolicy !== "reclaimable") throw Object.assign(new Error("page_in_use"), { definitelyBlocked: true });
  }
  await chrome.tabs.remove(command.tabId);
  if (await chrome.tabs.get(command.tabId).catch(() => null)) throw new Error("close_outcome_unknown");
  await reportBrowserInventory();
  return { action: "page_closed", suspended: command.target.automatic ? fence.suspended : true, tabId: command.tabId };
}

// Runs in the page's MAIN world. Credentials stay inside this function; only
// bounded model identifiers and diagnostic codes for the exact turn leave the page.
async function readEffortEvidence(conversationId, userId, assistantId) {
  const unknown = (reason, extra = {}) => ({ model: null, thinkingEffort: null, reason, ...extra });
  const samePage = () => location.origin === "https://chatgpt.com" &&
    location.pathname.match(/\/c\/([^/]+)/)?.[1] === conversationId;
  if (!samePage()) return unknown("identity_changed");
  if (!userId || !assistantId) return unknown("missing_turn_ids");
  let last;
  // Only GET requests are retried; this never touches the composer or Send.
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!samePage()) return unknown("identity_changed", { attempts: attempt });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const path = "/backend-api/conversations/" + encodeURIComponent(conversationId);
      let response = await fetch(path, { credentials: "include", signal: controller.signal });
      if (response.status === 401) {
        const auth = await fetch("/api/auth/session", { credentials: "include", signal: controller.signal });
        if (!auth.ok) return unknown("auth_unavailable", { attempts: attempt, httpStatus: auth.status });
        const session = await auth.json();
        if (typeof session.accessToken !== "string") return unknown("auth_unavailable", { attempts: attempt });
        response = await fetch(path, { credentials: "include", signal: controller.signal,
          headers: { Authorization: "Bearer " + session.accessToken } });
      }
      if (!samePage()) return unknown("identity_changed", { attempts: attempt });
      if (!response.ok) {
        last = unknown("http_error", { httpStatus: response.status });
        if (response.status !== 429 && response.status < 500) return { ...last, attempts: attempt };
      } else {
        const data = await response.json();
        if (!samePage()) return unknown("identity_changed", { attempts: attempt });
        if (!Array.isArray(data.messages)) return unknown("unsupported_history", { attempts: attempt });
        const userIndex = data.messages.findIndex(m => m.id === userId && m.author?.role === "user");
        const answerIndex = data.messages.findIndex(m => m.id === assistantId && m.author?.role === "assistant");
        if (userIndex < 0 || answerIndex <= userIndex ||
            data.messages.slice(userIndex + 1, answerIndex).some(m => m.author?.role === "user")) last = unknown("turn_not_found");
        else {
          const answer = data.messages[answerIndex];
          if (answer.status !== "finished_successfully") last = unknown("reply_not_finished");
          else {
            const meta = answer.metadata ?? {};
            const model = typeof meta.model_slug === "string" && meta.model_slug.length < 100 ? meta.model_slug : null;
            const thinkingEffort = typeof meta.thinking_effort === "string" && meta.thinking_effort.length < 50 ? meta.thinking_effort : null;
            last = { model, thinkingEffort, reason: "metadata_missing" };
            if (model && (!model.endsWith("-thinking") || thinkingEffort)) return { model, thinkingEffort, attempts: attempt };
          }
        }
      }
    } catch {
      last = unknown(controller.signal.aborted ? "timeout" : "network_error");
    } finally { clearTimeout(timer); }
    last.attempts = attempt;
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }
  return last;
}

async function verifyReplyEffort(tabId, session, snap) {
  const ids = { submittedUserMessageId: snap.submittedUserMessageId, assistantMessageId: snap.assistantMessageId };
  const unknown = reason => ({ ...ids, model: null, thinkingEffort: null, reason });
  try {
    if (await getTabSession(tabId, { forceFresh: true }) !== session) return unknown("identity_changed");
    const tab = await chrome.tabs.get(tabId), url = new URL(tab.url);
    if (url.origin !== "https://chatgpt.com") return unknown("identity_changed");
    const conversationId = url.pathname.match(/\/c\/([^/]+)/)?.[1];
    if (!conversationId) return unknown("identity_changed");
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: readEffortEvidence,
      args: [conversationId, ids.submittedUserMessageId, ids.assistantMessageId],
    });
    if (await getTabSession(tabId, { forceFresh: true }) !== session) return unknown("identity_changed");
    return { ...ids, ...(results?.[0]?.result ?? unknown("script_failed")) };
  } catch { return unknown("script_failed"); }
}

async function executeEffortControl(command) {
  const { tabId, session } = command;
  if (command.state === "executing") throw new Error("effort_outcome_unknown");
  if (await getTabSession(tabId, { forceFresh: true }) !== session) throw new Error("session_identity_changed");
  const state = await getPageState(tabId);
  if (!state.ready || state.generating || state.composerClean !== true) throw new Error("page_not_idle");
  command.executionFenced = true;
  const fence = await httpJson("POST", `/internal/session-controls/${encodeURIComponent(command.operationId)}/fence`,
    { owner: command.owner, token: command.token, documentId: state.documentId });
  if (!fence.execute) throw new Error("effort_outcome_unknown");
  const result = await sendTabMessage(tabId, { type: "set-effort", expectedSession: session,
    documentId: state.documentId, effortPolicy: command.target.effortPolicy }, 20000, "set-effort");
  if (result?.error) throw Object.assign(new Error(result.error), { definitelyBlocked: true });
  return result;
}

async function executeSessionControl(command) {
  if (command.kind === "reverify-effort") {
    const task = await httpJson("GET", `/v1/tasks/${encodeURIComponent(command.taskId)}`);
    if (task.session !== command.session) throw new Error("session_identity_changed");
    return verifyReplyEffort(command.tabId, command.session, command.target);
  }
  if (command.kind === "set-effort") return executeEffortControl(command);
  if (command.kind === "open") return executeOpenControl(command);
  if (command.kind === "close") return executeCloseControl(command);
  if (command.kind === "refresh") return executeRefreshControl(command);
  if (command.kind === "stop") return executeStopControl(command);
  if (command.kind !== "recover") throw new Error("unsupported_control");
  const { tabId, session, taskId } = command;
  const epochs = await captureTaskEpochs();
  if (await getTabSession(tabId, { forceFresh: true }) !== session) throw new Error("session_identity_changed");
  const task = await httpJson("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
  if (task.session !== session || task.sendAttemptedAt == null || !["in_progress", "recovering"].includes(task.status))
    throw new Error("task_not_recoverable");
  const pending = await getPendingReply(taskId);
  const inflight = await getInflight(session);
  const record = pending ?? (inflight?.taskId === taskId ? inflight : null);
  if (!record?.baseline || record.tabId !== tabId || record.stopRequestedAt) throw new Error("recovery_evidence_unavailable");
  // Observe the original send only. Never call run-task or a requeue endpoint.
  if (!await attachPendingFromTask(task, session, tabId, record, epochs)) throw new Error("recovery_superseded");
  void pollPendingReplies();
  return { action: "observation_attached", taskId };
}

async function executeStopControl(command) {
  const { tabId, session, taskId } = command;
  let requested = null;
  let submittedUserMessageId = command.result?.submittedUserMessageId ?? null;
  refreshingTabs.add(tabId);
  try {
    if (pendingPolls.has(taskId)) await pendingPolls.get(taskId);
    if (await getTabSession(tabId, { forceFresh: true }) !== session) throw new Error("session_identity_changed");
    const rec = await getPendingReply(taskId);
    if (rec && (rec.tabId !== tabId || rec.session !== session || !rec.submittedUserMessageId ||
        (submittedUserMessageId && rec.submittedUserMessageId !== submittedUserMessageId))) throw new Error("stop_identity_mismatch");
    submittedUserMessageId ??= rec?.submittedUserMessageId ?? null;
    if (command.state !== "executing") {
      if (!rec) throw new Error("stop_identity_mismatch");
      const page = await getPageState(tabId);
      command.executionFenced = true; // The server may persist the fence even if its response is lost.
      const fence = await httpJson("POST", `/internal/session-controls/${encodeURIComponent(command.operationId)}/fence`,
        { owner: command.owner, token: command.token, documentId: page.documentId, submittedUserMessageId });
      if (fence.execute) {
        const response = await sendTabMessage(tabId, { type: "stop-generation", taskId,
          expectedSession: session, submittedUserMessageId: rec.submittedUserMessageId }, PAGE_STATE_SENDMSG_TIMEOUT_MS, "stop-generation");
        if (response?.error) throw Object.assign(new Error(response.error), { definitelyBlocked: true });
        requested = response?.clicked ?? null;
        if (response?.stopRequestedAt) {
          stopRequests.set(taskId, { tabId, session, userId: rec.submittedUserMessageId, at: response.stopRequestedAt });
          rec.stopRequestedAt ??= response.stopRequestedAt;
          await setPendingReply(taskId, rec);
        }
      }
    } else requested = rec?.stopRequestedAt ? true : null;
  } finally { refreshingTabs.delete(tabId); }
  // Click acknowledgement, observed page state, and Relay cancellation are
  // separate facts. A stalled Stop button must not masquerade as cancellation.
  const deadline = Math.min(command.expiresAt, Date.now() + 10_000);
  let page = null, task = null, pageGenerationState = "unknown";
  do {
    page = await getPageState(tabId).catch(() => null);
    const rec = await getPendingReply(taskId);
    if (rec) await pollOnePending(taskId, rec);
    task = await httpJson("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
    if (task?.taskId !== taskId || task.session !== session) throw new Error("stop_task_identity_mismatch");
    // Pending state may already have been removed before /finish was persisted.
    // Recover only facts the server retained; cancellation by another mechanism
    // and natural completion do not prove a Stop request.
    if (requested == null && task.status === "cancelled" && task.error === "user stopped before reply") requested = true;
    pageGenerationState = page?.session === session && submittedUserMessageId &&
      page.baseline?.lastUserId === submittedUserMessageId
      ? page.generating === true ? "generating" : page.generating === false &&
        (page.observationReady ?? page.ready) === true ? "stopped" : "unknown"
      : "unknown";
    if (pageGenerationState === "stopped" && ["cancelled", "done", "failed", "expired"].includes(task.status)) break;
    if (Date.now() >= deadline) break;
    await delay(400);
  } while (Date.now() < deadline);
  return { stopRequested: requested, pageGenerationState, relayTaskStatus: task?.status ?? "unknown" };
}

const refreshingTabs = new Set();
async function executeRefreshControl(command) {
  const { tabId, session, taskId } = command;
  refreshingTabs.add(tabId);
  try {
    // Finish an already running sample before fencing the reload.
    if (taskId && pendingPolls.has(taskId)) await pendingPolls.get(taskId);
    let beforeDocumentId = command.result?.beforeDocumentId;
    if (command.state !== "executing") {
      if (await getTabSession(tabId, { forceFresh: true }) !== session) throw new Error("session_identity_changed");
      const state = await getPageState(tabId);
      if (state.session !== session || !state.documentId) throw new Error("page_identity_unavailable");
      if (state.composerClean !== true) throw new Error("composer_not_clean");
      if (!taskId && (!state.ready || state.generating)) throw new Error("page_not_idle");
      if (taskId) {
        const rec = await getPendingReply(taskId);
        if (!rec?.baseline || rec.tabId !== tabId || !rec.submittedUserMessageId || rec.stopRequestedAt)
          throw new Error("recovery_evidence_unavailable");
      }
      command.executionFenced = true;
      const fence = await httpJson("POST", `/internal/session-controls/${encodeURIComponent(command.operationId)}/fence`,
        { owner: command.owner, token: command.token, documentId: state.documentId });
      beforeDocumentId = fence.result?.beforeDocumentId;
      if (fence.execute) {
        const response = await sendTabMessage(tabId, { type: "refresh-page", expectedSession: session,
          taskId, documentId: state.documentId }, PAGE_STATE_SENDMSG_TIMEOUT_MS, "refresh-page").catch(() => null);
        if (response?.error) throw Object.assign(new Error(response.error), { definitelyBlocked: true });
      }
    }
    if (!beforeDocumentId) throw new Error("refresh_outcome_unknown");
    const deadline = Math.min(command.expiresAt, Date.now() + 30_000);
    while (Date.now() < deadline) {
      const state = await getPageState(tabId).catch(() => null);
      if (state?.session === session && state.documentId && state.documentId !== beforeDocumentId &&
          (state.ready || (taskId && state.generating && state.baseline?.userCount > 0))) {
        if (taskId) {
          const task = await httpJson("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
          if (["in_progress", "recovering"].includes(task.status))
            await executeSessionControl({ ...command, kind: "recover" });
          else if (task.status !== "done") throw new Error("refresh_task_not_preserved");
        }
        return { action: "page_refreshed", taskId, documentId: state.documentId };
      }
      await delay(500);
    }
    throw new Error("refresh_outcome_unknown");
  } finally { refreshingTabs.delete(tabId); }
}
let controlPollRunning = false;
function runControlOnce(command) {
  if (executingControls.has(command.operationId)) return executingControls.get(command.operationId);
  const execution = (async () => {
    let outcome;
    try { outcome = { state: "succeeded", result: await executeSessionControl(command) }; }
    catch (e) {
      if (e.message === "waiting_for_capacity" && !command.executionFenced) {
        capacityWaiting.add(command.session);
        return { state: "waiting", error: e.message };
      }
      const uncertain = !e.definitelyBlocked && (command.executionFenced || command.state === "executing");
      outcome = { state: uncertain || /^(refresh|open|close)_outcome_unknown$/.test(e.message) ? "unknown" : "blocked", error: e.message };
    }
    await httpJson("POST", `/internal/session-controls/${encodeURIComponent(command.operationId)}/finish`,
      { owner: command.owner, token: command.token, ...outcome });
    capacityWaiting.delete(command.session);
    return outcome;
  })().finally(() => executingControls.delete(command.operationId));
  executingControls.set(command.operationId, execution);
  return execution;
}
async function processSessionControls() {
  if (backendChanging) return;
  if (!await restoreBackendIdentities()) return;
  if (controlPollRunning) return;
  controlPollRunning = true;
  let advanced = false;
  try {
    const owner = await creationOwner();
    const { command } = await httpJson("POST", "/internal/session-controls/claim", { owner });
    if (!command) return;
    const outcome = await runControlOnce(command);
    advanced = outcome.state !== "waiting";
  } catch (err) { dlog("session controls", err); }
  finally {
    controlPollRunning = false;
    if (advanced) dispatchClient?.wake();
  }
}
async function pollSessionControls() {
  if (dispatchMode === "v2") return;
  await processSessionControls();
  setTimeout(() => void pollSessionControls(), 5000);
}
void pollSessionControls();

async function reportTaskProgress(taskId, phase, claimToken) {
  return httpJson("POST", `/internal/tasks/${taskId}/progress`, { phase, ...(claimToken ? { claimToken } : {}) }).then(() => true).catch((e) => {
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
    await httpJson("POST", `/internal/tasks/${taskId}/observation`, { ...normalized, claimToken: rec.claimToken });
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
  await reportTaskProgress(taskId, "recovery_observed", rec.claimToken);
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
    claimToken: claim.task.claimToken,
    effortPolicy: claim.task.effortPolicy ?? null,
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

async function attachPendingFromTask(task, session, tabId, record, epochs) {
  return mutateTaskStorage(async () => {
  const inflight = await getStorage(STORAGE_KEYS.INFLIGHT, {});
  const pending = await listPendingReplies();
  if (!epochs || (epochs.get(session) ?? 0) !== (taskEpochs.get(session) ?? 0) ||
      retiredTasks.has(task.taskId) || task.session !== session ||
      (inflight[session] && inflight[session].taskId !== task.taskId) ||
      Object.entries(pending).some(([id, rec]) => rec.session === session && id !== task.taskId)) return false;
  const existing = pending[task.taskId];
  const baseline = existing?.baseline ?? record.baseline ?? {
    assistantCount: 0,
    lastAssistantText: "",
    lastAssistantId: null,
    lastUserId: null,
    userCount: 0,
  };
  const deliveryPhase = inferDeliveryPhase(task, {
    ...record,
    ...existing,
  });
  const sendAttemptedAt = existing?.sendAttemptedAt ??
    inflight[session]?.sendAttemptedAt ?? task.sendAttemptedAt ?? record.sendAttemptedAt ??
    (deliveryPhase === "preparing" ? null : Date.now());
  const rec = {
    ...(existing ?? {}),
    session,
    tabId,
    taskId: task.taskId,
    effortPolicy: task.effortPolicy ?? null,
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
      existing?.submittedUserMessageId ?? record.submittedUserMessageId ?? inflight[session]?.submittedUserMessageId ?? null,
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
  };
  observeStopRequest(task.taskId, rec);
  pending[task.taskId] = rec;
  inflight[session] = {
    ...inflight[session],
    taskId: task.taskId,
    submittedAt: inflight[session]?.submittedAt ?? rec.submittedAt,
    sendAttemptedAt,
    tabId,
    baseline,
    deliveryPhase,
    submittedUserMessageId: rec.submittedUserMessageId,
    expiresAt: task.expiresAt,
    completionDeadlineAt: task.completionDeadlineAt,
    recoveryDeadlineAt: task.recoveryDeadlineAt,
    lateReplyDeadlineAt: task.lateReplyDeadlineAt,
  };
  // Publish ownership and its observer together, before waking any sampler.
  await chrome.storage.local.set({ [STORAGE_KEYS.INFLIGHT]: inflight, [STORAGE_KEYS.PENDING_REPLIES]: pending });
  bumpTaskEpoch(session);
  activatePendingReply(task.taskId);
  return true;
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
  if (backendChanging) return;
  await ensureDispatch();
  if (dispatchMode === "v2" && acknowledgedPages.get(session)?.tabId !== tabId) {
    await getPageState(tabId).catch(() => null);
    return;
  }
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

      let resumedClaim = null;
      const intent = dispatchMode === "v2" ? (await getStorage("dispatch_claim_intents", {}))[session] : null;
      if (dispatchMode === "v2") {
        const current = await getPageState(tabId).catch(() => null);
        if (!current || current.session !== session) break;
        if (current.dispatchProtocol !== 2) break;
        if (intent) {
          try {
            resumedClaim = await claimForPage(session, tabId, current, controller.signal);
            if (!resumedClaim.task) break;
            const prior = await getInflight(session);
            if (resumedClaim.task.status !== "in_progress" || resumedClaim.task.sendAttemptedAt != null || (prior && hasSendFence(prior))) {
              const task = await httpJson("GET", `/v1/tasks/${resumedClaim.task.taskId}`);
              if (["in_progress", "recovering"].includes(task.status) || isRecoverableLateReply(task)) {
                await attachPendingFromTask(task, session, tabId, prior ?? {});
                resumedClaim = null;
                continue;
              }
              await clearRecoveredTask(task.taskId, session, tabId);
              continue;
            }
          } catch (error) {
            if (controller.signal.aborted) break;
            dlog("claim recovery waiting", session, error.message);
            await delay(DISPATCH_LOOP_RETRY_MS);
            continue;
          }
        } else {
          const work = dispatchWork.get(session);
          const local = await getInflight(session);
          if (!local && (!work || (!work.queuedTasks && !work.activeTaskId && !work.paused) || work.suspended)) break;
        }
      }
      const durableInflight = resumedClaim?.task ? null : await getInflight(session);
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
          if (recovered.action === "superseded") continue;
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
          paused: true, reason: `${safety.code ?? safety.reason}: ${safety.text}`,
        }).catch(() => {});
        console.log("[relay sw] dispatch loop exit: safety", session.slice(0, 8), safety.reason);
        break;
      }
      await httpJson("POST", `/internal/sessions/${encodeURIComponent(session)}/status`, {
        paused: false,
      }).catch(() => {});

      // Do not claim while the page hydrates or finishes prior generation,
      // including a late reply, because React may overwrite a new prompt.
      let creationPreparation = null;
      try {
        const state = await getPageState(tabId);
        creationPreparation = await initialCreationForDispatch(state, session, tabId);
        if (state.session !== session || state.generating ||
            ((!state.ready || state.composerClean === false) && !creationPreparation)) {
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
        claim = resumedClaim ?? await claimForPage(session, tabId, await getPageState(tabId), controller.signal);
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
        if (dispatchMode === "v2") break;
        await delay(4000);
        continue;
      }

      const { taskId, text } = claim.task;
      if (dispatchMode === "v2" && (claim.task.status !== "in_progress" || claim.task.sendAttemptedAt != null)) continue;
      await getPageManager().noteActivity(session);
      const dispatchAt = Date.now();
      console.log(
        "[relay sw] dispatch task", taskId.slice(0, 8),
        "session", session.slice(0, 8),
        "dispatchAt", dispatchAt,
        "waitMs", dispatchAt - loopStart,
      );
      const postTask = (action, body) => httpJson("POST", `/internal/tasks/${taskId}/${action}`, { ...body, claimToken: claim.task.claimToken });
      activeDispatchTasks.add(taskId);
      try {
        const acquired = await markInflight(session, taskId, {
          tabId,
          deliveryPhase: "preparing", claimToken: claim.task.claimToken,
        });
        if (acquired === false) throw Object.assign(new Error("dispatch_claim_superseded"), { code: "dispatch_loop_interrupted" });
        let pageState;
        try {
          pageState = await getPageState(tabId);
        } catch (e) {
          await postTask("defer", {});
          await clearRecoveredTask(taskId, session, tabId, claim.task.claimToken);
          await delay(DISPATCH_LOOP_RETRY_MS);
          continue;
        }
        const initialize = creationPreparation?.initialTaskId === taskId
          ? await initialCreationForDispatch(pageState, session, tabId, taskId) : null;
        if (pageState.session !== session || pageState.generating ||
            ((!pageState.ready || pageState.composerClean === false) && !initialize)) {
          await postTask("defer", {});
          await clearRecoveredTask(taskId, session, tabId, claim.task.claimToken);
          await delay(DISPATCH_LOOP_RETRY_MS);
          continue;
        }
        if (initialize) {
          const task = await httpJson('GET', `/v1/tasks/${taskId}`);
          if (task.status !== 'in_progress' || task.sendAttemptedAt !== null) {
            throw new Error('new_session_initialization_blocked');
          }
        }
        await markInflight(session, taskId, {
          tabId,
          baseline: pageState?.baseline,
          deliveryPhase: "preparing", claimToken: claim.task.claimToken,
          expiresAt: claim.task.expiresAt,
          completionDeadlineAt: claim.task.completionDeadlineAt,
          recoveryDeadlineAt: claim.task.recoveryDeadlineAt,
          lateReplyDeadlineAt: claim.task.lateReplyDeadlineAt,
        });
        const started = await reportTaskProgress(taskId, "submit_started", claim.task.claimToken);
        if (claim.task.claimToken && !started) throw Object.assign(new Error("dispatch_start_unconfirmed"), { code: "dispatch_loop_interrupted" });

        let runRes;
        try {
          runRes = await sendTabMessage(
            tabId,
            { type: "run-task", taskId, text, effortPolicy: claim.task.effortPolicy, baseline: pageState?.baseline, expectedSession: session,
              expectedDocumentId: pageState.documentId, claimToken: claim.task.claimToken,
              ...(initialize ? { initializeComposer: { token: initialize.token, documentId: pageState.documentId } } : {}) },
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

        if (runRes?.managed) {
          try { await registerManagedPage(tabId, runRes); }
          catch (e) { console.warn("[relay sw] submission binding deferred", e.message); }
        }
        if (runRes?.error) {
          if (runRes.errorCode === "page_busy" && runRes.submissionState === "not-submitted") {
            await delay(DISPATCH_LOOP_RETRY_MS);
            continue;
          }
          if (
            runRes.errorCode === "attachment_upload_timeout" ||
            runRes.errorCode === "attachment_upload_failed" ||
            runRes.errorCode === "attachment_cleanup_incomplete"
          ) {
            const errorCode = runRes.errorCode;
            if (runRes.attachmentCleanupConfirmed !== true) {
              await setAttachmentBlock(session, `${errorCode}: ${runRes.error}`);
            }
            await postTask("complete", {
              error: errorCode,
            }).catch(() => {});
            await clearRecoveredTask(taskId, session, tabId, claim.task.claimToken);
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
          if (runRes.submissionState === "not-submitted" &&
              (runRes.errorCode === "composer_not_clean" || /waitForPageReady/.test(runRes.error))) {
            await postTask("defer", {});
            await clearRecoveredTask(taskId, session, tabId, claim.task.claimToken);
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
          throw new Error(runRes.errorCode ?? runRes.error);
        }
        if (runRes?.status !== "submitted") {
          // Compatibility with older content-script versions.
          if (typeof runRes?.reply === "string") {
            await postTask("complete", { text: runRes.reply });
            await clearRecoveredTask(taskId, session, tabId, claim.task.claimToken);
            console.log("[relay sw] task completed inline", taskId.slice(0, 8), "completionAt", Date.now());
            continue;
          }
          throw new Error("run-task did not acknowledge submission");
        }

        const submitAcknowledgedProgressReported =
          await reportTaskProgress(taskId, "submit_acknowledged", claim.task.claimToken);
        await markInflight(session, taskId, {
          deliveryPhase: "accepted", claimToken: claim.task.claimToken,
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
        // Navigation/offline interrupts this observer, not the ChatGPT request.
        // Preserve pending state and the Send fence for the replacement loop.
        if (e.code === "dispatch_loop_interrupted") break;
        console.warn("[relay sw] task failed", taskId.slice(0, 8), e.message);
        const terminal = await postTask("complete", { error: e.message }).catch(() => null);
        if (terminal) await clearRecoveredTask(taskId, session, tabId, claim.task.claimToken);
      } finally {
        activeDispatchTasks.delete(taskId);
      }
    }
  } finally {
    if (dispatchLoops.get(session)?.controller === controller) {
      dispatchLoops.delete(session);
    }
  }
}

function restoreBackendIdentities() {
  if (backendIdentityRestore) return backendIdentityRestore;
  backendIdentityRestore = (async () => {
    const marker = await getStorage("backend_identity_reset_pending", null);
    if (!marker?.pages?.length) return true;
    const previousGate = backendChanging;
    backendChanging = true;
    try {
      // The active maps and config are committed together. They choose the
      // restoration namespace after interruption on either side of that commit.
      const managedTabs = await getStorage("creation_tabs", {});
      const remaining = [];
      for (const page of marker.pages) {
        try {
          const tab = await chrome.tabs.get(page.tabId).catch(() => null);
          if (!tab) continue;
          const state = await getPageState(page.tabId);
          if (state.documentId !== page.documentId) continue; // Original document is gone.
          if ((state.conversationId ?? null) !== page.conversationId || (state.projectId ?? null) !== page.projectId) continue;
          const local = await sendTabMessage(page.tabId, { type: "get-inflight" }, 5000, "backend identity recovery preflight");
          if (state.generating || state.postSend || local?.inflight?.taskId) { remaining.push(page); continue; }
          const reset = await sendTabMessage(page.tabId, { type: "reset-relay-identity", documentId: page.documentId }, 5000, "backend identity recovery reset");
          if (!reset?.reset) { remaining.push(page); continue; }
          const managed = managedTabs[page.tabId];
          if (managed) {
            const fresh = await getPageState(page.tabId);
            if (fresh.documentId !== page.documentId || fresh.generating || fresh.postSend ||
                (await sendTabMessage(page.tabId, {type:"get-inflight"}, 5000, "backend identity restore preflight"))?.inflight?.taskId) { remaining.push(page); continue; }
            const restored = await sendTabMessage(page.tabId, { type: "configure-session", managed }, 5000, "backend identity restore");
            if (restored?.error || restored?.session !== managed.sessionRef) { remaining.push(page); continue; }
          }
        } catch { remaining.push(page); }
      }
      await setStorage("backend_identity_reset_pending", remaining.length ? {pages: remaining} : null);
      return remaining.length === 0;
    } finally { backendChanging = previousGate; }
  })().finally(() => { backendIdentityRestore = null; });
  return backendIdentityRestore;
}

async function restoreDispatchLoops() {
  if (!await restoreBackendIdentities()) return;
  try { await ensureDispatch(); } catch { return; }
  const tabs = await listChatGPTTabs();
  await Promise.allSettled(tabs.map(async tab => {
    if (!tab.id) return;
    const session = await getTabSession(tab.id, { forceFresh: true });
    if (!session) return;
    await getPageState(tab.id).catch(() => null);
    if (offlineSessions.has(session)) return;
    void startDispatchLoop(session, tab.id).catch((e) =>
      console.warn("[relay sw] restore loop failed", session.slice(0, 8), e),
    );
  }));
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
  return new Promise((resolve, reject) => {
    const handler = () => reject(Object.assign(new Error("dispatch loop interrupted"), {
      code: "dispatch_loop_interrupted",
    }));
    signal.addEventListener("abort", handler, { once: true });
    deferred.promise.then(value => {
      signal.removeEventListener("abort", handler);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", handler);
      reject(error);
    });
  });
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
  return mutateTaskStorage(async () => {
    const token = (await getStorage("dispatch_task_tokens", {}))[taskId]?.claimToken;
    if (rec.claimToken && token !== rec.claimToken) return false;
    rec.claimToken ??= token;
    const inflight = await getStorage(STORAGE_KEYS.INFLIGHT, {});
    const owner = inflight[rec.session];
    if (retiredTasks.has(taskId) || (owner && owner.taskId !== taskId)) return false;
    const map = await listPendingReplies();
    const existing = mergeTaskEvidence(owner ?? {}, map[taskId] ?? {});
    if (existing.submittedUserMessageId && rec.submittedUserMessageId &&
        existing.submittedUserMessageId !== rec.submittedUserMessageId) return false;
    Object.assign(rec, mergeTaskEvidence(existing, rec));
    rec.stopRequestedAt ??= null;
    observeStopRequest(taskId, rec);
    map[taskId] = rec;
    // Keep durable recovery evidence in sync when a sampler first learns the
    // original user ID, including generation-before-message acceptance.
    if (owner) inflight[rec.session] = mergeTaskEvidence(owner, {
      submittedUserMessageId: rec.submittedUserMessageId,
      deliveryPhase: rec.deliveryPhase,
      stopRequestedAt: rec.stopRequestedAt,
    });
    await chrome.storage.local.set({ [STORAGE_KEYS.INFLIGHT]: inflight, [STORAGE_KEYS.PENDING_REPLIES]: map });
    activatePendingReply(taskId);
    return true;
  });
}
function activatePendingReply(taskId) {
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
  await mutateStorageMap(STORAGE_KEYS.PENDING_REPLIES, map => { delete map[taskId]; });
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
  if (refreshingTabs.has(rec.tabId)) return;
  if (pendingPolls.has(taskId)) return pendingPolls.get(taskId);
  const running = pollOnePendingSnapshot(taskId, rec);
  pendingPolls.set(taskId, running);
  try { return await running; }
  finally { if (pendingPolls.get(taskId) === running) pendingPolls.delete(taskId); }
}

function observeStopRequest(taskId, rec, snap = {}) {
  const request = stopRequests.get(taskId);
  if (request && request.tabId === rec.tabId && request.session === rec.session &&
      (!rec.submittedUserMessageId || request.userId === rec.submittedUserMessageId)) {
    rec.stopRequestedAt ??= request.at;
  }
  if (snap?.taskId === taskId && snap.stopRequestedAt &&
      (!rec.submittedUserMessageId || snap.submittedUserMessageId === rec.submittedUserMessageId)) {
    rec.stopRequestedAt ??= snap.stopRequestedAt;
  }
  return !!rec.stopRequestedAt;
}

async function pollOnePendingSnapshot(taskId, rec) {
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
  if (rec.session.startsWith("sr_") && await getTabSession(rec.tabId, { forceFresh: true }) !== rec.session) {
    return; // No reply attribution before managed ownership and binding validation.
  }
  let snap;
  try {
    snap = await sendTabMessage(
      rec.tabId,
      {
        type: "poll-reply",
        taskId,
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
  observeStopRequest(taskId, rec, snap);
  if (rec.stopRequestedAt && ['reply-ready', 'posted-no-reply-yet', 'not-started'].includes(snap?.status)) {
    await cancelPending(taskId, rec, 'user stopped before reply');
    return;
  }

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
      paused: true, reason: snap.code === "conversation_blocked" ? snap.code : snap.reason ?? "safety",
    }).catch(() => {});
    // Fail the task so the agent can observe the problem.
    await failPending(taskId, rec, snap.code === "conversation_blocked" ? snap.code : `safety: ${snap.reason ?? "unknown"}`);
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
      await reportTaskProgress(taskId, "submit_acknowledged", rec.claimToken);
  }

  if (snap.status === "reply-ready") {
    const text = snap.reply ?? "";
    const sampleKey = JSON.stringify([snap.submittedUserMessageId, snap.assistantMessageId]);
    if (!snap.submittedUserMessageId || !snap.assistantMessageId ||
        (rec.submittedUserMessageId && rec.submittedUserMessageId !== snap.submittedUserMessageId)) {
      rec.stableSampleCount = 0;
      await setPendingReply(taskId, rec);
      return;
    }
    if (text === rec.lastSampleText && sampleKey === rec.lastSampleKey) {
      rec.stableSampleCount = (rec.stableSampleCount ?? 0) + 1;
    } else {
      rec.stableSampleCount = 1;
      rec.lastSampleText = text;
    }
    rec.lastSampleKey = sampleKey;
    rec.submittedUserMessageId ??= snap.submittedUserMessageId;
    if (rec.stableSampleCount >= POLL_REPLY_STABLE_SAMPLES && text.length > 0) {
      console.log("[relay sw] pending complete", taskId, "len=", text.length);
      if (!rec.replyProgressReported) {
        await reportTaskProgress(taskId, "reply_detected", rec.claimToken);
        rec.replyProgressReported = true;
      }
      try {
        // Stop can arrive while the progress request above is in flight.
        if (observeStopRequest(taskId, rec, snap)) {
          await cancelPending(taskId, rec, 'user stopped before reply');
          return;
        }
        const effortEvidence = rec.effortPolicy ? await verifyReplyEffort(rec.tabId, rec.session, snap) : undefined;
        // Stop/navigation can arrive during metadata verification too.
        if (observeStopRequest(taskId, rec, snap)) {
          await cancelPending(taskId, rec, "user stopped before reply"); return;
        }
        const captured = await httpJson("POST", `/internal/tasks/${taskId}/capture`, { text, effortEvidence, claimToken: rec.claimToken });
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
      await clearRecoveredTask(taskId, rec.session, rec.tabId, rec.claimToken);
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
        await reportTaskProgress(taskId, "generating_seen", rec.claimToken);
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
        await reportTaskProgress(taskId, "submit_acknowledged", rec.claimToken);
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

async function resetComposerBestEffort(tabId, session, taskId) {
  if (!tabId) return false;
  const result = await sendTabMessage(
    tabId,
    { type: "reset-composer", expectedSession: session, taskId },
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
    await httpJson("POST", `/internal/tasks/${taskId}/complete`, { error: reason, claimToken: rec.claimToken });
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
    const clean = await resetComposerBestEffort(rec.tabId, rec.session, taskId);
    if (!clean) {
      console.warn("[relay sw] continuing after incomplete composer reset", taskId);
    }
  }
  if (!terminalConfirmed) {
    await setPendingReply(taskId, rec);
    return false;
  }
  await clearRecoveredTask(taskId, rec.session, rec.tabId, rec.claimToken);
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
  await clearRecoveredTask(taskId, rec.session, rec.tabId, rec.claimToken);
  await setStorage(STORAGE_KEYS.LAST_ERROR, {
    taskId, session: rec.session, error: reason, at: Date.now(),
  });
}

async function cancelPending(taskId, rec, reason) {
  let terminal;
  try {
    terminal = await httpJson("POST", `/internal/tasks/${taskId}/user-stop`, { reason, claimToken: rec.claimToken });
  } catch (e) {
    console.warn("[relay sw] cancelPending POST failed", taskId, e.message);
    terminal = await httpJson('GET', `/v1/tasks/${taskId}`).catch(() => null);
  }
  if (!['done', 'failed', 'cancelled', 'expired'].includes(terminal?.status)) {
    await setPendingReply(taskId, rec);
    return false;
  }
  await clearRecoveredTask(taskId, rec.session, rec.tabId, rec.claimToken);
  if (terminal.status === 'cancelled') {
    await setStorage(STORAGE_KEYS.LAST_ERROR, {
      taskId, session: rec.session, error: reason, at: Date.now(),
    });
  }
  return true;
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
  if (backendChanging) return;
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
  const epochs = await captureTaskEpochs();
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
        // Check after the asynchronous read: an active upload is not an orphan.
        // Deferring it here races the content script's durable send fence.
        if (activeDispatchTasks.has(entry.taskId)) continue;
        const action = classifyRecoveryAction(t, entry);
        let tabId = entry.tabId ?? null;
        if (!tabId) {
          for (const [tid, sid] of tabSessionCache.entries()) {
            if (sid === session) { tabId = tid; break; }
          }
        }
        if (action === "reattach" && tabId) {
          await attachPendingFromTask(t, session, tabId, entry, epochs);
        } else if (action === "defer") {
          if ((await getStorage("dispatch_claim_intents", {}))[session]) continue;
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
            }, epochs);
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
       await clearRecoveredTask(entry.taskId, session, tabId);
      }
    } catch (e) {
      // Ignore relay unavailability and retry during the next cycle.
    }
  }
}

async function clearRecoveredTask(taskId, session, tabId, expectedToken) {
  const cleared = await mutateTaskStorage(async () => {
    const current = (await getStorage("dispatch_task_tokens", {}))[taskId];
    if (expectedToken && current?.claimToken !== expectedToken) return false;
    const [inflight, pending, intents] = await Promise.all([
      getStorage(STORAGE_KEYS.INFLIGHT, {}), listPendingReplies(), getStorage("dispatch_claim_intents", {}),
    ]);
    if (inflight[session]?.taskId === taskId) delete inflight[session];
    if (intents[session]?.taskId === taskId) delete intents[session];
    delete pending[taskId];
    retiredTasks.add(taskId); bumpTaskEpoch(session);
    await chrome.storage.local.set({ [STORAGE_KEYS.INFLIGHT]: inflight,
      [STORAGE_KEYS.PENDING_REPLIES]: pending, dispatch_claim_intents: intents });
    return true;
  });
  if (!cleared) return false;
  await notifyTabCleared(tabId, session, taskId, expectedToken);
  const deferred = pendingCompletion.get(taskId);
  if (deferred) { deferred.resolve(); pendingCompletion.delete(taskId); }
  stopRequests.delete(taskId);
  await getPageManager().noteActivity(session);
  dispatchClient?.wake();
  return true;
}

async function recoverInflightForTab(msg, tabId) {
  const epochs = await captureTaskEpochs();
  const task = await httpJson("GET", `/v1/tasks/${msg.taskId}`);
  const session = task.session;
  let conversationChanged = msg.conversationChanged === true;
  if (session.startsWith("sr_")) {
    // Page-load recovery may run before its initial alias registration finishes.
    // Verify the current page after normalization instead of treating that
    // earlier UUID/ref comparison as proof of navigation to another chat.
    const currentSession = await getTabSession(tabId, { forceFresh: true });
    if (!currentSession) return { action: "wait", status: task.status };
    conversationChanged = currentSession !== session;
  }
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
  if (conversationChanged) {
    action = hasSendFence(record, task) ? "fail-uncertain" : "defer";
  }

  if (action === "clear") {
    await clearRecoveredTask(task.taskId, session, tabId);
    return { action: "clear", status: task.status };
  }

  if (action === "defer") {
    if ((await getStorage("dispatch_claim_intents", {}))[session]) {
      void startDispatchLoop(session, tabId).catch(() => {});
      return { action: "wait", status: task.status };
    }
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
      const attached = await attachPendingFromTask(failed, session, tabId, {
        ...record,
        deliveryPhase: "unknown",
      }, epochs);
      if (!attached) return { action: "superseded" };
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
    if (!await attachPendingFromTask(task, session, tabId, record, epochs)) return { action: "superseded" };
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
    void processSessionControls();
    void reportSessionSnapshots();
    void reportBrowserInventory().catch(error => dlog("browser inventory", error));
    void processSessionCreations();
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

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTabSession(tabId);
  void getPageManager().forget(tabId);
  void processSessionCreations();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  // Managed creation keeps its stable ref across the first conversation navigation.
  const cachedRef = tabSessionCache.get(tabId);
  if (cachedRef?.startsWith("sr_")) {
    void getTabSession(tabId, { forceFresh: true }).then(session => {
      if (!session) return forgetTabSession(tabId);
      return handleTab(tabId);
    });
    return;
  }
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
void (async () => {
  if (!await restoreBackendIdentities()) return;
  await loadTabSessionCache();
  void reconcileInflight();
  void pollPendingReplies();
  void restoreDispatchLoops();
  void processSessionCreations();
})().catch(error => console.warn("[relay sw] startup identity recovery failed", error));

// Message bridge.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

  if (type === "get-managed-session") {
    getStorage("creation_tabs", {}).then(map => sendResponse({ managed: map[sender.tab?.id] ?? null }))
      .catch(() => sendResponse({ managed: null }));
    return true;
  }

 if (type === "session-hello") {
   if (sender.tab?.id && msg.session === null) {
     handleNullPage(sender.tab.id, msg)
       .then(() => sendResponse({ status: "ok" })).catch(error => sendResponse({ error: error.message }));
     return true;
   }
   if (sender.tab?.id && msg.session) {
     (async () => {
       const registered = await registerPageSession(sender.tab.id, msg);
       await rememberTabSession(sender.tab.id, registered.session, registrationResults.get(registered));
        void startDispatchLoop(registered.session, sender.tab.id).catch((e) =>
          console.warn("[relay sw] hello dispatch loop failed", e),
        );
        sendResponse({ status: "ok", conversationId: registered.managed ? registered.conversationId ?? null : null });
      })().catch((e) => sendResponse({ error: e.message }));
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
        const beforeRead = await captureTaskEpochs();
        const dispatchToken = (await getStorage("dispatch_task_tokens", {}))[msg.taskId];
        if (dispatchToken && (dispatchToken.baseUrl !== await getBaseUrl() || dispatchToken.tabId !== sender.tab.id ||
            dispatchToken.documentId !== msg.documentId || dispatchToken.claimToken !== msg.claimToken)) throw new Error("dispatch_page_obsolete");
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
        const marked = await markInflight(sid, msg.taskId, {
          tabId: sender.tab.id,
          baseline: msg.baseline,
          deliveryPhase: "send-attempted",
          claimToken: dispatchToken?.claimToken,
        }, beforeRead);
        if (!marked) throw new Error("send_fence_superseded");
        const epochs = await captureTaskEpochs();
        const permit = await httpJson("POST", `/internal/tasks/${msg.taskId}/progress`, {
          phase: "send_attempted", effortSelection: msg.effortSelection, ...(dispatchToken ? { claimToken: msg.claimToken } : {}),
        });
        if (dispatchToken && permit?.status !== "in_progress") throw new Error("send_fence_superseded");
        const fencedTask = await httpJson("GET", `/v1/tasks/${msg.taskId}`);
        const attached = await attachPendingFromTask(fencedTask, sid, sender.tab.id, {
          baseline: msg.baseline,
          deliveryPhase: "send-attempted",
        }, epochs);
        if (!attached) throw new Error("send_fence_superseded");
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
    if (!sender.tab?.id || !msg.taskId || !msg.expectedSession || !msg.submittedUserMessageId) {
      sendResponse({error:'missing Stop task identity'});
      return false;
    }
    const request = {tabId:sender.tab.id, session:msg.expectedSession,
      userId:msg.submittedUserMessageId, at:Date.now()};
    stopRequests.set(msg.taskId, request);
    (async () => {
      try {
        const rec = await getPendingReply(msg.taskId);
        const owner = rec ?? await getInflight(msg.expectedSession);
        if (!owner || owner.tabId !== sender.tab.id ||
            (owner.taskId && owner.taskId !== msg.taskId) ||
            (rec && rec.session !== msg.expectedSession) ||
            (owner.submittedUserMessageId && owner.submittedUserMessageId !== msg.submittedUserMessageId)) {
          if (stopRequests.get(msg.taskId) === request) stopRequests.delete(msg.taskId);
          sendResponse({error:'Stop task identity mismatch'});
          return;
        }
        if (!rec) {
          await markInflight(msg.expectedSession, msg.taskId, {stopRequestedAt:request.at});
          sendResponse({ status: "stop-requested" });
          return;
        }
        rec.stopRequestedAt ??= request.at;
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
          if (sid) await clearRecoveredTask(msg.taskId, sid, sender.tab.id);
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
      const lifecycle = await getStorage("page_lifecycle", {});
      const tabsInfo = await Promise.all(tabs.map(async (t) => {
        if (!t.id) return null;
        const page = await getPageState(t.id).catch(() => null);
        const sid = page ? page.session : tabSessionCache.get(t.id) ?? null;
        return {
          tabId: t.id, url: t.url, title: t.title, session: sid,
          pageKind: page?.pageKind ?? (tabRoute(t)?.conversationId ? "conversation" : "discovery"),
          lifecyclePolicy: lifecycle[t.id]?.lifecyclePolicy ?? "protected",
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
        dispatch: dispatchState,
        capacity: { ...await getPageManager().capacity(await maxManagedTabs()), waiting: [...capacityWaiting] },
      });
    })();
    return true;
  }

  if (type === "popup-set-capacity" || type === "popup-set-page-policy") {
    (async () => {
      if (type === "popup-set-capacity") {
        if (!Number.isInteger(msg.maxManagedTabs) || msg.maxManagedTabs < 1 || msg.maxManagedTabs > 100) throw new Error("invalid_capacity");
        await setStorage("config", { ...await getStorage("config", {}), maxManagedTabs: msg.maxManagedTabs });
      } else {
        const tab = await chrome.tabs.get(msg.tabId);
        const session = await getTabSession(tab.id, { forceFresh: true });
        if (!session) throw new Error("session_unavailable");
        await getPageManager().setPolicy(tab.id, msg.lifecyclePolicy);
      }
      dispatchClient?.wake();
      void reportBrowserInventory().catch(() => {});
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (type === "popup-set-base-url") {
    (async () => {
      const cfg = await getStorage("config", {});
      const url = new URL(msg.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid_backend_url");
      const nextBase = url.origin;
      const oldBase = await getBaseUrl();
      if (nextBase === oldBase) { sendResponse({ status: "ok" }); return; }
      if (backendChanging || controlPollRunning || creationPolling || executingControls.size) throw new Error("backend_change_blocked_by_active_work");
      backendChanging = true;
      try {
        for (const session of dispatchLoops.keys()) stopDispatchLoop(session);
        await Promise.allSettled([...registrationPending.values()].map(value => value.promise));
        const [inflight, pending, intents] = await Promise.all([getStorage(STORAGE_KEYS.INFLIGHT, {}), listPendingReplies(), getStorage("dispatch_claim_intents", {})]);
        if (Object.keys(inflight).length || Object.keys(pending).length || Object.keys(intents).length || activeDispatchTasks.size) throw new Error("backend_change_blocked_by_active_work");
        const pages = await Promise.all((await listChatGPTTabs()).map(async tab => {
          const state = await getPageState(tab.id);
          const local = await sendTabMessage(tab.id, { type: "get-inflight" }, 5000, "backend change preflight");
          if (!state.documentId || local?.inflight?.taskId || state.generating) throw new Error("backend_change_blocked_by_active_work");
          return { tab, state };
        }));
        dispatchClient?.stop();
        // Isolate idle identity and reclamation records by backend. Task evidence
        // cannot be switched away from; the checks above require it to be empty.
        const keys = ["tab_session_map", "creation_tabs", "page_lifecycle", "parked_sessions", "reopen_operations", "dispatch_task_tokens",
          STORAGE_KEYS.PAUSE, STORAGE_KEYS.LAST_ERROR, STORAGE_KEYS.ATTACHMENT_BLOCKS];
        const namespaces = await getStorage("backend_state", {});
        namespaces[oldBase] = Object.fromEntries(await Promise.all(keys.map(async key => [key, await getStorage(key, {})])));
        const next = namespaces[nextBase] ?? {};
        const restored = Object.fromEntries(keys.map(key => [key, next[key] ?? {}]));
        if (await getStorage("backend_identity_reset_pending", null) && !await restoreBackendIdentities()) throw new Error("backend_identity_recovery_pending");
        await setStorage("backend_identity_reset_pending", {pages: pages.map(({tab,state}) => ({tabId:tab.id,documentId:state.documentId,
          conversationId:state.conversationId ?? null,projectId:state.projectId ?? null}))});
        for (const { tab, state } of pages) {
          const reset = await sendTabMessage(tab.id, { type: "reset-relay-identity", documentId: state.documentId }, 5000, "backend identity reset");
          if (!reset?.reset) throw new Error(reset?.error ?? "backend_identity_reset_failed");
        }
        await chrome.storage.local.set({ ...restored, backend_state: namespaces, config: { ...cfg, baseUrl: nextBase } });
        dispatchClient = null; dispatchMode = null; dispatchSetup = null; pageManager = null;
        dispatchWork.clear(); acknowledgedPages.clear(); registrationCache.clear(); registrationPending.clear();
        dispatchPages.clear(); tabSessionCache.clear(); verifiedTabSessions.clear(); capacityWaiting.clear(); offlineSessions.clear();
        if (!await restoreBackendIdentities()) throw new Error("backend_identity_recovery_pending");
        sendResponse({ status: "ok" });
      } catch (error) {
        await restoreBackendIdentities().catch(() => false);
        throw error;
      } finally {
        backendChanging = false;
        if (dispatchClient?.stopped) { dispatchClient = null; dispatchMode = null; }
        void restoreDispatchLoops();
      }
    })().catch(error => sendResponse({ error: error.message }));
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
