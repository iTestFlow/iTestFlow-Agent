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
        status: { name: "In Progress" }, assignee: { displayName: "Jamie" }, priority: { name: "High" }, labels: ["checkout"],
        created: "2026-08-01T00:00:00.000Z", updated: "2026-08-02T00:00:00.000Z",
      },
    }] }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = jiraAdapter();
    await expect(adapter.fetchWorkItems({ projectId: "10000", workItemTypes: ["Story"], states: ["In Progress"] }))
      .resolves.toMatchObject([{ id: "QA-7", azureProjectId: "10000", teamProject: "Quality", title: "Checkout", description: "Details" }]);
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
