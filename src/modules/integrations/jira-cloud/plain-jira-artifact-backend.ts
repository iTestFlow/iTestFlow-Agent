import "server-only";

import { createHash } from "node:crypto";
import type { FinalApprovedTestCase } from "../core/integration-types";
import type { JiraCloudProjectScope } from "./jira-cloud-adapter";

export type PlainJiraArtifactSettings = {
  cloudId: string; siteUrl: string; accessToken: string; appBaseUrl: string;
  testCaseIssueTypeId: string; localIdFieldId: string;
};

const RESERVED = new Set(["project", "issuetype", "summary", "description", "labels", "parent"]);

export class PlainJiraArtifactBackend {
  private readonly baseUrl: string;
  constructor(private readonly settings: PlainJiraArtifactSettings, private readonly scope: JiraCloudProjectScope) {
    this.baseUrl = `https://api.atlassian.com/ex/jira/${encodeURIComponent(settings.cloudId.trim())}/rest/api/3`;
  }

  async createTestCase(input: { projectId: string; testCase: FinalApprovedTestCase }) {
    this.assertProject(input.projectId);
    if (!/^customfield_[0-9]+$/.test(this.settings.localIdFieldId) || RESERVED.has(this.settings.localIdFieldId.trim().toLowerCase())) {
      throw new Error(`Configured local identity field ${this.settings.localIdFieldId} is a reserved Jira field.`);
    }
    await this.fetchScopedIssue(input.testCase.targetUserStoryId);
    const existing = await this.findTestCaseByLocalId(input.testCase.localId);
    const fields: Record<string, unknown> = {};
    if (this.settings.localIdFieldId) fields[this.settings.localIdFieldId] = input.testCase.localId;
    Object.assign(fields, {
      summary: input.testCase.title,
      description: testCaseAdf(input.testCase),
      issuetype: { id: this.settings.testCaseIssueTypeId },
      labels: ["itestflow", "itestflow-test-case"],
      project: { id: this.scope.jiraProjectId },
    });
    const created = existing ? undefined : await this.request<{ id?: string; key?: string }>("/issue", { method: "POST", body: JSON.stringify({ fields }) });
    const remoteId = existing ?? created?.key ?? created?.id;
    if (!remoteId) throw new Error("Jira returned an invalid test-case issue.");
    await this.request(`/issue/${encodeURIComponent(remoteId)}/remotelink`, {
      method: "POST", body: JSON.stringify({
        globalId: `itestflow:test-case:${input.testCase.localId}`,
        object: {
        url: `${this.settings.appBaseUrl.replace(/\/+$/, "")}/test-cases/${encodeURIComponent(input.testCase.localId)}`,
        title: `iTestFlow test case ${input.testCase.localId}`,
      } }),
    });
    const commentMarker = `[itestflow:test-case:${createHash("sha256").update(input.testCase.localId, "utf8").digest("base64url")}]`;
    if (!await this.hasBacklinkComment(input.testCase.targetUserStoryId, commentMarker)) {
      await this.request(`/issue/${encodeURIComponent(input.testCase.targetUserStoryId)}/comment`, {
        method: "POST", body: JSON.stringify({ body: adf(`${commentMarker} Linked iTestFlow test case ${input.testCase.localId}: ${remoteId}`) }),
      });
    }
    return { success: true, azureTestCaseId: remoteId };
  }

  private async findTestCaseByLocalId(localId: string): Promise<string | undefined> {
    const result = await this.request<{ issues?: Array<{ key?: string; id?: string }> }>("/search/jql", {
      method: "POST", body: JSON.stringify({
        jql: `project = "${escapeJql(this.scope.jiraProjectKey)}" AND ${this.settings.localIdFieldId} = "${escapeJql(localId)}"`,
        fields: ["project"], maxResults: 2,
      }),
    });
    if ((result.issues?.length ?? 0) > 1) throw new Error("Multiple Jira artifacts use the same iTestFlow identity.");
    return result.issues?.[0]?.key ?? result.issues?.[0]?.id;
  }

  private async fetchScopedIssue(key: string) {
    const issue = await this.request<{ fields?: { project?: { id?: string; key?: string } } }>(`/issue/${encodeURIComponent(key)}?fields=project,summary,issuetype`);
    const project = issue.fields?.project;
    if (project?.id !== this.scope.jiraProjectId && project?.key !== this.scope.jiraProjectKey) {
      throw new Error("The target Jira issue is not in the selected project.");
    }
  }

  private async hasBacklinkComment(issueKey: string, marker: string): Promise<boolean> {
    let startAt = 0;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.request<{ comments?: Array<{ body?: unknown }>; isLast?: boolean; total?: number }>(
        `/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=100`,
      );
      const comments = result.comments ?? [];
      if (comments.some((comment) => JSON.stringify(comment.body ?? {}).includes(marker))) return true;
      startAt += comments.length;
      if (result.isLast === true || comments.length === 0 || (typeof result.total === "number" && startAt >= result.total)) return false;
    }
    throw new Error("Jira story comments exceed the safe backlink reconciliation limit.");
  }

  private assertProject(projectId: string) {
    if (projectId !== this.scope.jiraProjectId && projectId !== this.scope.jiraProjectKey) throw new Error("The selected Jira project does not match the target.");
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, cache: "no-store", headers: { Authorization: `Bearer ${this.settings.accessToken}`, Accept: "application/json", "Content-Type": "application/json" } });
    } catch { throw new Error("Plain Jira artifact publishing is unavailable."); }
    if (!response.ok) throw new Error("Plain Jira artifact publishing failed.");
    try { return await response.json() as T; } catch { throw new Error("Plain Jira returned an invalid response."); }
  }
}

function testCaseAdf(testCase: FinalApprovedTestCase) {
  const lines = [testCase.description, testCase.preconditions && `Preconditions: ${testCase.preconditions}`,
    ...testCase.steps.map((step, index) => `${index + 1}. ${step.action}\nExpected: ${step.expectedResult}`)].filter((value): value is string => Boolean(value));
  return adf(lines.join("\n\n"));
}
function adf(text: string) { return { type: "doc", version: 1, content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) }; }
function escapeJql(value: string) { return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
