import { z } from "zod";

const RequiredTextSchema = z.string().trim().min(1);
const OptionalTextSchema = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed || undefined;
  });
const DescriptionTextSchema = z
  .string()
  .optional()
  .default("")
  .transform((value) => value.trim());

const SourceIdsSchema = z
  .array(z.string())
  .transform((ids) => Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))))
  .pipe(z.array(RequiredTextSchema).min(1));

const GlossaryTypeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : value),
  z
    .enum(["term", "actor", "role", "system", "external_service", "business_entity", "data_entity", "process"])
    .default("term")
    .catch("term"),
);

export const ProjectKnowledgeModuleSchema = z
  .object({
    id: RequiredTextSchema,
    name: RequiredTextSchema,
    description: DescriptionTextSchema,
    sourceWorkItemIds: SourceIdsSchema,
    evidence: RequiredTextSchema,
  })
  .transform((module) => ({
    ...module,
    description: module.description || module.evidence,
  }));

export const ProjectKnowledgeBusinessRuleSchema = z.object({
  id: RequiredTextSchema,
  rule: RequiredTextSchema,
  sourceField: RequiredTextSchema,
  moduleName: OptionalTextSchema,
  sourceWorkItemIds: SourceIdsSchema,
  evidence: RequiredTextSchema,
});

export const ProjectKnowledgeStateTransitionSchema = z.object({
  id: RequiredTextSchema,
  workflowName: RequiredTextSchema,
  fromState: OptionalTextSchema,
  toState: OptionalTextSchema,
  triggerOrCondition: RequiredTextSchema,
  actor: OptionalTextSchema,
  moduleName: OptionalTextSchema,
  sourceWorkItemIds: SourceIdsSchema,
  evidence: RequiredTextSchema,
});

export const ProjectKnowledgeGlossaryTermSchema = z.object({
  term: RequiredTextSchema,
  type: GlossaryTypeSchema,
  definition: RequiredTextSchema,
  sourceWorkItemIds: SourceIdsSchema,
  evidence: RequiredTextSchema,
});

type ProjectKnowledgeGlossaryTerm = z.infer<typeof ProjectKnowledgeGlossaryTermSchema>;

const GLOSSARY_TYPE_PRIORITY: Record<ProjectKnowledgeGlossaryTerm["type"], number> = {
  business_entity: 1,
  process: 2,
  role: 3,
  actor: 4,
  external_service: 5,
  system: 6,
  data_entity: 7,
  term: 8,
};

export const ProjectKnowledgeCrossDependencySchema = z
  .object({
    id: RequiredTextSchema,
    sourceModule: RequiredTextSchema,
    targetModule: RequiredTextSchema,
    dependencyType: RequiredTextSchema,
    description: DescriptionTextSchema,
    sourceWorkItemIds: SourceIdsSchema,
    evidence: RequiredTextSchema,
  })
  .transform((dependency) => ({
    ...dependency,
    description: dependency.description || dependency.evidence,
  }));

export const ProjectKnowledgeBaseSchema = z
  .object({
    modules: z.array(ProjectKnowledgeModuleSchema).default([]),
    businessRules: z.array(ProjectKnowledgeBusinessRuleSchema).default([]),
    stateTransitions: z.array(ProjectKnowledgeStateTransitionSchema).default([]),
    glossary: z.array(ProjectKnowledgeGlossaryTermSchema).default([]),
    crossDependencies: z.array(ProjectKnowledgeCrossDependencySchema).default([]),
  })
  .transform((knowledgeBase) => ({
    ...knowledgeBase,
    glossary: deduplicateGlossaryTerms(knowledgeBase.glossary),
  }));

function deduplicateGlossaryTerms(glossary: ProjectKnowledgeGlossaryTerm[]) {
  const grouped = new Map<
    string,
    {
      selected: ProjectKnowledgeGlossaryTerm;
      sourceWorkItemIds: string[];
      evidence: string[];
    }
  >();

  glossary.forEach((entry) => {
    const key = normalizeGlossaryTerm(entry.term);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        selected: entry,
        sourceWorkItemIds: entry.sourceWorkItemIds,
        evidence: splitEvidence(entry.evidence),
      });
      return;
    }

    existing.sourceWorkItemIds = mergeUnique(existing.sourceWorkItemIds, entry.sourceWorkItemIds);
    existing.evidence = mergeUnique(existing.evidence, splitEvidence(entry.evidence));

    if (isMoreBusinessLikeGlossaryEntry(entry, existing.selected)) {
      existing.selected = entry;
    }
  });

  return Array.from(grouped.values()).map((group) => ({
    ...group.selected,
    sourceWorkItemIds: group.sourceWorkItemIds,
    evidence: group.evidence.join(" | "),
  }));
}

function normalizeGlossaryTerm(term: string) {
  return term.trim().replace(/\s+/g, " ").toLowerCase();
}

function splitEvidence(evidence: string) {
  return evidence
    .split(/\s+\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mergeUnique(first: string[], second: string[]) {
  return Array.from(new Set([...first, ...second].map((value) => value.trim()).filter(Boolean)));
}

function isMoreBusinessLikeGlossaryEntry(candidate: ProjectKnowledgeGlossaryTerm, current: ProjectKnowledgeGlossaryTerm) {
  const candidatePriority = GLOSSARY_TYPE_PRIORITY[candidate.type];
  const currentPriority = GLOSSARY_TYPE_PRIORITY[current.type];

  if (candidatePriority !== currentPriority) {
    return candidatePriority < currentPriority;
  }

  return candidate.definition.length > current.definition.length;
}

export const PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE = {
  modules: [
    {
      id: "string",
      name: "string",
      description: "string; omit item if not supported, or use evidence-based description",
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
      description: "string; omit item if not supported, or use evidence-based description",
      sourceWorkItemIds: ["string"],
      evidence: "string",
    },
  ],
} as const;

export type ProjectKnowledgeBase = z.infer<typeof ProjectKnowledgeBaseSchema>;
