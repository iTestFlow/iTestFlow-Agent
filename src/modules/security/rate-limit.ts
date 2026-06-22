import "server-only";

import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

/**
 * Fixed-window rate limiter for sensitive endpoints (login, credential validation).
 * It throttles brute-force / abuse.
 *
 * Two backends, chosen by resolveBackend() (read per call so it is testable):
 *  - "postgres": a shared `rate_limits` row per key, so N web replicas enforce ONE
 *    global limit. This is the DEFAULT in production (NODE_ENV==="production"),
 *    because the hosted target runs multiple web replicas and a per-process Map
 *    would let each replica grant the full quota independently.
 *  - "memory": per-process Map — correct for a single replica / dev, zero infra.
 *    This is the default outside production.
 *  - RATE_LIMIT_BACKEND ("postgres" | "memory") overrides the default explicitly.
 * The Postgres path mirrors the in-memory first-hit-window semantics exactly.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

function resolveBackend(): "postgres" | "memory" {
  const explicit = process.env.RATE_LIMIT_BACKEND;
  if (explicit === "postgres" || explicit === "memory") return explicit;
  // Hosted (production) runs multiple replicas → a shared counter is required for
  // the limit to mean anything. Dev/test default to the zero-infra memory backend.
  return process.env.NODE_ENV === "production" ? "postgres" : "memory";
}

export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (resolveBackend() === "postgres") {
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

// Opportunistic GC of expired rows. The table is keyed by key (a row per distinct
// client IP), so it is bounded by distinct keys, not requests — but a public login
// endpoint accumulates IPs forever, so prune expired windows periodically rather
// than on every call (which would double the write load).
let postgresChecksSinceCleanup = 0;
const CLEANUP_EVERY = 200;

async function maybeCleanupRateLimits(now: number): Promise<void> {
  postgresChecksSinceCleanup += 1;
  if (postgresChecksSinceCleanup < CLEANUP_EVERY) return;
  postgresChecksSinceCleanup = 0;
  try {
    await sqlRun(`DELETE FROM rate_limits WHERE reset_at_ms < @now::bigint`, { now });
  } catch {
    /* best-effort GC — never affects the limit decision */
  }
}

/** Delete every expired window. Exposed so a worker/cron can sweep proactively. */
export async function cleanupExpiredRateLimits(): Promise<number> {
  return sqlRun(`DELETE FROM rate_limits WHERE reset_at_ms < @now::bigint`, { now: Date.now() });
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
    void maybeCleanupRateLimits(now);
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

/**
 * Client IP for rate-limit keying, resilient to `X-Forwarded-For` spoofing.
 *
 * XFF is `client, proxy1, proxy2, …` where each hop *appends* on the right, so the
 * leftmost entry is fully attacker-controlled. We therefore count from the RIGHT:
 * the rightmost entry is the address our nearest trusted proxy observed. With
 * `RATE_LIMIT_TRUSTED_PROXY_HOPS = N` (number of reverse proxies/load balancers in
 * front of the app), the real client is the (N+1)th from the right. Default 0 =
 * take the rightmost entry (least spoofable). A client prepending fake IPs cannot
 * shift this index, so it cannot dodge its bucket. Set N to your proxy depth so the
 * key tracks the true client rather than your load balancer.
 */
export function clientIp(request: Request): string {
  const hops = Math.max(0, Math.trunc(Number(process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS ?? "0")) || 0);
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) {
      const index = Math.max(0, parts.length - 1 - hops);
      const ip = parts[index];
      if (ip) return ip;
    }
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test-only: clear the in-memory buckets. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}
