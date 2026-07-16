import {
  compareProjectKnowledgeAtomicConstraintValues,
  extractAtomicConstraint,
  projectKnowledgeAtomicConstraintIdentity,
  ProjectKnowledgeAtomicConstraintSchema,
  type ProjectKnowledgeAtomicConstraint,
} from "./project-knowledge-atomic-constraint";
import type { ProjectKnowledgeBase, ProjectKnowledgeEvidenceRef } from "./project-knowledge.schema";
import { projectKnowledgeEvidenceContentIdentitySet } from "./project-knowledge.schema";
import {
  buildEntryProvenanceProjection,
  canonicalizeProjectKnowledgeKey,
  compareProjectKnowledgeCanonicalText,
  flattenProjectKnowledgeSemanticEntries,
  hashCanonicalValue,
  type ProjectKnowledgeEntryCategory,
  type ProjectKnowledgeEntryValue,
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

export type ProjectKnowledgeHardConflictBasis = {
  object: string;
  property: string;
  condition?: string;
  values: Array<{
    participantId: string;
    operator: ProjectKnowledgeAtomicConstraint["operator"];
    value: string;
    valueType: ProjectKnowledgeAtomicConstraint["valueType"];
    unit?: string;
  }>;
};

export type ProjectKnowledgeHardConflict = {
  identityKey: string;
  subject: string;
  affectedCategory: ProjectKnowledgeEntryCategory;
  conflictType: "incompatible_concrete_value" | "incompatible_transition_target";
  participants: ProjectKnowledgeHardConflictParticipant[];
  evidenceIdentical: boolean;
  conflictBasis?: ProjectKnowledgeHardConflictBasis;
};

export function sortProjectKnowledgeHardConflictsForReview(conflicts: ProjectKnowledgeHardConflict[]) {
  return [...conflicts].sort((first, second) =>
    Number(first.evidenceIdentical) - Number(second.evidenceIdentical));
}

/**
 * Hard conflicts are limited to provable contradictions in the same atomic
 * slot and divergent state-transition targets. Logical ID collisions are
 * resolved upstream and never become a user-facing conflict on their own.
 */
export function detectProjectKnowledgeHardConflicts(
  knowledgeBase: ProjectKnowledgeBase,
): ProjectKnowledgeHardConflict[] {
  return [
    ...detectBusinessRuleConflicts(knowledgeBase),
    ...detectTransitionConflicts(knowledgeBase),
  ].sort((first, second) => compareProjectKnowledgeCanonicalText(first.identityKey, second.identityKey));
}

function detectBusinessRuleConflicts(knowledgeBase: ProjectKnowledgeBase) {
  type GroupMember = {
    participant: ProjectKnowledgeHardConflictParticipant;
    constraint: ProjectKnowledgeAtomicConstraint;
  };
  type Group = { subject: string; members: GroupMember[] };

  const grouped = new Map<string, Group>();
  for (const entry of flattenProjectKnowledgeSemanticEntries(knowledgeBase)) {
    if (entry.category !== "business_rule") continue;
    const rule = entry.entry as ProjectKnowledgeBase["businessRules"][number];
    const constraint = resolveBusinessRuleAtomicConstraint(rule);
    if (!constraint || !(rule.evidenceRefs?.length)) continue;
    const member = {
      participant: buildParticipant(entry, constraint.value, constraint),
      constraint,
    };
    for (const moduleName of businessRuleModuleScopes(rule, constraint)) {
      const groupKey = projectKnowledgeAtomicConstraintIdentity(constraint, moduleName);
      const group = grouped.get(groupKey) ?? {
        subject: renderAtomicConflictSubject(constraint, moduleName),
        members: [],
      };
      group.members.push(member);
      grouped.set(groupKey, group);
    }
  }

  const conflicts: ProjectKnowledgeHardConflict[] = [];
  for (const [constraintIdentity, group] of grouped) {
    if (!hasAtomicContradiction(group.members)) continue;
    const membersByParticipantId = new Map(group.members.map((member) => [member.participant.participantId, member]));
    const participants = sortParticipants(group.members.map((member) => member.participant));
    const basisConstraint = group.members[0]?.constraint;
    if (!basisConstraint) continue;
    const snapshotIds = Array.from(new Set(participants.flatMap((participant) => participant.sourceSnapshotIds))).sort();
    conflicts.push({
      identityKey: hashCanonicalValue({
        constraintIdentity,
        snapshotIds,
        participantConstraints: participants.map((participant) => {
          const constraint = membersByParticipantId.get(participant.participantId)?.constraint;
          return {
            participantId: participant.participantId,
            operator: constraint?.operator,
            value: constraint?.value,
            valueType: constraint?.valueType,
            unit: constraint?.unit ?? null,
          };
        }),
      }),
      subject: group.subject,
      affectedCategory: "business_rule",
      conflictType: "incompatible_concrete_value",
      participants,
      evidenceIdentical: participantsHaveIdenticalEvidence(participants),
      conflictBasis: {
        object: basisConstraint.object,
        property: basisConstraint.property,
        ...(basisConstraint.condition ? { condition: basisConstraint.condition } : {}),
        values: participants.map((participant) => {
          const constraint = membersByParticipantId.get(participant.participantId)?.constraint;
          if (!constraint) throw new Error("Every atomic conflict participant must retain its constraint.");
          return {
            participantId: participant.participantId,
            operator: constraint.operator,
            value: constraint.value,
            valueType: constraint.valueType,
            ...(constraint.unit ? { unit: constraint.unit } : {}),
          };
        }),
      },
    });
  }
  return conflicts;
}

function resolveBusinessRuleAtomicConstraint(rule: ProjectKnowledgeBase["businessRules"][number]) {
  const structured = ProjectKnowledgeAtomicConstraintSchema.safeParse(
    (rule as typeof rule & { constraint?: unknown }).constraint,
  );
  return structured.success ? structured.data : extractAtomicConstraint(rule.rule);
}

/**
 * A consolidated rule may represent the same claim in several modules. Each
 * association remains a distinct conflict scope, so a later contradiction in
 * any associated module cannot be hidden by the canonical primary module.
 */
function businessRuleModuleScopes(
  rule: ProjectKnowledgeBase["businessRules"][number],
  constraint: ProjectKnowledgeAtomicConstraint,
) {
  const candidates = [rule.moduleName, ...(rule.moduleAssociations ?? [])];
  const scopes = candidates.length ? candidates : [undefined];
  const unique = new Map<string, string | undefined>();
  for (const moduleName of scopes) {
    const identity = projectKnowledgeAtomicConstraintIdentity(constraint, moduleName);
    const existing = unique.get(identity);
    if (!unique.has(identity) || compareProjectKnowledgeCanonicalText(moduleName ?? "", existing ?? "") < 0) {
      unique.set(identity, moduleName);
    }
  }
  return Array.from(unique.entries())
    .sort(([first], [second]) => compareProjectKnowledgeCanonicalText(first, second))
    .map(([, moduleName]) => moduleName);
}

function hasAtomicContradiction(members: Array<{ constraint: ProjectKnowledgeAtomicConstraint }>) {
  for (let firstIndex = 0; firstIndex < members.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < members.length; secondIndex += 1) {
      const first = members[firstIndex];
      const second = members[secondIndex];
      if (!first || !second) continue;
      if (compareProjectKnowledgeAtomicConstraintValues(first.constraint, second.constraint) === "contradiction") {
        return true;
      }
    }
  }
  return false;
}

function renderAtomicConflictSubject(constraint: ProjectKnowledgeAtomicConstraint, moduleName?: string) {
  const modulePrefix = moduleName ? `${canonicalizeProjectKnowledgeKey(moduleName)}:` : "";
  return `${modulePrefix}${constraint.object}.${constraint.property}${
    constraint.condition ? ` when ${constraint.condition}` : ""
  }`;
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
      affectedCategory: sortedParticipants[0]?.category ?? "state_transition",
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
  atomicConstraint?: ProjectKnowledgeAtomicConstraint,
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
      atomicConstraint: atomicConstraint ?? null,
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
  const reference = identitySets[0]?.join("\n") ?? "";
  return identitySets.every((identities) => identities.join("\n") === reference);
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
