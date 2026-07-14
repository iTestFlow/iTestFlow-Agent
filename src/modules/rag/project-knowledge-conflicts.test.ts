import { describe, expect, it } from "vitest";

import { detectProjectKnowledgeHardConflicts, sortProjectKnowledgeHardConflictsForReview } from "./project-knowledge-conflicts";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

const evidenceRef = (snapshot: string, workItem: string): ProjectKnowledgeEvidenceRef => ({
  sourceSnapshotId: snapshot,
  sourceWorkItemId: workItem,
  sourceField: "acceptanceCriteria",
  quote: "Supported quote",
  origin: "generated_v2",
  verification: "exact",
});

describe("deterministic hard conflicts", () => {
  it("blocks incompatible concrete business-rule values on the same canonical subject", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        {
          id: "br-1",
          rule: "Maximum retry count must be 3",
          sourceField: "acceptanceCriteria",
          moduleName: "Payments",
          sourceWorkItemIds: ["1"],
          evidence: "retry count 3",
          evidenceRefs: [evidenceRef("s1", "1")],
        },
        {
          id: "br-2",
          rule: "Maximum retry count must be 5",
          sourceField: "acceptanceCriteria",
          moduleName: " payments ",
          sourceWorkItemIds: ["2"],
          evidence: "retry count 5",
          evidenceRefs: [evidenceRef("s2", "2")],
        },
      ],
    });
    const conflicts = detectProjectKnowledgeHardConflicts(knowledge);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictType: "incompatible_concrete_value",
      subject: "payments:maximum retry count",
      affectedCategory: "business_rule",
    });
    expect(conflicts[0].participants.map((participant) => participant.concreteValue)).toEqual(["3", "5"]);
    expect(conflicts[0].participants[0]).toMatchObject({
      participantId: expect.stringMatching(/^[a-f0-9]{64}$/),
      category: "business_rule",
      entryKey: "br-1",
      entry: expect.objectContaining({ id: "br-1", rule: "Maximum retry count must be 3" }),
      projection: {
        rule: "Maximum retry count must be 3",
        sourceField: "acceptanceCriteria",
        moduleName: "Payments",
      },
      semanticHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceRefs: [expect.objectContaining({ sourceSnapshotId: "s1" })],
      sourceSnapshotIds: ["s1"],
      sourceWorkItemIds: ["1"],
      evidence: "Supported quote",
    });
  });

  it("coalesces a same-ID business-rule duplicate into one concrete-value conflict", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        {
          id: "retry-limit",
          rule: "Maximum retry count must be 3",
          sourceField: "acceptanceCriteria",
          moduleName: "Payments",
          sourceWorkItemIds: ["1"],
          evidence: "retry count 3",
          evidenceRefs: [evidenceRef("s1", "1")],
        },
        {
          id: "retry-limit",
          rule: "Maximum retry count must be 5",
          sourceField: "acceptanceCriteria",
          moduleName: "Payments",
          sourceWorkItemIds: ["2"],
          evidence: "retry count 5",
          evidenceRefs: [evidenceRef("s2", "2")],
        },
      ],
    });

    const conflicts = detectProjectKnowledgeHardConflicts(knowledge);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictType: "incompatible_concrete_value",
      affectedCategory: "business_rule",
      participants: [
        expect.objectContaining({ entryKey: "retry-limit", concreteValue: "3" }),
        expect.objectContaining({ entryKey: "retry-limit", concreteValue: "5" }),
      ],
    });
  });

  it("blocks incompatible concrete transition targets", () => {
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
          evidenceRefs: [evidenceRef("s1", "1")],
        },
        {
          id: "st-2",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Rejected",
          triggerOrCondition: "Manager reviews",
          sourceWorkItemIds: ["2"],
          evidence: "rejected",
          evidenceRefs: [evidenceRef("s2", "2")],
        },
      ],
    });
    expect(detectProjectKnowledgeHardConflicts(knowledge)[0]).toMatchObject({
      conflictType: "incompatible_transition_target",
      subject: "order:pending:manager reviews",
      affectedCategory: "state_transition",
      participants: expect.arrayContaining([
        expect.objectContaining({ concreteValue: "approved" }),
        expect.objectContaining({ concreteValue: "rejected" }),
      ]),
    });
  });

  it("coalesces a same-ID transition duplicate into one transition-target conflict", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      stateTransitions: [
        {
          id: "manager-review",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Approved",
          triggerOrCondition: "Manager reviews",
          sourceWorkItemIds: ["1"],
          evidence: "approved",
          evidenceRefs: [evidenceRef("s1", "1")],
        },
        {
          id: "manager-review",
          workflowName: "Order",
          fromState: "Pending",
          toState: "Rejected",
          triggerOrCondition: "Manager reviews",
          sourceWorkItemIds: ["2"],
          evidence: "rejected",
          evidenceRefs: [evidenceRef("s2", "2")],
        },
      ],
    });

    const conflicts = detectProjectKnowledgeHardConflicts(knowledge);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictType: "incompatible_transition_target",
      affectedCategory: "state_transition",
      participants: [
        expect.objectContaining({ entryKey: "manager-review", concreteValue: "approved" }),
        expect.objectContaining({ entryKey: "manager-review", concreteValue: "rejected" }),
      ],
    });
  });

  it("retains an identity conflict when a specific conflict does not cover every participant", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        {
          id: "retry-limit",
          rule: "Maximum retry count must be 3",
          sourceField: "acceptanceCriteria",
          sourceWorkItemIds: ["1"],
          evidence: "retry count 3",
          evidenceRefs: [evidenceRef("s1", "1")],
        },
        {
          id: "retry-limit",
          rule: "Maximum retry count must be 5",
          sourceField: "acceptanceCriteria",
          sourceWorkItemIds: ["2"],
          evidence: "retry count 5",
          evidenceRefs: [evidenceRef("s2", "2")],
        },
        {
          id: "retry-limit",
          rule: "Retry limits are configurable",
          sourceField: "description",
          sourceWorkItemIds: ["3"],
          evidence: "configurable retry limits",
        },
      ],
    });

    const conflicts = detectProjectKnowledgeHardConflicts(knowledge);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((conflict) => conflict.conflictType).sort()).toEqual([
      "duplicate_identity",
      "incompatible_concrete_value",
    ]);
    expect(conflicts.find((conflict) => conflict.conflictType === "duplicate_identity")?.participants)
      .toHaveLength(3);
    expect(conflicts.find((conflict) => conflict.conflictType === "incompatible_concrete_value")?.participants)
      .toHaveLength(2);
  });

  it("leaves generic prose differences to lint and requires versioned evidence", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        { id: "br-1", rule: "Checkout should be intuitive", sourceField: "description", sourceWorkItemIds: ["1"], evidence: "A" },
        { id: "br-2", rule: "Checkout should be clear", sourceField: "description", sourceWorkItemIds: ["2"], evidence: "B" },
      ],
    });
    expect(detectProjectKnowledgeHardConflicts(knowledge)).toEqual([]);
  });

  it("keeps identity stable when participant order changes", () => {
    const rules = [
      {
        id: "br-1",
        rule: "Timeout is 10",
        sourceField: "acceptanceCriteria",
        sourceWorkItemIds: ["1"],
        evidence: "10",
        evidenceRefs: [evidenceRef("s1", "1")],
      },
      {
        id: "br-2",
        rule: "Timeout is 20",
        sourceField: "acceptanceCriteria",
        sourceWorkItemIds: ["2"],
        evidence: "20",
        evidenceRefs: [evidenceRef("s2", "2")],
      },
    ];
    const first = detectProjectKnowledgeHardConflicts(ProjectKnowledgeBaseSchema.parse({ businessRules: rules }))[0];
    const second = detectProjectKnowledgeHardConflicts(ProjectKnowledgeBaseSchema.parse({ businessRules: [...rules].reverse() }))[0];
    expect(second.identityKey).toBe(first.identityKey);
    expect(second.participants.map((participant) => participant.participantId))
      .toEqual(first.participants.map((participant) => participant.participantId));
  });

  it("does not flag logical identity aliases whose semantic projections are equal", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      modules: [
        {
          id: "MOD_AUTH",
          name: "Payments",
          description: "Processes payments",
          sourceWorkItemIds: ["1"],
          evidence: "First source",
          evidenceRefs: [evidenceRef("s1", "1")],
        },
        {
          id: "mod-auth",
          name: "Payments",
          description: "Processes payments",
          sourceWorkItemIds: ["2"],
          evidence: "Second source",
          evidenceRefs: [evidenceRef("s2", "2")],
        },
      ],
    });

    expect(detectProjectKnowledgeHardConflicts(knowledge)).toEqual([]);
  });

  it("flags logical identity aliases when their semantic projections materially differ", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      modules: [
        {
          id: "MOD_AUTH",
          name: "Authentication",
          description: "Handles password login",
          sourceWorkItemIds: ["1"],
          evidence: "Password login source",
          evidenceRefs: [evidenceRef("s1", "1")],
        },
        {
          id: "mod-auth",
          name: "Authentication and authorization",
          description: "Handles access policies",
          sourceWorkItemIds: ["2"],
          evidence: "Access policy source",
          evidenceRefs: [evidenceRef("s2", "2")],
        },
      ],
    });

    expect(detectProjectKnowledgeHardConflicts(knowledge)).toEqual([
      expect.objectContaining({
        conflictType: "duplicate_identity",
        subject: "identity:module:mod-auth",
        affectedCategory: "module",
        participants: expect.arrayContaining([
          expect.objectContaining({ entryKey: "mod_auth", entry: expect.objectContaining({ id: "MOD_AUTH" }) }),
          expect.objectContaining({ entryKey: "mod-auth", entry: expect.objectContaining({ id: "mod-auth" }) }),
        ]),
      }),
    ]);
  });

  it("treats duplicate canonical entry keys as hard identity conflicts", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      modules: [
        { id: "Payments", name: "Payments", description: "First", sourceWorkItemIds: ["1"], evidence: "First" },
        { id: " payments ", name: "Payment processing", description: "Second", sourceWorkItemIds: ["2"], evidence: "Second" },
      ],
    });

    expect(detectProjectKnowledgeHardConflicts(knowledge)).toEqual([
      expect.objectContaining({
        conflictType: "duplicate_identity",
        subject: "identity:module:payments",
        affectedCategory: "module",
        participants: expect.arrayContaining([
          expect.objectContaining({
            entryKey: "payments",
            entry: expect.objectContaining({ id: expect.stringMatching(/payments/i) }),
            projection: expect.objectContaining({ name: expect.any(String), description: expect.any(String) }),
            semanticHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]),
      }),
    ]);
    expect(detectProjectKnowledgeHardConflicts(knowledge)[0].participants)
      .toEqual(expect.not.arrayContaining([expect.objectContaining({ concreteValue: expect.anything() })]));
  });

  it("flags identical-evidence paraphrase conflicts across snapshot churn", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      glossary: [
        {
          term: "Discount",
          type: "term",
          definition: "A price reduction applied by a valid promo code.",
          sourceWorkItemIds: ["10"],
          evidence: "Valid code applies discount",
          evidenceRefs: [{ ...evidenceRef("snapshot-old", "10"), quote: "Valid code applies discount" }],
        },
        {
          term: "Discount",
          type: "term",
          definition: "A reduction applied by a valid promo code.",
          sourceWorkItemIds: ["10"],
          evidence: "Valid code applies discount",
          evidenceRefs: [{ ...evidenceRef("snapshot-new", "10"), quote: "Valid code  applies discount" }],
        },
      ],
    });

    const conflicts = detectProjectKnowledgeHardConflicts(knowledge);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictType: "duplicate_identity",
      evidenceIdentical: true,
    });
  });

  it("keeps the flag false when quotes differ or evidence is missing", () => {
    const differentQuotes = ProjectKnowledgeBaseSchema.parse({
      glossary: [
        {
          term: "Discount",
          type: "term",
          definition: "First definition.",
          sourceWorkItemIds: ["10"],
          evidence: "quote one",
          evidenceRefs: [{ ...evidenceRef("s1", "10"), quote: "quote one" }],
        },
        {
          term: "Discount",
          type: "term",
          definition: "Second definition.",
          sourceWorkItemIds: ["10"],
          evidence: "quote two",
          evidenceRefs: [{ ...evidenceRef("s2", "10"), quote: "quote two" }],
        },
      ],
    });
    expect(detectProjectKnowledgeHardConflicts(differentQuotes)[0]).toMatchObject({ evidenceIdentical: false });

    const missingRefs = ProjectKnowledgeBaseSchema.parse({
      modules: [
        { id: "Payments", name: "Payments", description: "First", sourceWorkItemIds: ["1"], evidence: "First" },
        { id: " payments ", name: "Payment processing", description: "Second", sourceWorkItemIds: ["2"], evidence: "Second" },
      ],
    });
    expect(detectProjectKnowledgeHardConflicts(missingRefs)[0]).toMatchObject({ evidenceIdentical: false });
  });

  it("still blocks concrete-value disagreements backed by identical evidence, flagged for the reviewer", () => {
    const knowledge = ProjectKnowledgeBaseSchema.parse({
      businessRules: [
        {
          id: "br-1",
          rule: "Maximum retry count must be 3",
          sourceField: "acceptanceCriteria",
          moduleName: "Payments",
          sourceWorkItemIds: ["1"],
          evidence: "Supported quote",
          evidenceRefs: [evidenceRef("s-old", "1")],
        },
        {
          id: "br-2",
          rule: "Maximum retry count must be 5",
          sourceField: "acceptanceCriteria",
          moduleName: "Payments",
          sourceWorkItemIds: ["1"],
          evidence: "Supported quote",
          evidenceRefs: [evidenceRef("s-new", "1")],
        },
      ],
    });

    const conflicts = detectProjectKnowledgeHardConflicts(knowledge);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictType: "incompatible_concrete_value",
      evidenceIdentical: true,
    });
    expect(conflicts[0].participants.map((participant) => participant.concreteValue)).toEqual(["3", "5"]);
  });

  it("orders evidence-identical conflicts after genuine disagreements for review", () => {
    const conflictStub = (identityKey: string, evidenceIdentical: boolean) => ({
      identityKey,
      subject: identityKey,
      affectedCategory: "glossary" as const,
      conflictType: "duplicate_identity" as const,
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
