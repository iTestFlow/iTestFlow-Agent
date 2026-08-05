import { afterAll, beforeAll, expect, it, vi } from "vitest";

// requireSession() (called by requireWorkflowContext) reads the session cookie via
// next/headers cookies(). Mint a real session token with createTestSession and feed
// it through this mutable cookie store -- copied verbatim from the pattern in
// src/app/api/isolation.route.db.test.ts.
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

import { resetDatabaseForTests } from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  createTestSession,
  describeDb,
  seedMembership,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { SessionError } from "@/modules/auth/session.service";
import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { resolveDocumentMutationScope, resolveDocumentReadScope } from "./document-route-helpers";

// Per-run identifiers: this suite shares the database with other suites/agents, so
// every row it writes is keyed under these unique workspace/project/user ids.
const WS_A = uniqueTestId("ws_docauthz_a");
const WS_B = uniqueTestId("ws_docauthz_b");
const ORG_A = `https://dev.azure.com/${WS_A}`;
const ORG_B = `https://dev.azure.com/${WS_B}`;
const PROJECT_A = uniqueTestId("az_docauthz_a"); // anchored in WS_A
const PROJECT_B = uniqueTestId("az_docauthz_b"); // anchored in WS_B

const OWNER = uniqueTestId("user_owner");
const MEMBER = uniqueTestId("user_member");
const OUTSIDER = uniqueTestId("user_outsider"); // member of WS_B only

const scopeA: ProjectScope = {
  projectId: PROJECT_A,
  azureProjectId: PROJECT_A,
  azureProjectName: "Docauthz Project A",
  azureOrganizationUrl: ORG_A,
  workspaceId: WS_A,
};

describeDb("document route authz helpers (DB-backed, session/role-gated, resolvers unmocked)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS_A, orgUrl: ORG_A });
    await seedWorkspace({ id: WS_B, orgUrl: ORG_B });
    await seedUser({ id: OWNER, email: `${OWNER}@itestflow.test` });
    await seedUser({ id: MEMBER, email: `${MEMBER}@itestflow.test` });
    await seedUser({ id: OUTSIDER, email: `${OUTSIDER}@itestflow.test` });
    await seedMembership({ workspaceId: WS_A, userId: OWNER, role: "owner" });
    await seedMembership({ workspaceId: WS_A, userId: MEMBER, role: "member" });
    // OUTSIDER belongs only to WS_B, never to WS_A.
    await seedMembership({ workspaceId: WS_B, userId: OUTSIDER, role: "member" });
    await seedProject({
      workspaceId: WS_A,
      orgUrl: ORG_A,
      azureProjectId: PROJECT_A,
      azureProjectName: "Docauthz Project A",
    });
    await seedProject({
      workspaceId: WS_B,
      orgUrl: ORG_B,
      azureProjectId: PROJECT_B,
      azureProjectName: "Docauthz Project B",
    });
  });

  afterAll(async () => {
    cookieState.token = undefined;
    await cleanupFixtures({ workspaceIds: [WS_A, WS_B], userIds: [OWNER, MEMBER, OUTSIDER] });
    await resetDatabaseForTests();
  });

  it("an owner passes resolveDocumentMutationScope", async () => {
    cookieState.token = await createTestSession(OWNER);

    const result = await resolveDocumentMutationScope(scopeA);
    expect(result.ctx.userId).toBe(OWNER);
    expect(result.ctx.workspace.id).toBe(WS_A);
    expect(result.scope.azureProjectId).toBe(PROJECT_A);
  });

  it("a member passes read scope but is rejected from mutation scope with the exact 403 message", async () => {
    cookieState.token = await createTestSession(MEMBER);

    const read = await resolveDocumentReadScope(scopeA);
    expect(read.ctx.userId).toBe(MEMBER);
    expect(read.scope.azureProjectId).toBe(PROJECT_A);

    try {
      await resolveDocumentMutationScope(scopeA);
      expect.unreachable("resolveDocumentMutationScope should have rejected a member");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowAuthError);
      expect((error as WorkflowAuthError).status).toBe(403);
      expect((error as Error).message).toBe("Only workspace owners and admins can manage source documents.");
    }
  });

  it("a second workspace's user targeting the first workspace's project fails without existence leakage", async () => {
    cookieState.token = await createTestSession(OUTSIDER);

    // OUTSIDER's own membership (WS_B) resolves fine, but the scope's project ids
    // are anchored in WS_A -- a different workspace. resolveProjectScope must
    // reject this generically (same message/shape whether or not the project
    // exists anywhere) rather than ever leaking existence across workspaces.
    const foreignScope: ProjectScope = {
      projectId: PROJECT_A,
      azureProjectId: PROJECT_A,
      azureProjectName: "Docauthz Project A",
      azureOrganizationUrl: ORG_A,
      workspaceId: WS_B,
    };

    try {
      await resolveDocumentReadScope(foreignScope);
      expect.unreachable("resolveDocumentReadScope should have rejected a cross-workspace project reference");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowAuthError);
      expect((error as WorkflowAuthError).status).toBe(403);
      expect((error as Error).message).toBe("The selected Azure DevOps project does not belong to this workspace.");
    }
  });

  it("no session produces the auth error shape: SessionError('Authentication required.')", async () => {
    cookieState.token = undefined;

    try {
      await resolveDocumentReadScope(scopeA);
      expect.unreachable("resolveDocumentReadScope should have rejected an unauthenticated caller");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as Error).message).toBe("Authentication required.");
    }
  });
});
