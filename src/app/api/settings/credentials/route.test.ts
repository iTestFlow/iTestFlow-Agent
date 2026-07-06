import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const resolveActiveWorkspaceForUser = vi.fn();
const authenticate = vi.fn();
const getStoredUserIdentity = vi.fn();
const authenticatedIdentityMatchesStoredUser = vi.fn();
const getUserCredentialStatus = vi.fn();
const resolveUserLlmConfig = vi.fn();
const saveUserLlmSettings = vi.fn();
const storeUserAzurePat = vi.fn();
const storeUserLlmApiKey = vi.fn();
const updateUserLlmModel = vi.fn();
const checkRateLimit = vi.fn();

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-07-06T12:00:00.000Z",
}));

vi.mock("@/modules/auth/session.service", () => ({
  requireSession: (...args: unknown[]) => requireSession(...args),
  SessionError: class SessionError extends Error {},
}));

vi.mock("@/modules/auth/user.service", () => ({
  getStoredUserIdentity: (...args: unknown[]) => getStoredUserIdentity(...args),
  authenticatedIdentityMatchesStoredUser: (...args: unknown[]) => authenticatedIdentityMatchesStoredUser(...args),
}));

vi.mock("@/modules/workspace/workspace.service", () => ({
  resolveActiveWorkspaceForUser: (...args: unknown[]) => resolveActiveWorkspaceForUser(...args),
}));

vi.mock("@/modules/auth/pat-auth-provider", () => ({
  PatAuthProvider: class {
    authenticate(...args: unknown[]) {
      return authenticate(...args);
    }
  },
}));

vi.mock("@/modules/credentials/credential.service", () => ({
  getUserCredentialStatus: (...args: unknown[]) => getUserCredentialStatus(...args),
  resolveUserLlmConfig: (...args: unknown[]) => resolveUserLlmConfig(...args),
  saveUserLlmSettings: (...args: unknown[]) => saveUserLlmSettings(...args),
  storeUserAzurePat: (...args: unknown[]) => storeUserAzurePat(...args),
  storeUserLlmApiKey: (...args: unknown[]) => storeUserLlmApiKey(...args),
  updateUserLlmModel: (...args: unknown[]) => updateUserLlmModel(...args),
}));

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  clientIp: () => "1.2.3.4",
}));

import { GET, PATCH, PUT } from "./route";

// Status as the service reports it: masked previews + metadata, never raw secrets.
const maskedStatus = {
  azurePat: { status: "configured", maskedPreview: "****abcd", lastValidatedAt: "2026-07-01T00:00:00.000Z", isStale: false },
  llm: {
    status: "configured",
    maskedPreview: "sk-****wxyz",
    provider: "openai",
    model: "gpt-4.1",
    lastValidatedAt: "2026-07-01T00:00:00.000Z",
    isStale: false,
  },
};

function jsonRequest(method: "PUT" | "PATCH", body: unknown) {
  return new Request("http://localhost/api/settings/credentials", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const mock of [
    requireSession,
    resolveActiveWorkspaceForUser,
    authenticate,
    getStoredUserIdentity,
    authenticatedIdentityMatchesStoredUser,
    getUserCredentialStatus,
    resolveUserLlmConfig,
    saveUserLlmSettings,
    storeUserAzurePat,
    storeUserLlmApiKey,
    updateUserLlmModel,
    checkRateLimit,
  ]) {
    mock.mockReset();
  }
  checkRateLimit.mockResolvedValue({ allowed: true });
  requireSession.mockResolvedValue({ userId: "user_1", activeWorkspaceId: null });
  resolveActiveWorkspaceForUser.mockResolvedValue({ id: "ws_1", azureOrgUrl: "https://dev.azure.com/org-a" });
  getUserCredentialStatus.mockResolvedValue(maskedStatus);
  authenticate.mockResolvedValue({ azureIdentityId: "azure-id-1", emailOrUniqueName: "me@example.com" });
  getStoredUserIdentity.mockResolvedValue({ id: "user_1", azureIdentityId: "azure-id-1", emailOrUniqueName: "me@example.com" });
  authenticatedIdentityMatchesStoredUser.mockReturnValue(true);
});

describe("PUT /api/settings/credentials", () => {
  it("rejects a PAT belonging to a different Azure account with 403 and never stores it", async () => {
    authenticatedIdentityMatchesStoredUser.mockReturnValue(false);

    const response = await PUT(jsonRequest("PUT", { azurePat: "someone-elses-pat" }));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("different Azure DevOps account");
    expect(storeUserAzurePat).not.toHaveBeenCalled();
  });

  it("rejects with 403 when no stored identity exists for the user, without storing", async () => {
    getStoredUserIdentity.mockResolvedValue(null);

    const response = await PUT(jsonRequest("PUT", { azurePat: "valid-pat" }));

    expect(response.status).toBe(403);
    // Short-circuits on the missing identity: no comparison is possible.
    expect(authenticatedIdentityMatchesStoredUser).not.toHaveBeenCalled();
    expect(storeUserAzurePat).not.toHaveBeenCalled();
  });

  it("maps PAT validation failure to 422 (not 401) without identity lookup or store", async () => {
    authenticate.mockRejectedValue(new Error("Azure DevOps rejected the Personal Access Token, or the organization URL is incorrect."));

    const response = await PUT(jsonRequest("PUT", { azurePat: "bad-pat" }));

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("rejected the Personal Access Token");
    expect(getStoredUserIdentity).not.toHaveBeenCalled();
    expect(storeUserAzurePat).not.toHaveBeenCalled();
  });

  it("stores the PAT for the session user when the authenticated identity matches", async () => {
    const response = await PUT(jsonRequest("PUT", { azurePat: "matching-pat" }));

    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledWith({
      organizationUrl: "https://dev.azure.com/org-a",
      personalAccessToken: "matching-pat",
    });
    expect(storeUserAzurePat).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      pat: "matching-pat",
      status: "configured",
      lastValidatedAt: "2026-07-06T12:00:00.000Z",
    });
  });

  it("skips the PAT path entirely for an LLM-only body", async () => {
    const response = await PUT(
      jsonRequest("PUT", {
        llm: { provider: "openai", model: "gpt-4.1", apiKey: "sk-new", baseUrl: "https://proxy.example.com" },
      }),
    );

    expect(response.status).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect(getStoredUserIdentity).not.toHaveBeenCalled();
    expect(storeUserAzurePat).not.toHaveBeenCalled();
    expect(storeUserLlmApiKey).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      provider: "openai",
      apiKey: "sk-new",
      lastValidatedAt: "2026-07-06T12:00:00.000Z",
    });
    expect(saveUserLlmSettings).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      provider: "openai",
      model: "gpt-4.1",
      baseUrl: "https://proxy.example.com",
      isDefault: true,
    });
  });

  it("rate-limits with 429 and Retry-After before touching the session or credentials", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 45 });

    const response = await PUT(jsonRequest("PUT", { azurePat: "any" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(requireSession).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(storeUserAzurePat).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/settings/credentials", () => {
  it("returns 400 when no LLM config is saved, without updating the model", async () => {
    resolveUserLlmConfig.mockResolvedValue(null);

    const response = await PATCH(jsonRequest("PATCH", { llm: { provider: "openai", model: "gpt-4.1-mini" } }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Save an API key");
    expect(updateUserLlmModel).not.toHaveBeenCalled();
  });

  it("returns 400 when the saved provider differs from the requested one", async () => {
    resolveUserLlmConfig.mockResolvedValue({ provider: "openai", model: "gpt-4.1", apiKey: "sk-saved", baseUrl: null });

    const response = await PATCH(jsonRequest("PATCH", { llm: { provider: "anthropic", model: "claude-sonnet-4-5" } }));

    expect(response.status).toBe(400);
    expect(updateUserLlmModel).not.toHaveBeenCalled();
  });

  it("updates the model for the saved provider", async () => {
    resolveUserLlmConfig.mockResolvedValue({ provider: "openai", model: "gpt-4.1", apiKey: "sk-saved", baseUrl: null });

    const response = await PATCH(jsonRequest("PATCH", { llm: { provider: "openai", model: "gpt-4.1-mini" } }));

    expect(response.status).toBe(200);
    expect(updateUserLlmModel).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      provider: "openai",
      model: "gpt-4.1-mini",
    });
  });

  it("rate-limits with 429 and Retry-After without reading or updating anything", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });

    const response = await PATCH(jsonRequest("PATCH", { llm: { provider: "openai", model: "gpt-4.1-mini" } }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(resolveUserLlmConfig).not.toHaveBeenCalled();
    expect(updateUserLlmModel).not.toHaveBeenCalled();
  });
});

describe("GET /api/settings/credentials", () => {
  it("returns only masked status fields with Cache-Control no-store", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json();
    expect(body).toEqual({
      workspaceId: "ws_1",
      azureOrgUrl: "https://dev.azure.com/org-a",
      ...maskedStatus,
    });
    // Masked previews only — nothing secret-shaped may pass through.
    expect(JSON.stringify(body)).not.toMatch(/apiKey|personalAccessToken|encrypted|cipher|"pat"/i);
  });
});
