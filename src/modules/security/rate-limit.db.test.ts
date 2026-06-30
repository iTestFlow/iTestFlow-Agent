import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// DB-backed integration coverage for the shared/global limiter. Requires migrated PostgreSQL via
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
    // The Postgres limiter derives now/resetAt purely from Date.now() in JS (the SQL
    // only compares the integer bind params it is handed), so we drive the window with
    // a faked clock instead of a real sleep — instant and deterministic, no flake. We
    // fake ONLY Date so the pg driver's own socket timers keep using the real clock and
    // the awaited query still resolves over the real connection.
    const key = `test:reset:${Date.now()}`; // unique key from the real clock, before faking
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2026-06-30T12:00:00.000Z").getTime();
      vi.setSystemTime(t0);
      expect((await checkRateLimit(key, 1, 150)).allowed).toBe(true);
      expect((await checkRateLimit(key, 1, 150)).allowed).toBe(false);
      // Jump just past the 150ms window — the stored reset_at_ms (t0+150) is now in the past.
      vi.setSystemTime(t0 + 151);
      expect((await checkRateLimit(key, 1, 150)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
