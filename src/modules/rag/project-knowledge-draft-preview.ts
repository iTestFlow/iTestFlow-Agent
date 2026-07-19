import type { ProjectKnowledgeBase, ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";

export const PROJECT_KNOWLEDGE_DRAFT_PREVIEW_CATEGORIES = [
  "all",
  "module",
  "business_rule",
  "state_transition",
  "glossary",
  "dependency",
] as const;

export type ProjectKnowledgeDraftPreviewCategory =
  (typeof PROJECT_KNOWLEDGE_DRAFT_PREVIEW_CATEGORIES)[number];
type EntryCategory = Exclude<ProjectKnowledgeDraftPreviewCategory, "all">;

export type ProjectKnowledgeDraftPreviewEntry = {
  entryId: string;
  category: EntryCategory;
  categoryLabel: string;
  badge: string;
  title: string;
  fields: Array<{ id: string; label: string; value: string }>;
  sourceWorkItemIds: string[];
  evidence: Array<{
    sourceWorkItemId: string;
    sourceField: ProjectKnowledgeEvidenceRef["sourceField"];
    quote: string;
  }>;
};

export function buildProjectKnowledgeDraftPreview(input: {
  draftId: string;
  draftVersion: string;
  status: string;
  knowledgeBase: ProjectKnowledgeBase;
  category?: ProjectKnowledgeDraftPreviewCategory;
  query?: string;
  page?: number;
  pageSize?: number;
}) {
  const category = input.category ?? "all";
  const query = normalizeSearch(input.query ?? "");
  const allEntries = flattenPreviewEntries(input.knowledgeBase);
  const counts = {
    all: allEntries.length,
    module: input.knowledgeBase.modules.length,
    business_rule: input.knowledgeBase.businessRules.length,
    state_transition: input.knowledgeBase.stateTransitions.length,
    glossary: input.knowledgeBase.glossary.length,
    dependency: input.knowledgeBase.crossDependencies.length,
  } satisfies Record<ProjectKnowledgeDraftPreviewCategory, number>;
  const filtered = allEntries.filter((entry) => {
    if (category !== "all" && entry.category !== category) return false;
    if (!query) return true;
    return normalizeSearch([
      entry.categoryLabel,
      entry.title,
      ...entry.fields.flatMap((field) => [field.label, field.value]),
      ...entry.sourceWorkItemIds,
      ...entry.evidence.flatMap((evidence) => [
        evidence.sourceWorkItemId,
        evidence.sourceField,
        evidence.quote,
      ]),
    ].join(" ")).includes(query);
  });
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 10));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, input.page ?? 1));
  const start = (page - 1) * pageSize;

  return {
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    status: input.status,
    counts,
    filters: { category, query: input.query?.trim() ?? "" },
    page,
    pageSize,
    pageCount,
    total: filtered.length,
    entries: filtered.slice(start, start + pageSize),
  };
}

function flattenPreviewEntries(knowledgeBase: ProjectKnowledgeBase): ProjectKnowledgeDraftPreviewEntry[] {
  return [
    ...knowledgeBase.modules.map((entry, index) => previewEntry({
      entryId: `module:${index}:${entry.id}`,
      category: "module",
      categoryLabel: "Modules",
      badge: "Module",
      title: entry.name,
      fields: [
        field("id", "ID", entry.id),
        field("name", "Name", entry.name),
        field("description", "Description", entry.description),
      ],
      entry,
    })),
    ...knowledgeBase.businessRules.map((entry, index) => previewEntry({
      entryId: `business_rule:${index}:${entry.id}`,
      category: "business_rule",
      categoryLabel: "Business Rules",
      badge: "Business Rule",
      title: entry.rule,
      fields: [
        field("id", "ID", entry.id),
        field("rule", "Rule", entry.rule),
        field("sourceField", "Source field", entry.sourceField),
        field("moduleName", "Module", entry.moduleName),
      ],
      entry,
    })),
    ...knowledgeBase.stateTransitions.map((entry, index) => previewEntry({
      entryId: `state_transition:${index}:${entry.id}`,
      category: "state_transition",
      categoryLabel: "State Transitions",
      badge: "State Transition",
      title: [entry.workflowName, [entry.fromState, entry.toState].filter(Boolean).join(" → ")]
        .filter(Boolean)
        .join(": "),
      fields: [
        field("id", "ID", entry.id),
        field("workflowName", "Workflow", entry.workflowName),
        field("fromState", "From state", entry.fromState),
        field("toState", "To state", entry.toState),
        field("triggerOrCondition", "Trigger or condition", entry.triggerOrCondition),
        field("actor", "Actor", entry.actor),
        field("moduleName", "Module", entry.moduleName),
      ],
      entry,
    })),
    ...knowledgeBase.glossary.map((entry, index) => previewEntry({
      entryId: `glossary:${index}:${entry.term}`,
      category: "glossary",
      categoryLabel: "Glossary",
      badge: "Glossary",
      title: entry.term,
      fields: [
        field("term", "Term", entry.term),
        field("type", "Type", entry.type.replaceAll("_", " ")),
        field("definition", "Definition", entry.definition),
      ],
      entry,
    })),
    ...knowledgeBase.crossDependencies.map((entry, index) => previewEntry({
      entryId: `dependency:${index}:${entry.id}`,
      category: "dependency",
      categoryLabel: "Dependencies",
      badge: "Dependency",
      title: `${entry.sourceModule} → ${entry.targetModule}`,
      fields: [
        field("id", "ID", entry.id),
        field("sourceModule", "Source", entry.sourceModule),
        field("targetModule", "Target", entry.targetModule),
        field("dependencyType", "Dependency type", entry.dependencyType),
        field("description", "Description", entry.description),
      ],
      entry,
    })),
  ];
}

function previewEntry(input: {
  entryId: string;
  category: EntryCategory;
  categoryLabel: string;
  badge: string;
  title: string;
  fields: Array<{ id: string; label: string; value: string } | null>;
  entry: {
    sourceWorkItemIds: string[];
    evidenceRefs?: ProjectKnowledgeEvidenceRef[];
  };
}): ProjectKnowledgeDraftPreviewEntry {
  return {
    entryId: input.entryId,
    category: input.category,
    categoryLabel: input.categoryLabel,
    badge: input.badge,
    title: input.title,
    fields: input.fields.filter((value): value is NonNullable<typeof value> => Boolean(value)),
    sourceWorkItemIds: input.entry.sourceWorkItemIds,
    evidence: (input.entry.evidenceRefs ?? []).map((evidence) => ({
      sourceWorkItemId: evidence.sourceWorkItemId,
      sourceField: evidence.sourceField,
      quote: evidence.quote,
    })),
  };
}

function field(id: string, label: string, value?: string | null) {
  const normalized = value?.trim();
  return normalized ? { id, label, value: normalized } : null;
}

function normalizeSearch(value: string) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
