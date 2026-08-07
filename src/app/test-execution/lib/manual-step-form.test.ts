import { describe, expect, it } from "vitest";

import {
  azureStepsToNaturalPlan,
  buildNaturalPlan,
  describeNaturalStep,
  emptyNaturalStep,
  validateNaturalStep,
} from "./manual-step-form";

describe("validateNaturalStep", () => {
  it("requires an instruction and enforces length caps", () => {
    expect(validateNaturalStep(emptyNaturalStep())).toMatch(/describe/i);
    expect(validateNaturalStep({ instruction: "Open the cart", expectedResult: "" })).toBeNull();
    expect(validateNaturalStep({ instruction: "x".repeat(2001), expectedResult: "" })).toMatch(/under/i);
    expect(validateNaturalStep({ instruction: "ok", expectedResult: "y".repeat(2001) })).toMatch(/under/i);
  });
});

describe("describeNaturalStep", () => {
  it("returns the instruction, truncated for lists", () => {
    expect(describeNaturalStep({ instruction: "Open the cart", expectedResult: "" })).toBe("Open the cart");
    expect(describeNaturalStep({ instruction: "a".repeat(200), expectedResult: "" }).length).toBe(140);
    expect(describeNaturalStep(emptyNaturalStep())).toBe("(empty step)");
  });
});

describe("buildNaturalPlan", () => {
  it("trims, drops empty rows, and returns null for empty plans", () => {
    const plan = buildNaturalPlan([
      { instruction: "  Open the cart  ", expectedResult: " Cart shows 2 items " },
      { instruction: "   ", expectedResult: "ignored" },
    ]);
    expect(plan?.steps).toEqual([{ instruction: "Open the cart", expectedResult: "Cart shows 2 items" }]);
    expect(plan?.schemaVersion).toBe("v2-natural");
    expect(buildNaturalPlan([emptyNaturalStep()])).toBeNull();
  });
});

describe("azureStepsToNaturalPlan", () => {
  it("maps Azure test-case steps 1:1 with length clamping", () => {
    const plan = azureStepsToNaturalPlan([
      { action: "Click the Save button", expectedResult: "Order saved toast" },
      { action: "a".repeat(3000), expectedResult: "b".repeat(3000) },
    ]);
    expect(plan?.steps[0]).toEqual({ instruction: "Click the Save button", expectedResult: "Order saved toast" });
    expect(plan?.steps[1].instruction.length).toBe(2000);
    expect(plan?.steps[1].expectedResult.length).toBe(2000);
  });

  it("returns null for step-less cases", () => {
    expect(azureStepsToNaturalPlan([])).toBeNull();
  });
});
