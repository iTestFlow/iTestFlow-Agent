import "server-only";

import { z } from "zod";

/**
 * Input normalization shared by the Azure DevOps publish routes. The client
 * keeps its own copy of these helpers in test-intelligence-shared.tsx by
 * design — this module is the server-side source of truth for what the
 * publish APIs accept.
 */

/**
 * Accepts a raw Azure Test Plan/Suite reference — a bare numeric ID, an Azure
 * DevOps URL query form (?planId=45 / &suiteId=7), or a REST-style path form
 * (/plans/123/ or /suites/123/) — and normalizes it to the numeric ID string.
 */
export function azureIdSchema(kind: "plan" | "suite") {
  return z.string().min(1).transform((value, ctx) => {
    const id = extractAzureId(value, kind);
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Enter a valid Azure Test ${kind === "plan" ? "Plan" : "Suite"} ID or URL.`,
      });
      return z.NEVER;
    }

    return id;
  });
}

export function extractAzureId(value: string, kind: "plan" | "suite") {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const queryPattern = kind === "plan" ? /[?&]planId=(\d+)/i : /[?&]suiteId=(\d+)/i;
  const pathPattern = kind === "plan" ? /\/plans\/(\d+)(?:\/|$|\?)/i : /\/suites\/(\d+)(?:\/|$|\?)/i;
  return trimmed.match(queryPattern)?.[1] ?? trimmed.match(pathPattern)?.[1];
}

/**
 * Maps label ("critical".."low") and string-digit forms onto the Azure 1-4
 * priority scale, defaulting empty values to 2. Unrecognized values pass
 * through unchanged so the downstream schema rejects them.
 */
export function normalizeTestCasePriority(value: unknown) {
  if (value === 1 || value === "1" || value === "critical") return 1;
  if (value === 2 || value === "2" || value === "high") return 2;
  if (value === 3 || value === "3" || value === "medium") return 3;
  if (value === 4 || value === "4" || value === "low") return 4;
  if (value === undefined || value === null || value === "") return 2;
  return value;
}
