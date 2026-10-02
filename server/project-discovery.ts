import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "./db.js";
import { RegistryError, projectKey, type SessionRegistry } from "./session-registry.js";

interface DiscoveryRow {
  id: string; save: number; state: string; owner: string | null; token: string | null;
  expires_at: number; result: string | null;
}

/** Read-only browser scans are resumable; only an explicit save merges the catalog. */
export function createProjectDiscoveryRouter(db: Db, registry: SessionRegistry) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_discoveries (
    id TEXT PRIMARY KEY, save INTEGER NOT NULL, state TEXT NOT NULL,
    owner TEXT, token TEXT, expires_at INTEGER NOT NULL, result TEXT
  )`);
  const router = Router();
  const expire = () => db.prepare(`UPDATE project_discoveries SET state='failed', result=?
    WHERE state IN ('queued','claimed') AND expires_at <= ?`)
    .run(JSON.stringify({ error: "discovery_timeout" }), Date.now());
  const get = (id: string) => db.prepare("SELECT * FROM project_discoveries WHERE id=?").get(id) as unknown as DiscoveryRow;
  const view = (row: DiscoveryRow) => ({ discoveryId: row.id, status: row.state,
    save: !!row.save, ...(row.result ? JSON.parse(row.result) : {}) });
  router.post("/v1/projects/discover", (req, res) => {
    if (req.body?.save !== undefined && typeof req.body.save !== "boolean") throw new RegistryError("invalid save", 400);
    expire();
    const active = db.prepare("SELECT COUNT(*) AS count FROM project_discoveries WHERE state IN ('queued','claimed')").get() as { count: number };
    if (active.count >= 100) throw new RegistryError("discovery queue full");
    const id = randomUUID();
    db.prepare("INSERT INTO project_discoveries(id,save,state,expires_at) VALUES (?,?,'queued',?)")
      .run(id, req.body?.save === true ? 1 : 0, Date.now() + 120_000);
    res.status(202).json(view(get(id)));
  });
  router.get("/v1/projects/discover/:id", (req, res) => {
    expire();
    const row = get(String(req.params.id));
    if (!row) throw new RegistryError("discovery not found", 404);
    res.json(view(row));
  });
  router.post("/internal/project-discoveries/claim", (req, res) => {
    const owner = req.body?.owner;
    if (typeof owner !== "string" || !owner.trim() || owner.length > 128) throw new RegistryError("invalid owner", 400);
    expire();
    let row = db.prepare("SELECT * FROM project_discoveries WHERE state='claimed' AND owner=? ORDER BY expires_at LIMIT 1").get(owner) as unknown as DiscoveryRow;
    if (!row) {
      row = db.prepare("SELECT * FROM project_discoveries WHERE state='queued' ORDER BY expires_at LIMIT 1").get() as unknown as DiscoveryRow;
      if (row) {
        db.prepare("UPDATE project_discoveries SET state='claimed',owner=?,token=? WHERE id=? AND state='queued'")
          .run(owner, randomUUID(), row.id);
        row = get(row.id);
      }
    }
    res.json({ command: row ? { discoveryId: row.id, token: row.token } : null });
  });
  router.post("/internal/project-discoveries/:id/complete", (req, res) => {
    expire();
    const row = get(String(req.params.id));
    if (!row) throw new RegistryError("discovery not found", 404);
    const b = req.body ?? {};
    if (!row.owner || row.owner !== b.owner || row.token !== b.token) throw new RegistryError("discovery ownership mismatch");
    if (row.state === "done") return res.json(view(row));
    if (row.state !== "claimed") throw new RegistryError("discovery terminated");
    if (!Array.isArray(b.sources) || b.sources.length > 100) throw new RegistryError("invalid sources", 400);
    const names = new Map<string, Set<string>>();
    const warnings = new Set<string>();
    const sources: Array<{ url: string; projectCount: number; error: string | null }> = [];
    for (const source of b.sources) {
      if (!source || typeof source !== "object") throw new RegistryError("invalid source", 400);
      let url: URL;
      try { url = new URL(source.url); } catch { throw new RegistryError("invalid source URL", 400); }
      if (url.origin !== "https://chatgpt.com" || !Array.isArray(source.projects) || source.projects.length > 1000) {
        throw new RegistryError("invalid source", 400);
      }
      const error = typeof source.error === "string" ? source.error.slice(0, 200) : null;
      let count = 0;
      if (!error) for (const p of source.projects) {
        if (!p || typeof p !== "object" || typeof p.href !== "string") continue;
        let link: URL;
        try { link = new URL(p.href, url); } catch { continue; }
        const id = link.origin === "https://chatgpt.com" ? projectKey(link.pathname.match(/^\/g\/([^/]+)\/project\/?$/)?.[1]) : null;
        if (!id || id !== p.projectId || typeof p.name !== "string" || !p.name.trim() || p.name.length > 200) continue;
        const seen = names.get(id) ?? new Set<string>();
        seen.add(p.name.trim()); names.set(id, seen); count++;
      }
      sources.push({ url: url.origin + url.pathname, projectCount: count, error });
      if (error) warnings.add(error);
      else if (!count) warnings.add("no_project_entries_observed");
    }
    const projects = [...names].flatMap(([projectId, values]) => {
      if (values.size !== 1) { warnings.add(`conflicting_names:${projectId}`); return []; }
      return [{ projectId, name: [...values][0]! }];
    }).sort((a, b) => a.projectId.localeCompare(b.projectId));
    const success = sources.some(s => !s.error);
    const result = { projects, sources, complete: false,
      scope: "open-chatgpt-tabs-visible-project-links", warnings: [...warnings],
      saved: !!row.save && success, ...(success ? {} : { error: "no_readable_chatgpt_tabs" }) };
    db.exec("BEGIN IMMEDIATE");
    try {
      if (row.save && success) for (const p of projects) registry.putProject(p.projectId, p.name, undefined);
      db.prepare("UPDATE project_discoveries SET state=?,result=? WHERE id=?")
        .run(success ? "done" : "failed", JSON.stringify(result), row.id);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    res.json(view(get(row.id)));
  });
  return router;
}
