import { parseEffortPolicy } from "../../shared/effort.js";
import { Router } from "express";
import type { TaskStore } from "../task-store.js";
import { normalizeTimeout } from "../task-store.js";
import { asPositiveInt } from "../util.js";
import type { Config } from "../config.js";
import { RegistryError, projectKey } from "../session-registry.js";
import { tryFixEncoding } from "../encoding-fix.js";

export function createSessionCreationRouter(store: TaskStore, config: Config) {
  const router = Router();
  const registry = store.registry;
  router.post("/v1/sessions", (req, res) => {
    const b = req.body ?? {};
    if (typeof b.text !== "string" || !b.text.trim()) throw new RegistryError("missing text", 400);
    if (b.clientRequestId !== undefined && (typeof b.clientRequestId !== "string" || !b.clientRequestId.trim() || b.clientRequestId.length > 128)) {
      throw new RegistryError("invalid clientRequestId", 400);
    }
    if (!Object.hasOwn(b, "projectId") || (b.projectId !== null && !projectKey(b.projectId))) {
      throw new RegistryError("projectId must be an explicit project ID or null", 400);
    }
    const project = b.projectId === null ? null : projectKey(b.projectId);
    const timeout = normalizeTimeout(asPositiveInt(b.timeout) ?? undefined, config.defaultTimeoutMs, config.maxTaskTimeoutMs);
    const fix = tryFixEncoding(b.text);
    let policy;
    try { policy = parseEffortPolicy(b); } catch { throw new RegistryError("invalid_effort_policy", 400); }
    const fingerprint = JSON.stringify({ project, text: fix.text, timeout, ...(policy ? { effortPolicy: policy } : {}) });
    const row = registry.create(b.sessionRef, project, fingerprint, () => store.createTask({
      session: b.sessionRef, text: fix.text, timeoutMs: timeout,
      clientRequestId: typeof b.clientRequestId === "string" ? b.clientRequestId : null,
    }), policy);
    const task = store.getTask(row.initial_task!)!;
    res.status(201).json({ taskId: task.id, status: task.status, ...registry.view(row) });
  });
  router.get("/v1/sessions/:ref", (req, res) => {
    res.json(registry.view(registry.requireRef(String(req.params.ref))));
  });
  router.get("/v1/projects", (_req, res) => res.json({ projects: registry.listProjects() }));
  router.put("/v1/projects/:id", (req, res) => {
    const b = req.body ?? {};
    if (typeof b.name !== "string" || b.name.length > 200 ||
      (b.description !== undefined && b.description !== null &&
        (typeof b.description !== "string" || b.description.length > 4000))) {
      throw new RegistryError("invalid project metadata", 400);
    }
    registry.putProject(String(req.params.id), b.name, b.description);
    res.json({ projects: registry.listProjects() });
  });
  router.delete("/v1/projects/:id", (req, res) => {
    registry.removeProject(String(req.params.id));
    res.json({ status: "ok" });
  });
  router.post("/internal/session-creations/claim", (req, res) => {
    const owner = req.body?.owner;
    if (typeof owner !== "string" || owner.length < 1 || owner.length > 128) throw new RegistryError("invalid owner", 400);
    const row = registry.claim(owner);
    res.json({ command: row ? { sessionRef: row.ref, projectId: row.project, token: row.token,
      state: row.command_state, tabId: row.tab_id, initialTaskId: row.initial_task } : null });
  });
  router.post("/internal/session-creations/:ref/:action", (req, res) => {
    const ref = String(req.params.ref);
    const b = req.body ?? {};
    if (typeof b.owner !== "string" || typeof b.token !== "string") throw new RegistryError("missing ownership", 400);
    const row = registry.owned(ref, b.owner, b.token);
    switch (req.params.action) {
      case "inspect": return res.json({ status: "ok", tabId: row.tab_id, ...registry.view(row) });
      case "reattach":
        if (b.previousTabMissing !== true || !Number.isSafeInteger(b.previousTabId) || !Number.isSafeInteger(b.tabId)) {
          throw new RegistryError("missing previous-tab evidence", 400);
        }
        registry.reattach(ref, b.owner, b.token, b.previousTabId, b.tabId); break;
      case "opening": registry.opening(ref, b.owner, b.token); break;
      case "attach":
        if (!Number.isSafeInteger(b.tabId) || b.tabId < 0) throw new RegistryError("invalid tabId", 400);
        registry.attach(ref, b.owner, b.token, b.tabId); break;
      case "bind":
        if (!Object.hasOwn(b, "projectId") || (b.projectId !== null && !projectKey(b.projectId))) {
          throw new RegistryError("missing project evidence", 400);
        }
        registry.bind(ref, b.owner, b.token, b.tabId, b.conversationId,
          b.projectId === null ? null : projectKey(b.projectId)); break;
      case "fail": {
        const task = store.getTask(row.initial_task!)!;
        const unknown = b.unknown === true || task.sendAttemptedAt !== null;
        const error = typeof b.error === "string" ? b.error.slice(0, 200) : "session_creation_failed";
        // A concurrent successful bind wins over a stale page observation.
        if (row.conversation) break;
        registry.fail(ref, b.owner, b.token, error, unknown);
        // After Send, a transient SPA identity mismatch is unknown evidence,
        // not proof the message failed. Keep observing the original task.
        if (task.sendAttemptedAt === null && ["queued", "in_progress", "recovering"].includes(task.status))
          store.completeTask(task.id, { error });
        break;
      }
      default: throw new RegistryError("unknown action", 400);
    }
    res.json({ status: "ok", ...registry.view(registry.requireRef(ref)) });
  });
  return router;
}
