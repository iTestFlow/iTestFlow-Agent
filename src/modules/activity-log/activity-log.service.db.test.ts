import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { getActivityLog } from "@/modules/activity-log/activity-log.service";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace } from "@/test/db";

const WS_A = "ws_actlog_a";
const WS_B = "ws_actlog_b";
const ORG_A = "https://dev.azure.com/actlog-a";
const ORG_B = "https://dev.azure.com/actlog-b";
const PROJ_A = "az_actlog_a";
const PROJ_B = "az_actlog_b";

async function insertAudit(id: string, projectId: string, azureProjectId: string, action: string, createdAt = nowIso()) {
  // project_id is set so the scoping trigger derives workspace_id, mirroring real writes.
  await sqlRun(
    `INSERT INTO audit_logs (id, project_id, azure_project_id, action, status, message, created_at, updated_at)
     VALUES (@id, @projectId, @azureProjectId, @action, 'Success', @id, @createdAt, @createdAt)`,
    { id, projectId, azureProjectId, action, createdAt },
  );
}

async function insertKnowledgeEvent(input: {
  id: string;
  projectId: string;
  azureProjectId: string;
  eventType: string;
  severity?: string;
  title?: string;
  message?: string;
  sourceIds?: string;
  metadataJson?: string | null;
  createdAt: string;
}) {
  // Mirrors recordProjectKnowledgeLog's insert shape; workspace_id is trigger-derived.
  await sqlRun(
    `INSERT INTO project_knowledge_log (
       id, project_id, azure_project_id, azure_project_name, azure_organization_url,
       event_type, severity, title, message, source_ids, metadata_json, created_at
     ) VALUES (
       @id, @projectId, @azureProjectId, 'Actlog Project', 'https://dev.azure.com/actlog',
       @eventType, @severity, @title, @message, @sourceIds, @metadataJson, @createdAt
     )`,
    {
      id: input.id,
      projectId: input.projectId,
      azureProjectId: input.azureProjectId,
      eventType: input.eventType,
      severity: input.severity ?? "info",
      title: input.title ?? input.id,
      message: input.message ?? `${input.id} message`,
      sourceIds: input.sourceIds ?? "[]",
      metadataJson: input.metadataJson ?? null,
      createdAt: input.createdAt,
    },
  );
}

describeDb("activity log workspace scoping (DB-backed)", () => {
  beforeAll(async () => {
    await cleanupFixtures({ workspaceIds: [WS_A, WS_B], userIds: [] });
    await seedWorkspace({ id: WS_A, orgUrl: ORG_A });
    await seedWorkspace({ id: WS_B, orgUrl: ORG_B });
    await seedProject({ workspaceId: WS_A, orgUrl: ORG_A, azureProjectId: PROJ_A });
    await seedProject({ workspaceId: WS_B, orgUrl: ORG_B, azureProjectId: PROJ_B });
    await insertAudit("act_a1", PROJ_A, PROJ_A, "azure_devops.sync");
    await insertAudit("act_a2", PROJ_A, PROJ_A, "rag.index");
    await insertAudit("act_b1", PROJ_B, PROJ_B, "azure_devops.sync");
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [WS_A, WS_B], userIds: [] });
    await resetDatabaseForTests();
  });

  // R4 #4 — a workspace-scoped read returns only that workspace's rows.
  it("returns only the requesting workspace's activity", async () => {
    const result = await getActivityLog({ workspaceId: WS_A });
    expect(result.items.length).toBe(2);
    expect(result.items.every((item) => item.audit.azureProjectId === PROJ_A)).toBe(true);

    const other = await getActivityLog({ workspaceId: WS_B });
    expect(other.items.length).toBe(1);
    expect(other.items[0]?.audit.azureProjectId).toBe(PROJ_B);
  });

  // R4 #4 — a null/absent scope must NOT behave as match-all across workspaces; the
  // read stays bounded to ctx.workspace.id.
  it("does not leak other workspaces when no project scope is supplied", async () => {
    const result = await getActivityLog({ workspaceId: WS_A, scope: undefined });
    expect(result.items.length).toBe(2);
    expect(result.items.some((item) => item.audit.azureProjectId === PROJ_B)).toBe(false);
    // Available-action groups are also workspace-scoped (WS_A has azure_devops + rag).
    expect(result.availableActions.map((a) => a.value).sort()).toEqual(["azure_devops", "rag"]);
  });
});

const WS_K = "ws_actlog_k";
const WS_K2 = "ws_actlog_k2";
const ORG_K = "https://dev.azure.com/actlog-k";
const ORG_K2 = "https://dev.azure.com/actlog-k2";
const PROJ_K = "az_actlog_k";
const PROJ_K2 = "az_actlog_k2";

describeDb("activity log knowledge-event merge (DB-backed)", () => {
  beforeAll(async () => {
    await sqlRun(`DELETE FROM project_knowledge_log WHERE workspace_id IN (@wsA, @wsB)`, { wsA: WS_K, wsB: WS_K2 });
    await cleanupFixtures({ workspaceIds: [WS_K, WS_K2], userIds: [] });
    await seedWorkspace({ id: WS_K, orgUrl: ORG_K });
    await seedWorkspace({ id: WS_K2, orgUrl: ORG_K2 });
    await seedProject({ workspaceId: WS_K, orgUrl: ORG_K, azureProjectId: PROJ_K });
    await seedProject({ workspaceId: WS_K2, orgUrl: ORG_K2, azureProjectId: PROJ_K2 });

    await insertAudit("actk_audit1", PROJ_K, PROJ_K, "rag.knowledge_draft.published", "2026-08-01T10:02:00.000Z");
    await insertKnowledgeEvent({
      id: "actk_know1",
      projectId: PROJ_K,
      azureProjectId: PROJ_K,
      eventType: "knowledge.lint_completed",
      severity: "warning",
      title: "Lint finished",
      message: "2 warnings found",
      sourceIds: `["41","42"]`,
      metadataJson: `{"issueCount":2}`,
      createdAt: "2026-08-01T10:03:00.000Z",
    });
    await insertKnowledgeEvent({
      id: "actk_know2",
      projectId: PROJ_K,
      azureProjectId: PROJ_K,
      eventType: "context.embedding_failed",
      severity: "error",
      title: "Embedding sync failed",
      message: "model unavailable",
      createdAt: "2026-08-01T10:01:00.000Z",
    });
    // Another workspace's knowledge event must never leak into WS_K reads.
    await insertKnowledgeEvent({
      id: "actk_other",
      projectId: PROJ_K2,
      azureProjectId: PROJ_K2,
      eventType: "knowledge.exported",
      createdAt: "2026-08-01T10:04:00.000Z",
    });
  });

  afterAll(async () => {
    // cleanupFixtures does not cover project_knowledge_log; its workspace_id FK would
    // otherwise block the workspaces delete.
    await sqlRun(`DELETE FROM project_knowledge_log WHERE workspace_id IN (@wsA, @wsB)`, { wsA: WS_K, wsB: WS_K2 });
    await cleanupFixtures({ workspaceIds: [WS_K, WS_K2], userIds: [] });
    await resetDatabaseForTests();
  });

  it("merges knowledge events with audit rows newest-first and maps their shape", async () => {
    const result = await getActivityLog({ workspaceId: WS_K });
    expect(result.items.map((item) => item.id)).toEqual(["actk_know1", "actk_audit1", "actk_know2"]);

    const lint = result.items[0]!;
    expect(lint.action).toBe("knowledge.lint_completed");
    expect(lint.status).toBe("Warning");
    expect(lint.message).toBe("Lint finished — 2 warnings found");
    expect(lint.audit.actor).toBeNull();
    expect(lint.audit.entityType).toBe("knowledge_event");
    expect(lint.audit.detailsJson).toEqual({ sourceIds: ["41", "42"], metadata: { issueCount: 2 } });

    const failure = result.items[2]!;
    expect(failure.status).toBe("Error");
    expect(failure.audit.detailsJson).toBeNull();
  });

  it("isolates knowledge and context groups through the group filter", async () => {
    const knowledge = await getActivityLog({ workspaceId: WS_K, groups: ["knowledge"] });
    expect(knowledge.items.map((item) => item.id)).toEqual(["actk_know1"]);

    const context = await getActivityLog({ workspaceId: WS_K, groups: ["context"] });
    expect(context.items.map((item) => item.id)).toEqual(["actk_know2"]);
  });

  it("searches knowledge event titles and messages", async () => {
    const byTitle = await getActivityLog({ workspaceId: WS_K, search: "Lint finished" });
    expect(byTitle.items.map((item) => item.id)).toEqual(["actk_know1"]);

    const byMessage = await getActivityLog({ workspaceId: WS_K, search: "model unavailable" });
    expect(byMessage.items.map((item) => item.id)).toEqual(["actk_know2"]);
  });

  it("keeps hasMore honest across the merged sources and never leaks other workspaces", async () => {
    const limited = await getActivityLog({ workspaceId: WS_K, limit: 2 });
    expect(limited.items.length).toBe(2);
    expect(limited.hasMore).toBe(true);

    const all = await getActivityLog({ workspaceId: WS_K });
    expect(all.hasMore).toBe(false);
    expect(all.items.some((item) => item.id === "actk_other")).toBe(false);
    expect(all.availableActions.map((a) => a.value).sort()).toEqual(["context", "knowledge", "rag"]);
  });
});
