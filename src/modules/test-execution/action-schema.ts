import { z } from "zod";

/**
 * Test Execution plan + runtime action vocabulary — Phase 1.5 (agentic).
 *
 * Plans are natural language: users (or imported Azure test cases) provide a
 * step INSTRUCTION and an EXPECTED RESULT per step. At run time an LLM agent
 * looks at the live page's accessibility snapshot and proposes ONE action per
 * iteration; the worker validates each proposal deterministically (action
 * allowlist, ref-must-exist-in-snapshot, origin policy, secret names) before
 * anything touches the browser. Secrets appear everywhere as {{secret:NAME}}
 * placeholders; values are substituted only in worker memory, post-validation.
 */

export const NATURAL_PLAN_SCHEMA_VERSION = "v2-natural" as const;
export const MAX_PLAN_STEPS = 100;
export const MAX_INSTRUCTION_LENGTH = 2_000;
export const MAX_EXPECTED_RESULT_LENGTH = 2_000;

export const TEST_EXECUTION_LAYER_HINTS = ["auto", "ui", "api", "db", "mixed"] as const;
export const LayerHintSchema = z.enum(TEST_EXECUTION_LAYER_HINTS);
export type LayerHint = z.infer<typeof LayerHintSchema>;

export const NaturalStepSchema = z.object({
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
  expectedResult: z.string().trim().max(MAX_EXPECTED_RESULT_LENGTH).default(""),
  /** Additive and defaulted so every previously frozen v2-natural plan remains readable. */
  layerHint: LayerHintSchema.default("auto"),
});
export type NaturalStep = z.infer<typeof NaturalStepSchema>;

export const NaturalPlanSchema = z.object({
  schemaVersion: z.literal(NATURAL_PLAN_SCHEMA_VERSION),
  steps: z.array(NaturalStepSchema).min(1).max(MAX_PLAN_STEPS),
});
export type NaturalPlan = z.infer<typeof NaturalPlanSchema>;

/* ------------------------------------------------------------------------ *
 * Runtime agent vocabulary
 * ------------------------------------------------------------------------ */

export const AGENT_ACTION_TYPES = [
  "navigate",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "hover",
  "pressKey",
  "waitForText",
  "screenshot",
] as const;
export type AgentActionType = (typeof AGENT_ACTION_TYPES)[number];

export const PRESS_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;

/** Actions that target an element and therefore require a snapshot ref. */
export const REF_REQUIRED_ACTIONS: ReadonlySet<AgentActionType> = new Set([
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "hover",
]);

/**
 * A validated, executable agent action. `ref` is an element reference taken
 * verbatim from the accessibility snapshot the model was shown (e.g. "e12").
 */
export type AgentAction =
  | { type: "navigate"; url: string }
  | { type: "click" | "check" | "uncheck" | "hover"; ref: string; elementDescription: string }
  | { type: "fill" | "select"; ref: string; elementDescription: string; value: string }
  | { type: "pressKey"; key: (typeof PRESS_KEYS)[number] }
  | { type: "waitForText"; text: string }
  | { type: "screenshot" };

/**
 * The per-iteration model output. Deliberately FLAT — one enum plus optional
 * scalar fields, no unions, no defaults — so the Anthropic native
 * structured-output path never hits the "compiled grammar is too large /
 * too many optional parameters" silent fallback that broke the old compile
 * schema. Cross-field consistency is enforced in code (agent-decision.ts).
 */
export const AgentDecisionSchema = z.object({
  decision: z.enum(["act", "step_passed", "step_failed", "blocked"]),
  actionType: z.string().optional(),
  /** Compact layer-specific payload; legacy scalar UI fields remain accepted. */
  argumentsJson: z.string().max(20_000).optional(),
  ref: z.string().optional(),
  elementDescription: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  key: z.string().optional(),
  waitText: z.string().optional(),
  actualResult: z.string().optional(),
  reason: z.string().optional(),
// UI arguments sit at the top level, so a model that puts API/DB arguments
// there too is copying the shape it was just shown. Keep those keys instead of
// stripping them silently, and let the action validator read them as a
// fallback. Deliberately passthrough rather than declaring each field: adding
// many optional typed properties to this flat schema is what previously tripped
// the provider's silent structured-output fallback.
}).passthrough();
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
