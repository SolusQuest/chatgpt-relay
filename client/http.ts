// client/http.ts
// Shared HTTP helper with AbortController timeouts and JSON handling.
export interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  serverId?: string;
}

async function request<T>(
  method: string,
  url: string,
  body: unknown,
  opts: HttpOptions,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 65_000);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(`${opts.baseUrl}${url}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.serverId ? { "X-Gpt-Relay-Server-Id": opts.serverId } : {}) },
      redirect: "error",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (opts.serverId && res.headers.get("X-Gpt-Relay-Server-Id") !== opts.serverId) {
      throw new HttpError("backend identity changed", 409, "backend_identity_mismatch");
    }
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); }
      catch (error) { if (res.ok) throw error; }
    }
    if (!res.ok) {
      const err = json as { error?: string; message?: string; errorInfo?: unknown } | null;
      throw new HttpError(
        err?.message ?? err?.error ?? `HTTP ${res.status}`,
        res.status,
        err?.error ?? null,
        err?.errorInfo ?? null,
      );
    }
    return json as T;
  } finally {
    clearTimeout(timeout);
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly errorInfo: unknown = null,
  ) {
    super(message);
  }
}

export const http = {
  put: <T>(url: string, body: unknown, opts: HttpOptions) => request<T>("PUT", url, body, opts),
  get: <T>(url: string, opts: HttpOptions) => request<T>("GET", url, undefined, opts),
  post: <T>(url: string, body: unknown, opts: HttpOptions) =>
    request<T>("POST", url, body, opts),
  del: <T>(url: string, opts: HttpOptions) => request<T>("DELETE", url, undefined, opts),
};
