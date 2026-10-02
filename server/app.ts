// server/app.ts
// Assemble the Express application and maintenance loop.
import express from "express";
import type { Config } from "./config.js";
import { openDatabase } from "./db.js";
import { TaskStore, TaskStoreError } from "./task-store.js";
import { createV1TasksRouter } from "./routes/v1-tasks.js";
import { createV1SessionsRouter } from "./routes/v1-sessions.js";
import { createInternalRouter } from "./routes/internal.js";
import { createSessionCreationRouter } from "./routes/session-creation.js";
import { RegistryError } from "./session-registry.js";
import { createProjectDiscoveryRouter } from "./project-discovery.js";

export interface AppHandle {
  app: express.Express;
  store: TaskStore;
  stopMaintenance: () => void;
}

export function createApp(config: Config): AppHandle {
  const db = openDatabase(config.dbFile);
  const store = new TaskStore(db, config);

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // v1 API
  app.use("/v1", createV1TasksRouter(store));
  app.use("/v1", createV1SessionsRouter(store));

  // Extension-internal API.
  app.use("/internal", createInternalRouter(store));
  app.use(createSessionCreationRouter(store, config));
  app.use(createProjectDiscoveryRouter(db, store.registry));
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

  return { app, store, stopMaintenance };
}
