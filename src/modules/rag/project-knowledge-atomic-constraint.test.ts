import { describe, expect, it } from "vitest";

import {
  compareProjectKnowledgeAtomicConstraintValues,
  extractAtomicConstraint,
  normalizeProjectKnowledgeRuleFingerprint,
  projectKnowledgeAtomicConstraintIdentity,
  ProjectKnowledgeAtomicConstraintSchema,
  validateProjectKnowledgeAtomicConstraint,
} from "./project-knowledge-atomic-constraint";

function constraint(input: Record<string, unknown>) {
  return ProjectKnowledgeAtomicConstraintSchema.parse(input);
}

describe("project knowledge atomic constraint extraction", () => {
  it.each([
    [
      "The retry count must be at most 3.",
      { object: "retry", property: "count", operator: "lte", value: "3", valueType: "number" },
    ],
    [
      "Session timeout must be at least 30 seconds.",
      { object: "session", property: "timeout", operator: "gte", value: "30", valueType: "number", unit: "second" },
    ],
    [
      "The retry count is less than 3.",
      { object: "retry", property: "count", operator: "lt", value: "3", valueType: "number" },
    ],
    [
      "The retry count is greater than 1.",
      { object: "retry", property: "count", operator: "gt", value: "1", valueType: "number" },
    ],
    [
      "Maximum retry count is 3.",
      { object: "retry", property: "count", operator: "lte", value: "3", valueType: "number" },
    ],
    [
      "The submit button must be enabled.",
      { object: "submit", property: "button", operator: "eq", value: "true", valueType: "boolean" },
    ],
    [
      "The refund reason is required.",
      { object: "refund", property: "reason", operator: "eq", value: "true", valueType: "boolean" },
    ],
    [
      "The action is denied.",
      { object: "action", property: "value", operator: "eq", value: "false", valueType: "boolean" },
    ],
    [
      "The payment method must be manual.",
      { object: "payment", property: "method", operator: "eq", value: "manual", valueType: "enum" },
    ],
    [
      "The order status must be Pending.",
      { object: "order", property: "status", operator: "eq", value: "pending", valueType: "state" },
    ],
    [
      "When payment succeeds, the receipt status must be visible.",
      {
        object: "receipt",
        property: "status",
        condition: "payment succeed",
        operator: "eq",
        value: "visible",
        valueType: "state",
      },
    ],
    [
      "The feature must not be enabled.",
      { object: "feature", property: "value", operator: "ne", value: "true", valueType: "boolean" },
    ],
  ])("extracts %s", (rule, expected) => {
    expect(extractAtomicConstraint(rule)).toEqual(expected);
  });

  it.each([
    "Customers can request refunds through support.",
    "Retry count must be between 3 and 5.",
    "Retry count must be 3 or 5.",
    "Retry count must be not enabled.",
    "A reason is required for a return/refund request.",
    "A reason is required for return/refund requests.",
    "El numero de reintentos debe ser 3.",
  ])("abstains for non-atomic or non-English rule text: %s", (rule) => {
    expect(extractAtomicConstraint(rule)).toBeNull();
  });
});

describe("project knowledge atomic constraint validation and canonicalization", () => {
  it("validates raw values only when they appear as complete tokens in cited quotes", () => {
    const parsed = validateProjectKnowledgeAtomicConstraint({
      object: "Retry",
      property: "Count",
      operator: "lte",
      value: "30",
      valueType: "number",
    }, ["The retry count must be at most 30."]);

    expect(parsed).toEqual({
      object: "retry",
      property: "count",
      operator: "lte",
      value: "30",
      valueType: "number",
    });
    expect(validateProjectKnowledgeAtomicConstraint({
      object: "retry",
      property: "count",
      operator: "lte",
      value: "3",
      valueType: "number",
    }, ["The retry count must be at most 30."])).toBeNull();
  });

  it("rejects malformed fields and ungrounded rewritten values", () => {
    expect(validateProjectKnowledgeAtomicConstraint({
      object: "retry",
      property: "count",
      operator: "lte",
      value: "many",
      valueType: "number",
    }, ["The retry count must be at most 30."])).toBeNull();
    expect(validateProjectKnowledgeAtomicConstraint({
      object: "feature",
      property: "state",
      operator: "eq",
      value: "true",
      valueType: "boolean",
    }, ["The feature is enabled."])).toMatchObject({ value: "true", valueType: "boolean" });
    expect(validateProjectKnowledgeAtomicConstraint({
      object: "feature",
      property: "state",
      operator: "eq",
      value: "false",
      valueType: "boolean",
    }, ["The feature is enabled."])).toBeNull();
    expect(validateProjectKnowledgeAtomicConstraint({
      object: "feature",
      property: "state",
      operator: "lte",
      value: "true",
      valueType: "boolean",
    }, ["The feature is true."])).toBeNull();
  });

  it("uses a module-qualified identity while ignoring the compared value", () => {
    const three = constraint({
      object: "Retry",
      property: "Count",
      operator: "eq",
      value: "3",
      valueType: "number",
    });
    const five = constraint({
      object: "retry",
      property: "count",
      operator: "eq",
      value: "5",
      valueType: "number",
    });

    expect(projectKnowledgeAtomicConstraintIdentity(three, "Checkout"))
      .toBe(projectKnowledgeAtomicConstraintIdentity(five, "checkout"));
    expect(projectKnowledgeAtomicConstraintIdentity(three, "Payments"))
      .not.toBe(projectKnowledgeAtomicConstraintIdentity(five, "checkout"));
  });
});

describe("project knowledge atomic constraint comparisons", () => {
  it("only reports a numeric contradiction when ranges cannot overlap", () => {
    const lteThirty = constraint({ object: "retry", property: "count", operator: "lte", value: "30", valueType: "number" });
    const eqFortyFive = constraint({ object: "retry", property: "count", operator: "eq", value: "45", valueType: "number" });
    const eqTwenty = constraint({ object: "retry", property: "count", operator: "eq", value: "20", valueType: "number" });
    const gteTwenty = constraint({ object: "retry", property: "count", operator: "gte", value: "20", valueType: "number" });

    expect(compareProjectKnowledgeAtomicConstraintValues(lteThirty, eqFortyFive)).toBe("contradiction");
    expect(compareProjectKnowledgeAtomicConstraintValues(lteThirty, eqTwenty)).toBe("not_comparable");
    expect(compareProjectKnowledgeAtomicConstraintValues(lteThirty, gteTwenty)).toBe("not_comparable");
  });

  it("requires compatible value types and units", () => {
    const thirtySeconds = constraint({ object: "timeout", property: "limit", operator: "lte", value: "30", valueType: "number", unit: "seconds" });
    const thirtyMinutes = constraint({ object: "timeout", property: "limit", operator: "lte", value: "30", valueType: "number", unit: "minutes" });
    const booleanValue = constraint({ object: "timeout", property: "limit", operator: "eq", value: "true", valueType: "boolean" });

    expect(compareProjectKnowledgeAtomicConstraintValues(thirtySeconds, thirtyMinutes)).toBe("not_comparable");
    expect(compareProjectKnowledgeAtomicConstraintValues(thirtySeconds, booleanValue)).toBe("not_comparable");
  });

  it("handles equivalent, boolean, and trivial not-equal cases", () => {
    const enabled = constraint({ object: "button", property: "state", operator: "eq", value: "enabled", valueType: "boolean" });
    const alsoEnabled = constraint({ object: "button", property: "state", operator: "eq", value: "true", valueType: "boolean" });
    const disabled = constraint({ object: "button", property: "state", operator: "eq", value: "disabled", valueType: "boolean" });
    const notEnabled = constraint({ object: "button", property: "state", operator: "ne", value: "enabled", valueType: "boolean" });

    expect(compareProjectKnowledgeAtomicConstraintValues(enabled, alsoEnabled)).toBe("equivalent");
    expect(compareProjectKnowledgeAtomicConstraintValues(enabled, disabled)).toBe("contradiction");
    expect(compareProjectKnowledgeAtomicConstraintValues(enabled, notEnabled)).toBe("contradiction");
  });
});

describe("project knowledge rule fingerprints", () => {
  it("folds closed grammar variants without inventing noun synonyms", () => {
    const request = normalizeProjectKnowledgeRuleFingerprint(
      "A reason is required for a return/refund request.",
    );
    const requests = normalizeProjectKnowledgeRuleFingerprint(
      "A reason is required for return/refund requests.",
    );

    expect(request).toBe(requests);
    expect(normalizeProjectKnowledgeRuleFingerprint("Notifications must be displayed."))
      .toBe(normalizeProjectKnowledgeRuleFingerprint("Notification is displayed."));
    expect(normalizeProjectKnowledgeRuleFingerprint("Loading indicator is visible."))
      .not.toBe(normalizeProjectKnowledgeRuleFingerprint("Loading spinner is visible."));
  });

  it("preserves protected values and remains idempotent", () => {
    const fingerprint = normalizeProjectKnowledgeRuleFingerprint(
      "Maximum retries are 3 Days.",
      { protectedTokens: ["3 Days"] },
    );

    expect(fingerprint).toContain("3 Days");
    expect(normalizeProjectKnowledgeRuleFingerprint(fingerprint, { protectedTokens: ["3 Days"] }))
      .toBe(fingerprint);
  });
});
