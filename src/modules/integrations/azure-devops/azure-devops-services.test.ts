import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createId: vi.fn(() => "audit-1"),
  nowIso: vi.fn(() => "2026-06-29T00:00:00.000Z"),
  sqlRun: vi.fn(async () => 1),
  enqueueBackgroundWrite: vi.fn((_label: string, operation: () => unknown) => operation()),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => db);

import { fakeAzureAdapter, projectScope, testCase } from "@/test/factories";
import { pushApprovedRequirementComment } from "./azure-devops-comment.service";
import { fetchProjectScopedLinkedTestCases } from "./azure-devops-linked-test-cases.service";
import { mapAzureTestCase, mapAzureWorkItem } from "./azure-devops-mapper";

describe("Azure DevOps mapping and focused services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps identities, tags, estimates, and relation IDs", () => {
    const mapped = mapAzureWorkItem({
      id: 123,
      fields: {
        "System.TeamProject": "Demo",
        "System.WorkItemType": "User Story",
        "System.Title": "Checkout",
        "System.AssignedTo": { displayName: "QA Owner" },
        "System.Tags": "one; two ;",
        "Microsoft.VSTS.Scheduling.StoryPoints": 5,
      },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://ado/_apis/wit/workItems/124" },
        { rel: "Microsoft.VSTS.Common.TestedBy-Forward", url: "https://ado/_apis/wit/workItems/200" },
      ],
    }, "azure-project");
    expect(mapped).toMatchObject({
      id: "123",
      assignedTo: "QA Owner",
      tags: ["one", "two"],
      storyPoints: 5,
      childLinks: ["124"],
      testedByLinks: ["200"],
    });
  });

  it("maps parent, related, and tests relation links", () => {
    const mapped = mapAzureWorkItem({
      id: 500,
      fields: { "System.Title": "Linked" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://ado/_apis/wit/workItems/400" },
        { rel: "System.LinkTypes.Related", url: "https://ado/_apis/wit/workItems/401" },
        { rel: "Microsoft.VSTS.Common.Tests-Forward", url: "https://ado/_apis/wit/workItems/402" },
      ],
    }, "azure-project");
    expect(mapped).toMatchObject({
      parentLinks: ["400"],
      relatedLinks: ["401"],
      testsLinks: ["402"],
    });
  });

  it("reads AssignedTo provided as a plain string", () => {
    const mapped = mapAzureWorkItem({
      id: 600,
      fields: { "System.Title": "Direct", "System.AssignedTo": "Plain Owner" },
    }, "azure-project");
    expect(mapped.assignedTo).toBe("Plain Owner");
  });

  it("falls back to default title and work item type when fields are absent", () => {
    const mapped = mapAzureWorkItem({ id: 777 }, "azure-project");
    expect(mapped).toMatchObject({
      title: "Work Item 777",
      workItemType: "Unknown",
    });
    expect(mapped.parentLinks).toEqual([]);
    expect(mapped.relatedLinks).toEqual([]);
    expect(mapped.testsLinks).toEqual([]);
    expect(mapped.tags).toBeUndefined();
  });

  it("parses and decodes Azure test-step XML", () => {
    const mapped = mapAzureTestCase({
      id: 200,
      fields: {
        "System.Title": "Pay",
        "Microsoft.VSTS.Common.Priority": 2,
        "Microsoft.VSTS.TCM.Steps": "<steps><step><parameterizedString>&lt;b&gt;Click &amp; pay&lt;/b&gt;</parameterizedString><parameterizedString>Order &quot;done&quot;</parameterizedString></step></steps>",
      },
    }, "project");
    expect(mapped.steps).toEqual([{ action: "<b>Click & pay</b>", expectedResult: "Order \"done\"" }]);
  });

  it("returns an empty steps array when Steps field is missing or empty", () => {
    expect(mapAzureTestCase({ id: 300, fields: { "System.Title": "No steps" } }, "project").steps).toEqual([]);
    expect(mapAzureTestCase({
      id: 301,
      fields: { "System.Title": "Empty steps", "Microsoft.VSTS.TCM.Steps": "" },
    }, "project").steps).toEqual([]);
  });

  it("maps out-of-range priority to undefined", () => {
    expect(mapAzureTestCase({
      id: 302,
      fields: { "System.Title": "Bad priority", "Microsoft.VSTS.Common.Priority": 9 },
    }, "project").priority).toBeUndefined();
  });

  it("delegates comments with the trusted Azure project ID and audits success", async () => {
    const addWorkItemComment = vi.fn(async () => ({ success: true, commentId: "c1" }));
    const adapter = fakeAzureAdapter({ addWorkItemComment });
    await expect(pushApprovedRequirementComment(adapter, projectScope(), {
      actor: "qa", workItemId: "123", commentBody: "Approved",
    })).resolves.toEqual({ success: true, commentId: "c1" });
    expect(addWorkItemComment).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      workItemId: "123",
      commentBody: "Approved",
    });
    expect(db.enqueueBackgroundWrite).toHaveBeenCalledWith(
      "audit:azure_devops.push_requirement_comment",
      expect.any(Function),
    );
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        projectId: "project-1",
        azureProjectId: "azure-project-1",
        action: "azure_devops.push_requirement_comment",
        status: "Success",
        actor: "qa",
        entityId: "123",
      }),
    );
  });

  it("audits a failed push when the adapter reports failure", async () => {
    const addWorkItemComment = vi.fn(async () => ({ success: false }));
    const adapter = fakeAzureAdapter({ addWorkItemComment });
    await expect(pushApprovedRequirementComment(adapter, projectScope(), {
      actor: "qa", workItemId: "123", commentBody: "Approved",
    })).resolves.toEqual({ success: false });
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        action: "azure_devops.push_requirement_comment",
        status: "Failed",
        message: "Requirement comment push failed.",
      }),
    );
  });

  it("returns project-scoped linked cases and audits success", async () => {
    const fetchLinkedTestCases = vi.fn(async () => [testCase()]);
    const adapter = fakeAzureAdapter({ fetchLinkedTestCases });
    await expect(fetchProjectScopedLinkedTestCases(adapter, projectScope(), {
      actor: "qa", userStoryId: "123",
    })).resolves.toHaveLength(1);
    expect(fetchLinkedTestCases).toHaveBeenCalledWith({
      projectId: "azure-project-1",
      userStoryId: "123",
    });
    expect(db.enqueueBackgroundWrite).toHaveBeenCalledWith(
      "audit:azure_devops.fetch_linked_test_cases",
      expect.any(Function),
    );
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        projectId: "project-1",
        azureProjectId: "azure-project-1",
        action: "azure_devops.fetch_linked_test_cases",
        status: "Success",
        actor: "qa",
        entityId: "123",
      }),
    );
  });
});
