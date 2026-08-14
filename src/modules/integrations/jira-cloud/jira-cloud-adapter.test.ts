import { beforeEach, describe, expect, it, vi } from "vitest";

import { JiraCloudAdapter } from "./jira-cloud-adapter";

describe("JiraCloudAdapter", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("uses the OAuth cloud API and maps projects and the authenticated user", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ values: [{ id: "10000", key: "QA", name: "Quality", projectTypeKey: "software" }] }))
      .mockResolvedValueOnce(json({ accountId: "acct-1", displayName: "Jamie", emailAddress: "j@example.com", avatarUrls: { "48x48": "avatar" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = jiraAdapter();
    await expect(adapter.fetchProjects()).resolves.toEqual([
      { id: "10000", key: "QA", name: "Quality", url: "https://quality.atlassian.net/jira/software/projects/QA", state: "software" },
    ]);
    await expect(adapter.fetchAuthenticatedUser()).resolves.toMatchObject({ id: "acct-1", displayName: "Jamie", emailAddress: "j@example.com" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.atlassian.com/ex/jira/cloud-a/rest/api/3/project/search?startAt=0");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer access-secret" }) });
  });

  it("maps JQL results and keeps all issue reads bound to the configured project", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ issues: [{
      id: "10001", key: "QA-7", fields: {
        project: { id: "10000", key: "QA", name: "Quality" }, issuetype: { name: "Story" },
        summary: "Checkout", description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }] },
        status: { name: "In Progress" }, assignee: { displayName: "Jamie" }, priority: { id: "10001", name: "High" }, labels: ["checkout"],
        created: "2026-08-01T00:00:00.000Z", updated: "2026-08-02T00:00:00.000Z",
      },
    }] }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = jiraAdapter();
    await expect(adapter.fetchWorkItems({ projectId: "10000", workItemTypes: ["Story"], states: ["In Progress"] }))
      .resolves.toMatchObject([{ id: "QA-7", azureProjectId: "10000", teamProject: "Quality", title: "Checkout", description: "Details", priority: 10001 }]);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.jql).toContain('project = "10000"');
    expect(request.jql).toContain('issuetype IN ("Story")');
    expect(request.jql).toContain('status IN ("In Progress")');
  });

  it("rejects a by-key issue from another project", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      id: "20001", key: "OTHER-1", fields: { project: { id: "20000", key: "OTHER", name: "Other" }, issuetype: { name: "Story" }, summary: "Secret" },
    })));
    await expect(jiraAdapter().fetchWorkItemById({ projectId: "10000", workItemId: "OTHER-1" }))
      .rejects.toThrow("not in the selected Jira project");
  });

  it("creates Jira comments and bugs using ADF and configured field mappings", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "10007", key: "QA-7", fields: { project: { id: "10000", key: "QA", name: "Quality" }, issuetype: { name: "Story" }, summary: "Story" } }))
      .mockResolvedValueOnce(json({ id: "1" }))
      .mockResolvedValueOnce(json({ id: "10009", key: "QA-9" }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = jiraAdapter();
    await expect(adapter.addWorkItemComment({ projectId: "10000", workItemId: "QA-7", commentBody: "Reviewed" }))
      .resolves.toEqual({ success: true, commentId: "1" });
    await expect(adapter.createBug({ projectId: "10000", bug: { title: "Broken", reproStepsHtml: "Steps", priority: 1, severity: "Critical" } }))
      .resolves.toEqual({ success: true, azureBugId: "QA-9" });
    const bugBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(bugBody.fields).toMatchObject({ project: { id: "10000" }, issuetype: { id: "bug-type" }, priority: { id: "highest-priority" }, customfield_10001: "Critical" });
  });

  it("rejects reserved custom fields before any cross-project write can be constructed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(jiraAdapter().createBug({
      projectId: "10000",
      bug: {
        title: "Broken", reproStepsHtml: "Steps", priority: 1, severity: "Critical",
        customFields: [{ referenceName: "project", value: "other-project" }],
      },
    })).rejects.toThrow("reserved Jira field");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects project-bound operations when constructed without a project scope", async () => {
    const adapter = new JiraCloudAdapter({ cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net", accessToken: "access" });
    await expect(adapter.fetchWorkItems({ projectId: "10000" })).rejects.toThrow("project scope is required");
  });

  it("follows Jira project and JQL pagination", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ values: [{ id: "1", key: "A", name: "A" }], total: 2, startAt: 0, maxResults: 1 }))
      .mockResolvedValueOnce(json({ values: [{ id: "2", key: "B", name: "B" }], total: 2, startAt: 1, maxResults: 1 }))
      .mockResolvedValueOnce(json({ issues: [{ id: "1", key: "QA-1", fields: { project: { id: "10000", name: "Quality" }, summary: "One", issuetype: { name: "Story" } } }], nextPageToken: "next" }))
      .mockResolvedValueOnce(json({ issues: [{ id: "2", key: "QA-2", fields: { project: { id: "10000", name: "Quality" }, summary: "Two", issuetype: { name: "Story" } } }], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(jiraAdapter().fetchProjects()).resolves.toHaveLength(2);
    await expect(jiraAdapter().fetchWorkItems({ projectId: "10000", limit: 2 })).resolves.toHaveLength(2);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({ nextPageToken: "next" });
  });

  it("follows Jira pagination when fetching an explicit set of issue keys", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ issues: [issue("1", "QA-1")], nextPageToken: "next" }))
      .mockResolvedValueOnce(json({ issues: [issue("2", "QA-2")], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(jiraAdapter().fetchWorkItemsByIds({ projectId: "10000", workItemIds: ["QA-1", "QA-2"] }))
      .resolves.toHaveLength(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ nextPageToken: "next" });
  });

  it("rejects a reserved configured severity field before writing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new JiraCloudAdapter({
      cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net", accessToken: "access-secret",
      fieldMapping: { bugIssueTypeId: "bug-type", severityFieldId: "summary" },
    }, { jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality" });

    await expect(adapter.createBug({
      projectId: "10000", bug: { title: "Broken", reproStepsHtml: "Steps", priority: 1, severity: "Critical" },
    })).rejects.toThrow("reserved Jira field");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bug parent outside the selected project before writing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(issue("20001", "OTHER-1", "20000", "OTHER")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(jiraAdapter().createBug({
      projectId: "10000",
      bug: { title: "Broken", reproStepsHtml: "Steps", priority: 1, severity: "Critical", parentStoryId: "OTHER-1" },
    })).rejects.toThrow("not in the selected Jira project");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates scoped Jira fields and transitions by status name for sync operations", async () => {
    const adapter = jiraAdapter() as JiraCloudAdapter & {
      updateIssueFields(input: { issueKey: string; fields: Record<string, unknown> }): Promise<void>;
      transitionIssue(input: { issueKey: string; statusName: string }): Promise<void>;
    };
    expect(typeof adapter.updateIssueFields).toBe("function");
    expect(typeof adapter.transitionIssue).toBe("function");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(issue("10001", "QA-7")))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(issue("10001", "QA-7")))
      .mockResolvedValueOnce(json({ transitions: [{ id: "31", to: { name: "Done" } }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await adapter.updateIssueFields({ issueKey: "QA-7", fields: { summary: "Updated" } });
    await adapter.transitionIssue({ issueKey: "QA-7", statusName: "Done" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ fields: { summary: "Updated" } });
    expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toEqual({ transition: { id: "31" } });
  });

  it("maps iterations, areas, users, project metadata, and create fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([{ id: 11, name: "Sprint 1", startDate: "2026-08-01", releaseDate: "2026-08-15" }]))
      .mockResolvedValueOnce(json([{ id: "21", name: "Checkout" }]))
      .mockResolvedValueOnce(json([{ accountId: "acct-1", displayName: "Jamie", emailAddress: "j@example.com", avatarUrls: { "48x48": "avatar" } }]))
      .mockResolvedValueOnce(json({ issueTypes: [{ name: "Story" }, { name: "Bug" }] }))
      .mockResolvedValueOnce(json([
        { statuses: [{ name: "Open" }, { name: "Done" }] },
        { statuses: [{ name: "Done" }] },
      ]))
      .mockResolvedValueOnce(json({ projects: [{ issuetypes: [{ fields: {
        summary: { name: "Summary", required: true, schema: { type: "string" } },
        priority: { allowedValues: [{ name: "High" }, { id: 2 }] },
      } }] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = jiraAdapter();

    await expect(adapter.fetchIterations({ projectId: "QA" })).resolves.toEqual([
      { id: "11", name: "Sprint 1", path: "Sprint 1", startDate: "2026-08-01", finishDate: "2026-08-15" },
    ]);
    await expect(adapter.fetchAreas({ projectId: "10000" })).resolves.toEqual([
      { id: "21", name: "Checkout", path: "Checkout" },
    ]);
    await expect(adapter.fetchProjectUsers({ projectId: "10000" })).resolves.toEqual([
      { id: "acct-1", displayName: "Jamie", uniqueName: "j@example.com", imageUrl: "avatar" },
    ]);
    await expect(adapter.fetchProjectWorkItemMetadata({ projectId: "10000" })).resolves.toEqual({
      workItemTypes: ["Story", "Bug"], states: ["Open", "Done"],
    });
    await expect(adapter.fetchWorkItemTypeFields({ projectId: "10000", workItemType: "Story" })).resolves.toEqual([
      { name: "Summary", referenceName: "summary", type: "string", required: true, allowedValues: [] },
      { name: "priority", referenceName: "priority", type: undefined, required: false, allowedValues: ["High", "2"] },
    ]);
  });

  it("skips the status request when project metadata excludes states", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ issueTypes: [{ name: "Task" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(jiraAdapter().fetchProjectWorkItemMetadata({ projectId: "10000", includeStates: false }))
      .resolves.toEqual({ workItemTypes: ["Task"], states: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps rich issues, filters JQL, and resolves linked requirements", async () => {
    const richIssue = {
      id: "10001", key: "QA-7", fields: {
        project: { id: "10000", key: "QA", name: "Quality" }, issuetype: { name: "Story" }, summary: "Checkout",
        description: "Plain details", status: { name: "Open" }, assignee: { displayName: "Jamie" }, priority: { id: "10001" },
        labels: ["api", 7], components: [{ name: "Payments" }], fixVersions: [{ name: "Sprint 1" }],
        parent: { key: "QA-1" }, subtasks: [{ key: "QA-8" }],
        issuelinks: [{ inwardIssue: { key: "QA-2" }, outwardIssue: { key: "QA-3" } }],
        customfield_10020: "Approved", customfield_10030: "5", resolutiondate: "2026-08-10",
      },
    };
    const linkedSource = {
      ...issue("10001", "QA-7"),
      fields: {
        ...issue("10001", "QA-7").fields,
        parent: { key: "QA-1" }, subtasks: [{ key: "QA-8" }],
        issuelinks: [{ inwardIssue: { key: "QA-2" }, outwardIssue: { key: "QA-3" } }],
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ issues: [richIssue], isLast: true }))
      .mockResolvedValueOnce(json(linkedSource))
      .mockResolvedValueOnce(json({
        issues: [
          issue("1", "QA-1"),
          { ...issue("2", "QA-2"), fields: { ...issue("2", "QA-2").fields, issuetype: { name: "Bug" } } },
        ],
        isLast: true,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new JiraCloudAdapter({
      cloudId: " cloud-a ", siteUrl: "https://quality.atlassian.net/", accessToken: "access-secret",
      fieldMapping: { acceptanceCriteriaFieldId: "customfield_10020", storyPointsFieldId: "customfield_10030" },
    }, { jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality" });

    await expect(adapter.fetchWorkItems({
      projectId: "10000", areaPath: "Payments", iterationPath: "Sprint 1", assignedTo: "acct-1", limit: 1,
    })).resolves.toMatchObject([{
      id: "QA-7", acceptanceCriteria: "Approved", storyPoints: 5, areaPath: "Payments", iterationPath: "Sprint 1",
      parentLinks: ["QA-1"], childLinks: ["QA-8"], relatedLinks: ["QA-2", "QA-3"], tags: ["api"], closedDate: "2026-08-10",
    }]);
    const firstJql = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).jql;
    expect(firstJql).toContain('component = "Payments"');
    expect(firstJql).toContain('fixVersion = "Sprint 1"');
    expect(firstJql).toContain('assignee = "acct-1"');
    await expect(adapter.fetchLinkedRequirementWorkItems({ projectId: "10000", workItemId: "QA-7", workItemTypes: ["Story"] }))
      .resolves.toEqual([expect.objectContaining({ id: "QA-1", workItemType: "Story" })]);
  });

  it("creates child tasks, attaches links as comments, and exposes safe helper fallbacks", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(issue("10001", "QA-1")))
      .mockResolvedValueOnce(json({ id: "10002", key: "QA-2" }))
      .mockResolvedValueOnce(json(issue("10002", "QA-2")))
      .mockResolvedValueOnce(json({ id: "comment-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = jiraAdapter();

    await expect(adapter.createChildTask({
      projectId: "10000", parentStoryId: "QA-1", title: "Implement", description: "Details", assignedTo: "acct-1",
    })).resolves.toEqual({ success: true, azureTaskId: "QA-2" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).fields).toMatchObject({
      project: { id: "10000" }, issuetype: { id: "task-type" }, parent: { key: "QA-1" }, assignee: { accountId: "acct-1" },
    });
    await expect(adapter.attachFileToWorkItem({
      projectId: "10000", workItemId: "QA-2", fileName: "evidence.txt", attachmentUrl: "https://files.example/evidence", comment: "Proof",
    })).resolves.toEqual({ success: true });
    await expect(adapter.uploadWorkItemAttachment({ projectId: "10000", attachment: {} as never }))
      .resolves.toEqual({ success: false, error: expect.stringContaining("require a target issue") });
    expect(adapter.buildWorkItemWebUrl({ projectId: "10000", workItemId: "QA 2" }))
      .toBe("https://quality.atlassian.net/browse/QA%202");

    const unconfigured = new JiraCloudAdapter(
      { cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net", accessToken: "access" },
      { jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality" },
    );
    await expect(unconfigured.createChildTask({ projectId: "10000", parentStoryId: "QA-1", title: "Task" }))
      .resolves.toEqual({ success: false, error: expect.stringContaining("task issue type") });
    await expect(unconfigured.createBug({ projectId: "10000", bug: { title: "Bug", reproStepsHtml: "Steps", priority: 1, severity: "High" } }))
      .resolves.toEqual({ success: false, error: expect.stringContaining("bug issue type") });
  });

  it("reports connection failures and maps fixed upstream error codes without leaking bodies", async () => {
    const adapter = jiraAdapter();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ accountId: "acct-1" })).mockRejectedValueOnce(new Error("secret network detail")));
    await expect(adapter.testConnection()).resolves.toBe(true);
    await expect(adapter.testConnection()).resolves.toBe(false);

    for (const [status, code] of [[401, "integration_auth_failed"], [403, "integration_permission_denied"], [404, "integration_not_found"], [429, "integration_rate_limited"], [503, "integration_unavailable"], [400, "integration_unknown"]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ secret: "do not leak" }, status)));
      await expect(adapter.fetchAuthenticatedUser()).rejects.toMatchObject({ code, message: "Jira Cloud request failed.", statusCode: status });
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("access-secret")));
    await expect(adapter.fetchAuthenticatedUser()).rejects.toMatchObject({ code: "integration_unavailable", message: "Jira Cloud is unavailable." });
  });

  it("rejects invalid sync mutations and ambiguous transitions before writing", async () => {
    const adapter = jiraAdapter();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(issue("10001", "QA-7")))
      .mockResolvedValueOnce(json({ transitions: [{ id: "1", to: { name: "Done" } }, { id: "2", to: { name: "done" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter.updateIssueFields({ issueKey: " ", fields: { summary: "x" } })).rejects.toThrow("field update is invalid");
    await expect(adapter.updateIssueFields({ issueKey: "QA-7", fields: {} })).rejects.toThrow("field update is invalid");
    await expect(adapter.updateIssueFields({ issueKey: "QA-7", fields: { project: { id: "20000" } } })).rejects.toThrow("unsupported field");
    await expect(adapter.transitionIssue({ issueKey: "", statusName: "Done" })).rejects.toThrow("transition is invalid");
    await expect(adapter.transitionIssue({ issueKey: "QA-7", statusName: "Done" })).rejects.toThrow("not uniquely available");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed for revision and unconfigured test-management capabilities", async () => {
    const adapter = jiraAdapter();
    await expect(adapter.fetchWorkItemRevisions({ projectId: "10000", workItemTypes: [], startDateTime: "2026-08-01", fields: [] }))
      .rejects.toMatchObject({ code: "integration_unsupported_capability" });

    const methods = [
      "fetchLinkedTestCases", "fetchTestCasesByIds", "fetchTestPlans", "fetchTestSuites", "fetchTestSuiteTree", "createTestSuite", "deleteTestSuite",
      "fetchTestPoints", "fetchTestRuns", "fetchTestResults", "addTestCasesToSuite", "addTestCaseToSuite", "updateTestPoints",
      "createTestCase", "createRequirementBasedSuite", "linkTestCaseToUserStory", "linkTestCaseToWorkItem",
    ] as const;
    for (const method of methods) {
      await expect((adapter[method] as (...args: unknown[]) => Promise<unknown>)())
        .rejects.toMatchObject({ code: "integration_unsupported_capability" });
    }
  });
});

function jiraAdapter() {
  return new JiraCloudAdapter({
    cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net", accessToken: "access-secret",
    fieldMapping: { bugIssueTypeId: "bug-type", taskIssueTypeId: "task-type", severityFieldId: "customfield_10001", priorityIds: { 1: "highest-priority" } },
  }, { jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality" });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function issue(id: string, key: string, projectId = "10000", projectKey = "QA") {
  return { id, key, fields: { project: { id: projectId, key: projectKey, name: projectKey }, summary: key, issuetype: { name: "Story" } } };
}
