import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import {
  getWorkspaceSettings,
  upsertWorkspaceSettings,
} from "@/modules/workspace/workspace-settings.service";
import {
  DEFAULT_TOP_K,
  getRetrievalTopK,
} from "@/modules/rag/retrieval-config";

const TEST_EMAIL = "owner-wssettings@itestflow.test";
const TEST_ORG = "itestflow-wssettings-test-org";
const TEST_ORG_URL = "https://dev.azure.com/itestflow-wssettings-test-org";

// DB-backed integration coverage; requires migrated PostgreSQL via DATABASE_URL.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

async function cleanup(workspaceId?: string) {
  if (workspaceId) await sqlRun(`DELETE FROM workspace_settings WHERE workspace_id = @id`, { id: workspaceId });
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
}

describeDb("workspace settings (DB-backed)", () => {
  let workspaceId: string;
  const savedEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
  const savedLegacyOrg = process.env.BOOTSTRAP_OWNER_AZURE_ORG;

  beforeAll(async () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = TEST_EMAIL;
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = TEST_ORG;
    await cleanup();
    const bootstrap = await ensureBootstrapOwner();
    workspaceId = bootstrap!.workspaceId;
  });

  afterAll(async () => {
    await cleanup(workspaceId);
    if (savedEmail === undefined) delete process.env.BOOTSTRAP_OWNER_EMAIL;
    else process.env.BOOTSTRAP_OWNER_EMAIL = savedEmail;
    if (savedLegacyOrg === undefined) delete process.env.BOOTSTRAP_OWNER_AZURE_ORG;
    else process.env.BOOTSTRAP_OWNER_AZURE_ORG = savedLegacyOrg;
    await resetDatabaseForTests();
  });

  it("returns null before any settings are stored", async () => {
    expect(await getWorkspaceSettings(workspaceId)).toBeNull();
  });

  it("getRetrievalTopK falls back to the env default when the workspace has no override", async () => {
    delete process.env.PROJECT_CONTEXT_TOP_K;
    expect(await getRetrievalTopK(workspaceId)).toBe(DEFAULT_TOP_K);
  });

  it("upserts and round-trips both fields", async () => {
    const view = await upsertWorkspaceSettings({
      workspaceId,
      retrievalTopK: 12,
      maxOutputTokenCap: 64000,
      updatedByUserId: null,
    });
    expect(view).toEqual({
      retrievalTopK: 12,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
    expect(await getRetrievalTopK(workspaceId)).toBe(12);
  });

  it("treats null fields as 'inherit' — stored null, getRetrievalTopK falls back to env", async () => {
    await upsertWorkspaceSettings({
      workspaceId,
      retrievalTopK: null,
      maxOutputTokenCap: null,
      updatedByUserId: null,
    });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: null,
      maxOutputTokenCap: null,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
    process.env.PROJECT_CONTEXT_TOP_K = "20";
    expect(await getRetrievalTopK(workspaceId)).toBe(20);
    delete process.env.PROJECT_CONTEXT_TOP_K;
  });

  it("overwrites prior values on a subsequent upsert", async () => {
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 5, maxOutputTokenCap: 16000, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: 5,
      maxOutputTokenCap: 16000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
  });

  it("applies partial updates without clobbering the omitted field", async () => {
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 5, maxOutputTokenCap: 16000, updatedByUserId: null });
    // Update only the cap — top-K is preserved (settings live in separate UI tabs).
    await upsertWorkspaceSettings({ workspaceId, maxOutputTokenCap: 64000, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: 5,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
    // Update only top-K — the cap is preserved.
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 8, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: 8,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
    // An explicit null still clears (inherit) — distinct from "omitted".
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: null, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: null,
      maxOutputTokenCap: 64000,
      llmRetryAttempts: null,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
  });
});
