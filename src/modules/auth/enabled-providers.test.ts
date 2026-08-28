import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ sqlGet: mocks.sqlGet }));

import { getEnabledLoginProviders, isLoginProviderEnabled, validateEnabledProviderShape } from "@/modules/auth/enabled-providers";

describe("getEnabledLoginProviders", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "");
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "");
    vi.stubEnv("BOOTSTRAP_OWNER_JIRA_SITE", "");
    vi.stubEnv("BOOTSTRAP_OWNER_EMAIL", "");
  });

  it("offers Azure only when no Jira site is configured", async () => {
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops"]);
    expect(mocks.sqlGet).not.toHaveBeenCalled();
  });

  it("auto-detects Jira from parsed bootstrap sites", async () => {
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "quality|owner@example.test");
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops", "jira-cloud"]);
  });

  it("keys the legacy single-site pair on PARSED entries: inert without the owner email", async () => {
    vi.stubEnv("BOOTSTRAP_OWNER_JIRA_SITE", "quality");
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops"]);

    vi.stubEnv("BOOTSTRAP_OWNER_EMAIL", "owner@example.test");
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops", "jira-cloud"]);
  });

  it("keeps Jira enabled through the database when the env sites were trimmed after seeding", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://example");
    mocks.sqlGet.mockResolvedValueOnce({ configured: true });
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops", "jira-cloud"]);
    expect(String(mocks.sqlGet.mock.calls[0][0])).toContain("provider_id = 'jira-cloud'");

    mocks.sqlGet.mockResolvedValueOnce({ configured: false });
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops"]);
  });

  it("preserves the explicit operator order and de-duplicates", async () => {
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "quality|owner@example.test");
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "jira-cloud, azure-devops, jira-cloud");
    await expect(getEnabledLoginProviders()).resolves.toEqual(["jira-cloud", "azure-devops"]);

    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "jira-cloud");
    await expect(getEnabledLoginProviders()).resolves.toEqual(["jira-cloud"]);
  });

  it("throws on an unknown provider id", async () => {
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "azure-devops,github");
    await expect(getEnabledLoginProviders()).rejects.toThrow(/github/);
    await expect(getEnabledLoginProviders()).rejects.toThrow(/azure-devops, jira-cloud/);
  });

  it("fails fast on explicit jira-cloud with no configured Jira site anywhere", async () => {
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "jira-cloud");
    await expect(getEnabledLoginProviders()).rejects.toThrow(/BOOTSTRAP_JIRA_SITES/);

    // A database row from an earlier seed satisfies the explicit enablement.
    vi.stubEnv("DATABASE_URL", "postgres://example");
    mocks.sqlGet.mockResolvedValueOnce({ configured: true });
    await expect(getEnabledLoginProviders()).resolves.toEqual(["jira-cloud"]);
  });

  it("answers isLoginProviderEnabled from the same contract", async () => {
    await expect(isLoginProviderEnabled("azure-devops")).resolves.toBe(true);
    await expect(isLoginProviderEnabled("jira-cloud")).resolves.toBe(false);

    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "quality|owner@example.test");
    await expect(isLoginProviderEnabled("jira-cloud")).resolves.toBe(true);

    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "jira-cloud");
    await expect(isLoginProviderEnabled("azure-devops")).resolves.toBe(false);
  });

  it("validates the configuration shape without touching the database", () => {
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "azure-devops,github");
    expect(() => validateEnabledProviderShape()).toThrow(/github/);

    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "jira-cloud");
    expect(() => validateEnabledProviderShape()).not.toThrow();
    expect(mocks.sqlGet).not.toHaveBeenCalled();
  });
});
