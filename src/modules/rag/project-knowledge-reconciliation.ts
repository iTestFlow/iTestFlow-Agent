import {
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import {
  canonicalizeProjectKnowledgeKey,
  compareProjectKnowledgeCanonicalText,
  computeProjectKnowledgeHashes,
  hashCanonicalValue,
  type ProjectKnowledgeOperation,
  type ProjectKnowledgeReplayResult,
} from "./project-knowledge-contracts";

export type ProjectKnowledgeVersionPrecondition = {
  category: string;
  entryKey: string;
  entryVersionId: string;
  entrySemanticHash: string;
  status?: string;
};

export type ProjectKnowledgeReplayOutcome = {
  operation: ProjectKnowledgeOperation;
  result: ProjectKnowledgeReplayResult;
  base: Record<string, unknown> | null;
  latest: Record<string, unknown> | null;
  proposed: Record<string, unknown> | null;
};

type RawKnowledgeEntry = {
  category: string;
  entryKey: string;
  value: Record<string, unknown>;
};

export function buildProjectKnowledgeOperations(input: {
  baseKnowledgeBase: ProjectKnowledgeBase | null;
  proposedKnowledgeBase: ProjectKnowledgeBase;
  baseVersions?: ProjectKnowledgeVersionPrecondition[];
  touchedKeys?: Set<string>;
}) {
  const baseEntries = toEntryMap(input.baseKnowledgeBase);
  const proposedEntries = toEntryMap(input.proposedKnowledgeBase);
  const baseHashes = input.baseKnowledgeBase
    ? new Map(
        computeProjectKnowledgeHashes(input.baseKnowledgeBase).entries.map((entry) => [
          entryIdentity(entry.category, entry.entryKey),
          entry,
        ]),
      )
    : new Map();
  const proposedHashes = new Map(
    computeProjectKnowledgeHashes(input.proposedKnowledgeBase).entries.map((entry) => [
      entryIdentity(entry.category, entry.entryKey),
      entry,
    ]),
  );
  const versions = new Map(
    (input.baseVersions ?? []).map((version) => [
      entryIdentity(version.category, version.entryKey),
      version,
    ]),
  );
  const operations: ProjectKnowledgeOperation[] = [];

  for (const [identity, proposed] of proposedEntries) {
    if (input.touchedKeys && !input.touchedKeys.has(identity)) continue;
    const base = baseEntries.get(identity);
    const version = versions.get(identity);
    const proposedHash = proposedHashes.get(identity);
    const baseHash = baseHashes.get(identity);
    const type = !base
      ? "create"
      : proposedHash?.entrySemanticHash === baseHash?.entrySemanticHash
        ? "confirm"
        : "update";
    operations.push({
      id: operationId(type, identity, proposed.value),
      type,
      category: proposed.category,
      entryKey: proposed.entryKey,
      expectedEntryVersionId: version?.entryVersionId ?? null,
      expectedEntrySemanticHash: version?.entrySemanticHash ?? baseHash?.entrySemanticHash ?? null,
      proposedEntry: proposed.value,
    });
  }

  for (const [identity, base] of baseEntries) {
    if (proposedEntries.has(identity)) continue;
    if (input.touchedKeys && !input.touchedKeys.has(identity)) continue;
    const version = versions.get(identity);
    const baseHash = baseHashes.get(identity);
    operations.push({
      id: operationId("retire", identity, base.value),
      type: "retire",
      category: base.category,
      entryKey: base.entryKey,
      expectedEntryVersionId: version?.entryVersionId ?? null,
      expectedEntrySemanticHash: version?.entrySemanticHash ?? baseHash?.entrySemanticHash ?? null,
      proposedEntry: null,
    });
  }

  return operations.sort(
    (first, second) =>
      compareProjectKnowledgeCanonicalText(first.category, second.category) ||
      compareProjectKnowledgeCanonicalText(
        canonicalizeProjectKnowledgeKey(first.entryKey),
        canonicalizeProjectKnowledgeKey(second.entryKey),
      ) ||
      compareProjectKnowledgeCanonicalText(first.type, second.type),
  );
}

export function replayProjectKnowledgeOperations(input: {
  baseKnowledgeBase: ProjectKnowledgeBase | null;
  latestKnowledgeBase: ProjectKnowledgeBase | null;
  operations: ProjectKnowledgeOperation[];
  latestVersions?: ProjectKnowledgeVersionPrecondition[];
  versionHistory?: ProjectKnowledgeVersionPrecondition[];
  currentContradictionParticipants?: Record<string, Array<Record<string, unknown>>>;
}) {
  const baseEntries = toEntryMap(input.baseKnowledgeBase);
  const latestEntries = toEntryMap(input.latestKnowledgeBase);
  const latestVersions = new Map(
    (input.latestVersions ?? []).map((version) => [entryIdentity(version.category, version.entryKey), version]),
  );
  const historyById = new Map((input.versionHistory ?? []).map((version) => [version.entryVersionId, version]));
  const outcomes: ProjectKnowledgeReplayOutcome[] = [];

  for (const operation of input.operations) {
    const identity = entryIdentity(operation.category, operation.entryKey);
    const base = baseEntries.get(identity)?.value ?? null;
    const latest = latestEntries.get(identity)?.value ?? null;
    const proposed = operation.proposedEntry ?? null;
    const latestVersion = latestVersions.get(identity);
    let result: ProjectKnowledgeReplayResult;

    if (operation.type === "create") {
      result = latest ? "key_collision" : "applied";
      if (result === "applied" && proposed) latestEntries.set(identity, rawEntry(operation, proposed));
    } else if (operation.type === "flag_contradiction") {
      const expected = participantIdentity(operation.participants ?? []);
      const current = participantIdentity(
        input.currentContradictionParticipants?.[operation.subjectKey ?? operation.entryKey] ??
          input.currentContradictionParticipants?.[operation.entryKey] ??
          operation.participants ?? [],
      );
      result = expected === current ? "applied" : "participants_changed";
    } else if (!latest) {
      const expectedHistory = operation.expectedEntryVersionId
        ? historyById.get(operation.expectedEntryVersionId)
        : undefined;
      if (operation.type === "retire" && expectedHistory?.status === "retired") {
        result = "already_applied";
      } else if (expectedHistory?.status === "retired") {
        result = "target_retired";
      } else {
        result = "target_missing";
      }
    } else if (!preconditionsMatch(operation, latestVersion)) {
      result = "target_changed";
    } else {
      result = "applied";
      if (operation.type === "retire") latestEntries.delete(identity);
      else if (proposed) latestEntries.set(identity, rawEntry(operation, proposed));
    }

    outcomes.push({ operation, result, base, latest, proposed });
  }

  const failed = outcomes.filter((outcome) => outcome.result !== "applied" && outcome.result !== "already_applied");
  return {
    outcomes,
    failed,
    knowledgeBase: failed.length ? null : fromEntryMap(latestEntries),
  };
}

export function projectKnowledgeEntryIdentity(category: string, entryKey: string) {
  return entryIdentity(category, entryKey);
}

function preconditionsMatch(
  operation: ProjectKnowledgeOperation,
  latestVersion: ProjectKnowledgeVersionPrecondition | undefined,
) {
  if (!latestVersion) return false;
  return (
    latestVersion.entryVersionId === operation.expectedEntryVersionId &&
    latestVersion.entrySemanticHash === operation.expectedEntrySemanticHash
  );
}

function toEntryMap(knowledgeBase: ProjectKnowledgeBase | null) {
  const map = new Map<string, RawKnowledgeEntry>();
  if (!knowledgeBase) return map;
  const parsed = ProjectKnowledgeBaseSchema.parse(knowledgeBase);
  const entries: RawKnowledgeEntry[] = [
    ...parsed.modules.map((value) => rawEntry({ category: "module", entryKey: value.id }, value)),
    ...parsed.businessRules.map((value) => rawEntry({ category: "business_rule", entryKey: value.id }, value)),
    ...parsed.stateTransitions.map((value) => rawEntry({ category: "state_transition", entryKey: value.id }, value)),
    ...parsed.glossary.map((value) => rawEntry({ category: "glossary", entryKey: value.term }, value)),
    ...parsed.crossDependencies.map((value) => rawEntry({ category: "dependency", entryKey: value.id }, value)),
  ];
  entries.forEach((entry) => map.set(entryIdentity(entry.category, entry.entryKey), entry));
  return map;
}

function fromEntryMap(entries: Map<string, RawKnowledgeEntry>) {
  return ProjectKnowledgeBaseSchema.parse({
    modules: valuesForCategory(entries, "module"),
    businessRules: valuesForCategory(entries, "business_rule"),
    stateTransitions: valuesForCategory(entries, "state_transition"),
    glossary: valuesForCategory(entries, "glossary"),
    crossDependencies: valuesForCategory(entries, "dependency"),
  });
}

function valuesForCategory(entries: Map<string, RawKnowledgeEntry>, category: string) {
  return Array.from(entries.values())
    .filter((entry) => entry.category === category)
    .sort((first, second) => compareProjectKnowledgeCanonicalText(
      canonicalizeProjectKnowledgeKey(first.entryKey),
      canonicalizeProjectKnowledgeKey(second.entryKey),
    ))
    .map((entry) => entry.value);
}

function rawEntry(
  operation: Pick<ProjectKnowledgeOperation, "category" | "entryKey">,
  value: Record<string, unknown>,
): RawKnowledgeEntry {
  return { category: operation.category, entryKey: operation.entryKey, value };
}

function entryIdentity(category: string, entryKey: string) {
  return `${category}:${canonicalizeProjectKnowledgeKey(entryKey)}`;
}

function operationId(type: string, identity: string, value: unknown) {
  return `pkop_${hashCanonicalValue({ type, identity, value }).slice(0, 32)}`;
}

function participantIdentity(participants: Array<Record<string, unknown>>) {
  return hashCanonicalValue(
    participants
      .flatMap((participant) => [
        participant.sourceSnapshotId,
        ...(Array.isArray(participant.sourceSnapshotIds) ? participant.sourceSnapshotIds : []),
      ])
      .filter((value): value is string => typeof value === "string")
      .sort(),
  );
}
