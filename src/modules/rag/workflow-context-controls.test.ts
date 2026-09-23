import { describe, expect, it } from "vitest";

import { ProjectKnowledgeBaseSchema } from "./project-knowledge.schema";
import {
  filterProjectKnowledgeForContextControls,
  normalizeWorkflowContextControls,
  parseWorkflowContextSourceId,
} from "./workflow-context-controls";

function knowledgeBase() {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [],
    businessRules: [
      {
        id: "rule-removed",
        rule: "Removed story rule",
        sourceField: "description",
        sourceWorkItemIds: ["100"],
        evidence: "Story 100 says this.",
      },
      {
        id: "rule-mixed",
        rule: "Mixed-source rule",
        sourceField: "description",
        sourceWorkItemIds: ["100", "200"],
        evidence: "Stories 100 and 200 say this.",
      },
      {
        id: "rule-kept",
        rule: "Kept story rule",
        sourceField: "description",
        sourceWorkItemIds: ["200"],
        evidence: "Story 200 says this.",
      },
    ],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
    chatInsights: [
      {
        id: "chat-removed",
        title: "Removed chat insight",
        content: "Synthesized from story 100.",
        sourceWorkItemIds: ["100"],
        evidence: "Story 100",
      },
      {
        id: "chat-kept",
        title: "Kept chat insight",
        content: "Synthesized from story 200.",
        sourceWorkItemIds: ["200"],
        evidence: "Story 200",
      },
    ],
  });
}

describe("workflow context controls", () => {
  it("keeps old requests automatic while preserving an intentional empty review", () => {
    expect(normalizeWorkflowContextControls({})).toEqual({ excludedSourceIds: [] });
    expect(normalizeWorkflowContextControls({ reviewedSourceIds: [], excludedSourceIds: [] })).toEqual({
      reviewedSourceIds: [],
      excludedSourceIds: [],
    });
  });

  it("parses knowledge IDs without corrupting keys that contain colons", () => {
    expect(parseWorkflowContextSourceId("KB:business_rule:order:approval")).toEqual({
      sourceType: "project_knowledge",
      category: "business_rule",
      entryKey: "order:approval",
    });
  });

  it("removes all knowledge derived from a removed story, including mixed-source and chat entries", () => {
    const filtered = filterProjectKnowledgeForContextControls(knowledgeBase(), {
      excludedSourceIds: ["WI:100"],
    });

    expect(filtered?.businessRules.map((entry) => entry.id)).toEqual(["rule-kept"]);
    expect(filtered?.chatInsights.map((entry) => entry.id)).toEqual(["chat-kept"]);
  });

  it("uses an explicit reviewed allowlist for knowledge without reintroducing alternatives", () => {
    const filtered = filterProjectKnowledgeForContextControls(knowledgeBase(), {
      reviewedSourceIds: ["KB:business_rule:rule-kept", "KB:chat_insight:chat-kept"],
      excludedSourceIds: [],
    });

    expect(filtered?.businessRules.map((entry) => entry.id)).toEqual(["rule-kept"]);
    expect(filtered?.chatInsights.map((entry) => entry.id)).toEqual(["chat-kept"]);
  });
});
