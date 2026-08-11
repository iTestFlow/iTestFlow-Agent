import { describe, expect, it } from "vitest";

import { AgentDecisionSchema, NATURAL_PLAN_SCHEMA_VERSION, NaturalPlanSchema } from "./action-schema";
import { collectNaturalPlanSecretReferences, validateNaturalPlan } from "./natural-plan";

describe("NaturalPlanSchema", () => {
  it("accepts instruction + expected result steps and applies defaults", () => {
    const parsed = NaturalPlanSchema.parse({
      schemaVersion: NATURAL_PLAN_SCHEMA_VERSION,
      steps: [{ instruction: "Open the catalog page" }],
    });
    expect(parsed.steps[0].expectedResult).toBe("");
  });

  it("rejects empty instructions, wrong versions, and oversized plans", () => {
    expect(
      NaturalPlanSchema.safeParse({ schemaVersion: NATURAL_PLAN_SCHEMA_VERSION, steps: [{ instruction: " " }] }).success,
    ).toBe(false);
    expect(NaturalPlanSchema.safeParse({ schemaVersion: "v1", steps: [{ instruction: "x" }] }).success).toBe(false);
    const steps = Array.from({ length: 101 }, () => ({ instruction: "x" }));
    expect(NaturalPlanSchema.safeParse({ schemaVersion: NATURAL_PLAN_SCHEMA_VERSION, steps }).success).toBe(false);
  });
});

describe("AgentDecisionSchema", () => {
  it("is flat and tolerant — cross-field rules live in agent-decision.ts", () => {
    expect(AgentDecisionSchema.safeParse({ decision: "act", actionType: "click", ref: "e5" }).success).toBe(true);
    expect(AgentDecisionSchema.safeParse({ decision: "nonsense" }).success).toBe(false);
  });
});

describe("validateNaturalPlan", () => {
  const context = { availableSecretNames: ["PASSWORD"] };

  it("accepts a plan and surfaces unknown secrets as warnings only", () => {
    const result = validateNaturalPlan(
      {
        schemaVersion: NATURAL_PLAN_SCHEMA_VERSION,
        steps: [
          { instruction: "Log in with {{secret:PASSWORD}}", expectedResult: "Dashboard opens" },
          { instruction: "Use {{secret:OTP}} to confirm", expectedResult: "" },
        ],
      },
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toEqual([
        expect.objectContaining({ severity: "warning", code: "unknown_secret", stepIndex: 1 }),
      ]);
    }
  });

  it("rejects structurally invalid plans with per-issue findings", () => {
    const result = validateNaturalPlan({ schemaVersion: NATURAL_PLAN_SCHEMA_VERSION, steps: [] }, context);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe("invalid_plan");
  });

  it("rejects explicit or mixed layers that the frozen environment cannot execute", () => {
    const result = validateNaturalPlan({
      schemaVersion: NATURAL_PLAN_SCHEMA_VERSION,
      steps: [
        { instruction: "Read the API", expectedResult: "OK", layerHint: "api" },
        { instruction: "Compare layers", expectedResult: "Same", layerHint: "mixed" },
      ],
    }, {
      availableSecretNames: [],
      availableLayers: ["ui"],
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "error", code: "invalid_plan", stepIndex: 0 }),
      expect.objectContaining({ severity: "error", code: "invalid_plan", stepIndex: 1 }),
    ]);
  });
});

describe("collectNaturalPlanSecretReferences", () => {
  it("collects distinct names from instructions and expected results", () => {
    const plan = NaturalPlanSchema.parse({
      schemaVersion: NATURAL_PLAN_SCHEMA_VERSION,
      steps: [
        { instruction: "Enter {{secret:USER}} and {{secret:PASSWORD}}", expectedResult: "" },
        { instruction: "Re-enter {{secret:PASSWORD}}", expectedResult: "shows {{secret:USER}}" },
      ],
    });
    expect(collectNaturalPlanSecretReferences(plan)).toEqual(["USER", "PASSWORD"]);
  });
});
