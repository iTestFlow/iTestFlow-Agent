import { describe, expect, it } from "vitest";

import { JobDeferredError, JobRetryError, normalizeJobRunAfter } from "./job-scheduling";

describe("job scheduling signals", () => {
  it("normalizes valid deadlines without carrying upstream exception details", () => {
    const retry = new JobRetryError("Retry the operation.", "integration_rate_limited", "2030-01-01T02:01:00+02:00");
    expect(retry).toBeInstanceOf(Error);
    expect(retry).toMatchObject({ message: "Retry the operation.", code: "integration_rate_limited", retryNotBefore: "2030-01-01T00:01:00.000Z" });
    expect(new JobDeferredError("2030-01-01T02:01:00+02:00")).toMatchObject({ runAfter: "2030-01-01T00:01:00.000Z" });
  });

  it.each(["", "invalid", "2030-99-01", "Infinity"])("rejects invalid deadline %j", (value) => {
    expect(() => normalizeJobRunAfter(value)).toThrow("The job scheduling deadline is invalid.");
    expect(() => new JobDeferredError(value)).toThrow(RangeError);
    expect(() => new JobRetryError("retry", "integration_unknown", value)).toThrow(RangeError);
  });
});
