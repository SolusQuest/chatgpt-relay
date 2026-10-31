import { BackendError, RELAY_PRODUCT, BACKEND_API_VERSION, type Backend, type ServerInfo } from "../shared/backend.js";
import { HttpError } from "./http.js";
import { createProbe, probeGet } from "./backend-probe.js";
export { BackendError } from "../shared/backend.js";
export type { Backend } from "../shared/backend.js";

export function normalizeUrl(address: string): string {
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(address);
  let url: URL;
  try { url = new URL(explicitScheme ? address : `http://${address}`); }
  catch { throw new BackendError("invalid_backend", "provide a backend URL or host:port"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new BackendError("invalid_backend", "backend must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  if (!explicitScheme && !url.port) url.port = "8765";
  return url.origin;
}

export async function probeBackend(address: string, options: { expectedId?: string; allowLegacy?: boolean; timeoutMs?: number; maxAttempts?: number; persistDiagnostics?: boolean } = {}): Promise<Backend> {
  const baseUrl = normalizeUrl(address);
  const timeoutMs = options.timeoutMs ?? 1500;
  // Discovery and the opportunistic legacy check opt out to retain their short
  // scan budgets. Only these read-only identity/compatibility probes retry.
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(options.maxAttempts ?? 3) || 1));
  const probe = createProbe(baseUrl), started = performance.now();
  try {
    let info: ServerInfo;
    try { info = await probeGet<ServerInfo>(probe, "/v1/server", timeoutMs, maxAttempts, options.persistDiagnostics); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        if (options.allowLegacy && !options.expectedId) {
          try {
            const doctor = await probeGet<any>(probe, "/v1/doctor", timeoutMs, maxAttempts, options.persistDiagnostics);
            if (typeof doctor?.server?.version === "string" && doctor.server.controlProtocol === 1 &&
                Array.isArray(doctor.instances) && Array.isArray(doctor.checks)) {
              return { baseUrl, name: "Legacy Relay", version: doctor.server.version, legacy: true };
            }
          } catch { /* Require the established Relay protocol, not a generic health page. */ }
        }
        throw new BackendError("backend_incompatible", `backend at ${baseUrl} needs the server identity API; upgrade it before binding`);
      }
      const failure = new BackendError("backend_unreachable", `cannot reach Relay backend at ${baseUrl}`);
      failure.cause = error;
      throw failure;
    }
    if (info?.product !== RELAY_PRODUCT || info.apiVersion !== BACKEND_API_VERSION ||
        typeof info.serverId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(info.serverId) ||
        typeof info.name !== "string" || typeof info.version !== "string") {
      throw new BackendError("backend_incompatible", `incompatible Relay backend at ${baseUrl}`);
    }
    if (options.expectedId && info.serverId !== options.expectedId) {
      throw new BackendError("backend_identity_mismatch", `backend identity changed at ${baseUrl}; inspect it and bind explicitly`);
    }
    return { baseUrl, serverId: info.serverId, name: info.name, version: info.version };
  } catch (error) {
    if (error instanceof BackendError) error.probe = probe;
    throw error;
  } finally {
    probe.elapsedMs = Math.round(performance.now() - started);
  }
}
