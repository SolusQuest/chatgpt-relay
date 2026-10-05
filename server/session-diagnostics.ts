import { Router } from "express";
import type { Db } from "./db.js";
import type { TaskStore } from "./task-store.js";
import { createRequire } from "node:module";
import { BrowserInstances, browserInstancesRouter } from "./browser-instances.js";

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
    if (typeof body?.owner !== "string" || !body.owner || body.owner.length > 200 ||
        !Number.isSafeInteger(body.tabId) || body.tabId < 0 || typeof body.session !== "string" ||
        !this.store.registry.get(body.session)) throw new Error("invalid_snapshot");
    const bool = (x: unknown) => typeof x === "boolean" ? x : null;
    // Whitelist fields: composer text, task prompts, URLs and credentials never leave the page.
    const payload = { owner: body.owner, tabId: body.tabId,
      generation: Number.isSafeInteger(body.generation) ? body.generation : null,
      version: typeof body.version === "string" ? body.version.slice(0, 80) : null,
      protocol: body.protocol === 1 ? 1 : null,
      capabilities: { composer: bool(body.capabilities?.composer),
        userMessages: bool(body.capabilities?.userMessages), assistantMessages: bool(body.capabilities?.assistantMessages) },
      ready: bool(body.ready), generating: bool(body.generating), composerClean: bool(body.composerClean),
      reason: typeof body.reason === "string" ? body.reason.slice(0, 100) : null };
    this.db.prepare(`INSERT INTO session_snapshots VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner, tab) DO UPDATE SET session=excluded.session,
      observed_at=excluded.observed_at, payload=excluded.payload`)
      .run(body.owner, body.tabId, this.store.registry.resolve(body.session), Date.now(), JSON.stringify(payload));
  }
  inspect(id: string, now = Date.now()) {
    const ref = this.store.registry.get(id);
    if (!ref) return null;
    const rows = this.db.prepare("SELECT observed_at, payload FROM session_snapshots WHERE session = ?")
      .all(ref.canonical) as { observed_at: number; payload: string }[];
    const pages = rows.map(r => ({ ...JSON.parse(r.payload), observedAt: r.observed_at,
      stale: now - r.observed_at > SNAPSHOT_TTL_MS }));
    const instances = this.instances.list(now);
    const live = pages.filter(p => {
      if (p.stale) return false;
      const instance = instances.find(i => i.instanceId === p.owner);
      if (!instance) return true; // Compatibility with extensions without inventory.
      const tab = instance.tabs.find(t => t.tabId === p.tabId);
      return !instance.stale && p.generation === instance.generation && !!tab && tab.conversationId === ref.conversation;
    });
    const matching = instances.filter(i => !i.stale).flatMap(i => i.tabs
      .filter(t => t.conversationId === ref.conversation && ref.conversation != null)
      .map(t => ({ instanceId: i.instanceId, generation: i.generation, ...t })));
    const expectedOwners = new Set([ref.owner, ...pages.map(p => p.owner)].filter(Boolean));
    const known = instances.filter(i => expectedOwners.has(i.instanceId));
    const browserStatus = matching.length > 1 ? "ambiguous" : matching.length === 1 ?
      matching[0]!.loading ? "loading" : live.length === 1 ? "observed" : "script_unreachable" :
      known.some(i => !i.stale) || (!expectedOwners.size && instances.some(i => !i.stale)) ? "tab_missing" :
      known.length ? "instance_stale" : "unknown";
    const active = this.store.listTasks({ session: ref.canonical, status: ["in_progress", "recovering"] })[0];
    return { ...this.store.registry.view(ref), session: ref.canonical,
      server: this.store.getSession(ref.canonical), activeTaskId: active?.id ?? null,
      queuedTasks: this.store.listTasks({ session: ref.canonical, status: "queued" }).length,
      pageStatus: live.length === 1 ? "observed" : live.length > 1 ? "ambiguous" : "unknown",
      page: live.length === 1 ? live[0] : null, pages,
      browser: { status: browserStatus, tabs: matching, instances: instances.map(({ tabs, ...instance }) => instance) } };
  }
  doctor(id?: string) {
    const sessions = id ? [this.inspect(id)].filter(s => s !== null) :
      this.store.listSessions().map(s => this.inspect(s.id)).filter(s => s !== null);
    const checks = sessions.map(s => ({ session: s.session, pageStatus: s.pageStatus,
      extensionVersion: s.page?.version ?? null, protocolCompatible: s.page ? s.page.protocol === 1 : null,
      capabilities: s.page?.capabilities ?? null,
      browser: s.browser,
      code: s.browser.status !== "unknown" && s.browser.status !== "observed" ? `browser_${s.browser.status}` :
        s.pageStatus !== "observed" ? `page_${s.pageStatus}` : s.page.protocol !== 1 ? "reload_extension_and_page" :
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
