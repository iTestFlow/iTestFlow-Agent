import { describe, expect, it } from "vitest";

import {
  buildProjectKnowledgeCitationSources,
  generatedProjectKnowledgeForOmissions,
  groundGeneratedProjectKnowledge,
  hasStrictProjectKnowledgeGrounding,
  omitUnsupportedProjectKnowledgeEntries,
  projectKnowledgeBaseToGeneratedPrompt,
  projectKnowledgeCitationHandle,
  ProjectKnowledgeGeneratedBaseSchema,
} from "./project-knowledge-grounding";

const workItem = {
  id: "42",
  sourceSnapshotId: "snapshot-42",
  workItemType: "User Story",
  title: "Secure checkout",
  description: "<p>Customers&nbsp;complete   checkout securely.</p>",
  acceptanceCriteria: "Given a cart, payment is required.",
  state: "Active",
  tags: ["checkout", "payments"],
};

function emptyGenerated() {
  return { modules: [], businessRules: [], stateTransitions: [], glossary: [], crossDependencies: [] };
}

describe("Project Knowledge grounding", () => {
  it("builds opaque deterministic handles over the canonical source projection", () => {
    const sources = buildProjectKnowledgeCitationSources([workItem]);
    expect(sources.map(({ sourceField, text }) => ({ sourceField, text }))).toEqual([
      { sourceField: "title", text: "Secure checkout" },
      { sourceField: "description", text: "Customers complete checkout securely." },
      { sourceField: "acceptanceCriteria", text: "Given a cart, payment is required." },
      { sourceField: "state", text: "Active" },
      { sourceField: "tags", text: "checkout; payments" },
    ]);
    expect(sources[0].handle).toBe(projectKnowledgeCitationHandle("snapshot-42", "title"));
    expect(projectKnowledgeCitationHandle("snapshot-42", "title"))
      .not.toBe(projectKnowledgeCitationHandle("snapshot-42", "description"));
    expect(sources.every((source) => !source.handle.includes("snapshot-42"))).toBe(true);
  });

  it("resolves handles server-side to immutable provenance and ignores spoofed metadata", () => {
    const sources = buildProjectKnowledgeCitationSources([workItem]);
    const description = sources.find((source) => source.sourceField === "description")!;
    const generated = ProjectKnowledgeGeneratedBaseSchema.parse({
      ...emptyGenerated(),
      modules: [{
        id: "mod-checkout",
        name: "Checkout",
        description: "Handles checkout.",
        sourceSnapshotId: "spoofed",
        sourceWorkItemIds: ["spoofed"],
        evidenceRefs: [{ sourceSnapshotId: "spoofed" }],
        citations: [{ handle: description.handle, quote: "Customers complete checkout securely." }],
      }],
    });

    const result = groundGeneratedProjectKnowledge({ generated, sources });
    expect(result.omissions).toEqual([]);
    expect(result.knowledgeBase.modules[0]).toMatchObject({
      sourceWorkItemIds: ["42"],
      evidence: "Customers complete checkout securely.",
      evidenceRefs: [{
        sourceSnapshotId: "snapshot-42",
        sourceWorkItemId: "42",
        sourceField: "description",
        quote: "Customers complete checkout securely.",
        origin: "generated_v4",
        verification: "exact",
        locator: {
          projectionVersion: "plain-text-v1",
          citationHandle: description.handle,
          start: 0,
          end: 37,
        },
      }],
    });
    expect(hasStrictProjectKnowledgeGrounding(result.knowledgeBase)).toBe(true);
  });

  it("repairs whitespace deterministically and rejects invalid handles or source fields", () => {
    const sources = buildProjectKnowledgeCitationSources([workItem]);
    const description = sources.find((source) => source.sourceField === "description")!;
    const tags = sources.find((source) => source.sourceField === "tags")!;
    const result = groundGeneratedProjectKnowledge({
      sources,
      generated: ProjectKnowledgeGeneratedBaseSchema.parse({
        ...emptyGenerated(),
        modules: [{
          id: "normalized",
          name: "Normalized",
          description: "Whitespace",
          citations: [{ handle: description.handle, quote: "Customers   complete checkout securely." }],
        }, {
          id: "unknown",
          name: "Unknown",
          description: "Unknown handle",
          citations: [{ handle: "cite_spoofed", quote: "Secure checkout" }],
        }],
        businessRules: [{
          id: "br-tags",
          rule: "Checkout is tagged.",
          citations: [{ handle: tags.handle, quote: "checkout" }],
        }],
      }),
    });

    expect(result.knowledgeBase.modules[0].evidenceRefs?.[0].verification).toBe("normalized");
    expect(result.knowledgeBase.modules.map((entry) => entry.id)).toEqual(["normalized"]);
    expect(result.knowledgeBase.businessRules).toEqual([]);
    expect(result.omissionReasons).toEqual({
      unknown_citation_handle: 1,
      unsupported_business_rule_source_field: 1,
    });
  });

  it("filters targeted repair entries and omits every still-unsupported category", () => {
    const generated = ProjectKnowledgeGeneratedBaseSchema.parse({
      modules: [{ id: "m1", name: "One", description: "One", citations: [] }],
      businessRules: [{ id: "b1", rule: "One", citations: [] }],
      stateTransitions: [{ id: "s1", workflowName: "Flow", triggerOrCondition: "Start", citations: [] }],
      glossary: [{ term: "Term", type: "term", definition: "Definition", citations: [] }],
      crossDependencies: [{ id: "d1", sourceModule: "One", targetModule: "Two", dependencyType: "uses", description: "Uses", citations: [] }],
    });
    const grounded = groundGeneratedProjectKnowledge({ generated, sources: [] });
    const targeted = generatedProjectKnowledgeForOmissions(generated, grounded.omissions.slice(0, 2));
    expect(targeted.modules).toHaveLength(1);
    expect(targeted.businessRules).toHaveLength(1);
    expect(targeted.stateTransitions).toEqual([]);
    expect(grounded.omissions).toHaveLength(5);
    expect(hasStrictProjectKnowledgeGrounding(grounded.knowledgeBase)).toBe(true);
  });

  it("keeps only quote-backed atomic constraints and round-trips retained constraints", () => {
    const sources = buildProjectKnowledgeCitationSources([workItem]);
    const acceptanceCriteria = sources.find((source) => source.sourceField === "acceptanceCriteria")!;
    const grounded = groundGeneratedProjectKnowledge({
      sources,
      generated: ProjectKnowledgeGeneratedBaseSchema.parse({
        ...emptyGenerated(),
        businessRules: [{
          id: "br-payment-required",
          rule: "Payment is required.",
          moduleAssociations: ["Checkout", "Payments"],
          constraint: {
            object: "Payment",
            property: "required",
            operator: "eq",
            value: "required",
            valueType: "boolean",
          },
          citations: [{ handle: acceptanceCriteria.handle, quote: "Given a cart, payment is required." }],
        }, {
          id: "br-malformed-constraint",
          rule: "Payment is required.",
          constraint: { object: "payment" },
          citations: [{ handle: acceptanceCriteria.handle, quote: "Given a cart, payment is required." }],
        }, {
          id: "br-unquoted-constraint",
          rule: "Payment is required.",
          constraint: {
            object: "retry",
            property: "limit",
            operator: "eq",
            value: "5",
            valueType: "number",
          },
          citations: [{ handle: acceptanceCriteria.handle, quote: "Given a cart, payment is required." }],
        }],
      }),
    });

    expect(grounded.constraintRejectionCount).toBe(2);
    expect(grounded.knowledgeBase.businessRules[0]).toMatchObject({
      moduleAssociations: ["Checkout", "Payments"],
      constraint: {
        object: "payment",
        property: "required",
        operator: "eq",
        value: "true",
        valueType: "boolean",
      },
    });
    expect(grounded.knowledgeBase.businessRules[1]).not.toHaveProperty("constraint");
    expect(grounded.knowledgeBase.businessRules[2]).not.toHaveProperty("constraint");

    const prompt = projectKnowledgeBaseToGeneratedPrompt(grounded.knowledgeBase);
    expect(prompt.businessRules[0]?.constraint).toEqual({
      object: "payment",
      property: "required",
      operator: "eq",
      value: "true",
      valueType: "boolean",
    });
    expect(prompt.businessRules[0]?.moduleAssociations).toEqual(["Checkout", "Payments"]);
    expect(prompt.businessRules[1]).not.toHaveProperty("constraint");

    const reGrounded = groundGeneratedProjectKnowledge({ generated: prompt, sources });
    expect(reGrounded.constraintRejectionCount).toBe(0);
    expect(reGrounded.knowledgeBase.businessRules[0]).toMatchObject({
      moduleAssociations: ["Checkout", "Payments"],
      constraint: {
        object: "payment",
        property: "required",
        operator: "eq",
        value: "true",
        valueType: "boolean",
      },
    });
  });

  it("re-grounds persisted canonical enum and state constraints against original quote casing", () => {
    const sources = buildProjectKnowledgeCitationSources([{
      ...workItem,
      id: "43",
      sourceSnapshotId: "snapshot-43",
      acceptanceCriteria: "Status must be Pending. Payment method must be Manual.",
    }]);
    const acceptanceCriteria = sources.find((source) => source.sourceField === "acceptanceCriteria")!;
    const grounded = groundGeneratedProjectKnowledge({
      sources,
      generated: ProjectKnowledgeGeneratedBaseSchema.parse({
        ...emptyGenerated(),
        businessRules: [{
          id: "br-status-pending",
          rule: "Status must be Pending.",
          constraint: {
            object: "status",
            property: "value",
            operator: "eq",
            value: "pending",
            valueType: "state",
          },
          citations: [{ handle: acceptanceCriteria.handle, quote: "Status must be Pending." }],
        }, {
          id: "br-payment-manual",
          rule: "Payment method must be Manual.",
          constraint: {
            object: "payment",
            property: "method",
            operator: "eq",
            value: "manual",
            valueType: "enum",
          },
          citations: [{ handle: acceptanceCriteria.handle, quote: "Payment method must be Manual." }],
        }],
      }),
    });

    expect(grounded.constraintRejectionCount).toBe(0);
    expect(grounded.knowledgeBase.businessRules.map((entry) => entry.constraint)).toEqual([
      { object: "status", property: "value", operator: "eq", value: "pending", valueType: "state" },
      { object: "payment", property: "method", operator: "eq", value: "manual", valueType: "enum" },
    ]);
  });

  it("converts verified canonical entries back to the citation-only prompt contract", () => {
    const sources = buildProjectKnowledgeCitationSources([workItem]);
    const title = sources[0];
    const grounded = groundGeneratedProjectKnowledge({
      sources,
      generated: ProjectKnowledgeGeneratedBaseSchema.parse({
        ...emptyGenerated(),
        glossary: [{ term: "Checkout", type: "process", definition: "A purchase process.", citations: [{ handle: title.handle, quote: "Secure checkout" }] }],
      }),
    }).knowledgeBase;
    const prompt = projectKnowledgeBaseToGeneratedPrompt(grounded);
    expect(prompt.glossary[0]).toEqual({
      term: "Checkout",
      type: "process",
      definition: "A purchase process.",
      citations: [{ handle: title.handle, quote: "Secure checkout" }],
    });
    expect(JSON.stringify(prompt)).not.toContain("sourceSnapshotId");

    const withUnsupported = {
      ...grounded,
      modules: [{ id: "legacy", name: "Legacy", description: "Legacy", sourceWorkItemIds: ["42"], evidence: "Legacy" }],
    };
    const omitted = omitUnsupportedProjectKnowledgeEntries(withUnsupported);
    expect(omitted.knowledgeBase.modules).toEqual([]);
    expect(omitted.omittedEntryCount).toBe(1);
  });
});
