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
  getPool,
  nowIso,
  resetDatabaseForTests,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "./project-context-store.service";
import { acquireProjectKnowledgeLock } from "./project-knowledge-lock";
import { fakeAzureAdapter, fakeLlmProvider, requirement } from "@/test/factories";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";
import {
  rebaseProjectKnowledgeDraft,
  saveGeneratedProjectKnowledgeBaseDraft,
  saveManualProjectKnowledgeBaseSnapshot,
} from "./project-knowledge.service";
import { recordProjectKnowledgeBenchmarkQuestion } from "./project-knowledge-benchmark.service";
import { regroundLegacyProjectKnowledgeCandidates } from "./project-knowledge-compiled.service";
import {
  beginProjectKnowledgeDraft,
  completeProjectKnowledgeDraft,
  publishProjectKnowledgeDraft,
  startProjectKnowledgeMilestone3Ga,
} from "./project-knowledge-draft.service";
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

  async function prepare(knowledgeBase = initialKnowledgeBase) {
    return saveManualProjectKnowledgeBaseSnapshot({
      scope,
      actor: "user-1",
      rawOutput: JSON.stringify(knowledgeBase),
      mode: "full",
    });
  }

  async function publish(draftId: string) {
    return saveGeneratedProjectKnowledgeBaseDraft({ scope, actor: "user-1", draftId });
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
    await sqlRun(`DELETE FROM project_knowledge_rollout_state WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_adrs WHERE project_id = @projectId`, { projectId });
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
      await sqlRun(`DELETE FROM project_knowledge_rollout_state WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_adrs WHERE project_id = @projectId`, { projectId });
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
    expect(draft.persistedStatus).toBe("ready_for_review");
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

  it("counts v2 reconciliation publications only after the explicit Milestone 3 GA start", async () => {
    const beforeGa = await prepare();
    await publish(beforeGa.id);

    expect(await sqlGet<{ reconciliation_publication_count: number }>(
      `SELECT reconciliation_publication_count FROM project_knowledge_rollout_state
       WHERE project_id = @projectId AND azure_project_id = @projectId`,
      { projectId },
    )).toBeUndefined();

    await startProjectKnowledgeMilestone3Ga({ scope, actor: "owner-1" });
    const started = await sqlGet<{ milestone3_ga_at: string; reconciliation_publication_count: number }>(
      `SELECT milestone3_ga_at, reconciliation_publication_count FROM project_knowledge_rollout_state
       WHERE project_id = @projectId AND azure_project_id = @projectId`,
      { projectId },
    );
    expect(started).toMatchObject({ reconciliation_publication_count: 0 });
    expect(started?.milestone3_ga_at).toBeTruthy();

    const afterGa = await prepare();
    await publish(afterGa.id);
    await startProjectKnowledgeMilestone3Ga({ scope, actor: "owner-1" });

    expect(await sqlGet<{ milestone3_ga_at: string; reconciliation_publication_count: number }>(
      `SELECT milestone3_ga_at, reconciliation_publication_count FROM project_knowledge_rollout_state
       WHERE project_id = @projectId AND azure_project_id = @projectId`,
      { projectId },
    )).toEqual({
      milestone3_ga_at: started?.milestone3_ga_at,
      reconciliation_publication_count: 1,
    });
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
      { scope, knowledgeBaseId: originalKnowledgeBaseId, knowledgeBase: initialKnowledgeBase },
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
    expect(JSON.parse(persisted!.validated_output)).toEqual(initialKnowledgeBase);
    expect(await sqlAll<{ revision_number: number; mode: string; validated_output: string }>(
      `SELECT revision_number, mode, validated_output
       FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{
      revision_number: 1,
      mode: "full",
      validated_output: JSON.stringify(initialKnowledgeBase),
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

  it("serializes concurrent publications so exactly one stale-base draft publishes", async () => {
    const first = await prepare();
    const second = await prepare();
    const outcomes = await Promise.allSettled([publish(first.id), publish(second.id)]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "knowledge_draft_conflict" }),
    });
    expect(await sqlAll<{ revision_number: number }>(
      `SELECT revision_number FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{ revision_number: 1 }]);
    expect(await sqlAll<{ status: string }>(
      `SELECT status FROM project_knowledge_drafts
       WHERE id IN (@firstId, @secondId) ORDER BY status`,
      { firstId: first.id, secondId: second.id },
    )).toEqual([{ status: "published" }, { status: "rebase_required" }]);
  });

  it("serializes sync before publication and rejects the waiting stale draft", async () => {
    const draft = await prepare();
    const blocker = await getPool().connect();
    await blocker.query("BEGIN");
    await acquireProjectKnowledgeLock(scope, blocker);
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
    const syncPromise = indexAzureWorkItemsAsProjectContext({
      scope,
      actor: "sync-worker",
      adapter: fakeAzureAdapter({ fetchWorkItems }),
      workItemTypes: ["User Story"],
      states: ["Active"],
    });
    await vi.waitFor(() => expect(fetchWorkItems).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const publicationOutcome = publish(draft.id).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );
    await blocker.query("COMMIT");
    blocker.release();

    const [syncResult, publication] = await Promise.all([syncPromise, publicationOutcome]);
    expect(syncResult.updatedCount).toBe(1);
    expect(publication).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "knowledge_draft_conflict" }),
    });
    expect(await sqlAll(
      `SELECT id FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([]);
    expect(await sqlGet<{ status: string; pending_drift: boolean }>(
      `SELECT status, pending_drift FROM project_knowledge_drafts WHERE id = @draftId`,
      { draftId: draft.id },
    )).toEqual({ status: "rebase_required", pending_drift: true });
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

  it("creates a fingerprint-advance revision without entry versions", async () => {
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

    await publish((await prepare()).id);

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
    expect(revisions[1].provenance_hash).toBe(revisions[0].provenance_hash);
    expect(await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM project_knowledge_entry_versions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual({ count: 3 });
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

  it("automatically publishes a verified provenance-only rebase child", async () => {
    await publish((await prepare()).id);
    const parent = await prepare();
    const provenanceOnly = {
      ...initialKnowledgeBase,
      modules: [{
        ...initialKnowledgeBase.modules[0],
        evidence: "Checkout description",
        evidenceRefs: [evidenceRef("description", "Checkout description")],
      }],
    };
    const child = await prepare(provenanceOnly);
    await sqlRun(
      `UPDATE project_knowledge_drafts SET status = 'rebase_required', status_reason = 'source_drift'
       WHERE id = @parentId`,
      { parentId: parent.id },
    );
    await sqlRun(
      `UPDATE project_knowledge_drafts SET parent_draft_id = @parentId, rebase_depth = 1
       WHERE id = @childId`,
      { parentId: parent.id, childId: child.id },
    );

    const result = await publishProjectKnowledgeDraft({
      scope,
      actor: "rebase-worker",
      draftId: child.id,
      publicationIntent: "automatic_provenance_refresh",
    });

    expect(result?.persistedStatus).toBe("published");
    expect(await sqlAll<{ revision_number: number }>(
      `SELECT revision_number FROM project_knowledge_revisions
       WHERE project_id = @projectId ORDER BY revision_number`,
      { projectId },
    )).toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
  });

  it("denies automatic publication after a semantic change and preserves the reviewable child", async () => {
    await publish((await prepare()).id);
    const changedKnowledge = {
      ...initialKnowledgeBase,
      businessRules: [{
        ...initialKnowledgeBase.businessRules[0],
        rule: "Payment and fraud approval are required.",
      }],
    };
    const parent = await prepare(changedKnowledge);
    const child = await prepare(changedKnowledge);
    await sqlRun(
      `UPDATE project_knowledge_drafts SET status = 'rebase_required', status_reason = 'source_drift'
       WHERE id = @parentId`,
      { parentId: parent.id },
    );
    await sqlRun(
      `UPDATE project_knowledge_drafts SET parent_draft_id = @parentId, rebase_depth = 1
       WHERE id = @childId`,
      { parentId: parent.id, childId: child.id },
    );

    const result = await publishProjectKnowledgeDraft({
      scope,
      actor: "rebase-worker",
      draftId: child.id,
      publicationIntent: "automatic_provenance_refresh",
    });

    expect(result).toMatchObject({
      persistedStatus: "ready_for_review",
      statusReason: "automatic_publication_denied",
    });
    expect(await sqlAll<{ revision_number: number }>(
      `SELECT revision_number FROM project_knowledge_revisions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{ revision_number: 1 }]);
  });

  it("replays a clean automatic rebase child and publishes it through the orchestration service", async () => {
    await publish((await prepare()).id);
    const parent = await beginProjectKnowledgeDraft({
      scope,
      actor: "rebase-worker",
      generationMode: "automatic",
      compilationMode: "full",
    });
    const completedParent = await completeProjectKnowledgeDraft({
      scope,
      draftId: parent.id,
      provider: "openai",
      model: "test-model",
      rawOutput: JSON.stringify(initialKnowledgeBase),
      knowledgeBase: initialKnowledgeBase,
      touchedSourceWorkItemIds: ["42"],
    });
    expect(completedParent.persistedStatus).toBe("ready_for_review");

    // Advance only the active revision. Entry versions and the source manifest
    // remain unchanged, so deterministic replay preconditions still match.
    await publish((await prepare()).id);
    await sqlRun(
      `UPDATE project_knowledge_drafts
       SET status = 'rebase_required', status_reason = 'base_revision_drift'
       WHERE id = @parentId`,
      { parentId: parent.id },
    );

    const result = await rebaseProjectKnowledgeDraft({
      scope,
      actor: "rebase-worker",
      provider: fakeLlmProvider(),
      parentDraftId: parent.id,
    });
    if (!result) throw new Error("Expected the deterministic rebase child to be returned.");

    expect(result.persistedStatus).toBe("published");
    expect(result.parentDraftId).toBe(parent.id);
    expect(await sqlAll<{ revision_number: number }>(
      `SELECT revision_number FROM project_knowledge_revisions
       WHERE project_id = @projectId ORDER BY revision_number`,
      { projectId },
    )).toEqual([
      { revision_number: 1 },
      { revision_number: 2 },
      { revision_number: 3 },
    ]);
    expect(await sqlGet<{ status: string; status_reason: string | null }>(
      `SELECT status, status_reason FROM project_knowledge_drafts WHERE id = @parentId`,
      { parentId: parent.id },
    )).toEqual({ status: "superseded", status_reason: "descendant_published" });
  });

  it("blocks a deterministic rebase child when replay produces a merged hard conflict", async () => {
    await publish((await prepare()).id);
    const conflictingKnowledge = {
      ...initialKnowledgeBase,
      businessRules: [
        {
          id: "BR-RETRY-3",
          rule: "Maximum retry count must be 3",
          sourceField: "acceptanceCriteria" as const,
          moduleName: "Checkout",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: [evidenceRef("acceptanceCriteria", "Checkout succeeds")],
        },
        {
          id: "BR-RETRY-5",
          rule: "Maximum retry count must be 5",
          sourceField: "acceptanceCriteria" as const,
          moduleName: "checkout",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: [evidenceRef("acceptanceCriteria", "Checkout succeeds")],
        },
      ],
    };
    const parent = await beginProjectKnowledgeDraft({
      scope,
      actor: "rebase-worker",
      generationMode: "automatic",
      compilationMode: "full",
    });
    const completedParent = await completeProjectKnowledgeDraft({
      scope,
      draftId: parent.id,
      provider: "openai",
      model: "test-model",
      rawOutput: JSON.stringify(conflictingKnowledge),
      knowledgeBase: conflictingKnowledge,
      touchedSourceWorkItemIds: ["42"],
    });
    expect(completedParent.persistedStatus).toBe("blocked");

    await publish((await prepare()).id);
    await sqlRun(
      `UPDATE project_knowledge_drafts
       SET status = 'rebase_required', status_reason = 'base_revision_drift'
       WHERE id = @parentId`,
      { parentId: parent.id },
    );

    const result = await rebaseProjectKnowledgeDraft({
      scope,
      actor: "rebase-worker",
      provider: fakeLlmProvider(),
      parentDraftId: parent.id,
    });
    if (!result) throw new Error("Expected the blocked deterministic rebase child to be returned.");

    expect(result).toMatchObject({
      persistedStatus: "blocked",
      statusReason: "hard_conflict",
      parentDraftId: parent.id,
      blockers: [expect.objectContaining({ type: "hard_conflict" })],
    });
    expect(await sqlAll<{ conflict_type: string }>(
      `SELECT conflict_type FROM project_knowledge_hard_conflicts
       WHERE project_id = @projectId AND draft_id = @draftId`,
      { projectId, draftId: result.id },
    )).toEqual([{ conflict_type: "incompatible_concrete_value" }]);
    expect(await sqlAll<{ revision_number: number }>(
      `SELECT revision_number FROM project_knowledge_revisions
       WHERE project_id = @projectId ORDER BY revision_number`,
      { projectId },
    )).toEqual([{ revision_number: 1 }, { revision_number: 2 }]);
  });

  it("persists and blocks an incompatible concrete-value conflict", async () => {
    const conflictingKnowledge = {
      ...initialKnowledgeBase,
      businessRules: [
        {
          id: "BR-RETRY-3",
          rule: "Maximum retry count must be 3",
          sourceField: "acceptanceCriteria" as const,
          moduleName: "Checkout",
          sourceWorkItemIds: ["42"],
          evidence: "Checkout succeeds",
          evidenceRefs: [evidenceRef("acceptanceCriteria", "Checkout succeeds")],
        },
        {
          id: "BR-RETRY-5",
          rule: "Maximum retry count must be 5",
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
      subject: "checkout:maximum retry count",
    }]);
    await expect(publish(draft.id)).rejects.toMatchObject({ code: "knowledge_publication_blocked" });
  });

  it("persists duplicate canonical identity and rejects publication without map collapse", async () => {
    const duplicateKnowledge = {
      ...initialKnowledgeBase,
      modules: [
        initialKnowledgeBase.modules[0],
        {
          ...initialKnowledgeBase.modules[0],
          id: " checkout ",
          name: "Checkout duplicate",
        },
      ],
    };

    const draft = await prepare(duplicateKnowledge);
    expect(draft.persistedStatus).toBe("blocked");
    expect(await sqlAll<{ conflict_type: string; subject: string }>(
      `SELECT conflict_type, subject FROM project_knowledge_hard_conflicts
       WHERE project_id = @projectId AND draft_id = @draftId`,
      { projectId, draftId: draft.id },
    )).toEqual([{
      conflict_type: "duplicate_identity",
      subject: "identity:module:checkout",
    }]);
    await expect(publish(draft.id)).rejects.toMatchObject({ code: "knowledge_publication_blocked" });
    expect(await sqlAll(
      `SELECT id FROM project_knowledge_entry_versions WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([]);
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
