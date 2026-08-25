import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getEnabledLoginProviders, isLoginProviderEnabled } from "@/modules/auth/enabled-providers";

/**
 * Pure-unit coverage for the login-provider enablement contract.
 * BOOTSTRAP_ENABLED_PROVIDERS is explicit and validated fail-fast; when unset,
 * auto-detect preserves today's effective behavior (Azure always, Jira only
 * when its OAuth client is configured).
 */
describe("getEnabledLoginProviders", () => {
  const ENV_KEYS = ["BOOTSTRAP_ENABLED_PROVIDERS", "ATLASSIAN_OAUTH_CLIENT_ID"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("auto-detects Azure only when unset and no Jira OAuth client is configured", () => {
    expect(getEnabledLoginProviders()).toEqual(["azure-devops"]);
  });

  it("auto-detects both providers when the Jira OAuth client is configured", () => {
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "client-1";
    expect(getEnabledLoginProviders()).toEqual(["azure-devops", "jira-cloud"]);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "  ,  ";
    expect(getEnabledLoginProviders()).toEqual(["azure-devops"]);
  });

  it("honors an explicit single provider", () => {
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "client-1";
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "azure-devops";
    expect(getEnabledLoginProviders()).toEqual(["azure-devops"]);

    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "jira-cloud";
    expect(getEnabledLoginProviders()).toEqual(["jira-cloud"]);
  });

  it("preserves the operator's order and dedupes repeats", () => {
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "client-1";
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = " jira-cloud , azure-devops , jira-cloud ";
    expect(getEnabledLoginProviders()).toEqual(["jira-cloud", "azure-devops"]);
  });

  it("throws (fail fast) on an unknown provider id, naming the bad value", () => {
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "azure-devops,github";
    expect(() => getEnabledLoginProviders()).toThrow(/github/);
    expect(() => getEnabledLoginProviders()).toThrow(/azure-devops, jira-cloud/);
  });

  it("throws when jira-cloud is enabled explicitly without its OAuth client", () => {
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "jira-cloud";
    expect(() => getEnabledLoginProviders()).toThrow(/ATLASSIAN_OAUTH_CLIENT_ID/);
  });

  it("answers isLoginProviderEnabled from the same contract", () => {
    expect(isLoginProviderEnabled("azure-devops")).toBe(true);
    expect(isLoginProviderEnabled("jira-cloud")).toBe(false);

    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "client-1";
    expect(isLoginProviderEnabled("jira-cloud")).toBe(true);

    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "jira-cloud";
    expect(isLoginProviderEnabled("azure-devops")).toBe(false);
  });
});
