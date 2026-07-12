// server/config.ts
// v3 运行时配置。所有可调项集中在这里；env > default。
import os from "node:os";
import path from "node:path";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  logDir: string;
  defaultTimeoutMs: number;
  activeTaskGraceMs: number;
  heartbeatStaleMs: number;
  sessionActiveMs: number;
  maintenanceIntervalMs: number;
  maxTaskTextBytes: number;
  maxQueuedPerSession: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw != null && raw !== "" ? raw : fallback;
}

// v3 期间使用 ~/.cgcon-v3 避免污染 v2 数据；Phase 5 收尾时改回 ~/.cgcon
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".cgcon-v3");

export function loadConfig(): Config {
  const dataDir = envStr("CGCON_DATA_DIR", DEFAULT_DATA_DIR);
  return {
    port: envInt("CGCON_PORT", 8766),
    host: envStr("CGCON_HOST", "127.0.0.1"),
    dataDir,
    dbFile: envStr("CGCON_DB_FILE", path.join(dataDir, "cgcon.db")),
    logDir: envStr("CGCON_LOG_DIR", path.join(dataDir, "logs")),
    defaultTimeoutMs: envInt("CGCON_DEFAULT_TIMEOUT_MS", 5 * 60_000),
    activeTaskGraceMs: envInt("CGCON_ACTIVE_TASK_GRACE_MS", 30_000),
    heartbeatStaleMs: envInt("CGCON_HEARTBEAT_STALE_MS", 60_000),
    sessionActiveMs: envInt("CGCON_SESSION_ACTIVE_MS", 30_000),
    maintenanceIntervalMs: envInt("CGCON_MAINTENANCE_INTERVAL_MS", 5_000),
    maxTaskTextBytes: envInt("CGCON_MAX_TASK_BYTES", 512 * 1024),
    maxQueuedPerSession: envInt("CGCON_MAX_QUEUED_PER_SESSION", 50),
  };
}