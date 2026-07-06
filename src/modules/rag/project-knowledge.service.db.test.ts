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
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";
import { saveManualProjectKnowledgeBaseSnapshot } from "./project-knowledge.service";

describeDb("project knowledge transaction integrity", () => {
  const workspaceId = uniqueTestId("ws_kb");
  const projectId = uniqueTestId("project_kb");
  const organizationUrl = `https://dev.azure.com/${uniqueTestId("org")}`;
  const originalKnowledgeBaseId = uniqueTestId("pkb_original");
  const scope = {
    projectId,
    azureProjectId: projectId,
    azureProjectName: "Knowledge Project",
    azureOrganizationUrl: organizationUrl,
  };
  const initialKnowledgeBase = {
    modules: [{
      id: "checkout",
      name: "Checkout",
      description: "Customers submit orders.",
      sourceWorkItemIds: ["42"],
      evidence: "Checkout succeeds",
    }],
    businessRules: [{
      id: "BR-1",
      rule: "Payment must be authorized.",
      sourceField: "acceptanceCriteria",
      moduleName: "Checkout",
      sourceWorkItemIds: ["42"],
      evidence: "Checkout succeeds",
    }],
    stateTransitions: [],
    glossary: [{
      term: "Order",
      type: "business_entity",
      definition: "A submitted customer purchase.",
      sourceWorkItemIds: ["42"],
      evidence: "Checkout description",
    }],
    crossDependencies: [],
  };

  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: organizationUrl });
    await seedProject({
      workspaceId,
      orgUrl: organizationUrl,
      azureProjectId: projectId,
      azureProjectName: "Knowledge Project",
    });
    const now = nowIso();
    await sqlRun(
      `INSERT INTO azure_devops_work_items (
         id, project_id, azure_project_id, azure_project_name, azure_organization_url,
         azure_work_item_id, work_item_type, title, description, acceptance_criteria,
         state, content_hash, sync_status, created_at, updated_at
       ) VALUES (
         @id, @projectId, @projectId, @projectName, @organizationUrl,
         '42', 'User Story', 'Checkout', 'Checkout description', 'Checkout succeeds',
         'Active', 'hash-42', 'active', @now, @now
       )`,
      {
        id: uniqueTestId("awi"),
        projectId,
        projectName: "Knowledge Project",
        organizationUrl,
        now,
      },
    );
  });

  beforeEach(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM project_knowledge_lint_issues WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_entry_versions WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_revisions WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_entries WHERE project_id = @projectId`, { projectId });
    await sqlRun(`DELETE FROM project_knowledge_base WHERE project_id = @projectId`, { projectId });
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
      await sqlRun(`DELETE FROM project_knowledge_lint_issues WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_entry_versions WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_revisions WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_entries WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_base WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId });
      await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
    } finally {
      await resetDatabaseForTests();
    }
  });

  it("rolls back replacement when rebuilding the search index fails", async () => {
    retrieval.refreshProjectKnowledgeSearchIndex.mockRejectedValueOnce(
      new Error("search index write failed"),
    );

    await expect(saveManualProjectKnowledgeBaseSnapshot({
      scope,
      actor: "user-1",
      rawOutput: JSON.stringify({
        modules: [],
        businessRules: [],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      }),
      mode: "full",
    })).rejects.toThrow("search index write failed");

    const surviving = await sqlGet<{ id: string; prompt_version: string }>(
      `SELECT id, prompt_version
       FROM project_knowledge_base
       WHERE project_id = @projectId AND azure_project_id = @projectId`,
      { projectId },
    );
    expect(surviving).toEqual({
      id: originalKnowledgeBaseId,
      prompt_version: "original",
    });
  });

  it("persists the snapshot, revision, and active entry versions atomically", async () => {
    const snapshot = await saveManualProjectKnowledgeBaseSnapshot({
      scope,
      actor: "user-1",
      rawOutput: JSON.stringify(initialKnowledgeBase),
      mode: "full",
    });

    expect(snapshot).toMatchObject({
      provider: "external",
      model: "manual-external",
      sourceWorkItemCount: 1,
      status: "Success",
    });
    expect(snapshot.id).not.toBe(originalKnowledgeBaseId);
    expect(retrieval.refreshProjectKnowledgeSearchIndex).toHaveBeenCalledExactlyOnceWith(
      {
        scope,
        knowledgeBaseId: snapshot.id,
        knowledgeBase: initialKnowledgeBase,
      },
      expect.anything(),
    );

    const persisted = await sqlGet<{
      id: string;
      provider: string;
      model_name: string;
      source_work_item_count: number;
      validated_output: string;
    }>(
      `SELECT id, provider, model_name, source_work_item_count, validated_output
       FROM project_knowledge_base
       WHERE project_id = @projectId`,
      { projectId },
    );
    expect(persisted).toMatchObject({
      id: snapshot.id,
      provider: "external",
      model_name: "manual-external",
      source_work_item_count: 1,
    });
    expect(JSON.parse(persisted!.validated_output)).toEqual(initialKnowledgeBase);

    expect(await sqlAll<{
      revision_number: number;
      mode: string;
      knowledge_base_id: string;
    }>(
      `SELECT revision_number, mode, knowledge_base_id
       FROM project_knowledge_revisions
       WHERE project_id = @projectId`,
      { projectId },
    )).toEqual([{
      revision_number: 1,
      mode: "full",
      knowledge_base_id: snapshot.id,
    }]);
    expect(await sqlAll<{ category: string; entry_key: string; status: string }>(
      `SELECT category, entry_key, status
       FROM project_knowledge_entry_versions
       WHERE project_id = @projectId
       ORDER BY category, entry_key`,
      { projectId },
    )).toEqual([
      { category: "business_rule", entry_key: "BR-1", status: "active" },
      { category: "glossary", entry_key: "Order", status: "active" },
      { category: "module", entry_key: "checkout", status: "active" },
    ]);
  });

  it("confirms unchanged entries, supersedes changed entries, and retires removed entries on resave", async () => {
    const first = await saveManualProjectKnowledgeBaseSnapshot({
      scope,
      actor: "user-1",
      rawOutput: JSON.stringify(initialKnowledgeBase),
      mode: "full",
    });
    const secondKnowledgeBase = {
      ...initialKnowledgeBase,
      businessRules: [{
        ...initialKnowledgeBase.businessRules[0],
        rule: "Payment and fraud checks must be authorized.",
        evidence: "Updated checkout policy",
      }],
      glossary: [],
    };

    const second = await saveManualProjectKnowledgeBaseSnapshot({
      scope,
      actor: "user-1",
      rawOutput: JSON.stringify(secondKnowledgeBase),
      mode: "full",
    });

    expect(second.id).not.toBe(first.id);
    expect(await sqlAll<{ revision_number: number; knowledge_base_id: string }>(
      `SELECT revision_number, knowledge_base_id
       FROM project_knowledge_revisions
       WHERE project_id = @projectId
       ORDER BY revision_number`,
      { projectId },
    )).toEqual([
      { revision_number: 1, knowledge_base_id: first.id },
      { revision_number: 2, knowledge_base_id: second.id },
    ]);

    const previousVersions = await sqlAll<{
      category: string;
      entry_key: string;
      status: string;
      superseded_by_entry_version_id: string | null;
    }>(
      `SELECT category, entry_key, status, superseded_by_entry_version_id
       FROM project_knowledge_entry_versions
       WHERE project_id = @projectId AND knowledge_base_id = @knowledgeBaseId
       ORDER BY category, entry_key`,
      { projectId, knowledgeBaseId: first.id },
    );
    expect(previousVersions).toEqual([
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
        status: "confirmed",
        superseded_by_entry_version_id: expect.any(String),
      },
    ]);
    expect(await sqlAll<{ category: string; entry_key: string; status: string }>(
      `SELECT category, entry_key, status
       FROM project_knowledge_entry_versions
       WHERE project_id = @projectId AND knowledge_base_id = @knowledgeBaseId
       ORDER BY category, entry_key`,
      { projectId, knowledgeBaseId: second.id },
    )).toEqual([
      { category: "business_rule", entry_key: "BR-1", status: "active" },
      { category: "module", entry_key: "checkout", status: "active" },
    ]);
  });
});
