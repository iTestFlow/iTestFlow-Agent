import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationError } from "../core/integration-error";
import { jiraApiBase, jiraBasicAuthorization, jiraFetch } from "./jira-http";

describe("jiraApiBase", () => {
  it("routes scoped tokens through the api.atlassian.com gateway", () => {
    expect(jiraApiBase({ tokenKind: "scoped", cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net" }))
      .toBe("https://api.atlassian.com/ex/jira/cloud-a/rest/api/3");
  });

  it("routes classic tokens against the direct site URL", () => {
    expect(jiraApiBase({ tokenKind: "classic", cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net/" }))
      .toBe("https://quality.atlassian.net/rest/api/3");
  });
});

describe("jiraFetch", () => {
  const auth = { email: "user@example.test", apiToken: "token-secret" };
  beforeEach(() => vi.unstubAllGlobals());

  it("sends Basic authorization from the email and token pair", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await jiraFetch("https://quality.atlassian.net/rest/api/3/myself", {}, auth);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: jiraBasicAuthorization(auth),
    });
  });

  it("fires the invalidation hook on 401 only", async () => {
    const onUnauthorized = vi.fn();
    for (const [status, fired] of [[401, true], [403, false], [404, false], [429, false], [500, false]] as const) {
      onUnauthorized.mockClear();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status })));
      await expect(jiraFetch("https://x.atlassian.net/rest/api/3/x", {}, auth, { onUnauthorized })).rejects.toThrow(IntegrationError);
      expect(onUnauthorized).toHaveBeenCalledTimes(fired ? 1 : 0);
    }
  });

  it("classifies statuses and surfaces Retry-After on rate limits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow down", { status: 429, headers: { "Retry-After": "37" } })));
    const error = await jiraFetch("https://x.atlassian.net/rest/api/3/x", {}, auth).catch((caught) => caught as IntegrationError);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).code).toBe("integration_rate_limited");
    expect((error as IntegrationError).statusCode).toBe(429);
    expect((error as IntegrationError).retryAfterSeconds).toBe(37);
  });

  it("never leaks the credential pair or upstream bodies in error messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream body token-secret", { status: 500 })));
    const error = await jiraFetch("https://x.atlassian.net/rest/api/3/x", {}, auth).catch((caught) => caught as Error);
    expect(String((error as Error).message)).not.toContain("token-secret");
    expect(String((error as Error).message)).not.toContain("secret upstream body");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom token-secret")));
    const network = await jiraFetch("https://x.atlassian.net/rest/api/3/x", {}, auth).catch((caught) => caught as Error);
    expect(String((network as Error).message)).toBe("Jira Cloud is unavailable.");
  });
});
