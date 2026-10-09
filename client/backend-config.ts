import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BackendError, type Backend } from "./backend.js";

export const clientConfigFile = () => process.env.GPT_RELAY_CLIENT_CONFIG ?? path.join(os.homedir(), ".gpt-relay", "client.json");
export function readBinding(): Backend | null {
  try {
    const config = JSON.parse(fs.readFileSync(clientConfigFile(), "utf8"));
    if (config.schemaVersion !== 1 || typeof config.backend?.baseUrl !== "string" ||
        typeof config.backend.serverId !== "string" || typeof config.backend.name !== "string" ||
        typeof config.backend.version !== "string") throw new Error("invalid config");
    return config.backend;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BackendError("backend_config_invalid", "cannot read client binding; inspect GPT_RELAY_CLIENT_CONFIG or use bind --clear");
  }
}

function removeStaleLock(lock: string): void {
  // Serialize stale-lock removal, then reread the owner. Otherwise two reapers
  // could remove a new writer's lock after both observed the same crashed PID.
  const reaper = `${lock}.reap`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(reaper, "wx", 0o600);
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") fs.unlinkSync(lock); }
  } catch { /* Another reaper or writer may have released the lock. */ }
  finally {
    if (descriptor !== undefined) { fs.closeSync(descriptor); fs.unlinkSync(reaper); }
  }
}

async function withConfigLock<T>(operation: () => T): Promise<T> {
  const file = clientConfigFile(), lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { descriptor = fs.openSync(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never take a lock from a live process. A crash's stale lock is removable.
      removeStaleLock(lock);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (descriptor === undefined) throw new BackendError("backend_config_busy", "client binding is being updated; retry the command");
  try { fs.writeFileSync(descriptor, String(process.pid)); return operation(); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

export async function saveBinding(backend: Backend, onlyIfUnbound = false): Promise<Backend> {
  if (!backend.serverId || backend.legacy) throw new BackendError("backend_incompatible", "binding requires a server with stable identity");
  return withConfigLock(() => {
    if (onlyIfUnbound) { const previous = readBinding(); if (previous) return previous; }
    const file = clientConfigFile(), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, backend }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return backend;
  });
}

export async function clearBinding(): Promise<void> {
  await withConfigLock(() => { try { fs.unlinkSync(clientConfigFile()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } });
}
