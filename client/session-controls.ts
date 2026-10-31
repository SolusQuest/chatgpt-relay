import type { EffortPolicy } from "../shared/effort.js";
import { http } from "./http.js";
const DEFAULT_BASE = process.env.GPT_RELAY_URL ?? "http://127.0.0.1:8765";
export type ControlKind = "open" | "close" | "refresh" | "recover" | "stop" | "set-effort" | "reverify-effort";
export interface SessionControlRequest {
  // Retain this ID before submitting. Reuse it after a transport failure.
  effort?: EffortPolicy["effort"];
  effortFallback?: EffortPolicy["effortFallback"];
  operationId: string;
  kind: ControlKind;
  session?: string;
  taskId?: string;
  instanceId?: string;
}
export interface SessionControlOperation {
  operationId: string; session: string; taskId: string | null; kind: ControlKind;
  instanceId: string; tabId: number | null; suspended: boolean;
  state: "queued" | "claimed" | "executing" | "succeeded" | "blocked" | "unknown";
  createdAt: number; expiresAt: number; error: string | null;
  errorInfo: { code: string; nextAction: string; safeToResubmit: boolean | null } | null;
  result: Record<string, unknown> | null;
}
export interface BrowserInstanceView {
  instanceId: string; generation: number; revision: number; observedAt: number; stale: boolean;
  receivedAt?: number; dispatch?: {state: "connected" | "disconnected" | "connecting" | "legacy"; lastConnectedAt: number | null; lastError: string | null; waitingSessions?: string[]};
  version: string | null; controls: string[];
  tabs: { tabId: number; conversationId: string | null; projectId: string | null; loading: boolean | null; discarded: boolean | null }[];
}
export interface SessionInspection {
  effortPolicy?: EffortPolicy | null;
  session: string; sessionRef: string; conversationId: string | null; projectId: string | null;
  pageStatus: "observed" | "ambiguous" | "unknown" | "page_snapshot_stale" | "page_probe_failed";
  activeTaskId: string | null; activeTaskStatus: "in_progress" | "recovering" | null; queuedTasks: number;
  controlsPending: boolean; latePending: boolean;
  dispatch: {waitingReason: "waiting_for_capacity" | null; waitingInstances: string[]};
  server: { suspended: boolean; paused: boolean; pauseReason: string | null } | null;
  page: { owner: string; tabId: number; dispatchProtocol?: 2 | null; ready: boolean | null; composerClean: boolean | null; generating: boolean | null; observedAt: number;
    block?: { code: "conversation_blocked"; message: string | null } | null } | null;
  browser: { status: "observed" | "loading" | "script_unreachable" | "page_snapshot_unknown" | "page_snapshot_stale" | "page_probe_failed" | "tab_missing" | "ambiguous" | "instance_stale" | "unknown";
    tabs: (BrowserInstanceView["tabs"][number] & { instanceId: string; generation: number })[];
    instances: Omit<BrowserInstanceView, "tabs">[] };
}
export function submitSessionControl(request: SessionControlRequest, baseUrl = DEFAULT_BASE): Promise<SessionControlOperation> {
  return http.post("/v1/session-controls", request, { baseUrl });
}
export function getOperation(operationId: string, baseUrl = DEFAULT_BASE): Promise<SessionControlOperation> {
  return http.get(`/v1/operations/${encodeURIComponent(operationId)}`, { baseUrl });
}
export function inspectSession(session: string, baseUrl = DEFAULT_BASE): Promise<SessionInspection> {
  return http.get(`/v1/sessions/${encodeURIComponent(session)}/inspect`, { baseUrl });
}
export async function listBrowserInstances(baseUrl = DEFAULT_BASE): Promise<BrowserInstanceView[]> {
  return (await http.get<{ instances: BrowserInstanceView[] }>("/v1/browser-instances", { baseUrl })).instances;
}
