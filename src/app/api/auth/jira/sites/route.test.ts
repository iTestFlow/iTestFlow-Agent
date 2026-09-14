import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listActiveJiraSites = vi.fn();
const checkRateLimit = vi.fn();

vi.mock("@/modules/workspace/workspace.service", () => ({
  listActiveJiraSites: (...args: unknown[]) => listActiveJiraSites(...args),
}));

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  clientIp: () => "1.2.3.4",
}));

import { GET } from "./route";

const ENV_KEYS = ["BOOTSTRAP_ENABLED_PROVIDERS", "BOOTSTRAP_JIRA_SITES", "BOOTSTRAP_OWNER_JIRA_SITE", "BOOTSTRAP_OWNER_EMAIL", "DATABASE_URL"] as const;

function request() {
  return new Request("http://localhost/api/auth/jira/sites");
}

describe("GET /api/auth/jira/sites", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    listActiveJiraSites.mockReset();
    checkRateLimit.mockReset();
    checkRateLimit.mockResolvedValue({ allowed: true });
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.BOOTSTRAP_JIRA_SITES = "quality|owner@example.test"; // auto-detect enables jira-cloud
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns active sites (display fields only) with no-store, never ids or cloudIds", async () => {
    listActiveJiraSites.mockResolvedValueOnce([
      { name: "Quality", siteUrl: "https://quality.atlassian.net" },
    ]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json();
    expect(body.sites).toEqual([{ name: "Quality", siteUrl: "https://quality.atlassian.net" }]);
    expect(JSON.stringify(body)).not.toContain('"id"');
    expect(JSON.stringify(body)).not.toContain("cloudId");
  });

  it("returns an empty list when no sites are enabled", async () => {
    listActiveJiraSites.mockResolvedValueOnce([]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).sites).toEqual([]);
  });

  it("rate-limits with 429 before reading sites", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(listActiveJiraSites).not.toHaveBeenCalled();
  });

  it("fails closed with 403 when Jira Cloud sign-in is disabled for the deployment", async () => {
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "azure-devops";

    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(listActiveJiraSites).not.toHaveBeenCalled();
  });
});
