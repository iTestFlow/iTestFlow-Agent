import { describe, expect, it } from "vitest";

import type { ProjectKnowledgeBase, ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import { mergeProjectKnowledgeConflictEntries } from "./project-knowledge-consolidation";

function evidenceRef(
  sourceWorkItemId: string,
  sourceSnapshotId: string,
  quote: string,
): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId,
    sourceWorkItemId,
    sourceField: "description",
    quote,
    origin: "generated_v2",
    verification: "exact",
  };
}

describe("mergeProjectKnowledgeConflictEntries", () => {
  it("uses deterministic module semantics and unions evidence provenance", () => {
    const entries: ProjectKnowledgeBase["modules"] = [
      {
        id: "mod-checkout",
        name: "Checkout",
        description: "Handles checkout.",
        sourceWorkItemIds: ["10"],
        evidence: "Checkout exists.",
        evidenceRefs: [evidenceRef("10", "snapshot-10", "Checkout exists.")],
      },
      {
        id: "MOD_CHECKOUT",
        name: "Checkout and payment",
        description: "Handles checkout, payment, and confirmation.",
        sourceWorkItemIds: ["11"],
        evidence: "Payment is collected during checkout.",
        evidenceRefs: [evidenceRef("11", "snapshot-11", "Payment is collected during checkout.")],
      },
    ];

    const merged = mergeProjectKnowledgeConflictEntries("module", entries);

    expect(merged).toEqual({
      id: "mod-checkout",
      name: "Checkout and payment",
      description: "Handles checkout, payment, and confirmation.",
      sourceWorkItemIds: ["10", "11"],
      evidence: "Checkout exists. | Payment is collected during checkout.",
      evidenceRefs: [
        evidenceRef("10", "snapshot-10", "Checkout exists."),
        evidenceRef("11", "snapshot-11", "Payment is collected during checkout."),
      ],
    });
  });

  it("applies the glossary preference policy while retaining all sources", () => {
    const entries: ProjectKnowledgeBase["glossary"] = [
      {
        term: "Customer",
        type: "term",
        definition: "A buyer.",
        sourceWorkItemIds: ["10"],
        evidence: "Customer buys.",
      },
      {
        term: "Customer",
        type: "business_entity",
        definition: "A person or organization that buys products.",
        sourceWorkItemIds: ["11"],
        evidence: "Customer owns an order.",
      },
    ];

    expect(mergeProjectKnowledgeConflictEntries("glossary", entries)).toEqual({
      term: "Customer",
      type: "business_entity",
      definition: "A person or organization that buys products.",
      sourceWorkItemIds: ["10", "11"],
      evidence: "Customer buys. | Customer owns an order.",
      evidenceRefs: undefined,
    });
  });

  it("keeps the longest deterministic rule wording and unions canonical module associations", () => {
    const entries: ProjectKnowledgeBase["businessRules"] = [
      {
        id: "br-notify",
        rule: "The customer receives a notification.",
        sourceField: "acceptanceCriteria",
        moduleName: "Checkout Flow",
        moduleAssociations: ["Customer Portal"],
        sourceWorkItemIds: ["10"],
        evidence: "A customer receives a notification.",
      },
      {
        id: "br-notify",
        rule: "A notification is sent to the customer after checkout.",
        sourceField: "acceptanceCriteria",
        moduleName: "Payments",
        moduleAssociations: ["checkout-flow", "Notification Center"],
        sourceWorkItemIds: ["11"],
        evidence: "A notification is sent after checkout.",
      },
    ];

    expect(mergeProjectKnowledgeConflictEntries("business_rule", entries)).toMatchObject({
      rule: "A notification is sent to the customer after checkout.",
      moduleName: "checkout-flow",
      moduleAssociations: ["checkout-flow", "customer-portal", "notification-center", "payments"],
    });

    expect(mergeProjectKnowledgeConflictEntries("business_rule", [entries[1]])).toMatchObject({
      moduleName: "checkout-flow",
      moduleAssociations: ["checkout-flow", "notification-center", "payments"],
    });
  });

  it("retains an available structured constraint deterministically", () => {
    const structured: ProjectKnowledgeBase["businessRules"][number] = {
      id: "br-submit",
      rule: "Submit button must be enabled.",
      sourceField: "acceptanceCriteria",
      moduleName: "Checkout",
      constraint: {
        object: "submit",
        property: "button",
        operator: "eq",
        value: "enabled",
        valueType: "boolean",
      },
      sourceWorkItemIds: ["10"],
      evidence: "Submit button must be enabled.",
    };
    const longerWithoutConstraint: ProjectKnowledgeBase["businessRules"][number] = {
      ...structured,
      rule: "The submit button must be enabled after checkout validation.",
      constraint: undefined,
      sourceWorkItemIds: ["11"],
    };

    const forward = mergeProjectKnowledgeConflictEntries("business_rule", [longerWithoutConstraint, structured]);
    const reverse = mergeProjectKnowledgeConflictEntries("business_rule", [structured, longerWithoutConstraint]);

    expect(forward).toMatchObject({
      rule: "The submit button must be enabled after checkout validation.",
      constraint: {
        object: "submit",
        property: "button",
        operator: "eq",
        value: "true",
        valueType: "boolean",
      },
    });
    expect(reverse.constraint).toEqual(forward.constraint);
  });

  it("keeps the most-specific dependency type regardless of merge order", () => {
    const generic: ProjectKnowledgeBase["crossDependencies"][number] = {
      id: "dep-payment",
      sourceModule: "Checkout",
      targetModule: "Payment Service",
      dependencyType: "dependency",
      description: "Checkout relies on the payment service.",
      sourceWorkItemIds: ["10"],
      evidence: "Checkout relies on payment.",
    };
    const specific: ProjectKnowledgeBase["crossDependencies"][number] = {
      ...generic,
      dependencyType: "external service dependency",
      sourceWorkItemIds: ["11"],
    };

    expect(mergeProjectKnowledgeConflictEntries("dependency", [generic, specific]).dependencyType)
      .toBe("external service dependency");
    expect(mergeProjectKnowledgeConflictEntries("dependency", [specific, generic]).dependencyType)
      .toBe("external service dependency");
  });
});
