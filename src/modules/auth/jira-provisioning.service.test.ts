import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`,
  nowIso: () => "2026-08-13T10:00:00.000Z",
  sqlGet: mocks.sqlGet,
  sqlRun: mocks.sqlRun,
  withTransaction: mocks.withTransaction,
}));

import { provisionJiraLogin } from "./jira-provisioning.service";

describe("Jira login provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ATLASSIAN_ALLOWED_CLOUD_IDS", "cloud-a");
    mocks.withTransaction.mockImplementation(async (fn) => fn({ query: vi.fn() }));
    mocks.sqlRun.mockResolvedValue(1);
  });

  it("creates an allowlisted Jira workspace, external identity, owner membership, and returns ids", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws_fixed" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "user_fixed" })
      .mockResolvedValueOnce({ role: "owner" });

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "jamie@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_fixed", userId: "user_fixed", role: "owner" });

    expect(mocks.sqlGet.mock.calls[0][0]).toContain("INSERT INTO workspaces");
    expect(mocks.sqlGet.mock.calls[0][1]).toMatchObject({ providerId: "jira-cloud", siteId: "cloud-a" });
    expect(mocks.sqlRun.mock.calls.some(([sql]) => sql.includes("INSERT INTO external_identities"))).toBe(true);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "owner")).toBe(true);
  });

  it("reuses an existing identity and joins an existing workspace as member without email relinking", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "ws_existing" })
      .mockResolvedValueOnce({ user_id: "user_existing" })
      .mockResolvedValueOnce({ role: "admin" });

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "changed@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_existing", userId: "user_existing", role: "admin" });

    expect(mocks.sqlGet.mock.calls.some(([sql]) => sql.includes("email_or_unique_name"))).toBe(false);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "member")).toBe(true);
  });

  it("links a mixed-case existing email through the case-insensitive identity invariant", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws_fixed" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "user_mixed_case" })
      .mockResolvedValueOnce({ role: "owner" });

    await provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-2", displayName: "Jamie", emailAddress: "Jamie@Example.com" },
    });
    const emailLookup = mocks.sqlGet.mock.calls.find(([sql]) => sql.includes("LOWER(email_or_unique_name)"));
    expect(emailLookup?.[1]).toMatchObject({ email: "jamie@example.com" });
  });
});
