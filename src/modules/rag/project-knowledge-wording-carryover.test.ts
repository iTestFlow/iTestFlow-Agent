import { describe, expect, it } from "vitest";

import {
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";
import {
  carryOverProjectKnowledgeWording,
  isCompatibleProjectKnowledgeParaphrase,
} from "./project-knowledge-wording-carryover";

function evidenceRef(
  sourceWorkItemId: string,
  sourceSnapshotId: string,
  quote: string,
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"] = "acceptanceCriteria",
): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId,
    sourceWorkItemId,
    sourceField,
    quote,
    origin: "generated_v2",
    verification: "exact",
  };
}

function knowledgeBase(partial: Partial<Record<keyof ProjectKnowledgeBase, unknown[]>>): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
    ...partial,
  });
}

function glossaryTerm(term: string, definition: string, refs: ProjectKnowledgeEvidenceRef[]) {
  return { term, type: "term", definition, sourceWorkItemIds: ["x"], evidence: "seed", evidenceRefs: refs };
}

function businessRule(id: string, rule: string, refs: ProjectKnowledgeEvidenceRef[]) {
  return { id, rule, sourceField: "acceptanceCriteria", sourceWorkItemIds: ["x"], evidence: "seed", evidenceRefs: refs };
}

function moduleEntry(id: string, name: string, description: string, refs: ProjectKnowledgeEvidenceRef[]) {
  return { id, name, description, sourceWorkItemIds: ["x"], evidence: "seed", evidenceRefs: refs };
}

describe("isCompatibleProjectKnowledgeParaphrase", () => {
  it("treats module and glossary wording drift as always compatible", () => {
    const base = knowledgeBase({
      modules: [
        moduleEntry("mod-a", "Checkout", "Customers pay.", [evidenceRef("1", "s1", "q")]),
        moduleEntry("mod-a", "Checkout", "Customers complete payment.", [evidenceRef("1", "s2", "q")]),
      ],
      glossary: [
        glossaryTerm("Discount", "A price reduction applied by a valid promo code.", [evidenceRef("10", "s10", "q")]),
        glossaryTerm("Discount", "A reduction applied by a valid promo code.", [evidenceRef("10", "s11", "q")]),
      ],
    });
    expect(isCompatibleProjectKnowledgeParaphrase("module", base.modules[0], base.modules[1])).toBe(true);
    expect(isCompatibleProjectKnowledgeParaphrase("glossary", base.glossary[0], base.glossary[1])).toBe(true);
  });

  it("uses atomic constraints and abstention fingerprints for business rules", () => {
    const base = knowledgeBase({
      businessRules: [
        businessRule("br-1", "Maximum retry count is 3.", [evidenceRef("1", "s1", "q")]),
        businessRule("br-1", "Maximum retry count is 5.", [evidenceRef("1", "s2", "q")]),
        businessRule("br-1", "The maximum retry count must be 3", [evidenceRef("1", "s3", "q")]),
        businessRule("br-2", "A reason is required for a return/refund request.", [evidenceRef("2", "s4", "q")]),
        businessRule("br-2", "A reason is required for return/refund requests.", [evidenceRef("2", "s5", "q")]),
      ],
    });
    const [three, five, alsoThree, reasonA, reasonB] = base.businessRules;
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", three, five)).toBe(false);
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", three, alsoThree)).toBe(true);
    // Both conservative extractions abstain; request/requests folds in the closed
    // fingerprint table and is therefore safe to carry over.
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", reasonA, reasonB)).toBe(true);
  });

  it("refuses a mixed constraint/abstention pair when fingerprint and evidence both differ", () => {
    const base = knowledgeBase({
      businessRules: [
        businessRule("br-retry", "Maximum retry count is 3.", [evidenceRef("1", "s1", "Retries are capped at 3.")]),
        businessRule("br-retry", "Retry behavior varies by account.", [evidenceRef("1", "s2", "Behavior differs per account tier.")]),
      ],
    });

    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", base.businessRules[0], base.businessRules[1]))
      .toBe(false);
  });

  it("merges a mixed constraint/abstention pair citing content-equivalent evidence", () => {
    // One side extracts an atomic claim, the other abstains — constraint presence
    // can flip between builds for the same source claim. Trailing-punctuation
    // drift in the re-quoted evidence must not keep the pair split forever.
    const base = knowledgeBase({
      businessRules: [
        businessRule("br-retry-cap", "Maximum retry count is 3.", [evidenceRef("1", "s1", "Retry count max 3.")]),
        businessRule("br-retry-cap", "Retries are capped at three attempts per user.", [evidenceRef("1", "s2", "Retry count max 3")]),
      ],
    });

    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", base.businessRules[0], base.businessRules[1]))
      .toBe(true);
  });

  it("merges a mixed pair on fingerprint equality even when evidence differs", () => {
    // Production pair: "to cart" vs "to the cart" — identical fingerprints (articles
    // fold), but one published twin carries a persisted LLM constraint while the
    // re-extraction abstains. The old mixed branch refused unconditionally.
    const base = knowledgeBase({
      businessRules: [
        {
          ...businessRule("br-add-to-cart-in-stock-only", "Only in-stock products can be added to cart.", [
            evidenceRef("8", "s1", "Products must be in-stock"),
          ]),
          constraint: {
            object: "product",
            property: "availability",
            operator: "eq",
            value: "in-stock",
            valueType: "enum",
          },
        },
        businessRule("br-add-to-cart-in-stock-only", "Only in-stock products can be added to the cart.", [
          evidenceRef("8", "s2", "Only in-stock products can be added"),
        ]),
      ],
    });

    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", base.businessRules[0], base.businessRules[1]))
      .toBe(true);
  });

  it("treats trailing-punctuation evidence drift as the same source claim for abstaining twins", () => {
    // Production pair: both extractions abstain, the fingerprint is word-order
    // sensitive, and the two quotes differ by exactly one trailing period.
    const base = knowledgeBase({
      businessRules: [
        businessRule("br-payment-retry", "Retrying payment does not duplicate payment or order.", [
          evidenceRef("16", "s1", "retry does not duplicate payment or order."),
        ]),
        businessRule("br-payment-retry", "A payment retry does not duplicate the payment or order.", [
          evidenceRef("16", "s2", "retry does not duplicate payment or order"),
        ]),
      ],
    });

    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", base.businessRules[0], base.businessRules[1]))
      .toBe(true);
  });

  it("merges different-identity constraints only when they cite content-equivalent evidence", () => {
    // Production pair: two wordings of one quoted claim whose object/property
    // split drifted between extractions. The same quote cannot disagree with
    // itself; distinct evidence keeps the pair separate and reviewable.
    const quote = "Street, city, and postal code are required for shipping.";
    const constraintFor = (object: string, property: string) => ({
      object,
      property,
      operator: "eq" as const,
      value: "required",
      valueType: "boolean" as const,
    });
    const base = knowledgeBase({
      businessRules: [
        {
          ...businessRule("br-shipping", "Shipping address required fields are validated.", [evidenceRef("30", "s1", quote)]),
          constraint: constraintFor("shipping address", "required fields"),
        },
        {
          ...businessRule("br-shipping", "The shipping address form validates its required fields.", [evidenceRef("30", "s2", quote)]),
          constraint: constraintFor("shipping address form", "validation"),
        },
        {
          ...businessRule("br-shipping", "Billing contact fields are validated separately.", [evidenceRef("30", "s3", "Billing contact must be validated separately.")]),
          constraint: constraintFor("billing contact", "validation"),
        },
      ],
    });
    const [shippingA, shippingB, billing] = base.businessRules;

    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", shippingA, shippingB)).toBe(true);
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", shippingA, billing)).toBe(false);
  });

  it("merges extraction abstentions with identical evidence even when fingerprints differ", () => {
    const base = knowledgeBase({
      businessRules: [
        businessRule("br-1", "Customers can request refunds through support.", [evidenceRef("1", "s1", "q")]),
        businessRule("br-1", "Refunds can be requested by customers through support.", [evidenceRef("1", "s2", "q")]),
      ],
    });
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", base.businessRules[0], base.businessRules[1])).toBe(true);
  });

  it("merges word-order paraphrases of an enumeration citing the same quote", () => {
    // Enumerations always abstain from atomic extraction (multi-value lists), so
    // this pair used to split on the word-order-sensitive fingerprint and publish
    // as two records, one rekeyed with a hash suffix.
    const quote = "Allowed status values and badge colours: Draft (grey); Quoting (blue); Completed (green)";
    const base = knowledgeBase({
      businessRules: [
        businessRule(
          "br-status-colours",
          "Allowed Application Status values and badge colours are Draft (grey), Quoting (blue), and Completed (green).",
          [evidenceRef("385392", "s1", quote)],
        ),
        businessRule(
          "br-status-colours",
          "Application Status allowed values and badge colours are Draft (grey), Quoting (blue), and Completed (green).",
          [evidenceRef("385392", "s2", quote)],
        ),
      ],
    });
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", base.businessRules[0], base.businessRules[1])).toBe(true);
  });

  it("keeps extraction abstentions separate when fingerprints and evidence both differ", () => {
    const base = knowledgeBase({
      businessRules: [
        businessRule("br-1", "Customers can request refunds through support.", [evidenceRef("1", "s1", "Refunds go through support.")]),
        businessRule("br-1", "Support agents can escalate refund disputes.", [evidenceRef("1", "s2", "Disputes may be escalated.")]),
      ],
    });
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", base.businessRules[0], base.businessRules[1])).toBe(false);
  });

  it("prefers supplied atomic constraints and refuses a proven contradiction", () => {
    const refs = [evidenceRef("1", "s1", "The submit button is enabled.")];
    const base = knowledgeBase({
      businessRules: [
        {
          ...businessRule("br-submit", "The submit button is enabled.", refs),
          moduleName: "Checkout",
          constraint: {
            object: "submit",
            property: "button",
            operator: "eq",
            value: "enabled",
            valueType: "boolean",
          },
        },
        {
          ...businessRule("br-submit", "The submit button is shown as enabled.", refs),
          moduleName: "Checkout",
          constraint: {
            object: "submit",
            property: "button",
            operator: "eq",
            value: "true",
            valueType: "boolean",
          },
        },
        {
          ...businessRule("br-submit", "The submit button is disabled.", refs),
          moduleName: "Checkout",
          constraint: {
            object: "submit",
            property: "button",
            operator: "eq",
            value: "disabled",
            valueType: "boolean",
          },
        },
      ],
    });
    const [enabled, alsoEnabled, disabled] = base.businessRules;

    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", enabled, alsoEnabled)).toBe(true);
    expect(isCompatibleProjectKnowledgeParaphrase("business_rule", enabled, disabled)).toBe(false);
  });

  it("requires state transitions to agree on the target state", () => {
    const base = knowledgeBase({
      stateTransitions: [
        { id: "st-1", workflowName: "Order", fromState: "New", toState: "Paid", triggerOrCondition: "Payment succeeds", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s1", "q")] },
        { id: "st-1", workflowName: "Order", fromState: "New", toState: "PAID", triggerOrCondition: "Payment completes", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s2", "q")] },
        { id: "st-1", workflowName: "Order", fromState: "New", toState: "Cancelled", triggerOrCondition: "Payment succeeds", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s3", "q")] },
        { id: "st-1", workflowName: "Order", fromState: "Submitted", triggerOrCondition: "Reviewer approves the order", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s4", "q")] },
        { id: "st-1", workflowName: "Order", fromState: "Rejected", triggerOrCondition: "Requester resubmits after rejection", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s5", "q")] },
      ],
    });
    const [paid, paidUpper, cancelled, missingA, missingB] = base.stateTransitions;
    expect(isCompatibleProjectKnowledgeParaphrase("state_transition", paid, paidUpper)).toBe(true);
    expect(isCompatibleProjectKnowledgeParaphrase("state_transition", paid, cancelled)).toBe(false);
    // Two ABSENT target states are unknowns, not an agreement — merging them would
    // fuse structurally distinct transitions into one chimera entry.
    expect(isCompatibleProjectKnowledgeParaphrase("state_transition", missingA, missingB)).toBe(false);
    expect(isCompatibleProjectKnowledgeParaphrase("state_transition", paid, missingA)).toBe(false);
  });

  it("requires dependency endpoints and transport semantics to agree while accepting synonyms", () => {
    const sharedGatewayEvidence = evidenceRef(
      "15",
      "snapshot-15",
      "Payment gateway is called; successful payment creates order.",
    );
    const base = knowledgeBase({
      crossDependencies: [
        { id: "dep-1", sourceModule: "Cart", targetModule: "Payments", dependencyType: "api", description: "Cart calls payments.", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s1", "q")] },
        { id: "dep-1", sourceModule: "Cart", targetModule: "Payments", dependencyType: "api", description: "The cart module invokes payments.", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s2", "q")] },
        { id: "dep-1", sourceModule: "Cart", targetModule: "Payments", dependencyType: "event", description: "Cart calls payments.", sourceWorkItemIds: ["1"], evidence: "seed", evidenceRefs: [evidenceRef("1", "s3", "q")] },
        { id: "dep-2", sourceModule: "Checkout", targetModule: "Payment Gateway", dependencyType: "external service call", description: "Checkout calls the gateway.", sourceWorkItemIds: ["15"], evidence: "seed", evidenceRefs: [sharedGatewayEvidence] },
        { id: "dep-2", sourceModule: "Checkout", targetModule: "Payment Gateway", dependencyType: "external service dependency", description: "Checkout depends on the gateway.", sourceWorkItemIds: ["15"], evidence: "seed", evidenceRefs: [sharedGatewayEvidence] },
        { id: "dep-3", sourceModule: "Checkout", targetModule: "Payment Gateway", dependencyType: "payment gateway call", description: "Checkout calls the gateway.", sourceWorkItemIds: ["15"], evidence: "seed", evidenceRefs: [sharedGatewayEvidence] },
        { id: "dep-3", sourceModule: "Checkout", targetModule: "Payment Gateway", dependencyType: "payment gateway dependency", description: "Checkout depends on the gateway.", sourceWorkItemIds: ["15"], evidence: "seed", evidenceRefs: [sharedGatewayEvidence] },
      ],
    });
    const [api, apiReworded, event, externalCall, externalDependency, gatewayCall, gatewayDependency] = base.crossDependencies;
    expect(isCompatibleProjectKnowledgeParaphrase("dependency", api, apiReworded)).toBe(true);
    expect(isCompatibleProjectKnowledgeParaphrase("dependency", api, event)).toBe(false);
    expect(isCompatibleProjectKnowledgeParaphrase("dependency", api, {
      ...api,
      evidenceRefs: [evidenceRef("99", "s99", "A different relationship.")],
    })).toBe(false);
    expect(externalCall.dependencyType).toBe("external service dependency");
    expect(externalDependency.dependencyType).toBe("external service dependency");
    expect(isCompatibleProjectKnowledgeParaphrase("dependency", externalCall, externalDependency)).toBe(true);
    expect(isCompatibleProjectKnowledgeParaphrase("dependency", gatewayCall, gatewayDependency)).toBe(true);
  });
});

describe("carryOverProjectKnowledgeWording", () => {
  it("restores previous glossary wording while keeping the new snapshot provenance", () => {
    const previous = knowledgeBase({
      glossary: [glossaryTerm(
        "Discount",
        "A price reduction applied by a valid promo code and included in order totals.",
        [evidenceRef("10", "snapshot-old-10", "Valid code applies discount")],
      )],
    });
    const next = knowledgeBase({
      glossary: [glossaryTerm(
        "Discount",
        "A reduction applied by a valid promo code and included in order totals.",
        [evidenceRef("10", "snapshot-new-10", "Valid code applies discount")],
      )],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(1);
    expect(result.knowledgeBase.glossary[0].definition)
      .toBe("A price reduction applied by a valid promo code and included in order totals.");
    expect(result.knowledgeBase.glossary[0].evidenceRefs).toEqual([
      expect.objectContaining({ sourceSnapshotId: "snapshot-new-10" }),
    ]);
    expect(result.knowledgeBase.glossary[0].evidence).toBe("Valid code applies discount");
  });

  it("restores the previous business-rule id and wording so semantic hashes stay stable", () => {
    const previous = knowledgeBase({
      businessRules: [businessRule(
        "br-refund-reason",
        "A reason is required.",
        [evidenceRef("20", "snapshot-old-20", "reason is required")],
      )],
    });
    const next = knowledgeBase({
      businessRules: [businessRule(
        "br-refund-reason",
        "The reason is required.",
        [evidenceRef("20", "snapshot-new-20", "reason is required")],
      )],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(1);
    expect(result.knowledgeBase.businessRules[0]).toMatchObject({
      id: "br-refund-reason",
      rule: "A reason is required.",
    });
  });

  it("never carries wording across a concrete-value disagreement", () => {
    const previous = knowledgeBase({
      businessRules: [businessRule("br-retry", "Maximum retry count is 3.", [evidenceRef("1", "s-old", "retry")])],
    });
    const next = knowledgeBase({
      businessRules: [businessRule("br-retry", "Maximum retry count is 5.", [evidenceRef("1", "s-new", "retry")])],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(0);
    expect(result.knowledgeBase.businessRules[0].rule).toBe("Maximum retry count is 5.");
  });

  it("restores previous wording when the re-quoted evidence drifted only by trailing punctuation", () => {
    const previous = knowledgeBase({
      businessRules: [businessRule(
        "br-payment-retry",
        "Retrying payment does not duplicate payment or order.",
        [evidenceRef("16", "s-old", "retry does not duplicate payment or order.")],
      )],
    });
    const next = knowledgeBase({
      businessRules: [businessRule(
        "br-payment-retry",
        "A payment retry does not duplicate the payment or order.",
        [evidenceRef("16", "s-new", "retry does not duplicate payment or order")],
      )],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(1);
    expect(result.knowledgeBase.businessRules[0]).toMatchObject({
      id: "br-payment-retry",
      rule: "Retrying payment does not duplicate payment or order.",
    });
    expect(result.knowledgeBase.businessRules[0].evidenceRefs).toEqual([
      expect.objectContaining({ sourceSnapshotId: "s-new" }),
    ]);
  });

  it("restores constraint-bearing wording over an abstaining re-extraction of unchanged evidence", () => {
    const previous = knowledgeBase({
      businessRules: [{
        ...businessRule("br-retry-cap", "Maximum retry count is 3.", [evidenceRef("1", "s-old", "retry count is capped at 3")]),
        constraint: {
          object: "retry",
          property: "count",
          operator: "lte",
          value: "3",
          valueType: "number",
        },
      }],
    });
    const next = knowledgeBase({
      businessRules: [businessRule(
        "br-retry-cap",
        "The retry count limit applies to all users.",
        [evidenceRef("1", "s-new", "retry count is capped at 3")],
      )],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(1);
    expect(result.knowledgeBase.businessRules[0]).toMatchObject({
      id: "br-retry-cap",
      rule: "Maximum retry count is 3.",
    });
  });

  it("does not downgrade hierarchy-compatible dependency types during carry-over", () => {
    const quote = "Checkout depends on an external payment service.";
    const previous = knowledgeBase({
      crossDependencies: [{
        id: "dep-payment",
        sourceModule: "Checkout",
        targetModule: "Payment Service",
        dependencyType: "dependency",
        description: "Checkout depends on payment.",
        sourceWorkItemIds: ["1"],
        evidence: quote,
        evidenceRefs: [evidenceRef("1", "s-old", quote)],
      }],
    });
    const next = knowledgeBase({
      crossDependencies: [{
        id: "dep-payment",
        sourceModule: "Checkout",
        targetModule: "Payment Service",
        dependencyType: "external service dependency",
        description: "Checkout calls its payment service.",
        sourceWorkItemIds: ["1"],
        evidence: quote,
        evidenceRefs: [evidenceRef("1", "s-new", quote)],
      }],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(1);
    expect(result.knowledgeBase.crossDependencies[0]).toMatchObject({
      dependencyType: "external service dependency",
      description: "Checkout depends on payment.",
    });
  });

  it("matches a module through its name when the id churned", () => {
    const previous = knowledgeBase({
      modules: [moduleEntry("mod-checkout", "Checkout", "Customers complete checkout securely.", [evidenceRef("1", "s-old", "checkout")])],
    });
    const next = knowledgeBase({
      modules: [moduleEntry("mod-checkout-flow", "Checkout", "Customers can finish checkout in a secure way.", [evidenceRef("1", "s-new", "checkout")])],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(1);
    expect(result.knowledgeBase.modules[0]).toMatchObject({
      id: "mod-checkout",
      description: "Customers complete checkout securely.",
    });
  });

  it("skips entries whose evidence content genuinely changed", () => {
    const previous = knowledgeBase({
      glossary: [glossaryTerm("Discount", "Old definition.", [evidenceRef("10", "s-old", "Valid code applies discount")])],
    });
    const next = knowledgeBase({
      glossary: [glossaryTerm("Discount", "New definition.", [
        evidenceRef("10", "s-new", "Valid code applies discount"),
        evidenceRef("11", "s-new-11", "Discount shown in totals"),
      ])],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(0);
    expect(result.knowledgeBase.glossary[0].definition).toBe("New definition.");
  });

  it("skips legacy entries without evidence refs and passes through a null previous base", () => {
    const previous = knowledgeBase({
      glossary: [{ term: "Discount", type: "term", definition: "Old.", sourceWorkItemIds: ["10"], evidence: "legacy only" }],
    });
    const next = knowledgeBase({
      glossary: [{ term: "Discount", type: "term", definition: "New.", sourceWorkItemIds: ["10"], evidence: "legacy only" }],
    });

    expect(carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next }).wordingCarryOverCount).toBe(0);
    expect(carryOverProjectKnowledgeWording({ previousKnowledgeBase: null, knowledgeBase: next }).knowledgeBase).toBe(next);
  });

  it("skips ambiguous matches and consumes each previous entry at most once", () => {
    const sharedRefs = [evidenceRef("1", "s", "same quote")];
    // Both previous entries share the name key AND the reference-name surface, so the
    // new entry genuinely matches two candidates — ambiguity must skip the restore.
    const previous = knowledgeBase({
      modules: [
        moduleEntry("mod-a", "Beta", "Prev wording A.", sharedRefs),
        moduleEntry("mod-x", "Beta", "Prev wording B.", sharedRefs),
      ],
    });
    const ambiguousNext = knowledgeBase({
      modules: [moduleEntry("mod-a", "Beta", "Fresh wording.", [evidenceRef("1", "s2", "same quote")])],
    });
    expect(carryOverProjectKnowledgeWording({
      previousKnowledgeBase: previous,
      knowledgeBase: ambiguousNext,
    }).wordingCarryOverCount).toBe(0);

    // Two new entries matching the same previous entry: only the first consumes it.
    const doubleNext = knowledgeBase({
      modules: [
        moduleEntry("mod-a", "Alpha", "Fresh wording one.", [evidenceRef("1", "s2", "same quote")]),
        moduleEntry("mod-a-copy", "Alpha", "Fresh wording two.", [evidenceRef("1", "s3", "same quote")]),
      ],
    });
    const singlePrevious = knowledgeBase({
      modules: [moduleEntry("mod-a", "Alpha", "Prev wording A.", sharedRefs)],
    });
    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: singlePrevious, knowledgeBase: doubleNext });
    expect(result.wordingCarryOverCount).toBe(1);
    expect(result.knowledgeBase.modules[0].description).toBe("Prev wording A.");
    expect(result.knowledgeBase.modules[1].description).toBe("Fresh wording two.");
  });

  it("skips a restore that would collide with another entry's identity", () => {
    const previous = knowledgeBase({
      modules: [moduleEntry("mod-a", "Alpha", "Prev wording.", [evidenceRef("1", "s", "quote a")])],
    });
    const next = knowledgeBase({
      modules: [
        moduleEntry("mod-b", "Alpha", "Fresh wording.", [evidenceRef("1", "s2", "quote a")]),
        moduleEntry("mod-a", "Zeta", "Unrelated module.", [evidenceRef("9", "s9", "quote z")]),
      ],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(0);
    expect(result.knowledgeBase.modules[0].id).toBe("mod-b");
  });

  it("skips restores whose referenced names differ beyond whitespace, keeping dependencies consistent", () => {
    // "Payment_Processing" and "Payment Processing" share a logical-identity key but
    // NOT a dependency-endpoint key — restoring the underscore spelling would mutate
    // or dangle dependencies pointing at the new spelling during the final re-parse.
    const previous = knowledgeBase({
      modules: [moduleEntry("mod-pay", "Payment_Processing", "Prev wording.", [evidenceRef("1", "s-old", "pay quote")])],
    });
    const next = knowledgeBase({
      modules: [moduleEntry("mod-pay", "Payment Processing", "Fresh wording.", [evidenceRef("1", "s-new", "pay quote")])],
      crossDependencies: [{
        id: "dep-1",
        sourceModule: "Cart",
        targetModule: "Payment Processing",
        dependencyType: "api",
        description: "Cart calls payments.",
        sourceWorkItemIds: ["2"],
        evidence: "dep quote",
        evidenceRefs: [evidenceRef("2", "s-dep", "dep quote")],
      }],
    });

    const result = carryOverProjectKnowledgeWording({ previousKnowledgeBase: previous, knowledgeBase: next });

    expect(result.wordingCarryOverCount).toBe(0);
    expect(result.knowledgeBase.modules[0].name).toBe("Payment Processing");
    expect(result.knowledgeBase.crossDependencies[0].targetModule).toBe("Payment Processing");
    expect(result.knowledgeBase.crossDependencies[0].description).toBe("Cart calls payments.");
  });
});
