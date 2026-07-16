import "server-only";

import { createHash } from "crypto";
import { z } from "zod";

import {
  PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS,
  PROJECT_KNOWLEDGE_SOURCE_FIELDS,
  ProjectKnowledgeBaseSchema,
  renderProjectKnowledgeEvidenceRefs,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";
import {
  normalizeProjectKnowledgeSourceWhitespace,
  PROJECT_KNOWLEDGE_SOURCE_PROJECTION_VERSION,
  projectKnowledgeCanonicalSourceText,
} from "./project-knowledge-source-text";

const RequiredText = z.string().trim().min(1);
const OptionalText = z.string().optional().transform((value) => value?.trim() || undefined);
const CitationSchema = z.object({
  handle: z.string().optional().default(""),
  quote: z.string().optional().default(""),
});
const CitationsSchema = z.array(CitationSchema).optional().default([]);
const GlossaryTypeSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : value,
  z.enum(["term", "actor", "role", "system", "external_service", "business_entity", "data_entity", "process"])
    .default("term")
    .catch("term"),
);

export const ProjectKnowledgeGeneratedBaseSchema = z.object({
  modules: z.array(z.object({
    id: RequiredText,
    name: RequiredText,
    description: z.string().optional().default("").transform((value) => value.trim()),
    citations: CitationsSchema,
  })).default([]),
  businessRules: z.array(z.object({
    id: RequiredText,
    rule: RequiredText,
    moduleName: OptionalText,
    citations: CitationsSchema,
  })).default([]),
  stateTransitions: z.array(z.object({
    id: RequiredText,
    workflowName: RequiredText,
    fromState: OptionalText,
    toState: OptionalText,
    triggerOrCondition: RequiredText,
    actor: OptionalText,
    moduleName: OptionalText,
    citations: CitationsSchema,
  })).default([]),
  glossary: z.array(z.object({
    term: RequiredText,
    type: GlossaryTypeSchema,
    definition: RequiredText,
    citations: CitationsSchema,
  })).default([]),
  crossDependencies: z.array(z.object({
    id: RequiredText,
    sourceModule: RequiredText,
    targetModule: RequiredText,
    dependencyType: RequiredText,
    description: z.string().optional().default("").transform((value) => value.trim()),
    citations: CitationsSchema,
  })).default([]),
});

export type ProjectKnowledgeGeneratedBase = z.infer<typeof ProjectKnowledgeGeneratedBaseSchema>;

export type ProjectKnowledgeCitationSource = {
  handle: string;
  sourceSnapshotId: string;
  sourceWorkItemId: string;
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"];
  text: string;
};

export type ProjectKnowledgeGroundingOmission = {
  category: "module" | "business_rule" | "state_transition" | "glossary" | "dependency";
  entryKey: string;
  reasons: string[];
};

export const PROJECT_KNOWLEDGE_GENERATED_OUTPUT_SHAPE = {
  modules: [{ id: "string", name: "string", description: "string", citations: [{ handle: "cite_...", quote: "exact quote" }] }],
  businessRules: [{ id: "string", rule: "string", moduleName: "optional string", citations: [{ handle: "cite_...", quote: "exact quote" }] }],
  stateTransitions: [{
    id: "string",
    workflowName: "string",
    fromState: "optional string",
    toState: "optional string",
    triggerOrCondition: "string",
    actor: "optional string",
    moduleName: "optional string",
    citations: [{ handle: "cite_...", quote: "exact quote" }],
  }],
  glossary: [{ term: "string", type: "term | actor | role | system | external_service | business_entity | data_entity | process", definition: "string", citations: [{ handle: "cite_...", quote: "exact quote" }] }],
  crossDependencies: [{ id: "string", sourceModule: "string", targetModule: "string", dependencyType: "string", description: "string", citations: [{ handle: "cite_...", quote: "exact quote" }] }],
} as const;

export function projectKnowledgeCitationHandle(
  sourceSnapshotId: string,
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"],
) {
  const digest = createHash("sha256")
    .update(`${PROJECT_KNOWLEDGE_SOURCE_PROJECTION_VERSION}\u0000${sourceSnapshotId}\u0000${sourceField}`)
    .digest("base64url")
    .slice(0, 20);
  return `cite_${digest}`;
}

export function buildProjectKnowledgeCitationSources(input: Array<{
  id: string;
  sourceSnapshotId: string;
  workItemType: string;
  title: string;
  state?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string[];
  areaPath?: string;
  iterationPath?: string;
  updatedDate?: string;
}>) {
  return input.flatMap<ProjectKnowledgeCitationSource>((item) => {
    const fields: Record<ProjectKnowledgeEvidenceRef["sourceField"], unknown> = {
      title: item.title,
      description: item.description,
      acceptanceCriteria: item.acceptanceCriteria,
      state: item.state,
      tags: item.tags,
      areaPath: item.areaPath,
      iterationPath: item.iterationPath,
      metadata: undefined,
    };
    return PROJECT_KNOWLEDGE_SOURCE_FIELDS.filter((sourceField) => sourceField !== "metadata").flatMap((sourceField) => {
      const text = projectKnowledgeCanonicalSourceText(fields[sourceField], sourceField);
      return text ? [{
        handle: projectKnowledgeCitationHandle(item.sourceSnapshotId, sourceField),
        sourceSnapshotId: item.sourceSnapshotId,
        sourceWorkItemId: item.id,
        sourceField,
        text,
      }] : [];
    });
  });
}

export function groundGeneratedProjectKnowledge(input: {
  generated: ProjectKnowledgeGeneratedBase;
  sources: ProjectKnowledgeCitationSource[];
}) {
  const sourceByHandle = new Map(input.sources.map((source) => [source.handle, source]));
  const omissions: ProjectKnowledgeGroundingOmission[] = [];
  const groundedEntryKeys: string[] = [];
  let candidateCount = 0;

  const provenance = (
    category: ProjectKnowledgeGroundingOmission["category"],
    entryKey: string,
    citations: Array<{ handle: string; quote: string }>,
  ) => {
    candidateCount += 1;
    const reasons: string[] = [];
    const refs = citations.flatMap<ProjectKnowledgeEvidenceRef>((citation) => {
      const source = sourceByHandle.get(citation.handle);
      if (!source) {
        reasons.push(citation.handle ? "unknown_citation_handle" : "missing_citation_handle");
        return [];
      }
      if (category === "business_rule" && !PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS.includes(
        source.sourceField as (typeof PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS)[number],
      )) {
        reasons.push("unsupported_business_rule_source_field");
        return [];
      }
      const match = matchCitationQuote(source.text, citation.quote);
      if (!match) {
        reasons.push(citation.quote.trim() ? "quote_not_found" : "missing_quote");
        return [];
      }
      return [{
        sourceSnapshotId: source.sourceSnapshotId,
        sourceWorkItemId: source.sourceWorkItemId,
        sourceField: source.sourceField,
        quote: match.quote,
        locator: {
          projectionVersion: PROJECT_KNOWLEDGE_SOURCE_PROJECTION_VERSION,
          citationHandle: source.handle,
          start: match.start,
          end: match.end,
        },
        origin: "generated_v4",
        verification: match.verification,
      }];
    });
    const uniqueRefs = Array.from(new Map(refs.map((ref) => [
      [ref.sourceSnapshotId, ref.sourceField, ref.quote].join("\u0000"),
      ref,
    ])).values());
    if (!uniqueRefs.length) {
      omissions.push({ category, entryKey, reasons: Array.from(new Set(reasons.length ? reasons : ["missing_citations"])) });
      return null;
    }
    groundedEntryKeys.push(`${category}:${entryKey}`);
    return {
      evidenceRefs: uniqueRefs,
      sourceWorkItemIds: Array.from(new Set(uniqueRefs.map((ref) => ref.sourceWorkItemId))),
      evidence: renderProjectKnowledgeEvidenceRefs(uniqueRefs),
    };
  };

  const knowledgeBase = ProjectKnowledgeBaseSchema.parse({
    modules: input.generated.modules.flatMap((entry) => {
      const refs = provenance("module", entry.id, entry.citations ?? []);
      return refs ? [{ ...entry, ...refs, description: entry.description || refs.evidence, citations: undefined }] : [];
    }),
    businessRules: input.generated.businessRules.flatMap((entry) => {
      const refs = provenance("business_rule", entry.id, entry.citations ?? []);
      return refs ? [{ ...entry, ...refs, sourceField: refs.evidenceRefs[0].sourceField, citations: undefined }] : [];
    }),
    stateTransitions: input.generated.stateTransitions.flatMap((entry) => {
      const refs = provenance("state_transition", entry.id, entry.citations ?? []);
      return refs ? [{ ...entry, ...refs, citations: undefined }] : [];
    }),
    glossary: input.generated.glossary.flatMap((entry) => {
      const refs = provenance("glossary", entry.term, entry.citations ?? []);
      return refs ? [{ ...entry, ...refs, citations: undefined }] : [];
    }),
    crossDependencies: input.generated.crossDependencies.flatMap((entry) => {
      const refs = provenance("dependency", entry.id, entry.citations ?? []);
      return refs ? [{ ...entry, ...refs, description: entry.description || refs.evidence, citations: undefined }] : [];
    }),
  });

  return {
    knowledgeBase,
    omissions,
    candidateCount,
    groundedEntryCount: candidateCount - omissions.length,
    groundedEntryKeys,
    omissionReasons: omissions.reduce<Record<string, number>>((counts, omission) => {
      for (const reason of omission.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

export function projectKnowledgeBaseToGeneratedPrompt(knowledgeBase: ProjectKnowledgeBase): ProjectKnowledgeGeneratedBase {
  const citations = (refs: ProjectKnowledgeEvidenceRef[] | undefined) => (refs ?? []).map((ref) => ({
    handle: projectKnowledgeCitationHandle(ref.sourceSnapshotId, ref.sourceField),
    quote: ref.quote,
  }));
  return ProjectKnowledgeGeneratedBaseSchema.parse({
    modules: knowledgeBase.modules.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      citations: citations(entry.evidenceRefs),
    })),
    businessRules: knowledgeBase.businessRules.map((entry) => ({
      id: entry.id,
      rule: entry.rule,
      moduleName: entry.moduleName,
      citations: citations(entry.evidenceRefs),
    })),
    stateTransitions: knowledgeBase.stateTransitions.map((entry) => ({
      id: entry.id,
      workflowName: entry.workflowName,
      fromState: entry.fromState,
      toState: entry.toState,
      triggerOrCondition: entry.triggerOrCondition,
      actor: entry.actor,
      moduleName: entry.moduleName,
      citations: citations(entry.evidenceRefs),
    })),
    glossary: knowledgeBase.glossary.map((entry) => ({
      term: entry.term,
      type: entry.type,
      definition: entry.definition,
      citations: citations(entry.evidenceRefs),
    })),
    crossDependencies: knowledgeBase.crossDependencies.map((entry) => ({
      id: entry.id,
      sourceModule: entry.sourceModule,
      targetModule: entry.targetModule,
      dependencyType: entry.dependencyType,
      description: entry.description,
      citations: citations(entry.evidenceRefs),
    })),
  });
}

export function generatedProjectKnowledgeForOmissions(
  generated: ProjectKnowledgeGeneratedBase,
  omissions: ProjectKnowledgeGroundingOmission[],
) {
  const keys = new Set(omissions.map((omission) => `${omission.category}:${omission.entryKey}`));
  return ProjectKnowledgeGeneratedBaseSchema.parse({
    modules: generated.modules.filter((entry) => keys.has(`module:${entry.id}`)),
    businessRules: generated.businessRules.filter((entry) => keys.has(`business_rule:${entry.id}`)),
    stateTransitions: generated.stateTransitions.filter((entry) => keys.has(`state_transition:${entry.id}`)),
    glossary: generated.glossary.filter((entry) => keys.has(`glossary:${entry.term}`)),
    crossDependencies: generated.crossDependencies.filter((entry) => keys.has(`dependency:${entry.id}`)),
  });
}

export function hasStrictProjectKnowledgeGrounding(knowledgeBase: ProjectKnowledgeBase) {
  return allEntries(knowledgeBase).every((entry) =>
    Boolean(entry.evidenceRefs?.length) &&
    entry.evidenceRefs!.every((ref) => ref.verification !== "unverified"));
}

export function omitUnsupportedProjectKnowledgeEntries(knowledgeBase: ProjectKnowledgeBase) {
  const supported = <T extends { evidenceRefs?: ProjectKnowledgeEvidenceRef[] }>(entries: T[]) =>
    entries.filter((entry) => Boolean(entry.evidenceRefs?.length) &&
      entry.evidenceRefs!.every((ref) => ref.verification !== "unverified"));
  const filtered = ProjectKnowledgeBaseSchema.parse({
    modules: supported(knowledgeBase.modules),
    businessRules: supported(knowledgeBase.businessRules),
    stateTransitions: supported(knowledgeBase.stateTransitions),
    glossary: supported(knowledgeBase.glossary),
    crossDependencies: supported(knowledgeBase.crossDependencies),
  });
  return {
    knowledgeBase: filtered,
    omittedEntryCount: allEntries(knowledgeBase).length - allEntries(filtered).length,
  };
}

function allEntries(knowledgeBase: ProjectKnowledgeBase) {
  return [
    ...knowledgeBase.modules,
    ...knowledgeBase.businessRules,
    ...knowledgeBase.stateTransitions,
    ...knowledgeBase.glossary,
    ...knowledgeBase.crossDependencies,
  ];
}

function matchCitationQuote(fieldText: string, quote: string) {
  const exactQuote = quote.trim();
  if (!exactQuote) return null;
  const exactStart = fieldText.indexOf(exactQuote);
  if (exactStart >= 0) {
    return { quote: exactQuote, start: exactStart, end: exactStart + exactQuote.length, verification: "exact" as const };
  }
  const normalizedQuote = normalizeProjectKnowledgeSourceWhitespace(exactQuote);
  const normalizedStart = fieldText.indexOf(normalizedQuote);
  if (normalizedStart >= 0) {
    return {
      quote: normalizedQuote,
      start: normalizedStart,
      end: normalizedStart + normalizedQuote.length,
      verification: "normalized" as const,
    };
  }
  return null;
}
