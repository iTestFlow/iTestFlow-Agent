import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseBootstrapOrgs } from "@/modules/auth/bootstrap.service";

/**
 * Pure-unit coverage for the multi-org `.env` parser (no database). Verifies the
 * per-org owner format, legacy backward-compatibility, owner-email inheritance,
 * fail-fast on a missing owner, and de-duplication.
 */
describe("parseBootstrapOrgs", () => {
  const ENV_KEYS = ["BOOTSTRAP_OWNER_EMAIL", "BOOTSTRAP_OWNER_AZURE_ORG", "BOOTSTRAP_AZURE_ORGS"] as const;
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

  it("returns [] when nothing is configured", () => {
    expect(parseBootstrapOrgs()).toEqual([]);
  });

  it("treats the legacy pair as a single entry (backward compatible)", () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = "admin@company.com";
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = "contoso";
    expect(parseBootstrapOrgs()).toEqual([
      { orgName: "contoso", orgUrl: "https://dev.azure.com/contoso", email: "admin@company.com" },
    ]);
  });

  it("is a no-op (not an error) when only the legacy org is set without an email", () => {
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = "contoso";
    expect(parseBootstrapOrgs()).toEqual([]);
  });

  it("parses BOOTSTRAP_AZURE_ORGS into per-org owners", () => {
    process.env.BOOTSTRAP_AZURE_ORGS =
      "https://dev.azure.com/org-a|a@x.com, https://dev.azure.com/org-b|b@x.com";
    expect(parseBootstrapOrgs()).toEqual([
      { orgName: "org-a", orgUrl: "https://dev.azure.com/org-a", email: "a@x.com" },
      { orgName: "org-b", orgUrl: "https://dev.azure.com/org-b", email: "b@x.com" },
    ]);
  });

  it("inherits BOOTSTRAP_OWNER_EMAIL when an entry omits the owner", () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = "fallback@x.com";
    process.env.BOOTSTRAP_AZURE_ORGS = "org-c|, org-d|owner-d@x.com";
    expect(parseBootstrapOrgs()).toEqual([
      { orgName: "org-c", orgUrl: "https://dev.azure.com/org-c", email: "fallback@x.com" },
      { orgName: "org-d", orgUrl: "https://dev.azure.com/org-d", email: "owner-d@x.com" },
    ]);
  });

  it("throws (fail fast) when an entry has no owner and no fallback", () => {
    process.env.BOOTSTRAP_AZURE_ORGS = "org-e";
    expect(() => parseBootstrapOrgs()).toThrow(/owner email/i);
  });

  it("dedupes a repeated org by canonical URL, keeping the first owner", () => {
    process.env.BOOTSTRAP_AZURE_ORGS =
      "https://dev.azure.com/dup|first@x.com, dup|second@x.com";
    expect(parseBootstrapOrgs()).toEqual([
      { orgName: "dup", orgUrl: "https://dev.azure.com/dup", email: "first@x.com" },
    ]);
  });

  it("keeps the legacy pair first when it overlaps BOOTSTRAP_AZURE_ORGS", () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = "legacy@x.com";
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = "https://dev.azure.com/shared";
    process.env.BOOTSTRAP_AZURE_ORGS = "https://dev.azure.com/shared|other@x.com, org-f|f@x.com";
    expect(parseBootstrapOrgs()).toEqual([
      { orgName: "shared", orgUrl: "https://dev.azure.com/shared", email: "legacy@x.com" },
      { orgName: "org-f", orgUrl: "https://dev.azure.com/org-f", email: "f@x.com" },
    ]);
  });
});
