import { describe, expect, it } from "vitest";
import type { ExecutionOutcome } from "./playwright-agent";
import {
  DEFAULT_SCREENSHOT_POLICY,
  SCREENSHOT_POLICIES,
  isScreenshotPolicy,
  shouldCaptureScreenshot,
  type ScreenshotPolicy,
} from "./screenshot-policy";

const FAILURE_OUTCOMES: ExecutionOutcome[] = ["failed", "blocked", "timeout", "error"];

describe("shouldCaptureScreenshot", () => {
  it("never captures for cancelled steps under any policy", () => {
    for (const policy of SCREENSHOT_POLICIES) {
      expect(shouldCaptureScreenshot(policy, { hasExpectedResult: true, outcome: "cancelled" })).toBe(false);
      expect(shouldCaptureScreenshot(policy, { hasExpectedResult: false, outcome: "cancelled" })).toBe(false);
    }
  });

  it("never captures under the none policy", () => {
    for (const outcome of ["passed", ...FAILURE_OUTCOMES] as ExecutionOutcome[]) {
      expect(shouldCaptureScreenshot("none", { hasExpectedResult: true, outcome })).toBe(false);
      expect(shouldCaptureScreenshot("none", { hasExpectedResult: false, outcome })).toBe(false);
    }
  });

  it("captures every non-cancelled step under every-step", () => {
    for (const outcome of ["passed", ...FAILURE_OUTCOMES] as ExecutionOutcome[]) {
      expect(shouldCaptureScreenshot("every-step", { hasExpectedResult: false, outcome })).toBe(true);
    }
  });

  it("captures validation points and failure evidence under validation-points", () => {
    expect(shouldCaptureScreenshot("validation-points", { hasExpectedResult: true, outcome: "passed" })).toBe(true);
    expect(shouldCaptureScreenshot("validation-points", { hasExpectedResult: false, outcome: "passed" })).toBe(false);
    for (const outcome of FAILURE_OUTCOMES) {
      expect(shouldCaptureScreenshot("validation-points", { hasExpectedResult: false, outcome })).toBe(true);
      expect(shouldCaptureScreenshot("validation-points", { hasExpectedResult: true, outcome })).toBe(true);
    }
  });

  it("captures only failures under failures-only", () => {
    expect(shouldCaptureScreenshot("failures-only", { hasExpectedResult: true, outcome: "passed" })).toBe(false);
    for (const outcome of FAILURE_OUTCOMES) {
      expect(shouldCaptureScreenshot("failures-only", { hasExpectedResult: true, outcome })).toBe(true);
    }
  });
});

describe("isScreenshotPolicy", () => {
  it("accepts every declared policy and the default", () => {
    for (const policy of SCREENSHOT_POLICIES) expect(isScreenshotPolicy(policy)).toBe(true);
    expect(isScreenshotPolicy(DEFAULT_SCREENSHOT_POLICY)).toBe(true);
  });

  it("rejects unknown values", () => {
    for (const value of ["always", "", null, undefined, 4, "EVERY-STEP"]) {
      expect(isScreenshotPolicy(value as ScreenshotPolicy)).toBe(false);
    }
  });
});
