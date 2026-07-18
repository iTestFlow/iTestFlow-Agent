import { z } from "zod";

import { ProjectKnowledgeAtomicConstraintSchema } from "./project-knowledge-atomic-constraint";
import { canonicalizeProjectKnowledgeDependencyType } from "./project-knowledge-dependency-type";

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

export const PROJECT_KNOWLEDGE_SOURCE_FIELDS = [
  "title",
  "description",
  "acceptanceCriteria",
  "state",
  "tags",
  "areaPath",
  "iterationPath",
  "metadata",
] as const;

export const PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS = [
  "title",
  "description",
  "acceptanceCriteria",
  "metadata",
] as const;

export const ProjectKnowledgeEvidenceRefSchema = z.object({
  sourceSnapshotId: RequiredTextSchema,
  sourceWorkItemId: RequiredTextSchema,
  sourceField: z.enum(PROJECT_KNOWLEDGE_SOURCE_FIELDS),
  quote: RequiredTextSchema,
  locator: z.record(z.string(), z.unknown()).optional(),
  origin: z.enum(["generated_v2", "generated_v4", "migrated_legacy", "reviewer_reanchored"]),
  verification: z.enum(["exact", "normalized", "auto_reanchored", "unverified"]),
});

export type ProjectKnowledgeEvidenceRef = z.infer<typeof ProjectKnowledgeEvidenceRefSchema>;

const EvidenceRefsSchema = z
  .array(ProjectKnowledgeEvidenceRefSchema)
  .transform(sortProjectKnowledgeEvidenceRefs)
  .optional();

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
    evidenceRefs: EvidenceRefsSchema,
  })
  .transform((module) => {
    const provenance = deriveCompatibilityProvenance(module);
    return {
      ...module,
      ...provenance,
      description: module.description || provenance.evidence,
    };
  });

export const ProjectKnowledgeBusinessRuleSchema = z.object({
  id: RequiredTextSchema,
  rule: RequiredTextSchema,
  sourceField: RequiredTextSchema,
  moduleName: OptionalTextSchema,
  moduleAssociations: z.array(RequiredTextSchema).optional(),
  constraint: ProjectKnowledgeAtomicConstraintSchema.optional(),
  sourceWorkItemIds: SourceIdsSchema,
  evidence: RequiredTextSchema,
  evidenceRefs: EvidenceRefsSchema,
}).transform((rule) => ({ ...rule, ...deriveCompatibilityProvenance(rule) }));

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
  evidenceRefs: EvidenceRefsSchema,
}).transform((transition) => ({ ...transition, ...deriveCompatibilityProvenance(transition) }));

export const ProjectKnowledgeGlossaryTermSchema = z.object({
  term: RequiredTextSchema,
  type: GlossaryTypeSchema,
  definition: RequiredTextSchema,
  sourceWorkItemIds: SourceIdsSchema,
  evidence: RequiredTextSchema,
  evidenceRefs: EvidenceRefsSchema,
}).transform((term) => ({ ...term, ...deriveCompatibilityProvenance(term) }));

type ProjectKnowledgeModule = z.infer<typeof ProjectKnowledgeModuleSchema>;
type ProjectKnowledgeStateTransition = z.infer<typeof ProjectKnowledgeStateTransitionSchema>;
type ProjectKnowledgeGlossaryTerm = z.infer<typeof ProjectKnowledgeGlossaryTermSchema>;

export const ProjectKnowledgeCrossDependencySchema = z
  .object({
    id: RequiredTextSchema,
    sourceModule: RequiredTextSchema,
    targetModule: RequiredTextSchema,
    dependencyType: RequiredTextSchema,
    description: DescriptionTextSchema,
    sourceWorkItemIds: SourceIdsSchema,
    evidence: RequiredTextSchema,
    evidenceRefs: EvidenceRefsSchema,
  })
  .transform((dependency) => {
    const provenance = deriveCompatibilityProvenance(dependency);
    return {
      ...dependency,
      ...provenance,
      dependencyType: canonicalizeProjectKnowledgeDependencyType(dependency.dependencyType),
      description: dependency.description || provenance.evidence,
    };
  });

type ProjectKnowledgeCrossDependency = z.infer<typeof ProjectKnowledgeCrossDependencySchema>;

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
    crossDependencies: normalizeWorkflowStepDependencies(knowledgeBase),
  }));

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

function normalizeEvidenceQuote(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function canonicalLocator(locator: ProjectKnowledgeEvidenceRef["locator"]) {
  if (!locator) return "";
  return JSON.stringify(canonicalLocatorValue(locator));
}

function canonicalLocatorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalLocatorValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => compareCanonicalText(first, second))
      .map(([key, nested]) => [key, canonicalLocatorValue(nested)]),
  );
}

function evidenceRefIdentity(ref: ProjectKnowledgeEvidenceRef) {
  return [
    ref.sourceWorkItemId,
    ref.sourceSnapshotId,
    ref.sourceField,
    canonicalLocator(ref.locator),
    normalizeEvidenceQuote(ref.quote),
  ].join("\u0000");
}

export function sortProjectKnowledgeEvidenceRefs(refs: ProjectKnowledgeEvidenceRef[]) {
  return [...refs].sort((first, second) => compareCanonicalText(evidenceRefIdentity(first), evidenceRefIdentity(second)));
}

function compareCanonicalText(first: string, second: string) {
  return first < second ? -1 : first > second ? 1 : 0;
}

export function mergeProjectKnowledgeEvidenceRefs(
  first: ProjectKnowledgeEvidenceRef[],
  second: ProjectKnowledgeEvidenceRef[],
) {
  const refs = new Map<string, ProjectKnowledgeEvidenceRef>();
  [...first, ...second].forEach((ref) => refs.set(evidenceRefIdentity(ref), ref));
  return sortProjectKnowledgeEvidenceRefs(Array.from(refs.values()));
}

// Content identity deliberately excludes sourceSnapshotId and locator: both churn on
// re-sync even when the underlying source text is unchanged, and comparisons that need
// to survive that churn must key on what the evidence actually says, not which capture
// said it. The strict form keeps the quote byte-exact (past whitespace) and backs the
// evidence-identical conflict flag, where a false "identical" could hide a genuine
// disagreement from the reviewer. Merge gates and wording carry-over use the relaxed
// equivalence form below instead.
export function projectKnowledgeEvidenceContentIdentity(ref: ProjectKnowledgeEvidenceRef) {
  return [ref.sourceWorkItemId, ref.sourceField, normalizeEvidenceQuote(ref.quote)].join("\u0000");
}

// Relaxed quote form for merge-gate equivalence ONLY. LLM re-quoting drifts in terminal
// punctuation, symmetric wrapping quotes, and case even when the cited source text is
// unchanged; treating that drift as different evidence permanently splits paraphrase
// twins. NOT used by the evidence-identical conflict flag (strict above) nor by any
// persisted hash (contracts.ts keeps its own quote normalization). Smart quotes are
// deliberately excluded from wrapper stripping: they form asymmetric pairs that NFKC
// does not fold, so stripping them would risk eating interior characters.
function relaxedEvidenceQuoteForm(value: string) {
  let quote = normalizeEvidenceQuote(value).normalize("NFKC");
  for (let pass = 0; pass < 2; pass += 1) {
    quote = quote.replace(/^(["'`])(.*)\1$/u, "$2").trim();
    quote = quote.replace(/[.;:!?â€¦]+$/u, "").trim();
  }
  return quote.toLowerCase();
}

export function projectKnowledgeEvidenceContentEquivalenceIdentity(ref: ProjectKnowledgeEvidenceRef) {
  return [ref.sourceWorkItemId, ref.sourceField, relaxedEvidenceQuoteForm(ref.quote)].join("\u0000");
}

export function projectKnowledgeEvidenceContentIdentitySet(refs: ProjectKnowledgeEvidenceRef[] | undefined) {
  return evidenceContentIdentitySet(refs, projectKnowledgeEvidenceContentIdentity);
}

export function haveIdenticalNonEmptyEvidenceContent(
  first: ProjectKnowledgeEvidenceRef[] | undefined,
  second: ProjectKnowledgeEvidenceRef[] | undefined,
) {
  return haveMatchingNonEmptyEvidenceContent(first, second, projectKnowledgeEvidenceContentIdentity);
}

export function haveEquivalentNonEmptyEvidenceContent(
  first: ProjectKnowledgeEvidenceRef[] | undefined,
  second: ProjectKnowledgeEvidenceRef[] | undefined,
) {
  return haveMatchingNonEmptyEvidenceContent(first, second, projectKnowledgeEvidenceContentEquivalenceIdentity);
}

function evidenceContentIdentitySet(
  refs: ProjectKnowledgeEvidenceRef[] | undefined,
  identity: (ref: ProjectKnowledgeEvidenceRef) => string,
) {
  return Array.from(new Set((refs ?? []).map(identity))).sort(compareCanonicalText);
}

function haveMatchingNonEmptyEvidenceContent(
  first: ProjectKnowledgeEvidenceRef[] | undefined,
  second: ProjectKnowledgeEvidenceRef[] | undefined,
  identity: (ref: ProjectKnowledgeEvidenceRef) => string,
) {
  const firstIdentities = evidenceContentIdentitySet(first, identity);
  const secondIdentities = evidenceContentIdentitySet(second, identity);
  return firstIdentities.length > 0 &&
    firstIdentities.length === secondIdentities.length &&
    firstIdentities.every((value, index) => value === secondIdentities[index]);
}

export function renderProjectKnowledgeEvidenceRefs(refs: ProjectKnowledgeEvidenceRef[]) {
  return sortProjectKnowledgeEvidenceRefs(refs)
    .map((ref) => escapeProjectKnowledgeCompatibilityEvidenceFragment(normalizeEvidenceQuote(ref.quote)))
    .join(" | ");
}

export function escapeProjectKnowledgeCompatibilityEvidenceFragment(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export function splitProjectKnowledgeRenderedEvidence(value: string) {
  const fragments: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith(" | ", index)) {
      if (current.trim()) fragments.push(current.trim());
      current = "";
      index += 2;
      continue;
    }
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      const next = value[index + 1];
      if (next === "\\" || next === "|") {
        current += next;
        index += 1;
        continue;
      }
    }
    current += character;
  }
  if (current.trim()) fragments.push(current.trim());
  return fragments;
}

export function splitProjectKnowledgeLegacyEvidence(value: string) {
  return value.split(" | ").map((fragment) => fragment.trim()).filter(Boolean);
}

function deriveCompatibilityProvenance(input: {
  sourceWorkItemIds: string[];
  evidence: string;
  evidenceRefs?: ProjectKnowledgeEvidenceRef[];
}) {
  if (!input.evidenceRefs?.length) {
    return { sourceWorkItemIds: input.sourceWorkItemIds, evidence: input.evidence };
  }
  const evidenceRefs = sortProjectKnowledgeEvidenceRefs(input.evidenceRefs);
  return {
    evidenceRefs,
    sourceWorkItemIds: Array.from(new Set(evidenceRefs.map((ref) => ref.sourceWorkItemId))),
    evidence: renderProjectKnowledgeEvidenceRefs(evidenceRefs),
  };
}

export const PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE = {
  modules: [
    {
      id: "string",
      name: "string",
      description: "string; omit item if not supported, or use evidence-based description",
      sourceWorkItemIds: ["string"],
      evidence: "string",
      evidenceRefs: [
        {
          sourceSnapshotId: "string",
          sourceWorkItemId: "string",
          sourceField: "title | description | acceptanceCriteria | state | tags | areaPath | iterationPath | metadata",
          quote: "exact string",
          locator: "optional object",
          origin: "generated_v2",
          verification: "exact | normalized | auto_reanchored",
        },
      ],
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
      evidenceRefs: ["EvidenceRef"],
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
      evidenceRefs: ["EvidenceRef"],
    },
  ],
  glossary: [
    {
      term: "string",
      type: "term | actor | role | system | external_service | business_entity | data_entity | process",
      definition: "string",
      sourceWorkItemIds: ["string"],
      evidence: "string",
      evidenceRefs: ["EvidenceRef"],
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
      evidenceRefs: ["EvidenceRef"],
    },
  ],
} as const;

export type ProjectKnowledgeBase = z.infer<typeof ProjectKnowledgeBaseSchema>;
