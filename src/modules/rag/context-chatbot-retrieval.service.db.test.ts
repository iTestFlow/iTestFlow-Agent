import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import {
  refreshProjectKnowledgeSearchIndex,
  retrieveContextChatbotEvidence,
} from "@/modules/rag/context-chatbot-retrieval.service";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

const WS = uniqueTestId("ws_chatbotretrieval");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_chatbotretrieval");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Chatbot Retrieval",
  azureOrganizationUrl: ORG,
};

function checkoutItem(): Requirement {
  return requirement({
    id: "701",
    azureProjectId: PROJ,
    title: "Checkout process",
    // "workflow" only, no standalone "flow" -- proves trigram bridges this for
    // context search, since word-prefix FTS cannot match "flow" against it.
    description: "The checkout workflow charges the customer's card.",
    acceptanceCriteria: "Given a cart, when checkout completes, then confirm the order.",
    tags: [],
  });
}

function knowledgeBaseWithWorkflowEntry(): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "checkout-module",
      // Same compound-word setup as the context chunk above, on the knowledge side.
      name: "Checkout workflow",
      description: "Handles cart checkout and payment capture.",
      sourceWorkItemIds: ["701"],
      evidence: "WI 701",
    }],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
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

describeDb("context chatbot retrieval (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Chatbot Retrieval" });
    await sync([checkoutItem()]);
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: knowledgeBaseWithWorkflowEntry(),
    });
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM project_knowledge_entries_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_entries WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("finds context and knowledge via ordinary full-text matches", async () => {
    const evidence = await retrieveContextChatbotEvidence({ scope, query: "checkout customer card" });
    expect(evidence.context.map((item) => item.workItemId)).toEqual(["701"]);
    expect(evidence.knowledge.map((item) => item.entryKey)).toEqual(["checkout-module"]);
  });

  it("finds context via trigram when the query is a compound-word infix FTS prefix matching misses", async () => {
    const evidence = await retrieveContextChatbotEvidence({ scope, query: "flow" });
    expect(evidence.context.map((item) => item.workItemId)).toContain("701");
  });

  it("finds knowledge via trigram when the query is a compound-word infix FTS prefix matching misses", async () => {
    const evidence = await retrieveContextChatbotEvidence({ scope, query: "flow" });
    expect(evidence.knowledge.map((item) => item.entryKey)).toContain("checkout-module");
  });

  it("returns empty context and browse-order knowledge for a whitespace-only query", async () => {
    const evidence = await retrieveContextChatbotEvidence({ scope, query: "   " });
    expect(evidence.context).toEqual([]);
    expect(evidence.knowledge.map((item) => item.entryKey)).toContain("checkout-module");
  });

  it("scopes both context and knowledge to the requesting project", async () => {
    const otherScope: ProjectScope = {
      projectId: uniqueTestId("az_chatbotretrieval_other"),
      azureProjectId: uniqueTestId("az_chatbotretrieval_other"),
      azureProjectName: "Other project",
      azureOrganizationUrl: ORG,
    };
    const evidence = await retrieveContextChatbotEvidence({ scope: otherScope, query: "checkout customer card" });
    expect(evidence.context).toEqual([]);
    expect(evidence.knowledge).toEqual([]);
  });
});
