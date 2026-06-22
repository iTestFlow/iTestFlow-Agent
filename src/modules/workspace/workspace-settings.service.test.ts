import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import {
  getWorkspaceSettings,
  upsertWorkspaceSettings,
} from "@/modules/workspace/workspace-settings.service";
import {
  clampTopK,
  DEFAULT_TOP_K,
  getRetrievalTopK,
  getRetrievalTopKFromEnv,
} from "@/modules/rag/retrieval-config";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  getMaxOutputTokenCapDefaultFromEnv,
} from "@/modules/llm/llm-defaults";

describe("workspace setting defaults (pure)", () => {
  const originalProjectContextTopK = process.env.PROJECT_CONTEXT_TOP_K;
  const originalMaxOutputTokenCap = process.env.LLM_MAX_OUTPUT_TOKEN_CAP;
  afterEach(() => {
    if (originalProjectContextTopK === undefined) delete process.env.PROJECT_CONTEXT_TOP_K;
    else process.env.PROJECT_CONTEXT_TOP_K = originalProjectContextTopK;
    if (originalMaxOutputTokenCap === undefined) delete process.env.LLM_MAX_OUTPUT_TOKEN_CAP;
    else process.env.LLM_MAX_OUTPUT_TOKEN_CAP = originalMaxOutputTokenCap;
  });

  it("clamps to [1, 25] and falls back to the default on a non-finite value", () => {
    expect(clampTopK(0)).toBe(1);
    expect(clampTopK(1000)).toBe(25);
    expect(clampTopK(12)).toBe(12);
    expect(clampTopK(Number.NaN)).toBe(DEFAULT_TOP_K);
  });

  it("reads PROJECT_CONTEXT_TOP_K from the environment with a clamped default", () => {
    process.env.PROJECT_CONTEXT_TOP_K = "15";
    expect(getRetrievalTopKFromEnv()).toBe(15);
    delete process.env.PROJECT_CONTEXT_TOP_K;
    expect(getRetrievalTopKFromEnv()).toBe(DEFAULT_TOP_K);
    process.env.PROJECT_CONTEXT_TOP_K = "999";
    expect(getRetrievalTopKFromEnv()).toBe(25);
  });

  it("reads LLM_MAX_OUTPUT_TOKEN_CAP from the environment with allowed-option defaults", () => {
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "64000";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(64000);
    delete process.env.LLM_MAX_OUTPUT_TOKEN_CAP;
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(DEFAULT_MAX_OUTPUT_TOKEN_CAP);
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "not-a-number";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(DEFAULT_MAX_OUTPUT_TOKEN_CAP);
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "999";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(16000);
    process.env.LLM_MAX_OUTPUT_TOKEN_CAP = "100000";
    expect(getMaxOutputTokenCapDefaultFromEnv()).toBe(64000);
  });
});

const TEST_EMAIL = "owner-wssettings@itestflow.test";
const TEST_ORG = "itestflow-wssettings-test-org";
const TEST_ORG_URL = "https://dev.azure.com/itestflow-wssettings-test-org";

// DB-backed (ADR-9): requires migrated PostgreSQL via DATABASE_URL; skipped otherwise.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

async function cleanup(workspaceId?: string) {
  if (workspaceId) await sqlRun(`DELETE FROM workspace_settings WHERE workspace_id = @id`, { id: workspaceId });
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
}

describeDb("workspace settings (DB-backed)", () => {
  let workspaceId: string;

  beforeAll(async () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = TEST_EMAIL;
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = TEST_ORG;
    await cleanup();
    const bootstrap = await ensureBootstrapOwner();
    workspaceId = bootstrap!.workspaceId;
  });

  afterAll(async () => {
    await cleanup(workspaceId);
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
    expect(view).toEqual({ retrievalTopK: 12, maxOutputTokenCap: 64000, llmRetryAttempts: null });
    expect(await getRetrievalTopK(workspaceId)).toBe(12);
  });

  it("treats null fields as 'inherit' — stored null, getRetrievalTopK falls back to env", async () => {
    await upsertWorkspaceSettings({
      workspaceId,
      retrievalTopK: null,
      maxOutputTokenCap: null,
      updatedByUserId: null,
    });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({ retrievalTopK: null, maxOutputTokenCap: null, llmRetryAttempts: null });
    process.env.PROJECT_CONTEXT_TOP_K = "20";
    expect(await getRetrievalTopK(workspaceId)).toBe(20);
    delete process.env.PROJECT_CONTEXT_TOP_K;
  });

  it("overwrites prior values on a subsequent upsert", async () => {
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 5, maxOutputTokenCap: 16000, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({ retrievalTopK: 5, maxOutputTokenCap: 16000, llmRetryAttempts: null });
  });

  it("applies partial updates without clobbering the omitted field", async () => {
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 5, maxOutputTokenCap: 16000, updatedByUserId: null });
    // Update only the cap — top-K is preserved (settings live in separate UI tabs).
    await upsertWorkspaceSettings({ workspaceId, maxOutputTokenCap: 64000, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({ retrievalTopK: 5, maxOutputTokenCap: 64000, llmRetryAttempts: null });
    // Update only top-K — the cap is preserved.
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: 8, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({ retrievalTopK: 8, maxOutputTokenCap: 64000, llmRetryAttempts: null });
    // An explicit null still clears (inherit) — distinct from "omitted".
    await upsertWorkspaceSettings({ workspaceId, retrievalTopK: null, updatedByUserId: null });
    expect(await getWorkspaceSettings(workspaceId)).toEqual({ retrievalTopK: null, maxOutputTokenCap: 64000, llmRetryAttempts: null });
  });
});
