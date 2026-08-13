import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "event-1", nowIso: () => "2026-08-13T00:00:00.000Z",
  sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
}));

import { acceptJiraWebhookEvent } from "./jira-webhook-events.service";

describe("acceptJiraWebhookEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("anchors a delivery to a registered webhook and inserts it idempotently", async () => {
    mocks.sqlGet.mockResolvedValue({ workspace_id: "ws-1", project_id: "project-1", cloud_id: "cloud-a" });
    mocks.sqlRun.mockResolvedValue(1);
    await expect(acceptJiraWebhookEvent({
      deliveryId: "delivery-7", retryCount: 2,
      registrationToken: "registration-secret",
      payload: { webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001], issue: { id: "10001" } },
      rawPayload: "{\"webhookEvent\":\"jira:issue_updated\"}",
    })).resolves.toEqual({ accepted: true, duplicate: false });
    const [sql, params] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (cloud_id, delivery_id) DO NOTHING");
    expect(params).toMatchObject({ workspaceId: "ws-1", projectId: "project-1", cloudId: "cloud-a", deliveryId: "delivery-7", retryCount: 2 });
    expect(params.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("acknowledges a retry without creating a second event", async () => {
    mocks.sqlGet.mockResolvedValue({ workspace_id: "ws-1", project_id: "project-1", cloud_id: "cloud-a" });
    mocks.sqlRun.mockResolvedValue(0);
    await expect(acceptJiraWebhookEvent({
      deliveryId: "delivery-7", retryCount: 1,
      registrationToken: "registration-secret",
      payload: { webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001] }, rawPayload: "{}",
    })).resolves.toEqual({ accepted: true, duplicate: true });
  });

  it("rejects missing delivery identity and unmatched webhook registrations before insert", async () => {
    await expect(acceptJiraWebhookEvent({
      deliveryId: "", retryCount: 0, payload: { webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001] }, rawPayload: "{}",
      registrationToken: "registration-secret",
    })).rejects.toThrow("delivery identifier");
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(acceptJiraWebhookEvent({
      deliveryId: "delivery-8", retryCount: 0, payload: { webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001] }, rawPayload: "{}",
      registrationToken: "registration-secret",
    })).rejects.toThrow("registered Jira webhook");
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });
});
