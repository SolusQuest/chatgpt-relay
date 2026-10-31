import { evictionCandidates } from './page-policy.js';

// A single queue covers reservation, reclamation and creation, including reopen.
export function createPageManager({ storageGet, storageSet, listTabs, getPageState,
  inspectSession, listPending, closePage, now = Date.now }) {
  let queue = Promise.resolve();
  const read = async key => (await storageGet(key)) ?? {};
  let writes = Promise.resolve();
  const mutate = (key, update) => {
    const operation = writes.then(async () => { const value = await read(key); await update(value); await storageSet(key, value); });
    writes = operation.catch(() => {});
    return operation;
  };
  const isManaged = record => (record.provenance === 'relay' || record.managementGranted === true) && record.lifecyclePolicy === 'reclaimable';
  async function remember(tabId, metadata, isCurrent = () => true) {
    await mutate('page_lifecycle', records => {
      if (!isCurrent()) throw new Error('registration_superseded');
      let previous = records[tabId];
      // A tab's authority belongs to its session, never to the browser tab ID.
      if (previous && (previous.session !== metadata.session ||
          (previous.conversationId && previous.conversationId !== metadata.conversationId))) previous = null;
      records[tabId] = { ...previous, ...metadata, tabId,
        lifecyclePolicy: metadata.lifecyclePolicy ?? previous?.lifecyclePolicy ?? 'protected',
        provenance: metadata.provenance ?? previous?.provenance ?? 'manual',
        lastTaskActivityAt: metadata.lastTaskActivityAt ?? previous?.lastTaskActivityAt ?? now() };
    });
  }
  async function forget(tabId, isCurrent = () => true) { await mutate('page_lifecycle', records => { if (isCurrent()) delete records[tabId]; }); }
  async function noteActivity(session) {
    await mutate('page_lifecycle', records => { for (const record of Object.values(records))
      if (record.session === session) record.lastTaskActivityAt = now(); });
  }
  async function setPolicy(tabId, policy) {
    if (!['protected', 'reclaimable'].includes(policy)) throw new Error('invalid_lifecycle_policy');
    await mutate('page_lifecycle', records => { if (records[tabId]) {
      records[tabId].lifecyclePolicy = policy;
      records[tabId].managementGranted = policy === 'reclaimable';
    } });
  }
  async function capacity(maxManagedTabs = 6) {
    const [tabs, records] = await Promise.all([listTabs(), read('page_lifecycle')]);
    const managedCount = tabs.filter(tab => isManaged(records[tab.id] ?? {})).length;
    return { managedCount, maxManagedTabs, available: Math.max(0, maxManagedTabs - managedCount) };
  }
  async function sample(record) {
    const latest = (await read('page_lifecycle'))[record.tabId];
    if (!latest || !isManaged(latest) || latest.session !== record.session ||
        latest.conversationId !== record.conversationId) return null;
    record = latest;
    const [tabs, state, server, pending] = await Promise.all([
      listTabs(), getPageState(record.tabId), inspectSession(record.session), listPending(),
    ]);
    const tab = tabs.find(tab => tab.id === record.tabId);
    if (!tab || !state || !server || state.session !== record.session ||
        state.conversationId !== record.conversationId || !state.documentId ||
        !Number.isInteger(state.activityRevision)) return null;
    const pendingItems = pending instanceof Map ? [...pending.values()] : Array.isArray(pending) ? pending : Object.values(pending ?? {});
    const localPending = pendingItems.some(item => item?.session === record.session || item?.expectedSession === record.session || item?.tabId === record.tabId);
    const eligible = evictionCandidates([{ ...record,
      safeIdle: server.safeIdle === true && state.ready === true && state.generating === false &&
        state.composerClean === true && !state.inflight?.taskId &&
        Number.isFinite(record.lastTaskActivityAt) && now() - record.lastTaskActivityAt >= 60000,
      queued: server.queued, activeTask: server.activeTask, recovery: server.recovery,
      latePending: server.latePending === false && !localPending ? false : true,
      controlsPending: server.controlsPending,
      draft: state.composerClean !== true, upload: state.composerClean !== true,
      pinned: tab.pinned === false ? false : true, active: tab.active === false ? false : true,
      lastUserActivityAt: state.lastUserActivityAt,
    }], { now: now() });
    return eligible.length ? { record: eligible[0], state } : null;
  }
  async function ensureSlot(max) {
    if ((await capacity(max)).available > 0) return;
    const records = Object.values(await read('page_lifecycle')).filter(isManaged);
    const samples = (await Promise.all(records.map(record => sample(record).catch(() => null)))).filter(Boolean);
    const ordered = evictionCandidates(samples.map(sample => sample.record), { now: now() });
    for (const record of ordered) {
      // Refresh after ordering: human interaction or queued work can change while sampling another tab.
      const fresh = await sample(record).catch(() => null);
      if (!fresh) continue;
      const original = samples.find(sample => sample.record.tabId === record.tabId);
      if (fresh.state.activityRevision !== original.state.activityRevision || fresh.state.documentId !== original.state.documentId) continue;
      await mutate('parked_sessions', parked => { parked[record.session] = { ...record, status: 'closing', parkedAt: now() }; });
      try { await closePage(record, fresh.state); } catch { /* Actual disappearance is the only completion evidence. */ }
      const tabs = await listTabs();
      if (tabs.some(tab => tab.id === record.tabId)) throw new Error('waiting_for_capacity');
      await mutate('parked_sessions', parked => { parked[record.session] = { ...record, status: 'closed', parkedAt: now() }; });
      await forget(record.tabId);
      if ((await capacity(max)).available > 0) return;
    }
    throw new Error('waiting_for_capacity');
  }
  function withSlot(openFn, maxManagedTabs = 6) {
    const operation = queue.then(async () => { await ensureSlot(maxManagedTabs); return openFn(); });
    queue = operation.catch(() => {});
    return operation;
  }
  return { remember, forget, noteActivity, setPolicy, capacity, withSlot };
}
