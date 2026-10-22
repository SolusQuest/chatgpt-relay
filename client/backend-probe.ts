import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { http, HttpError } from "./http.js";
import type { ProbeAttempt, ProbeDiagnostics } from "../shared/backend.js";

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

function describeError(error: unknown): NonNullable<ProbeAttempt["errors"]> {
  const errors: NonNullable<ProbeAttempt["errors"]> = [];
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length && errors.length < 8) {
    const value = pending.shift();
    if (seen.has(value)) continue;
    seen.add(value);
    if (!(value instanceof Error)) {
      errors.push({ name: "Error", message: String(value).slice(0, 500) });
      continue;
    }
    const detail = value as NodeJS.ErrnoException & { address?: string; port?: number };
    errors.push({ name: value.name, message: value.message.slice(0, 500), code: detail.code,
      status: value instanceof HttpError ? value.status : undefined,
      syscall: detail.syscall, address: detail.address, port: detail.port });
    if (value.cause !== undefined) pending.push(value.cause);
    if (value instanceof AggregateError) pending.push(...value.errors.slice(0, 8));
  }
  return errors;
}

// Diagnostics must never turn a successful probe into a failure. Keep one rotated
// file and omit response bodies, task text, headers and CLI arguments.
function recordAttempt(probe: ProbeDiagnostics, attempt: ProbeAttempt): void {
  probe.attempts.push(attempt);
  try {
    const dataDir = process.env.GPT_RELAY_DATA_DIR || path.join(os.homedir(), ".gpt-relay");
    const logDir = process.env.GPT_RELAY_LOG_DIR || path.join(dataDir, "logs");
    const file = path.join(logDir, "client-probes.jsonl");
    fs.mkdirSync(logDir, { recursive: true });
    try {
      if (fs.statSync(file).size >= 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* Missing file or concurrent rotation; still attempt the append. */ }
    fs.appendFileSync(file, JSON.stringify({ event: "backend_probe", probeId: probe.probeId,
      pid: process.pid, baseUrl: probe.baseUrl, ...attempt }) + "\n", { mode: 0o600 });
    probe.logFile = file;
  } catch { /* Read-only or full filesystem: diagnostics remain in the error. */ }
}

export function createProbe(baseUrl: string): ProbeDiagnostics {
  return { probeId: randomUUID(), baseUrl, elapsedMs: 0, attempts: [] };
}

export async function probeGet<T>(probe: ProbeDiagnostics, requestPath: string, timeoutMs: number,
  maxAttempts: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const timestamp = new Date().toISOString(), started = performance.now();
    let status: number | undefined;
    try {
      const result = await http.get<T>(requestPath, { baseUrl: probe.baseUrl, timeoutMs,
        onResponseStatus: value => { status = value; } });
      recordAttempt(probe, { timestamp, path: requestPath, attempt, timeoutMs,
        elapsedMs: Math.round(performance.now() - started), status, outcome: "success" });
      return result;
    } catch (error) {
      const errors = describeError(error);
      const retryable = error instanceof HttpError ? [408, 500, 502, 503, 504].includes(error.status) :
        errors.some(item => item.name === "AbortError" || item.name === "TimeoutError" ||
          item.code !== undefined && TRANSIENT_CODES.has(item.code));
      recordAttempt(probe, { timestamp, path: requestPath, attempt, timeoutMs,
        elapsedMs: Math.round(performance.now() - started), status, outcome: "failure", retryable, errors });
      if (!retryable || attempt >= maxAttempts) throw error;
    }
    await delay(200 * attempt);
  }
}
