import { describe, expect, it } from "vitest";

import { projectKnowledgeAtomicConstraintIdentity } from "./project-knowledge-atomic-constraint";
import { detectProjectKnowledgeHardConflicts } from "./project-knowledge-conflicts";
import { hashCanonicalValue } from "./project-knowledge-contracts";
import {
  hasProjectKnowledgeDuplicateLogicalIdentities,
  resolveProjectKnowledgeDuplicateIdentities,
} from "./project-knowledge-duplicate-resolution";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

function evidenceRef(quote: string): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId: "snapshot-1",
    sourceWorkItemId: "1",
    sourceField: "acceptanceCriteria",
    quote,
    origin: "generated_v4",
    verification: "exact",
  };
}

function knowledgeBase(partial: Record<string, unknown>) {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
    ...partial,
  });
}

function rule(
  id: string,
  text: string,
  constraint?: Record<string, unknown>,
) {
  return {
    id,
    rule: text,
    sourceField: "acceptanceCriteria",
    sourceWorkItemIds: ["1"],
    evidence: text,
    evidenceRefs: [evidenceRef(text)],
    ...(constraint ? { constraint } : {}),
  };
}

describe("project knowledge duplicate resolution", () => {
  it("merges equivalent business rules while preserving one logical identity", () => {
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        rule("retry-limit", "Retry count must be 3.", {
          object: "retry",
          property: "count",
          operator: "eq",
          value: "3",
          valueType: "number",
        }),
        rule("retry-limit", "The retry count is 3.", {
          object: "Retry",
          property: "Count",
          operator: "eq",
          value: "3",
          valueType: "number",
        }),
      ],
    }));

    expect(result.knowledgeBase.businessRules).toHaveLength(1);
    expect(result.counters).toMatchObject({
      preConsolidationDuplicateIdentityCount: 1,
      paraphraseMergeCount: 1,
      rekeyCount: 0,
      possibleTensionCount: 0,
    });
    expect(hasProjectKnowledgeDuplicateLogicalIdentities(result.knowledgeBase)).toBe(false);
  });

  it("re-keys compatible-distinct business rules and records a non-blocking tension", () => {
    // Guard for the both-constraints different-identity refusal: this relies on the
    // rule() helper quoting the rule text itself, so the two entries also cite
    // DIFFERENT evidence — content-equivalent evidence would merge them instead.
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        rule("notification", "Primary purchase button must be enabled.", {
          object: "purchase notification",
          property: "primary button",
          operator: "eq",
          value: "enabled",
          valueType: "boolean",
        }),
        rule("notification", "Secondary purchase button must be enabled.", {
          object: "purchase notification",
          property: "secondary button",
          operator: "eq",
          value: "enabled",
          valueType: "boolean",
        }),
      ],
    }));

    expect(result.knowledgeBase.businessRules.map((entry) => entry.id)).toEqual([
      "notification",
      expect.stringMatching(/^notification-[a-f0-9]{8}$/),
    ]);
    const rekeyed = result.knowledgeBase.businessRules.find((entry) => entry.id !== "notification");
    expect(rekeyed?.constraint).toBeDefined();
    expect(rekeyed?.id).toBe(`notification-${hashCanonicalValue(
      projectKnowledgeAtomicConstraintIdentity(rekeyed!.constraint!, rekeyed!.moduleName),
    ).slice(0, 8)}`);
    expect(result.counters).toMatchObject({ rekeyCount: 1, possibleTensionCount: 1 });
    expect(result.possibleTensions).toEqual([
      expect.objectContaining({
        category: "business_rule",
        reason: "different_atomic_identity",
        entryKeys: expect.arrayContaining(["notification"]),
      }),
    ]);
    expect(detectProjectKnowledgeHardConflicts(result.knowledgeBase)).toEqual([]);
  });

  it("re-keys a contradiction without hiding the atomic conflict", () => {
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        rule("retry-limit", "Retry count must be 3.", {
          object: "retry",
          property: "count",
          operator: "eq",
          value: "3",
          valueType: "number",
        }),
        rule("retry-limit", "Retry count must be 5.", {
          object: "retry",
          property: "count",
          operator: "eq",
          value: "5",
          valueType: "number",
        }),
      ],
    }));

    expect(result.counters).toMatchObject({ rekeyCount: 1, possibleTensionCount: 0 });
    expect(hasProjectKnowledgeDuplicateLogicalIdentities(result.knowledgeBase)).toBe(false);
    expect(detectProjectKnowledgeHardConflicts(result.knowledgeBase)).toEqual([
      expect.objectContaining({ conflictType: "incompatible_concrete_value" }),
    ]);
  });

  it("retains module-qualified conflicts after merging equivalent cross-module rules", () => {
    const featureConstraint = (value: "true" | "false") => ({
      object: "feature",
      property: "enabled",
      operator: "eq" as const,
      value,
      valueType: "boolean" as const,
    });
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        { ...rule("feature-enabled", "Feature must be true.", featureConstraint("true")), moduleName: "Alpha" },
        { ...rule("feature-enabled", "Feature must be true.", featureConstraint("true")), moduleName: "Zulu" },
        { ...rule("feature-enabled", "Feature must be false.", featureConstraint("false")), moduleName: "Zulu" },
      ],
    }));

    expect(result.knowledgeBase.businessRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ moduleName: "Alpha", moduleAssociations: ["Alpha", "Zulu"] }),
    ]));
    expect(result.counters).toMatchObject({ rekeyCount: 1, possibleTensionCount: 0 });
    expect(detectProjectKnowledgeHardConflicts(result.knowledgeBase)).toEqual([
      expect.objectContaining({
        conflictType: "incompatible_concrete_value",
        subject: "zulu:feature.enabled",
      }),
    ]);
  });

  it("preserves singleton module casing while deterministically resolving a three-member re-key tie", () => {
    const stateConstraint = (value: "pending" | "approved" | "rejected") => ({
      object: "notification",
      property: "state",
      operator: "eq" as const,
      value,
      valueType: "enum" as const,
    });
    const suffix = hashCanonicalValue(projectKnowledgeAtomicConstraintIdentity(
      stateConstraint("pending"),
      "Notification Center",
    )).slice(0, 8);
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        {
          ...rule("notification-state", "Notification state must be pending.", stateConstraint("pending")),
          moduleName: "Notification Center",
          moduleAssociations: ["Policy Details"],
        },
        {
          ...rule("notification-state", "Notification state must be approved.", stateConstraint("approved")),
          moduleName: "notification-center",
          moduleAssociations: ["policy-details"],
        },
        {
          ...rule("notification-state", "Notification state must be rejected.", stateConstraint("rejected")),
          moduleName: "Notification Center",
          moduleAssociations: ["Archive"],
        },
      ],
    }));

    expect(result.knowledgeBase.businessRules.map((entry) => entry.id)).toEqual([
      "notification-state",
      `notification-state-${suffix}`,
      `notification-state-${suffix}-2`,
    ]);
    expect(result.knowledgeBase.businessRules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        constraint: expect.objectContaining({ value: "pending" }),
        moduleName: "Notification Center",
        moduleAssociations: ["Policy Details"],
      }),
      expect.objectContaining({
        constraint: expect.objectContaining({ value: "approved" }),
        moduleName: "notification-center",
        moduleAssociations: ["policy-details"],
      }),
      expect.objectContaining({
        constraint: expect.objectContaining({ value: "rejected" }),
        moduleName: "Notification Center",
        moduleAssociations: ["Archive"],
      }),
    ]));
    expect(result.counters).toMatchObject({
      preConsolidationDuplicateIdentityCount: 2,
      paraphraseMergeCount: 0,
      rekeyCount: 2,
    });
  });

  it("keeps distinct-evidence abstentions separate while merging equal fingerprints", () => {
    const merged = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        rule("refund-reason", "A reason is required for a return/refund request."),
        rule("refund-reason", "A reason is required for return/refund requests."),
      ],
    }));
    const preserved = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        rule("checkout", "Checkout should be intuitive."),
        rule("checkout", "Checkout should be clear."),
      ],
    }));

    expect(merged.knowledgeBase.businessRules).toHaveLength(1);
    expect(preserved.knowledgeBase.businessRules).toHaveLength(2);
    expect(preserved.counters).toMatchObject({
      atomicExtractionFailureCount: 2,
      rekeyCount: 1,
      possibleTensionCount: 1,
    });
  });

  it("merges same-evidence word-order paraphrases that abstain from extraction", () => {
    const sharedEvidence = [evidenceRef("Allowed status values and badge colours: Draft (grey); Quoting (blue)")];
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        { ...rule("status-colours", "Allowed Application Status values and badge colours are Draft (grey), and Quoting (blue)."), evidenceRefs: sharedEvidence },
        { ...rule("status-colours", "Application Status allowed values and badge colours are Draft (grey), and Quoting (blue)."), evidenceRefs: sharedEvidence },
      ],
    }));

    expect(result.knowledgeBase.businessRules).toHaveLength(1);
    expect(result.knowledgeBase.businessRules[0].id).toBe("status-colours");
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0, possibleTensionCount: 0 });
  });

  it("heals a previously rekeyed same-evidence twin back into its base id", () => {
    const sharedEvidence = [evidenceRef("Allowed status values and badge colours: Draft (grey); Quoting (blue)")];
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        { ...rule("status-colours", "Allowed Application Status values and badge colours are Draft (grey), and Quoting (blue)."), evidenceRefs: sharedEvidence },
        { ...rule("status-colours-d501f6b2", "Application Status allowed values and badge colours are Draft (grey), and Quoting (blue)."), evidenceRefs: sharedEvidence },
      ],
    }));

    expect(result.knowledgeBase.businessRules).toHaveLength(1);
    expect(result.knowledgeBase.businessRules[0].id).toBe("status-colours");
    expect(result.knowledgeBase.businessRules[0].evidenceRefs).toHaveLength(1);
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0 });
  });

  it("merges a mixed constraint/abstention twin with equivalent evidence instead of recording a tension", () => {
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        {
          ...rule("add-to-cart", "Only in-stock products can be added to cart.", {
            object: "product",
            property: "availability",
            operator: "eq",
            value: "in-stock",
            valueType: "enum",
          }),
          evidenceRefs: [evidenceRef("Only in-stock products can be added.")],
        },
        {
          ...rule("add-to-cart", "Customers can only add in-stock products to the cart."),
          evidenceRefs: [evidenceRef("Only in-stock products can be added")],
        },
      ],
    }));

    expect(result.knowledgeBase.businessRules).toHaveLength(1);
    expect(result.knowledgeBase.businessRules[0].constraint).toMatchObject({ value: "in-stock" });
    expect(result.counters).toMatchObject({
      paraphraseMergeCount: 1,
      evidenceOnlyParaphraseMergeCount: 1,
      rekeyCount: 0,
      possibleTensionCount: 0,
    });
  });

  it("heals a published mixed twin back into its base id", () => {
    // The production shape behind the atomic_extraction_uncertain tensions: a
    // published base entry with a persisted LLM constraint plus its previously
    // rekeyed abstaining twin, quotes drifted by one trailing period.
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        {
          ...rule("add-to-cart", "Only in-stock products can be added to cart.", {
            object: "product",
            property: "availability",
            operator: "eq",
            value: "in-stock",
            valueType: "enum",
          }),
          evidenceRefs: [evidenceRef("Only in-stock products can be added.")],
        },
        {
          ...rule("add-to-cart-23d18761", "Only in-stock products can be added to the cart."),
          evidenceRefs: [evidenceRef("Only in-stock products can be added")],
        },
      ],
    }));

    expect(result.knowledgeBase.businessRules).toHaveLength(1);
    expect(result.knowledgeBase.businessRules[0].id).toBe("add-to-cart");
    expect(result.knowledgeBase.businessRules[0].constraint).toMatchObject({ value: "in-stock" });
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0, possibleTensionCount: 0 });
  });

  it("heals abstaining twins whose quotes drifted only by trailing punctuation", () => {
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        {
          ...rule("payment-retry", "Retrying payment does not duplicate payment or order."),
          evidenceRefs: [evidenceRef("retry does not duplicate payment or order.")],
        },
        {
          ...rule("payment-retry-e112a78e", "A payment retry does not duplicate the payment or order."),
          evidenceRefs: [evidenceRef("retry does not duplicate payment or order")],
        },
      ],
    }));

    expect(result.knowledgeBase.businessRules).toHaveLength(1);
    expect(result.knowledgeBase.businessRules[0].id).toBe("payment-retry");
    expect(result.counters).toMatchObject({
      paraphraseMergeCount: 1,
      evidenceOnlyParaphraseMergeCount: 1,
      rekeyCount: 0,
      possibleTensionCount: 0,
    });
  });

  it("heals a different-identity constrained twin when both sides cite the same quote", () => {
    // The production different_atomic_identity tension: the extractor split
    // object/property differently for two wordings of one quoted claim.
    const quote = "Street, city, and postal code are required for shipping.";
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        {
          ...rule("shipping-fields", "Shipping address required fields are validated.", {
            object: "shipping address",
            property: "required fields",
            operator: "eq",
            value: "required",
            valueType: "boolean",
          }),
          evidenceRefs: [evidenceRef(quote)],
        },
        {
          ...rule("shipping-fields-df696276", "The shipping address form validates its required fields.", {
            object: "shipping address form",
            property: "validation",
            operator: "eq",
            value: "required",
            valueType: "boolean",
          }),
          evidenceRefs: [evidenceRef(quote)],
        },
      ],
    }));

    expect(result.knowledgeBase.businessRules).toHaveLength(1);
    expect(result.knowledgeBase.businessRules[0].id).toBe("shipping-fields");
    expect(result.knowledgeBase.businessRules[0].constraint).toBeDefined();
    expect(result.counters).toMatchObject({
      paraphraseMergeCount: 1,
      evidenceOnlyParaphraseMergeCount: 1,
      rekeyCount: 0,
      possibleTensionCount: 0,
    });
  });

  it("keeps a genuinely distinct rekeyed twin without re-rekeying it", () => {
    const base = knowledgeBase({
      businessRules: [
        rule("checkout", "Checkout should be intuitive."),
        rule("checkout-0a1b2c3d", "Checkout must expose an express lane for returning customers."),
      ],
    });
    const first = resolveProjectKnowledgeDuplicateIdentities(base);
    const second = resolveProjectKnowledgeDuplicateIdentities(first.knowledgeBase);

    expect(first.knowledgeBase.businessRules.map((entry) => entry.id).sort()).toEqual([
      "checkout",
      "checkout-0a1b2c3d",
    ]);
    expect(first.counters).toMatchObject({ paraphraseMergeCount: 0, rekeyCount: 0, possibleTensionCount: 1 });
    expect(second.knowledgeBase).toEqual(first.knowledgeBase);
    expect(second.counters).toMatchObject({ rekeyCount: 0 });
  });

  it("never strips an author id that merely looks rekeyed", () => {
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      businessRules: [
        rule("audit-deadbeef", "Audit entries are retained for review."),
        rule("audit-cafebabe", "Audit exports include reviewer names."),
      ],
    }));

    expect(result.knowledgeBase.businessRules.map((entry) => entry.id).sort()).toEqual([
      "audit-cafebabe",
      "audit-deadbeef",
    ]);
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 0, rekeyCount: 0, possibleTensionCount: 0 });
  });

  it("merges hierarchy-compatible dependencies with identical evidence", () => {
    const sharedEvidence = [evidenceRef("Checkout calls the payment gateway.")];
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      crossDependencies: [
        {
          id: "checkout-payment",
          sourceModule: "Checkout",
          targetModule: "Payment Gateway",
          dependencyType: "dependency",
          description: "Checkout uses payment gateway.",
          sourceWorkItemIds: ["1"],
          evidence: "Checkout calls the payment gateway.",
          evidenceRefs: sharedEvidence,
        },
        {
          id: "checkout-payment",
          sourceModule: "Checkout",
          targetModule: "Payment Gateway",
          dependencyType: "external service dependency",
          description: "Checkout calls payment gateway.",
          sourceWorkItemIds: ["1"],
          evidence: "Checkout calls the payment gateway.",
          evidenceRefs: sharedEvidence,
        },
      ],
    }));

    expect(result.knowledgeBase.crossDependencies).toEqual([
      expect.objectContaining({ dependencyType: "external service dependency" }),
    ]);
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0 });
  });

  it("re-keys non-matching state targets so their hard conflict remains visible", () => {
    const result = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({
      stateTransitions: [
        {
          id: "manager-review",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Approved",
          triggerOrCondition: "Manager reviews",
          sourceWorkItemIds: ["1"],
          evidence: "Approved",
          evidenceRefs: [evidenceRef("Approved")],
        },
        {
          id: "manager-review",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Rejected",
          triggerOrCondition: "Manager reviews",
          sourceWorkItemIds: ["2"],
          evidence: "Rejected",
          evidenceRefs: [evidenceRef("Rejected")],
        },
      ],
    }));

    expect(result.knowledgeBase.stateTransitions.map((entry) => entry.id)).toEqual([
      "manager-review",
      expect.stringMatching(/^manager-review-[a-f0-9]{8}$/),
    ]);
    expect(detectProjectKnowledgeHardConflicts(result.knowledgeBase)).toEqual([
      expect.objectContaining({ conflictType: "incompatible_transition_target" }),
    ]);
  });

  it("is idempotent and deterministic across input permutations", () => {
    const entries = [
      rule("notification", "Primary purchase button must be enabled.", {
        object: "purchase notification", property: "primary button", operator: "eq", value: "enabled", valueType: "boolean",
      }),
      rule("notification", "Secondary purchase button must be enabled.", {
        object: "purchase notification", property: "secondary button", operator: "eq", value: "enabled", valueType: "boolean",
      }),
      rule("download-loading", "Download loading indicator must be enabled.", {
        object: "download loading", property: "indicator", operator: "eq", value: "enabled", valueType: "boolean",
      }),
      rule("download-loading", "Download loading spinner must be enabled.", {
        object: "download loading", property: "spinner", operator: "eq", value: "enabled", valueType: "boolean",
      }),
    ];
    const first = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({ businessRules: entries }));
    const permuted = resolveProjectKnowledgeDuplicateIdentities(knowledgeBase({ businessRules: [...entries].reverse() }));
    const secondPass = resolveProjectKnowledgeDuplicateIdentities(first.knowledgeBase);

    expect(permuted.knowledgeBase).toEqual(first.knowledgeBase);
    expect(permuted.possibleTensions).toEqual(first.possibleTensions);
    expect(secondPass.knowledgeBase).toEqual(first.knowledgeBase);
    expect(secondPass.counters).toMatchObject({
      preConsolidationDuplicateIdentityCount: 0,
      paraphraseMergeCount: 0,
      rekeyCount: 0,
    });
  });
});
