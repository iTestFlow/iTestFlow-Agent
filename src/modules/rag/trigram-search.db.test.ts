import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { searchProjectContextByTrigram } from "@/modules/rag/trigram-search";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

const WS = uniqueTestId("ws_trigram");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_trigram");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Trigram Search",
  azureOrganizationUrl: ORG,
};

function workflowItem(): Requirement {
  return requirement({
    id: "501",
    azureProjectId: PROJ,
    title: "Approval process",
    // Deliberately contains "workflow" only as a compound word -- no standalone
    // "flow" token anywhere, so word-prefix FTS matching on "flow" cannot find it.
    description: "The approval workflow routes requests to a manager.",
    acceptanceCriteria: "Given a request, when submitted, then the workflow starts.",
    tags: [],
  });
}

async function sync(items: Requirement[]) {
  return indexAzureWorkItemsAsProjectContext({
    scope,
    actor: "db-test",
    adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => items) }),
    workItemTypes: ["User Story"],
    states: ["Active"],
  });
}

describeDb("trigram search (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Trigram Search" });
    await sync([workflowItem()]);
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("finds a compound-word match ('flow' -> 'workflow') that word-prefix FTS cannot", async () => {
    const results = await searchProjectContextByTrigram({ scope, query: "flow", topK: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.azure_work_item_id).toBe("501");
    expect(results[0]!.similarity).toBeGreaterThan(0);
  });

  it("returns nothing for an unrelated query", async () => {
    const results = await searchProjectContextByTrigram({ scope, query: "zzz nonexistent term", topK: 5 });
    expect(results).toEqual([]);
  });

  it("skips the database entirely for queries below the minimum trigram length", async () => {
    const results = await searchProjectContextByTrigram({ scope, query: "ab", topK: 5 });
    expect(results).toEqual([]);
  });

  it("scopes results to the requesting project", async () => {
    const otherScope: ProjectScope = {
      projectId: uniqueTestId("az_trigram_other"),
      azureProjectId: uniqueTestId("az_trigram_other"),
      azureProjectName: "Other project",
      azureOrganizationUrl: ORG,
    };
    const results = await searchProjectContextByTrigram({ scope: otherScope, query: "flow", topK: 5 });
    expect(results).toEqual([]);
  });
});
