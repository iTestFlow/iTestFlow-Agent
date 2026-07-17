import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const retrieval = vi.hoisted(() => ({
  refreshProjectKnowledgeSearchIndex: vi.fn(),
}));

vi.mock("@/modules/rag/context-chatbot-retrieval.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/rag/context-chatbot-retrieval.service")>();
  return {
    ...actual,
    refreshProjectKnowledgeSearchIndex: retrieval.refreshProjectKnowledgeSearchIndex,
  };
});

import {
  flushBackgroundWrites,
  nowIso,
  resetDatabaseForTests,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "./project-context-store.service";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";
import {
  saveManualProjectKnowledgeBaseFromBatches,
} from "./project-knowledge.service";
import { publishProjectKnowledgeDraft } from "./project-knowledge-draft.service";
import type { ProjectKnowledgeBase } from "./project-knowledge.schema";
import { recordProjectKnowledgeBenchmarkQuestion } from "./project-knowledge-benchmark.service";
import { regroundLegacyProjectKnowledgeCandidates } from "./project-knowledge-compiled.service";
import { backfillProjectKnowledgeCompilerFoundation } from "./project-knowledge-migration.service";

describeDb("source-versioned project knowledge publication", () => {
  const workspaceId = uniqueTestId("ws_kb");
  const projectId = uniqueTestId("project_kb");
  const organizationUrl = `https://dev.azure.com/${uniqueTestId("org")}`;
  const originalKnowledgeBaseId = uniqueTestId("pkb_original");
  const workItemRowId = uniqueTestId("awi");
  const baselineSnapshotId = uniqueTestId("awis_baseline");
  const scope = {
    workspaceId,
    projectId,
    azureProjectId: projectId,
    azureProjectName: "Knowledge Project",
    azureOrganizationUrl: organizationUrl,
  };
  const evidenceRef = (
    sourceField: "description" | "acceptanceCriteria",
    quote: string,
  ) => ({
    sourceSnapshotId: baselineSnapshotId,
    sourceWorkItemId: "42",
    sourceField,
    quote,
    origin: "generated_v2" as const,
    verification: "exact" as const,
  });
  const initialKnowledgeBase = {
    modules: [{
      id: "checkout",
      name: "Checkout",
      description: "Customers submit orders.",
      sourceWorkItemIds: ["42"],
      evidence: "Checkout succeeds",
      evidenceRefs: [evidenceRef("acceptanceCriteria", "Checkout succeeds")],
    }],
    businessRules: [{
      id: "BR-1",
      rule: "Payment must be authorized.",
      sourceField: "acceptanceCriteria" as const,
      moduleName: "Checkout",
      sourceWorkItemIds: ["42"],
      evidence: "Checkout succeeds",
      evidenceRefs: [evidenceRef("acceptanceCriteria", "Checkout succeeds")],
    }],
    stateTransitions: [],
    glossary: [{
      term: "Order",
      type: "business_entity" as const,
      definition: "A submitted customer purchase.",
      sourceWorkItemIds: ["42"],
      evidence: "Checkout description",
      evidenceRefs: [evidenceRef("description", "Checkout description")],
    }],
    crossDependencies: [],
  };

  async function prepare(knowledgeBase: ProjectKnowledgeBase = initialKnowledgeBase) {
    return saveManualProjectKnowledgeBaseFromBatches({
      scope,
      actor: "user-1",
      partialKnowledgeBases: [knowledgeBase],
      mode: "full",
    });
  }

  async function publish(draftId: string) {
    return publishProjectKnowledgeDraft({ scope, actor: "user-1", draftId });
  }

  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: organizationUrl });
    await seedProject({
      workspaceId,
      orgUrl: organizationUrl,
      azureProjectId: projectId,
      azureProjectName: "Knowledge Project",
    });
    const now = nowIso();
    const fields = {
      title: "Checkout",
      description: "Checkout description",
      acceptanceCriteria: "Checkout succeeds",
      state: "Active",
      workItemType: "User Story",
      tags: [],
      areaPath: null,
      iterationPath: null,
      metadata: {},
    };
    await sqlRun(
      `INSERT INTO azure_devops_work_item_snapshots (
         id, workspace_id, project_id, azure_project_id, azure_project_name,
         azure_organization_url, azure_work_item_id, work_item_type, content_hash,
         ado_revision, fields_json, source_updated_at, captured_at, created_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, @projectName,
         @organizationUrl, '42', 'User Story', 'hash-42', 1,
         @fieldsJson, @now, @now, @now
       )`,
      {
        id: baselineSnapshotId,
        workspaceId,
        projectId,
        projectName: "Knowledge Project",
        organizationUrl,
        fieldsJson: JSON.stringify(fields),
        now,
      },
    );
    await sqlRun(
      `INSERT INTO azure_devops_work_items (
         id, project_id, azure_project_id, azure_project_name, azure_organization_url,
         azure_work_item_id, work_item_type, title, description, acceptance_criteria,
         state, content_hash, sync_status, current_snapshot_id, created_at, updated_at
       ) VALUES (
         @id, @projectId, @projectId, @projectName, @organizationUrl,
         '42', 'User Story', 'Checkout', 'Checkout description', 'Checkout succeeds',
         'Active', 'hash-42', 'active', @snapshotId, @now, @now
       )`,
      {
        id: workItemRowId,
        projectId,
        projectName: "Knowledge Project",
        organizationUrl,
        snapshotId: baselineSnapshotId,
        now,
      },
    );
  });

  beforeEach(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM project_knowledge_entry_evidence_refs WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_hard_conflicts WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_draft_batches WHERE draft_id IN (SELECT id FROM project_knowledge_drafts WHERE project_id = @projectId)`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_drafts WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_lint_issues WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_lint_runs WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_entry_versions WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_revisions WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_entries_fts WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_entries WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_migration_issues WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_benchmark_cases WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_candidates WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_base WHERE project_id = @projectId`, { projectId });
    await sqlRun(
      `DELETE FROM azure_devops_work_item_snapshots
       WHERE project_id = @projectId AND id <> @baselineSnapshotId`,
      { projectId, baselineSnapshotId },
    );
    await sqlRun(
      `DELETE FROM azure_devops_work_items
       WHERE project_id = @projectId AND id <> @workItemRowId`,
      { projectId, workItemRowId },
    );
    await sqlRun(
      `UPDATE azure_devops_work_items
       SET current_snapshot_id = @baselineSnapshotId, content_hash = 'hash-42', sync_status = 'active',
           title = 'Checkout', description = 'Checkout description',
           acceptance_criteria = 'Checkout succeeds', state = 'Active'
       WHERE id = @workItemRowId`,
      { baselineSnapshotId, workItemRowId },
    );
    const now = nowIso();
    await sqlRun(
      `INSERT INTO project_knowledge_base (
         id, project_id, azure_project_id, azure_project_name, azure_organization_url,
         prompt_version, provider, model_name, source_work_item_count, raw_output,
         validated_output, status, extracted_at, created_at, updated_at
       ) VALUES (
         @id, @projectId, @projectId, @projectName, @organizationUrl,
         'original', 'external', 'manual', 1, '{}',
         @validatedOutput, 'Success', @now, @now, @now
       )`,
      {
        id: originalKnowledgeBaseId,
        projectId,
        projectName: "Knowledge Project",
        organizationUrl,
        validatedOutput: JSON.stringify({
          modules: [],
          businessRules: [],
          stateTransitions: [],
          glossary: [],
          crossDependencies: [],
        }),
        now,
      },
    );
    vi.clearAllMocks();
    retrieval.refreshProjectKnowledgeSearchIndex.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    try {
      await flushBackgroundWrites();
      await sqlRun(`DELETE FROM project_knowledge_entry_evidence_refs WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_hard_conflicts WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_draft_batches WHERE draft_id IN (SELECT id FROM project_knowledge_drafts WHERE project_id = @projectId)`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_drafts WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_lint_issues WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_lint_runs WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_entry_versions WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_revisions WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_entries_fts WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_entries WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_migration_issues WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_benchmark_cases WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_candidates WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_base WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM azure_devops_work_item_snapshots WHERE project_id = @projectId`, { projectId });
      await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
    } finally {
      await resetDatabaseForTests();
    }
  });

  it("rolls back revision, active knowledge, and critical logs when search indexing fails", async () => {
    const draft = await prepare();
    expect(draft.persistedStatus).toBe("ready_to_publish");
    retrieval.refreshProjectKnowledgeSearchIndex.mockRejectedValueOnce(new Error("search index write failed"));

    await expect(publish(draft.id)).rejects.toThrow("search index write failed");

    expect(await sqlGet<{ id: string; prompt_version: string }>(
      `SELECT id, prompt_version FROM project_knowledge_base
       WHERE project_id = @projectId AND azure_project_id = @projectId`,
      { projectId },
    )).toEqual({ id: originalKnowledgeBaseId, prompt_version: "original" });
    expect(await sqlAll(
      `SELECT id FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([]);
    expect(await sqlAll(
      `SELECT id FROM project_knowledge_log
       WHERE project_id = @projectId AND event_type = 'knowledge.revision_saved'`,
      { projectId },
    )).toEqual([]);
  });

  it("publishes the first draft for a project whose current KB is absent", async () => {
    await sqlRun(
      `DELETE FROM project_knowledge_base WHERE project_id = @projectId AND azure_project_id = @projectId`,
      { projectId },
    );

    const draft = await prepare();
    expect(draft.baseRevisionId).toBeNull();
    const published = await publish(draft.id);

    expect(published?.persistedStatus).toBe("published");
    expect(await sqlGet<{
      count: number;
      active_revision_count: number;
    }>(
      `SELECT COUNT(*)::int AS count,
              COUNT(active_revision_id)::int AS active_revision_count
       FROM project_knowledge_base
       WHERE project_id = @projectId AND azure_project_id = @projectId`,
      { projectId },
    )).toEqual({ count: 1, active_revision_count: 1 });
    expect(await sqlAll<{ revision_number: number; base_revision_id: string | null }>(
      `SELECT revision_number, base_revision_id
       FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{ revision_number: 1, base_revision_id: null }]);
  });

  it("publishes a reviewable draft and persists immutable revision output atomically", async () => {
    const draft = await prepare();
    const published = await publish(draft.id);

    expect(published?.persistedStatus).toBe("published");
    expect(retrieval.refreshProjectKnowledgeSearchIndex).toHaveBeenCalledExactlyOnceWith(
      { scope, knowledgeBaseId: originalKnowledgeBaseId, knowledgeBase: draft.knowledgeBase },
      expect.anything(),
    );
    const persisted = await sqlGet<{
      id: string;
      provider: string;
      model_name: string;
      source_work_item_count: number;
      validated_output: string;
      active_revision_id: string;
      freshness_status: string;
      provenance_status: string;
    }>(
      `SELECT id, provider, model_name, source_work_item_count, validated_output,
              active_revision_id, freshness_status, provenance_status
       FROM project_knowledge_base WHERE project_id = @projectId`,
      { projectId },
    );
    expect(persisted).toMatchObject({
      id: originalKnowledgeBaseId,
      provider: "external",
      model_name: "manual-external",
      source_work_item_count: 1,
      active_revision_id: expect.any(String),
      freshness_status: "current",
      provenance_status: "verified",
    });
    expect(JSON.parse(persisted!.validated_output)).toEqual(draft.knowledgeBase);
    expect(await sqlAll<{ revision_number: number; mode: string; validated_output: string }>(
      `SELECT revision_number, mode, validated_output
       FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{
      revision_number: 1,
      mode: "full",
      validated_output: JSON.stringify(draft.knowledgeBase),
    }]);
    expect(await sqlAll<{ category: string; entry_key: string; status: string }>(
      `SELECT category, entry_key, status FROM project_knowledge_entry_versions
       WHERE project_id = @projectId ORDER BY category, entry_key`,
      { projectId },
    )).toEqual([
      { category: "business_rule", entry_key: "BR-1", status: "active" },
      { category: "glossary", entry_key: "Order", status: "active" },
      { category: "module", entry_key: "checkout", status: "active" },
    ]);
    expect(await sqlAll<{ source_snapshot_id: string; verification: string }>(
      `SELECT source_snapshot_id, verification FROM project_knowledge_entry_evidence_refs
       WHERE project_id = @projectId ORDER BY entry_version_id`,
      { projectId },
    )).toEqual(Array.from({ length: 3 }, () => ({
      source_snapshot_id: baselineSnapshotId,
      verification: "exact",
    })));
    expect(await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM project_knowledge_lint_runs WHERE project_id = @projectId`,
      { projectId },
    )).toEqual({ count: 1 });
  });

  it("publishes one concurrent draft and marks the other outdated without merging", async () => {
    const first = await prepare();
    const second = await prepare();
    const outcomes = await Promise.all([publish(first.id), publish(second.id)]);

    expect(outcomes.map((outcome) => outcome?.persistedStatus).sort()).toEqual([
      "published",
      "superseded",
    ]);
    expect(await sqlAll<{ revision_number: number }>(
      `SELECT revision_number FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{ revision_number: 1 }]);
    expect(await sqlAll<{ status: string; status_reason: string | null }>(
      `SELECT status, status_reason FROM project_knowledge_drafts
       WHERE id IN (@firstId, @secondId) ORDER BY status`,
      { firstId: first.id, secondId: second.id },
    )).toEqual([
      { status: "published", status_reason: null },
      { status: "superseded", status_reason: "active_revision_changed" },
    ]);
  });

  it("publishes the exact frozen draft as stale when sources change after build", async () => {
    const draft = await prepare();
    const fetchWorkItems = vi.fn(async () => [requirement({
      id: "42",
      azureProjectId: projectId,
      teamProject: "Knowledge Project",
      title: "Checkout",
      description: "Checkout description changed while the draft was under review.",
      acceptanceCriteria: "Checkout succeeds",
      state: "Active",
      revision: 2,
    })]);
    const syncResult = await indexAzureWorkItemsAsProjectContext({
      scope,
      actor: "sync-worker",
      adapter: fakeAzureAdapter({ fetchWorkItems }),
      workItemTypes: ["User Story"],
      states: ["Active"],
    });
    const publication = await publish(draft.id);

    expect(syncResult.updatedCount).toBe(1);
    expect(publication?.persistedStatus).toBe("published");
    expect(await sqlAll<{
      semantic_hash: string;
      source_fingerprint: string;
    }>(
      `SELECT semantic_hash, source_fingerprint
       FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{
      semantic_hash: draft.semanticHash,
      source_fingerprint: draft.sourceFingerprint,
    }]);
    expect(await sqlGet<{ status: string; pending_drift: boolean }>(
      `SELECT status, pending_drift FROM project_knowledge_drafts WHERE id = @draftId`,
      { draftId: draft.id },
    )).toEqual({ status: "published", pending_drift: true });
    expect(await sqlGet<{
      freshness_status: string;
      stale_reason_json: Array<{ type: string; message: string }>;
    }>(
      `SELECT freshness_status, stale_reason_json
       FROM project_knowledge_base WHERE project_id = @projectId`,
      { projectId },
    )).toEqual({
      freshness_status: "stale",
      stale_reason_json: [{
        type: "source_updates_after_build",
        message: "Newer source updates will be included in the next build.",
        detectedAt: expect.any(String),
      }],
    });
  });

  it("versions only semantic or provenance changes and retires removed entries", async () => {
    const firstDraft = await prepare();
    await publish(firstDraft.id);
    const firstRevision = await sqlGet<{ id: string }>(
      `SELECT id FROM project_knowledge_revisions WHERE project_id = @projectId AND revision_number = 1`,
      { projectId },
    );
    const secondKnowledgeBase = {
      ...initialKnowledgeBase,
      businessRules: [{
        ...initialKnowledgeBase.businessRules[0],
        rule: "Payment and fraud checks must be authorized.",
        // The wording change must come with changed evidence content: a same-evidence
        // rewording is paraphrase noise the wording carry-over deliberately reverts.
        evidenceRefs: [evidenceRef("description", "Checkout description")],
      }],
      glossary: [],
    };
    const secondDraft = await prepare(secondKnowledgeBase);
    await publish(secondDraft.id);
    const secondRevision = await sqlGet<{ id: string }>(
      `SELECT id FROM project_knowledge_revisions WHERE project_id = @projectId AND revision_number = 2`,
      { projectId },
    );

    expect(await sqlAll<{
      category: string;
      entry_key: string;
      status: string;
      superseded_by_entry_version_id: string | null;
    }>(
      `SELECT category, entry_key, status, superseded_by_entry_version_id
       FROM project_knowledge_entry_versions
       WHERE project_id = @projectId AND revision_id = @revisionId
       ORDER BY category, entry_key`,
      { projectId, revisionId: firstRevision!.id },
    )).toEqual([
      {
        category: "business_rule",
        entry_key: "BR-1",
        status: "superseded",
        superseded_by_entry_version_id: expect.any(String),
      },
      {
        category: "glossary",
        entry_key: "Order",
        status: "retired",
        superseded_by_entry_version_id: null,
      },
      {
        category: "module",
        entry_key: "checkout",
        status: "active",
        superseded_by_entry_version_id: null,
      },
    ]);
    expect(await sqlAll<{ category: string; entry_key: string; status: string }>(
      `SELECT category, entry_key, status FROM project_knowledge_entry_versions
       WHERE project_id = @projectId AND revision_id = @revisionId`,
      { projectId, revisionId: secondRevision!.id },
    )).toEqual([{ category: "business_rule", entry_key: "BR-1", status: "active" }]);
  });

  it("versions immutable provenance when a source snapshot advances without semantic changes", async () => {
    await publish((await prepare()).id);
    const replacementSnapshotId = uniqueTestId("awis_revision");
    const baseline = await sqlGet<{ fields_json: unknown }>(
      `SELECT fields_json FROM azure_devops_work_item_snapshots WHERE id = @baselineSnapshotId`,
      { baselineSnapshotId },
    );
    const now = nowIso();
    await sqlRun(
      `INSERT INTO azure_devops_work_item_snapshots (
         id, workspace_id, project_id, azure_project_id, azure_project_name,
         azure_organization_url, azure_work_item_id, work_item_type, content_hash,
         ado_revision, fields_json, source_updated_at, captured_at, created_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, 'Knowledge Project',
         @organizationUrl, '42', 'User Story', 'hash-42', 2,
         @fieldsJson, @now, @now, @now
       )`,
      {
        id: replacementSnapshotId,
        workspaceId,
        projectId,
        organizationUrl,
        fieldsJson: JSON.stringify(baseline!.fields_json),
        now,
      },
    );
    await sqlRun(
      `UPDATE azure_devops_work_items SET current_snapshot_id = @snapshotId WHERE id = @workItemRowId`,
      { snapshotId: replacementSnapshotId, workItemRowId },
    );

    const replacementKnowledgeBase = {
      ...initialKnowledgeBase,
      modules: initialKnowledgeBase.modules.map((entry) => ({
        ...entry,
        evidenceRefs: entry.evidenceRefs.map((ref) => ({ ...ref, sourceSnapshotId: replacementSnapshotId })),
      })),
      businessRules: initialKnowledgeBase.businessRules.map((entry) => ({
        ...entry,
        evidenceRefs: entry.evidenceRefs.map((ref) => ({ ...ref, sourceSnapshotId: replacementSnapshotId })),
      })),
      glossary: initialKnowledgeBase.glossary.map((entry) => ({
        ...entry,
        evidenceRefs: entry.evidenceRefs.map((ref) => ({ ...ref, sourceSnapshotId: replacementSnapshotId })),
      })),
    };
    await publish((await prepare(replacementKnowledgeBase)).id);

    const revisions = await sqlAll<{
      revision_number: number;
      source_fingerprint: string;
      semantic_hash: string;
      provenance_hash: string;
    }>(
      `SELECT revision_number, source_fingerprint, semantic_hash, provenance_hash
       FROM project_knowledge_revisions WHERE project_id = @projectId ORDER BY revision_number`,
      { projectId },
    );
    expect(revisions).toHaveLength(2);
    expect(revisions[1].source_fingerprint).not.toBe(revisions[0].source_fingerprint);
    expect(revisions[1].semantic_hash).toBe(revisions[0].semantic_hash);
    expect(revisions[1].provenance_hash).not.toBe(revisions[0].provenance_hash);
    expect(await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM project_knowledge_entry_versions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual({ count: 6 });
  });

  it("creates a new version only for an entry whose provenance changes", async () => {
    await publish((await prepare()).id);
    const provenanceOnly = {
      ...initialKnowledgeBase,
      modules: [{
        ...initialKnowledgeBase.modules[0],
        evidence: "Checkout description",
        evidenceRefs: [evidenceRef("description", "Checkout description")],
      }],
    };
    await publish((await prepare(provenanceOnly)).id);

    const revisions = await sqlAll<{ semantic_hash: string; provenance_hash: string }>(
      `SELECT semantic_hash, provenance_hash FROM project_knowledge_revisions
       WHERE project_id = @projectId ORDER BY revision_number`,
      { projectId },
    );
    expect(revisions[1].semantic_hash).toBe(revisions[0].semantic_hash);
    expect(revisions[1].provenance_hash).not.toBe(revisions[0].provenance_hash);
    expect(await sqlAll<{ category: string; status: string }>(
      `SELECT versions.category, versions.status
       FROM project_knowledge_entry_versions versions
       JOIN project_knowledge_revisions revisions ON revisions.id = versions.revision_id
       WHERE versions.project_id = @projectId AND revisions.revision_number = 2`,
      { projectId },
    )).toEqual([{ category: "module", status: "active" }]);
  });

  it("persists and blocks an incompatible concrete-value conflict", async () => {
    const conflictingKnowledge = {
      ...initialKnowledgeBase,
      businessRules: [
        {
          id: "BR-RETRY-3",
          rule: "Retry count must be 3.",
          sourceField: "acceptanceCriteria" as const,
          moduleName: "Checkout",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: [evidenceRef("acceptanceCriteria", "Checkout succeeds")],
        },
        {
          id: "BR-RETRY-5",
          rule: "Retry count must be 5.",
          sourceField: "acceptanceCriteria" as const,
          moduleName: "checkout",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: [evidenceRef("acceptanceCriteria", "Checkout succeeds")],
        },
      ],
    };

    const draft = await prepare(conflictingKnowledge);
    expect(draft.persistedStatus).toBe("blocked");
    expect(await sqlAll<{ conflict_type: string; subject: string }>(
      `SELECT conflict_type, subject FROM project_knowledge_hard_conflicts
       WHERE project_id = @projectId AND draft_id = @draftId`,
      { projectId, draftId: draft.id },
    )).toEqual([{
      conflict_type: "incompatible_concrete_value",
      subject: "checkout:retry.count",
    }]);
    await expect(publish(draft.id)).rejects.toMatchObject({ code: "knowledge_publication_blocked" });
  });

  it("merges business-rule module associations by canonical identity while retaining original casing", async () => {
    const casingKnowledge = {
      ...initialKnowledgeBase,
      businessRules: [
        {
          ...initialKnowledgeBase.businessRules[0],
          id: "BR-MODULE-CASING",
          moduleName: "Payment Retrials Tab",
          moduleAssociations: ["Policy Details"],
        },
        {
          ...initialKnowledgeBase.businessRules[0],
          id: "BR-MODULE-CASING",
          moduleName: "payment-retrials-tab",
          moduleAssociations: ["policy-details", "Payment Status"],
        },
      ],
    };

    const draft = await prepare(casingKnowledge);

    expect(draft.persistedStatus).toBe("ready_to_publish");
    expect(draft.proposedKnowledge?.businessRules).toEqual([
      expect.objectContaining({
        id: "BR-MODULE-CASING",
        moduleName: "Payment Retrials Tab",
        moduleAssociations: ["Payment Retrials Tab", "Payment Status", "Policy Details"],
      }),
    ]);
    expect(await sqlAll<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM project_knowledge_hard_conflicts
       WHERE project_id = @projectId AND draft_id = @draftId`,
      { projectId, draftId: draft.id },
    )).toEqual([{ count: 0 }]);
  });

  it("publishes re-keyed hash-suffixed business rules through the canonical uniqueness guard", async () => {
    const rekeyedKnowledge = {
      ...initialKnowledgeBase,
      businessRules: [
        {
          ...initialKnowledgeBase.businessRules[0],
          id: "BR-PURCHASE-NOTIFICATION",
          rule: "Primary purchase button must be enabled.",
        },
        {
          ...initialKnowledgeBase.businessRules[0],
          id: "BR-PURCHASE-NOTIFICATION",
          rule: "Secondary purchase button must be enabled.",
        },
      ],
    };

    const draft = await prepare(rekeyedKnowledge);
    const entryKeys = draft.proposedKnowledge?.businessRules.map((entry) => entry.id);

    expect(draft.persistedStatus).toBe("ready_to_publish");
    expect(entryKeys).toEqual([
      "BR-PURCHASE-NOTIFICATION",
      expect.stringMatching(/^BR-PURCHASE-NOTIFICATION-[a-f0-9]{8}$/),
    ]);

    await expect(publish(draft.id)).resolves.toMatchObject({ persistedStatus: "published" });
    expect(await sqlAll<{ entry_key: string; status: string }>(
      `SELECT entry_key, status FROM project_knowledge_entry_versions
       WHERE project_id = @projectId AND category = 'business_rule'
       ORDER BY entry_key`,
      { projectId },
    )).toEqual(entryKeys?.map((entryKey) => ({ entry_key: entryKey, status: "active" })));
  });

  it("auto-merges the frozen Quote Receiving dependency variants before persisting conflicts", async () => {
    const sharedEvidence = [evidenceRef("acceptanceCriteria", "Checkout succeeds")];
    const quoteReceivingKnowledge = {
      ...initialKnowledgeBase,
      crossDependencies: [
        {
          id: "dep-quote-receiving-aggregator",
          sourceModule: "Quote Receiving",
          targetModule: "Aggregator",
          dependencyType: "quote request dependency",
          description: "The quote receiving waiting period starts immediately after the request is sent to the aggregator.",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: sharedEvidence,
        },
        {
          id: "dep-quote-receiving-aggregator",
          sourceModule: "Quote Receiving",
          targetModule: "Aggregator",
          dependencyType: "integration",
          description: "The quote receiving waiting period starts immediately after the quote request is sent to the aggregator.",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: sharedEvidence,
        },
        {
          id: "dep-quote-receiving-insurance-company",
          sourceModule: "Quote Receiving",
          targetModule: "Insurance company",
          dependencyType: "quote response dependency",
          description: "The waiting period can end when all active insurance companies have returned their quotes.",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: sharedEvidence,
        },
        {
          id: "dep-quote-receiving-insurance-company",
          sourceModule: "Quote Receiving",
          targetModule: "Insurance company",
          dependencyType: "integration",
          description: "Quote Receiving waiting period can end when all active insurance companies have returned their quotes.",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: sharedEvidence,
        },
      ],
    };

    const draft = await prepare(quoteReceivingKnowledge);

    expect(draft.persistedStatus).toBe("ready_to_publish");
    expect(draft.proposedKnowledge?.crossDependencies).toEqual([
      expect.objectContaining({ id: "dep-quote-receiving-aggregator", dependencyType: "quote request dependency" }),
      expect.objectContaining({ id: "dep-quote-receiving-insurance-company", dependencyType: "quote response dependency" }),
    ]);
    expect(await sqlAll<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM project_knowledge_hard_conflicts
       WHERE project_id = @projectId AND draft_id = @draftId`,
      { projectId, draftId: draft.id },
    )).toEqual([{ count: 0 }]);
  });

  it("consolidates compatible duplicate canonical identity before publication", async () => {
    const secondSnapshotId = uniqueTestId("snap_returns");
    const now = nowIso();
    await sqlRun(
      `INSERT INTO azure_devops_work_item_snapshots (
         id, workspace_id, project_id, azure_project_id, azure_project_name,
         azure_organization_url, azure_work_item_id, work_item_type, content_hash,
         ado_revision, fields_json, source_updated_at, captured_at, created_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, @projectName,
         @organizationUrl, '43', 'User Story', 'hash-43', 1,
         @fieldsJson, @now, @now, @now
       )`,
      {
        id: secondSnapshotId,
        workspaceId,
        projectId,
        projectName: "Knowledge Project",
        organizationUrl,
        fieldsJson: JSON.stringify({
          title: "Returns",
          description: "Returns description",
          acceptanceCriteria: "Returns succeed",
          state: "Active",
          workItemType: "User Story",
          tags: [],
          areaPath: null,
          iterationPath: null,
          metadata: {},
        }),
        now,
      },
    );
    await sqlRun(
      `INSERT INTO azure_devops_work_items (
         id, project_id, azure_project_id, azure_project_name, azure_organization_url,
         azure_work_item_id, work_item_type, title, description, acceptance_criteria,
         state, content_hash, sync_status, current_snapshot_id, created_at, updated_at
       ) VALUES (
         @id, @projectId, @projectId, @projectName, @organizationUrl,
         '43', 'User Story', 'Returns', 'Returns description', 'Returns succeed',
         'Active', 'hash-43', 'active', @snapshotId, @now, @now
       )`,
      {
        id: uniqueTestId("wi_returns"),
        projectId,
        projectName: "Knowledge Project",
        organizationUrl,
        snapshotId: secondSnapshotId,
        now,
      },
    );
    const duplicateKnowledge = {
      ...initialKnowledgeBase,
      modules: [
        initialKnowledgeBase.modules[0],
        {
          ...initialKnowledgeBase.modules[0],
          id: " checkout ",
          name: "Checkout duplicate",
          sourceWorkItemIds: ["43"],
          evidence: "Returns description",
          evidenceRefs: [{
            ...evidenceRef("description", "Returns description"),
            sourceSnapshotId: secondSnapshotId,
            sourceWorkItemId: "43",
          }],
        },
      ],
    };

    const draft = await prepare(duplicateKnowledge);
    expect(draft.persistedStatus).toBe("ready_to_publish");
    expect(draft.knowledgeBase.modules).toHaveLength(1);
    expect(draft.knowledgeBase.modules[0]).toMatchObject({
      id: "checkout",
      sourceWorkItemIds: expect.arrayContaining(["42", "43"]),
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ sourceSnapshotId: baselineSnapshotId }),
        expect.objectContaining({ sourceSnapshotId: secondSnapshotId }),
      ]),
    });
    expect(await sqlAll<{ conflict_type: string; subject: string }>(
      `SELECT conflict_type, subject FROM project_knowledge_hard_conflicts
       WHERE project_id = @projectId AND draft_id = @draftId`,
      { projectId, draftId: draft.id },
    )).toEqual([]);

    await expect(publish(draft.id)).resolves.toMatchObject({ persistedStatus: "published" });
    expect(await sqlAll<{ category: string; entry_key: string; status: string }>(
      `SELECT category, entry_key, status FROM project_knowledge_entry_versions
       WHERE project_id = @projectId AND category = 'module'`,
      { projectId },
    )).toEqual([{ category: "module", entry_key: "checkout", status: "active" }]);
  });

  it("stores only sanitized, deduplicated real benchmark questions", async () => {
    const question = "Can jane@example.com verify work item 12345 in checkout?";
    recordProjectKnowledgeBenchmarkQuestion({ scope, sourceType: "qa", question });
    recordProjectKnowledgeBenchmarkQuestion({ scope, sourceType: "qa", question });
    await flushBackgroundWrites();

    expect(await sqlAll<{ sanitized_question: string; usage_count: number }>(
      `SELECT sanitized_question, usage_count FROM project_knowledge_benchmark_cases
       WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{
      sanitized_question: "Can [email] verify work item [number] in checkout?",
      usage_count: 2,
    }]);
  });

  it("preserves backslashes while mapping persisted legacy evidence", async () => {
    const versionId = uniqueTestId("pkev_legacy_backslash");
    const quote = String.raw`Use \\server\share and regex \d+\|\w+`;
    const now = nowIso();
    const snapshot = await sqlGet<{ fields_json: Record<string, unknown> }>(
      `SELECT fields_json FROM azure_devops_work_item_snapshots WHERE id = @snapshotId`,
      { snapshotId: baselineSnapshotId },
    );
    await sqlRun(
      `UPDATE azure_devops_work_item_snapshots
       SET fields_json = @fieldsJson::jsonb
       WHERE id = @snapshotId`,
      {
        snapshotId: baselineSnapshotId,
        fieldsJson: JSON.stringify({ ...snapshot?.fields_json, description: quote }),
      },
    );
    await sqlRun(
      `INSERT INTO project_knowledge_entry_versions (
         id, workspace_id, project_id, azure_project_id, azure_project_name,
         azure_organization_url, knowledge_base_id, revision_id, category,
         entry_key, title, content, status, source_work_item_ids, evidence,
         metadata_json, content_hash, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, 'Knowledge Project',
         @organizationUrl, @knowledgeBaseId, 'legacy', 'module',
         'legacy-paths', 'Legacy paths', 'Legacy paths', 'active', '["42"]', @evidence,
         @metadataJson, 'legacy-hash', @now, @now
       )`,
      {
        id: versionId,
        workspaceId,
        projectId,
        organizationUrl,
        knowledgeBaseId: originalKnowledgeBaseId,
        evidence: quote,
        metadataJson: JSON.stringify({
          id: "legacy-paths",
          name: "Legacy paths",
          description: "Legacy paths",
          sourceWorkItemIds: ["42"],
          evidence: quote,
        }),
        now,
      },
    );

    await backfillProjectKnowledgeCompilerFoundation(scope);

    expect(await sqlAll<{ quote: string; origin: string; verification: string }>(
      `SELECT quote, origin, verification
       FROM project_knowledge_entry_evidence_refs
       WHERE entry_version_id = @versionId`,
      { versionId },
    )).toEqual([{ quote, origin: "migrated_legacy", verification: "exact" }]);
  });

  it("re-grounds a legacy candidate only through unique snapshot-field evidence", async () => {
    const candidateId = uniqueTestId("pkc");
    const now = nowIso();
    await sqlRun(
      `INSERT INTO project_knowledge_candidates (
         id, workspace_id, project_id, azure_project_id, azure_project_name,
         azure_organization_url, title, content, status, source_work_item_ids,
         evidence_refs_json, citations_json, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, 'Knowledge Project',
         @organizationUrl, 'Checkout rule', 'Payment rule', 'legacy_ungrounded',
         '["42"]'::jsonb, '[]'::jsonb, @citationsJson, @now, @now
       )`,
      {
        id: candidateId,
        workspaceId,
        projectId,
        organizationUrl,
        citationsJson: JSON.stringify({ legacyEvidence: "Checkout succeeds" }),
        now,
      },
    );

    await regroundLegacyProjectKnowledgeCandidates(scope);

    const candidate = await sqlGet<{ status: string; evidence_refs_json: unknown }>(
      `SELECT status, evidence_refs_json FROM project_knowledge_candidates WHERE id = @candidateId`,
      { candidateId },
    );
    expect(candidate?.status).toBe("grounded");
    expect(candidate?.evidence_refs_json).toEqual([{
      sourceSnapshotId: baselineSnapshotId,
      sourceWorkItemId: "42",
      sourceField: "acceptanceCriteria",
      quote: "Checkout succeeds",
      origin: "migrated_legacy",
      verification: "exact",
    }]);
  });
});
