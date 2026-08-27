import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlAll: vi.fn(),
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`,
  nowIso: () => "2026-08-13T10:00:00.000Z",
  sqlAll: mocks.sqlAll,
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
    mocks.sqlAll.mockResolvedValue([]);
    mocks.sqlRun.mockResolvedValue(1);
  });

  it("creates an allowlisted Jira workspace, external identity, owner membership, and returns ids", async () => {
    mocks.sqlAll.mockResolvedValueOnce([]); // no existing target or URL occupant
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws_fixed" }) // workspace insert
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce(undefined) // user by email
      .mockResolvedValueOnce({ id: "user_fixed" }) // user insert
      .mockResolvedValueOnce({ role: "owner" }); // membership

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "jamie@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_fixed", userId: "user_fixed", role: "owner" });

    expect(mocks.sqlAll.mock.calls[0][0]).toContain("ORDER BY id");
    expect(mocks.sqlAll.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("INSERT INTO workspaces");
    expect(mocks.sqlGet.mock.calls[0][1]).toMatchObject({ providerId: "jira-cloud", siteId: "cloud-a" });
    // Two partial unique indexes can now arbitrate this insert; the conflict
    // clause must stay bare so either one resolves to a no-op instead of an error.
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("ON CONFLICT DO NOTHING");
    expect(mocks.sqlGet.mock.calls[0][0]).not.toContain("ON CONFLICT (provider_id, provider_site_id)");
    expect(mocks.sqlRun.mock.calls.some(([sql]) => sql.includes("INSERT INTO external_identities"))).toBe(true);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "owner")).toBe(true);
  });

  it("adopts a bootstrap-seeded workspace and joins the first OAuth user as member", async () => {
    mocks.sqlAll.mockResolvedValueOnce([{
      id: "ws_seeded",
      provider_site_id: null,
      provider_site_url: "https://quality.atlassian.net",
      status: "active",
    }]);
    mocks.sqlGet
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce(undefined) // user by email
      .mockResolvedValueOnce({ id: "user_fixed" }) // user insert
      .mockResolvedValueOnce({ role: "member" }); // membership

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-9", displayName: "First Visitor", emailAddress: "visitor@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_seeded", userId: "user_fixed", role: "member" });

    // Adoption claims the seeded row (site id/name filled) instead of inserting a duplicate.
    const adoption = mocks.sqlRun.mock.calls.find(([sql]) => sql.includes("SET provider_site_id = @siteId"));
    expect(adoption?.[1]).toMatchObject({
      workspaceId: "ws_seeded",
      siteId: "cloud-a",
      siteUrl: "https://quality.atlassian.net",
    });
    expect(mocks.sqlGet.mock.calls.some(([sql]) => sql.includes("INSERT INTO workspaces"))).toBe(false);
    // The adopted workspace already carries the seeded owner; the OAuth user only joins.
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "member")).toBe(true);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "owner")).toBe(false);
  });

  it("normalizes the Atlassian resource URL before matching and storing", async () => {
    mocks.sqlAll.mockResolvedValueOnce([]);
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws_fixed" }) // insert
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce(undefined) // user by email
      .mockResolvedValueOnce({ id: "user_fixed" }) // user insert
      .mockResolvedValueOnce({ role: "owner" }); // membership

    await provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://Quality.Atlassian.Net/", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "jamie@example.com" },
    });

    expect(mocks.sqlAll.mock.calls[0][1]).toMatchObject({ siteUrl: "https://quality.atlassian.net" });
    expect(mocks.sqlGet.mock.calls[0][1]).toMatchObject({ siteUrl: "https://quality.atlassian.net" });
  });

  it("reuses an existing identity and joins an existing workspace as member without email relinking", async () => {
    mocks.sqlAll.mockResolvedValueOnce([{
      id: "ws_existing",
      provider_site_id: "cloud-a",
      provider_site_url: "https://quality.atlassian.net",
      status: "active",
    }]);
    mocks.sqlGet
      .mockResolvedValueOnce({ user_id: "user_existing" }) // external identity
      .mockResolvedValueOnce({ role: "admin" }); // membership

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-1", displayName: "Jamie Jira", emailAddress: "changed@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_existing", userId: "user_existing", role: "admin" });

    expect(mocks.sqlGet.mock.calls.some(([sql]) => sql.includes("email_or_unique_name"))).toBe(false);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "member")).toBe(true);
  });

  it("re-claims a seeded workspace committed between the first claim and the lost insert", async () => {
    mocks.sqlAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "ws_seeded_late",
        provider_site_id: null,
        provider_site_url: "https://quality.atlassian.net",
        status: "active",
      }]);
    mocks.sqlGet
      .mockResolvedValueOnce(undefined) // insert loses to the freshly committed seeded row
      .mockResolvedValueOnce(undefined) // external identity
      .mockResolvedValueOnce(undefined) // user by email
      .mockResolvedValueOnce({ id: "user_fixed" }) // user insert
      .mockResolvedValueOnce({ role: "member" }); // membership

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      identity: { accountId: "account-3", displayName: "Racing Login", emailAddress: "race@example.com" },
    })).resolves.toEqual({ workspaceId: "ws_seeded_late", userId: "user_fixed", role: "member" });

    expect(mocks.sqlAll).toHaveBeenCalledTimes(2);
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => (
      sql.includes("SET provider_site_id = @siteId") && params.workspaceId === "ws_seeded_late"
    ))).toBe(true);
    expect(mocks.sqlGet.mock.calls.some(([sql, params]) => sql.includes("INSERT INTO workspace_members") && params.role === "owner")).toBe(false);
  });

  it("links a mixed-case existing email through the case-insensitive identity invariant", async () => {
    mocks.sqlAll.mockResolvedValueOnce([]);
    mocks.sqlGet
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

  it("re-points the sole placeholder owner before retiring it and refreshing the target URL", async () => {
    mocks.sqlAll
      .mockResolvedValueOnce([
        {
          id: "ws-placeholder",
          provider_site_id: null,
          provider_site_url: "https://new-name.atlassian.net",
          status: "active",
        },
        {
          id: "ws-target",
          provider_site_id: "cloud-a",
          provider_site_url: "https://old-name.atlassian.net",
          status: "active",
        },
      ])
      .mockResolvedValueOnce([{
        id: "wm-placeholder-owner",
        user_id: "user-owner",
        role: "owner",
        status: "active",
      }]);
    mocks.sqlGet
      .mockResolvedValueOnce(undefined) // owner has no membership in target
      .mockResolvedValueOnce(undefined) // no external identity yet
      .mockResolvedValueOnce({ id: "user-owner" }) // link by email
      .mockResolvedValueOnce({ role: "owner" }); // membership retains moved owner role

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "New Name", url: "https://new-name.atlassian.net", scopes: [] },
      identity: { accountId: "account-owner", displayName: "Owner", emailAddress: "owner@example.com" },
    })).resolves.toEqual({ workspaceId: "ws-target", userId: "user-owner", role: "owner" });

    const statements = mocks.sqlRun.mock.calls.map(([sql]) => String(sql));
    const repoint = statements.findIndex((sql) => sql.includes("SET workspace_id = @targetId"));
    const retire = statements.findIndex((sql) => sql.includes("provider_site_url = NULL"));
    const refresh = statements.findIndex((sql) => sql.includes("provider_site_url = @siteUrl"));
    expect(repoint).toBeGreaterThanOrEqual(0);
    expect(retire).toBeGreaterThan(repoint);
    expect(refresh).toBeGreaterThan(retire);
    expect(mocks.sqlGet.mock.calls.at(-1)?.[1]).toMatchObject({ role: "member" });
  });

  it("upgrades an existing target membership instead of merging role precedence", async () => {
    mocks.sqlAll
      .mockResolvedValueOnce([
        {
          id: "ws-placeholder",
          provider_site_id: null,
          provider_site_url: "https://new-name.atlassian.net",
          status: "active",
        },
        {
          id: "ws-target",
          provider_site_id: "cloud-a",
          provider_site_url: "https://old-name.atlassian.net",
          status: "active",
        },
      ])
      .mockResolvedValueOnce([{
        id: "wm-placeholder-owner",
        user_id: "user-owner",
        role: "owner",
        status: "active",
      }]);
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "wm-target-member" })
      .mockResolvedValueOnce({ user_id: "user-owner" })
      .mockResolvedValueOnce({ role: "owner" });

    await provisionJiraLogin({
      resource: { id: "cloud-a", name: "New Name", url: "https://new-name.atlassian.net", scopes: [] },
      identity: { accountId: "account-owner", displayName: "Owner", emailAddress: "owner@example.com" },
    });

    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => (
      sql.includes("SET role = 'owner', status = 'active'") && params.membershipId === "wm-target-member"
    ))).toBe(true);
    expect(mocks.sqlRun.mock.calls.some(([sql, params]) => (
      sql.includes("SET status = 'inactive'") && params.membershipId === "wm-placeholder-owner"
    ))).toBe(true);
    expect(mocks.sqlRun.mock.calls.some(([sql]) => sql.includes("SET workspace_id = @targetId"))).toBe(false);
  });

  it("rolls back on a placeholder with any additional active membership", async () => {
    mocks.sqlAll
      .mockResolvedValueOnce([
        {
          id: "ws-placeholder",
          provider_site_id: null,
          provider_site_url: "https://new-name.atlassian.net",
          status: "active",
        },
        {
          id: "ws-target",
          provider_site_id: "cloud-a",
          provider_site_url: "https://old-name.atlassian.net",
          status: "active",
        },
      ])
      .mockResolvedValueOnce([
        { id: "wm-owner", user_id: "owner", role: "owner", status: "active" },
        { id: "wm-extra", user_id: "extra", role: "member", status: "active" },
      ]);

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "New Name", url: "https://new-name.atlassian.net", scopes: [] },
      identity: { accountId: "account", displayName: "User", emailAddress: "user@example.com" },
    })).rejects.toThrow("placeholder");
    expect(mocks.sqlGet).not.toHaveBeenCalled();
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("never merges a different cloud-ID-backed workspace occupying the new URL", async () => {
    mocks.sqlAll.mockResolvedValueOnce([
      {
        id: "ws-target",
        provider_site_id: "cloud-a",
        provider_site_url: "https://old-name.atlassian.net",
        status: "active",
      },
      {
        id: "ws-other-cloud",
        provider_site_id: "cloud-b",
        provider_site_url: "https://new-name.atlassian.net",
        status: "active",
      },
    ]);

    await expect(provisionJiraLogin({
      resource: { id: "cloud-a", name: "New Name", url: "https://new-name.atlassian.net", scopes: [] },
      identity: { accountId: "account", displayName: "User", emailAddress: "user@example.com" },
    })).rejects.toThrow("collision");
    expect(mocks.sqlGet).not.toHaveBeenCalled();
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });
});
