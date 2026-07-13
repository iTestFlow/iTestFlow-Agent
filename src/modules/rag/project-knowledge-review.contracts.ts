import type { ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import type { ProjectKnowledgeEntryCategory } from "./project-knowledge-contracts";
import type { ProjectKnowledgeHardConflictParticipant } from "./project-knowledge-conflicts";

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

export type ProjectKnowledgeReviewContextEntry = {
  category: Exclude<ProjectKnowledgeReviewCategory, "hard_conflict">;
  entryKey: string;
  sources: ProjectKnowledgeReviewSource[];
};

export type ProjectKnowledgeReviewContext = {
  entries: ProjectKnowledgeReviewContextEntry[];
  sources: ProjectKnowledgeReviewSource[];
};

export function projectKnowledgeBlockerId(input: {
  type: string;
  category?: string;
  entryKey?: string;
  sourceSnapshotId?: string;
  operationId?: string;
  identityKey?: string;
}) {
  return [
    input.type,
    input.category ?? "unknown",
    input.entryKey ?? input.identityKey ?? "unknown",
    input.sourceSnapshotId ?? input.operationId ?? "",
  ].map((value) => encodeURIComponent(value)).join(":");
}

export function normalizeProjectKnowledgeBlockers(values: unknown[]): ProjectKnowledgeDraftBlocker[] {
  return values.flatMap<ProjectKnowledgeDraftBlocker>((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const blocker = value as Record<string, unknown>;
    const type = typeof blocker.type === "string" ? blocker.type : "publication_blocker";
    const category = normalizeCategory(blocker.category);
    const entryKey = stringValue(blocker.entryKey) || stringValue(blocker.identityKey) || "unknown";
    const message = stringValue(blocker.message) || defaultBlockerMessage(type);
    const id = stringValue(blocker.id) || projectKnowledgeBlockerId({
      type,
      category,
      entryKey,
      sourceSnapshotId: stringValue(blocker.sourceSnapshotId),
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
      const participants = arrayOfObjects(blocker.participants) as unknown as ProjectKnowledgeHardConflictParticipant[];
      return [{
        ...blocker,
        id,
        type,
        category: "hard_conflict",
        entryKey,
        message,
        affectedCategory: normalizeEntryCategory(blocker.affectedCategory) ??
          normalizeEntryCategory(participants[0]?.category) ?? "module",
        identityKey: stringValue(blocker.identityKey) || entryKey,
        subject: stringValue(blocker.subject) || entryKey,
        conflictType: stringValue(blocker.conflictType) || "contradiction",
        participants,
      } as ProjectKnowledgeHardConflictBlocker];
    }
    if (type === "invalid_business_rule_source_field") {
      return [{
        ...blocker,
        id,
        type,
        category: "business_rule",
        entryKey,
        message,
        sourceWorkItemIds: stringArray(blocker.sourceWorkItemIds),
      } as ProjectKnowledgeInvalidSourceFieldBlocker];
    }
    if (["missing_evidence_refs", "quote_mismatch", "snapshot_missing", "work_item_mismatch", "source_field_missing"].includes(type)) {
      const sourceWorkItemId = stringValue(blocker.sourceWorkItemId);
      return [{
        ...blocker,
        id,
        type,
        category,
        entryKey,
        message,
        sourceWorkItemIds: Array.from(new Set([
          ...stringArray(blocker.sourceWorkItemIds),
          ...(sourceWorkItemId ? [sourceWorkItemId] : []),
        ])),
        ...(stringValue(blocker.sourceSnapshotId) ? { sourceSnapshotId: stringValue(blocker.sourceSnapshotId) } : {}),
        ...(sourceWorkItemId ? { sourceWorkItemId } : {}),
        ...(stringValue(blocker.sourceField) ? { sourceField: stringValue(blocker.sourceField) } : {}),
      } as ProjectKnowledgeEvidenceBlocker];
    }
    return [];
  });
}

export function summarizeProjectKnowledgeReview(
  blockers: ProjectKnowledgeDraftBlocker[],
  metrics: Record<string, unknown>,
): ProjectKnowledgeReviewSummary {
  return {
    attemptedEvidenceRepairs: numberValue(metrics.autoEvidenceRepairAttemptedCount),
    automaticEvidenceRepairs: numberValue(metrics.autoEvidenceRepairCount),
    automaticDuplicateConsolidations: numberValue(metrics.automaticDuplicateConsolidationCount),
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
