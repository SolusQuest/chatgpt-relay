// server/app.ts
// Assemble the Express application and maintenance loop.
import express from "express";
import { Dispatch, dispatchRouter } from "./dispatch.js";
import type { Config } from "./config.js";
import { openDatabase } from "./db.js";
import { TaskStore, TaskStoreError } from "./task-store.js";
import { createV1TasksRouter } from "./routes/v1-tasks.js";
import { createV1SessionsRouter } from "./routes/v1-sessions.js";
import { createInternalRouter } from "./routes/internal.js";
import { createSessionCreationRouter } from "./routes/session-creation.js";
import { RegistryError } from "./session-registry.js";
import { createProjectDiscoveryRouter } from "./project-discovery.js";
import { SessionDiagnostics, diagnosticsRouter } from "./session-diagnostics.js";
import { SessionControls, controlsRouter } from "./session-controls.js";
import { errorInfo } from "./error-info.js";
import { serverIdentity } from "./identity.js";
import type { ServerInfo } from "../shared/backend.js";

export interface AppHandle {
  app: express.Express;
  store: TaskStore;
  identity: ServerInfo;
  closeDatabase: () => void;
  stopMaintenance: () => void;
}

export function createApp(config: Config): AppHandle {
  const db = openDatabase(config.dbFile);
  const store = new TaskStore(db, config);
  const identity = serverIdentity(db);
  const dispatch = new Dispatch(db, store);

  const app = express();
  app.use((req, res, next) => {
    res.setHeader("X-Gpt-Relay-Server-Id", identity.serverId);
    const expected = req.get("X-Gpt-Relay-Server-Id");
    if (expected && expected !== identity.serverId) return res.status(409).json({ error: "backend_identity_mismatch" });
    next();
  });
  app.get("/v1/server", (_req, res) => res.json(identity));
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = ((body: any) => {
      if (res.statusCode >= 400 && typeof body?.error === "string")
        body = { ...body, errorInfo: errorInfo(body.error === "session_paused" && typeof body.message === "string" ? body.message : body.error) };
      return json(body);
    }) as typeof res.json;
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && !req.path.startsWith("/internal/dispatch/")) res.once("finish", () => { if (res.statusCode < 400) dispatch.notifyCommands(); });
    next();
  });
  app.use(dispatchRouter(dispatch));
  const diagnostics = new SessionDiagnostics(db, store);
  app.use(diagnosticsRouter(diagnostics));
  app.use(controlsRouter(new SessionControls(db, store, diagnostics)));

  // v1 API
  app.use("/v1", createV1TasksRouter(store));
  app.use("/v1", createV1SessionsRouter(store));

  // Extension-internal API.
  app.use("/internal", createInternalRouter(store, dispatch));
  app.use(createSessionCreationRouter(store, config));
  app.use(createProjectDiscoveryRouter(db, store.registry));
  dispatch.notifyCommands();
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof RegistryError) return res.status(err.status).json({ error: err.message });
    if (err instanceof TaskStoreError) return res.status(err.code === "task_too_large" ? 413 : 409)
      .json({ error: err.code, message: err.message });
    next(err);
  });

  // Health endpoint, also used by the popup to probe relay reachability.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", sessions: store.listSessions().length });
  });

  // Fallback for oversized request bodies.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (err && (err as { type?: string }).type === "entity.too.large") {
        return res
          .status(413)
          .json({ error: "PAYLOAD_TOO_LARGE", message: "Request body too large" });
      }
      next(err);
    },
  );

  const timer = setInterval(() => {
    try {
      const now = Date.now();
      store.expireDueTasks(now);
      store.releaseHeartbeatLostTasks(now);
    } catch (err) {
      console.error("[maintenance] error:", err);
    }
  }, config.maintenanceIntervalMs);
  timer.unref?.();

  const stopMaintenance = () => clearInterval(timer);

  return { app, store, identity, stopMaintenance, closeDatabase: () => db.close() };
}
