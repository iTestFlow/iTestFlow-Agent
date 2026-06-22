import "server-only";

import { nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";

/**
 * Fixed-window rate limiter for sensitive endpoints (login, credential validation).
 * It throttles brute-force / abuse.
 *
 * Two backends, chosen by RATE_LIMIT_BACKEND (read per call so it is testable):
 *  - default ("memory"): per-process Map — correct for a single replica, zero infra.
 *  - "postgres": a shared `rate_limits` row per key, so N web replicas enforce ONE
 *    global limit. Required when running multiple web replicas. The Postgres path
 *    mirrors the in-memory first-hit-window semantics exactly.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (process.env.RATE_LIMIT_BACKEND === "postgres") {
    return checkRateLimitPostgres(key, limit, windowMs);
  }
  return checkRateLimitMemory(key, limit, windowMs);
}

function checkRateLimitMemory(key: string, limit: number, windowMs: number): RateLimitResult {
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

/**
 * Shared-counter limiter. One atomic upsert per check: a new or expired window
 * resets count to 1, an active window increments. allowed = count <= limit.
 * Fails OPEN on a DB error — a limiter hiccup must never block logins, and an
 * attacker cannot reach this without the same database login itself depends on.
 */
async function checkRateLimitPostgres(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();
  const resetAt = now + windowMs;
  try {
    const row = await sqlGet<{ count: number; reset_at_ms: string | number }>(
      `INSERT INTO rate_limits (key, reset_at_ms, count, updated_at)
       VALUES (@key, @resetAt::bigint, 1, @updatedAt)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at_ms > @now::bigint THEN rate_limits.count + 1 ELSE 1 END,
         reset_at_ms = CASE WHEN rate_limits.reset_at_ms > @now::bigint THEN rate_limits.reset_at_ms ELSE @resetAt::bigint END,
         updated_at = @updatedAt
       RETURNING count, reset_at_ms`,
      { key, now, resetAt, updatedAt: nowIso() },
    );
    if (!row) return { allowed: true, retryAfterSeconds: 0 };

    if (row.count > limit) {
      const resetMs = Number(row.reset_at_ms);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetMs - now) / 1000)) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    console.warn("[rate-limit] postgres backend unavailable; allowing request.", error);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Best-effort client IP from proxy headers; falls back to a constant bucket. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test-only: clear the in-memory buckets. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}
