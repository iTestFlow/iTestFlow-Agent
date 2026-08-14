import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "event-1", nowIso: () => "2026-08-13T00:00:00.000Z",
  sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
}));
vi.mock("@/modules/jobs/job-queue.service", () => ({ enqueueJob: mocks.enqueueJob }));

import { acceptJiraWebhookEvent } from "./jira-webhook-events.service";

describe("acceptJiraWebhookEvent", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.enqueueJob.mockResolvedValue("job-1"); });

  it("anchors a delivery to a registered webhook and inserts it idempotently", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ workspace_id: "ws-1", project_id: "project-1", cloud_id: "cloud-a" })
      .mockResolvedValueOnce({ id: "event-1", inserted: true, status: "pending" });
    await expect(acceptJiraWebhookEvent({
      deliveryId: "delivery-7", retryCount: 2,
      registrationToken: "registration-secret",
      payload: { webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001], issue: { id: "10001" } },
      rawPayload: "{\"webhookEvent\":\"jira:issue_updated\"}",
    })).resolves.toEqual({ accepted: true, duplicate: false });
    const [sql, params] = mocks.sqlGet.mock.calls[1];
    expect(sql).toContain("ON CONFLICT (cloud_id, delivery_id) DO NOTHING");
    expect(params).toMatchObject({ workspaceId: "ws-1", projectId: "project-1", cloudId: "cloud-a", deliveryId: "delivery-7", retryCount: 2 });
    expect(params.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.enqueueJob).toHaveBeenCalledWith({
      jobType: "jira_webhook_reconcile", workspaceId: "ws-1", projectId: "project-1",
      payload: { eventId: "event-1" }, dedupeKey: "jira_webhook:event-1", maxAttempts: 5,
      createdByUserId: null,
    });
  });

  it("acknowledges a retry without creating a second event", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ workspace_id: "ws-1", project_id: "project-1", cloud_id: "cloud-a" })
      .mockResolvedValueOnce({ id: "event-1", inserted: false, status: "pending" });
    await expect(acceptJiraWebhookEvent({
      deliveryId: "delivery-7", retryCount: 1,
      registrationToken: "registration-secret",
      payload: { webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001] }, rawPayload: "{}",
    })).resolves.toEqual({ accepted: true, duplicate: true });
    expect(mocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "jira_webhook:event-1" }));
  });

  it("does not enqueue a completed delivery again when Atlassian retries the acknowledgement", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ workspace_id: "ws-1", project_id: "project-1", cloud_id: "cloud-a" })
      .mockResolvedValueOnce({ id: "event-1", inserted: false, status: "completed" });
    await expect(acceptJiraWebhookEvent({
      deliveryId: "delivery-7", retryCount: 1, registrationToken: "registration-secret",
      payload: { webhookEvent: "jira:issue_updated", matchedWebhookIds: [7001] }, rawPayload: "{}",
    })).resolves.toEqual({ accepted: true, duplicate: true });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
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
