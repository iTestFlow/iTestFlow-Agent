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
} from "./project-knowledge-contracts";

export type ProjectKnowledgeVersionPrecondition = {
  category: string;
  entryKey: string;
  entryVersionId: string;
  entrySemanticHash: string;
  status?: string;
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
