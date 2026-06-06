import type { SystemPromptDefinition } from "./prompt.types";

export const structuredOutputPrompt: SystemPromptDefinition = {
  name: "structured-output-format",
  version: "1.1.0",
  purpose: "Provider-neutral instruction for returning schema-conformant JSON.",
  system: [
    "Return only valid JSON matching schema {schemaName}.",
    "Do not wrap the JSON in markdown fences or add commentary.",
    "Use the required output shape exactly. Arrays marked as string arrays must contain strings only, never objects.",
    "For contextUsed, include source IDs only. Never include prompt filenames, upload labels, browser labels, or pasted-file names.",
  ].join("\n"),
};

export function withStructuredOutputInstruction(system: string, schemaName: string) {
  return `${system}\n${buildStructuredOutputInstruction(schemaName)}`;
}

export function buildStructuredOutputUserPrompt(input: {
  system: string;
  user: string;
  schemaName: string;
}) {
  return [
    input.system,
    input.user,
    buildStructuredOutputInstruction(input.schemaName),
  ].join("\n\n");
}

function buildStructuredOutputInstruction(schemaName: string) {
  return [
    structuredOutputPrompt.system.replace("{schemaName}", schemaName),
    "Required JSON shape:",
    JSON.stringify(requiredOutputShape(schemaName), null, 2),
  ].join("\n");
}

function requiredOutputShape(schemaName: string) {
  if (schemaName === "ContextSuggestionOutput") {
    return {
      suggestedItems: [
        {
          workItemId: "string",
          title: "string",
          workItemType: "string",
          relationshipType: "optional string",
          relevanceScore: "number from 0 to 1",
          reason: "string",
        },
      ],
    };
  }

  if (schemaName === "RequirementAnalysisOutput") {
    return {
      findings: [
        {
          id: "string",
          checklistItemId: "string",
          issueType:
            "ambiguity | conflict | missing_requirement | incomplete_criteria | inconsistency | non_testable_requirement | unsupported_assumption | unhandled_edge_case | ownership_gap | traceability_gap | risk_gap",
          severity: "critical | high | medium | low | info",
          title: "string",
          description: "string",
          suggestion: "string",
          riskLevel: "high | medium | low",
          riskJustification: "string",
          affectedAreas: ["string"],
          references: [
            {
              module: "optional string",
              section: "optional string",
              sourceId: "optional string",
              description: "optional string",
            },
          ],
          contradiction: "boolean",
        },
      ],
      summary: {
        totalFindings: "integer 0 or greater",
        criticalCount: "integer 0 or greater",
        highCount: "integer 0 or greater",
        mediumCount: "integer 0 or greater",
        lowCount: "integer 0 or greater",
        infoCount: "integer 0 or greater",
        overallQuality: "poor | fair | good | excellent",
        completenessScore: "number from 0 to 100",
        clarityScore: "number from 0 to 100",
        testabilityScore: "number from 0 to 100",
        summaryText: "string",
      },
      recommendations: ["string only, not objects"],
      questionsForProductOwner: ["string only, not objects"],
      contextUsed: ["source ID string only, not objects or prompt filenames"],
    };
  }

  if (schemaName === "TestCaseGenerationOutput") {
    return {
      testCases: [generatedTestCaseShape()],
      summary: {
        totalCases: "integer 0 or greater",
        byType: { regression: "integer count example" },
        byPriority: { "1": "integer count example" },
        coverageEstimate: "number from 0 to 100",
      },
      contextUsed: ["source ID string only, not objects or prompt filenames"],
    };
  }

  if (schemaName === "ExistingTestCaseReviewOutput") {
    return {
      summary: "string",
      coverageScore: "number from 0 to 100",
      traceabilityMatrix: [
        {
          id: "TM-001",
          sourceType: "story | description | acceptanceCriteria | businessRules",
          sourceReference: "Title | Description paragraph 1 | AC-1 | Business rule ID",
          requirementText: "atomic testable story point",
          coverageStatus: "Covered | Partially covered | Not covered | Needs review",
          severity: "High | Medium | Low",
          linkedTestCaseIds: ["string"],
          evidenceSummary: "what the linked tests actually validate",
          missingCoverage: "what is missing, or empty string when fully covered",
          recommendedMinimumTestCount: "integer 0 or greater",
          recommendedAction: "specific next action",
        },
      ],
      insights: [
        {
          id: "INS-001",
          severity: "High | Medium | Low",
          title: "string",
          explanation: "string",
          relatedMatrixRowIds: ["string"],
          relatedTestCaseIds: ["string"],
          suggestedAction: "string",
        },
      ],
      findings: [
        {
          id: "string",
          category:
            "Missing coverage | Duplicate | Weak steps | Weak expected result | Missing preconditions | Missing test data | Automation readiness",
          severity: "High | Medium | Low",
          title: "string",
          explanation: "string",
          relatedMatrixRowIds: ["string"],
          relatedTestCaseIds: ["string"],
          suggestedAction: "string",
        },
      ],
      suggestedAdditions: [generatedTestCaseShape()],
      contextUsed: ["source ID string only, not objects or prompt filenames"],
    };
  }

  if (schemaName === "ProjectKnowledgeBase") {
    return {
      modules: [
        {
          id: "string",
          name: "string",
          description: "string",
          sourceWorkItemIds: ["string"],
          evidence: "string",
        },
      ],
      businessRules: [
        {
          id: "string",
          rule: "string",
          sourceField: "acceptanceCriteria | description | title | metadata",
          moduleName: "optional string",
          sourceWorkItemIds: ["string"],
          evidence: "string",
        },
      ],
      stateTransitions: [
        {
          id: "string",
          workflowName: "string",
          fromState: "optional string",
          toState: "optional string",
          triggerOrCondition: "string",
          actor: "optional string",
          moduleName: "optional string",
          sourceWorkItemIds: ["string"],
          evidence: "string",
        },
      ],
      glossary: [
        {
          term: "string",
          type: "term | actor | role | system | external_service | business_entity | data_entity | process",
          definition: "string",
          sourceWorkItemIds: ["string"],
          evidence: "string",
        },
      ],
      crossDependencies: [
        {
          id: "string",
          sourceModule: "string",
          targetModule: "string",
          dependencyType: "string",
          description: "string",
          sourceWorkItemIds: ["string"],
          evidence: "string",
        },
      ],
    };
  }

  return {
    schemaName,
    instruction: "Return a JSON object that matches this schema.",
  };
}

function generatedTestCaseShape() {
  return {
    id: "string",
    title: "string",
    description: "string",
    priority: "number only: 1 | 2 | 3 | 4, where 1 is highest and 4 is lowest",
    type: "execution type only: functional | smoke | sanity | regression | e2e | integration | unit | api | ui | security | performance | accessibility; never use a Coverage Focus value such as data-validation",
    category: "string",
    tags: ["string"],
    relatedAcceptanceCriteria: ["string"],
    relatedBusinessRules: ["string"],
    relatedModules: ["string"],
    preconditions: "string",
    testData: "optional string",
    steps: [
      {
        stepNumber: "positive integer",
        action: "string",
        expectedResult: "string",
      },
    ],
  };
}
