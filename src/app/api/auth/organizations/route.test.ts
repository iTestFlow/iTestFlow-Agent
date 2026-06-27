import { beforeEach, describe, expect, it, vi } from "vitest";

const listActiveWorkspaces = vi.fn();
const checkRateLimit = vi.fn();

vi.mock("@/modules/workspace/workspace.service", () => ({
  listActiveWorkspaces: (...args: unknown[]) => listActiveWorkspaces(...args),
}));

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  clientIp: () => "1.2.3.4",
}));

import { GET } from "./route";

function request() {
  return new Request("http://localhost/api/auth/organizations");
}

describe("GET /api/auth/organizations", () => {
  beforeEach(() => {
    listActiveWorkspaces.mockReset();
    checkRateLimit.mockReset();
  });

  it("returns active orgs (display fields only) with no-store, never the internal id", async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: true });
    listActiveWorkspaces.mockResolvedValueOnce([
      { name: "Org A", azureOrgName: "org-a", azureOrgUrl: "https://dev.azure.com/org-a" },
    ]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json();
    expect(body.organizations).toEqual([
      { name: "Org A", azureOrgName: "org-a", azureOrgUrl: "https://dev.azure.com/org-a" },
    ]);
    expect(JSON.stringify(body)).not.toContain('"id"');
  });

  it("returns an empty list when no orgs are enabled", async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: true });
    listActiveWorkspaces.mockResolvedValueOnce([]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).organizations).toEqual([]);
  });

  it("rate-limits with 429 and does not read workspaces", async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });

    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(listActiveWorkspaces).not.toHaveBeenCalled();
  });
});
