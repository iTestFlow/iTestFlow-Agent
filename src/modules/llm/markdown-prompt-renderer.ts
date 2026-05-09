import "server-only";

import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { LlmContextSource } from "@/modules/rag/project-context-store.service";

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
  outputContract: unknown;
};

export function buildRequirementAnalysisMarkdownPrompt(input: MarkdownPromptInput) {
  const relevantKnowledge = selectRelevantProjectKnowledge({
    projectKnowledgeBase: input.projectKnowledgeBase,
    queryText: [
      stringifyForPromptSearch(input.targetRequirement),
      stringifyForPromptSearch(input.relatedWorkItems ?? []),
      stringifyForPromptSearch(input.selectedContext ?? []),
    ].join("\n"),
    prioritySourceIds: [
      extractWorkItemId(input.targetRequirement),
      ...extractWorkItemIds(input.relatedWorkItems ?? []),
      ...extractWorkItemIds(input.selectedContext ?? []),
    ].filter(Boolean) as string[],
  });

  return {
    prompt: [
      renderCurrentProject(input.currentProject),
      renderTargetWorkItem("User Story Under Analysis", input.targetRequirement),
      renderWorkItemCollection("Related Work Items", input.relatedWorkItems ?? []),
      renderWorkItemCollection("Project Context", input.selectedContext ?? []),
      renderProjectKnowledge(relevantKnowledge),
      renderOutputContract(input.outputContract),
    ]
      .filter(Boolean)
      .join("\n\n"),
    relevantProjectKnowledgeBase: relevantKnowledge,
  };
}

export function buildTestCaseGenerationMarkdownPrompt(input: MarkdownPromptInput & { options?: Record<string, unknown> }) {
  const relevantKnowledge = selectRelevantProjectKnowledge({
    projectKnowledgeBase: input.projectKnowledgeBase,
    queryText: [
      stringifyForPromptSearch(input.targetRequirement),
      stringifyForPromptSearch(input.relatedWorkItems ?? []),
      stringifyForPromptSearch(input.selectedContext ?? []),
      stringifyForPromptSearch(input.options ?? {}),
    ].join("\n"),
    prioritySourceIds: [
      extractWorkItemId(input.targetRequirement),
      ...extractWorkItemIds(input.relatedWorkItems ?? []),
      ...extractWorkItemIds(input.selectedContext ?? []),
    ].filter(Boolean) as string[],
  });

  return {
    prompt: [
      renderCurrentProject(input.currentProject),
      renderTargetWorkItem("User Story Under Test", input.targetRequirement),
      renderWorkItemCollection("Related Work Items", input.relatedWorkItems ?? []),
      renderWorkItemCollection("Project Context", input.selectedContext ?? []),
      renderTestDesignOptions(input.options ?? {}),
      renderCoverageExpectations(),
      renderProjectKnowledge(relevantKnowledge),
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

const DOMAIN_BRIEF_LIMITS = {
  modules: 6,
  businessRules: 14,
  stateTransitions: 6,
  glossary: 14,
  crossDependencies: 6,
} as const;

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

function renderTestDesignOptions(options: Record<string, unknown>) {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined && value !== null && value !== "");
  return [
    "# Test Design Options",
    entries.length ? entries.map(([key, value]) => `- ${key}: ${formatScalar(value)}`).join("\n") : "No additional test design options were supplied.",
  ].join("\n\n");
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

function selectRelevantProjectKnowledge(input: {
  projectKnowledgeBase: unknown | null | undefined;
  queryText: string;
  prioritySourceIds: string[];
}): ProjectKnowledgeBase | null {
  const knowledgeBase = normalizeProjectKnowledge(input.projectKnowledgeBase);
  if (!knowledgeBase) return null;

  const queryTerms = tokenizeForPromptSearch(input.queryText);
  const prioritySourceIds = new Set(input.prioritySourceIds);

  return {
    modules: rankKnowledgeItems(knowledgeBase.modules, queryTerms, prioritySourceIds, (item) =>
      [item.id, item.name, item.description, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ).slice(0, DOMAIN_BRIEF_LIMITS.modules),
    businessRules: rankKnowledgeItems(knowledgeBase.businessRules, queryTerms, prioritySourceIds, (item) =>
      [item.id, item.rule, item.moduleName, item.sourceField, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ).slice(0, DOMAIN_BRIEF_LIMITS.businessRules),
    stateTransitions: rankKnowledgeItems(knowledgeBase.stateTransitions, queryTerms, prioritySourceIds, (item) =>
      [
        item.id,
        item.workflowName,
        item.fromState,
        item.toState,
        item.triggerOrCondition,
        item.actor,
        item.moduleName,
        item.evidence,
        item.sourceWorkItemIds.join(" "),
      ].join(" "),
    ).slice(0, DOMAIN_BRIEF_LIMITS.stateTransitions),
    glossary: rankKnowledgeItems(knowledgeBase.glossary, queryTerms, prioritySourceIds, (item) =>
      [item.term, item.type, item.definition, item.evidence, item.sourceWorkItemIds.join(" ")].join(" "),
    ).slice(0, DOMAIN_BRIEF_LIMITS.glossary),
    crossDependencies: rankKnowledgeItems(knowledgeBase.crossDependencies, queryTerms, prioritySourceIds, (item) =>
      [
        item.id,
        item.sourceModule,
        item.targetModule,
        item.dependencyType,
        item.description,
        item.evidence,
        item.sourceWorkItemIds.join(" "),
      ].join(" "),
    ).slice(0, DOMAIN_BRIEF_LIMITS.crossDependencies),
  };
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
    .filter((entry) => entry.score > 0 || entry.index < 3)
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

function cleanPromptText(value?: string) {
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
