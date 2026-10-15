import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.js";
import { MacOSService, type ServicePlan } from "./macos.js";

const actions = ["install", "status", "start", "stop", "restart", "uninstall"] as const;
export type ServiceAction = typeof actions[number];

export function parseServiceArgs(args: string[]): { action: ServiceAction; dryRun: boolean } {
  const [action, ...flags] = args;
  if (!actions.includes(action as ServiceAction) ||
      flags.length > 1 || flags.length === 1 && (action !== "install" || flags[0] !== "--dry-run")) {
    throw new Error("usage: gpt-relay service install [--dry-run] | status | start | stop | restart | uninstall");
  }
  return { action: action as ServiceAction, dryRun: flags.length === 1 };
}

export function installationPlan(): ServicePlan {
  const config = loadConfig();
  const port = Number(process.env.GPT_RELAY_PORT || config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("login services require a fixed GPT_RELAY_PORT (1-65535)");
  const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const environment: Record<string, string> = {};
  // Capture only server configuration, never the caller's credentials or CLI binding.
  const optionalKeys = ["GPT_RELAY_NAME", "GPT_RELAY_DISCOVERY", "GPT_RELAY_REGISTRY_DIR",
    "GPT_RELAY_DEFAULT_TIMEOUT_MS", "GPT_RELAY_MAX_TASK_TIMEOUT_MS", "GPT_RELAY_ACTIVE_TASK_GRACE_MS",
    "GPT_RELAY_RECOVERY_LEASE_MS", "GPT_RELAY_LATE_REPLY_GRACE_MS", "GPT_RELAY_HEARTBEAT_STALE_MS",
    "GPT_RELAY_SESSION_ACTIVE_MS", "GPT_RELAY_MAINTENANCE_INTERVAL_MS", "GPT_RELAY_MAX_TASK_BYTES",
    "GPT_RELAY_MAX_QUEUED_PER_SESSION"];
  for (const key of optionalKeys) {
    if (process.env[key]) environment[key] = process.env[key]!;
  }
  return {
    node: fs.realpathSync(process.execPath),
    // Resolve from WorkingDirectory at launch, so pnpm dependency updates do
    // not pin the agent to an obsolete versioned path inside node_modules.
    loader: "tsx",
    root,
    environment: { ...environment, GPT_RELAY_HOST: config.host, GPT_RELAY_PORT: String(config.port),
      GPT_RELAY_DATA_DIR: path.resolve(config.dataDir), GPT_RELAY_DB_FILE: path.resolve(config.dbFile),
      GPT_RELAY_LOG_DIR: path.resolve(config.logDir) },
    logDir: path.resolve(config.logDir),
  };
}

export async function serviceCommand(args: string[]): Promise<void> {
  const { action, dryRun } = parseServiceArgs(args);
  if (process.platform !== "darwin") throw new Error(`service management is not implemented for ${process.platform}; use gpt-relay start`);
  const uid = process.getuid!();
  if (uid === 0) throw new Error("install the login service as the browser user, without sudo");
  const service = new MacOSService(os.homedir(), uid);
  const result = action === "install" ? await service.install(installationPlan(), dryRun) : await service[action]();
  console.log(JSON.stringify(result, null, 2));
}
