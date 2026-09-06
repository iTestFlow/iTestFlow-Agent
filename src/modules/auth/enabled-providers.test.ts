import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ sqlGet: mocks.sqlGet }));

import { getEnabledJiraLoginMethods, getEnabledLoginProviders, isJiraLoginMethodEnabled, isLoginProviderEnabled, validateEnabledProviderShape } from "@/modules/auth/enabled-providers";

describe("getEnabledLoginProviders", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "");
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "");
    vi.stubEnv("BOOTSTRAP_OWNER_JIRA_SITE", "");
    vi.stubEnv("BOOTSTRAP_OWNER_EMAIL", "");
    // validateEnabledProviderShape now reads the method-layer env; keep
    // ambient dev-box values out of this suite.
    vi.stubEnv("JIRA_LOGIN_METHODS", "");
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "");
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "");
  });

  it("offers Azure only when no Jira site is configured", async () => {
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops"]);
    expect(mocks.sqlGet).not.toHaveBeenCalled();
  });

  it.each(["", "azure-devops"])("accepts the legacy callback-only environment with providers=%s", async (providers) => {
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", providers);
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "http://localhost:3000/api/auth/jira/callback");

    expect(() => validateEnabledProviderShape()).not.toThrow();
    await expect(getEnabledLoginProviders()).resolves.toEqual(["azure-devops"]);
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual([]);
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

  it("fails closed as disabled when the provider list cannot be resolved at request time", async () => {
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "jira-cloud"); // no configured site anywhere → list resolution throws
    await expect(isLoginProviderEnabled("jira-cloud")).resolves.toBe(false);
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

describe("getEnabledJiraLoginMethods", () => {
  const OAUTH_ENV = {
    ATLASSIAN_OAUTH_CLIENT_ID: "client-id",
    ATLASSIAN_OAUTH_CLIENT_SECRET: "client-secret",
    ATLASSIAN_OAUTH_REDIRECT_URI: "https://itestflow.example/api/auth/jira/callback",
  } as const;
  const stubFullOAuthEnv = () => {
    for (const [key, value] of Object.entries(OAUTH_ENV)) vi.stubEnv(key, value);
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "");
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "quality|owner@example.test");
    vi.stubEnv("BOOTSTRAP_OWNER_JIRA_SITE", "");
    vi.stubEnv("BOOTSTRAP_OWNER_EMAIL", "");
    vi.stubEnv("JIRA_LOGIN_METHODS", "");
    for (const key of Object.keys(OAUTH_ENV)) vi.stubEnv(key, "");
  });

  it("offers the API token alone when the OAuth client is unconfigured — existing deployments unchanged", async () => {
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual(["api_token"]);
    await expect(isJiraLoginMethodEnabled("api_token")).resolves.toBe(true);
    await expect(isJiraLoginMethodEnabled("oauth")).resolves.toBe(false);
  });

  it("auto-offers OAuth after the token default once the client is fully configured", async () => {
    stubFullOAuthEnv();
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual(["api_token", "oauth"]);
    expect(() => validateEnabledProviderShape()).not.toThrow();
  });

  it("keeps a callback-only Jira deployment on API tokens unless OAuth is explicitly requested", async () => {
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", " ");
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", " ");
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "http://localhost:3000/api/auth/jira/callback");

    expect(() => validateEnabledProviderShape()).not.toThrow();
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual(["api_token"]);
    vi.stubEnv("JIRA_LOGIN_METHODS", "oauth");
    expect(() => validateEnabledProviderShape()).toThrow(/OAuth client is not configured/);
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual([]);
  });

  it.each(["ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET"])("still rejects a callback plus only %s", (credentialKey) => {
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", OAUTH_ENV.ATLASSIAN_OAUTH_REDIRECT_URI);
    vi.stubEnv(credentialKey, "configured");
    expect(() => validateEnabledProviderShape()).toThrow(/partially configured/);
  });

  it("still requires a callback when both OAuth credentials are supplied", () => {
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", OAUTH_ENV.ATLASSIAN_OAUTH_CLIENT_ID);
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", OAUTH_ENV.ATLASSIAN_OAUTH_CLIENT_SECRET);
    expect(() => validateEnabledProviderShape()).toThrow(/ATLASSIAN_OAUTH_REDIRECT_URI/);
  });

  it("fails startup on a partial OAuth env, naming every missing variable", () => {
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "client-id");
    expect(() => validateEnabledProviderShape()).toThrow(/ATLASSIAN_OAUTH_CLIENT_SECRET/);
    expect(() => validateEnabledProviderShape()).toThrow(/ATLASSIAN_OAUTH_REDIRECT_URI/);
  });

  it("honors an explicit JIRA_LOGIN_METHODS order and deduplicates", async () => {
    stubFullOAuthEnv();
    vi.stubEnv("JIRA_LOGIN_METHODS", "oauth, api_token, oauth");
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual(["oauth", "api_token"]);
  });

  it("lets an explicit api_token list hide a fully configured OAuth client", async () => {
    stubFullOAuthEnv();
    vi.stubEnv("JIRA_LOGIN_METHODS", "api_token");
    expect(() => validateEnabledProviderShape()).not.toThrow();
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual(["api_token"]);
    await expect(isJiraLoginMethodEnabled("oauth")).resolves.toBe(false);
  });

  it("supports OAuth-only mode: token sign-in is off for the deployment", async () => {
    stubFullOAuthEnv();
    vi.stubEnv("JIRA_LOGIN_METHODS", "oauth");
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual(["oauth"]);
    await expect(isJiraLoginMethodEnabled("api_token")).resolves.toBe(false);
    await expect(isJiraLoginMethodEnabled("oauth")).resolves.toBe(true);
  });

  it("fails fast on an invalid JIRA_LOGIN_METHODS value", () => {
    vi.stubEnv("JIRA_LOGIN_METHODS", "oauth");
    expect(() => validateEnabledProviderShape()).toThrow(/ATLASSIAN_OAUTH_/);

    vi.stubEnv("JIRA_LOGIN_METHODS", "github");
    expect(() => validateEnabledProviderShape()).toThrow(/api_token, oauth/);

    vi.stubEnv("JIRA_LOGIN_METHODS", " , ");
    expect(() => validateEnabledProviderShape()).toThrow(/JIRA_LOGIN_METHODS/);
  });

  it("returns no methods when the jira-cloud provider itself is disabled", async () => {
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "");
    stubFullOAuthEnv();
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual([]);
    await expect(isJiraLoginMethodEnabled("api_token")).resolves.toBe(false);
    await expect(isJiraLoginMethodEnabled("oauth")).resolves.toBe(false);
  });

  it("fails closed to no methods when resolution throws at request time", async () => {
    // OAuth-only mode with the client env gone after boot: startup would have
    // refused, but a public route hitting this drift must see 'disabled',
    // never a 500.
    vi.stubEnv("JIRA_LOGIN_METHODS", "oauth");
    await expect(getEnabledJiraLoginMethods()).resolves.toEqual([]);
    await expect(isJiraLoginMethodEnabled("oauth")).resolves.toBe(false);
  });
});
