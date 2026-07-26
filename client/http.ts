// client/http.ts
// Shared HTTP helper with AbortController timeouts and JSON handling.
export interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
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
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = json as { error?: string; message?: string } | null;
      throw new HttpError(
        err?.message ?? err?.error ?? `HTTP ${res.status}`,
        res.status,
        err?.error ?? null,
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
  ) {
    super(message);
  }
}

export const http = {
  get: <T>(url: string, opts: HttpOptions) => request<T>("GET", url, undefined, opts),
  post: <T>(url: string, body: unknown, opts: HttpOptions) =>
    request<T>("POST", url, body, opts),
  del: <T>(url: string, opts: HttpOptions) => request<T>("DELETE", url, undefined, opts),
};
