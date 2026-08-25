import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlAll: vi.fn(), sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-08-13T00:00:00.000Z", sqlAll: mocks.sqlAll, sqlGet: mocks.sqlGet,
}));
vi.mock("./workspace-access.service", () => ({ getWorkspaceMembership: vi.fn() }));

import { findActiveJiraSiteByUrl, listActiveJiraSites, listActiveWorkspaces } from "./workspace.service";

beforeEach(() => {
  mocks.sqlAll.mockReset().mockResolvedValue([]);
  mocks.sqlGet.mockReset().mockResolvedValue(undefined);
});

it("keeps Jira workspaces out of the legacy Azure pre-auth organization picker", async () => {
  await listActiveWorkspaces();
  expect(mocks.sqlAll.mock.calls[0][0]).toContain("provider_id = 'azure-devops'");
});

it("lists only active Jira sites that carry a site URL, as display fields", async () => {
  mocks.sqlAll.mockResolvedValueOnce([
    { name: "seeded-a", provider_site_name: null, provider_site_url: "https://a.atlassian.net" },
    { name: "ws-name", provider_site_name: "Connected B", provider_site_url: "https://b.atlassian.net" },
  ]);

  const sites = await listActiveJiraSites();

  const sql = mocks.sqlAll.mock.calls[0][0];
  expect(sql).toContain("provider_id = 'jira-cloud'");
  expect(sql).toContain("status = 'active'");
  expect(sql).toContain("provider_site_url IS NOT NULL");
  // Display fields only — never workspace ids or Atlassian cloudIds.
  expect(sql).not.toContain("provider_site_id");
  expect(sites).toEqual([
    { name: "seeded-a", siteUrl: "https://a.atlassian.net" },
    { name: "Connected B", siteUrl: "https://b.atlassian.net" },
  ]);
});

it("finds an active Jira site by its canonical URL for the OAuth start validation", async () => {
  mocks.sqlGet.mockResolvedValueOnce({
    name: "seeded-a", provider_site_name: null, provider_site_url: "https://a.atlassian.net",
  });

  const site = await findActiveJiraSiteByUrl("https://a.atlassian.net");

  const [sql, params] = mocks.sqlGet.mock.calls[0];
  expect(sql).toContain("provider_id = 'jira-cloud'");
  expect(sql).toContain("status = 'active'");
  expect(params).toEqual({ siteUrl: "https://a.atlassian.net" });
  expect(site).toEqual({ name: "seeded-a", siteUrl: "https://a.atlassian.net" });

  expect(await findActiveJiraSiteByUrl("https://missing.atlassian.net")).toBeNull();
});
