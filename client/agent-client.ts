// client/agent-client.ts
// Agent client built on the /v1 API with cross-process pending-record persistence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { http, HttpError } from "./http.js";
export { submitSessionControl, getOperation, inspectSession, listBrowserInstances } from "./session-controls.js";
export type { SessionControlRequest, SessionControlOperation, SessionInspection, BrowserInstanceView, ControlKind } from "./session-controls.js";

const DEFAULT_BASE = process.env.GPT_RELAY_URL ?? "http://127.0.0.1:8765";
const pendingDir = () => process.env.GPT_RELAY_PENDING_DIR ??
  path.join(os.homedir(), ".gpt-relay", "pending");

const TERMINAL = new Set(["done", "failed", "cancelled", "expired"]);

export interface ReviewOptions {
  session?: string;
  sessionRef?: string;
  newSession?: boolean;
  projectId?: string | null;
  /** @deprecated Use waitTimeoutMs. This no longer changes server task lifetime. */
  timeoutMs?: number;
  waitTimeoutMs?: number;
  taskTimeoutMs?: number;
  waitChunkMs?: number;
  clientRequestId?: string;
  baseUrl?: string;
  wait?: boolean;
  signal?: AbortSignal;
}

export interface ReviewResult {
  taskId: string;
  status: "done" | "failed" | "cancelled" | "expired";
  reply: string | null;
  lateReply: string | null;
  error: string | null;
  submissionState: TaskView["submissionState"];
  elapsedMs: number;
}

export interface TaskProgressView {
  revision: number;
  phase: "accepted" | "generating" | "answer_streaming";
  activity: string | null;
  outputChars: number;
  observedAt: number;
  changedAt: number;
  provisional: true;
}

export interface TaskView {
  clientRequestId?: string | null;
  sessionRef?: string | null;
  conversationId?: string | null;
  taskId: string;
  session: string;
  status: string;
  text?: string;
  reply: string | null;
  lateReply: string | null;
  error: string | null;
  timeoutMs: number;
  submittedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  lateCompletedAt: number | null;
  submitStartedAt: number | null;
  sendAttemptedAt: number | null;
  submissionState:
    | "not_attempted"
    | "verifying"
    | "acknowledged"
    | "replied"
    | "not_observed"
    | "unknown";
  submissionVerificationDeadlineAt: number | null;
  submitAcknowledgedAt: number | null;
  generatingSeenAt: number | null;
  replyDetectedAt: number | null;
  recoveryStartedAt: number | null;
  recoveryObservedAt: number | null;
  recoveryReason: string | null;
  expiresAt: number;
  completionDeadlineAt: number;
  recoveryLeaseDeadlineAt: number | null;
  recoveryDeadlineAt: number;
  lateReplyDeadlineAt: number;
  requeueCount: number;
  progress: TaskProgressView | null;
}

export interface SessionView {
  sessionRef?: string;
  conversationId?: string | null;
  creationStatus?: string;
  session: string;
  lastSeen: number;
  paused: boolean;
  pauseReason: string | null;
  pendingTasks: number;
  inProgressTaskId: string | null;
  activeTaskId: string | null;
  activeTaskStatus: string | null;
}

interface PendingRecord {
  taskId: string;
  session: string;
  submittedAt: number;
  textPreview: string;
  clientRequestId?: string | null;
  sessionRef?: string;
  newSession?: boolean;
  requestOnly?: boolean;
  requestHash?: string;
  baseUrl?: string;
}

function ensurePendingDir(): void {
  fs.mkdirSync(pendingDir(), { recursive: true });
}
function pendingFile(taskId: string): string {
  return path.join(pendingDir(), `${taskId}.json`);
}
export function writePending(rec: PendingRecord): void {
  ensurePendingDir();
  fs.writeFileSync(pendingFile(rec.taskId), JSON.stringify(rec));
}
export function clearPending(taskId: string): void {
  try {
    fs.unlinkSync(pendingFile(taskId));
  } catch {
    /* ignore */
  }
}
export function listPending(): PendingRecord[] {
  if (!fs.existsSync(pendingDir())) return [];
  return fs
    .readdirSync(pendingDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(pendingDir(), f), "utf8")) as PendingRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is PendingRecord => r !== null);
}

async function submitTask(
  text: string,
  opts: ReviewOptions,
): Promise<{ taskId: string; status: string; encodingWarning?: string; encodingFixed?: string }> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const body: Record<string, unknown> = {
    ...(opts.sessionRef ? { sessionRef: opts.sessionRef } : { session: opts.session }),
    text,
  };
  if (opts.newSession) body.projectId = opts.projectId;
  if (opts.taskTimeoutMs != null) body.timeout = opts.taskTimeoutMs;
  if (opts.clientRequestId) body.clientRequestId = opts.clientRequestId;
  return http.post<{ taskId: string; status: string; encodingWarning?: string; encodingFixed?: string }>(opts.newSession ? "/v1/sessions" : "/v1/tasks", body, {
    baseUrl,
    timeoutMs: 10_000,
    signal: opts.signal,
  });
}

export async function waitForTask(
  taskId: string,
  opts: { baseUrl?: string; timeoutMs?: number; waitChunkMs?: number; signal?: AbortSignal } = {},
): Promise<TaskView> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const overallTimeout = opts.timeoutMs ?? 10 * 60_000;
  const chunk = Math.min(opts.waitChunkMs ?? 30_000, 55_000);
  const deadline = Date.now() + overallTimeout;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const wait = Math.min(chunk, remaining);
    const t = await http.get<TaskView>(`/v1/tasks/${taskId}?wait=${wait}`, {
      baseUrl,
      timeoutMs: wait + 5_000,
      signal: opts.signal,
    });
    if (TERMINAL.has(t.status)) return t;
  }
  throw new Error(`waitForTask timeout after ${overallTimeout}ms`);
}

export async function review(
  text: string,
  opts: ReviewOptions,
): Promise<ReviewResult | { taskId: string; status: string; sessionRef?: string; clientRequestId: string; reply?: undefined; lateReply?: undefined; error?: undefined }> {
  const started = Date.now();
  if (Boolean(opts.session) === Boolean(opts.sessionRef)) throw new Error("provide exactly one of session or sessionRef");
  if (opts.newSession && (!opts.sessionRef || !Object.hasOwn(opts, "projectId"))) {
    throw new Error("new session requires sessionRef and explicit projectId or null");
  }
  if (opts.clientRequestId !== undefined && (!opts.clientRequestId.trim() || opts.clientRequestId.length > 128)) {
    throw new Error("invalid clientRequestId");
  }
  opts = { ...opts, clientRequestId: opts.clientRequestId ?? randomUUID() };
  const identity = opts.sessionRef ?? opts.session!;
  const requestHash = createHash("sha256").update(JSON.stringify({ text, project: opts.projectId,
    newSession: !!opts.newSession, timeout: opts.taskTimeoutMs })).digest("hex");
  const requestKey = `request_${createHash("sha256").update(JSON.stringify([
    opts.baseUrl ?? DEFAULT_BASE, identity, opts.clientRequestId])).digest("hex")}`;
  const old = listPending().find(r => r.taskId === requestKey);
  if (old?.requestHash && old.requestHash !== requestHash) throw new Error("clientRequestId pending payload conflict");
  const record: PendingRecord = { taskId: requestKey, session: identity, sessionRef: opts.sessionRef,
    newSession: opts.newSession, requestOnly: true, requestHash, baseUrl: opts.baseUrl ?? DEFAULT_BASE,
    submittedAt: started, textPreview: text.slice(0, 80), clientRequestId: opts.clientRequestId };
  ensurePendingDir();
  try { fs.writeFileSync(pendingFile(requestKey), JSON.stringify(record), { flag: "wx", flush: true }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const reserved = JSON.parse(fs.readFileSync(pendingFile(requestKey), "utf8")) as PendingRecord;
    if (reserved.requestHash !== requestHash) throw new Error("clientRequestId pending payload conflict");
  }
  let submitted: Awaited<ReturnType<typeof submitTask>>;
  try { submitted = await submitTask(text, opts); }
  catch (e) {
    if (e instanceof HttpError && [400, 404, 409, 413].includes(e.status)) clearPending(requestKey);
    throw e;
  }
  const { taskId } = submitted;
  if (submitted.encodingWarning) {
    process.stderr.write(`[gpt-relay] WARNING: server flagged suspicious encoding: ${submitted.encodingWarning}\n`);
    process.stderr.write(`[gpt-relay]   hint (PowerShell): $OutputEncoding = [System.Text.UTF8Encoding]::new()\n`);
  }
  if (submitted.encodingFixed) {
    process.stderr.write(`[gpt-relay] note: server auto-fixed encoding (${submitted.encodingFixed})\n`);
  }
  writePending({
    ...record,
    requestOnly: false,
    taskId,
    session: identity,
    submittedAt: started,
    textPreview: text.slice(0, 80),
    clientRequestId: opts.clientRequestId ?? null,
  });
  clearPending(requestKey);
  if (opts.wait === false) {
    return { taskId, status: submitted.status, sessionRef: opts.sessionRef, clientRequestId: opts.clientRequestId! };
  }
  try {
    const t = await waitForTask(taskId, {
      baseUrl: opts.baseUrl,
      timeoutMs: opts.waitTimeoutMs ?? opts.timeoutMs,
      waitChunkMs: opts.waitChunkMs,
      signal: opts.signal,
    });
    if (!shouldKeepPendingForLateReply(t)) clearPending(taskId);
    return {
      taskId: t.taskId,
      status: t.status as ReviewResult["status"],
      reply: t.reply,
      lateReply: t.lateReply,
      error: t.error,
      submissionState: t.submissionState,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    // Keep the pending record so a later resume can recover the task.
    throw err;
  }
}

export async function listSessions(baseUrl = DEFAULT_BASE): Promise<SessionView[]> {
  const r = await http.get<{ sessions: SessionView[] }>("/v1/sessions", {
    baseUrl,
    timeoutMs: 5_000,
  });
  return r.sessions;
}

export async function getTask(
  taskId: string,
  baseUrl = DEFAULT_BASE,
): Promise<TaskView | null> {
  try {
    return await http.get<TaskView>(`/v1/tasks/${taskId}`, {
      baseUrl,
      timeoutMs: 5_000,
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

export async function cancelTask(
  taskId: string,
  baseUrl = DEFAULT_BASE,
): Promise<TaskView> {
  return http.del<TaskView>(`/v1/tasks/${taskId}`, {
    baseUrl,
    timeoutMs: 5_000,
  });
}

export async function healthCheck(baseUrl = DEFAULT_BASE): Promise<boolean> {
  try {
    const r = await http.get<{ status: string }>("/health", {
      baseUrl,
      timeoutMs: 3_000,
    });
    return r.status === "ok";
  } catch {
    return false;
  }
}

/** Return the latest status for every pending task and remove terminal records. */
export async function resumePending(
  baseUrl = DEFAULT_BASE,
): Promise<{ record: PendingRecord; task: TaskView | null }[]> {
  const out: { record: PendingRecord; task: TaskView | null }[] = [];
  for (const rec of listPending()) {
    let t: TaskView | null;
    if (rec.requestOnly) {
      if (rec.baseUrl && rec.baseUrl !== baseUrl) { out.push({ record: rec, task: null }); continue; }
      const query = new URLSearchParams({ clientRequestId: rec.clientRequestId!, limit: "1", include_text: "1" });
      query.set(rec.sessionRef ? "sessionRef" : "session", rec.session);
      try {
        if (rec.newSession && rec.sessionRef) {
          // The ref identifies creation, including retries with a different message key.
          const session = await http.get<{ initialTaskId: string | null }>(
            `/v1/sessions/${encodeURIComponent(rec.sessionRef)}`, { baseUrl, timeoutMs: 5000 });
          t = session.initialTaskId ? await getTask(session.initialTaskId, baseUrl) : null;
        } else {
          const found = await http.get<{ tasks: TaskView[] }>(`/v1/tasks?${query}`, { baseUrl, timeoutMs: 5000 });
          t = found.tasks[0] ?? null;
        }
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 404) throw e;
        t = null;
      }
      if (!t) { out.push({ record: rec, task: null }); continue; }
      const recovered = { ...rec, taskId: t.taskId, requestOnly: false };
      writePending(recovered);
      clearPending(rec.taskId);
      Object.assign(rec, recovered);
    } else t = await getTask(rec.taskId, baseUrl);
    if (!t) {
      // The server no longer has the task, for example after moving machines.
      clearPending(rec.taskId);
      out.push({ record: rec, task: null });
      continue;
    }
    if (TERMINAL.has(t.status) && !shouldKeepPendingForLateReply(t)) {
      clearPending(rec.taskId);
    }
    out.push({ record: rec, task: t });
  }
  return out;
}

function shouldKeepPendingForLateReply(task: TaskView): boolean {
  return task.status === "failed" &&
    (
      task.sendAttemptedAt !== null ||
      task.submitAcknowledgedAt !== null ||
      task.generatingSeenAt !== null
    ) &&
    task.lateReply === null &&
    task.lateReplyDeadlineAt > Date.now() &&
    (
      task.error === "task_processing_timeout" ||
      task.error === "submission_not_observed" ||
      task.error === "submission_outcome_unknown" ||
      task.error === "task_recovery_timeout" ||
      task.error === "task_recovery_lease_expired" ||
      task.error === "session_heartbeat_lost" ||
      task.error === "aborted"
    );
}
