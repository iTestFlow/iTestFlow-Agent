import { describe, expect, it } from "vitest";

import { isCredentialStale } from "./credential.service";

describe("isCredentialStale", () => {
  const now = "2026-06-22T00:00:00.000Z";

  it.each([null, undefined, "not-a-date"])(
    "treats %s as not stale",
    (value) => expect(isCredentialStale(value, now, 60)).toBe(false),
  );

  it("uses an inclusive day threshold", () => {
    expect(isCredentialStale("2026-04-23T00:00:00.000Z", now, 60)).toBe(false);
    expect(isCredentialStale("2026-04-22T23:59:59.999Z", now, 60)).toBe(true);
  });
});
