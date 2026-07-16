import type { ProjectKnowledgeBase, ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import type { ProjectKnowledgeEntryCategory, ProjectKnowledgeEntryValue } from "./project-knowledge-contracts";
import type {
  ProjectKnowledgeHardConflictBasis,
  ProjectKnowledgeHardConflictParticipant,
} from "./project-knowledge-conflicts";

export const PROJECT_KNOWLEDGE_REVIEW_CATEGORIES = [
  "module",
  "business_rule",
  "state_transition",
  "glossary",
  "dependency",
  "hard_conflict",
] as const;

export type ProjectKnowledgeReviewCategory = (typeof PROJECT_KNOWLEDGE_REVIEW_CATEGORIES)[number];

type BlockerBase = {
  id: string;
  type: string;
  category: ProjectKnowledgeReviewCategory;
  entryKey: string;
  entryInstanceId?: string;
  message: string;
};

export type ProjectKnowledgeEvidenceBlocker = BlockerBase & {
  type:
    | "missing_evidence_refs"
    | "quote_mismatch"
    | "snapshot_missing"
    | "work_item_mismatch"
    | "source_field_missing";
  sourceWorkItemIds: string[];
  sourceSnapshotId?: string;
  sourceWorkItemId?: string;
  sourceField?: string;
  referenceIdentity?: string;
};

export type ProjectKnowledgeInvalidSourceFieldBlocker = BlockerBase & {
  type: "invalid_business_rule_source_field";
  category: "business_rule";
  sourceWorkItemIds: string[];
};

export type ProjectKnowledgeReplayBlocker = BlockerBase & {
  type: "replay_conflict";
  operationId: string;
  result: string;
  base: Record<string, unknown> | null;
  latest: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
  actions: Array<"keep_latest" | "use_proposed" | "edit_proposed">;
};

export type ProjectKnowledgeHardConflictBlocker = BlockerBase & {
  type: "hard_conflict";
  category: "hard_conflict";
  affectedCategory: ProjectKnowledgeEntryCategory;
  identityKey: string;
  subject: string;
  conflictType: string;
  participants: ProjectKnowledgeHardConflictParticipant[];
  evidenceIdentical: boolean;
  conflictBasis?: ProjectKnowledgeHardConflictBasis;
};

export type ProjectKnowledgeDraftBlocker =
  | ProjectKnowledgeEvidenceBlocker
  | ProjectKnowledgeInvalidSourceFieldBlocker
  | ProjectKnowledgeReplayBlocker
  | ProjectKnowledgeHardConflictBlocker;

export type ProjectKnowledgeReviewSummary = {
  attemptedEvidenceRepairs: number;
  automaticEvidenceRepairs: number;
  automaticDuplicateConsolidations: number;
  preConsolidationDuplicateIdentities: number;
  paraphraseMerges: number;
  rekeys: number;
  atomicExtractionFailures: number;
  possibleTensions: number;
  wordingCarryOvers: number;
  unresolvedEvidenceEntries: number;
  remainingBlockers: number;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
};

export type ProjectKnowledgeReviewSourceField = {
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"];
  text: string;
};

export type ProjectKnowledgeReviewSource = {
  sourceSnapshotId: string;
  sourceWorkItemId: string;
  workItemType: string;
  workItemTitle: string;
  workItemUrl: string;
  adoRevision: number | null;
  sourceUpdatedAt: string | null;
  capturedAt: string | null;
  fields: ProjectKnowledgeReviewSourceField[];
};

export type ProjectKnowledgeReviewEvidenceSuggestion = {
  sourceSnapshotId: string;
  sourceWorkItemId: string;
  sourceField: ProjectKnowledgeEvidenceRef["sourceField"];
  quote: string;
  verification: "exact" | "normalized";
};

export type ProjectKnowledgeReviewContextEntry = {
  category: Exclude<ProjectKnowledgeReviewCategory, "hard_conflict">;
  entryKey: string;
  entryInstanceId: string;
  sourceAvailability: "available" | "snapshot_missing" | "unmatched_work_item" | "empty_fields";
  affectedWorkItemIds: string[];
  sources: ProjectKnowledgeReviewSource[];
  suggestedEvidence?: ProjectKnowledgeReviewEvidenceSuggestion[];
};

export type ProjectKnowledgeReviewContext = {
  entries: ProjectKnowledgeReviewContextEntry[];
  sources: ProjectKnowledgeReviewSource[];
};

export function projectKnowledgeBlockerId(input: {
  type: string;
  category?: string;
  entryKey?: string;
  entryInstanceId?: string;
  sourceSnapshotId?: string;
  sourceWorkItemId?: string;
  sourceField?: string;
  referenceIdentity?: string;
  detailDiscriminator?: string;
  operationId?: string;
  identityKey?: string;
}) {
  const base = [
    input.type,
    input.category ?? "unknown",
    input.entryKey ?? input.identityKey ?? "unknown",
    input.sourceSnapshotId ?? input.operationId ?? "",
  ];
  const detail = [
    input.entryInstanceId ? `entry=${input.entryInstanceId}` : "",
    input.sourceWorkItemId ? `work-item=${input.sourceWorkItemId}` : "",
    input.sourceField ? `field=${input.sourceField}` : "",
    input.referenceIdentity ? `reference=${input.referenceIdentity}` : "",
    input.detailDiscriminator ? `detail=${input.detailDiscriminator}` : "",
  ].filter(Boolean).join("|");
  return [...base, ...(detail ? [detail] : [])]
    .map((value) => encodeURIComponent(value))
    .join(":");
}

/**
 * Stable identity for one semantic entry instance. Unlike a logical entry key,
 * this remains collision-safe when a draft contains disagreeing versions of the
 * same entry. Callers can pass a flattened semantic entry directly.
 */
export function projectKnowledgeEntryInstanceId(input: {
  category: string;
  entryKey: string;
  projection: unknown;
  evidence?: string;
  sourceWorkItemIds?: string[];
  evidenceRefs?: ProjectKnowledgeEvidenceRef[];
  provenance?: unknown;
}) {
  const logicalKey = canonicalLogicalKey(input.entryKey) || canonicalKey(input.entryKey);
  const provenance = input.provenance ?? entryProvenanceProjection({
    evidence: input.evidence ?? "",
    sourceWorkItemIds: input.sourceWorkItemIds ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
  });
  return `pkei_${browserSafeCanonicalHash({
    category: input.category,
    logicalKey,
    semanticProjection: input.projection,
    provenance,
  })}`;
}

export type ProjectKnowledgeReviewEntryInstance = {
  category: ProjectKnowledgeEntryCategory;
  entryKey: string;
  entryInstanceId: string;
  entry: ProjectKnowledgeEntryValue;
};

/** Browser-safe projection used by guided review to find and update one entry. */
export function projectKnowledgeEntryInstances(
  knowledgeBase: ProjectKnowledgeBase,
): ProjectKnowledgeReviewEntryInstance[] {
  const instances: Array<{
    category: ProjectKnowledgeEntryCategory;
    entryKey: string;
    entry: ProjectKnowledgeEntryValue;
    projection: Record<string, unknown>;
  }> = [
    ...knowledgeBase.modules.map((entry) => ({
      category: "module" as const,
      entryKey: canonicalKey(entry.id),
      entry,
      projection: { name: entry.name, description: entry.description },
    })),
    ...knowledgeBase.businessRules.map((entry) => ({
      category: "business_rule" as const,
      entryKey: canonicalKey(entry.id),
      entry,
      projection: {
        rule: entry.rule,
        sourceField: canonicalBusinessRuleSourceField(entry.sourceField),
        moduleName: entry.moduleName ?? null,
      },
    })),
    ...knowledgeBase.stateTransitions.map((entry) => ({
      category: "state_transition" as const,
      entryKey: canonicalKey(entry.id),
      entry,
      projection: {
        workflowName: entry.workflowName,
        fromState: entry.fromState ?? null,
        toState: entry.toState ?? null,
        triggerOrCondition: entry.triggerOrCondition,
        actor: entry.actor ?? null,
        moduleName: entry.moduleName ?? null,
      },
    })),
    ...knowledgeBase.glossary.map((entry) => ({
      category: "glossary" as const,
      entryKey: canonicalKey(entry.term),
      entry,
      projection: { term: entry.term, type: entry.type, definition: entry.definition },
    })),
    ...knowledgeBase.crossDependencies.map((entry) => ({
      category: "dependency" as const,
      entryKey: canonicalKey(entry.id),
      entry,
      projection: {
        sourceModule: entry.sourceModule,
        targetModule: entry.targetModule,
        dependencyType: entry.dependencyType,
        description: entry.description,
      },
    })),
  ];
  return instances.map((instance) => ({
    category: instance.category,
    entryKey: instance.entryKey,
    entry: instance.entry,
    entryInstanceId: projectKnowledgeEntryInstanceId({
      ...instance,
      evidence: instance.entry.evidence,
      sourceWorkItemIds: instance.entry.sourceWorkItemIds,
      evidenceRefs: instance.entry.evidenceRefs ?? [],
    }),
  }));
}

export function findProjectKnowledgeEntryInstance(
  knowledgeBase: ProjectKnowledgeBase,
  entryInstanceId: string,
) {
  return projectKnowledgeEntryInstances(knowledgeBase)
    .find((instance) => instance.entryInstanceId === entryInstanceId) ?? null;
}

export function normalizeProjectKnowledgeBlockers(values: unknown[]): ProjectKnowledgeDraftBlocker[] {
  const normalized = values.flatMap<ProjectKnowledgeDraftBlocker>((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const blocker = value as Record<string, unknown>;
    const type = typeof blocker.type === "string" ? blocker.type : "publication_blocker";
    const category = normalizeCategory(blocker.category);
    const entryKey = stringValue(blocker.entryKey) || stringValue(blocker.identityKey) || "unknown";
    const message = stringValue(blocker.message) || defaultBlockerMessage(type);
    const sourceWorkItemId = stringValue(blocker.sourceWorkItemId);
    const sourceWorkItemIds = Array.from(new Set([
      ...stringArray(blocker.sourceWorkItemIds),
      ...(sourceWorkItemId ? [sourceWorkItemId] : []),
    ]));
    const sourceSnapshotId = stringValue(blocker.sourceSnapshotId);
    const sourceField = stringValue(blocker.sourceField);
    const referenceIdentity = stringValue(blocker.referenceIdentity);
    const entryInstanceId = stringValue(blocker.entryInstanceId) || projectKnowledgeEntryInstanceId({
      category: type === "hard_conflict"
        ? normalizeEntryCategory(blocker.affectedCategory) ?? "hard_conflict"
        : category,
      entryKey,
      projection: blocker.projection ?? blocker.semanticProjection ?? null,
      provenance: {
        legacyFallback: true,
        sourceWorkItemIds: [...sourceWorkItemIds].sort(),
        sourceSnapshotId: sourceSnapshotId || null,
        sourceField: sourceField || null,
        operationId: stringValue(blocker.operationId) || null,
        participantIds: arrayOfObjects(blocker.participants)
          .map((participant) => stringValue(participant.participantId))
          .filter(Boolean)
          .sort(),
      },
    });
    const id = stringValue(blocker.id) || projectKnowledgeBlockerId({
      type,
      category,
      entryKey,
      entryInstanceId,
      sourceSnapshotId,
      sourceWorkItemId,
      sourceField,
      referenceIdentity,
      operationId: stringValue(blocker.operationId),
      identityKey: stringValue(blocker.identityKey),
    });

    if (type === "replay_conflict") {
      return [{
        ...blocker,
        id,
        type,
        category,
        entryKey,
        entryInstanceId,
        message,
        operationId: stringValue(blocker.operationId),
        result: stringValue(blocker.result),
        base: objectValue(blocker.base),
        latest: objectValue(blocker.latest),
        proposed: objectValue(blocker.proposed),
        actions: ["keep_latest", "use_proposed", "edit_proposed"],
      } as ProjectKnowledgeReplayBlocker];
    }
    if (type === "hard_conflict") {
      const { conflictBasis: rawConflictBasis, ...hardConflictBlocker } = blocker;
      const participants = arrayOfObjects(blocker.participants) as unknown as ProjectKnowledgeHardConflictParticipant[];
      const conflictBasis = normalizeHardConflictBasis(rawConflictBasis);
      return [{
        ...hardConflictBlocker,
        id,
        type,
        category: "hard_conflict",
        entryKey,
        entryInstanceId,
        message,
        affectedCategory: normalizeEntryCategory(blocker.affectedCategory) ??
          normalizeEntryCategory(participants[0]?.category) ?? "module",
        identityKey: stringValue(blocker.identityKey) || entryKey,
        subject: stringValue(blocker.subject) || entryKey,
        conflictType: stringValue(blocker.conflictType) || "contradiction",
        participants,
        evidenceIdentical: blocker.evidenceIdentical === true,
        ...(conflictBasis
          ? { conflictBasis }
          : {}),
      } as ProjectKnowledgeHardConflictBlocker];
    }
    if (type === "invalid_business_rule_source_field") {
      return [{
        ...blocker,
        id,
        type,
        category: "business_rule",
        entryKey,
        entryInstanceId,
        message,
        sourceWorkItemIds,
      } as ProjectKnowledgeInvalidSourceFieldBlocker];
    }
    if (["missing_evidence_refs", "quote_mismatch", "snapshot_missing", "work_item_mismatch", "source_field_missing"].includes(type)) {
      return [{
        ...blocker,
        id,
        type,
        category,
        entryKey,
        entryInstanceId,
        message,
        sourceWorkItemIds,
        ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
        ...(sourceWorkItemId ? { sourceWorkItemId } : {}),
        ...(sourceField ? { sourceField } : {}),
        ...(referenceIdentity ? { referenceIdentity } : {}),
      } as ProjectKnowledgeEvidenceBlocker];
    }
    return [];
  });
  return ensureUniqueBlockerIds(normalized);
}

export function summarizeProjectKnowledgeReview(
  blockers: ProjectKnowledgeDraftBlocker[],
  metrics: Record<string, unknown>,
): ProjectKnowledgeReviewSummary {
  return {
    attemptedEvidenceRepairs: numberValue(metrics.autoEvidenceRepairAttemptedCount),
    automaticEvidenceRepairs: numberValue(metrics.autoEvidenceRepairCount),
    automaticDuplicateConsolidations: numberValue(metrics.automaticDuplicateConsolidationCount),
    preConsolidationDuplicateIdentities: numberValue(metrics.preConsolidationDuplicateIdentityCount),
    paraphraseMerges: numberValue(metrics.paraphraseMergeCount),
    rekeys: numberValue(metrics.rekeyCount),
    atomicExtractionFailures: numberValue(metrics.atomicExtractionFailureCount),
    possibleTensions: numberValue(metrics.possibleTensionCount),
    wordingCarryOvers: numberValue(metrics.wordingCarryOverCount),
    unresolvedEvidenceEntries: numberValue(metrics.autoEvidenceRepairUnresolvedCount),
    remainingBlockers: blockers.length,
    byType: countBy(blockers, (blocker) => blocker.type),
    byCategory: countBy(blockers, (blocker) =>
      blocker.type === "hard_conflict" ? blocker.affectedCategory : blocker.category),
  };
}

function normalizeEntryCategory(value: unknown): ProjectKnowledgeEntryCategory | null {
  return ["module", "business_rule", "state_transition", "glossary", "dependency"].includes(String(value))
    ? value as ProjectKnowledgeEntryCategory
    : null;
}

function normalizeCategory(value: unknown): ProjectKnowledgeReviewCategory {
  return typeof value === "string" && PROJECT_KNOWLEDGE_REVIEW_CATEGORIES.includes(value as ProjectKnowledgeReviewCategory)
    ? value as ProjectKnowledgeReviewCategory
    : "module";
}

function defaultBlockerMessage(type: string) {
  if (type === "missing_evidence_refs") return "This entry needs at least one immutable evidence reference.";
  if (type === "replay_conflict") return "Choose which version should be kept in the reviewed proposal.";
  if (type === "hard_conflict") return "These source-backed entries disagree and require a reviewer decision.";
  return "This entry must be reviewed before publication.";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayOfObjects(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeHardConflictBasis(value: unknown): ProjectKnowledgeHardConflictBasis | null {
  const basis = objectValue(value);
  if (!basis) return null;
  const object = stringValue(basis.object);
  const property = stringValue(basis.property);
  if (!object || !property) return null;
  const values = arrayOfObjects(basis.values).flatMap((item) => {
    const participantId = stringValue(item.participantId);
    const operator = stringValue(item.operator);
    const atomicValue = stringValue(item.value);
    const valueType = stringValue(item.valueType);
    if (
      !participantId ||
      !["eq", "lte", "gte", "lt", "gt", "ne"].includes(operator) ||
      !atomicValue ||
      !["number", "boolean", "enum", "state"].includes(valueType)
    ) {
      return [];
    }
    return [{
      participantId,
      operator: operator as ProjectKnowledgeHardConflictBasis["values"][number]["operator"],
      value: atomicValue,
      valueType: valueType as ProjectKnowledgeHardConflictBasis["values"][number]["valueType"],
      ...(stringValue(item.unit) ? { unit: stringValue(item.unit) } : {}),
    }];
  });
  if (!values.length) return null;
  return {
    object,
    property,
    ...(stringValue(basis.condition) ? { condition: stringValue(basis.condition) } : {}),
    values,
  };
}

function countBy(
  blockers: ProjectKnowledgeDraftBlocker[],
  selector: (blocker: ProjectKnowledgeDraftBlocker) => string,
) {
  return blockers.reduce<Record<string, number>>((counts, blocker) => {
    const key = selector(blocker);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function ensureUniqueBlockerIds(blockers: ProjectKnowledgeDraftBlocker[]) {
  const totals = blockers.reduce<Map<string, number>>((counts, blocker) => {
    counts.set(blocker.id, (counts.get(blocker.id) ?? 0) + 1);
    return counts;
  }, new Map());
  const occurrences = new Map<string, number>();
  return blockers.map((blocker) => {
    if ((totals.get(blocker.id) ?? 0) < 2) return blocker;
    const occurrence = (occurrences.get(blocker.id) ?? 0) + 1;
    occurrences.set(blocker.id, occurrence);
    return { ...blocker, id: `${blocker.id}:legacy-collision-${occurrence}` };
  });
}

function canonicalKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalLogicalKey(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function canonicalBusinessRuleSourceField(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const canonical = ["title", "description", "acceptanceCriteria", "metadata"]
    .find((candidate) => candidate.toLowerCase() === normalized);
  if (canonical) return canonical;
  if (["acceptancecriterion", "acceptancecriteria", "criteria", "ac"].includes(normalized)) {
    return "acceptanceCriteria";
  }
  if (["desc", "systemdescription"].includes(normalized)) return "description";
  if (["name", "systemtitle"].includes(normalized)) return "title";
  return value.trim();
}

function entryProvenanceProjection(input: {
  evidence: string;
  sourceWorkItemIds: string[];
  evidenceRefs: ProjectKnowledgeEvidenceRef[];
}) {
  if (input.evidenceRefs.length) {
    return [...input.evidenceRefs]
      .sort((first, second) => compareText(evidenceRefIdentity(first), evidenceRefIdentity(second)))
      .map((ref) => ({
        sourceSnapshotId: ref.sourceSnapshotId,
        sourceWorkItemId: ref.sourceWorkItemId,
        sourceField: ref.sourceField,
        quote: ref.quote.trim().replace(/\s+/g, " "),
        ...(ref.locator ? { locator: canonicalizeValue(ref.locator) } : {}),
        origin: ref.origin,
        verification: ref.verification,
      }));
  }
  return {
    legacyEvidence: input.evidence,
    sourceWorkItemIds: Array.from(new Set(
      input.sourceWorkItemIds.map((id) => id.trim()).filter(Boolean),
    )).sort(),
  };
}

function evidenceRefIdentity(ref: ProjectKnowledgeEvidenceRef) {
  return [
    ref.sourceWorkItemId,
    ref.sourceSnapshotId,
    ref.sourceField,
    ref.locator ? JSON.stringify(canonicalizeValue(ref.locator)) : "",
    ref.quote.trim().replace(/\s+/g, " "),
  ].join("\u0000");
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => compareText(first, second))
      .map(([key, nested]) => [key, canonicalizeValue(nested)]),
  );
}

function compareText(first: string, second: string) {
  return first < second ? -1 : first > second ? 1 : 0;
}

/** A synchronous 128-bit non-cryptographic hash that is safe in browser bundles. */
function browserSafeCanonicalHash(value: unknown) {
  const text = JSON.stringify(canonicalizeValue(value));
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
