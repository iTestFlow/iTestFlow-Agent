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
type ProjectKnowledgeModule = z.infer<typeof ProjectKnowledgeModuleSchema>;
type ProjectKnowledgeStateTransition = z.infer<typeof ProjectKnowledgeStateTransitionSchema>;

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

type ProjectKnowledgeCrossDependency = z.infer<typeof ProjectKnowledgeCrossDependencySchema>;

export const ProjectKnowledgeBaseSchema = z
  .object({
    modules: z.array(ProjectKnowledgeModuleSchema).default([]),
    businessRules: z.array(ProjectKnowledgeBusinessRuleSchema).default([]),
    stateTransitions: z.array(ProjectKnowledgeStateTransitionSchema).default([]),
    glossary: z.array(ProjectKnowledgeGlossaryTermSchema).default([]),
    crossDependencies: z.array(ProjectKnowledgeCrossDependencySchema).default([]),
  })
  .transform((knowledgeBase) => {
    const glossary = deduplicateGlossaryTerms(knowledgeBase.glossary);
    return {
      ...knowledgeBase,
      glossary,
      crossDependencies: normalizeWorkflowStepDependencies({
        ...knowledgeBase,
        glossary,
      }),
    };
  });

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

function normalizeWorkflowStepDependencies(knowledgeBase: {
  modules: ProjectKnowledgeModule[];
  stateTransitions: ProjectKnowledgeStateTransition[];
  glossary: ProjectKnowledgeGlossaryTerm[];
  crossDependencies: ProjectKnowledgeCrossDependency[];
}) {
  const canonicalEndpoints = buildCanonicalDependencyEndpoints(knowledgeBase);

  return knowledgeBase.crossDependencies.map((dependency) => {
    const source = normalizeDependencyEndpoint(dependency.sourceModule, canonicalEndpoints, dependency.id, dependency.targetModule);
    const target = normalizeDependencyEndpoint(dependency.targetModule, canonicalEndpoints, dependency.id, dependency.sourceModule);
    let description = dependency.description;

    if (source.originalEndpoint) {
      description = appendOriginalEndpointNote(description, "source", source.originalEndpoint);
    }
    if (target.originalEndpoint) {
      description = appendOriginalEndpointNote(description, "target", target.originalEndpoint);
    }

    return {
      ...dependency,
      sourceModule: source.endpoint,
      targetModule: target.endpoint,
      description,
    };
  });
}

function buildCanonicalDependencyEndpoints(input: {
  modules: ProjectKnowledgeModule[];
  stateTransitions: ProjectKnowledgeStateTransition[];
  glossary: ProjectKnowledgeGlossaryTerm[];
}) {
  const endpoints = new Map<string, CanonicalDependencyEndpoint>();
  const addEndpoint = (value: string | undefined, priority: number) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const key = normalizeDependencyEndpointKey(trimmed);
    const existing = endpoints.get(key);
    if (existing && existing.priority <= priority) return;
    endpoints.set(key, {
      name: trimmed,
      key,
      slug: slugDependencyEndpointKey(trimmed),
      priority,
    });
  };

  input.modules.forEach((module) => addEndpoint(module.name, 1));
  input.glossary.forEach((term) => addEndpoint(term.term, 2));
  input.stateTransitions.forEach((transition) => {
    addEndpoint(transition.workflowName, 3);
    addEndpoint(transition.moduleName, 3);
  });

  return Array.from(endpoints.values());
}

type CanonicalDependencyEndpoint = {
  name: string;
  key: string;
  slug: string;
  priority: number;
};

function normalizeDependencyEndpoint(
  endpoint: string,
  canonicalEndpoints: CanonicalDependencyEndpoint[],
  dependencyId: string,
  oppositeEndpoint: string,
) {
  const exactEndpoint = resolveCanonicalDependencyEndpoint(endpoint, canonicalEndpoints, dependencyId, oppositeEndpoint);
  if (exactEndpoint) return { endpoint: exactEndpoint.name, originalEndpoint: exactEndpoint.key === normalizeDependencyEndpointKey(endpoint) ? undefined : endpoint };

  return { endpoint };
}

function resolveCanonicalDependencyEndpoint(
  endpoint: string,
  canonicalEndpoints: CanonicalDependencyEndpoint[],
  dependencyId: string,
  oppositeEndpoint: string,
) {
  const endpointKey = normalizeDependencyEndpointKey(endpoint);
  const exactEndpoint = canonicalEndpoints.find((candidate) => candidate.key === endpointKey);
  if (exactEndpoint) return exactEndpoint;

  const parentEndpoint = getWorkflowStepParentEndpoint(endpoint);
  if (parentEndpoint) {
    const parentKey = normalizeDependencyEndpointKey(parentEndpoint);
    const canonicalParentEndpoint = canonicalEndpoints.find((candidate) => candidate.key === parentKey);
    if (canonicalParentEndpoint) return canonicalParentEndpoint;

    const parentSlug = slugDependencyEndpointKey(parentEndpoint);
    const parentMatch = chooseBestCanonicalEndpoint(
      canonicalEndpoints.filter((candidate) => endpointMatchesAlias(candidate, parentKey, parentSlug)),
    );
    if (parentMatch) return parentMatch;
  }

  const dependencySlug = slugDependencyEndpointKey(dependencyId);
  const oppositeKey = normalizeDependencyEndpointKey(oppositeEndpoint);
  return chooseBestCanonicalEndpoint(
    canonicalEndpoints.filter((candidate) => candidate.key !== oppositeKey && dependencySlug.includes(candidate.slug)),
  ) ?? null;
}

function endpointMatchesAlias(candidate: CanonicalDependencyEndpoint, aliasKey: string, aliasSlug: string) {
  if (aliasKey.length < 4 || aliasSlug.length < 4) return false;
  return candidate.key.includes(aliasKey) || candidate.slug.includes(aliasSlug);
}

function chooseBestCanonicalEndpoint(candidates: CanonicalDependencyEndpoint[]) {
  return candidates
    .filter((candidate) => candidate.slug.length >= 4)
    .sort((first, second) => first.priority - second.priority || first.key.length - second.key.length)[0];
}

function getWorkflowStepParentEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  const suffixMatch = trimmed.match(/^(.*?)\s+(?:workflow\s+)?step\s*#?\d+\.?\s*$/i);
  const suffixParent = suffixMatch?.[1] ? cleanWorkflowStepParent(suffixMatch[1]) : "";
  if (suffixParent) return suffixParent;

  const prefixMatch = trimmed.match(/^step\s*#?\d+\.?\s*[-:]\s*(.*?)$/i);
  const prefixParent = prefixMatch?.[1] ? cleanWorkflowStepParent(prefixMatch[1]) : "";
  if (prefixParent) return prefixParent;

  return null;
}

function cleanWorkflowStepParent(value: string) {
  return value.trim().replace(/[-:]+$/g, "").trim();
}

function normalizeDependencyEndpointKey(endpoint: string) {
  return endpoint.trim().toLowerCase().replace(/\s+/g, " ");
}

function slugDependencyEndpointKey(endpoint: string) {
  return normalizeDependencyEndpointKey(endpoint).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function appendOriginalEndpointNote(description: string, kind: "source" | "target", originalEndpoint: string) {
  const note = `Original ${kind} endpoint: ${originalEndpoint}.`;
  return description.includes(note) ? description : [description, note].filter(Boolean).join("\n\n");
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
