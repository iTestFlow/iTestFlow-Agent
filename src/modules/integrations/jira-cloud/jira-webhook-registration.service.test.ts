import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "webhook-local", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
}));

import { registerJiraProjectWebhook, renewJiraProjectWebhook } from "./jira-webhook-registration.service";

describe("Jira webhook registration", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("authorizes the workspace/project anchor before registering an expiring project webhook", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ project_key: "QA", webhook_id: null, webhook_status: null })
      .mockResolvedValueOnce({ id: "webhook-local" });
    mocks.sqlRun.mockResolvedValue(1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 7001 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerJiraProjectWebhook({
      workspaceId: "ws-1", projectId: "project-1", cloudId: "cloud-a", accessToken: "access-secret",
      callbackUrl: "https://app.example/api/webhooks/jira",
    })).resolves.toMatchObject({ webhookId: "7001" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.atlassian.com/ex/jira/cloud-a/rest/api/3/webhook",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer access-secret" }) }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.url).toMatch(/^https:\/\/app\.example\/api\/webhooks\/jira\?registration=[A-Za-z0-9_-]+$/);
    expect(body.webhooks).toEqual([{ jqlFilter: 'project = "QA"', events: ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted"] }]);
    expect(mocks.sqlGet.mock.calls[2][1].callbackKeyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not contact Jira for an untrusted workspace/project/site combination", async () => {
    mocks.sqlGet.mockResolvedValue(undefined);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(registerJiraProjectWebhook({
      workspaceId: "ws-1", projectId: "project-other", cloudId: "cloud-b", accessToken: "access", callbackUrl: "https://app.example/api/webhooks/jira",
    })).rejects.toThrow("not authorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews with Atlassian's refresh endpoint and persists the returned absolute expiry", async () => {
    mocks.sqlGet.mockResolvedValue({ webhook_id: "7001", cloud_id: "cloud-a" });
    mocks.sqlRun.mockResolvedValue(1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ expirationDate: "2026-09-12T00:00:00.000+0000" }), { status: 200 })));
    await expect(renewJiraProjectWebhook({ workspaceId: "ws-1", projectId: "project-1", accessToken: "access" }))
      .resolves.toEqual({ expiresAt: "2026-09-12T00:00:00.000Z" });
  });

  it("compensates a newly created remote webhook when local persistence fails", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ project_key: "QA", webhook_id: null, webhook_status: null })
      .mockResolvedValueOnce({ id: "webhook-local" });
    mocks.sqlRun.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ webhookRegistrationResult: [{ createdWebhookId: 7001 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerJiraProjectWebhook({
      workspaceId: "ws-1", projectId: "project-1", cloudId: "cloud-a", accessToken: "access", callbackUrl: "https://app.example/api/webhooks/jira",
    })).rejects.toThrow("could not be persisted");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
    expect(mocks.sqlRun.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM jira_webhooks WHERE id"))).toBe(true);
  });

  it("reconciles an uncertain registration by callback hash on the next call", async () => {
    const callbackToken = "registration-secret";
    const { createHash } = await import("node:crypto");
    mocks.sqlGet
      .mockResolvedValueOnce({ id: "webhook-local", callback_key_hash: createHash("sha256").update(callbackToken).digest("hex") });
    mocks.sqlRun.mockResolvedValue(1);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      values: [{ id: 7001, url: `https://app.example/api/webhooks/jira?registration=${callbackToken}`, expirationDate: "2026-09-12T00:00:00.000+0000" }],
      total: 1, startAt: 0, maxResults: 100,
    }), { status: 200 })));
    await expect(registerJiraProjectWebhook({
      workspaceId: "ws-1", projectId: "project-1", cloudId: "cloud-a", accessToken: "access", callbackUrl: "https://app.example/api/webhooks/jira",
    })).resolves.toEqual({ webhookId: "7001", expiresAt: "2026-09-12T00:00:00.000Z" });
    expect(String(mocks.sqlGet.mock.calls[0][0])).toContain("registration_uncertain");
  });
});
