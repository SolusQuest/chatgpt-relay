import { Router } from "express";
import type { Db } from "./db.js";
import type { TaskStore } from "./task-store.js";

export const SNAPSHOT_TTL_MS = 30_000;
export class SessionDiagnostics {
  constructor(private db: Db, private store: TaskStore) {
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
      version: typeof body.version === "string" ? body.version.slice(0, 80) : null,
      protocol: body.protocol === 1 ? 1 : null,
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
    const live = pages.filter(p => !p.stale);
    const active = this.store.listTasks({ session: ref.canonical, status: ["in_progress", "recovering"] })[0];
    return { ...this.store.registry.view(ref), session: ref.canonical,
      server: this.store.getSession(ref.canonical), activeTaskId: active?.id ?? null,
      queuedTasks: this.store.listTasks({ session: ref.canonical, status: "queued" }).length,
      pageStatus: live.length === 1 ? "observed" : live.length > 1 ? "ambiguous" : "unknown",
      page: live.length === 1 ? live[0] : null, pages };
  }
}

export function diagnosticsRouter(diagnostics: SessionDiagnostics) {
  const router = Router();
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
