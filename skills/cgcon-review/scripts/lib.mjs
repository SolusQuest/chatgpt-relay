// skills/cgcon-review/scripts/lib.mjs
// 共享工具：BASE URL、pending 目录、简单 HTTP。仅依赖 Node built-ins。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BASE = process.env.CGCON_URL ?? `http://127.0.0.1:${process.env.CGCON_PORT ?? 8766}`;
export const PENDING_DIR = process.env.CGCON_PENDING_DIR ??
  path.join(os.homedir(), ".cgcon-v3", "pending");

const TERMINAL = new Set(["done", "failed", "cancelled", "expired"]);

export function isTerminal(status) { return TERMINAL.has(status); }

export async function httpJson(method, urlPath, body, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65_000);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const txt = await res.text();
    const json = txt ? JSON.parse(txt) : null;
    if (!res.ok) {
      const err = new Error(json?.message ?? json?.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      err.code = json?.error ?? null;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export function ensurePendingDir() { fs.mkdirSync(PENDING_DIR, { recursive: true }); }
export function pendingFile(taskId) { return path.join(PENDING_DIR, `${taskId}.json`); }
export function writePending(rec) {
  ensurePendingDir();
  fs.writeFileSync(pendingFile(rec.taskId), JSON.stringify(rec));
}
export function clearPending(taskId) {
  try { fs.unlinkSync(pendingFile(taskId)); } catch { /* ignore */ }
}
export function listPending() {
  if (!fs.existsSync(PENDING_DIR)) return [];
  return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith(".json")).map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), "utf8")); }
    catch { return null; }
  }).filter(Boolean);
}