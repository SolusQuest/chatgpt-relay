import { type Backend, BackendError, probeBackend } from "./backend.js";
import { readBinding, saveBinding } from "./backend-config.js";
import { discoverBackends, uniqueBackend } from "./discovery.js";

export interface BackendOptions { server?: string; local?: boolean }
export async function resolveBackend(options: BackendOptions = {}): Promise<Backend> {
  if (options.server && options.local) throw new BackendError("invalid_backend_options", "--server and --local are mutually exclusive");
  if (options.server) return probeBackend(options.server, { allowLegacy: true });
  if (options.local) return uniqueBackend(await discoverBackends(true));
  if (process.env.GPT_RELAY_URL) return probeBackend(process.env.GPT_RELAY_URL, { allowLegacy: true });
  const binding = readBinding();
  if (binding) return probeBackend(binding.baseUrl, { expectedId: binding.serverId });

  // Preserve ordinary commands against a running pre-discovery loopback server.
  // Never bind it automatically or treat it as an identity-aware LAN candidate.
  let legacy: Backend | undefined;
  if (process.env.GPT_RELAY_LEGACY_FALLBACK !== "0") {
    try {
      const backend = await probeBackend(`http://127.0.0.1:${process.env.GPT_RELAY_PORT ?? 8765}`, { allowLegacy: true, timeoutMs: 300, maxAttempts: 1 });
      if (backend.legacy) legacy = backend;
    } catch { /* Use the normal identity-aware discovery path. */ }
  }
  let discovered: Backend[];
  try { discovered = await discoverBackends(); }
  catch (error) {
    if (legacy && error instanceof BackendError && error.code === "discovery_unavailable") return legacy;
    throw error;
  }
  if (legacy) discovered.push(legacy);
  const selected = uniqueBackend(discovered);
  if (selected.legacy) return selected;
  const saved = await saveBinding(selected, true);
  return probeBackend(saved.baseUrl, { expectedId: saved.serverId });
}
