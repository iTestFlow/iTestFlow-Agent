import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkRateLimit = vi.fn();

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  clientIp: () => "1.2.3.4",
}));

import { GET } from "./route";

const ENV_KEYS = ["BOOTSTRAP_ENABLED_PROVIDERS", "BOOTSTRAP_JIRA_SITES", "BOOTSTRAP_OWNER_JIRA_SITE", "BOOTSTRAP_OWNER_EMAIL", "DATABASE_URL"] as const;

function request() {
  return new Request("http://localhost/api/auth/providers");
}

describe("GET /api/auth/providers", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    checkRateLimit.mockReset();
    checkRateLimit.mockResolvedValue({ allowed: true });
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns both enabled providers with labels and no-store, Azure first under auto-detect", async () => {
    process.env.BOOTSTRAP_JIRA_SITES = "quality|owner@example.test";

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      providers: [
        { id: "azure-devops", label: "Azure DevOps" },
        { id: "jira-cloud", label: "Jira Cloud" },
      ],
    });
  });

  it("omits Jira when no OAuth client is configured (auto-detect)", async () => {
    const response = await GET(request());
    expect(await response.json()).toEqual({
      providers: [{ id: "azure-devops", label: "Azure DevOps" }],
    });
  });

  it("respects the operator's explicit order", async () => {
    process.env.BOOTSTRAP_JIRA_SITES = "quality|owner@example.test";
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "jira-cloud,azure-devops";

    const body = await (await GET(request())).json();
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["jira-cloud", "azure-devops"]);
  });

  it("rate-limits with 429 and Retry-After", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
  });
});
