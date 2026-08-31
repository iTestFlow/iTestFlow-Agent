import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationError } from "../core/integration-error";
import { JiraBearerAuthError, jiraApiBase, jiraBasicAuthorization, jiraFetch, type JiraAuth } from "./jira-http";

describe("jiraApiBase", () => {
  it("routes scoped tokens through the api.atlassian.com gateway", () => {
    expect(jiraApiBase({ tokenKind: "scoped", cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net" }))
      .toBe("https://api.atlassian.com/ex/jira/cloud-a/rest/api/3");
  });

  it("routes classic tokens against the direct site URL", () => {
    expect(jiraApiBase({ tokenKind: "classic", cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net/" }))
      .toBe("https://quality.atlassian.net/rest/api/3");
  });

  it("routes OAuth through the gateway — the exact scoped-token base URL", () => {
    expect(jiraApiBase({ credentialKind: "oauth", cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net" }))
      .toBe(jiraApiBase({ tokenKind: "scoped", cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net" }));
  });

  it("routes an explicit api_token credentialKind by its token kind, never the discriminator", () => {
    expect(jiraApiBase({ credentialKind: "api_token", tokenKind: "classic", cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net" }))
      .toBe("https://quality.atlassian.net/rest/api/3");
  });
});

describe("jiraFetch (basic)", () => {
  const auth: JiraAuth = { kind: "basic", email: "user@example.test", apiToken: "token-secret" };
  beforeEach(() => vi.unstubAllGlobals());

  it("sends Basic authorization from the email and token pair", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await jiraFetch("https://quality.atlassian.net/rest/api/3/myself", {}, auth);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: jiraBasicAuthorization(auth),
    });
  });

  it("fires the invalidation hook on 401 only, with no retry", async () => {
    const onUnauthorized = vi.fn();
    for (const [status, fired] of [[401, true], [403, false], [404, false], [429, false], [500, false]] as const) {
      onUnauthorized.mockClear();
      const fetchMock = vi.fn().mockResolvedValue(new Response("denied", { status }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(jiraFetch("https://x.atlassian.net/rest/api/3/x", {}, auth, { onUnauthorized })).rejects.toThrow(IntegrationError);
      expect(onUnauthorized).toHaveBeenCalledTimes(fired ? 1 : 0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("jiraFetch (bearer)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  const bearerAuth = (getToken: (options?: { forceRefresh?: boolean }) => Promise<string>): JiraAuth =>
    ({ kind: "bearer", getToken });

  it("sends the supplied bearer token without forcing a refresh", async () => {
    const getToken = vi.fn().mockResolvedValue("access-1");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await jiraFetch("https://api.atlassian.com/ex/jira/c/rest/api/3/myself", {}, bearerAuth(getToken));
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledWith(undefined);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer access-1" });
  });

  it("refreshes once and retries once on a plain 401, without firing the hook", async () => {
    const getToken = vi.fn()
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    const firstResponse = new Response("expired", { status: 401 });
    const cancelSpy = vi.spyOn(firstResponse.body!, "cancel");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const init = { method: "POST", body: JSON.stringify({ fields: { summary: "x" } }) };
    const response = await jiraFetch("https://api.atlassian.com/x", init, bearerAuth(getToken), { onUnauthorized });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer stale-token" });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer fresh-token" });
    // The retry re-sends the request itself, not just the new header.
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1][1]?.body).toBe(init.body);
    // The abandoned 401 response frees its pooled connection.
    expect(cancelSpy).toHaveBeenCalled();
    expect(getToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("fires the hook exactly once when the retry also 401s", async () => {
    const getToken = vi.fn().mockResolvedValue("token");
    const fetchMock = vi.fn().mockResolvedValue(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const error = await jiraFetch("https://api.atlassian.com/x", {}, bearerAuth(getToken), { onUnauthorized })
      .catch((caught) => caught as IntegrationError);
    expect((error as IntegrationError).code).toBe("integration_auth_failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("never refreshes or retries on 403/429/5xx", async () => {
    for (const status of [403, 429, 500] as const) {
      const getToken = vi.fn().mockResolvedValue("token");
      const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status, headers: status === 429 ? { "Retry-After": "11" } : {} }));
      vi.stubGlobal("fetch", fetchMock);
      const error = await jiraFetch("https://api.atlassian.com/x", {}, bearerAuth(getToken))
        .catch((caught) => caught as IntegrationError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledWith(undefined);
      if (status === 429) expect((error as IntegrationError).retryAfterSeconds).toBe(11);
    }
  });

  it("maps a terminal supplier failure to auth_failed without firing the hook", async () => {
    // The supplier already flipped the connection row; the hook would write a
    // second, conflicting status on top.
    const getToken = vi.fn()
      .mockResolvedValueOnce("stale-token")
      .mockRejectedValueOnce(new JiraBearerAuthError("reauthorization_required"));
    const fetchMock = vi.fn().mockResolvedValue(new Response("expired", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const error = await jiraFetch("https://api.atlassian.com/x", {}, bearerAuth(getToken), { onUnauthorized })
      .catch((caught) => caught as IntegrationError);
    expect((error as IntegrationError).code).toBe("integration_auth_failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("maps a terminal supplier failure on the initial token supply the same way", async () => {
    // A refactor that guarded only the forceRefresh path would leak the raw
    // supplier error to the job queue as integration_unknown and retry a
    // terminally-flipped row five times.
    const getToken = vi.fn().mockRejectedValue(new JiraBearerAuthError("reauthorization_required"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const error = await jiraFetch("https://api.atlassian.com/x", {}, bearerAuth(getToken), { onUnauthorized })
      .catch((caught) => caught as IntegrationError);
    expect((error as IntegrationError).code).toBe("integration_auth_failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("maps a transient supplier failure to unavailable before any request", async () => {
    const getToken = vi.fn().mockRejectedValue(new JiraBearerAuthError("unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await jiraFetch("https://api.atlassian.com/x", {}, bearerAuth(getToken))
      .catch((caught) => caught as IntegrationError);
    expect((error as IntegrationError).code).toBe("integration_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an unexpected supplier failure to unknown and never leaks its message", async () => {
    const getToken = vi.fn().mockRejectedValue(new Error("pg pool exhausted access-9 refresh-9"));
    vi.stubGlobal("fetch", vi.fn());
    const error = await jiraFetch("https://api.atlassian.com/x", {}, bearerAuth(getToken))
      .catch((caught) => caught as IntegrationError);
    expect((error as IntegrationError).code).toBe("integration_unknown");
    expect(String((error as Error).message)).not.toContain("access-9");
    expect(String((error as Error).message)).not.toContain("pg pool");
  });

  it("never leaks the bearer token in error messages", async () => {
    const getToken = vi.fn().mockResolvedValue("bearer-secret-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("body bearer-secret-token", { status: 500 })));
    const error = await jiraFetch("https://api.atlassian.com/x", {}, bearerAuth(getToken))
      .catch((caught) => caught as Error);
    expect(String((error as Error).message)).not.toContain("bearer-secret-token");
  });
});
