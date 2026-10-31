import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Router } from "express";
import type { Db } from "./db.js";
import type { TaskStore } from "./task-store.js";
import { RegistryError } from "./session-registry.js";
import { isValidSessionId } from "./util.js";

type Page = { session: string; tabId: number; documentId: string };
type Subscription = Page | { session: string; tabId: null; documentId: null };
type Identity = { owner: string; generation: string };
const valid = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
export class Dispatch {
  private epoch = randomUUID();
  private revision = 0;
  private events = new EventEmitter();
  private commandFingerprint = "";
  constructor(private db: Db, private store: TaskStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS dispatch_generations(owner TEXT PRIMARY KEY,generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_retired(owner TEXT,generation TEXT,PRIMARY KEY(owner,generation));
      CREATE TABLE IF NOT EXISTS dispatch_requests(owner TEXT,generation TEXT,request_id TEXT,session TEXT,tab_id INTEGER,document_id TEXT,task_id TEXT,token TEXT,PRIMARY KEY(owner,generation,request_id));
      CREATE TABLE IF NOT EXISTS dispatch_claims(task_id TEXT PRIMARY KEY,owner TEXT,generation TEXT,token TEXT);`);
    this.events.setMaxListeners(0);
    store.onDispatchChange(() => this.notify());
  }
  notify() { this.revision++; this.events.emit("change"); }
  notifyCommands() {
    // Claims, inventory, heartbeats and inspection are frequent. Only a durable
    // command-state change can wake the dispatcher through the HTTP hook.
    const tables = [
      ["session_refs", "SELECT ref,command_state,owner,conversation FROM session_refs ORDER BY ref"],
      ["session_controls", "SELECT id,state,owner FROM session_controls WHERE state IN ('queued','claimed','executing') ORDER BY id"],
      ["project_discoveries", "SELECT id,state,owner FROM project_discoveries WHERE state IN ('queued','claimed') ORDER BY id"],
    ];
    const fingerprint = JSON.stringify(tables.map(([table, query]) => this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table!) ? this.db.prepare(query!).all() : []));
    if (fingerprint === this.commandFingerprint) return;
    this.commandFingerprint = fingerprint;
    this.notify();
  }
  get cursor() { return `${this.epoch}:${this.revision}`; }
  identity(b: any): Identity {
    if (!valid(b?.owner) || !valid(b?.generation)) throw new RegistryError("invalid dispatch identity", 400);
    return { owner: b.owner, generation: b.generation };
  }
  page(b: any): Page {
    if (!isValidSessionId(b?.session) || !Number.isInteger(b.tabId) || b.tabId < 0 || !valid(b.documentId)) throw new RegistryError("invalid dispatch page", 400);
    return { session: this.store.registry.resolve(b.session), tabId: b.tabId, documentId: b.documentId };
  }
  subscription(b: any): Subscription {
    if (b?.tabId === null && b?.documentId === null && isValidSessionId(b?.session)) return { session: this.store.registry.resolve(b.session), tabId: null, documentId: null };
    return this.page(b);
  }
  register(id: Identity, pages: Subscription[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.registerPages(id, pages);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private registerPages(id: Identity, pages: Subscription[]) {
    if (this.db.prepare("SELECT 1 FROM dispatch_retired WHERE owner=? AND generation=?").get(id.owner,id.generation)) throw new RegistryError("dispatch_generation_obsolete");
    if (new Set(pages.map(p => p.session)).size !== pages.length) throw new RegistryError("dispatch_duplicate_session",400);
    for (const p of pages) {
      const old = this.db.prepare("SELECT * FROM dispatch_sessions WHERE session=?").get(p.session) as any;
      const active = this.store.listTasks({session:p.session,status:["in_progress","recovering"],limit:1})[0];
      if (old && old.owner !== id.owner) {
        const lastSeen = this.store.getSession(p.session)?.lastSeen ?? 0;
        if (active || Date.now() - lastSeen < 60_000) throw new RegistryError("dispatch_owner_conflict");
        this.db.prepare("DELETE FROM dispatch_sessions WHERE session=?").run(p.session);
      }
      if (old && old.owner === id.owner && old.generation === id.generation && p.tabId !== null && old.tab_id !== p.tabId && active) throw new RegistryError("dispatch_page_conflict");
    }
    const old = this.db.prepare("SELECT generation FROM dispatch_generations WHERE owner=?").get(id.owner) as any;
    if (old && old.generation !== id.generation) this.db.prepare("INSERT OR IGNORE INTO dispatch_retired VALUES (?,?)").run(id.owner,old.generation);
    this.db.prepare("INSERT INTO dispatch_generations VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET generation=excluded.generation").run(id.owner,id.generation);
    for (const p of pages) {
      // A parked subscription never replaces an executor while it is active.
      if (p.tabId === null && this.db.prepare("SELECT session FROM dispatch_sessions WHERE session=?").get(p.session) && this.store.listTasks({session:p.session,status:["in_progress","recovering"],limit:1}).length) continue;
      this.db.prepare(`INSERT INTO dispatch_sessions VALUES (?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET generation=excluded.generation,tab_id=excluded.tab_id,document_id=excluded.document_id`).run(p.session,id.owner,id.generation,p.tabId ?? -1,p.documentId ?? "");
      if (p.tabId !== null) this.store.touchSession(p.session);
    }
  }
  snapshot(pages: Subscription[], id: Identity, cursor: unknown) {
    const count = (sql: string, ...args: any[]) => Number((this.db.prepare(sql).get(...args) as any).n);
    return { cursor: this.cursor, resyncRequired: typeof cursor !== "string" || !cursor.startsWith(this.epoch + ":"),
      sessions: pages.map(p => {
        const active = this.store.listTasks({session:p.session,status:["in_progress","recovering"],limit:1})[0];
        const s = this.store.getSession(p.session);
        return {session:p.session,queuedTasks:count("SELECT COUNT(*) n FROM tasks WHERE session=? AND status='queued'",p.session),activeTaskId:active?.id ?? null,activeTaskStatus:active?.status ?? null,suspended:this.store.isSuspended(p.session),paused:s?.paused ?? false};
      }), pendingCommands: {
        sessionCreation: count("SELECT COUNT(*) n FROM session_refs WHERE command_state='queued' OR (owner=? AND command_state IN ('claimed','opening'))",id.owner)>0,
        sessionControl: count("SELECT COUNT(*) n FROM session_controls WHERE owner=? AND state IN ('queued','claimed','executing') AND expires_at>?",id.owner,Date.now())>0,
        projectDiscovery: count("SELECT COUNT(*) n FROM project_discoveries WHERE (state='queued' OR (owner=? AND state='claimed')) AND expires_at>?",id.owner,Date.now())>0,
      }};
  }
  private blockedReason(id: Identity, page: Subscription): "dispatch_owner_conflict" | "dispatch_page_conflict" | null {
    const binding = this.db.prepare("SELECT * FROM dispatch_sessions WHERE session=?").get(page.session) as any;
    if (!binding) return null;
    const active = this.store.listTasks({session:page.session,status:["in_progress","recovering"],limit:1})[0];
    if (binding.owner !== id.owner && (active || Date.now() - (this.store.getSession(page.session)?.lastSeen ?? 0) < 60_000)) return "dispatch_owner_conflict";
    if (binding.owner === id.owner && binding.generation === id.generation && page.tabId !== null && binding.tab_id !== page.tabId && active) return "dispatch_page_conflict";
    return null;
  }
  async watch(b: any, signal: AbortSignal) {
    const id = this.identity(b);
    if (!Array.isArray(b.sessions) || b.sessions.length > 500) throw new RegistryError("invalid dispatch sessions",400);
    const subscriptions: Subscription[] = b.sessions.map((p: any) => this.subscription(p));
    if (new Set(subscriptions.map(p => p.session)).size !== subscriptions.length) throw new RegistryError("dispatch_duplicate_session",400);
    const blockedSessions: Array<{session:string;reason:"dispatch_owner_conflict" | "dispatch_page_conflict"}> = [];
    const pages = subscriptions.filter(page => {
      const reason = this.blockedReason(id,page);
      if (!reason) return true;
      blockedSessions.push({session:page.session,reason});
      return false;
    });
    this.register(id,pages);
    const wait = Math.min(20000,Math.max(0,Number(b.waitMs)||0));
    if (b.cursor === this.cursor && wait && !signal.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.events.off("change",finish); signal.removeEventListener("abort",finish); resolve(); };
      const timer = setTimeout(finish,wait);
      this.events.on("change",finish); signal.addEventListener("abort",finish,{once:true});
      if (b.cursor !== this.cursor || signal.aborted) finish();
    });
    if (signal.aborted) return { cursor: this.cursor, resyncRequired: false, sessions: [], blockedSessions, pendingCommands: { sessionCreation: false, sessionControl: false, projectDiscovery: false } };
    return {...this.snapshot(pages,id,b.cursor),blockedSessions};
  }
  claim(b: any) {
    const id = this.identity(b), p = this.page(b);
    if (!valid(b.requestId)) throw new RegistryError("invalid dispatch request",400);
    this.db.exec("BEGIN IMMEDIATE");
    let record: any;
    try {
      record = this.db.prepare("SELECT * FROM dispatch_requests WHERE owner=? AND generation=? AND request_id=?").get(id.owner,id.generation,b.requestId);
      if (record) {
        if (record.session !== p.session || record.tab_id !== p.tabId || record.document_id !== p.documentId) throw new RegistryError("dispatch_request_conflict");
      } else {
        const owner = this.db.prepare("SELECT * FROM dispatch_sessions WHERE session=?").get(p.session) as any;
        const current = this.db.prepare("SELECT generation FROM dispatch_generations WHERE owner=?").get(id.owner) as any;
        if (!owner || current?.generation !== id.generation || owner.owner !== id.owner || owner.generation !== id.generation || owner.tab_id !== p.tabId || owner.document_id !== p.documentId) throw new RegistryError("dispatch_generation_obsolete");
        const task = this.store.claimNextTask(p.session,Date.now(),true);
        record = {task_id:task?.id ?? null,token:task ? randomUUID():null};
        this.db.prepare("INSERT INTO dispatch_requests VALUES (?,?,?,?,?,?,?,?)").run(id.owner,id.generation,b.requestId,p.session,p.tabId,p.documentId,record.task_id,record.token);
        if (task) this.db.prepare("INSERT OR REPLACE INTO dispatch_claims VALUES (?,?,?,?)").run(task.id,id.owner,id.generation,record.token);
      }
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
    const t = record.task_id ? this.store.getTask(record.task_id) : null;
    return {task:t ? {taskId:t.id,text:t.text,effortPolicy:t.effortPolicy,timeoutMs:t.timeoutMs,submittedAt:t.submittedAt,expiresAt:t.expiresAt,completionDeadlineAt:t.expiresAt+this.store.getActiveTaskGraceMs(),recoveryDeadlineAt:this.store.getRecoveryDeadlineAt(t),lateReplyDeadlineAt:this.store.getLateReplyDeadlineAt(t),requeueCount:t.requeueCount,status:t.status,sendAttemptedAt:t.sendAttemptedAt,claimToken:record.token}:null};
  }
  resume(b: any) {
    const id = this.identity(b), page = this.page(b);
    if (!valid(b.originalGeneration) || !valid(b.requestId) || (b.resumeRequestId !== undefined && !valid(b.resumeRequestId))) throw new RegistryError("invalid dispatch resume",400);
    const destinationId = b.resumeRequestId ?? b.requestId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.db.prepare("SELECT * FROM dispatch_requests WHERE owner=? AND generation=? AND request_id=?").get(id.owner,b.originalGeneration,b.requestId) as any;
      const current = this.db.prepare("SELECT generation FROM dispatch_generations WHERE owner=?").get(id.owner) as any;
      const owner = this.db.prepare("SELECT * FROM dispatch_sessions WHERE session=?").get(page.session) as any;
      if (!request || request.session !== page.session || current?.generation !== id.generation || owner?.owner !== id.owner || owner.generation !== id.generation || owner.tab_id !== page.tabId || owner.document_id !== page.documentId) throw new RegistryError("dispatch_resume_mismatch");
      const task = request.task_id ? this.store.getTask(request.task_id) : null;
      if (task?.status === "in_progress" && task.sendAttemptedAt === null) {
        const existing = this.db.prepare("SELECT * FROM dispatch_claims WHERE task_id=?").get(task.id) as any;
        // Rotating the token fences every message from the old executor. A retry
        // in the same document preserves the new token.
        const resumed = this.db.prepare("SELECT * FROM dispatch_requests WHERE owner=? AND generation=? AND request_id=?").get(id.owner,id.generation,destinationId) as any;
        if (resumed && (resumed.task_id !== task.id || resumed.session !== page.session || resumed.tab_id !== page.tabId || resumed.document_id !== page.documentId)) throw new RegistryError("dispatch_request_conflict");
        const same = existing?.generation === id.generation && resumed?.token === existing.token;
        const priorGenerationRetired = existing?.owner === id.owner && existing.generation !== id.generation && this.db.prepare("SELECT 1 FROM dispatch_retired WHERE owner=? AND generation=?").get(id.owner, existing.generation);
        if (!same && existing?.token !== request.token && !priorGenerationRetired) throw new RegistryError("dispatch_resume_superseded");
        const token = same ? existing.token : randomUUID();
        this.db.prepare("INSERT OR REPLACE INTO dispatch_claims VALUES (?,?,?,?)").run(task.id,id.owner,id.generation,token);
        this.db.prepare("INSERT OR REPLACE INTO dispatch_requests VALUES (?,?,?,?,?,?,?,?)").run(id.owner,id.generation,destinationId,page.session,page.tabId,page.documentId,task.id,token);
      }
      this.db.exec("COMMIT");
      if (task?.status === "in_progress" && task.sendAttemptedAt === null) return this.claim({...b,requestId:destinationId,originalGeneration:undefined});
      return this.claim({...b,generation:b.originalGeneration,tabId:request.tab_id,documentId:request.document_id});
    } catch(e) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw e; }
  }
  validate(taskId: string, token: unknown, sending = false) {
    const claim = this.db.prepare("SELECT * FROM dispatch_claims WHERE task_id=?").get(taskId) as any;
    if (!claim) return;
    if (claim.token !== token) throw new RegistryError("dispatch_claim_mismatch");
    const taskState = this.store.getTask(taskId);
    const generation = this.db.prepare("SELECT generation FROM dispatch_generations WHERE owner=?").get(claim.owner) as any;
    if (taskState?.sendAttemptedAt === null && generation?.generation !== claim.generation) throw new RegistryError("dispatch_generation_obsolete");
    if (taskState?.sendAttemptedAt === null) {
      const binding = this.db.prepare("SELECT * FROM dispatch_sessions WHERE session=?").get(taskState.session) as any;
      const request = this.db.prepare("SELECT * FROM dispatch_requests WHERE token=?").get(claim.token) as any;
      if (!binding || !request || binding.owner !== claim.owner || binding.generation !== claim.generation || binding.tab_id !== request.tab_id || binding.document_id !== request.document_id) throw new RegistryError("dispatch_page_obsolete");
    }
    if (sending) {
      if (taskState?.sendAttemptedAt !== null) throw new RegistryError("dispatch_send_already_fenced");
      const current = this.db.prepare("SELECT generation FROM dispatch_generations WHERE owner=?").get(claim.owner) as any;
      const task = this.store.getTask(taskId);
      const page = task ? this.db.prepare("SELECT * FROM dispatch_sessions WHERE session=?").get(task.session) as any : null;
      const request = this.db.prepare("SELECT * FROM dispatch_requests WHERE token=?").get(claim.token) as any;
      if (!page || !request || page.owner !== claim.owner || page.generation !== claim.generation || page.tab_id !== request.tab_id || page.document_id !== request.document_id) throw new RegistryError("dispatch_page_obsolete");
      if (current?.generation !== claim.generation || task?.status !== "in_progress") throw new RegistryError("dispatch_generation_obsolete");
    }
  }
}
export function dispatchRouter(dispatch: Dispatch) {
  const router = Router();
  router.post("/internal/dispatch/watch", async (req,res,next) => {
    const controller = new AbortController();
    const close = () => controller.abort(); res.once("close",close);
    try { const result = await dispatch.watch(req.body,controller.signal); if (!controller.signal.aborted) res.json(result); }
    catch(e) { next(e); } finally { res.off("close",close); }
  });
  router.post("/internal/dispatch/resume", (req,res) => res.json(dispatch.resume(req.body)));
  router.post("/internal/dispatch/claim", (req,res) => res.json(dispatch.claim(req.body)));
  return router;
}
