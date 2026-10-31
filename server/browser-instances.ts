import type { Db } from "./db.js";
import { Router } from "express";

// A minute MV3 alarm can wake an idle worker. Page freshness remains stricter.
export const INSTANCE_TTL_MS = 90_000;
export const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PROJECT_ID = /^g-[A-Za-z0-9-]{1,160}$/;
export interface BrowserTab {
  tabId: number; conversationId: string | null; projectId: string | null;
  loading: boolean | null; discarded: boolean | null;
  lifecyclePolicy?: "protected" | "reclaimable" | null;
  lifecycle?: "protected" | "reclaimable" | null; waitingReason?: string | null;
}
export interface BrowserInstance {
  instanceId: string; generation: number; revision: number; observedAt: number; stale: boolean;
  receivedAt?: number; dispatch?: {state: "connected" | "disconnected" | "connecting" | "legacy"; lastConnectedAt: number | null; lastError: string | null; waitingSessions?: string[]};
  version: string | null; controls: string[]; tabs: BrowserTab[];
}
export class BrowserInstances {
  constructor(private db: Db) {
    db.exec(`CREATE TABLE IF NOT EXISTS browser_instances (
      owner TEXT PRIMARY KEY, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
      observed_at INTEGER NOT NULL, payload TEXT NOT NULL);`);
  }
  report(body: any) {
    if (typeof body?.owner !== "string" || !body.owner || body.owner.length > 200 ||
        !Number.isSafeInteger(body.generation) || body.generation < 1 ||
        !Number.isSafeInteger(body.revision) || body.revision < 1 ||
        !Array.isArray(body.tabs) || body.tabs.length > 2000) throw new Error("invalid_inventory");
    const receivedAt = Date.now();
    if (body.observedAt != null && (!Number.isSafeInteger(body.observedAt) || body.observedAt < 0)) throw new Error("invalid_inventory");
    const observedAt = Math.min(body.observedAt ?? receivedAt, receivedAt);
    const seen = new Set<number>();
    const boolean = (x: unknown) => typeof x === "boolean" ? x : null;
    const tabs: BrowserTab[] = body.tabs.map((tab: any) => {
      if (!Number.isSafeInteger(tab?.tabId) || tab.tabId < 0 || seen.has(tab.tabId) ||
          (tab.conversationId != null && (typeof tab.conversationId !== "string" || !CONVERSATION_ID.test(tab.conversationId))) ||
          (tab.projectId != null && (typeof tab.projectId !== "string" || !PROJECT_ID.test(tab.projectId)))) throw new Error("invalid_inventory");
      seen.add(tab.tabId);
      return { tabId: tab.tabId, conversationId: tab.conversationId ?? null,
        projectId: tab.projectId ?? null, loading: boolean(tab.loading), discarded: boolean(tab.discarded),
        lifecyclePolicy: ["protected", "reclaimable"].includes(tab.lifecyclePolicy ?? tab.lifecycle) ? (tab.lifecyclePolicy ?? tab.lifecycle) : null,
        lifecycle: ["protected", "reclaimable"].includes(tab.lifecyclePolicy ?? tab.lifecycle) ? (tab.lifecyclePolicy ?? tab.lifecycle) : null,
        waitingReason: ["loading", "dispatch_disconnected", "page_snapshot_stale", "page_probe_failed", "busy", "protected"].includes(tab.waitingReason) ? tab.waitingReason : null };
    });
    const controls = ["open", "close"].filter(kind => body.controls?.includes?.(kind));
    const dispatch = { state: ["connected", "disconnected", "connecting", "legacy"].includes(body.dispatch?.state) ? body.dispatch.state : "legacy",
      lastConnectedAt: Number.isSafeInteger(body.dispatch?.lastConnectedAt) && body.dispatch.lastConnectedAt >= 0 ? Math.min(body.dispatch.lastConnectedAt, receivedAt) : null,
      waitingSessions: Array.isArray(body.dispatch?.waitingSessions) ? [...new Set<string>(body.dispatch.waitingSessions.slice(0, 500).filter((id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))] : [],
      lastError: typeof body.dispatch?.lastError === "string" && /^[a-z_]{1,100}$/.test(body.dispatch.lastError) ? body.dispatch.lastError : null };
    const payload = JSON.stringify({ receivedAt, dispatch, version: typeof body.version === "string" ? body.version.slice(0, 80) : null, controls, tabs });
    // Every report replaces the entire inventory, including an empty list. Older
    // requests cannot resurrect closed tabs or a previous worker's numeric IDs.
    this.db.prepare(`INSERT INTO browser_instances VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET generation=excluded.generation, revision=excluded.revision,
      observed_at=excluded.observed_at, payload=excluded.payload
      WHERE excluded.generation > browser_instances.generation OR
        (excluded.generation = browser_instances.generation AND excluded.revision > browser_instances.revision
          AND excluded.observed_at >= browser_instances.observed_at)`)
      .run(body.owner, body.generation, body.revision, observedAt, payload);
  }
  list(now = Date.now()): BrowserInstance[] {
    const rows = this.db.prepare("SELECT * FROM browser_instances ORDER BY owner").all() as unknown as
      { owner: string; generation: number; revision: number; observed_at: number; payload: string }[];
    return rows.map(row => ({ instanceId: row.owner, generation: row.generation, revision: row.revision,
      observedAt: row.observed_at, stale: now - row.observed_at > INSTANCE_TTL_MS, ...JSON.parse(row.payload) }));
  }
}
export function browserInstancesRouter(instances: BrowserInstances) {
  const router = Router();
  router.get("/v1/browser-instances", (_req, res) => res.json({ instances: instances.list() }));
  router.post("/internal/browser-inventory", (req, res) => {
    try { instances.report(req.body); res.json({ status: "ok" }); }
    catch { res.status(400).json({ error: "invalid_inventory" }); }
  });
  return router;
}
