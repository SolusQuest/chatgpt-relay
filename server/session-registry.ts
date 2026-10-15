import type { EffortPolicy } from "../shared/effort.js";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export class RegistryError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}
export const validRef = (value: unknown): value is string =>
  typeof value === "string" && /^sr_[A-Za-z0-9_-]{1,120}$/.test(value);
export function projectKey(value: unknown): string | null {
  return typeof value === "string"
    ? value.match(/^(g-p-[a-f0-9]{32})(?:-[^\s/?#]+)?$/i)?.[1]?.toLowerCase() ?? null
    : null;
}
export interface ReferenceRow {
  ref: string; canonical: string; conversation: string | null; project: string | null;
  initial_task: string | null; fingerprint: string | null; command_state: string;
  owner: string | null; token: string | null; tab_id: number | null;
  created_at: number; error: string | null; effort_policy: string | null;
}
interface TaskEvidence { status: string; send_attempted_at: number | null }

/** Stable execution identity; browser ownership is independent of message status. */
export class SessionRegistry {
  constructor(private readonly db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_refs (
        ref TEXT PRIMARY KEY, canonical TEXT NOT NULL UNIQUE,
        conversation TEXT UNIQUE, project TEXT, initial_task TEXT, fingerprint TEXT,
        command_state TEXT NOT NULL, owner TEXT, token TEXT, tab_id INTEGER,
        created_at INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = db.prepare("PRAGMA table_info(session_refs)").all() as { name: string }[];
    if (!columns.some(c => c.name === "effort_policy")) db.exec("ALTER TABLE session_refs ADD COLUMN effort_policy TEXT");
  }
  get(id: string): ReferenceRow | null {
    return this.db.prepare("SELECT * FROM session_refs WHERE ref = ? OR canonical = ? OR conversation = ?")
      .get(id, id, id) as unknown as ReferenceRow ?? null;
  }
  resolve(id: string): string { return this.get(id)?.canonical ?? id; }
  legacy(id: string): ReferenceRow {
    const existing = this.get(id);
    if (existing) return existing;
    const ref = `sr_${randomUUID()}`;
    this.db.prepare(`INSERT INTO session_refs(ref, canonical, conversation, command_state, created_at)
      VALUES (?, ?, ?, 'finished', ?)`).run(ref, id, id, Date.now());
    return this.get(ref)!;
  }
  requireRef(ref: unknown): ReferenceRow {
    if (!validRef(ref)) throw new RegistryError("invalid sessionRef", 400);
    const row = this.get(ref);
    if (!row || row.ref !== ref) throw new RegistryError("sessionRef not found", 404);
    return row;
  }
  view(row: ReferenceRow) {
    const task = row.initial_task ? this.db.prepare("SELECT status, send_attempted_at FROM tasks WHERE id = ?").get(row.initial_task) as unknown as TaskEvidence : null;
    const terminal = task && ["done", "failed", "cancelled", "expired"].includes(task.status);
    const creationStatus = row.conversation ? "created"
      : row.command_state === "unknown" || (terminal && (task.status === "done" || task.send_attempted_at != null ||
        (row.command_state === "opening" && row.tab_id === null))) ? "unknown"
      : row.command_state === "failed" || terminal ? "failed" : "pending";
    return { sessionRef: row.ref, conversationId: row.conversation, projectId: row.project,
      effortPolicy: row.effort_policy ? JSON.parse(row.effort_policy) as EffortPolicy : null,
      creationStatus, initialTaskId: row.initial_task, initialTaskStatus: task?.status ?? null,
      creationError: row.error };
  }
  create(ref: string, project: string | null, fingerprint: string, createTask: () => { id: string }, policy: EffortPolicy | null = null) {
    if (!validRef(ref)) throw new RegistryError("invalid sessionRef", 400);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get(ref);
      if (old) {
        if (old.ref !== ref || old.fingerprint !== fingerprint) throw new RegistryError("sessionRef creation conflict");
        this.db.exec("COMMIT");
        return old;
      }
      this.db.prepare(`INSERT INTO session_refs(ref, canonical, project, fingerprint, command_state, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)`).run(ref, ref, project, fingerprint, Date.now());
      if (policy) this.setEffort(ref, policy);
      const task = createTask();
      this.db.prepare("UPDATE session_refs SET initial_task = ? WHERE ref = ?").run(task.id, ref);
      this.db.exec("COMMIT");
      return this.get(ref)!;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  setEffort(id: string, policy: EffortPolicy) {
    const ref = this.get(id);
    if (!ref) throw new RegistryError("session not found", 404);
    this.db.prepare("UPDATE session_refs SET effort_policy=? WHERE ref=?").run(JSON.stringify(policy), ref.ref);
  }
  claim(owner: string): ReferenceRow | null {
    const resumable = this.db.prepare(`SELECT r.* FROM session_refs r JOIN tasks t ON t.id = r.initial_task
      WHERE r.owner = ? AND r.command_state IN ('claimed','opening') AND t.status = 'queued'
      AND t.expires_at > ? ORDER BY r.created_at LIMIT 1`).get(owner, Date.now()) as unknown as ReferenceRow;
    if (resumable) return resumable;
    const row = this.db.prepare(`SELECT r.* FROM session_refs r JOIN tasks t ON t.id = r.initial_task
      WHERE r.command_state = 'queued' AND t.status = 'queued' AND t.expires_at > ?
      ORDER BY r.created_at LIMIT 1`).get(Date.now()) as unknown as ReferenceRow;
    if (!row) return null;
    const changed = this.db.prepare("UPDATE session_refs SET owner = ?, token = ?, command_state = 'claimed' WHERE ref = ? AND command_state = 'queued'")
      .run(owner, randomUUID(), row.ref);
    if (Number(changed.changes) !== 1) return null;
    return this.get(row.ref)!;
  }
  owned(ref: string, owner: string, token: string): ReferenceRow {
    const row = this.requireRef(ref);
    if (row.owner !== owner || row.token !== token) throw new RegistryError("creation ownership mismatch");
    const task = this.db.prepare("SELECT status, send_attempted_at FROM tasks WHERE id = ?").get(row.initial_task!) as unknown as TaskEvidence;
    if (!task || (!row.conversation && this.view(row).creationStatus !== "unknown" &&
      ["failed", "expired", "cancelled"].includes(task.status) && task.send_attempted_at == null)) {
      throw new RegistryError("creation attempt terminated");
    }
    return row;
  }
  opening(ref: string, owner: string, token: string) {
    const row = this.owned(ref, owner, token);
    if (row.command_state !== "claimed") throw new RegistryError("creation already opened");
    this.db.prepare("UPDATE session_refs SET command_state = 'opening' WHERE ref = ?").run(ref);
  }
  attach(ref: string, owner: string, token: string, tab: number) {
    const row = this.owned(ref, owner, token);
    const uncertain = this.view(row).creationStatus === "unknown";
    if (!["opening", "attached", "finished", "unknown"].includes(row.command_state) ||
      (row.tab_id !== null && row.tab_id !== tab)) throw new RegistryError("creation tab mismatch");
    this.db.prepare("UPDATE session_refs SET tab_id = ?, command_state = CASE WHEN conversation IS NOT NULL THEN 'finished' WHEN ? THEN 'unknown' ELSE 'attached' END WHERE ref = ?")
      .run(tab, uncertain ? 1 : 0, ref);
  }
  reattach(ref: string, owner: string, token: string, oldTab: number, tab: number) {
    const row = this.owned(ref, owner, token);
    if (row.tab_id !== oldTab || row.tab_id === null) throw new RegistryError("previous tab ownership changed");
    this.db.prepare("UPDATE session_refs SET tab_id = ? WHERE ref = ? AND tab_id = ?").run(tab, ref, oldTab);
  }
  bind(ref: string, owner: string, token: string, tab: number, conversation: string, project: string | null) {
    const row = this.owned(ref, owner, token);
    if (row.tab_id !== tab || row.project !== project || typeof conversation !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversation)) {
      throw new RegistryError("conversation or project mismatch");
    }
    if (row.conversation && row.conversation !== conversation) throw new RegistryError("sessionRef already bound");
    const other = this.get(conversation);
    if (other && other.ref !== ref) throw new RegistryError("conversation already registered");
    this.db.prepare("UPDATE session_refs SET conversation = ?, command_state = 'finished', error = NULL WHERE ref = ?")
      .run(conversation, ref);
    return this.get(ref)!;
  }
  fail(ref: string, owner: string, token: string, error: string, unknown: boolean) {
    const row = this.owned(ref, owner, token);
    if (row.conversation) return;
    this.db.prepare("UPDATE session_refs SET command_state = ?, error = ? WHERE ref = ?")
      .run(unknown ? "unknown" : "failed", error, ref);
  }
  listProjects() {
    return this.db.prepare("SELECT project_id AS projectId, name, description, updated_at AS updatedAt FROM projects ORDER BY name, project_id").all();
  }
  putProject(id: string, name: string, description: string | null | undefined) {
    const key = projectKey(id);
    if (!key || !name.trim()) throw new RegistryError("invalid projectId or name", 400);
    this.db.prepare(`INSERT INTO projects(project_id, name, description, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET name = excluded.name,
        description = CASE WHEN ? THEN excluded.description ELSE projects.description END, updated_at = excluded.updated_at`)
      .run(key, name.trim(), description ?? null, Date.now(), description !== undefined ? 1 : 0);
  }
  removeProject(id: string) {
    const key = projectKey(id);
    if (!key) throw new RegistryError("invalid projectId", 400);
    this.db.prepare("DELETE FROM projects WHERE project_id = ?").run(key);
  }
}
