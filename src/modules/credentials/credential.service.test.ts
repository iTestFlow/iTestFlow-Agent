import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createId, nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  getUserCredentialStatus,
  resolveUserAzurePat,
  resolveUserLlmConfig,
  saveUserLlmSettings,
  storeUserAzurePat,
  storeUserLlmApiKey,
} from "@/modules/credentials/credential.service";

const WS_URL = "https://dev.azure.com/cred-test-org";

// DB-backed (ADR-9): requires migrated PostgreSQL via DATABASE_URL; skipped otherwise.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("credential service (DB-backed)", () => {
  const workspaceId = createId("ws");
  const userId = createId("user");

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const now = nowIso();
    await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @u`, { u: WS_URL });
    await sqlRun(
      `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
       VALUES (@id, 'Cred Test', 'cred-test-org', @u, 'active', @now, @now)`,
      { id: workspaceId, u: WS_URL, now },
    );
    await sqlRun(
      `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
       VALUES (@id, 'Cred User', @email, 'active', @now)`,
      { id: userId, email: `${userId}@cred-test`, now },
    );
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @u`, { u: WS_URL });
    await sqlRun(`DELETE FROM users WHERE id = @id`, { id: userId });
    await resetDatabaseForTests();
  });

  it("stores and resolves an encrypted Azure PAT", async () => {
    await storeUserAzurePat({ workspaceId, userId, pat: "pat-secret-9999" });
    expect(await resolveUserAzurePat(workspaceId, userId)).toBe("pat-secret-9999");
  });

  it("stores an LLM key + settings and resolves a usable config", async () => {
    await storeUserLlmApiKey({ workspaceId, userId, provider: "openai", apiKey: "sk-abc-7777" });
    await saveUserLlmSettings({ workspaceId, userId, provider: "openai", model: "gpt-x", isDefault: true });
    expect(await resolveUserLlmConfig(workspaceId, userId)).toMatchObject({
      provider: "openai",
      model: "gpt-x",
      apiKey: "sk-abc-7777",
    });
  });

  it("exposes only masked status, never raw secrets", async () => {
    const status = await getUserCredentialStatus(workspaceId, userId);
    expect(status.azurePat.status).toBe("configured");
    expect(status.azurePat.maskedPreview).toBe("••••9999");
    expect(status.llm.maskedPreview).toBe("••••7777");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("pat-secret");
    expect(serialized).not.toContain("sk-abc");
  });
});
