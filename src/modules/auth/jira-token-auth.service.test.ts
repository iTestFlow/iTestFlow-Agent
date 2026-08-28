import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticateJiraApiToken, InvalidJiraTokenError, JiraTokenAuthError, JiraTokenScopeError,
  resolveJiraSiteResource,
} from "./jira-token-auth.service";

const resource = { cloudId: "cloud-a", siteName: "quality", siteUrl: "https://quality.atlassian.net" };
const GATEWAY = "https://api.atlassian.com/ex/jira/cloud-a/rest/api/3/myself";
const SITE = "https://quality.atlassian.net/rest/api/3/myself";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("resolveJiraSiteResource", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("resolves the cloud ID from the normalized site's tenant endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ cloudId: "cloud-a" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveJiraSiteResource("Quality.atlassian.net/")).resolves.toEqual(resource);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://quality.atlassian.net/_edge/tenant_info");
  });

  it("rejects non-Atlassian input before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveJiraSiteResource("https://evil.example.com")).rejects.toThrow("*.atlassian.net");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid tenant response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ nope: true })));
    await expect(resolveJiraSiteResource("quality")).rejects.toThrow(JiraTokenAuthError);
  });
});

describe("authenticateJiraApiToken", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("detects a scoped token through the gateway and returns the typed email as identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ accountId: "acc-1", displayName: "Quinn", emailAddress: null }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(authenticateJiraApiToken({ resource, emailAddress: "Quinn@Example.Test", apiToken: "tok" })).resolves.toEqual({
      identity: { accountId: "acc-1", displayName: "Quinn", emailAddress: "quinn@example.test" },
      tokenKind: "scoped",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(GATEWAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the direct site URL and detects a classic token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(json({ accountId: "acc-1", displayName: "Quinn", emailAddress: "quinn@example.test" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(authenticateJiraApiToken({ resource, emailAddress: "quinn@example.test", apiToken: "tok" })).resolves.toMatchObject({
      tokenKind: "classic",
    });
    expect(String(fetchMock.mock.calls[1][0])).toBe(SITE);
  });

  it("reports invalid credentials when both probes reject authentication", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));
    await expect(authenticateJiraApiToken({ resource, emailAddress: "quinn@example.test", apiToken: "wrong" }))
      .rejects.toThrow(InvalidJiraTokenError);
  });

  it("distinguishes a mis-scoped token from wrong credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "The request is missing required scopes: read:jira-user" }), { status: 401 }),
    ));
    await expect(authenticateJiraApiToken({ resource, emailAddress: "quinn@example.test", apiToken: "tok" }))
      .rejects.toThrow(JiraTokenScopeError);
  });

  it("fails closed when the profile email contradicts the typed email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ accountId: "acc-1", displayName: "Quinn", emailAddress: "other@example.test" })));
    await expect(authenticateJiraApiToken({ resource, emailAddress: "quinn@example.test", apiToken: "tok" }))
      .rejects.toThrow(InvalidJiraTokenError);
  });

  it("maps outages to a retryable error instead of invalid credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 503 })));
    await expect(authenticateJiraApiToken({ resource, emailAddress: "quinn@example.test", apiToken: "tok" }))
      .rejects.toThrow("Atlassian is unavailable");
  });
});
