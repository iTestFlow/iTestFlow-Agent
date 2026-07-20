import "server-only";

import { describe } from "vitest";
import { flushBackgroundWrites, nowIso, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { persistSession } from "@/modules/auth/session.service";

/**
 * Shared harness for DB-backed integration tests (ADR-9). `describeDb` runs a suite
 * only when DATABASE_URL is set (CI provides a migrated Postgres; the default unit
 * run skips it). The seed helpers create the minimal identity/workspace/project rows
 * a route or service needs, so isolation tests don't copy-paste insert SQL.
 */

export const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

// Mechanical isolation: fixture IDs built with uniqueTestId never collide with rows
// left behind by a crashed earlier run (afterAll cleanup does not run on a crash, and
// unlike CI's fresh service container, a local database persists between runs).
const RUN_SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let uniqueCounter = 0;

/** A per-run-unique fixture ID: `${prefix}_<runsuffix>_<n>`. Prefer this over fixed IDs in new tests. */
export function uniqueTestId(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${RUN_SUFFIX}_${uniqueCounter}`;
}

export async function seedWorkspace(input: { id: string; orgUrl: string; name?: string; orgName?: string }): Promise<void> {
  await sqlRun(
    `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
     VALUES (@id, @name, @orgName, @orgUrl, 'active', @now, @now)
     ON CONFLICT (id) DO NOTHING`,
    { id: input.id, name: input.name ?? input.id, orgName: input.orgName ?? input.id, orgUrl: input.orgUrl, now: nowIso() },
  );
}

export async function seedUser(input: { id: string; email: string; displayName?: string }): Promise<void> {
  await sqlRun(
    `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
     VALUES (@id, @displayName, @email, 'active', @now)
     ON CONFLICT (id) DO NOTHING`,
    { id: input.id, displayName: input.displayName ?? input.id, email: input.email, now: nowIso() },
  );
}

export async function seedMembership(input: {
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}): Promise<void> {
  await sqlRun(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
     VALUES (@id, @workspaceId, @userId, @role, 'active', @now, @now)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'`,
    {
      id: `mbr_${input.workspaceId}_${input.userId}`,
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      now: nowIso(),
    },
  );
}

/** Anchor a project the way the workspace project-anchor service does: id = the Azure GUID (INV-1). */
export async function seedProject(input: {
  workspaceId: string;
  orgUrl: string;
  azureProjectId: string;
  azureProjectName?: string;
}): Promise<void> {
  await sqlRun(
    `INSERT INTO projects (id, azure_project_id, azure_project_name, azure_organization_url, name, status, workspace_id, created_at, updated_at)
     VALUES (@id, @id, @name, @orgUrl, @name, 'active', @workspaceId, @now, @now)
     ON CONFLICT (azure_organization_url, azure_project_id)
     DO UPDATE SET workspace_id = EXCLUDED.workspace_id, updated_at = EXCLUDED.updated_at`,
    {
      id: input.azureProjectId,
      name: input.azureProjectName ?? input.azureProjectId,
      orgUrl: input.orgUrl,
      workspaceId: input.workspaceId,
      now: nowIso(),
    },
  );
}

/** Create a real session row for `userId` and return the raw cookie token. */
export async function createTestSession(userId: string): Promise<string> {
  const { token } = await persistSession({ userId });
  return token;
}

/** Remove the rows seeded above for the given workspaces and users (FK-safe order). */
export async function cleanupFixtures(input: { workspaceIds: string[]; userIds: string[] }): Promise<void> {
  // Some services persist audit/history rows through the shared deferred-write
  // queue. Let those writes settle before removing their workspace parents.
  await flushBackgroundWrites();

  for (const id of input.workspaceIds) {
    await sqlRun(`DELETE FROM analytics_workflow_runs WHERE workspace_id = @id OR azure_project_id IN (SELECT azure_project_id FROM projects WHERE workspace_id = @id)`, { id });
    await sqlRun(`DELETE FROM audit_logs WHERE workspace_id = @id OR azure_project_id IN (SELECT azure_project_id FROM projects WHERE workspace_id = @id)`, { id });
    await sqlRun(`DELETE FROM projects WHERE workspace_id = @id`, { id });
    await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id });
  }
  for (const id of input.userIds) {
    await sqlRun(`DELETE FROM sessions WHERE user_id = @id`, { id });
    await sqlRun(`DELETE FROM users WHERE id = @id`, { id });
  }
  for (const id of input.workspaceIds) {
    await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id });
  }
}
