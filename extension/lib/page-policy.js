// Page identity and automatic reclamation are deliberately separate policies.
export function classifyPage({ pathname = '/', managed = null } = {}) {
  const conversationId = pathname.match(/\/c\/([a-f0-9-]+)(?:\/|$)/i)?.[1] ?? null;
  const projectId = pathname.match(/\/g\/(g-p-[a-f0-9]{32})(?:-[^/]*)?(?:\/|$)/i)?.[1]?.toLowerCase() ?? null;
  const validManaged = /^sr_[A-Za-z0-9_-]{1,120}$/.test(managed?.sessionRef ?? '') &&
    typeof managed?.token === 'string' && managed.token.length > 0 && typeof managed?.owner === 'string' &&
    (managed.projectId ?? null) === projectId &&
    (!managed.boundConversation || managed.boundConversation === conversationId) &&
    (!!conversationId || !!projectId || pathname === '/');
  return { pageKind: conversationId ? 'conversation' : validManaged ? 'creation' : 'discovery', conversationId, projectId };
}

export function evictionCandidates(tabs, { now = Date.now(), recentUserActivityMs = 60000 } = {}) {
  return tabs.filter(tab => tab.lifecyclePolicy === 'reclaimable' && (tab.provenance === 'relay' || tab.managementGranted === true) &&
    !!tab.conversationId && tab.safeIdle === true &&
    ['queued', 'activeTask', 'recovery', 'latePending', 'controlsPending', 'draft', 'upload', 'pinned', 'active']
      .every(key => tab[key] === false) &&
    (tab.lastUserActivityAt === null || (Number.isFinite(tab.lastUserActivityAt) && now - tab.lastUserActivityAt >= recentUserActivityMs)))
    .sort((a, b) => Math.max(a.lastUserActivityAt ?? 0, a.lastTaskActivityAt ?? 0) -
      Math.max(b.lastUserActivityAt ?? 0, b.lastTaskActivityAt ?? 0) || a.tabId - b.tabId);
}
