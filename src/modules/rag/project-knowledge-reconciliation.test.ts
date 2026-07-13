import { describe, expect, it } from "vitest";

import { computeProjectKnowledgeHashes, type ProjectKnowledgeOperation } from "./project-knowledge-contracts";
import {
  buildProjectKnowledgeOperations,
  replayProjectKnowledgeOperations,
  type ProjectKnowledgeVersionPrecondition,
} from "./project-knowledge-reconciliation";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "./project-knowledge.schema";

const moduleEntry = (id: string, description: string, sourceId = "1") => ({
  id,
  name: id.toUpperCase(),
  description,
  sourceWorkItemIds: [sourceId],
  evidence: description,
});

const knowledge = (modules: ReturnType<typeof moduleEntry>[] = []): ProjectKnowledgeBase =>
  ProjectKnowledgeBaseSchema.parse({ modules });

function semanticHash(kb: ProjectKnowledgeBase, key: string) {
  return computeProjectKnowledgeHashes(kb).entries.find((entry) => entry.entryKey === key)?.entrySemanticHash ?? "missing";
}

const version = (
  kb: ProjectKnowledgeBase,
  key: string,
  id = `version-${key}`,
  status = "active",
): ProjectKnowledgeVersionPrecondition => ({
  category: "module",
  entryKey: key,
  entryVersionId: id,
  entrySemanticHash: semanticHash(kb, key),
  status,
});

describe("operation construction", () => {
  it("builds create, update, confirm, and retire with exact preconditions", () => {
    const base = knowledge([
      moduleEntry("same", "Same"),
      moduleEntry("changed", "Old"),
      moduleEntry("retired", "Retire me"),
    ]);
    const proposed = knowledge([
      moduleEntry("same", "Same"),
      moduleEntry("changed", "New"),
      moduleEntry("created", "Create me"),
    ]);
    const operations = buildProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      proposedKnowledgeBase: proposed,
      baseVersions: [version(base, "same"), version(base, "changed"), version(base, "retired")],
    });
    expect(operations.map((operation) => [operation.entryKey, operation.type])).toEqual([
      ["changed", "update"],
      ["created", "create"],
      ["retired", "retire"],
      ["same", "confirm"],
    ]);
    expect(operations.find((operation) => operation.entryKey === "created")).toMatchObject({
      expectedEntryVersionId: null,
      expectedEntrySemanticHash: null,
    });
    expect(operations.find((operation) => operation.entryKey === "changed")).toMatchObject({
      expectedEntryVersionId: "version-changed",
      expectedEntrySemanticHash: semanticHash(base, "changed"),
    });
  });

  it("limits operations to the explicitly touched identity set", () => {
    const base = knowledge([moduleEntry("one", "Old"), moduleEntry("two", "Old")]);
    const proposed = knowledge([moduleEntry("one", "New"), moduleEntry("two", "New")]);
    const operations = buildProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      proposedKnowledgeBase: proposed,
      baseVersions: [version(base, "one"), version(base, "two")],
      touchedKeys: new Set(["module:one"]),
    });
    expect(operations.map((operation) => operation.entryKey)).toEqual(["one"]);
  });
});

describe("deterministic operation replay outcome matrix", () => {
  const base = knowledge([moduleEntry("target", "Old")]);
  const latest = knowledge([moduleEntry("target", "Old")]);
  const activeVersion = version(latest, "target");
  const proposedEntry = moduleEntry("target", "New");
  const operation = (type: ProjectKnowledgeOperation["type"], overrides: Partial<ProjectKnowledgeOperation> = {}): ProjectKnowledgeOperation => ({
    id: `op-${type}`,
    type,
    category: "module",
    entryKey: "target",
    expectedEntryVersionId: activeVersion.entryVersionId,
    expectedEntrySemanticHash: activeVersion.entrySemanticHash,
    proposedEntry: type === "retire" ? null : proposedEntry,
    ...overrides,
  });

  it("replays create as applied or key_collision", () => {
    const create = operation("create", {
      entryKey: "created",
      expectedEntryVersionId: null,
      expectedEntrySemanticHash: null,
      proposedEntry: moduleEntry("created", "Created"),
    });
    expect(replayProjectKnowledgeOperations({ baseKnowledgeBase: base, latestKnowledgeBase: latest, operations: [create] }).outcomes[0].result)
      .toBe("applied");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: knowledge([...latest.modules, moduleEntry("created", "Existing")]),
      operations: [create],
    }).outcomes[0].result).toBe("key_collision");
  });

  it.each(["update", "confirm"] as const)("replays %s across all target outcomes", (type) => {
    const op = operation(type);
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [op],
      latestVersions: [activeVersion],
    }).outcomes[0].result).toBe("applied");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: knowledge(),
      operations: [op],
    }).outcomes[0].result).toBe("target_missing");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: knowledge(),
      operations: [op],
      versionHistory: [{ ...activeVersion, status: "retired" }],
    }).outcomes[0].result).toBe("target_retired");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [op],
      latestVersions: [{ ...activeVersion, entryVersionId: "new-version" }],
    }).outcomes[0].result).toBe("target_changed");
  });

  it("replays retire and permits already_applied only with retirement history", () => {
    const retire = operation("retire");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [retire],
      latestVersions: [activeVersion],
    }).outcomes[0].result).toBe("applied");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: knowledge(),
      operations: [retire],
      versionHistory: [{ ...activeVersion, status: "retired" }],
    }).outcomes[0].result).toBe("already_applied");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: knowledge(),
      operations: [retire],
    }).outcomes[0].result).toBe("target_missing");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [retire],
      latestVersions: [{ ...activeVersion, entrySemanticHash: "changed" }],
    }).outcomes[0].result).toBe("target_changed");
  });

  it("invalidates contradiction resolution when participants change", () => {
    const contradiction = operation("flag_contradiction", {
      category: "hard_conflict",
      entryKey: "conflict-1",
      proposedEntry: null,
      participants: [{ sourceSnapshotId: "s1" }, { sourceSnapshotId: "s2" }],
    });
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [contradiction],
    }).outcomes[0].result).toBe("applied");
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [contradiction],
      currentContradictionParticipants: { "conflict-1": [{ sourceSnapshotId: "s1" }, { sourceSnapshotId: "s3" }] },
    }).outcomes[0].result).toBe("participants_changed");
  });

  it("invalidates contradiction resolution when participant snapshot arrays change", () => {
    const contradiction = operation("flag_contradiction", {
      category: "hard_conflict",
      entryKey: "conflict-1",
      proposedEntry: null,
      participants: [{ sourceSnapshotIds: ["s1", "s2"] }],
    });
    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [contradiction],
      currentContradictionParticipants: {
        "conflict-1": [{ sourceSnapshotIds: ["s1", "s3"] }],
      },
    }).outcomes[0].result).toBe("participants_changed");
  });

  it("uses the stable contradiction subject key before the participant-derived identity", () => {
    const contradiction = operation("flag_contradiction", {
      category: "hard_conflict",
      entryKey: "participants-derived-identity",
      subjectKey: "businessRules:retry-limit",
      proposedEntry: null,
      participants: [{ sourceSnapshotId: "s1" }, { sourceSnapshotId: "s2" }],
    });

    expect(replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [contradiction],
      currentContradictionParticipants: {
        "businessRules:retry-limit": [{ sourceSnapshotId: "s1" }, { sourceSnapshotId: "s2" }],
        "participants-derived-identity": [{ sourceSnapshotId: "s1" }, { sourceSnapshotId: "s3" }],
      },
    }).outcomes[0].result).toBe("applied");
  });

  it("returns base/latest/proposed for human three-way resolution", () => {
    const changedLatest = knowledge([moduleEntry("target", "Concurrent")]);
    const outcome = replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: changedLatest,
      operations: [operation("update")],
      latestVersions: [version(changedLatest, "target", "concurrent-version")],
    }).failed[0];
    expect(outcome).toMatchObject({
      result: "target_changed",
      base: { description: "Old" },
      latest: { description: "Concurrent" },
      proposed: { description: "New" },
    });
  });

  it("applies cumulative child deltas in deterministic order", () => {
    const update = operation("update");
    const create = operation("create", {
      entryKey: "child-created",
      expectedEntryVersionId: null,
      expectedEntrySemanticHash: null,
      proposedEntry: moduleEntry("child-created", "Created by child"),
    });
    const replay = replayProjectKnowledgeOperations({
      baseKnowledgeBase: base,
      latestKnowledgeBase: latest,
      operations: [update, create],
      latestVersions: [activeVersion],
    });
    expect(replay.failed).toEqual([]);
    expect(replay.knowledgeBase?.modules.map((entry) => [entry.id, entry.description])).toEqual([
      ["child-created", "Created by child"],
      ["target", "New"],
    ]);
  });
});
