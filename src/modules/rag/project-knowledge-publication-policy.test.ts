import { describe, expect, it } from "vitest";

import { computeProjectKnowledgeHashes } from "./project-knowledge-contracts";
import { evaluateAutomaticProvenanceRefresh } from "./project-knowledge-publication-policy";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "./project-knowledge.schema";

function knowledge(input: { name?: string; snapshotId?: string; verification?: "exact" | "unverified" } = {}) {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "payments",
      name: input.name ?? "Payments",
      description: "Processes payments.",
      sourceWorkItemIds: ["1"],
      evidence: "Payment evidence",
      evidenceRefs: [{
        sourceSnapshotId: input.snapshotId ?? "snapshot-1",
        sourceWorkItemId: "1",
        sourceField: "description",
        quote: "Payment evidence",
        origin: "generated_v2",
        verification: input.verification ?? "exact",
      }],
    }],
  });
}

function decision(input: {
  published?: ProjectKnowledgeBase;
  parent?: ProjectKnowledgeBase;
  child?: ProjectKnowledgeBase;
  blockers?: unknown[];
}) {
  const published = input.published ?? knowledge();
  const parent = input.parent ?? published;
  const child = input.child ?? knowledge({ snapshotId: "snapshot-2" });
  return evaluateAutomaticProvenanceRefresh({
    publishedKnowledgeBase: published,
    publishedSemanticHash: computeProjectKnowledgeHashes(published).semanticKnowledgeHash,
    parentKnowledgeBase: parent,
    parentSemanticHash: computeProjectKnowledgeHashes(parent).semanticKnowledgeHash,
    childKnowledgeBase: child,
    childSemanticHash: computeProjectKnowledgeHashes(child).semanticKnowledgeHash,
    currentActiveRevisionId: "revision-1",
    childBaseRevisionId: "revision-1",
    childBlockers: input.blockers ?? [],
  });
}

describe("automatic provenance refresh publication policy", () => {
  it("allows a verified provenance-only refresh against unchanged published semantics", () => {
    expect(decision({})).toEqual({ allowed: true, touchedEntryKeys: ["module:payments"] });
  });

  it("denies a parent that contains an unreviewed semantic change", () => {
    const changed = knowledge({ name: "Changed Payments" });
    expect(decision({ parent: changed, child: changed })).toEqual({ allowed: false, reason: "semantic_change" });
  });

  it("denies an unverified touched entry and any persisted blocker", () => {
    expect(decision({ child: knowledge({ snapshotId: "snapshot-2", verification: "unverified" }) }))
      .toEqual({ allowed: false, reason: "unverified_touched_entry" });
    expect(decision({ blockers: [{ type: "hard_conflict" }] }))
      .toEqual({ allowed: false, reason: "publication_blockers" });
  });

  it("denies duplicate canonical identities instead of allowing map collapse", () => {
    const source = knowledge();
    const duplicate = ProjectKnowledgeBaseSchema.parse({
      ...source,
      modules: [...source.modules, { ...source.modules[0], name: "Duplicate Payments" }],
    });
    expect(decision({ child: duplicate })).toMatchObject({ allowed: false });
  });
});
