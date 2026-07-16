import { describe, expect, it } from "vitest";

import { detectProjectKnowledgeHardConflicts, sortProjectKnowledgeHardConflictsForReview } from "./project-knowledge-conflicts";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

function evidenceRef(snapshot: string, workItem: string, quote = "Supported quote"): ProjectKnowledgeEvidenceRef {
  return {
    sourceSnapshotId: snapshot,
    sourceWorkItemId: workItem,
    sourceField: "acceptanceCriteria",
    quote,
    origin: "generated_v2",
    verification: "exact",
  };
}

function businessRule(
  id: string,
  rule: string,
  snapshot: string,
  moduleName?: string,
) {
  return {
    id,
    rule,
    sourceField: "acceptanceCriteria",
    ...(moduleName ? { moduleName } : {}),
    sourceWorkItemIds: [snapshot],
    evidence: rule,
    evidenceRefs: [evidenceRef(snapshot, snapshot, rule)],
  };
}

describe("deterministic hard conflicts", () => {
  it("only blocks a proven same-slot atomic value contradiction", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        businessRule("br-1", "Retry count must be 3", "s1", "Payments"),
        businessRule("br-2", "Retry count must be 5", "s2", " payments "),
      ],
    });

    const conflicts = detectProjectKnowledgeHardConflicts(knowledge);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictType: "incompatible_concrete_value",
      subject: "payments:retry.count",
      affectedCategory: "business_rule",
      conflictBasis: {
        object: "retry",
        property: "count",
        values: [
          expect.objectContaining({ value: "3", valueType: "number" }),
          expect.objectContaining({ value: "5", valueType: "number" }),
        ],
      },
    });
    expect(conflicts[0]?.participants.map((participant) => participant.concreteValue)).toEqual(["3", "5"]);
  });

  it("does not manufacture conflicts from compatible bounds or incomparable units", () => {
    const compatible = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        businessRule("br-1", "Retry count must be at most 30", "s1"),
        businessRule("br-2", "Retry count must be 20", "s2"),
        businessRule("br-3", "Retry count must be at least 20", "s3"),
      ],
    });
    const incompatibleUnits = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        businessRule("br-1", "Timeout must be at most 30 seconds", "s1"),
        businessRule("br-2", "Timeout must be 45 minutes", "s2"),
      ],
    });

    expect(detectProjectKnowledgeHardConflicts(compatible)).toEqual([]);
    expect(detectProjectKnowledgeHardConflicts(incompatibleUnits)).toEqual([]);
  });

  it("still blocks a bound when an equal point violates it", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        businessRule("br-1", "Retry count must be at most 30", "s1"),
        businessRule("br-2", "Retry count must be 45", "s2"),
      ],
    });

    expect(detectProjectKnowledgeHardConflicts(knowledge)).toEqual([
      expect.objectContaining({
        conflictType: "incompatible_concrete_value",
        conflictBasis: expect.objectContaining({
          values: expect.arrayContaining([
            expect.objectContaining({ operator: "lte", value: "30" }),
            expect.objectContaining({ operator: "eq", value: "45" }),
          ]),
        }),
      }),
    ]);
  });

  it("does not surface a duplicate identity as a hard conflict", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        businessRule("same-id", "Customers can request refunds through support.", "s1"),
        businessRule("same-id", "Refunds can be requested through the support team.", "s2"),
      ],
      modules: [
        { id: "Payments", name: "Payments", description: "First", sourceWorkItemIds: ["1"], evidence: "First" },
        { id: "payments", name: "Payment processing", description: "Second", sourceWorkItemIds: ["2"], evidence: "Second" },
      ],
    });

    expect(detectProjectKnowledgeHardConflicts(knowledge)).toEqual([]);
  });

  it("keeps divergent state-transition targets as conflicts", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      stateTransitions: [
        {
          id: "st-1",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Approved",
          triggerOrCondition: "Manager reviews",
          sourceWorkItemIds: ["1"],
          evidence: "approved",
          evidenceRefs: [evidenceRef("s1", "1", "approved")],
        },
        {
          id: "st-2",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Rejected",
          triggerOrCondition: "Manager reviews",
          sourceWorkItemIds: ["2"],
          evidence: "rejected",
          evidenceRefs: [evidenceRef("s2", "2", "rejected")],
        },
      ],
    });

    expect(detectProjectKnowledgeHardConflicts(knowledge)[0]).toMatchObject({
      conflictType: "incompatible_transition_target",
      subject: "order:pending:manager reviews",
      affectedCategory: "state_transition",
    });
  });

  it("keeps conflict identities and participant order stable when input order changes", () => {
    const rules = [
      businessRule("br-1", "Timeout is 10", "s1"),
      businessRule("br-2", "Timeout is 20", "s2"),
    ];
    const first = detectProjectKnowledgeHardConflicts(ProjectKnowledgeBaseSchema.parse({ businessRules: rules }))[0];
    const second = detectProjectKnowledgeHardConflicts(ProjectKnowledgeBaseSchema.parse({ businessRules: [...rules].reverse() }))[0];

    expect(second?.identityKey).toBe(first?.identityKey);
    expect(second?.participants.map((participant) => participant.participantId))
      .toEqual(first?.participants.map((participant) => participant.participantId));
  });

  it("orders evidence-identical conflicts after genuine disagreements for review", () => {
    const conflictStub = (identityKey: string, evidenceIdentical: boolean) => ({
      identityKey,
      subject: identityKey,
      affectedCategory: "business_rule" as const,
      conflictType: "incompatible_concrete_value" as const,
      participants: [],
      evidenceIdentical,
    });

    const sorted = sortProjectKnowledgeHardConflictsForReview([
      conflictStub("a-identical", true),
      conflictStub("b-real", false),
      conflictStub("c-identical", true),
      conflictStub("d-real", false),
    ]);

    expect(sorted.map((conflict) => conflict.identityKey))
      .toEqual(["b-real", "d-real", "a-identical", "c-identical"]);
  });
});
