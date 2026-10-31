import { type Backend, BackendError, probeBackend } from "./backend.js";
import { readBinding, saveBinding } from "./backend-config.js";
import { discoverBackends, uniqueBackend } from "./discovery.js";

export interface BackendOptions { server?: string; local?: boolean; serverId?: string; stateless?: boolean }
export async function resolveBackend(options: BackendOptions = {}): Promise<Backend> {
  if (options.server && options.local) throw new BackendError("invalid_backend_options", "--server and --local are mutually exclusive");
  const probe = (address: string, expectedId?: string) => probeBackend(address, {
    expectedId: options.serverId ?? expectedId, allowLegacy: !options.stateless,
    persistDiagnostics: !options.stateless,
  });
  const checkIdentity = (backend: Backend) => {
    if (options.serverId && backend.serverId !== options.serverId)
      throw new BackendError("backend_identity_mismatch", "selected backend does not match --server-id");
    return backend;
  };
  if (options.server) return probe(options.server);
  if (options.local) return checkIdentity(uniqueBackend(await discoverBackends(true, { persistDiagnostics: !options.stateless })));
  if (process.env.GPT_RELAY_URL) return probe(process.env.GPT_RELAY_URL);
  const binding = readBinding();
  if (binding) return probe(checkIdentity(binding).baseUrl, binding.serverId);
  if (options.stateless) throw new BackendError("backend_not_configured",
    "stateless mode requires --server, --local, GPT_RELAY_URL or an existing binding; automatic binding is disabled");

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
    if (legacy && error instanceof BackendError && error.code === "discovery_unavailable") return checkIdentity(legacy);
    throw error;
  }
  if (legacy) discovered.push(legacy);
  const selected = uniqueBackend(discovered);
  checkIdentity(selected);
  if (selected.legacy) return selected;
  const saved = await saveBinding(selected, true);
  return probe(checkIdentity(saved).baseUrl, saved.serverId);
}
