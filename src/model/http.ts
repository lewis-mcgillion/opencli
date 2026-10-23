export class ApiError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`API ${status}: ${body}`);
  }
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 6;
const MAX_GENERATED_BACKOFF_MS = 60_000;

function isConnectionError(e: any): boolean {
  const text = `${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.code ?? ""}`;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|Unable to connect|ConnectionRefused|ConnectionClosed/i.test(text);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });
}

function parseRetryAfter(headers: Headers): number | null {
  const msHeader = headers.get("retry-after-ms") ?? headers.get("x-ms-retry-after-ms");
  if (msHeader) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export function retryDelayMs(attempt: number, status?: number, headers?: Headers): number {
  const fromHeaders = headers ? parseRetryAfter(headers) : null;
  if (fromHeaders !== null) return fromHeaders;
  const base = status === 429 ? 2000 : 1000;
  return Math.min(base * 2 ** (attempt - 1), MAX_GENERATED_BACKOFF_MS);
}

export interface PostOptions {
  headers: Record<string, string>;
  signal?: AbortSignal;
  onRetry?: (attempt: number, reason: string) => void;
}

export async function postJsonWithRetry(url: string, body: unknown, opts: PostOptions): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...opts.headers },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (res.ok) return res;
      const text = await res.text();
      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        const delay = retryDelayMs(attempt, res.status, res.headers);
        opts.onRetry?.(attempt + 1, `HTTP ${res.status}, backing off ${delay}ms`);
        await sleep(delay, opts.signal);
        continue;
      }
      throw new ApiError(res.status, text);
    } catch (e: any) {
      if (e.name === "AbortError" || e instanceof ApiError) throw e;
      if (attempt < MAX_ATTEMPTS && isConnectionError(e)) {
        const delay = retryDelayMs(attempt);
        opts.onRetry?.(attempt + 1, `connection failed, backing off ${delay}ms`);
        await sleep(delay, opts.signal);
        continue;
      }
      throw e;
    }
  }
}
