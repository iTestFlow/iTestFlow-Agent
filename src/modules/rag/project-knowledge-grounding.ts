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
import { validateProjectKnowledgeAtomicConstraint } from "./project-knowledge-atomic-constraint";

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
// Keep the generated constraint permissive enough for quote-backed grounding to
// reject incomplete or semantically invalid values, while giving native structured
// output providers a concrete JSON Schema. `z.unknown()` serializes as `{}`, which
// Anthropic rejects because it accepts any JSON value.
const GeneratedAtomicConstraintSchema = z.object({
  object: z.string().optional(),
  property: z.string().optional(),
  condition: z.string().optional(),
  operator: z.string().optional(),
  value: z.string().optional(),
  valueType: z.string().optional(),
  unit: z.string().optional(),
});

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
    moduleAssociations: z.array(RequiredText).optional(),
    constraint: GeneratedAtomicConstraintSchema.optional(),
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
  kind: "work_item";
  handle: string;
  sourceSnapshotId: string;
  sourceWorkItemId: string;
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"];
  text: string;
} | {
  kind: "document";
  handle: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  documentName: string;
  documentType?: string;
  sourceField: "documentContent";
  text: string;
  locator: Record<string, unknown>;
  verification: ProjectKnowledgeEvidenceRef["verification"];
};

export type ProjectSourceDocumentCitationChunk = {
  id: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  documentName: string;
  documentType?: string;
  section?: string | null;
  pageNumber?: number | null;
  content: string;
  metadata?: Record<string, unknown>;
  /** Image/OCR sources may carry this forward to preserve the review gate. */
  verification?: ProjectKnowledgeEvidenceRef["verification"];
};

export type ProjectKnowledgeGroundingOmission = {
  category: "module" | "business_rule" | "state_transition" | "glossary" | "dependency";
  entryKey: string;
  reasons: string[];
};

export const PROJECT_KNOWLEDGE_GENERATED_OUTPUT_SHAPE = {
  modules: [{ id: "string", name: "string", description: "string", citations: [{ handle: "cite_...", quote: "exact quote" }] }],
  businessRules: [{
    id: "string",
    rule: "string",
    moduleName: "optional string",
    moduleAssociations: "optional string[]",
    constraint: "optional { object: string, property: string, condition?: string, operator: eq | lte | gte | lt | gt | ne, value: string, valueType: number | boolean | enum | state, unit?: string }",
    citations: [{ handle: "cite_...", quote: "exact quote" }],
  }],
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

/**
 * Deliberately does not share the work-item hash payload. The explicit docref
 * namespace makes a document version/chunk handle collision impossible even if
 * ids happen to resemble Azure DevOps snapshot ids.
 */
export function projectSourceDocumentCitationHandle(
  sourceDocumentVersionId: string,
  chunkId: string,
) {
  const digest = createHash("sha256")
    .update(`docref\u0000${sourceDocumentVersionId}\u0000${chunkId}`)
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
}>): Extract<ProjectKnowledgeCitationSource, { kind: "work_item" }>[] {
  return input.flatMap<Extract<ProjectKnowledgeCitationSource, { kind: "work_item" }>>((item) => {
    const fields: Record<ProjectKnowledgeEvidenceRef["sourceField"], unknown> = {
      title: item.title,
      description: item.description,
      acceptanceCriteria: item.acceptanceCriteria,
      state: item.state,
      tags: item.tags,
      areaPath: item.areaPath,
      iterationPath: item.iterationPath,
      metadata: undefined,
      documentContent: undefined,
    };
    return PROJECT_KNOWLEDGE_SOURCE_FIELDS
      .filter((sourceField) => sourceField !== "metadata" && sourceField !== "documentContent")
      .flatMap((sourceField) => {
      const text = projectKnowledgeCanonicalSourceText(fields[sourceField], sourceField);
      return text ? [{
        kind: "work_item" as const,
        handle: projectKnowledgeCitationHandle(item.sourceSnapshotId, sourceField),
        sourceSnapshotId: item.sourceSnapshotId,
        sourceWorkItemId: item.id,
        sourceField,
        text,
      }] : [];
    });
  });
}

/**
 * Build document citations as a sibling path so the established Azure DevOps
 * handle calculation and field projection stay byte-for-byte untouched.
 */
export function buildProjectSourceDocumentCitationSources(
  chunks: ProjectSourceDocumentCitationChunk[],
): Extract<ProjectKnowledgeCitationSource, { kind: "document" }>[] {
  return chunks.flatMap((chunk) => {
    const text = projectKnowledgeCanonicalSourceText(chunk.content, "documentContent");
    if (!text) return [];
    return [{
      kind: "document" as const,
      handle: projectSourceDocumentCitationHandle(chunk.sourceDocumentVersionId, chunk.id),
      sourceDocumentId: chunk.sourceDocumentId,
      sourceDocumentVersionId: chunk.sourceDocumentVersionId,
      documentName: chunk.documentName,
      ...(chunk.documentType ? { documentType: chunk.documentType } : {}),
      sourceField: "documentContent" as const,
      text,
      locator: {
        documentChunkId: chunk.id,
        documentName: chunk.documentName,
        ...(chunk.section ? { section: chunk.section } : {}),
        ...(typeof chunk.pageNumber === "number" ? { pageNumber: chunk.pageNumber } : {}),
        ...(chunk.metadata && Object.keys(chunk.metadata).length ? { metadata: chunk.metadata } : {}),
      },
      verification: chunk.verification ?? "exact",
    }];
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
  let constraintRejectionCount = 0;

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
      const locator = {
        ...(source.kind === "document" ? source.locator : {}),
        projectionVersion: PROJECT_KNOWLEDGE_SOURCE_PROJECTION_VERSION,
        citationHandle: source.handle,
        start: match.start,
        end: match.end,
      };
      if (source.kind === "document") {
        return [{
          sourceKind: "document" as const,
          sourceDocumentId: source.sourceDocumentId,
          sourceDocumentVersionId: source.sourceDocumentVersionId,
          sourceField: source.sourceField,
          quote: match.quote,
          locator,
          origin: "generated_v4" as const,
          verification: source.verification === "unverified" ? "unverified" as const : match.verification,
        }];
      }
      return [{
        sourceKind: "work_item" as const,
        sourceSnapshotId: source.sourceSnapshotId,
        sourceWorkItemId: source.sourceWorkItemId,
        sourceField: source.sourceField,
        quote: match.quote,
        locator,
        origin: "generated_v4" as const,
        verification: match.verification,
      }];
    });
    const uniqueRefs = Array.from(new Map(refs.map((ref) => [
      [
        ref.sourceKind,
        ref.sourceSnapshotId ?? "",
        ref.sourceDocumentVersionId ?? "",
        ref.sourceField,
        ref.quote,
      ].join("\u0000"),
      ref,
    ])).values());
    if (!uniqueRefs.length) {
      omissions.push({ category, entryKey, reasons: Array.from(new Set(reasons.length ? reasons : ["missing_citations"])) });
      return null;
    }
    groundedEntryKeys.push(`${category}:${entryKey}`);
    return {
      evidenceRefs: uniqueRefs,
      sourceWorkItemIds: Array.from(new Set(uniqueRefs.flatMap((ref) =>
        ref.sourceKind === "work_item" && ref.sourceWorkItemId ? [ref.sourceWorkItemId] : []))),
      evidence: renderProjectKnowledgeEvidenceRefs(uniqueRefs),
    };
  };

  const knowledgeBase = ProjectKnowledgeBaseSchema.parse({
    modules: input.generated.modules.flatMap((entry) => {
      const refs = provenance("module", entry.id, entry.citations ?? []);
      return refs ? [{ ...entry, ...refs, description: entry.description || refs.evidence, citations: undefined }] : [];
    }),
    businessRules: input.generated.businessRules.flatMap((entry) => {
      const { constraint: rawConstraint, moduleAssociations, ...businessRule } = entry;
      const refs = provenance("business_rule", entry.id, entry.citations ?? []);
      if (!refs) {
        if (rawConstraint !== undefined) constraintRejectionCount += 1;
        return [];
      }
      const constraint = rawConstraint === undefined
        ? null
        : validateProjectKnowledgeAtomicConstraint(
          rawConstraint,
          refs.evidenceRefs.map((ref) => ref.quote),
        );
      if (rawConstraint !== undefined && !constraint) constraintRejectionCount += 1;
      return [{
        ...businessRule,
        ...refs,
        ...(moduleAssociations ? { moduleAssociations } : {}),
        ...(constraint ? { constraint } : {}),
        sourceField: refs.evidenceRefs[0].sourceField,
        citations: undefined,
      }];
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
    constraintRejectionCount,
    omissionReasons: omissions.reduce<Record<string, number>>((counts, omission) => {
      for (const reason of omission.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

export function projectKnowledgeBaseToGeneratedPrompt(knowledgeBase: ProjectKnowledgeBase): ProjectKnowledgeGeneratedBase {
  const citations = (refs: ProjectKnowledgeEvidenceRef[] | undefined) => (refs ?? []).flatMap((ref) => {
    const handle = projectKnowledgeCitationHandleForEvidenceRef(ref);
    return handle ? [{ handle, quote: ref.quote }] : [];
  });
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
      ...(entry.moduleAssociations ? { moduleAssociations: entry.moduleAssociations } : {}),
      ...(entry.constraint ? { constraint: entry.constraint } : {}),
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

function projectKnowledgeCitationHandleForEvidenceRef(ref: ProjectKnowledgeEvidenceRef) {
  if (ref.sourceKind !== "document") {
    return ref.sourceSnapshotId && ref.sourceWorkItemId
      ? projectKnowledgeCitationHandle(ref.sourceSnapshotId, ref.sourceField)
      : null;
  }
  const chunkId = typeof ref.locator?.documentChunkId === "string" ? ref.locator.documentChunkId.trim() : "";
  return ref.sourceDocumentVersionId && chunkId
    ? projectSourceDocumentCitationHandle(ref.sourceDocumentVersionId, chunkId)
    : null;
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
