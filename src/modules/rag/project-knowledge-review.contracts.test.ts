import { describe, expect, it } from "vitest";

import {
  normalizeProjectKnowledgeBlockers,
  projectKnowledgeBlockerId,
  summarizeProjectKnowledgeReview,
} from "./project-knowledge-review.contracts";

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
    })).toEqual({
      attemptedEvidenceRepairs: 5,
      automaticEvidenceRepairs: 2,
      automaticDuplicateConsolidations: 13,
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
    })).toMatchObject({
      attemptedEvidenceRepairs: 0,
      automaticEvidenceRepairs: 0,
      automaticDuplicateConsolidations: 0,
      unresolvedEvidenceEntries: 0,
    });
  });
});
