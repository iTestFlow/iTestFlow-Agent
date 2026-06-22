import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { checkRateLimit, resetRateLimitsForTests } from "@/modules/security/rate-limit";

describe("rate limiter (in-memory)", () => {
  beforeEach(() => resetRateLimitsForTests());

  it("allows up to the limit, then blocks with a retry hint", async () => {
    const key = "login:1.2.3.4";
    expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 3, 60_000)).allowed).toBe(true);

    const blocked = await checkRateLimit(key, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps separate buckets per key", async () => {
    expect((await checkRateLimit("a", 1, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit("a", 1, 60_000)).allowed).toBe(false);
    expect((await checkRateLimit("b", 1, 60_000)).allowed).toBe(true);
  });

  it("resets after the window elapses", async () => {
    // A real (not sub-millisecond) window: the first two calls land in the same
    // window deterministically, then we wait past it to see the counter reset.
    expect((await checkRateLimit("c", 1, 120)).allowed).toBe(true);
    expect((await checkRateLimit("c", 1, 120)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect((await checkRateLimit("c", 1, 120)).allowed).toBe(true);
  });
});

// DB-backed (ADR-9): the shared/global limiter. Requires migrated PostgreSQL via
// DATABASE_URL; skipped otherwise.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("rate limiter (postgres, shared)", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_BACKEND = "postgres";
  });
  afterEach(async () => {
    delete process.env.RATE_LIMIT_BACKEND;
    await sqlRun(`DELETE FROM rate_limits WHERE key LIKE 'test:%'`, {});
  });
  afterAll(async () => {
    await resetDatabaseForTests();
  });

  it("enforces a shared limit and blocks with a retry hint", async () => {
    const key = `test:enforce:${Math.floor(Date.now())}`;
    expect((await checkRateLimit(key, 2, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(key, 2, 60_000)).allowed).toBe(true);
    const blocked = await checkRateLimit(key, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps separate counters per key", async () => {
    const a = `test:a:${Math.floor(Date.now())}`;
    const b = `test:b:${Math.floor(Date.now())}`;
    expect((await checkRateLimit(a, 1, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit(a, 1, 60_000)).allowed).toBe(false);
    expect((await checkRateLimit(b, 1, 60_000)).allowed).toBe(true);
  });

  it("resets once the window has elapsed", async () => {
    // A real window (not 1ms) — the DB round-trip between calls would otherwise
    // outlast a sub-millisecond window and reset before the second call.
    const key = `test:reset:${Math.floor(Date.now())}`;
    expect((await checkRateLimit(key, 1, 150)).allowed).toBe(true);
    expect((await checkRateLimit(key, 1, 150)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect((await checkRateLimit(key, 1, 150)).allowed).toBe(true);
  });
});
