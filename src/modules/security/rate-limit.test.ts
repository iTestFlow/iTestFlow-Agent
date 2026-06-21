import { beforeEach, describe, expect, it } from "vitest";

import { checkRateLimit, resetRateLimitsForTests } from "@/modules/security/rate-limit";

describe("rate limiter", () => {
  beforeEach(() => resetRateLimitsForTests());

  it("allows up to the limit, then blocks with a retry hint", () => {
    const key = "login:1.2.3.4";
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);

    const blocked = checkRateLimit(key, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps separate buckets per key", () => {
    expect(checkRateLimit("a", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("a", 1, 60_000).allowed).toBe(false);
    expect(checkRateLimit("b", 1, 60_000).allowed).toBe(true);
  });

  it("resets after the window elapses", () => {
    expect(checkRateLimit("c", 1, 1).allowed).toBe(true);
    expect(checkRateLimit("c", 1, 1).allowed).toBe(false);
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin past the 1ms window */
    }
    expect(checkRateLimit("c", 1, 1).allowed).toBe(true);
  });
});
