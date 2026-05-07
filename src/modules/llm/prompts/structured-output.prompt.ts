import type { SystemPromptDefinition } from "./prompt.types";

export const structuredOutputPrompt: SystemPromptDefinition = {
  name: "structured-output-format",
  version: "1.1.0",
  purpose: "Provider-neutral instruction for returning schema-conformant JSON.",
  system: [
    "Return only valid JSON matching schema {schemaName}.",
    "Do not wrap the JSON in markdown fences or add commentary.",
    "Use the required output shape exactly. Arrays marked as string arrays must contain strings only, never objects.",
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
      executiveSummary: "string",
      scores: {
        clarity: "number from 0 to 100",
        testability: "number from 0 to 100",
        completeness: "number from 0 to 100",
        ambiguityRisk: "number from 0 to 100",
        integrationRisk: "number from 0 to 100",
        businessRuleCoverage: "number from 0 to 100",
        acceptanceCriteriaQuality: "number from 0 to 100",
        overallReadiness: "number from 0 to 100",
      },
      findings: [
        {
          id: "string",
          severity: "High | Medium | Low",
          category: "string",
          title: "string",
          explanation: "string",
          suggestedImprovement: "string",
          azureDevOpsCommentSnippet: "string",
          scoreImpact: "number",
          sourceContextIds: ["string"],
        },
      ],
      assumptions: ["string only, not objects"],
      questionsForProductOwner: ["string only, not objects"],
    };
  }

  if (schemaName === "TestCaseGenerationOutput") {
    return {
      summary: "string",
      testCases: [generatedTestCaseShape()],
    };
  }

  if (schemaName === "ExistingTestCaseReviewOutput") {
    return {
      summary: "string",
      findings: [
        {
          id: "string",
          category:
            "Missing coverage | Duplicate | Weak steps | Weak expected result | Missing preconditions | Missing test data | Automation readiness",
          severity: "High | Medium | Low",
          title: "string",
          explanation: "string",
          relatedTestCaseIds: ["string"],
          suggestedAction: "string",
        },
      ],
      suggestedAdditions: [generatedTestCaseShape()],
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
    description: "optional string",
    preconditions: "optional string",
    steps: [
      {
        index: "positive integer",
        action: "string",
        expectedResult: "string",
      },
    ],
    testData: "optional string",
    expectedResult: "string",
    priority: "High | Medium | Low",
    severity: "High | Medium | Low",
    testType: "Functional | Negative | Edge case | Integration | Regression | API | UI | Security | Performance | Accessibility",
    automationSuitability: "High | Medium | Low",
    relatedAcceptanceCriteria: ["string"],
    relatedBusinessRules: ["string"],
    relatedRisks: ["string"],
    tags: ["string"],
  };
}
