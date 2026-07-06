import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  patConstructed: vi.fn(),
  authenticate: vi.fn(),
  findWorkspaceByAzureOrgUrl: vi.fn(),
  provisionUserFromIdentity: vi.fn(),
  ensureWorkspaceMembership: vi.fn(),
  storeUserAzurePat: vi.fn(),
  createSession: vi.fn(),
  writeAuditLog: vi.fn(),
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: () => "1.2.3.4",
}));
vi.mock("@/modules/auth/pat-auth-provider", () => ({
  PatAuthProvider: class {
    readonly id = "azure-pat";
    authenticate = mocks.authenticate;
    constructor() {
      mocks.patConstructed();
    }
  },
}));
vi.mock("@/modules/workspace/workspace.service", () => ({
  findWorkspaceByAzureOrgUrl: mocks.findWorkspaceByAzureOrgUrl,
}));
vi.mock("@/modules/auth/user.service", () => ({
  provisionUserFromIdentity: mocks.provisionUserFromIdentity,
  ensureWorkspaceMembership: mocks.ensureWorkspaceMembership,
}));
vi.mock("@/modules/credentials/credential.service", () => ({
  storeUserAzurePat: mocks.storeUserAzurePat,
}));
vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));
// Fixed nowIso pins the route's lastValidatedAt; sqlGet/sqlRun back the real
// createSession delegated to below without a database.
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-01-01T00:00:00.000Z",
  createId: (prefix: string) => `${prefix}_fixed`,
  sqlGet: mocks.sqlGet,
  sqlRun: mocks.sqlRun,
}));
// createSession is a spy (its position in the service call order is asserted)
// that delegates to the REAL implementation, so the session-cookie write below
// exercises real behavior instead of a fabricated mock.
vi.mock("@/modules/auth/session.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/session.service")>();
  return { ...actual, createSession: mocks.createSession };
});
// The request-scoped cookie store that Next.js merges onto the route's response.
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.cookieSet, get: () => undefined, delete: () => {} }),
}));

import { SESSION_COOKIE } from "@/modules/auth/session-cookie";
import { POST } from "./route";

const actualSessionService = await vi.importActual<typeof import("@/modules/auth/session.service")>(
  "@/modules/auth/session.service",
);

const workspace = {
  id: "ws_1",
  name: "Contoso",
  azureOrgName: "contoso",
  azureOrgUrl: "https://dev.azure.com/contoso",
};
const identity = {
  azureIdentityId: "azure-id-1",
  displayName: "Dana Dev",
  emailOrUniqueName: "dana@contoso.com",
};

function loginRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.findWorkspaceByAzureOrgUrl.mockResolvedValue(workspace);
    mocks.authenticate.mockResolvedValue(identity);
    mocks.provisionUserFromIdentity.mockResolvedValue("user_1");
    mocks.ensureWorkspaceMembership.mockResolvedValue(undefined);
    mocks.storeUserAzurePat.mockResolvedValue(undefined);
    mocks.sqlGet.mockResolvedValue(undefined);
    mocks.sqlRun.mockResolvedValue(1);
    mocks.createSession.mockImplementation(actualSessionService.createSession);
  });

  it("rate-limits with 429 and Retry-After before the body is parsed", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    // Even a malformed body must yield 429, not 400: the limiter runs first.
    const request = loginRequest("{not json");

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("login:1.2.3.4", 10, 5 * 60 * 1000);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.findWorkspaceByAzureOrgUrl).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 400 without a workspace lookup", async () => {
    const response = await POST(loginRequest("{not json"));

    expect(response.status).toBe(400);
    expect(mocks.findWorkspaceByAzureOrgUrl).not.toHaveBeenCalled();
    expect(mocks.patConstructed).not.toHaveBeenCalled();
  });

  it("rejects a blank organization with the schema's message", async () => {
    const response = await POST(loginRequest({ organization: "  ", personalAccessToken: "pat" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Select or enter your Azure DevOps organization." });
  });

  it("returns 403 for an org without a workspace and never touches the PAT provider", async () => {
    mocks.findWorkspaceByAzureOrgUrl.mockResolvedValue(null);

    const response = await POST(loginRequest({ organization: "unknown-org", personalAccessToken: "pat" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This Azure DevOps organization is not enabled for iTestFlow. Ask a workspace owner to enable it.",
    });
    expect(mocks.patConstructed).not.toHaveBeenCalled();
    expect(mocks.provisionUserFromIdentity).not.toHaveBeenCalled();
  });

  it("maps an authentication failure to 401 and stores nothing", async () => {
    mocks.authenticate.mockRejectedValue(
      new Error("Azure DevOps rejected the Personal Access Token, or the organization URL is incorrect."),
    );

    const response = await POST(loginRequest({ organization: "contoso", personalAccessToken: "bad-pat" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Azure DevOps rejected the Personal Access Token, or the organization URL is incorrect.",
    });
    expect(mocks.provisionUserFromIdentity).not.toHaveBeenCalled();
    expect(mocks.storeUserAzurePat).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("sanitizes a non-Error authentication throw into the generic 401 body", async () => {
    mocks.authenticate.mockRejectedValue("boom");

    const response = await POST(loginRequest({ organization: "contoso", personalAccessToken: "bad-pat" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Azure DevOps authentication failed." });
  });

  it("provisions, joins, stores the PAT, and creates the session in order, with audit and cookie", async () => {
    const response = await POST(
      loginRequest({ organization: "contoso", personalAccessToken: "pat-secret" }, { "user-agent": "vitest-agent" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, userId: "user_1", workspaceId: "ws_1" });

    // The bare org name is normalized to the full URL before authentication.
    expect(mocks.authenticate).toHaveBeenCalledWith({
      organizationUrl: "https://dev.azure.com/contoso",
      personalAccessToken: "pat-secret",
    });
    expect(mocks.provisionUserFromIdentity).toHaveBeenCalledWith(identity);
    expect(mocks.ensureWorkspaceMembership).toHaveBeenCalledWith("ws_1", "user_1", "member");
    expect(mocks.storeUserAzurePat).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      pat: "pat-secret",
      status: "configured",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(mocks.createSession).toHaveBeenCalledWith({
      userId: "user_1",
      workspaceId: "ws_1",
      userAgent: "vitest-agent",
    });

    // provision -> membership -> PAT storage -> session, strictly in that order.
    const order = [
      mocks.provisionUserFromIdentity,
      mocks.ensureWorkspaceMembership,
      mocks.storeUserAzurePat,
      mocks.createSession,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1", action: "USER_LOGIN", status: "Success", actor: "user_1" }),
    );

    // Only the opaque session cookie reaches the browser — never the PAT.
    expect(mocks.cookieSet).toHaveBeenCalledOnce();
    const [name, token, options] = mocks.cookieSet.mock.calls[0];
    expect(name).toBe(SESSION_COOKIE);
    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThan(20);
    expect(token).not.toContain("pat-secret");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("normalizes the organization input before the workspace lookup", async () => {
    mocks.findWorkspaceByAzureOrgUrl.mockResolvedValue(null);

    await POST(loginRequest({ organization: "contoso", personalAccessToken: "pat" }));
    expect(mocks.findWorkspaceByAzureOrgUrl).toHaveBeenLastCalledWith("https://dev.azure.com/contoso");

    await POST(loginRequest({ organization: "https://dev.azure.com/contoso///", personalAccessToken: "pat" }));
    expect(mocks.findWorkspaceByAzureOrgUrl).toHaveBeenLastCalledWith("https://dev.azure.com/contoso");
  });
});
