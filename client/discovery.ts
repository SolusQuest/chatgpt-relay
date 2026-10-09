import os from "node:os";
import { isIP } from "node:net";
import type { Bonjour } from "bonjour-service";
import { createBonjour } from "../shared/mdns.js";
import { localRegistrations } from "../shared/local-registry.js";
import { DISCOVERY_TYPE, type Backend } from "../shared/backend.js";
import { BackendError, normalizeUrl, probeBackend } from "./backend.js";

export interface Candidate { baseUrl: string; serverId?: string }
export type DiscoveryClient = Pick<Bonjour, "find" | "destroy">;
const hostUrl = (host: string, port: number) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
export function isLocalAddress(host: string): boolean {
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127.")) return true;
  return Object.values(os.networkInterfaces()).flat().some(address => address?.address === host);
}

export async function browseNetwork(localOnly: boolean, timeoutMs: number,
  createClient: (onError: (error: unknown) => void) => DiscoveryClient = createBonjour): Promise<Candidate[]> {
  return new Promise((resolve, reject) => {
    const candidates: Candidate[] = [];
    let bonjour: DiscoveryClient | undefined, browser: ReturnType<Bonjour["find"]> | undefined;
    let finished = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      browser?.stop();
      bonjour?.destroy();
      if (error) reject(new BackendError("discovery_unavailable", "LAN discovery is unavailable; use bind <address>"));
      else resolve(candidates);
    };
    try {
      bonjour = createClient(finish);
      if (finished) { bonjour.destroy(); return; }
      browser = bonjour.find({ type: DISCOVERY_TYPE, protocol: "tcp" }, service => {
        if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return;
        const serverId = typeof service.txt?.serverId === "string" ? service.txt.serverId : undefined;
        for (const address of service.addresses ?? []) {
          if (!localOnly || isLocalAddress(address)) candidates.push({ baseUrl: hostUrl(address, service.port), serverId });
        }
      });
      timer = setTimeout(() => finish(), timeoutMs);
    } catch (error) { finish(error); }
  });
}

export async function verifyCandidates(candidates: Candidate[]): Promise<Backend[]> {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    try {
      const baseUrl = normalizeUrl(candidate.baseUrl);
      unique.set(`${baseUrl}#${candidate.serverId ?? ""}`, { ...candidate, baseUrl });
    } catch { /* Invalid announcement. */ }
  }
  const work = [...unique.values()].slice(0, 256), found = new Map<string, Backend>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(8, work.length) }, async () => {
    while (index < work.length) {
      const candidate = work[index++]!;
      try {
        const backend = await probeBackend(candidate.baseUrl, { expectedId: candidate.serverId, timeoutMs: 500 });
        const old = found.get(backend.serverId!);
        if (!old || backend.baseUrl.localeCompare(old.baseUrl) < 0) found.set(backend.serverId!, backend);
      } catch { /* Stale, unreachable and incompatible candidates are not selectable. */ }
    }
  }));
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.baseUrl.localeCompare(b.baseUrl));
}

export async function discoverBackends(localOnly = false): Promise<Backend[]> {
  const candidates: Candidate[] = localRegistrations().filter(record => {
    try { return isLocalAddress(new URL(record.baseUrl).hostname); } catch { return false; }
  });
  if (process.env.GPT_RELAY_DISCOVERY !== "0" && !localOnly) {
    const configured = Number(process.env.GPT_RELAY_DISCOVERY_TIMEOUT_MS ?? 2000);
    const window = Number.isFinite(configured) ? Math.max(100, Math.min(configured, 10000)) : 2000;
    try { candidates.push(...await browseNetwork(false, window)); }
    catch (error) {
      const local = await verifyCandidates(candidates);
      if (local.length) return local;
      throw error;
    }
  }
  return verifyCandidates(candidates);
}

export function uniqueBackend(backends: Backend[]): Backend {
  if (backends.length === 0) throw new BackendError("backend_not_found", "no compatible Relay server found; start one or use bind <address>");
  if (backends.length > 1) throw new BackendError("backend_ambiguous", "multiple Relay servers found; use bind <address> or --server <address>", backends);
  return backends[0]!;
}
