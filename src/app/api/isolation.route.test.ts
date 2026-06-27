import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Inject the session cookie that requireSession() reads via next/headers. The store
// is mutable so each test sets (or clears) the active token before calling a route.
const cookieState = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "itf_session" && cookieState.token ? { value: cookieState.token } : undefined),
    set: () => {},
    delete: () => {
      cookieState.token = undefined;
    },
    getAll: () => [],
    has: (name: string) => name === "itf_session" && Boolean(cookieState.token),
  }),
}));

import { flushBackgroundWrites, resetDatabaseForTests, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, createTestSession, describeDb, seedMembership, seedProject, seedUser, seedWorkspace } from "@/test/db";
import { POST as workItemDetailsPost } from "@/app/api/azure-devops/work-item-details/route";
import { POST as requirementRunPost } from "@/app/api/requirement-analysis/run/route";
import { POST as requirementManualSubmitPost } from "@/app/api/requirement-analysis/manual/submit/route";

const WS_A = "ws_iso_a";
const WS_B = "ws_iso_b";
const ORG_A = "https://dev.azure.com/iso-a";
const ORG_B = "https://dev.azure.com/iso-b";
const USER = "user_iso_member";
const PROJECT_A = "az_iso_project_a"; // anchored in WS_A
const PROJECT_B = "az_iso_project_b"; // anchored in WS_B (foreign to USER)

function post(handler: (req: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function countByProject(table: "analytics_workflow_runs" | "audit_logs", azureProjectId: string) {
  const row = await sqlGet<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE azure_project_id = @azureProjectId`,
    { azureProjectId },
  );
  return row?.count ?? 0;
}

async function countAnalyticsByUser(azureProjectId: string, userId: string) {
  const row = await sqlGet<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM analytics_workflow_runs
      WHERE azure_project_id = @azureProjectId AND user_id = @userId`,
    { azureProjectId, userId },
  );
  return row?.count ?? 0;
}

async function countAuditByActor(azureProjectId: string, actor: string) {
  const row = await sqlGet<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM audit_logs
      WHERE azure_project_id = @azureProjectId AND actor = @actor`,
    { azureProjectId, actor },
  );
  return row?.count ?? 0;
}

const validRequirementAnalysisOutput = JSON.stringify({
  findings: [],
  summary: {
    totalFindings: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0,
    overallQuality: "good",
    completenessScore: 100,
    clarityScore: 100,
    testabilityScore: 100,
    summaryText: "No issues found.",
  },
  recommendations: [],
  questionsForProductOwner: [],
  contextUsed: [],
});

describeDb("API isolation & pre-auth side effects (DB-backed, route-level)", () => {
  beforeAll(async () => {
    await cleanupFixtures({ workspaceIds: [WS_A, WS_B], userIds: [USER] });
    await seedWorkspace({ id: WS_A, orgUrl: ORG_A });
    await seedWorkspace({ id: WS_B, orgUrl: ORG_B });
    await seedUser({ id: USER, email: "iso-member@itestflow.test" });
    await seedMembership({ workspaceId: WS_A, userId: USER, role: "member" });
    await seedProject({ workspaceId: WS_A, orgUrl: ORG_A, azureProjectId: PROJECT_A, azureProjectName: "A Project" });
    await seedProject({ workspaceId: WS_B, orgUrl: ORG_B, azureProjectId: PROJECT_B, azureProjectName: "B Project" });
  });

  afterAll(async () => {
    cookieState.token = undefined;
    await cleanupFixtures({ workspaceIds: [WS_A, WS_B], userIds: [USER] });
    await resetDatabaseForTests();
  });

  // R4 #3 — a guarded route, driven with a foreign azureProjectId, must 403 at the
  // resolver and never reach the Azure adapter (no cross-workspace data access).
  it("rejects a guarded route call whose project belongs to another workspace (403)", async () => {
    cookieState.token = await createTestSession(USER);
    const res = await post(workItemDetailsPost, {
      scope: {
        // USER is a member of WS_A but forges a scope for WS_B's project.
        projectId: PROJECT_B,
        azureProjectId: PROJECT_B,
        azureProjectName: "B Project",
        azureOrganizationUrl: ORG_B,
        workspaceId: WS_A,
      },
      workItemId: "123",
    });
    expect(res.status).toBe(403);
  });

  // R4 #3 (positive control) — the user's own workspace project resolves past the
  // 403 guard. It then fails at the Azure call (no real PAT), proving the rejection
  // above is isolation-specific, not a blanket failure.
  it("does not 403 a project owned by the caller's workspace", async () => {
    cookieState.token = await createTestSession(USER);
    const res = await post(workItemDetailsPost, {
      scope: {
        projectId: PROJECT_A,
        azureProjectId: PROJECT_A,
        azureProjectName: "A Project",
        azureOrganizationUrl: ORG_A,
        workspaceId: WS_A,
      },
      workItemId: "123",
    });
    expect(res.status).not.toBe(403);
  });

  // R4 #5 — an unauthenticated request to an analytics-writing route must 401 BEFORE
  // startWorkflowRun, leaving zero analytics and zero audit rows.
  it("writes no analytics/audit rows when the request is unauthenticated (401)", async () => {
    cookieState.token = undefined;
    const res = await post(requirementRunPost, {
      scope: {
        projectId: PROJECT_A,
        azureProjectId: PROJECT_A,
        azureProjectName: "A Project",
        azureOrganizationUrl: ORG_A,
        workspaceId: WS_A,
      },
      targetWorkItemId: "1",
    });
    expect(res.status).toBe(401);

    await flushBackgroundWrites();
    expect(await countByProject("analytics_workflow_runs", PROJECT_A)).toBe(0);
    expect(await countByProject("audit_logs", PROJECT_A)).toBe(0);
  });

  it("writes analytics/audit rows with the authenticated user id", async () => {
    cookieState.token = await createTestSession(USER);
    const res = await post(requirementManualSubmitPost, {
      scope: {
        projectId: PROJECT_A,
        azureProjectId: PROJECT_A,
        azureProjectName: "A Project",
        azureOrganizationUrl: ORG_A,
        workspaceId: WS_A,
      },
      targetWorkItemId: "1",
      enabledChecklistItemIds: ["completeness_testability"],
      rawOutput: validRequirementAnalysisOutput,
      contextCitations: [],
    });
    expect(res.status).toBe(200);

    await flushBackgroundWrites();
    expect(await countAnalyticsByUser(PROJECT_A, USER)).toBe(1);
    expect(await countAuditByActor(PROJECT_A, USER)).toBe(1);
    expect(await countAnalyticsByUser(PROJECT_A, "local-user")).toBe(0);
    expect(await countAuditByActor(PROJECT_A, "local-user")).toBe(0);
  });
});
