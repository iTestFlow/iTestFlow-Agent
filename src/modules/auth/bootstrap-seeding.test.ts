import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn() }));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`,
  nowIso: () => "2026-08-25T00:00:00.000Z",
  sqlGet: mocks.sqlGet,
  sqlRun: mocks.sqlRun,
}));

import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";

/**
 * Mocked-SQL coverage of the seeding flow (the DB lane proves the real SQL in
 * jira-bootstrap.db.test.ts / multi-org.db.test.ts): entry ordering, the
 * adopt-before-insert rule for Jira sites, and the case-insensitive shared
 * owner-user resolution.
 */
describe("ensureBootstrapOwner (unit)", () => {
  const ENV_KEYS = [
    "BOOTSTRAP_OWNER_EMAIL",
    "BOOTSTRAP_OWNER_AZURE_ORG",
    "BOOTSTRAP_AZURE_ORGS",
    "BOOTSTRAP_OWNER_JIRA_SITE",
    "BOOTSTRAP_JIRA_SITES",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockReset();
    mocks.sqlRun.mockReset().mockResolvedValue(1);
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns null without touching the database when nothing is configured", async () => {
    await expect(ensureBootstrapOwner()).resolves.toBeNull();
    expect(mocks.sqlGet).not.toHaveBeenCalled();
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("seeds a new Jira site workspace, its owner user, and the owner membership", async () => {
    process.env.BOOTSTRAP_JIRA_SITES = "mysite|owner@x.com";
    mocks.sqlGet
      .mockResolvedValueOnce(undefined) // adopt lookup: site not present yet
      .mockResolvedValueOnce({ id: "ws_fixed" }) // re-select after insert
      .mockResolvedValueOnce(undefined) // owner user CI lookup
      .mockResolvedValueOnce({ id: "user_fixed" }) // re-select after insert
      .mockResolvedValueOnce({ workspace_id: "ws_fixed" }); // guarded membership upsert

    await expect(ensureBootstrapOwner()).resolves.toEqual({ workspaceId: "ws_fixed", userId: "user_fixed" });

    const workspaceInsert = mocks.sqlRun.mock.calls.find(([sql]) => sql.includes("INSERT INTO workspaces"));
    expect(workspaceInsert?.[0]).toContain("'jira-cloud'");
    // Two partial unique indexes may arbitrate this insert; the bare clause
    // must no-op on either.
    expect(workspaceInsert?.[0]).toContain("ON CONFLICT DO NOTHING");
    expect(workspaceInsert?.[1]).toMatchObject({ siteUrl: "https://mysite.atlassian.net", siteName: "mysite" });

    const userLookup = mocks.sqlGet.mock.calls[2][0];
    expect(userLookup).toContain("LOWER(email_or_unique_name)");

    const membership = mocks.sqlGet.mock.calls.find(([sql]) => sql.includes("INSERT INTO workspace_members"));
    expect(membership?.[0]).toContain("'owner'");
    expect(membership?.[0]).toContain("status = 'active'");
    expect(membership?.[0]).toContain("provider_site_url = @siteUrl");
    expect(membership?.[0]).toContain("FOR UPDATE OF w");
    expect(membership?.[1]).toMatchObject({ workspaceId: "ws_fixed", userId: "user_fixed" });
  });

  it("adopts an already-present Jira site workspace instead of inserting a duplicate", async () => {
    process.env.BOOTSTRAP_JIRA_SITES = "mysite|owner@x.com";
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws_existing" }) // adopt lookup hits
      .mockResolvedValueOnce({ id: "user_existing" }) // owner user CI lookup hits
      .mockResolvedValueOnce({ workspace_id: "ws_existing" }); // guarded membership upsert

    await expect(ensureBootstrapOwner()).resolves.toEqual({ workspaceId: "ws_existing", userId: "user_existing" });

    expect(mocks.sqlRun.mock.calls.some(([sql]) => sql.includes("INSERT INTO workspaces"))).toBe(false);
    expect(mocks.sqlRun.mock.calls.some(([sql]) => sql.includes("INSERT INTO users"))).toBe(false);
    expect(mocks.sqlGet.mock.calls.some(([sql]) => sql.includes("INSERT INTO workspace_members"))).toBe(true);
  });

  it("keeps Azure entries first and shares the owner-user resolution across providers", async () => {
    process.env.BOOTSTRAP_AZURE_ORGS = "contoso|owner@x.com";
    process.env.BOOTSTRAP_JIRA_SITES = "mysite|OWNER@X.COM";
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws_azure" }) // azure workspace select after insert
      .mockResolvedValueOnce({ id: "user_shared" }) // azure owner CI lookup
      .mockResolvedValueOnce({ id: "ws_jira" }) // jira adopt lookup
      .mockResolvedValueOnce({ id: "user_shared" }) // jira owner CI lookup (case-variant)
      .mockResolvedValueOnce({ workspace_id: "ws_jira" }); // guarded Jira membership upsert

    await expect(ensureBootstrapOwner()).resolves.toEqual({ workspaceId: "ws_azure", userId: "user_shared" });

    // Both providers resolve the owner case-insensitively — a case-variant
    // email can never crash on the CI-unique index.
    const ciLookups = mocks.sqlGet.mock.calls.filter(([sql]) => sql.includes("LOWER(email_or_unique_name)"));
    expect(ciLookups).toHaveLength(2);
  });

  it("re-resolves the site when reconciliation retires a cached placeholder before membership write", async () => {
    process.env.BOOTSTRAP_JIRA_SITES = "new-name|owner@x.com";
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "ws-placeholder" }) // cached URL lookup
      .mockResolvedValueOnce({ id: "user-owner" }) // owner user
      .mockResolvedValueOnce(undefined) // guarded write sees retired placeholder
      .mockResolvedValueOnce({ id: "ws-target" }) // URL now belongs to cloud-ID target
      .mockResolvedValueOnce({ workspace_id: "ws-target" }); // retry succeeds

    await expect(ensureBootstrapOwner()).resolves.toEqual({
      workspaceId: "ws-target",
      userId: "user-owner",
    });

    const membershipWrites = mocks.sqlGet.mock.calls.filter(([sql]) => sql.includes("INSERT INTO workspace_members"));
    expect(membershipWrites).toHaveLength(2);
    expect(membershipWrites[0][1]).toMatchObject({ workspaceId: "ws-placeholder" });
    expect(membershipWrites[1][1]).toMatchObject({ workspaceId: "ws-target" });
  });
});
