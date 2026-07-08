import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getWorkspaceById: vi.fn(),
  resolveActiveWorkspaceForUser: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  resolveUserAzurePat: vi.fn(),
  resolveUserLlmConfig: vi.fn(),
  markUserAzurePatExpired: vi.fn(),
  createLLMProvider: vi.fn(),
  createIntegrationProvider: vi.fn(),
  resolveWorkspaceProviderId: vi.fn(),
}));

// Keep the real SessionError class so authErrorResponse's `instanceof
// SessionError` check is exercised against the class routes actually throw.
vi.mock("@/modules/auth/session.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/session.service")>();
  return {
    ...actual,
    requireSession: mocks.requireSession,
  };
});
vi.mock("@/modules/workspace/workspace.service", () => ({
  getWorkspaceById: mocks.getWorkspaceById,
  resolveActiveWorkspaceForUser: mocks.resolveActiveWorkspaceForUser,
}));
vi.mock("@/modules/workspace/workspace-access.service", () => ({
  getWorkspaceMembership: mocks.getWorkspaceMembership,
}));
vi.mock("@/modules/workspace/workspace-settings.service", () => ({
  getWorkspaceSettings: mocks.getWorkspaceSettings,
}));
vi.mock("@/modules/credentials/credential.service", () => ({
  resolveUserAzurePat: mocks.resolveUserAzurePat,
  resolveUserLlmConfig: mocks.resolveUserLlmConfig,
  markUserAzurePatExpired: mocks.markUserAzurePatExpired,
}));
vi.mock("@/modules/llm/llm-provider.factory", () => ({
  createLLMProvider: mocks.createLLMProvider,
}));
vi.mock("@/modules/integrations/provider-registry", () => ({
  createIntegrationProvider: mocks.createIntegrationProvider,
  resolveWorkspaceProviderId: mocks.resolveWorkspaceProviderId,
}));

import { SessionError } from "@/modules/auth/session.service";
import { DEFAULT_RETRY_ATTEMPTS } from "@/modules/llm/llm-defaults";
import { fakeLlmProvider, projectScope } from "@/test/factories";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserAzureAdapterOrgLevel,
  getUserLLMProvider,
  requireWorkflowContext,
  requireWorkflowRole,
  WorkflowAuthError,
  type WorkflowContext,
} from "./scoped-resolution.service";

const workspace = {
  id: "ws-1",
  name: "Acme",
  azureOrgName: "acme",
  azureOrgUrl: "https://dev.azure.com/acme",
  providerId: "azure-devops",
};
const ctx: WorkflowContext = { userId: "user-1", workspace };

async function captureAuthError(work: Promise<unknown>): Promise<WorkflowAuthError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowAuthError);
    return error as WorkflowAuthError;
  }
  throw new Error("expected a WorkflowAuthError rejection");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    sessionId: "sess-1",
    userId: "user-1",
    activeWorkspaceId: "ws-active",
  });
  mocks.getWorkspaceById.mockResolvedValue(workspace);
  mocks.resolveActiveWorkspaceForUser.mockResolvedValue({ ...workspace, role: "member" });
  mocks.getWorkspaceMembership.mockResolvedValue({
    id: "wm-1",
    workspaceId: workspace.id,
    userId: "user-1",
    role: "member",
    status: "active",
  });
  mocks.getWorkspaceSettings.mockResolvedValue(null);
  mocks.resolveUserAzurePat.mockResolvedValue("pat-secret");
  mocks.resolveUserLlmConfig.mockResolvedValue({
    provider: "openai",
    model: "gpt-test",
    apiKey: "sk-secret",
    baseUrl: "https://llm.example",
  });
  mocks.markUserAzurePatExpired.mockResolvedValue(undefined);
  mocks.createLLMProvider.mockReturnValue(fakeLlmProvider());
  mocks.createIntegrationProvider.mockReturnValue({ __provider: "azure" });
  mocks.resolveWorkspaceProviderId.mockImplementation((workspaceArg) => workspaceArg.providerId);
});

describe("requireWorkflowContext", () => {
  it("uses the explicit workspace when supplied, never the primary fallback", async () => {
    const result = await requireWorkflowContext("ws-1");
    expect(result).toEqual({ userId: "user-1", workspace });
    expect(mocks.getWorkspaceById).toHaveBeenCalledWith("ws-1");
    expect(mocks.resolveActiveWorkspaceForUser).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith("user-1", "ws-1");
  });

  it("rejects an explicit unknown workspaceId with 404 before any membership check", async () => {
    mocks.getWorkspaceById.mockResolvedValue(null);
    const error = await captureAuthError(requireWorkflowContext("ws-missing"));
    expect(error.status).toBe(404);
    expect(error.message).toBe("Workspace not found.");
    expect(mocks.getWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("falls back to the session's active workspace when no id is supplied", async () => {
    const result = await requireWorkflowContext();
    expect(result.workspace).toMatchObject(workspace);
    expect(mocks.resolveActiveWorkspaceForUser).toHaveBeenCalledWith("user-1", "ws-active");
    expect(mocks.getWorkspaceById).not.toHaveBeenCalled();
  });

  it("rejects with 403 when no primary workspace resolves for the user", async () => {
    mocks.resolveActiveWorkspaceForUser.mockResolvedValue(null);
    const error = await captureAuthError(requireWorkflowContext(null));
    expect(error.status).toBe(403);
    expect(error.message).toBe("No workspace membership found for this user.");
  });

  it("rejects with 403 when the workspace exists but the user is not a member", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue(null);
    const error = await captureAuthError(requireWorkflowContext("ws-1"));
    expect(error.status).toBe(403);
    expect(error.message).toBe("You do not have access to this workspace.");
  });
});

describe("requireWorkflowRole", () => {
  it("allows a membership role included in the allowed list", async () => {
    await expect(requireWorkflowRole(ctx, ["owner", "member"])).resolves.toBeUndefined();
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith("user-1", "ws-1");
  });

  it("rejects a role outside the allowed list with 403 and the default message", async () => {
    const error = await captureAuthError(requireWorkflowRole(ctx, ["owner", "admin"]));
    expect(error.status).toBe(403);
    expect(error.message).toBe("Your workspace role is not permitted to perform this action.");
  });

  it("rejects a missing membership with 403 and the caller-supplied message", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue(null);
    const error = await captureAuthError(requireWorkflowRole(ctx, ["owner"], "Owners only."));
    expect(error.status).toBe(403);
    expect(error.message).toBe("Owners only.");
  });
});

describe("Azure adapter resolution", () => {
  const patMessage =
    "Add your Azure DevOps Personal Access Token in Settings → My Credentials before running this action.";

  it("rejects with 400 when the user has no stored PAT", async () => {
    mocks.resolveUserAzurePat.mockResolvedValue(null);
    const error = await captureAuthError(getUserAzureAdapter(ctx, projectScope()));
    expect(error.status).toBe(400);
    expect(error.message).toBe(patMessage);
    expect(mocks.resolveUserAzurePat).toHaveBeenCalledWith("ws-1", "user-1");
    expect(mocks.createIntegrationProvider).not.toHaveBeenCalled();
  });

  it("rejects the org-level adapter with the same 400 when the PAT is missing", async () => {
    mocks.resolveUserAzurePat.mockResolvedValue(null);
    const error = await captureAuthError(getUserAzureAdapterOrgLevel(ctx));
    expect(error.status).toBe(400);
    expect(error.message).toBe(patMessage);
  });

  it("builds the adapter from the workspace org URL and the server-resolved project scope", async () => {
    await getUserAzureAdapter(ctx, projectScope());
    expect(mocks.resolveWorkspaceProviderId).toHaveBeenCalledWith(workspace);
    expect(mocks.createIntegrationProvider).toHaveBeenCalledWith({
      providerId: "azure-devops",
      settings: { organizationUrl: "https://dev.azure.com/acme", personalAccessToken: "pat-secret" },
      projectScope: { azureProjectId: "azure-project-1", azureProjectName: "Demo Project" },
      hooks: { onUnauthorized: expect.any(Function) },
    });
  });

  it("builds the org-level adapter without a project binding", async () => {
    await getUserAzureAdapterOrgLevel(ctx);
    expect(mocks.createIntegrationProvider).toHaveBeenCalledWith({
      providerId: "azure-devops",
      settings: { organizationUrl: "https://dev.azure.com/acme", personalAccessToken: "pat-secret" },
      projectScope: undefined,
      hooks: { onUnauthorized: expect.any(Function) },
    });
  });

  it("expires the PAT on the unauthorized hook without failing the in-flight request", async () => {
    mocks.markUserAzurePatExpired.mockRejectedValue(new Error("db down"));
    await getUserAzureAdapterOrgLevel(ctx);
    const [{ hooks }] = mocks.createIntegrationProvider.mock.calls[0] as [
      { hooks: { onUnauthorized: () => void } },
    ];
    // Fire-and-forget: the hook returns synchronously and swallows the failure.
    expect(() => hooks.onUnauthorized()).not.toThrow();
    await Promise.resolve();
    expect(mocks.markUserAzurePatExpired).toHaveBeenCalledWith("ws-1", "user-1");
  });
});

describe("getUserLLMProvider", () => {
  it("rejects with 400 when the user has no LLM configuration", async () => {
    mocks.resolveUserLlmConfig.mockResolvedValue(null);
    const error = await captureAuthError(getUserLLMProvider(ctx));
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      "Add your LLM provider and API key in Settings → My Credentials before running this action.",
    );
    expect(mocks.createLLMProvider).not.toHaveBeenCalled();
  });

  it("builds the provider from the user's credentials and workspace-level caps", async () => {
    mocks.getWorkspaceSettings.mockResolvedValue({ maxOutputTokenCap: 64000, llmRetryAttempts: 3 });
    const provider = fakeLlmProvider();
    mocks.createLLMProvider.mockReturnValue(provider);

    await expect(getUserLLMProvider(ctx)).resolves.toBe(provider);
    expect(mocks.getWorkspaceSettings).toHaveBeenCalledWith("ws-1");
    expect(mocks.createLLMProvider).toHaveBeenCalledWith({
      provider: "openai",
      apiKey: "sk-secret",
      model: "gpt-test",
      baseUrl: "https://llm.example",
      maxOutputTokenCap: 64000,
      retryAttempts: 3,
    });
  });

  it("falls back to deployment defaults when the workspace has no settings row", async () => {
    vi.stubEnv("LLM_MAX_OUTPUT_TOKEN_CAP", "16000");
    await getUserLLMProvider(ctx);
    expect(mocks.createLLMProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokenCap: 16000,
        retryAttempts: DEFAULT_RETRY_ATTEMPTS,
      }),
    );
  });
});

describe("authErrorResponse", () => {
  it("maps a SessionError to 401 with the sanitized body", async () => {
    const response = authErrorResponse(new SessionError("Authentication required."));
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "Authentication required." });
  });

  it("maps a WorkflowAuthError to its own status", async () => {
    const response = authErrorResponse(new WorkflowAuthError("Workspace not found.", 404));
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: "Workspace not found." });
  });

  it("returns null for anything else so routes fall through to normal handling", () => {
    expect(authErrorResponse(new Error("boom"))).toBeNull();
    expect(authErrorResponse("boom")).toBeNull();
  });
});
