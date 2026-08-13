import "server-only";

import { estimateTokens, usableInputTokens } from "./token-estimate";

import type { NormalizedTestDesignOptions } from "@/modules/test-case-design/test-design-options";
import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { LlmContextSource } from "@/modules/rag/project-context-store.service";
import { renderExtraInstructionsSection } from "@/modules/llm/extra-instructions";

type CurrentProjectPromptInput = {
  azureProjectId: string;
  azureProjectName: string;
};

type MarkdownPromptInput = {
  currentProject: CurrentProjectPromptInput;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext?: unknown[];
  projectKnowledgeBase?: unknown | null;
  projectKnowledgeNotice?: string | null;
  extraInstructions?: string;
  outputContract: unknown;
  /** The caller's configured model window; sizes how much context is included. */
  maxInputTokens?: number;
  /** The workspace's retrieval top-K, honoured as a floor for related work items. */
  relatedWorkItemsFloor?: number;
  /** Semantic ordering for knowledge entries; overrides keyword ranking when supplied. */
  rankedKnowledgeKeys?: Partial<Record<
    "modules" | "businessRules" | "stateTransitions" | "glossary" | "crossDependencies" | "chatInsights",
    string[]
  >>;
};

export function buildRequirementAnalysisMarkdownPrompt(input: MarkdownPromptInput) {
  const relatedWorkItems = selectRelatedWorkItemsWithinBudget({
    relatedWorkItems: input.relatedWorkItems ?? [],
    floor: input.relatedWorkItemsFloor ?? DEFAULT_RELATED_ITEMS_FLOOR,
    maxInputTokens: input.maxInputTokens,
  });
  const relevantKnowledge = selectRelevantProjectKnowledge({
    maxInputTokens: input.maxInputTokens,
    weighting: "requirementAnalysis",
    rankedOverride: input.rankedKnowledgeKeys,
    projectKnowledgeBase: input.projectKnowledgeBase,
    queryText: [
      stringifyForPromptSearch(input.targetRequirement),
      stringifyForPromptSearch(relatedWorkItems),
      stringifyForPromptSearch(input.selectedContext ?? []),
    ].join("\n"),
    prioritySourceIds: [
      extractWorkItemId(input.targetRequirement),
      ...extractWorkItemIds(relatedWorkItems),
      ...extractWorkItemIds(input.selectedContext ?? []),
    ].filter(Boolean) as string[],
  });

  return {
    prompt: [
      renderCurrentProject(input.currentProject),
      renderTargetWorkItem("User Story Under Analysis", input.targetRequirement),
      renderWorkItemCollection("Related Work Items", relatedWorkItems),
      renderWorkItemCollection("Project Context", input.selectedContext ?? []),
      renderProjectKnowledgeAuthorityNotice(input.projectKnowledgeNotice),
      renderProjectKnowledge(relevantKnowledge),
      renderExtraInstructionsSection(input.extraInstructions),
      renderOutputContract(input.outputContract),
    ]
      .filter(Boolean)
      .join("\n\n"),
    relevantProjectKnowledgeBase: relevantKnowledge,
  };
}

export function buildTestCaseGenerationMarkdownPrompt(input: MarkdownPromptInput & { options?: Record<string, unknown> | NormalizedTestDesignOptions }) {
  const relatedWorkItems = selectRelatedWorkItemsWithinBudget({
    relatedWorkItems: input.relatedWorkItems ?? [],
    floor: input.relatedWorkItemsFloor ?? DEFAULT_RELATED_ITEMS_FLOOR,
    maxInputTokens: input.maxInputTokens,
  });
  const relevantKnowledge = selectRelevantProjectKnowledge({
    maxInputTokens: input.maxInputTokens,
    rankedOverride: input.rankedKnowledgeKeys,
    projectKnowledgeBase: input.projectKnowledgeBase,
    queryText: [
      stringifyForPromptSearch(input.targetRequirement),
      stringifyForPromptSearch(relatedWorkItems),
      stringifyForPromptSearch(input.selectedContext ?? []),
      stringifyForPromptSearch(input.options ?? {}),
    ].join("\n"),
    prioritySourceIds: [
      extractWorkItemId(input.targetRequirement),
      ...extractWorkItemIds(relatedWorkItems),
      ...extractWorkItemIds(input.selectedContext ?? []),
    ].filter(Boolean) as string[],
  });

  return {
    prompt: [
      renderCurrentProject(input.currentProject),
      renderTargetWorkItem("User Story Under Test", input.targetRequirement),
      renderWorkItemCollection("Related Work Items", relatedWorkItems),
      renderWorkItemCollection("Project Context", input.selectedContext ?? []),
      renderTestDesignOptions(input.options ?? {}),
      renderCoverageExpectations(),
      renderProjectKnowledgeAuthorityNotice(input.projectKnowledgeNotice),
      renderProjectKnowledge(relevantKnowledge),
      renderExtraInstructionsSection(input.extraInstructions),
      renderOutputContract(input.outputContract),
    ]
      .filter(Boolean)
      .join("\n\n"),
    relevantProjectKnowledgeBase: relevantKnowledge,
  };
}

export function buildExistingTestCaseReviewMarkdownPrompt(input: MarkdownPromptInput & { linkedTestCases?: unknown[] }) {
  const relatedWorkItems = selectRelatedWorkItemsWithinBudget({
    relatedWorkItems: input.relatedWorkItems ?? [],
    floor: input.relatedWorkItemsFloor ?? DEFAULT_RELATED_ITEMS_FLOOR,
    maxInputTokens: input.maxInputTokens,
  });
  const relevantKnowledge = selectRelevantProjectKnowledge({
    maxInputTokens: input.maxInputTokens,
    rankedOverride: input.rankedKnowledgeKeys,
    projectKnowledgeBase: input.projectKnowledgeBase,
    queryText: [
      stringifyForPromptSearch(input.targetRequirement),
      stringifyForPromptSearch(input.linkedTestCases ?? []),
      stringifyForPromptSearch(relatedWorkItems),
      stringifyForPromptSearch(input.selectedContext ?? []),
    ].join("\n"),
    prioritySourceIds: [
      extractWorkItemId(input.targetRequirement),
      ...extractWorkItemIds(relatedWorkItems),
      ...extractWorkItemIds(input.selectedContext ?? []),
    ].filter(Boolean) as string[],
  });

  return {
    prompt: [
      renderCurrentProject(input.currentProject),
      renderTargetWorkItem("User Story Under Traceability Review", input.targetRequirement),
      renderLinkedTestCaseCollection("Linked Azure DevOps Test Cases Under Review", input.linkedTestCases ?? []),
      renderWorkItemCollection("Project Context", input.selectedContext ?? []),
      renderExistingCoverageReviewInstructions(),
      renderProjectKnowledgeAuthorityNotice(input.projectKnowledgeNotice),
      renderProjectKnowledge(relevantKnowledge),
      renderExtraInstructionsSection(input.extraInstructions),
      renderOutputContract(input.outputContract),
    ]
      .filter(Boolean)
      .join("\n\n"),
    relevantProjectKnowledgeBase: relevantKnowledge,
  };
}

export function extractWorkItemId(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const item = value as {
    id?: unknown;
    workItemId?: unknown;
    azureWorkItemId?: unknown;
  };
  const id = item.workItemId ?? item.id ?? item.azureWorkItemId;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/**
 * Floor per knowledge category, so every category is represented even on a small
 * model. These are minimums, not caps — the token budget decides how far past them to
 * go. They were previously hard caps (6/14/6/14/6), which on a real 213-entry project
 * meant workflows saw 22% of the compiled knowledge regardless of the model's window:
 * 14 of 114 business rules reached test design, and business rules ARE the test
 * conditions.
 */
const DOMAIN_BRIEF_FLOORS = {
  modules: 4,
  businessRules: 6,
  stateTransitions: 4,
  glossary: 6,
  crossDependencies: 2,
  chatInsights: 2,
} as const;

/**
 * Share of the model's usable window that compiled knowledge may occupy in a workflow
 * prompt. The rest is the work item under analysis, related items, selected context,
 * the output contract, and room for the response.
 */
const KNOWLEDGE_BUDGET_SHARE = 0.35;

/**
 * How many slots each knowledge category earns per round, per workflow.
 *
 * Uniform round-robin is only defensible while everything fits. Once the corpus
 * outgrows the window it silently equalises categories that are not equally useful:
 * modelled on a 2,000-entry corpus, business rules — half the corpus and the single
 * most load-bearing category for test work — received about a fifth of the slots.
 *
 * The weights encode what each workflow actually reasons over:
 * - **Test design**: business rules and state transitions ARE the test
 *   conditions. Every rule is a positive case, a negative case and usually a boundary;
 *   every transition is a path. Glossary and modules mainly disambiguate wording.
 * - **Requirement analysis**: contradictions and gaps surface by comparing a
 *   requirement against existing rules, but module and dependency structure matters
 *   more here than for test authoring, because scope and impact are the question.
 */
const CATEGORY_WEIGHTS = {
  testDesign: { businessRules: 4, stateTransitions: 3, glossary: 1, modules: 1, crossDependencies: 1, chatInsights: 2 },
  requirementAnalysis: { businessRules: 3, stateTransitions: 2, glossary: 2, modules: 2, crossDependencies: 2, chatInsights: 2 },
} as const;

export type KnowledgeWeighting = keyof typeof CATEGORY_WEIGHTS;
/** Share available to related work items, over and above the caller's top-K floor. */
const RELATED_ITEMS_BUDGET_SHARE = 0.25;
/**
 * Ceiling the floor-guaranteed portion of related items may consume, measured against
 * the full usable window rather than the narrower share above. The floor exists so the
 * workspace's configured top-K is not silently truncated by the 25% share; it is not a
 * license for one oversized item (or several) to consume the whole prompt on its own.
 */
const RELATED_ITEMS_FLOOR_CEILING_SHARE = 0.5;
/** Used when the caller does not supply the workspace top-K. */
const DEFAULT_RELATED_ITEMS_FLOOR = 8;
/** Cap on what per-category floors may consume, so they cannot overrun the share. */
const MAX_FLOOR_SHARE_OF_BUDGET = 0.5;

function renderCurrentProject(project: CurrentProjectPromptInput) {
  return [
    "# Current Project",
    `- Azure Project ID: ${project.azureProjectId}`,
    `- Azure Project Name: ${project.azureProjectName}`,
  ].join("\n");
}

function renderTargetWorkItem(title: string, item: unknown) {
  return [`# ${title}`, renderWorkItem(item, 2)].join("\n\n");
}

function renderWorkItemCollection(title: string, items: unknown[]) {
  if (!items.length) {
    return [`# ${title}`, "No related items were supplied."].join("\n\n");
  }

  return [`# ${title}`, ...items.map((item) => renderWorkItem(item, 2))].join("\n\n");
}

function renderLinkedTestCaseCollection(title: string, items: unknown[]) {
  if (!items.length) {
    return [`# ${title}`, "No linked Azure DevOps test cases were supplied."].join("\n\n");
  }

  return [`# ${title}`, ...items.map((item) => renderLinkedTestCase(item, 2))].join("\n\n");
}

function renderWorkItem(value: unknown, headingLevel: number) {
  const item = toPromptWorkItem(value);
  const heading = `${"#".repeat(headingLevel)} ${item.id ? `#${item.id} - ` : ""}${item.title ?? "Untitled Work Item"}`;
  const lines = [heading];

  const metadata = [
    item.workItemType ? `Type: ${item.workItemType}` : undefined,
    item.state ? `State: ${item.state}` : undefined,
    item.priority !== undefined ? `Priority: ${item.priority}` : undefined,
    item.areaPath ? `Area Path: ${item.areaPath}` : undefined,
    item.iterationPath ? `Iteration Path: ${item.iterationPath}` : undefined,
    item.tags.length ? `Tags: ${item.tags.join(", ")}` : undefined,
    item.createdDate ? `Created: ${item.createdDate}` : undefined,
    item.updatedDate ? `Updated: ${item.updatedDate}` : undefined,
    item.relevanceScore !== undefined ? `Relevance Score: ${item.relevanceScore}` : undefined,
  ].filter(Boolean);

  if (metadata.length) lines.push(...metadata.map((line) => `- ${line}`));

  const links = [
    item.parentLinks.length ? `Parent Links: ${item.parentLinks.join(", ")}` : undefined,
    item.childLinks.length ? `Child Links: ${item.childLinks.join(", ")}` : undefined,
    item.relatedLinks.length ? `Related Links: ${item.relatedLinks.join(", ")}` : undefined,
    item.testedByLinks.length ? `Tested By Links: ${item.testedByLinks.join(", ")}` : undefined,
    item.testsLinks.length ? `Tests Links: ${item.testsLinks.join(", ")}` : undefined,
  ].filter(Boolean);

  if (links.length) {
    lines.push("", "Links:");
    lines.push(...links.map((line) => `- ${line}`));
  }

  if (item.description) {
    lines.push("", "Description:", item.description);
  }

  if (item.acceptanceCriteria) {
    lines.push("", "Acceptance Criteria:", item.acceptanceCriteria);
  }

  if (item.content) {
    lines.push("", "Context Content:", item.content);
  }

  return lines.join("\n");
}

function renderTestDesignOptions(options: Record<string, unknown> | NormalizedTestDesignOptions) {
  if (isNormalizedTestDesignOptions(options)) {
    return [
      "# Test Design Options",
      `- Target Test Case Range: ${options.targetTestCaseRangeLabel}`,
      `- Target test case range: ${options.minCases}-${options.maxCases}`,
      "- Coverage Focus:",
      ...options.coverageFocusLabels.map((label) => `  - ${label}`),
      "",
      "Only the Coverage Focus items listed above are selected for this run.",
    ].join("\n");
  }

  const entries = Object.entries(options).filter(([, value]) => value !== undefined && value !== null && value !== "");
  return [
    "# Test Design Options",
    entries.length ? entries.map(([key, value]) => `- ${key}: ${formatScalar(value)}`).join("\n") : "No additional test design options were supplied.",
  ].join("\n\n");
}

function isNormalizedTestDesignOptions(value: Record<string, unknown> | NormalizedTestDesignOptions): value is NormalizedTestDesignOptions {
  return (
    typeof value.targetTestCaseRangeLabel === "string" &&
    typeof value.minCases === "number" &&
    typeof value.maxCases === "number" &&
    Array.isArray(value.coverageFocusLabels)
  );
}

function renderCoverageExpectations() {
  return [
    "# Coverage Expectations",
    "- Each acceptance criterion should have at least one test case when enough information exists.",
    "- Include positive, negative, edge, boundary, integration, workflow, role/permission, data validation, accessibility, and regression scenarios when supported by context.",
    "- Use realistic test data based on the project domain.",
    "- Step 1 in every test case must start with Preconditions and use expectedResult exactly \"Preconditions are met\".",
    "- Avoid duplicate, trivial, overly broad, or non-executable test cases.",
  ].join("\n");
}

function renderExistingCoverageReviewInstructions() {
  return [
    "# Coverage Review Instructions",
    "- Decompose the story title, description, and acceptance criteria into atomic testable points.",
    "- Every meaningful story point must appear in traceabilityMatrix.",
    "- Set traceabilityMatrix.sourceText to a concise source excerpt of 240 characters or fewer. Use an empty string when it would duplicate requirementText or sourceReference. If the source is link-based, include a short label and at most one URL.",
    "- Keep traceabilityMatrix.requirementText human-readable and normalized. Do not put raw URLs, markdown link syntax, or link lists in requirementText.",
    "- A single acceptance criterion may produce multiple matrix rows when it contains multiple flows, roles, states, validations, integrations, errors, or edge cases.",
    "- Map linked test cases only when their steps and expected results provide real evidence.",
    "- Do not count a title-only, vague, or setup-only test case as covered.",
    "- Recommend more than one test case when a point has multiple flows, roles, validations, integrations, or negative paths.",
    "- Suggested additions should cover only uncovered or partially covered matrix rows.",
  ].join("\n");
}

function renderLinkedTestCase(value: unknown, headingLevel: number) {
  const testCase = toPromptTestCase(value);
  const heading = `${"#".repeat(headingLevel)} ${testCase.id ? `#${testCase.id} - ` : ""}${testCase.title ?? "Untitled Test Case"}`;
  const lines = [heading];

  const metadata = [
    testCase.priority !== undefined ? `Priority: ${testCase.priority}` : undefined,
    testCase.testType ? `Test Type: ${testCase.testType}` : undefined,
    testCase.automationSuitability ? `Automation Suitability: ${testCase.automationSuitability}` : undefined,
    testCase.tags.length ? `Tags: ${testCase.tags.join(", ")}` : undefined,
  ].filter(Boolean);

  if (metadata.length) lines.push(...metadata.map((line) => `- ${line}`));

  if (testCase.description) {
    lines.push("", "Description:", testCase.description);
  }

  if (testCase.preconditions) {
    lines.push("", "Preconditions:", testCase.preconditions);
  }

  if (testCase.testData) {
    lines.push("", "Test Data:", testCase.testData);
  }

  if (testCase.expectedResult) {
    lines.push("", "Overall Expected Result:", testCase.expectedResult);
  }

  lines.push("", "Steps:");
  if (!testCase.steps.length) {
    lines.push("No test steps were supplied.");
  } else {
    lines.push(
      ...testCase.steps.map((step, index) =>
        [
          `${index + 1}. Action: ${step.action || "(empty action)"}`,
          `   Expected Result: ${step.expectedResult || "(empty expected result)"}`,
        ].join("\n"),
      ),
    );
  }

  return lines.join("\n");
}

function renderProjectKnowledgeAuthorityNotice(notice: string | null | undefined) {
  return notice ? ["# Knowledge Authority", notice].join("\n\n") : "";
}

function renderProjectKnowledge(knowledgeBase: ProjectKnowledgeBase | null) {
  if (!knowledgeBase) {
    return [
      "# Saved Project Knowledge",
      "No saved project knowledge was supplied. Use only the work item, related work items, and selected project context.",
    ].join("\n\n");
  }

  return [
    "# Saved Project Knowledge",
    renderModules(knowledgeBase),
    renderBusinessRules(knowledgeBase),
    renderStateTransitions(knowledgeBase),
    renderGlossary(knowledgeBase),
    renderDependencies(knowledgeBase),
    renderChatInsights(knowledgeBase),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderModules(knowledgeBase: ProjectKnowledgeBase) {
  if (!knowledgeBase.modules.length) return "## Modules\nNo modules were supplied.";
  return [
    "## Modules",
    ...knowledgeBase.modules.map((item) =>
      [
        `- ${item.id}: ${item.name}`,
        item.description ? `  - Description: ${cleanPromptText(item.description)}` : undefined,
        item.sourceWorkItemIds.length ? `  - Sources: ${item.sourceWorkItemIds.join(", ")}` : undefined,
        item.evidence ? `  - Evidence: ${cleanPromptText(item.evidence)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function renderBusinessRules(knowledgeBase: ProjectKnowledgeBase) {
  if (!knowledgeBase.businessRules.length) return "## Business Rules\nNo business rules were supplied.";
  return [
    "## Business Rules",
    ...knowledgeBase.businessRules.map((item) =>
      [
        `- ${item.id}: ${cleanPromptText(item.rule)}`,
        item.moduleName ? `  - Module: ${item.moduleName}` : undefined,
        item.sourceField ? `  - Source Field: ${item.sourceField}` : undefined,
        item.sourceWorkItemIds.length ? `  - Sources: ${item.sourceWorkItemIds.join(", ")}` : undefined,
        item.evidence ? `  - Evidence: ${cleanPromptText(item.evidence)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function renderStateTransitions(knowledgeBase: ProjectKnowledgeBase) {
  if (!knowledgeBase.stateTransitions.length) return "## State Transitions\nNo state transitions were supplied.";
  return [
    "## State Transitions",
    ...knowledgeBase.stateTransitions.map((item) =>
      [
        `- ${item.id}: ${item.workflowName}`,
        item.fromState || item.toState ? `  - Transition: ${item.fromState ?? "unspecified"} -> ${item.toState ?? "unspecified"}` : undefined,
        `  - Trigger/Condition: ${cleanPromptText(item.triggerOrCondition)}`,
        item.actor ? `  - Actor: ${item.actor}` : undefined,
        item.moduleName ? `  - Module: ${item.moduleName}` : undefined,
        item.sourceWorkItemIds.length ? `  - Sources: ${item.sourceWorkItemIds.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function renderGlossary(knowledgeBase: ProjectKnowledgeBase) {
  if (!knowledgeBase.glossary.length) return "## Glossary\nNo glossary terms were supplied.";
  return [
    "## Glossary",
    ...knowledgeBase.glossary.map((item) =>
      [
        `- ${item.term} (${item.type}): ${cleanPromptText(item.definition)}`,
        item.sourceWorkItemIds.length ? `  - Sources: ${item.sourceWorkItemIds.join(", ")}` : undefined,
        item.evidence ? `  - Evidence: ${cleanPromptText(item.evidence)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function renderChatInsights(knowledgeBase: ProjectKnowledgeBase) {
  // Unlike the five compiler categories, omitted entirely rather than a "none supplied"
  // placeholder when empty: most projects will never integrate one, and a permanent
  // empty section for a feature that is off by default is noise, not information.
  if (!knowledgeBase.chatInsights.length) return "";
  return [
    "## Answers An Admin Approved From The Business Owner Assistant",
    "These are a human-approved synthesis, not an extracted-and-verified fact re-anchored to a source quote -- weigh them accordingly.",
    ...knowledgeBase.chatInsights.map((item) =>
      [
        `- ${cleanPromptText(item.content)}`,
        item.sourceWorkItemIds.length ? `  - Sources: ${item.sourceWorkItemIds.join(", ")}` : undefined,
        item.evidence ? `  - Evidence: ${cleanPromptText(item.evidence)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function renderDependencies(knowledgeBase: ProjectKnowledgeBase) {
  if (!knowledgeBase.crossDependencies.length) return "## Dependencies\nNo cross dependencies were supplied.";
  return [
    "## Dependencies",
    ...knowledgeBase.crossDependencies.map((item) =>
      [
        `- ${item.id}: ${item.sourceModule} -> ${item.targetModule}`,
        `  - Type: ${item.dependencyType}`,
        item.description ? `  - Description: ${cleanPromptText(item.description)}` : undefined,
        item.sourceWorkItemIds.length ? `  - Sources: ${item.sourceWorkItemIds.join(", ")}` : undefined,
        item.evidence ? `  - Evidence: ${cleanPromptText(item.evidence)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

function renderOutputContract(outputContract: unknown) {
  return [
    "# Required JSON Output",
    "Respond with one valid JSON object matching this shape. Do not wrap the response in markdown fences and do not include any text before or after the JSON.",
    "For contextUsed, include only source IDs explicitly present in the work item, selected context, or saved project knowledge. Never include prompt filenames, upload labels, browser labels, or pasted-file names such as Pasted markdown.md.",
    JSON.stringify(outputContract, null, 2),
  ].join("\n\n");
}

function toPromptWorkItem(value: unknown) {
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const contextSource = value as Partial<LlmContextSource>;

    return {
      id: stringValue(objectValue.id ?? objectValue.workItemId ?? objectValue.azureWorkItemId),
      workItemType: stringValue(objectValue.workItemType),
      title: stringValue(objectValue.title ?? objectValue.documentName),
      state: stringValue(objectValue.state),
      priority: numberOrStringValue(objectValue.priority),
      tags: stringArrayValue(objectValue.tags ?? (contextSource.metadata as { tags?: unknown } | undefined)?.tags),
      areaPath: stringValue(objectValue.areaPath ?? (contextSource.metadata as { areaPath?: unknown } | undefined)?.areaPath),
      iterationPath: stringValue(objectValue.iterationPath ?? (contextSource.metadata as { iterationPath?: unknown } | undefined)?.iterationPath),
      createdDate: stringValue(objectValue.createdDate),
      updatedDate: stringValue(objectValue.updatedDate ?? (contextSource.metadata as { updatedDate?: unknown } | undefined)?.updatedDate),
      relevanceScore: numberOrStringValue(objectValue.relevanceScore),
      parentLinks: stringArrayValue(objectValue.parentLinks),
      childLinks: stringArrayValue(objectValue.childLinks),
      relatedLinks: stringArrayValue(objectValue.relatedLinks),
      testedByLinks: stringArrayValue(objectValue.testedByLinks),
      testsLinks: stringArrayValue(objectValue.testsLinks),
      description: cleanPromptText(stringValue(objectValue.description)),
      acceptanceCriteria: cleanPromptText(stringValue(objectValue.acceptanceCriteria)),
      content: cleanPromptText(stringValue(objectValue.content)),
    };
  }

  return {
    id: undefined,
    workItemType: undefined,
    title: "Untitled Work Item",
    state: undefined,
    priority: undefined,
    tags: [],
    areaPath: undefined,
    iterationPath: undefined,
    createdDate: undefined,
    updatedDate: undefined,
    relevanceScore: undefined,
    parentLinks: [],
    childLinks: [],
    relatedLinks: [],
    testedByLinks: [],
    testsLinks: [],
    description: cleanPromptText(stringValue(value)),
    acceptanceCriteria: undefined,
    content: undefined,
  };
}

function toPromptTestCase(value: unknown) {
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return {
      id: stringValue(objectValue.id ?? objectValue.azureTestCaseId),
      title: stringValue(objectValue.title),
      description: cleanPromptText(stringValue(objectValue.description)),
      preconditions: cleanPromptText(stringValue(objectValue.preconditions)),
      testData: cleanPromptText(stringValue(objectValue.testData)),
      expectedResult: cleanPromptText(stringValue(objectValue.expectedResult)),
      priority: numberOrStringValue(objectValue.priority),
      testType: stringValue(objectValue.testType),
      automationSuitability: stringValue(objectValue.automationSuitability),
      tags: stringArrayValue(objectValue.tags),
      steps: testStepsValue(objectValue.steps),
    };
  }

  return {
    id: undefined,
    title: "Untitled Test Case",
    description: undefined,
    preconditions: undefined,
    testData: undefined,
    expectedResult: undefined,
    priority: undefined,
    testType: undefined,
    automationSuitability: undefined,
    tags: [],
    steps: [],
  };
}

function testStepsValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((step) => {
    if (!step || typeof step !== "object") {
      return { action: cleanPromptText(String(step ?? "")) ?? "", expectedResult: "" };
    }
    const objectValue = step as Record<string, unknown>;
    return {
      action: cleanPromptText(stringValue(objectValue.action)) ?? "",
      expectedResult: cleanPromptText(stringValue(objectValue.expectedResult ?? objectValue.expected)) ?? "",
    };
  });
}

/**
 * Ranks each knowledge category by relevance, then fills a token budget round-robin
 * across categories.
 *
 * Round-robin rather than per-category quotas: it guarantees every category is
 * represented (rank 1 of each before rank 2 of any), and small categories simply
 * exhaust, handing their remaining share to the large ones. No arbitrary split to tune.
 */
function selectRelevantProjectKnowledge(input: {
  projectKnowledgeBase: unknown | null | undefined;
  queryText: string;
  prioritySourceIds: string[];
  /** From the caller's configured model; falls back conservatively when unknown. */
  maxInputTokens?: number;
  /** Which category weighting to apply; defaults to the test-oriented profile. */
  weighting?: KnowledgeWeighting;
  /** Optional relevance override, ranked best-first per category (semantic ranking). */
  rankedOverride?: Partial<Record<keyof typeof CATEGORY_WEIGHTS.testDesign, string[]>>;
}): ProjectKnowledgeBase | null {
  const knowledgeBase = normalizeProjectKnowledge(input.projectKnowledgeBase);
  if (!knowledgeBase) return null;

  const queryTerms = tokenizeForPromptSearch(input.queryText);
  const prioritySourceIds = new Set(input.prioritySourceIds);
  // Preserves TItem: rankKnowledgeItems is generic, but inference through a local
  // alias widens to its constraint unless the parameter is re-declared here.
  const rank = <TItem extends { sourceWorkItemIds?: string[] }>(
    items: TItem[],
    describe: (item: TItem) => string,
  ): TItem[] => rankKnowledgeItems(items, queryTerms, prioritySourceIds, describe);

  // The semantic override is the eligible set for its category, in relevance order —
  // not a reordering of everything. It arrives already cut at a relevance threshold, so
  // admitting the entries it left out would put back exactly the material the threshold
  // exists to remove: a category with nothing to say about this work item still has a
  // best entry, and sending it reads as though it were relevant. A category the
  // override omits entirely keeps keyword ranking.
  const applyOverride = <TItem extends { sourceWorkItemIds?: string[] }>(
    items: TItem[],
    keyOf: (item: TItem) => string,
    eligible: string[] | undefined,
  ): TItem[] => {
    if (!eligible) return items;
    const position = new Map(eligible.map((key, index) => [key, index]));
    return items
      .filter((item) => position.has(keyOf(item)))
      .sort((first, second) => position.get(keyOf(first))! - position.get(keyOf(second))!);
  };

  const ranked = {
    modules: rank(knowledgeBase.modules, (item) =>
      [item.id, item.name, item.description, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ),
    businessRules: rank(knowledgeBase.businessRules, (item) =>
      [item.id, item.rule, item.moduleName, item.sourceField, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ),
    stateTransitions: rank(knowledgeBase.stateTransitions, (item) =>
      [item.id, item.workflowName, item.fromState, item.toState, item.triggerOrCondition, item.actor, item.moduleName, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ),
    glossary: rank(knowledgeBase.glossary, (item) =>
      [item.term, item.type, item.definition, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ),
    crossDependencies: rank(knowledgeBase.crossDependencies, (item) =>
      [item.id, item.sourceModule, item.targetModule, item.dependencyType, item.description, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ),
    // Not re-anchored to a source quote the way the compiler's own categories are (see
    // the schema doc comment on ProjectKnowledgeChatInsightSchema), so ranked on its own
    // content plus sources -- there is no "moduleName"/"type" field to fold in.
    chatInsights: rank(knowledgeBase.chatInsights, (item) =>
      [item.id, item.title, item.content, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ),
  };

  const ordered = {
    // Keys must match what the knowledge entry table stores as `entry_key`: the entry
    // id for every category except glossary, which is keyed by term.
    modules: applyOverride(ranked.modules, (item) => item.id, input.rankedOverride?.modules),
    businessRules: applyOverride(ranked.businessRules, (item) => item.id, input.rankedOverride?.businessRules),
    stateTransitions: applyOverride(ranked.stateTransitions, (item) => item.id, input.rankedOverride?.stateTransitions),
    glossary: applyOverride(ranked.glossary, (item) => item.term, input.rankedOverride?.glossary),
    crossDependencies: applyOverride(ranked.crossDependencies, (item) => item.id, input.rankedOverride?.crossDependencies),
    chatInsights: applyOverride(ranked.chatInsights, (item) => item.id, input.rankedOverride?.chatInsights),
  };

  const budgetTokens = Math.floor(usableInputTokens(input.maxInputTokens) * KNOWLEDGE_BUDGET_SHARE);
  const weights = CATEGORY_WEIGHTS[input.weighting ?? "testDesign"];
  const taken = {
    modules: 0, businessRules: 0, stateTransitions: 0, glossary: 0, crossDependencies: 0, chatInsights: 0,
  } as Record<keyof typeof ranked, number>;
  const categories = Object.keys(ranked) as Array<keyof typeof ranked>;

  // Floors first, so every category is represented before weighting takes over. They
  // are capped at a fraction of the budget: a floor that cannot be afforded must not
  // silently overrun the share and squeeze the work item itself out of the prompt.
  //
  // Checked against the PROJECTED total (usedTokens + this entry's cost), not the
  // current one: checking only the current total against the ceiling lets a single
  // oversized entry blow straight through it once the loop has decided "one more floor
  // item" is allowed, with no per-entry cap anywhere else to catch it. Measured: a
  // single ~20,000-character business rule alone costs ~5,026 estimated tokens --
  // larger than an entire 4,000-token window on its own.
  const floorCeiling = Math.floor(budgetTokens * MAX_FLOOR_SHARE_OF_BUDGET);
  let usedTokens = 0;
  for (const category of categories) {
    while (taken[category] < DOMAIN_BRIEF_FLOORS[category] && taken[category] < ordered[category].length) {
      const cost = estimateTokens(JSON.stringify(ordered[category][taken[category]]));
      if (usedTokens + cost > floorCeiling) break;
      usedTokens += cost;
      taken[category] += 1;
    }
  }

  // Then weighted round-robin: a category with weight 4 takes four items per pass.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const category of categories) {
      for (let slot = 0; slot < weights[category]; slot += 1) {
        const next = ordered[category][taken[category]];
        if (next === undefined) break;
        const cost = estimateTokens(JSON.stringify(next));
        if (usedTokens + cost > budgetTokens) break;
        taken[category] += 1;
        usedTokens += cost;
        progressed = true;
      }
    }
  }

  return {
    modules: ordered.modules.slice(0, taken.modules),
    businessRules: ordered.businessRules.slice(0, taken.businessRules),
    stateTransitions: ordered.stateTransitions.slice(0, taken.stateTransitions),
    glossary: ordered.glossary.slice(0, taken.glossary),
    crossDependencies: ordered.crossDependencies.slice(0, taken.crossDependencies),
    chatInsights: ordered.chatInsights.slice(0, taken.chatInsights),
  };
}

/**
 * Trims related work items to what fits, keeping at least the caller's top-K.
 *
 * top-K is a deliberate user setting (Settings -> Knowledge & Context), so it is
 * honoured as a floor rather than replaced: the budget only ever adds items the
 * window can afford.
 */
function selectRelatedWorkItemsWithinBudget(input: {
  relatedWorkItems: unknown[];
  floor: number;
  maxInputTokens?: number;
}): unknown[] {
  const budgetTokens = Math.floor(usableInputTokens(input.maxInputTokens) * RELATED_ITEMS_BUDGET_SHARE);
  // Wider than budgetTokens deliberately: this is what the floor-guaranteed portion may
  // spend, so the 25% share does not truncate below the workspace's configured top-K.
  const floorCeiling = Math.floor(usableInputTokens(input.maxInputTokens) * RELATED_ITEMS_FLOOR_CEILING_SHARE);
  const selected: unknown[] = [];
  let usedTokens = 0;
  for (const item of input.relatedWorkItems) {
    const cost = estimateTokens(JSON.stringify(item));
    // Checked against the PROJECTED total before committing, for both stages: the floor
    // stage was previously unconditional regardless of cost, which is exactly what let a
    // single oversized related item consume the whole prompt on its own -- despite this
    // function's own stated intent that "the budget only ever adds items the window can
    // afford."
    const ceiling = selected.length < input.floor ? floorCeiling : budgetTokens;
    if (usedTokens + cost > ceiling) break;
    selected.push(item);
    usedTokens += cost;
  }
  return selected;
}

function normalizeProjectKnowledge(value: unknown): ProjectKnowledgeBase | null {
  if (!value || typeof value !== "object") return null;
  const knowledgeBase = value as Partial<ProjectKnowledgeBase>;
  return {
    modules: Array.isArray(knowledgeBase.modules) ? knowledgeBase.modules : [],
    businessRules: Array.isArray(knowledgeBase.businessRules) ? knowledgeBase.businessRules : [],
    stateTransitions: Array.isArray(knowledgeBase.stateTransitions) ? knowledgeBase.stateTransitions : [],
    glossary: Array.isArray(knowledgeBase.glossary) ? knowledgeBase.glossary : [],
    crossDependencies: Array.isArray(knowledgeBase.crossDependencies) ? knowledgeBase.crossDependencies : [],
    chatInsights: Array.isArray(knowledgeBase.chatInsights) ? knowledgeBase.chatInsights : [],
  };
}

function rankKnowledgeItems<TItem extends { sourceWorkItemIds?: string[] }>(
  items: TItem[],
  queryTerms: Set<string>,
  prioritySourceIds: Set<string>,
  textForItem: (item: TItem) => string,
) {
  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreKnowledgeItem(item, queryTerms, prioritySourceIds, textForItem(item)),
    }))
    // Ranking orders; it must not exclude. Entries that share no term with the work
    // item used to be dropped here unless they were in the first three, which capped
    // modules and dependencies at three on any model — a hard filter applied before the
    // token budget, and before semantic ranking could speak for an entry that keyword
    // overlap cannot see. Zero-scoring entries now sort last instead, so a small window
    // still never reaches them and a large one can.
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

function scoreKnowledgeItem<TItem extends { sourceWorkItemIds?: string[] }>(
  item: TItem,
  queryTerms: Set<string>,
  prioritySourceIds: Set<string>,
  text: string,
) {
  const haystack = text.toLowerCase();
  const termHits = Array.from(queryTerms).reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
  const sourceHits = item.sourceWorkItemIds?.filter((id) => prioritySourceIds.has(id)).length ?? 0;
  const explicitRuleBonus = /\b(br|us|fr|cr|rule)[-_#]?\d+\b/i.test(text) ? 0.4 : 0;
  const complianceBonus =
    /\b(compliance|pii|audit|authorization|authentication|security|timeout|timer|expiry|retry|rtl|arabic|api|integration|configuration)\b/i.test(
      text,
    )
      ? 0.35
      : 0;

  return termHits + sourceHits * 4 + explicitRuleBonus + complianceBonus;
}

function extractWorkItemIds(values: unknown[]): string[] {
  return values.flatMap((value) => {
    const id = extractWorkItemId(value);
    return id ? [id] : [];
  });
}

function stringifyForPromptSearch(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function tokenizeForPromptSearch(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9\u0600-\u06ff]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 2),
  );
}

export function cleanPromptText(value?: string) {
  if (!value) return undefined;

  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/p>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<\/tr>\s*<tr[^>]*>/gi, "\n")
    .replace(/<tr[^>]*>/gi, "")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
    .replace(/<t[dh][^>]*>/gi, "")
    .replace(/<\/t[dh]>/gi, "")
    .replace(/<\/?(table|thead|tbody)[^>]*>/gi, "\n")
    .replace(/<strong[^>]*>/gi, "**")
    .replace(/<\/strong>/gi, "**")
    .replace(/<b[^>]*>/gi, "**")
    .replace(/<\/b>/gi, "**")
    .replace(/<em[^>]*>/gi, "*")
    .replace(/<\/em>/gi, "*")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberOrStringValue(value: unknown) {
  if (typeof value === "number" || typeof value === "string") return value;
  return undefined;
}

function stringArrayValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" || typeof item === "number" ? String(item) : undefined))
    .filter(Boolean) as string[];
}

function formatScalar(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
