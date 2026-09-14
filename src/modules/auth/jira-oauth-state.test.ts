import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nowIso: vi.fn(() => "2026-08-13T10:00:00.000Z"),
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`,
  nowIso: mocks.nowIso,
  sqlGet: mocks.sqlGet,
  sqlRun: mocks.sqlRun,
}));

import { consumeJiraOAuthState, createJiraOAuthState, JiraOAuthStateError } from "./jira-oauth-state";

const selection = { workspaceId: "ws-1", siteUrl: "https://quality.atlassian.net", cloudId: "cloud-a" };

describe("Jira OAuth state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nowIso.mockReturnValue("2026-08-13T10:00:00.000Z");
    mocks.sqlRun.mockResolvedValue(1);
  });

  it("persists only hashes with the workspace binding and a 10-minute TTL — never the raw state", async () => {
    const state = await createJiraOAuthState("/dashboards", "binding-secret", selection);
    expect(state.length).toBeGreaterThanOrEqual(40);
    const [sql, params] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("INSERT INTO jira_oauth_states");
    expect(params).toMatchObject({
      returnTo: "/dashboards",
      selectedWorkspaceId: "ws-1",
      selectedSiteUrl: "https://quality.atlassian.net",
      selectedCloudId: "cloud-a",
      expiresAt: "2026-08-13T10:10:00.000Z",
    });
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain("binding-secret");
    expect(params.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prunes states expired at the same application timestamp in the state-insert statement", async () => {
    await createJiraOAuthState("/dashboards", "binding-secret", selection);

    expect(mocks.nowIso).toHaveBeenCalledTimes(1);
    expect(mocks.sqlRun).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.sqlRun.mock.calls[0];
    const normalizedSql = String(sql).replace(/\s+/g, " ").trim();

    expect(normalizedSql).toMatch(
      /^WITH\s+[a-zA-Z_][a-zA-Z0-9_]*\s+AS\s*\(\s*DELETE FROM jira_oauth_states WHERE expires_at <= @now(?:\s+RETURNING\s+[^)]+)?\s*\)\s*INSERT INTO jira_oauth_states\b/i,
    );
    expect(normalizedSql.match(/DELETE FROM jira_oauth_states/gi)).toHaveLength(1);
    expect(normalizedSql.match(/INSERT INTO jira_oauth_states/gi)).toHaveLength(1);
    expect(normalizedSql.match(/@now\b/g)).toHaveLength(2);
    expect(normalizedSql.replace(/;$/, "")).not.toContain(";");
    expect(params).toMatchObject({
      now: "2026-08-13T10:00:00.000Z",
      expiresAt: "2026-08-13T10:10:00.000Z",
    });
  });

  it("accepts a seeded workspace with no pinned cloud ID", async () => {
    await createJiraOAuthState("/dashboards", "binding", { ...selection, cloudId: null });
    expect(mocks.sqlRun.mock.calls[0][1]).toMatchObject({ selectedCloudId: null });
  });

  it("rejects every open-redirect shape for returnTo", async () => {
    for (const returnTo of [
      "//evil.example", "/\\evil", "https://evil.example/x", "/a/%2f..", "/a/%5C..", "relative",
      // WHATWG parsers strip tabs/newlines, turning these into
      // protocol-relative URLs; the origin-equality backstop must hold.
      "/\t/evil.example", "/\n/evil.example",
    ]) {
      await expect(createJiraOAuthState(returnTo, "binding", selection)).rejects.toBeInstanceOf(JiraOAuthStateError);
    }
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("requires the browser binding and a complete site selection", async () => {
    await expect(createJiraOAuthState("/dashboards", "  ", selection)).rejects.toBeInstanceOf(JiraOAuthStateError);
    await expect(createJiraOAuthState("/dashboards", "binding", { ...selection, workspaceId: " " }))
      .rejects.toBeInstanceOf(JiraOAuthStateError);
    await expect(createJiraOAuthState("/dashboards", "binding", { ...selection, siteUrl: " " }))
      .rejects.toBeInstanceOf(JiraOAuthStateError);
  });

  it("consumes single-use via DELETE ... RETURNING, matching hash, binding, and TTL", async () => {
    mocks.sqlGet.mockResolvedValueOnce({
      return_to: "/dashboards",
      selected_workspace_id: "ws-1",
      selected_site_url: "https://quality.atlassian.net",
      selected_cloud_id: "cloud-a",
    });
    await expect(consumeJiraOAuthState("opaque-state", "binding")).resolves.toEqual({
      returnTo: "/dashboards",
      selectedWorkspaceId: "ws-1",
      selectedSiteUrl: "https://quality.atlassian.net",
      selectedCloudId: "cloud-a",
    });
    const [sql, params] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("DELETE FROM jira_oauth_states");
    expect(sql).toContain("RETURNING");
    expect(sql).toContain("expires_at > @now");
    expect(JSON.stringify(params)).not.toContain("opaque-state");
  });

  it("rejects a replayed, expired, or binding-mismatched state as one typed error", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(consumeJiraOAuthState("replayed", "binding")).rejects.toBeInstanceOf(JiraOAuthStateError);
  });
});
