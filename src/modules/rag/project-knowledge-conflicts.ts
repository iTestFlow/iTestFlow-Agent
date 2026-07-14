import type { ProjectKnowledgeBase, ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import { projectKnowledgeEvidenceContentIdentitySet } from "./project-knowledge.schema";
import {
  buildEntryProvenanceProjection,
  canonicalizeProjectKnowledgeKey,
  canonicalizeProjectKnowledgeLogicalIdentity,
  compareProjectKnowledgeCanonicalText,
  flattenProjectKnowledgeSemanticEntries,
  hashCanonicalValue,
  type ProjectKnowledgeEntryValue,
  type ProjectKnowledgeEntryCategory,
  type ProjectKnowledgeSemanticEntry,
} from "./project-knowledge-contracts";

export type ProjectKnowledgeHardConflictParticipant = {
  participantId: string;
  category: ProjectKnowledgeEntryCategory;
  entryKey: string;
  entry: ProjectKnowledgeEntryValue;
  projection: Record<string, unknown>;
  semanticHash: string;
  concreteValue?: string;
  evidenceRefs: ProjectKnowledgeEvidenceRef[];
  sourceSnapshotIds: string[];
  sourceWorkItemIds: string[];
  evidence: string;
};

export type ProjectKnowledgeHardConflict = {
  identityKey: string;
  subject: string;
  affectedCategory: ProjectKnowledgeEntryCategory;
  conflictType: "incompatible_concrete_value" | "incompatible_transition_target" | "duplicate_identity";
  participants: ProjectKnowledgeHardConflictParticipant[];
  evidenceIdentical: boolean;
};

export function sortProjectKnowledgeHardConflictsForReview(conflicts: ProjectKnowledgeHardConflict[]) {
  return [...conflicts].sort((first, second) =>
    Number(first.evidenceIdentical) - Number(second.evidenceIdentical));
}

export function detectProjectKnowledgeHardConflicts(
  knowledgeBase: ProjectKnowledgeBase,
): ProjectKnowledgeHardConflict[] {
  const specificConflicts = [
    ...detectBusinessRuleConflicts(knowledgeBase),
    ...detectTransitionConflicts(knowledgeBase),
  ];
  return [
    ...detectDuplicateIdentityConflicts(knowledgeBase).filter((duplicateConflict) =>
      !specificConflicts.some((specificConflict) =>
        hasSameParticipantSet(duplicateConflict, specificConflict))),
    ...specificConflicts,
  ].sort((first, second) => compareProjectKnowledgeCanonicalText(first.identityKey, second.identityKey));
}

function hasSameParticipantSet(
  first: ProjectKnowledgeHardConflict,
  second: ProjectKnowledgeHardConflict,
) {
  if (first.affectedCategory !== second.affectedCategory) return false;
  if (first.participants.length !== second.participants.length) return false;
  const secondParticipantIds = new Set(second.participants.map((participant) => participant.participantId));
  return first.participants.every((participant) => secondParticipantIds.has(participant.participantId));
}

function detectDuplicateIdentityConflicts(knowledgeBase: ProjectKnowledgeBase) {
  const grouped = new Map<string, ProjectKnowledgeHardConflictParticipant[]>();
  for (const entry of flattenProjectKnowledgeSemanticEntries(knowledgeBase)) {
    const subject = `identity:${entry.category}:${canonicalizeProjectKnowledgeLogicalIdentity(entry.entryKey)}`;
    addParticipant(grouped, subject, buildParticipant(entry));
  }

  const conflicts: ProjectKnowledgeHardConflict[] = [];
  for (const [subject, participants] of grouped) {
    if (participants.length < 2) continue;
    if (new Set(participants.map((participant) => hashCanonicalValue(participant.projection))).size < 2) continue;
    const sortedParticipants = sortParticipants(participants);
    conflicts.push({
      identityKey: hashCanonicalValue({
        subject,
        participantProjections: sortedParticipants.map((participant) => participant.semanticHash),
        snapshotIds: Array.from(new Set(sortedParticipants.flatMap((participant) => participant.sourceSnapshotIds))).sort(),
      }),
      subject,
      affectedCategory: sortedParticipants[0].category,
      conflictType: "duplicate_identity",
      participants: sortedParticipants,
      evidenceIdentical: participantsHaveIdenticalEvidence(sortedParticipants),
    });
  }
  return conflicts;
}

function detectBusinessRuleConflicts(knowledgeBase: ProjectKnowledgeBase) {
  const grouped = new Map<string, ProjectKnowledgeHardConflictParticipant[]>();
  for (const entry of flattenProjectKnowledgeSemanticEntries(knowledgeBase)) {
    if (entry.category !== "business_rule") continue;
    const rule = entry.entry as ProjectKnowledgeBase["businessRules"][number];
    const concrete = parseConcreteRule(rule.rule);
    if (!concrete || !(rule.evidenceRefs?.length)) continue;
    const subject = canonicalizeProjectKnowledgeKey(
      [rule.moduleName, concrete.subject].filter(Boolean).join(":"),
    );
    addParticipant(grouped, subject, buildParticipant(entry, concrete.value));
  }
  return conflictsFromGroups(grouped, "incompatible_concrete_value");
}

function detectTransitionConflicts(knowledgeBase: ProjectKnowledgeBase) {
  const grouped = new Map<string, ProjectKnowledgeHardConflictParticipant[]>();
  for (const entry of flattenProjectKnowledgeSemanticEntries(knowledgeBase)) {
    if (entry.category !== "state_transition") continue;
    const transition = entry.entry as ProjectKnowledgeBase["stateTransitions"][number];
    if (!transition.toState || !(transition.evidenceRefs?.length)) continue;
    const subject = canonicalizeProjectKnowledgeKey(
      [
        transition.moduleName,
        transition.workflowName,
        transition.fromState ?? "unspecified",
        transition.triggerOrCondition,
      ].filter(Boolean).join(":"),
    );
    addParticipant(grouped, subject, buildParticipant(
      entry,
      canonicalizeProjectKnowledgeKey(transition.toState),
    ));
  }
  return conflictsFromGroups(grouped, "incompatible_transition_target");
}

function conflictsFromGroups(
  grouped: Map<string, ProjectKnowledgeHardConflictParticipant[]>,
  conflictType: ProjectKnowledgeHardConflict["conflictType"],
) {
  const conflicts: ProjectKnowledgeHardConflict[] = [];
  for (const [subject, participants] of grouped) {
    if (new Set(participants.map((participant) =>
      canonicalizeProjectKnowledgeKey(participant.concreteValue ?? ""))).size < 2) {
      continue;
    }
    const sortedParticipants = sortParticipants(participants);
    const snapshotIds = Array.from(new Set(sortedParticipants.flatMap((participant) => participant.sourceSnapshotIds))).sort();
    conflicts.push({
      identityKey: hashCanonicalValue({
        subject,
        snapshotIds,
        participantValues: sortedParticipants.map((participant) => participant.concreteValue ?? ""),
      }),
      subject,
      affectedCategory: sortedParticipants[0].category,
      conflictType,
      participants: sortedParticipants,
      evidenceIdentical: participantsHaveIdenticalEvidence(sortedParticipants),
    });
  }
  return conflicts;
}

function sortParticipants(participants: ProjectKnowledgeHardConflictParticipant[]) {
  return [...participants].sort((first, second) =>
    compareProjectKnowledgeCanonicalText(first.entryKey, second.entryKey) ||
    compareProjectKnowledgeCanonicalText(first.concreteValue ?? "", second.concreteValue ?? "") ||
    compareProjectKnowledgeCanonicalText(first.semanticHash, second.semanticHash) ||
    compareProjectKnowledgeCanonicalText(first.participantId, second.participantId) ||
    compareProjectKnowledgeCanonicalText(first.evidence, second.evidence));
}

function buildParticipant(
  entry: ProjectKnowledgeSemanticEntry,
  concreteValue?: string,
): ProjectKnowledgeHardConflictParticipant {
  const semanticHash = hashCanonicalValue({
    category: entry.category,
    canonicalKey: entry.entryKey,
    ...entry.projection,
  });
  const provenanceHash = hashCanonicalValue(buildEntryProvenanceProjection(entry));
  return {
    participantId: hashCanonicalValue({
      category: entry.category,
      canonicalKey: entry.entryKey,
      semanticHash,
      provenanceHash,
    }),
    category: entry.category,
    entryKey: entry.entryKey,
    entry: entry.entry,
    projection: entry.projection,
    semanticHash,
    ...(concreteValue === undefined ? {} : { concreteValue }),
    evidenceRefs: entry.evidenceRefs,
    sourceSnapshotIds: sourceSnapshotIds(entry.evidenceRefs),
    sourceWorkItemIds: [...new Set(entry.sourceWorkItemIds)].sort(),
    evidence: entry.evidence,
  };
}

function participantsHaveIdenticalEvidence(participants: ProjectKnowledgeHardConflictParticipant[]) {
  const identitySets = participants.map((participant) =>
    projectKnowledgeEvidenceContentIdentitySet(participant.evidenceRefs));
  if (identitySets.some((identities) => !identities.length)) return false;
  const reference = identitySets[0].join("\n");
  return identitySets.every((identities) => identities.join("\n") === reference);
}

export function parseConcreteRule(rule: string) {
  const match = rule.trim().match(/^(.{2,120}?)\s+(?:must\s+be|shall\s+be|is|equals|=)\s+(.{1,120})$/i);
  if (!match?.[1] || !match[2]) return null;
  const value = canonicalizeProjectKnowledgeKey(match[2].replace(/[.;]+$/g, ""));
  if (!/\d|\b(?:true|false|required|allowed|denied|enabled|disabled|yes|no|active|inactive)\b/i.test(value)) {
    return null;
  }
  return { subject: match[1], value };
}

function sourceSnapshotIds(refs: ProjectKnowledgeEvidenceRef[]) {
  return Array.from(new Set(refs.map((ref) => ref.sourceSnapshotId))).sort();
}

function addParticipant(
  grouped: Map<string, ProjectKnowledgeHardConflictParticipant[]>,
  subject: string,
  participant: ProjectKnowledgeHardConflictParticipant,
) {
  const existing = grouped.get(subject) ?? [];
  existing.push(participant);
  grouped.set(subject, existing);
}
