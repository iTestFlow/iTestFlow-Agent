import { describe, expect, it } from "vitest";

import { normalizeProjectKnowledgeRuleFingerprint } from "./project-knowledge-atomic-constraint";
import { detectProjectKnowledgeHardConflicts } from "./project-knowledge-conflicts";
import {
  hasProjectKnowledgeDuplicateLogicalIdentities,
  resolveProjectKnowledgeDuplicateIdentities,
} from "./project-knowledge-duplicate-resolution";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

/**
 * These inputs are reduced from the frozen v4.0 blocked-draft payloads that
 * prompted the v4.1 design. Evidence handles are fixture-local, while the
 * claim text, identities, and dependency labels remain the persisted ones.
 */
function evidenceRef(quote: string, sourceId: string): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId: `snapshot-${sourceId}`,
    sourceWorkItemId: sourceId,
    sourceField: "acceptanceCriteria",
    quote,
    origin: "generated_v4",
    verification: "exact",
  };
}

function businessRule(input: {
  id: string;
  rule: string;
  moduleName: string;
  sourceId: string;
  constraint?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    rule: input.rule,
    moduleName: input.moduleName,
    sourceField: "acceptanceCriteria" as const,
    sourceWorkItemIds: [input.sourceId],
    evidence: input.rule,
    evidenceRefs: [evidenceRef(input.rule, input.sourceId)],
    ...(input.constraint ? { constraint: input.constraint } : {}),
  };
}

function dependency(input: {
  id: string;
  sourceModule: string;
  targetModule: string;
  dependencyType: string;
  description: string;
  evidenceKey: string;
  evidenceQuote?: string;
}) {
  const quote = input.evidenceQuote ?? input.description;
  return {
    id: input.id,
    sourceModule: input.sourceModule,
    targetModule: input.targetModule,
    dependencyType: input.dependencyType,
    description: input.description,
    sourceWorkItemIds: [input.evidenceKey],
    evidence: quote,
    evidenceRefs: [evidenceRef(quote, input.evidenceKey)],
  };
}

function resolveFixture(partial: Record<string, unknown>) {
  const result = resolveProjectKnowledgeDuplicateIdentities(ProjectKnowledgeBaseSchema.parse({
    modules: [],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
    ...partial,
  }));
  expect(detectProjectKnowledgeHardConflicts(result.knowledgeBase)).toEqual([]);
  expect(hasProjectKnowledgeDuplicateLogicalIdentities(result.knowledgeBase)).toBe(false);
  return result;
}

describe("project knowledge v4.1 frozen-draft behavioral fixtures", () => {
  it("merges Quote Timeout Popup wording while preserving its separate trigger rule", () => {
    const result = resolveFixture({
      businessRules: [
        businessRule({
          id: "br-quote-timeout-popup-non-dismissible",
          rule: "The quote timeout popup must be non-dismissible, with no close X and no overlay click-through; the user must select one of the available actions.",
          moduleName: "Quote Expiry Management",
          sourceId: "366149-a",
          constraint: {
            object: "quote timeout popup", property: "dismissible", operator: "eq", value: "false", valueType: "boolean",
          },
        }),
        businessRule({
          id: "br-quote-timeout-popup-non-dismissible",
          rule: "The quote timeout popup is non-dismissible; it has no close X and no overlay click-through, and the user must select one of the available actions.",
          moduleName: "Quote Expiry Management",
          sourceId: "366149-b",
          constraint: {
            object: "quote timeout popup", property: "dismissible", operator: "eq", value: "false", valueType: "boolean",
          },
        }),
        businessRule({
          id: "br-timeout-trigger-frontend-only",
          rule: "The quote timeout popup must be triggered exclusively by the front-end timer reaching zero on Step 4 or Step 5, and not by backend errors.",
          moduleName: "Quote Expiry Management",
          sourceId: "366149-c",
        }),
      ],
    });

    expect(result.knowledgeBase.businessRules).toHaveLength(2);
    expect(result.knowledgeBase.businessRules.map((entry) => entry.id)).toEqual([
      "br-quote-timeout-popup-non-dismissible",
      "br-timeout-trigger-frontend-only",
    ]);
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0, possibleTensionCount: 0 });
  });

  it("merges Masked Card Number wording and retains both module associations", () => {
    const result = resolveFixture({
      businessRules: [
        businessRule({
          id: "br-masked-card-number",
          rule: "Card numbers must be displayed with all but the last 4 digits masked, for example **** **** **** 1234.",
          moduleName: "Payment Retrials Tab",
          sourceId: "367569",
          constraint: {
            object: "card number", property: "masking", operator: "eq", value: "true", valueType: "boolean",
          },
        }),
        businessRule({
          id: "br-masked-card-number",
          rule: "Card numbers are displayed with all but the last 4 digits masked, for example **** **** **** 1234.",
          moduleName: "Policy Details",
          sourceId: "360500",
          constraint: {
            object: "card number", property: "masking", operator: "eq", value: "true", valueType: "boolean",
          },
        }),
      ],
    });

    expect(result.knowledgeBase.businessRules).toEqual([
      expect.objectContaining({
        id: "br-masked-card-number",
        moduleName: "Payment Retrials Tab",
        moduleAssociations: ["Payment Retrials Tab", "Policy Details"],
        sourceWorkItemIds: ["360500", "367569"],
      }),
    ]);
    expect(result.knowledgeBase.businessRules[0]?.evidenceRefs).toHaveLength(2);
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0, possibleTensionCount: 0 });
  });

  it("re-keys the Purchase Notification button variants and records a non-blocking tension", () => {
    const first = "Download Policy is enabled only when the policy document has been issued and the document URL is available; if policy status is Pending, it is disabled with a tooltip explaining that the document is not yet available.";
    const second = "Download Policy is enabled only when the policy document URL has been received and stored from the insurance company's purchase notification response; otherwise it is disabled with a tooltip.";
    expect(normalizeProjectKnowledgeRuleFingerprint(first)).not.toBe(normalizeProjectKnowledgeRuleFingerprint(second));

    const result = resolveFixture({
      businessRules: [
        businessRule({ id: "br-download-policy-availability", rule: first, moduleName: "Policy Document Downloads", sourceId: "360014-a" }),
        businessRule({ id: "br-download-policy-availability", rule: second, moduleName: "Policy Document Downloads", sourceId: "360014-b" }),
      ],
    });

    expect(result.knowledgeBase.businessRules).toHaveLength(2);
    expect(result.counters).toMatchObject({ rekeyCount: 1, possibleTensionCount: 1 });
    expect(result.possibleTensions).toEqual([
      expect.objectContaining({ category: "business_rule", reason: "fingerprint_mismatch" }),
    ]);
  });

  it("keeps the Download Loading variants separate when their frozen fingerprints differ", () => {
    const first = "While quotes are being fetched from the aggregator, a loading skeleton or spinner is displayed in place of the quote list; the sort dropdown and expiry timer are hidden until at least one quote is received.";
    const second = "While quotes are being fetched from the aggregator, display a loading skeleton/spinner in place of the quote list, and hide the sort dropdown and expiry timer until at least one quote is received.";
    expect(normalizeProjectKnowledgeRuleFingerprint(first)).not.toBe(normalizeProjectKnowledgeRuleFingerprint(second));

    const result = resolveFixture({
      businessRules: [
        businessRule({ id: "br-loading-quotes-state", rule: first, moduleName: "Quote List", sourceId: "358867-a" }),
        businessRule({ id: "br-loading-quotes-state", rule: second, moduleName: "Quote List", sourceId: "358867-b" }),
      ],
    });

    expect(result.knowledgeBase.businessRules).toHaveLength(2);
    expect(result.counters).toMatchObject({ rekeyCount: 1, possibleTensionCount: 1 });
  });

  it("merges the Quote Receiving to Aggregator dependency through the generic hierarchy level", () => {
    const result = resolveFixture({
      crossDependencies: [
        dependency({
          id: "dep-quote-receiving-aggregator",
          sourceModule: "Quote Receiving",
          targetModule: "Aggregator",
          dependencyType: "quote request dependency",
          description: "The quote receiving waiting period starts immediately after the request is sent to the aggregator.",
          evidenceKey: "quote-receiving-aggregator",
          evidenceQuote: "Quote Receiving waiting period starts immediately after the request is sent to the aggregator.",
        }),
        dependency({
          id: "dep-quote-receiving-aggregator",
          sourceModule: "Quote Receiving",
          targetModule: "Aggregator",
          dependencyType: "integration",
          description: "The quote receiving waiting period starts immediately after the quote request is sent to the aggregator.",
          evidenceKey: "quote-receiving-aggregator",
          evidenceQuote: "Quote Receiving waiting period starts immediately after the request is sent to the aggregator.",
        }),
      ],
    });

    expect(result.knowledgeBase.crossDependencies).toEqual([
      expect.objectContaining({ dependencyType: "quote request dependency" }),
    ]);
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0 });
  });

  it("merges the Quote Receiving to Insurance Company dependency through the generic hierarchy level", () => {
    const result = resolveFixture({
      crossDependencies: [
        dependency({
          id: "dep-quote-receiving-insurance-company",
          sourceModule: "Quote Receiving",
          targetModule: "Insurance company",
          dependencyType: "quote response dependency",
          description: "The waiting period can end when all active insurance companies have returned their quotes.",
          evidenceKey: "quote-receiving-insurance-company",
          evidenceQuote: "Quote Receiving waiting period can end when all active insurance companies have returned their quotes.",
        }),
        dependency({
          id: "dep-quote-receiving-insurance-company",
          sourceModule: "Quote Receiving",
          targetModule: "Insurance company",
          dependencyType: "integration",
          description: "Quote Receiving waiting period can end when all active insurance companies have returned their quotes.",
          evidenceKey: "quote-receiving-insurance-company",
          evidenceQuote: "Quote Receiving waiting period can end when all active insurance companies have returned their quotes.",
        }),
      ],
    });

    expect(result.knowledgeBase.crossDependencies).toEqual([
      expect.objectContaining({ dependencyType: "quote response dependency" }),
    ]);
    expect(result.counters).toMatchObject({ paraphraseMergeCount: 1, rekeyCount: 0 });
  });

  it("re-keys Political Declaration to Payment Service when its persisted types are non-hierarchical", () => {
    const result = resolveFixture({
      crossDependencies: [
        dependency({
          id: "dep-political-declaration-unified-payment-service",
          sourceModule: "Political Declaration",
          targetModule: "Unified payment service",
          dependencyType: "data_exclusion",
          description: "Political Declaration answers are saved against the application record and are not sent to the unified payment service.",
          evidenceKey: "political-declaration-payment-service",
          evidenceQuote: "Political Declaration answers are not sent to the unified payment service.",
        }),
        dependency({
          id: "dep-political-declaration-unified-payment-service",
          sourceModule: "Political Declaration",
          targetModule: "Unified payment service",
          dependencyType: "exclusion",
          description: "Political Declaration answers are not sent to the unified payment service.",
          evidenceKey: "political-declaration-payment-service",
          evidenceQuote: "Political Declaration answers are not sent to the unified payment service.",
        }),
      ],
    });

    expect(result.knowledgeBase.crossDependencies).toHaveLength(2);
    expect(result.counters).toMatchObject({ rekeyCount: 1, possibleTensionCount: 0 });
  });
});
