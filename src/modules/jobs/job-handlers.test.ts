import { describe, expect, it, vi } from "vitest";

import {
  getJobHandler,
  registerJobHandler,
  registeredJobTypes,
} from "./job-handlers";

describe("job handler registry", () => {
  it("registers, returns, and replaces handlers by job type", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    registerJobHandler("test.job", first);
    expect(getJobHandler("test.job")).toBe(first);
    registerJobHandler("test.job", second);
    expect(getJobHandler("test.job")).toBe(second);
    expect(registeredJobTypes()).toContain("test.job");
    expect(getJobHandler("missing")).toBeUndefined();
  });
});
