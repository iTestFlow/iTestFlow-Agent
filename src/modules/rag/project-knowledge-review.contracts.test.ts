import { describe, expect, it } from "vitest";

import {
  findProjectKnowledgeEntryInstance,
  normalizeProjectKnowledgeBlockers,
  projectKnowledgeBlockerId,
  projectKnowledgeEntryInstanceId,
  projectKnowledgeEntryInstances,
  summarizeProjectKnowledgeReview,
} from "./project-knowledge-review.contracts";
import { flattenProjectKnowledgeSemanticEntries } from "./project-knowledge-contracts";

describe("project knowledge review contracts", () => {
  it("creates stable encoded blocker identities with fallbacks", () => {
    expect(projectKnowledgeBlockerId({
      type: "quote mismatch",
      category: "business_rule",
      identityKey: "promo code",
      operationId: "operation/1",
    })).toBe("quote%20mismatch:business_rule:promo%20code:operation%2F1");
    expect(projectKnowledgeBlockerId({ type: "missing_evidence_refs" }))
      .toBe("missing_evidence_refs:unknown:unknown:");
  });

  it("adds entry and evidence discriminators to collision-safe blocker identities", () => {
    const first = projectKnowledgeBlockerId({
      type: "quote_mismatch",
      category: "glossary",
      entryKey: "payment gateway",
      entryInstanceId: "instance-one",
      sourceSnapshotId: "snapshot-1",
      sourceWorkItemId: "1",
      sourceField: "description",
      referenceIdentity: "ref-one",
    });
    const second = projectKnowledgeBlockerId({
      type: "quote_mismatch",
      category: "glossary",
      entryKey: "payment gateway",
      entryInstanceId: "instance-two",
      sourceSnapshotId: "snapshot-1",
      sourceWorkItemId: "1",
      sourceField: "description",
      referenceIdentity: "ref-two",
    });

    expect(first).not.toBe(second);
    expect(first).toContain("entry%3Dinstance-one");
    expect(first).toContain("reference%3Dref-one");
  });

  it("derives browser-safe semantic/provenance entry identities for exact lookup", () => {
    const knowledgeBase = {
      modules: [],
      businessRules: [],
      stateTransitions: [],
      glossary: [
        {
          term: "Payment Gateway",
          type: "system" as const,
          definition: "Routes card payments.",
          sourceWorkItemIds: ["10"],
          evidence: "Routes card payments.",
        },
        {
          term: "Payment Gateway",
          type: "system" as const,
          definition: "Routes bank transfers.",
          sourceWorkItemIds: ["11"],
          evidence: "Routes bank transfers.",
        },
      ],
      crossDependencies: [],
    };
    const firstPass = projectKnowledgeEntryInstances(knowledgeBase);
    const secondPass = projectKnowledgeEntryInstances(structuredClone(knowledgeBase));

    expect(firstPass.map((entry) => entry.entryInstanceId))
      .toEqual(secondPass.map((entry) => entry.entryInstanceId));
    expect(new Set(firstPass.map((entry) => entry.entryInstanceId)).size).toBe(2);
    expect(firstPass.every((entry) => entry.entryInstanceId.startsWith("pkei_"))).toBe(true);
    expect(flattenProjectKnowledgeSemanticEntries(knowledgeBase).map(projectKnowledgeEntryInstanceId).sort())
      .toEqual(firstPass.map((entry) => entry.entryInstanceId).sort());
    expect(findProjectKnowledgeEntryInstance(knowledgeBase, firstPass[1].entryInstanceId)?.entry)
      .toMatchObject({ definition: "Routes bank transfers.", sourceWorkItemIds: ["11"] });
  });

  it("normalizes every supported blocker shape and discards malformed values", () => {
    const blockers = normalizeProjectKnowledgeBlockers([
      null,
      [],
      "invalid",
      { type: "unknown_type" },
      {
        type: "replay_conflict",
        category: "dependency",
        entryKey: "checkout-shipping",
        operationId: "operation-1",
        result: "semantic_conflict",
        base: { description: "base" },
        latest: { description: "latest" },
        proposed: ["not-an-object"],
      },
      {
        type: "hard_conflict",
        identityKey: "order-status",
        affectedCategory: "state_transition",
        participants: [{ entryKey: "paid", category: "state_transition" }, null, [], "bad"],
        conflictBasis: {
          object: "order",
          property: "status",
          values: [{
            participantId: "participant-1",
            operator: "eq",
            value: "paid",
            valueType: "state",
          }],
        },
      },
      {
        id: "source-field-id",
        type: "invalid_business_rule_source_field",
        category: "not-real",
        entryKey: "rule-1",
        sourceWorkItemIds: ["42", 7],
        message: "Choose an allowed field.",
      },
      {
        type: "quote_mismatch",
        category: "glossary",
        entryKey: "Customer",
        sourceWorkItemIds: ["42"],
        sourceWorkItemId: "43",
        sourceSnapshotId: "snapshot-43",
        sourceField: "description",
      },
      {
        type: "missing_evidence_refs",
        category: "module",
        entryKey: "checkout",
      },
    ]);

    expect(blockers).toHaveLength(5);
    expect(blockers[0]).toMatchObject({
      type: "replay_conflict",
      category: "dependency",
      entryKey: "checkout-shipping",
      proposed: null,
      actions: ["keep_latest", "use_proposed", "edit_proposed"],
      message: "Choose which version should be kept in the reviewed proposal.",
    });
    expect(blockers[1]).toMatchObject({
      type: "hard_conflict",
      category: "hard_conflict",
      entryKey: "order-status",
      subject: "order-status",
      conflictType: "contradiction",
      affectedCategory: "state_transition",
      participants: [{ entryKey: "paid", category: "state_transition" }],
      evidenceIdentical: false,
      conflictBasis: {
        object: "order",
        property: "status",
        values: [{
          participantId: "participant-1",
          operator: "eq",
          value: "paid",
          valueType: "state",
        }],
      },
    });
    expect(blockers[2]).toMatchObject({
      id: "source-field-id",
      type: "invalid_business_rule_source_field",
      category: "business_rule",
      sourceWorkItemIds: ["42"],
    });
    expect(blockers[3]).toMatchObject({
      type: "quote_mismatch",
      category: "glossary",
      sourceWorkItemIds: ["42", "43"],
      sourceSnapshotId: "snapshot-43",
      sourceWorkItemId: "43",
      sourceField: "description",
      message: "This entry must be reviewed before publication.",
    });
    expect(blockers[4]).toMatchObject({
      type: "missing_evidence_refs",
      message: "This entry needs at least one immutable evidence reference.",
      sourceWorkItemIds: [],
    });
  });

  it("coerces the evidence-identical flag strictly to a boolean", () => {
    const [truthy, stringly, missing] = normalizeProjectKnowledgeBlockers([
      { type: "hard_conflict", identityKey: "a", affectedCategory: "glossary", evidenceIdentical: true },
      { type: "hard_conflict", identityKey: "b", affectedCategory: "glossary", evidenceIdentical: "yes" },
      { type: "hard_conflict", identityKey: "c", affectedCategory: "glossary" },
    ]);

    expect(truthy).toMatchObject({ evidenceIdentical: true });
    expect(stringly).toMatchObject({ evidenceIdentical: false });
    expect(missing).toMatchObject({ evidenceIdentical: false });
  });

  it("normalizes legacy blocker identities and disambiguates persisted duplicate ids", () => {
    const blockers = normalizeProjectKnowledgeBlockers([
      {
        id: "legacy-duplicate",
        type: "missing_evidence_refs",
        category: "glossary",
        entryKey: "Payment Gateway",
        sourceWorkItemIds: ["10"],
      },
      {
        id: "legacy-duplicate",
        type: "missing_evidence_refs",
        category: "glossary",
        entryKey: "Payment Gateway",
        sourceWorkItemIds: ["11"],
      },
    ]);

    expect(blockers).toHaveLength(2);
    expect(blockers.every((blocker) => blocker.entryInstanceId?.startsWith("pkei_"))).toBe(true);
    expect(new Set(blockers.map((blocker) => blocker.entryInstanceId)).size).toBe(2);
    expect(new Set(blockers.map((blocker) => blocker.id)).size).toBe(2);
  });

  it("summarizes valid metrics and counts by type and category", () => {
    const blockers = normalizeProjectKnowledgeBlockers([
      { type: "missing_evidence_refs", category: "module", entryKey: "one" },
      { type: "missing_evidence_refs", category: "module", entryKey: "two" },
      { type: "hard_conflict", identityKey: "conflict", affectedCategory: "glossary" },
    ]);
    expect(summarizeProjectKnowledgeReview(blockers, {
      autoEvidenceRepairAttemptedCount: 5,
      autoEvidenceRepairCount: 2,
      autoEvidenceRepairUnresolvedCount: 3,
      automaticDuplicateConsolidationCount: 13,
      preConsolidationDuplicateIdentityCount: 7,
      paraphraseMergeCount: 6,
      rekeyCount: 5,
      atomicExtractionFailureCount: 4,
      possibleTensionCount: 3,
      wordingCarryOverCount: 4,
    })).toEqual({
      attemptedEvidenceRepairs: 5,
      automaticEvidenceRepairs: 2,
      automaticDuplicateConsolidations: 13,
      preConsolidationDuplicateIdentities: 7,
      paraphraseMerges: 6,
      rekeys: 5,
      atomicExtractionFailures: 4,
      possibleTensions: 3,
      wordingCarryOvers: 4,
      unresolvedEvidenceEntries: 3,
      remainingBlockers: 3,
      byType: { missing_evidence_refs: 2, hard_conflict: 1 },
      byCategory: { module: 2, glossary: 1 },
    });
  });

  it("ignores non-finite and non-number repair metrics", () => {
    expect(summarizeProjectKnowledgeReview([], {
      autoEvidenceRepairAttemptedCount: "4",
      autoEvidenceRepairCount: Number.NaN,
      autoEvidenceRepairUnresolvedCount: undefined,
      wordingCarryOverCount: "many",
    })).toMatchObject({
      attemptedEvidenceRepairs: 0,
      automaticEvidenceRepairs: 0,
      automaticDuplicateConsolidations: 0,
      preConsolidationDuplicateIdentities: 0,
      paraphraseMerges: 0,
      rekeys: 0,
      atomicExtractionFailures: 0,
      possibleTensions: 0,
      wordingCarryOvers: 0,
      unresolvedEvidenceEntries: 0,
    });
  });
});
