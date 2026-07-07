import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceAccessError } from "@/modules/workspace/workspace-access.service";

const resolveWorkspaceRequest = vi.fn();
const authenticate = vi.fn();
const storeWorkspaceSyncPat = vi.fn();
const checkRateLimit = vi.fn();

// workspaceRequestError stays real so the 403/401 mapping asserted below is the
// guard's, not a mock's.
vi.mock("@/modules/workspace/workspace-request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/workspace/workspace-request")>()),
  resolveWorkspaceRequest: (...args: unknown[]) => resolveWorkspaceRequest(...args),
}));

vi.mock("@/modules/auth/pat-auth-provider", () => ({
  PatAuthProvider: class {
    authenticate(...args: unknown[]) {
      return authenticate(...args);
    }
  },
}));

vi.mock("@/modules/credentials/credential.service", () => ({
  storeWorkspaceSyncPat: (...args: unknown[]) => storeWorkspaceSyncPat(...args),
}));

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  clientIp: () => "1.2.3.4",
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-07-06T00:00:00.000Z",
}));

import { POST } from "./route";

const context = {
  userId: "user-1",
  workspace: {
    id: "ws-1",
    name: "Org A",
    azureOrgName: "server-org",
    azureOrgUrl: "https://dev.azure.com/server-org",
  },
};

function request(body: unknown) {
  return new Request("http://localhost/api/workspace/sync-credential", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/workspace/sync-credential", () => {
  beforeEach(() => {
    resolveWorkspaceRequest.mockReset().mockResolvedValue(context);
    authenticate.mockReset().mockResolvedValue({ displayName: "Sync Bot" });
    storeWorkspaceSyncPat.mockReset().mockResolvedValue(undefined);
    checkRateLimit.mockReset().mockResolvedValue({ allowed: true });
  });

  it("stores the PAT under the server-resolved workspace and caller, ignoring client-supplied org", async () => {
    // Client-supplied workspace/org fields must never override the resolved context.
    const response = await POST(
      request({
        personalAccessToken: "pat-secret",
        workspaceId: "ws-evil",
        organizationUrl: "https://dev.azure.com/evil-org",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, workspaceId: "ws-1" });

    // Role guard requires owner/admin.
    expect(resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
    // Validated against the workspace's own Azure org.
    expect(authenticate).toHaveBeenCalledWith({
      organizationUrl: "https://dev.azure.com/server-org",
      personalAccessToken: "pat-secret",
    });
    expect(storeWorkspaceSyncPat).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pat: "pat-secret",
      createdByUserId: "user-1",
      lastValidatedAt: "2026-07-06T00:00:00.000Z",
    });
    // Validate-before-store ordering.
    expect(authenticate.mock.invocationCallOrder[0]).toBeLessThan(
      storeWorkspaceSyncPat.mock.invocationCallOrder[0],
    );
  });

  it("returns 422 and does not store when PAT validation fails", async () => {
    authenticate.mockRejectedValueOnce(new Error("Azure DevOps rejected the Personal Access Token."));

    const response = await POST(request({ personalAccessToken: "bad-pat" }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("Azure DevOps authentication failed. Check that your Personal Access Token is valid and has not expired, then try again.");
    expect(body.technicalDetails).toContain("Azure DevOps rejected the Personal Access Token.");
    expect(storeWorkspaceSyncPat).not.toHaveBeenCalled();
  });

  it("rate-limits with 429 and Retry-After before touching auth", async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 45 });

    const response = await POST(request({ personalAccessToken: "pat-secret" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(resolveWorkspaceRequest).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(storeWorkspaceSyncPat).not.toHaveBeenCalled();
  });

  it.each([
    ["empty token", { personalAccessToken: "   " }, "Enter a Personal Access Token."],
    ["missing token", {}, "Required"],
  ])("returns 400 for %s without validating or storing", async (_name, body, message) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(message);
    expect(authenticate).not.toHaveBeenCalled();
    expect(storeWorkspaceSyncPat).not.toHaveBeenCalled();
  });

  it("returns the guard's 403 for a non-admin member and never validates or stores", async () => {
    resolveWorkspaceRequest.mockRejectedValueOnce(
      new WorkspaceAccessError("This action requires an elevated workspace role."),
    );

    const response = await POST(request({ personalAccessToken: "pat-secret" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("This action requires an elevated workspace role.");
    expect(authenticate).not.toHaveBeenCalled();
    expect(storeWorkspaceSyncPat).not.toHaveBeenCalled();
  });
});
