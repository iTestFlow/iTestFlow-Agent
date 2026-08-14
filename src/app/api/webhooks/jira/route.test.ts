import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), accept: vi.fn() }));
vi.mock("@/modules/integrations/jira-cloud/jira-webhook-auth", () => ({ verifyJiraOAuthWebhookBearer: mocks.verify }));
vi.mock("@/modules/integrations/jira-cloud/jira-webhook-events.service", () => ({
  acceptJiraWebhookEvent: mocks.accept,
  JiraWebhookRejectedError: class JiraWebhookRejectedError extends Error {},
}));

import { POST } from "./route";

describe("Jira webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = "client-secret";
    mocks.verify.mockResolvedValue(undefined);
    mocks.accept.mockResolvedValue({ accepted: true, duplicate: false });
  });

  it("verifies the bearer before accepting the raw delivery", async () => {
    const body = JSON.stringify({ webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001] });
    const response = await POST(new Request("https://app.test/api/webhooks/jira?registration=registration-secret", {
      method: "POST", body,
      headers: { authorization: "Bearer signed", "x-atlassian-webhook-identifier": "delivery-7", "x-atlassian-webhook-retry": "2" },
    }));
    expect(response.status).toBe(202);
    expect(mocks.verify).toHaveBeenCalledWith("Bearer signed", "client-secret");
    expect(mocks.accept).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "delivery-7", registrationToken: "registration-secret", retryCount: 2, rawPayload: body }));
  });

  it("returns a fixed 401 and performs no persistence when authentication fails", async () => {
    mocks.verify.mockRejectedValue(new Error("token detail"));
    const response = await POST(new Request("https://app.test/api/webhooks/jira", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Jira webhook authentication failed." });
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("returns a retryable response when persistence fails transiently", async () => {
    mocks.accept.mockRejectedValue(new Error("database connection secret detail"));
    const response = await POST(new Request("https://app.test/api/webhooks/jira?registration=token", {
      method: "POST", body: "{}", headers: { authorization: "Bearer signed", "x-atlassian-webhook-identifier": "delivery-7" },
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Jira webhook delivery could not be persisted." });
  });

  it("rejects invalid JSON before persistence", async () => {
    const response = await POST(new Request("https://app.test/api/webhooks/jira", {
      method: "POST", body: "{", headers: { authorization: "Bearer signed" },
    }));
    expect(response.status).toBe(400);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("returns a non-retryable fixed response for a rejected delivery", async () => {
    const { JiraWebhookRejectedError } = await import("@/modules/integrations/jira-cloud/jira-webhook-events.service");
    mocks.accept.mockRejectedValue(new JiraWebhookRejectedError("registration secret"));
    const response = await POST(new Request("https://app.test/api/webhooks/jira", {
      method: "POST", body: "{}", headers: { authorization: "Bearer signed" },
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Jira webhook delivery was rejected." });
  });
});
