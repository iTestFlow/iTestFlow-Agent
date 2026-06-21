import "server-only";

/**
 * In-memory fixed-window rate limiter for sensitive endpoints (login, credential
 * validation). It throttles brute-force / abuse on a single hosted instance.
 *
 * Per-process: in a multi-replica deployment each instance limits independently;
 * a shared store (e.g. Redis) would be needed for global limits — noted as a
 * future enhancement, acceptable for the first private hosted release.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Best-effort client IP from proxy headers; falls back to a constant bucket. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test-only: clear all buckets. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}
