import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createId, nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { describeDb } from "@/test/db";
import {
  getUserCredentialStatus,
  isCredentialStale,
  markUserAzurePatExpired,
  resolveUserAzurePat,
  resolveUserLlmConfig,
  saveUserLlmSettings,
  storeUserAzurePat,
  storeUserLlmApiKey,
} from "@/modules/credentials/credential.service";

const WS_URL = "https://dev.azure.com/cred-test-org";

describe("isCredentialStale (pure)", () => {
  const now = "2026-06-22T00:00:00.000Z";

  it("treats a missing timestamp as not stale", () => {
    expect(isCredentialStale(null, now, 60)).toBe(false);
    expect(isCredentialStale(undefined, now, 60)).toBe(false);
  });

  it("is false for a freshly validated credential", () => {
    expect(isCredentialStale("2026-06-21T00:00:00.000Z", now, 60)).toBe(false);
  });

  it("is false at the threshold and true beyond it", () => {
    expect(isCredentialStale("2026-04-23T00:00:00.000Z", now, 60)).toBe(false); // exactly 60 days
    expect(isCredentialStale("2026-04-13T00:00:00.000Z", now, 60)).toBe(true); // ~70 days
  });

  it("guards against unparseable input", () => {
    expect(isCredentialStale("not-a-date", now, 60)).toBe(false);
  });
});

// DB-backed integration coverage; requires migrated PostgreSQL via DATABASE_URL.

describeDb("credential service (DB-backed)", () => {
  const workspaceId = createId("ws");
  const userId = createId("user");
  const originalEncryptionKey = process.env.APP_ENCRYPTION_KEY;

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
    try {
      await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @u`, { u: WS_URL });
      await sqlRun(`DELETE FROM users WHERE id = @id`, { id: userId });
      await resetDatabaseForTests();
    } finally {
      if (originalEncryptionKey === undefined) {
        delete process.env.APP_ENCRYPTION_KEY;
      } else {
        process.env.APP_ENCRYPTION_KEY = originalEncryptionKey;
      }
    }
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

  it("flips the PAT to expired on use-time rejection, idempotently", async () => {
    await markUserAzurePatExpired(workspaceId, userId);
    await markUserAzurePatExpired(workspaceId, userId); // idempotent
    expect((await getUserCredentialStatus(workspaceId, userId)).azurePat.status).toBe("expired");
  });
});
