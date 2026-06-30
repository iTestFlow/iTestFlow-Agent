import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, resetRateLimitsForTests } from "./rate-limit";

describe("in-memory rate limiter", () => {
  beforeEach(() => resetRateLimitsForTests());

  it("isolates keys and blocks after the configured count", async () => {
    expect((await checkRateLimit("a", 1, 60_000)).allowed).toBe(true);
    expect((await checkRateLimit("a", 1, 60_000)).allowed).toBe(false);
    expect((await checkRateLimit("b", 1, 60_000)).allowed).toBe(true);
  });

  it("starts a fresh bucket after the window", async () => {
    vi.useFakeTimers();
    expect((await checkRateLimit("window", 1, 100)).allowed).toBe(true);
    expect((await checkRateLimit("window", 1, 100)).allowed).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    expect((await checkRateLimit("window", 1, 100)).allowed).toBe(true);
  });
});
