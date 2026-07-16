import { createHash } from "crypto";
import { z } from "zod";

import {
  PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS,
  ProjectKnowledgeBaseSchema,
  ProjectKnowledgeEvidenceRefSchema,
  sortProjectKnowledgeEvidenceRefs,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";

export const PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION = "4.0.0";
export const PROJECT_KNOWLEDGE_WORDING_VERSION = "4.0.0";
export const PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION = "semantic-v2";
export const PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION = "provenance-v2";
export const PROJECT_KNOWLEDGE_LEGACY_SEMANTIC_HASH_VERSION = "semantic-v1-backfill";
export const PROJECT_KNOWLEDGE_LEGACY_PROVENANCE_HASH_VERSION = "provenance-v1-legacy";
export const PROJECT_KNOWLEDGE_DRAFT_HEARTBEAT_TTL_MS = 10 * 60 * 1000;
export const PROJECT_KNOWLEDGE_MANUAL_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const PROJECT_KNOWLEDGE_DRAFT_STATUSES = [
  "generating",
  "awaiting_input",
  "ready_for_review",
  "ready_to_publish",
  "blocked",
  "rebase_required",
  "superseded",
  "published",
  "failed",
] as const;

export type ProjectKnowledgeDraftStatus = (typeof PROJECT_KNOWLEDGE_DRAFT_STATUSES)[number];
export type ProjectKnowledgeDraftDisplayStatus = ProjectKnowledgeDraftStatus | "compiling";

export const ProjectKnowledgeSourceManifestEntrySchema = z.object({
  sourceSnapshotId: z.string().trim().min(1),
  sourceWorkItemId: z.string().trim().min(1),
  workItemType: z.string().trim().min(1),
  contentHash: z.string().trim().min(1),
  adoRevision: z.number().int().nonnegative().nullable().optional(),
  sourceUpdatedAt: z.string().nullable().optional(),
  capturedAt: z.string().min(1),
});

export type ProjectKnowledgeSourceManifestEntry = z.infer<typeof ProjectKnowledgeSourceManifestEntrySchema>;

export const ProjectKnowledgeSourceManifestSchema = z
  .array(ProjectKnowledgeSourceManifestEntrySchema)
  .transform(sortProjectKnowledgeSourceManifest);

export const PROJECT_KNOWLEDGE_OPERATION_TYPES = [
  "create",
  "update",
  "confirm",
  "retire",
  "flag_contradiction",
] as const;

export type ProjectKnowledgeOperationType = (typeof PROJECT_KNOWLEDGE_OPERATION_TYPES)[number];

export const ProjectKnowledgeOperationSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(PROJECT_KNOWLEDGE_OPERATION_TYPES),
  category: z.string().trim().min(1),
  entryKey: z.string().trim().min(1),
  expectedEntryVersionId: z.string().trim().min(1).nullable(),
  expectedEntrySemanticHash: z.string().trim().min(1).nullable(),
  proposedEntry: z.record(z.string(), z.unknown()).nullable().optional(),
  participants: z.array(z.record(z.string(), z.unknown())).optional(),
  subjectKey: z.string().trim().min(1).optional(),
});

export type ProjectKnowledgeOperation = z.infer<typeof ProjectKnowledgeOperationSchema>;

export type ProjectKnowledgeEntryCategory =
  | "module"
  | "business_rule"
  | "state_transition"
  | "glossary"
  | "dependency";

export type ProjectKnowledgeEntryValue =
  | ProjectKnowledgeBase["modules"][number]
  | ProjectKnowledgeBase["businessRules"][number]
  | ProjectKnowledgeBase["stateTransitions"][number]
  | ProjectKnowledgeBase["glossary"][number]
  | ProjectKnowledgeBase["crossDependencies"][number];

export type ProjectKnowledgeSemanticEntry = {
  category: ProjectKnowledgeEntryCategory;
  entryKey: string;
  entry: ProjectKnowledgeEntryValue;
  projection: Record<string, unknown>;
  evidence: string;
  sourceWorkItemIds: string[];
  evidenceRefs: ProjectKnowledgeEvidenceRef[];
};

export type ProjectKnowledgeHashSet = {
  semanticKnowledgeHash: string;
  provenanceHash: string;
  entries: Array<
    ProjectKnowledgeSemanticEntry & {
      entrySemanticHash: string;
      entryProvenanceHash: string;
    }
  >;
};

export function canonicalizeProjectKnowledgeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Canonicalizes logical entry identities for alias matching without changing
 * the canonical keys used by semantic and provenance hash payloads.
 */
export function canonicalizeProjectKnowledgeLogicalIdentity(value: string | undefined) {
  return value
    ?.normalize("NFKC")
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") ?? "";
}

export function compareProjectKnowledgeCanonicalText(first: string, second: string) {
  return first < second ? -1 : first > second ? 1 : 0;
}

/**
 * Legacy source-field spellings are normalized for semantic hashing and lint
 * classification only. Stored knowledge is changed only by reviewed v2 publication.
 */
export function canonicalizeBusinessRuleSourceFieldForProjection(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const canonical = PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS.find(
    (candidate) => candidate.toLowerCase() === normalized,
  );
  if (canonical) return canonical;
  if (["acceptancecriterion", "acceptancecriteria", "criteria", "ac"].includes(normalized)) {
    return "acceptanceCriteria";
  }
  if (["desc", "systemdescription"].includes(normalized)) return "description";
  if (["name", "systemtitle"].includes(normalized)) return "title";
  return value.trim();
}

export function flattenProjectKnowledgeSemanticEntries(
  knowledgeBaseInput: ProjectKnowledgeBase,
): ProjectKnowledgeSemanticEntry[] {
  const knowledgeBase = ProjectKnowledgeBaseSchema.parse(knowledgeBaseInput);
  return [
    ...knowledgeBase.modules.map((entry) => ({
      category: "module" as const,
      entryKey: canonicalizeProjectKnowledgeKey(entry.id),
      entry,
      projection: {
        name: entry.name,
        description: entry.description,
      },
      evidence: entry.evidence,
      sourceWorkItemIds: entry.sourceWorkItemIds,
      evidenceRefs: entry.evidenceRefs ?? [],
    })),
    ...knowledgeBase.businessRules.map((entry) => ({
      category: "business_rule" as const,
      entryKey: canonicalizeProjectKnowledgeKey(entry.id),
      entry,
      projection: {
        rule: entry.rule,
        sourceField: canonicalizeBusinessRuleSourceFieldForProjection(entry.sourceField),
        moduleName: entry.moduleName ?? null,
      },
      evidence: entry.evidence,
      sourceWorkItemIds: entry.sourceWorkItemIds,
      evidenceRefs: entry.evidenceRefs ?? [],
    })),
    ...knowledgeBase.stateTransitions.map((entry) => ({
      category: "state_transition" as const,
      entryKey: canonicalizeProjectKnowledgeKey(entry.id),
      entry,
      projection: {
        workflowName: entry.workflowName,
        fromState: entry.fromState ?? null,
        toState: entry.toState ?? null,
        triggerOrCondition: entry.triggerOrCondition,
        actor: entry.actor ?? null,
        moduleName: entry.moduleName ?? null,
      },
      evidence: entry.evidence,
      sourceWorkItemIds: entry.sourceWorkItemIds,
      evidenceRefs: entry.evidenceRefs ?? [],
    })),
    ...knowledgeBase.glossary.map((entry) => ({
      category: "glossary" as const,
      entryKey: canonicalizeProjectKnowledgeKey(entry.term),
      entry,
      projection: {
        term: entry.term,
        type: entry.type,
        definition: entry.definition,
      },
      evidence: entry.evidence,
      sourceWorkItemIds: entry.sourceWorkItemIds,
      evidenceRefs: entry.evidenceRefs ?? [],
    })),
    ...knowledgeBase.crossDependencies.map((entry) => ({
      category: "dependency" as const,
      entryKey: canonicalizeProjectKnowledgeKey(entry.id),
      entry,
      projection: {
        sourceModule: entry.sourceModule,
        targetModule: entry.targetModule,
        dependencyType: entry.dependencyType,
        description: entry.description,
      },
      evidence: entry.evidence,
      sourceWorkItemIds: entry.sourceWorkItemIds,
      evidenceRefs: entry.evidenceRefs ?? [],
    })),
  ].sort(compareSemanticEntries);
}

export function computeProjectKnowledgeHashes(knowledgeBase: ProjectKnowledgeBase): ProjectKnowledgeHashSet {
  const entries = flattenProjectKnowledgeSemanticEntries(knowledgeBase).map((entry) => {
    const semanticPayload = {
      category: entry.category,
      canonicalKey: entry.entryKey,
      ...entry.projection,
    };
    return {
      ...entry,
      entrySemanticHash: hashCanonicalValue(semanticPayload),
      entryProvenanceHash: hashCanonicalValue(buildEntryProvenanceProjection(entry)),
    };
  });

  return {
    semanticKnowledgeHash: hashCanonicalValue(
      entries.map((entry) => ({
        category: entry.category,
        canonicalKey: entry.entryKey,
        projection: entry.projection,
      })),
    ),
    provenanceHash: hashCanonicalValue(
      entries.map((entry) => ({
        category: entry.category,
        canonicalKey: entry.entryKey,
        provenance: buildEntryProvenanceProjection(entry),
      })),
    ),
    entries,
  };
}

export function buildEntryProvenanceProjection(entry: {
  evidence: string;
  sourceWorkItemIds: string[];
  evidenceRefs: ProjectKnowledgeEvidenceRef[];
}) {
  if (entry.evidenceRefs.length) {
    return sortProjectKnowledgeEvidenceRefs(entry.evidenceRefs).map(canonicalEvidenceRefProjection);
  }
  return {
    legacyEvidence: entry.evidence,
    sourceWorkItemIds: [...new Set(entry.sourceWorkItemIds.map((id) => id.trim()).filter(Boolean))].sort(),
  };
}

export function canonicalEvidenceRefProjection(ref: ProjectKnowledgeEvidenceRef) {
  return ProjectKnowledgeEvidenceRefSchema.parse({
    sourceSnapshotId: ref.sourceSnapshotId,
    sourceWorkItemId: ref.sourceWorkItemId,
    sourceField: ref.sourceField,
    quote: normalizeEvidenceQuote(ref.quote),
    locator: ref.locator ? canonicalizeJsonValue(ref.locator) : undefined,
    origin: ref.origin,
    verification: ref.verification,
  });
}

export function getEntryProvenanceStatus(refs: ProjectKnowledgeEvidenceRef[]) {
  if (!refs.length) return "legacy_unknown" as const;
  const resolving = refs.filter((ref) => ref.verification !== "unverified").length;
  if (resolving === refs.length) return "verified" as const;
  if (resolving > 0) return "partial" as const;
  return "legacy_unverified" as const;
}

export function sortProjectKnowledgeSourceManifest(
  manifest: ProjectKnowledgeSourceManifestEntry[],
) {
  return [...manifest].sort(
    (first, second) =>
      compareProjectKnowledgeCanonicalText(first.sourceWorkItemId, second.sourceWorkItemId) ||
      compareProjectKnowledgeCanonicalText(first.sourceSnapshotId, second.sourceSnapshotId),
  );
}

export function computeProjectKnowledgeSourceFingerprint(
  manifest: ProjectKnowledgeSourceManifestEntry[],
) {
  return hashCanonicalValue(
    sortProjectKnowledgeSourceManifest(manifest).map((entry) => ({
      sourceSnapshotId: entry.sourceSnapshotId,
      sourceWorkItemId: entry.sourceWorkItemId,
      workItemType: entry.workItemType,
      contentHash: entry.contentHash,
      adoRevision: entry.adoRevision ?? null,
    })),
  );
}

export function displayProjectKnowledgeDraftStatus(
  status: ProjectKnowledgeDraftStatus,
  heartbeatAt: string | null,
  now = Date.now(),
): ProjectKnowledgeDraftDisplayStatus {
  if (status !== "generating" || !heartbeatAt) return status;
  const heartbeat = Date.parse(heartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat <= PROJECT_KNOWLEDGE_DRAFT_HEARTBEAT_TTL_MS
    ? "compiling"
    : status;
}

export function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => compareProjectKnowledgeCanonicalText(first, second))
      .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
  );
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function hashCanonicalValue(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compareSemanticEntries(first: ProjectKnowledgeSemanticEntry, second: ProjectKnowledgeSemanticEntry) {
  return compareProjectKnowledgeCanonicalText(first.category, second.category) ||
    compareProjectKnowledgeCanonicalText(first.entryKey, second.entryKey) ||
    compareProjectKnowledgeCanonicalText(canonicalJson(first.projection), canonicalJson(second.projection)) ||
    compareProjectKnowledgeCanonicalText(
      canonicalJson(buildEntryProvenanceProjection(first)),
      canonicalJson(buildEntryProvenanceProjection(second)),
    );
}

function normalizeEvidenceQuote(value: string) {
  return value.trim().replace(/\s+/g, " ");
}
