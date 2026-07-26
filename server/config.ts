// server/config.ts
// Runtime configuration. Keep tunable values centralized; environment overrides defaults.
import os from "node:os";
import path from "node:path";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  logDir: string;
  defaultTimeoutMs: number;
  maxTaskTimeoutMs: number;
  activeTaskGraceMs: number;
  lateReplyGraceMs: number;
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

// Default data directory: ~/.gpt-relay
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".gpt-relay");

export function loadConfig(): Config {
  const dataDir = envStr("GPT_RELAY_DATA_DIR", DEFAULT_DATA_DIR);
  return {
    port: envInt("GPT_RELAY_PORT", 8765),
    host: envStr("GPT_RELAY_HOST", "127.0.0.1"),
    dataDir,
    dbFile: envStr("GPT_RELAY_DB_FILE", path.join(dataDir, "gpt-relay.db")),
    logDir: envStr("GPT_RELAY_LOG_DIR", path.join(dataDir, "logs")),
    defaultTimeoutMs: envInt("GPT_RELAY_DEFAULT_TIMEOUT_MS", 30 * 60_000),
    maxTaskTimeoutMs: envInt("GPT_RELAY_MAX_TASK_TIMEOUT_MS", 60 * 60_000),
    activeTaskGraceMs: envInt("GPT_RELAY_ACTIVE_TASK_GRACE_MS", 60_000),
    lateReplyGraceMs: envInt("GPT_RELAY_LATE_REPLY_GRACE_MS", 30 * 60_000),
    heartbeatStaleMs: envInt("GPT_RELAY_HEARTBEAT_STALE_MS", 60_000),
    sessionActiveMs: envInt("GPT_RELAY_SESSION_ACTIVE_MS", 30_000),
    maintenanceIntervalMs: envInt("GPT_RELAY_MAINTENANCE_INTERVAL_MS", 5_000),
    maxTaskTextBytes: envInt("GPT_RELAY_MAX_TASK_BYTES", 512 * 1024),
    maxQueuedPerSession: envInt("GPT_RELAY_MAX_QUEUED_PER_SESSION", 50),
  };
}
