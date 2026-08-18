import type { ExecutionOutcome } from "./playwright-agent";

/**
 * Screenshot capture policy for a test execution run.
 *
 * - "every-step": capture after every executed step.
 * - "validation-points" (default): capture after steps that carry an expected
 *   result, plus failure evidence whenever a step does not pass.
 * - "failures-only": capture only when a step does not pass.
 * - "none": never capture; agent-initiated screenshots are not persisted either.
 */
export const SCREENSHOT_POLICIES = ["every-step", "validation-points", "failures-only", "none"] as const;

export type ScreenshotPolicy = (typeof SCREENSHOT_POLICIES)[number];

export const DEFAULT_SCREENSHOT_POLICY: ScreenshotPolicy = "validation-points";

export const SCREENSHOT_POLICY_LABELS: Record<ScreenshotPolicy, string> = {
  "every-step": "Every step",
  "validation-points": "Validation points only (default)",
  "failures-only": "Failures only",
  none: "No screenshots",
};

export function isScreenshotPolicy(value: unknown): value is ScreenshotPolicy {
  return typeof value === "string" && (SCREENSHOT_POLICIES as readonly string[]).includes(value);
}

/**
 * Deterministic capture decision for one finished step. Cancelled steps never
 * capture (the browser context is being torn down and the user asked to stop).
 */
export function shouldCaptureScreenshot(
  policy: ScreenshotPolicy,
  step: { hasExpectedResult: boolean; outcome: ExecutionOutcome },
): boolean {
  if (step.outcome === "cancelled" || policy === "none") return false;
  if (policy === "every-step") return true;
  const failed = step.outcome !== "passed";
  if (policy === "failures-only") return failed;
  return failed || step.hasExpectedResult;
}
