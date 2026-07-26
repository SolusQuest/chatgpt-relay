// server/util.ts
// Small helpers for session ID sanitization and input validation.
export function isValidSessionId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 128;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function asPositiveInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}
