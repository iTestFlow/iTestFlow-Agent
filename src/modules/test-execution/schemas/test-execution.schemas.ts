import { z } from "zod";

import { NaturalPlanSchema } from "../action-schema";
import { SECRET_NAME_PATTERN } from "../secret-resolution";

/**
 * Request/response schemas for the Test Execution API routes. Secret VALUES
 * appear only in write requests (create/update); every read model exposes
 * masked previews exclusively. Plans are natural-language steps — the agent
 * chooses concrete browser actions at run time.
 */

export const SecretInputSchema = z.object({
  secretName: z.string().regex(SECRET_NAME_PATTERN, "Secret names are UPPER_SNAKE_CASE, max 64 chars."),
  title: z.string().trim().min(1).max(120),
  value: z.string().min(1).max(4_096),
});
export type SecretInput = z.infer<typeof SecretInputSchema>;

/**
 * Named test user (AgentEx-style handle model): steps reference the handle in
 * natural language ("Login as expired_user"). A user without its own password
 * secret falls back to the DEFAULT_PASSWORD secret when one is defined.
 */
export const TestUserSchema = z.object({
  handle: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "Handles are lower_snake_case, max 64 chars."),
  username: z.string().trim().min(1).max(200),
  passwordSecretName: z.string().regex(SECRET_NAME_PATTERN).nullable().default(null),
  notes: z.string().trim().max(300).default(""),
});
export type TestUserInput = z.infer<typeof TestUserSchema>;

export const EnvironmentConfigInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  initialUrl: z.string().trim().url().max(2_000),
  allowedOrigin: z.string().trim().url().max(500),
  viewportWidth: z.number().int().min(320).max(3840).default(1280),
  viewportHeight: z.number().int().min(320).max(3840).default(720),
  headless: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  navigationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  evidenceLevel: z.enum(["minimal", "on_failure", "all_steps"]).default("on_failure"),
  loginPlan: NaturalPlanSchema.nullable().default(null),
  /** session = reuse a captured, encrypted browser session when still valid. */
  loginMode: z.enum(["session", "fresh"]).default("session"),
  /** Authenticated-only landmark text; required for session reuse (never URL-based). */
  loggedInText: z.string().trim().max(200).default(""),
  /** Free-text guidance for the execution agent — context, never an override of the safety rules. */
  executionNotes: z.string().trim().max(2_000).default(""),
  users: z.array(TestUserSchema).max(30).default([]),
});
export type EnvironmentConfigInput = z.infer<typeof EnvironmentConfigInputSchema>;

export const EnvironmentCreateSchema = z.object({
  config: EnvironmentConfigInputSchema,
  secrets: z.array(SecretInputSchema).max(30).default([]),
});

export const EnvironmentUpdateSchema = z.object({
  config: EnvironmentConfigInputSchema.partial().optional(),
  /** Write-only upsert; values are never returned. */
  upsertSecrets: z.array(SecretInputSchema).max(30).default([]),
  removeSecretNames: z.array(z.string().regex(SECRET_NAME_PATTERN)).max(30).default([]),
});

/** One case selected or authored in the Test Scope step. */
export const RunCaseInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  sourceKind: z.enum(["azure_test_case", "manual"]),
  azureTestCaseId: z.string().trim().regex(/^\d+$/).nullable().default(null),
  plan: NaturalPlanSchema,
});
export type RunCaseInput = z.infer<typeof RunCaseInputSchema>;

export const RunEnvironmentSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("profile"), environmentProfileId: z.string().min(1) }),
  z.object({
    mode: z.literal("one_time"),
    config: EnvironmentConfigInputSchema.omit({ name: true }),
    secrets: z.array(SecretInputSchema).max(30).default([]),
  }),
]);

export const RunCreateSchema = z.object({
  environment: RunEnvironmentSelectionSchema,
  story: z
    .object({
      workItemId: z.string().trim().regex(/^\d+$/),
      title: z.string().trim().max(500).default(""),
    })
    .nullable()
    .default(null),
  cases: z.array(RunCaseInputSchema).min(1).max(50),
});
