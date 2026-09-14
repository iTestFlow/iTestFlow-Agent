import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeJiraSite, parseBootstrapJiraSites } from "@/modules/auth/bootstrap.service";

/**
 * Pure-unit coverage for the Jira-site `.env` parser (no database). Mirrors the
 * BOOTSTRAP_AZURE_ORGS contract: per-site owner format, legacy pair
 * backward-compatibility, owner-email inheritance, fail-fast on a missing owner,
 * de-duplication, and strict *.atlassian.net normalization.
 */
describe("normalizeJiraSite", () => {
  it("expands a bare site name to its atlassian.net URL", () => {
    expect(normalizeJiraSite("mysite")).toEqual({ name: "mysite", url: "https://mysite.atlassian.net" });
  });

  it("accepts a bare *.atlassian.net host", () => {
    expect(normalizeJiraSite("other.atlassian.net")).toEqual({ name: "other", url: "https://other.atlassian.net" });
  });

  it("lowercases and strips trailing slashes from a full URL", () => {
    expect(normalizeJiraSite("https://MySite.Atlassian.Net/")).toEqual({
      name: "mysite",
      url: "https://mysite.atlassian.net",
    });
  });

  it("rejects plain http", () => {
    expect(() => normalizeJiraSite("http://mysite.atlassian.net")).toThrow(/https/i);
  });

  it("rejects hosts outside *.atlassian.net", () => {
    expect(() => normalizeJiraSite("https://mysite.example.com")).toThrow(/atlassian\.net/i);
  });

  it("rejects URLs carrying a path, query, or fragment", () => {
    expect(() => normalizeJiraSite("https://mysite.atlassian.net/browse/X-1")).toThrow(/atlassian\.net/i);
    expect(() => normalizeJiraSite("https://mysite.atlassian.net?x=1")).toThrow(/atlassian\.net/i);
  });

  it("rejects a site name that cannot form a valid host", () => {
    expect(() => normalizeJiraSite("my site")).toThrow(/atlassian\.net/i);
  });

  it("rejects URLs carrying credentials", () => {
    expect(() => normalizeJiraSite("https://evil@mysite.atlassian.net")).toThrow(/credentials/i);
    expect(() => normalizeJiraSite("https://user:pass@mysite.atlassian.net")).toThrow(/credentials/i);
  });

  it("rejects non-ASCII hosts that URL parsing would punycode into un-adoptable sites", () => {
    expect(() => normalizeJiraSite("https://мysite.atlassian.net")).toThrow(/atlassian\.net/i);
    expect(() => normalizeJiraSite("https://xn--ysite-k0d.atlassian.net")).toThrow(/atlassian\.net/i);
  });

  it("accepts the default https port and rejects a trailing-dot host", () => {
    expect(normalizeJiraSite("https://mysite.atlassian.net:443")).toEqual({
      name: "mysite",
      url: "https://mysite.atlassian.net",
    });
    expect(() => normalizeJiraSite("mysite.atlassian.net.")).toThrow(/atlassian\.net/i);
  });

  it("rejects an empty input", () => {
    expect(() => normalizeJiraSite("  ")).toThrow(/empty/i);
  });
});

describe("parseBootstrapJiraSites", () => {
  const ENV_KEYS = ["BOOTSTRAP_OWNER_EMAIL", "BOOTSTRAP_OWNER_JIRA_SITE", "BOOTSTRAP_JIRA_SITES"] as const;
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
    expect(parseBootstrapJiraSites()).toEqual([]);
  });

  it("treats the legacy pair as a single entry (backward compatible)", () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = "admin@company.com";
    process.env.BOOTSTRAP_OWNER_JIRA_SITE = "mysite";
    expect(parseBootstrapJiraSites()).toEqual([
      { siteName: "mysite", siteUrl: "https://mysite.atlassian.net", email: "admin@company.com" },
    ]);
  });

  it("is a no-op (not an error) when only the legacy site is set without an email", () => {
    process.env.BOOTSTRAP_OWNER_JIRA_SITE = "mysite";
    expect(parseBootstrapJiraSites()).toEqual([]);
  });

  it("parses BOOTSTRAP_JIRA_SITES into per-site owners, mixing bare names and URLs", () => {
    process.env.BOOTSTRAP_JIRA_SITES = "site-a|a@x.com, https://site-b.atlassian.net|b@x.com";
    expect(parseBootstrapJiraSites()).toEqual([
      { siteName: "site-a", siteUrl: "https://site-a.atlassian.net", email: "a@x.com" },
      { siteName: "site-b", siteUrl: "https://site-b.atlassian.net", email: "b@x.com" },
    ]);
  });

  it("inherits BOOTSTRAP_OWNER_EMAIL when an entry omits the owner", () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = "fallback@x.com";
    process.env.BOOTSTRAP_JIRA_SITES = "site-c|, site-d|owner-d@x.com";
    expect(parseBootstrapJiraSites()).toEqual([
      { siteName: "site-c", siteUrl: "https://site-c.atlassian.net", email: "fallback@x.com" },
      { siteName: "site-d", siteUrl: "https://site-d.atlassian.net", email: "owner-d@x.com" },
    ]);
  });

  it("throws (fail fast) when an entry has no owner and no fallback", () => {
    process.env.BOOTSTRAP_JIRA_SITES = "site-e";
    expect(() => parseBootstrapJiraSites()).toThrow(/owner email/i);
  });

  it("dedupes a repeated site by canonical URL, keeping the first owner", () => {
    process.env.BOOTSTRAP_JIRA_SITES = "https://dup.atlassian.net|first@x.com, dup|second@x.com";
    expect(parseBootstrapJiraSites()).toEqual([
      { siteName: "dup", siteUrl: "https://dup.atlassian.net", email: "first@x.com" },
    ]);
  });

  it("keeps the legacy pair first when it overlaps BOOTSTRAP_JIRA_SITES", () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = "legacy@x.com";
    process.env.BOOTSTRAP_OWNER_JIRA_SITE = "https://shared.atlassian.net";
    process.env.BOOTSTRAP_JIRA_SITES = "shared|other@x.com, site-f|f@x.com";
    expect(parseBootstrapJiraSites()).toEqual([
      { siteName: "shared", siteUrl: "https://shared.atlassian.net", email: "legacy@x.com" },
      { siteName: "site-f", siteUrl: "https://site-f.atlassian.net", email: "f@x.com" },
    ]);
  });
});
