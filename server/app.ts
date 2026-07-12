// server/app.ts
// 组装 Express app + 维护循环。
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { openDatabase } from "./db.js";
import { TaskStore } from "./task-store.js";
import { createV1TasksRouter } from "./routes/v1-tasks.js";
import { createV1SessionsRouter } from "./routes/v1-sessions.js";
import { createInternalRouter } from "./routes/internal.js";
import { createLegacyRouter } from "./routes/legacy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_DIR = path.resolve(__dirname, "..", "legacy");

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
  // 扩展端内部 API
  app.use("/internal", createInternalRouter(store));
  // 旧 API shim（Phase 5 删除）
  app.use("/", createLegacyRouter(store));

  // 兼容：油猴 loader 从 /tampermonkey.js 拉脚本
  app.get("/tampermonkey.js", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.type("application/javascript; charset=utf-8");
    res.sendFile(path.join(LEGACY_DIR, "tampermonkey.js"));
  });

  // 413 兜底
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

  // 维护循环
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