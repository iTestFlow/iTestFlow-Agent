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
      .mockResolvedValueOnce(undefined) // adopt claim: no seeded row
      .mockResolvedValueOnce({ id: "ws_fixed" }) // insert
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce(undefined) // user by email
      .mockResolvedValueOnce({ id: "user_fixed" }) // user insert
      .mockResolvedValueOnce({ role: "owner" }); // membership

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "jamie@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_fixed", userId: "user_fixed", role: "owner" });

    expect(mocks.sqlGet.mock.calls[0][0]).toContain("UPDATE workspaces");
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("provider_site_id IS NULL");
    expect(mocks.sqlGet.mock.calls[1][0]).toContain("INSERT INTO workspaces");
    expect(mocks.sqlGet.mock.calls[1][1]).toMatchObject({ providerId: "jira-cloud", siteId: "cloud-a" });
    // Two partial unique indexes can now arbitrate this insert; the conflict
    // clause must stay bare so either one resolves to a no-op instead of an error.
    expect(mocks.sqlGet.mock.calls[1][0]).toContain("ON CONFLICT DO NOTHING");
    expect(mocks.sqlGet.mock.calls[1][0]).not.toContain("ON CONFLICT (provider_id, provider_site_id)");
    expect(mocks.sqlRun.mock.calls.some(([sql]) => sql.includes("INSERT INTO external_identities"))).toBe(true);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "owner")).toBe(true);
  });

  it("adopts a bootstrap-seeded workspace and joins the first OAuth user as member", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws_seeded" }) // adopt claim wins
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce(undefined) // user by email
      .mockResolvedValueOnce({ id: "user_fixed" }) // user insert
      .mockResolvedValueOnce({ role: "member" }); // membership

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-9", displayName: "First Visitor", emailAddress: "visitor@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_seeded", userId: "user_fixed", role: "member" });

    // Adoption claims the seeded row (site id/name filled) instead of inserting a duplicate.
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("UPDATE workspaces");
    expect(mocks.sqlGet.mock.calls[0][1]).toMatchObject({ siteId: "cloud-a", siteUrl: "https://quality.atlassian.net" });
    expect(mocks.sqlGet.mock.calls.some(([sql]) => sql.includes("INSERT INTO workspaces"))).toBe(false);
    // The adopted workspace already carries the seeded owner; the OAuth user only joins.
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "member")).toBe(true);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "owner")).toBe(false);
  });

  it("normalizes the Atlassian resource URL before matching and storing", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(undefined) // adopt claim
      .mockResolvedValueOnce({ id: "ws_fixed" }) // insert
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce(undefined) // user by email
      .mockResolvedValueOnce({ id: "user_fixed" }) // user insert
      .mockResolvedValueOnce({ role: "owner" }); // membership

    await provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://Quality.Atlassian.Net/", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "jamie@example.com" },
    });

    expect(mocks.sqlGet.mock.calls[0][1]).toMatchObject({ siteUrl: "https://quality.atlassian.net" });
    expect(mocks.sqlGet.mock.calls[1][1]).toMatchObject({ siteUrl: "https://quality.atlassian.net" });
  });

  it("reuses an existing identity and joins an existing workspace as member without email relinking", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(undefined) // adopt claim
      .mockResolvedValueOnce(undefined) // insert no-op
      .mockResolvedValueOnce({ id: "ws_existing" }) // fallback select
      .mockResolvedValueOnce({ user_id: "user_existing" }) // external identity
      .mockResolvedValueOnce({ role: "admin" }); // membership

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "changed@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_existing", userId: "user_existing", role: "admin" });

    expect(mocks.sqlGet.mock.calls.some(([sql]) => sql.includes("email_or_unique_name"))).toBe(false);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "member")).toBe(true);
  });

  it("links a mixed-case existing email through the case-insensitive identity invariant", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(undefined) // adopt claim
      .mockResolvedValueOnce({ id: "ws_fixed" }) // insert
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce({ id: "user_mixed_case" }) // user by email
      .mockResolvedValueOnce({ role: "owner" }); // membership

    await provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-2", displayName: "Jamie", emailAddress: "Jamie@Example.com" },
    });
    const emailLookup = mocks.sqlGet.mock.calls.find(([sql]) => sql.includes("LOWER(email_or_unique_name)"));
    expect(emailLookup?.[1]).toMatchObject({ email: "jamie@example.com" });
  });
});
