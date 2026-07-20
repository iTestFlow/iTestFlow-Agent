import { describe, expect, it } from "vitest";

import { computeProjectKnowledgeHashes } from "./project-knowledge-contracts";
import {
  buildProjectKnowledgeOperations,
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
