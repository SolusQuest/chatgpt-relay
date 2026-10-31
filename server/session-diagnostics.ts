import { Router } from "express";
import type { Db } from "./db.js";
import { isLateReplyEligible, type TaskStore } from "./task-store.js";
import { createRequire } from "node:module";
import { BrowserInstances, browserInstancesRouter } from "./browser-instances.js";
import { projectKey } from "./session-registry.js";

const serverVersion: string = createRequire(import.meta.url)("../package.json").version;

export const SNAPSHOT_TTL_MS = 30_000;
export class SessionDiagnostics {
  readonly instances: BrowserInstances;
  constructor(private db: Db, private store: TaskStore) {
    this.instances = new BrowserInstances(db);
    db.exec(`CREATE TABLE IF NOT EXISTS session_snapshots (
      owner TEXT NOT NULL, tab INTEGER NOT NULL, session TEXT NOT NULL,
      observed_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner, tab));`);
  }
  report(body: any) {
    const receivedAt = Date.now();
    if (body?.observedAt != null && (!Number.isSafeInteger(body.observedAt) || body.observedAt < 0)) throw new Error("invalid_snapshot");
    if (body?.revision != null && (!Number.isSafeInteger(body.revision) || body.revision < 1)) throw new Error("invalid_snapshot");
    if (body?.generation != null && (!Number.isSafeInteger(body.generation) || body.generation < 1)) throw new Error("invalid_snapshot");
    if (typeof body?.owner !== "string" || !body.owner || body.owner.length > 200 ||
        !Number.isSafeInteger(body.tabId) || body.tabId < 0 || typeof body.session !== "string" ||
        !this.store.registry.get(body.session)) throw new Error("invalid_snapshot");
    const bool = (x: unknown) => typeof x === "boolean" ? x : null;
    const ref = this.store.registry.get(body.session)!;
    const existing = this.db.prepare("SELECT payload, observed_at FROM session_snapshots WHERE owner=? AND tab=?").get(body.owner, body.tabId) as {payload: string; observed_at: number} | undefined;
    const previous = existing ? JSON.parse(existing.payload) : null;
    const instance = this.instances.list(receivedAt).find(i => i.instanceId === body.owner);
    if ((instance && (body.generation ?? 0) < instance.generation) ||
        (previous?.generation != null && (body.generation ?? 0) < previous.generation) ||
        (previous && body.generation === previous.generation && previous.revision != null &&
          (body.revision == null || body.revision <= previous.revision))) return { accepted: false, reason: "out_of_order" };
    const observedAt = Math.min(body.observedAt ?? receivedAt, receivedAt);
    if (existing && body.generation === previous.generation && observedAt < existing.observed_at) return { accepted: false, reason: "out_of_order" };
    // Legacy manual chats did not store their Project. Learn it only from a
    // responsive page that confirms the already registered conversation.
    if (!ref.initial_task && body.protocol === 1 && body.conversationId === ref.conversation && projectKey(body.projectId))
      this.db.prepare("UPDATE session_refs SET project=? WHERE ref=? AND project IS NULL").run(projectKey(body.projectId), ref.ref);
    // Whitelist fields: composer text, task prompts, URLs and credentials never leave the page.
    const payload = { owner: body.owner, tabId: body.tabId,
      generation: Number.isSafeInteger(body.generation) ? body.generation : null,
      revision: body.revision ?? null, receivedAt,
      documentId: typeof body.documentId === "string" ? body.documentId.slice(0, 200) : null,
      probe: typeof body.probe?.ok === "boolean" ? { ok: body.probe.ok,
        code: body.probe.ok ? null : "page_probe_failed" } : null,
      version: typeof body.version === "string" ? body.version.slice(0, 80) : null,
      protocol: body.protocol === 1 ? 1 : null,
      dispatchProtocol: body.dispatchProtocol === 2 ? 2 : null,
      capabilities: { composer: bool(body.capabilities?.composer), effort: bool(body.capabilities?.effort),
        userMessages: bool(body.capabilities?.userMessages), assistantMessages: bool(body.capabilities?.assistantMessages) },
      ready: bool(body.ready), generating: bool(body.generating), composerClean: bool(body.composerClean),
      block: body.block?.code === "conversation_blocked" ? { code: "conversation_blocked",
        message: typeof body.block.text === "string" ? body.block.text.slice(0, 240) : null } : null,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 100) : null };
    this.db.prepare(`INSERT INTO session_snapshots VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner, tab) DO UPDATE SET session=excluded.session,
      observed_at=excluded.observed_at, payload=excluded.payload`)
      .run(body.owner, body.tabId, this.store.registry.resolve(body.session), observedAt, JSON.stringify(payload));
    return { accepted: true };
  }
  reportBatch(body: any) {
    if (typeof body?.owner !== "string" || !body.owner || body.owner.length > 200 ||
        !Number.isSafeInteger(body.generation) || body.generation < 1 ||
        !Array.isArray(body.reports) || body.reports.length > 2000) throw new Error("invalid_snapshot_batch");
    return body.reports.map((report: any, index: number) => {
      try { return { index, ...this.report({ ...report, owner: body.owner, generation: body.generation }) }; }
      catch { return { index, accepted: false, reason: "invalid_snapshot" }; }
    });
  }
  inspect(id: string, now = Date.now()) {
    const ref = this.store.registry.get(id);
    if (!ref) return null;
    const rows = this.db.prepare("SELECT observed_at, payload FROM session_snapshots WHERE session = ?")
      .all(ref.canonical) as { observed_at: number; payload: string }[];
    const pages = rows.map(r => ({ ...JSON.parse(r.payload), observedAt: r.observed_at,
      stale: now - r.observed_at > SNAPSHOT_TTL_MS }));
    const instances = this.instances.list(now);
    const matchesTab = (owner: string, tab: { tabId: number; conversationId: string | null }) =>
      ref.conversation != null ? tab.conversationId === ref.conversation :
        owner === ref.owner && tab.tabId === ref.tab_id && tab.conversationId == null;
    const current = pages.filter(p => {
      if (p.stale) return false;
      const instance = instances.find(i => i.instanceId === p.owner);
      if (!instance) return true; // Compatibility with extensions without inventory.
      const tab = instance.tabs.find(t => t.tabId === p.tabId);
      return !instance.stale && p.generation === instance.generation && !!tab && matchesTab(p.owner, tab);
    });
    const live = current.filter(p => p.probe?.ok !== false);
    const failed = current.some(p => p.probe?.ok === false);
    const evidenceStatus = failed ? "page_probe_failed" : pages.some(p => p.stale) ? "page_snapshot_stale" : "page_snapshot_unknown";
    const matching = instances.filter(i => !i.stale).flatMap(i => i.tabs
      .filter(t => matchesTab(i.instanceId, t))
      .map(t => ({ instanceId: i.instanceId, generation: i.generation, ...t })));
    const expectedOwners = new Set([ref.owner, ...pages.map(p => p.owner)].filter(Boolean));
    const known = instances.filter(i => expectedOwners.has(i.instanceId));
    const browserStatus = matching.length > 1 ? "ambiguous" : matching.length === 1 ?
      matching[0]!.loading ? "loading" : failed ? "page_probe_failed" : live.length === 1 ? "observed" : evidenceStatus :
      known.some(i => !i.stale) || (!expectedOwners.size && instances.some(i => !i.stale)) ? "tab_missing" :
      known.length ? "instance_stale" : "unknown";
    const waitingInstances = instances.filter(i => !i.stale && i.dispatch?.waitingSessions?.some(id => this.store.registry.resolve(id) === ref.canonical));
    const controlsPending = !!this.db.prepare(`SELECT id FROM session_controls WHERE session=?
      AND state IN ('queued','claimed','executing') AND expires_at > ? LIMIT 1`).get(ref.canonical, now);
    const failedTasks = this.db.prepare("SELECT id FROM tasks WHERE session=? AND status='failed' AND late_reply IS NULL")
      .all(ref.canonical) as {id: string}[];
    const latePending = failedTasks.some(({id}) => {
      const task = this.store.getTask(id)!;
      return isLateReplyEligible(task.error) && now <= this.store.getLateReplyDeadlineAt(task);
    });
    const active = this.store.listTasks({ session: ref.canonical, status: ["in_progress", "recovering"] })[0];
    return { ...this.store.registry.view(ref), session: ref.canonical,
      server: this.store.getSession(ref.canonical), activeTaskId: active?.id ?? null,
      activeTaskStatus: active?.status ?? null, controlsPending, latePending,
      dispatch: {waitingReason: waitingInstances.length ? "waiting_for_capacity" : null,
        waitingInstances: waitingInstances.map(i => i.instanceId)},
      queuedTasks: this.store.listTasks({ session: ref.canonical, status: "queued" }).length,
      pageStatus: failed ? "page_probe_failed" : live.length === 1 ? "observed" : live.length > 1 ? "ambiguous" : pages.some(p => p.stale) ? "page_snapshot_stale" : "unknown",
      page: live.length === 1 ? live[0] : null, pages,
      browser: { status: browserStatus, tabs: matching, instances: instances.map(({ tabs, ...instance }) => ({...instance, relevant: matching.some(t => t.instanceId === instance.instanceId) || expectedOwners.has(instance.instanceId)})) } };
  }
  doctor(id?: string) {
    const sessions = id ? [this.inspect(id)].filter(s => s !== null) :
      this.store.listSessions().map(s => this.inspect(s.id)).filter(s => s !== null);
    const checks = sessions.map(s => ({ session: s.session, pageStatus: s.pageStatus,
      extensionVersion: s.page?.version ?? null, protocolCompatible: s.page ? s.page.protocol === 1 : null,
      capabilities: s.page?.capabilities ?? null,
      block: s.page?.block ?? null,
      browser: s.browser, dispatch: s.dispatch,
      code: s.dispatch.waitingReason === "waiting_for_capacity" ? "waiting_for_capacity" : s.browser.instances.some(i => i.relevant && !i.stale && i.dispatch?.state === "disconnected") ? "dispatch_disconnected" :
        s.browser.status !== "unknown" && s.browser.status !== "observed" ? s.browser.status.startsWith("page_") ? s.browser.status : `browser_${s.browser.status}` :
        s.pageStatus !== "observed" ? s.pageStatus.startsWith("page_") ? s.pageStatus : `page_${s.pageStatus}` : s.page.protocol !== 1 || (s.browser.instances.some(i => i.relevant && !i.stale && i.dispatch?.state === "connected") && s.page.dispatchProtocol !== 2) ? "reload_extension_and_page" :
        s.page.block?.code === "conversation_blocked" ? "conversation_blocked" :
        s.page.capabilities?.composer !== true ? "composer_unavailable" : "ok" }));
    return { server: { reachable: true, version: serverVersion, controlProtocol: 1 },
      status: checks.length > 0 && checks.every(c => c.code === "ok") ? "ok" : "attention",
      instances: this.instances.list().map(({ tabs, ...instance }) => instance),
      checks, note: "Null capabilities are unobserved. A stale instance heartbeat does not distinguish a closed browser from a disabled extension." };
  }
}

export function diagnosticsRouter(diagnostics: SessionDiagnostics) {
  const router = Router();
  router.use(browserInstancesRouter(diagnostics.instances));
  router.get("/v1/doctor", (req, res) => {
    const id = typeof req.query.session === "string" ? req.query.session : undefined;
    if (id && !diagnostics.inspect(id)) return res.status(404).json({ error: "session_not_found" });
    res.json(diagnostics.doctor(id));
  });
  router.post("/internal/session-snapshots/batch", (req, res) => {
    try { res.json({ status: "ok", reports: diagnostics.reportBatch(req.body) }); }
    catch { res.status(400).json({ error: "invalid_snapshot_batch" }); }
  });
  router.post("/internal/session-snapshots", (req, res) => {
    try { diagnostics.report(req.body); res.json({ status: "ok" }); }
    catch { res.status(400).json({ error: "invalid_snapshot" }); }
  });
  router.get("/v1/sessions/:id/inspect", (req, res) => {
    const result = diagnostics.inspect(String(req.params.id));
    if (!result) return res.status(404).json({ error: "session_not_found" });
    res.json(result);
  });
  return router;
}
