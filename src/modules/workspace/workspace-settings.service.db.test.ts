import { afterAll, beforeAll, expect, it } from "vitest";

import { cleanupFixtures, describeDb, seedWorkspace, suspendJiraBootstrapEnv, uniqueTestId } from "@/test/db";
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

async function cleanup(workspaceId?: string) {
  if (workspaceId) await sqlRun(`DELETE FROM workspace_settings WHERE workspace_id = @id`, { id: workspaceId });
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
}

describeDb("workspace settings (DB-backed)", () => {
  let workspaceId: string;
  const savedEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
  const savedLegacyOrg = process.env.BOOTSTRAP_OWNER_AZURE_ORG;
  let restoreJiraEnv = () => {};

  beforeAll(async () => {
    restoreJiraEnv = suspendJiraBootstrapEnv();
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
    restoreJiraEnv();
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
      modelInputTokenLimitOverride: 128000,
      updatedByUserId: null,
    });
    expect(view).toEqual({
      retrievalTopK: 12,
      maxOutputTokenCap: 64000,
      modelInputTokenLimitOverride: 128000,
      llmRetryAttempts: null,
      externalLlmEnabled: true,
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
      modelInputTokenLimitOverride: null,
      updatedByUserId: null,
    });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: null,
      maxOutputTokenCap: null,
      modelInputTokenLimitOverride: null,
      llmRetryAttempts: null,
      externalLlmEnabled: true,
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
      modelInputTokenLimitOverride: null,
      llmRetryAttempts: null,
      externalLlmEnabled: true,
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
      modelInputTokenLimitOverride: null,
      llmRetryAttempts: null,
      externalLlmEnabled: true,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
    // Update only top-K — the cap is preserved.
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 8, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: 8,
      maxOutputTokenCap: 64000,
      modelInputTokenLimitOverride: null,
      llmRetryAttempts: null,
      externalLlmEnabled: true,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
    // An explicit null still clears (inherit) — distinct from "omitted".
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: null, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: null,
      maxOutputTokenCap: 64000,
      modelInputTokenLimitOverride: null,
      llmRetryAttempts: null,
      externalLlmEnabled: true,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
  });

  it("round-trips the External LLM setting and preserves it during unrelated updates", async () => {
    await upsertWorkspaceSettings({ workspaceId, externalLlmEnabled: false, updatedByUserId: null });
    expect((await getWorkspaceSettings(workspaceId))?.externalLlmEnabled).toBe(false);

    await upsertWorkspaceSettings({ workspaceId, llmRetryAttempts: 2, updatedByUserId: null });
    expect((await getWorkspaceSettings(workspaceId))?.externalLlmEnabled).toBe(false);

    await upsertWorkspaceSettings({ workspaceId, externalLlmEnabled: true, updatedByUserId: null });
    expect((await getWorkspaceSettings(workspaceId))?.externalLlmEnabled).toBe(true);
  });

  it("merges concurrent partial workspace AI controls", async () => {
    // Begin without a row so one concurrent write inserts it and the others take
    // the conflict path. Each request must update only its supplied setting.
    await sqlRun(`DELETE FROM workspace_settings WHERE workspace_id = @id`, { id: workspaceId });

    await Promise.all([
      upsertWorkspaceSettings({ workspaceId, externalLlmEnabled: false, updatedByUserId: null }),
      upsertWorkspaceSettings({ workspaceId, maxOutputTokenCap: 64000, updatedByUserId: null }),
      upsertWorkspaceSettings({ workspaceId, modelInputTokenLimitOverride: 128000, updatedByUserId: null }),
      upsertWorkspaceSettings({ workspaceId, llmRetryAttempts: 3, updatedByUserId: null }),
    ]);

    expect(await getWorkspaceSettings(workspaceId)).toEqual({
      retrievalTopK: null,
      maxOutputTokenCap: 64000,
      modelInputTokenLimitOverride: 128000,
      llmRetryAttempts: 3,
      externalLlmEnabled: false,
      manualBaselineMinutes: null,
      reviewBaselineMinutes: null,
    });
  });

  it("keeps External LLM settings isolated between workspaces", async () => {
    const firstWorkspaceId = uniqueTestId("ws_external_llm_first");
    const secondWorkspaceId = uniqueTestId("ws_external_llm_second");
    await seedWorkspace({
      id: firstWorkspaceId,
      orgUrl: `https://dev.azure.com/${firstWorkspaceId}`,
    });
    await seedWorkspace({
      id: secondWorkspaceId,
      orgUrl: `https://dev.azure.com/${secondWorkspaceId}`,
    });

    try {
      await upsertWorkspaceSettings({
        workspaceId: firstWorkspaceId,
        externalLlmEnabled: false,
        updatedByUserId: null,
      });
      await upsertWorkspaceSettings({
        workspaceId: secondWorkspaceId,
        externalLlmEnabled: true,
        updatedByUserId: null,
      });

      expect((await getWorkspaceSettings(firstWorkspaceId))?.externalLlmEnabled).toBe(false);
      expect((await getWorkspaceSettings(secondWorkspaceId))?.externalLlmEnabled).toBe(true);
    } finally {
      await cleanupFixtures({
        workspaceIds: [firstWorkspaceId, secondWorkspaceId],
        userIds: [],
      });
    }
  });
});
