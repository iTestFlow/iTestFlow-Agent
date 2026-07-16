import "server-only";

const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const BASE_RETRY_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 3000;
const MAX_RETRY_AFTER_MS = 30000;

export async function fetchWithTransientRetry(
  url: string,
  init: RequestInit,
  retryAttempts: number,
) {
  let retriesUsed = 0;

  while (true) {
    init.signal?.throwIfAborted();
    try {
      const response = await fetch(url, init);
      if (retriesUsed >= retryAttempts || !TRANSIENT_STATUS_CODES.has(response.status)) {
        return response;
      }

      await response.body?.cancel();
      await delay(retryDelayMs(response, retriesUsed), init.signal);
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      if (retriesUsed >= retryAttempts) throw error;
      await delay(exponentialDelayMs(retriesUsed), init.signal);
    }

    retriesUsed += 1;
  }
}

function retryDelayMs(response: Response, retryIndex: number) {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  return retryAfterMs ?? exponentialDelayMs(retryIndex);
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;

  const seconds = Number(value);
  const delayMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();

  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_RETRY_AFTER_MS) {
    return null;
  }

  return delayMs;
}

function exponentialDelayMs(retryIndex: number) {
  return Math.min(BASE_RETRY_DELAY_MS * (2 ** retryIndex), MAX_RETRY_DELAY_MS);
}

function delay(durationMs: number, signal?: AbortSignal | null) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Request aborted."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
