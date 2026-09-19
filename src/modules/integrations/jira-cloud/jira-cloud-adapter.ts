import "server-only";

import { readBoundedDocumentResponse } from "@/modules/documents/bounded-document-response";
import type { WorkManagementProvider } from "../core/work-management-provider";
import type { TestManagementProvider } from "../core/test-management-provider";
import type {
  Area, AttachmentUpload, BugWorkItemInput, Iteration,
  ProjectUser, ProjectWorkItemMetadata, ProviderAuthenticatedUser, ProviderProject,
  Requirement, WorkItemAttachment, WorkItemAttachmentDownload, WorkItemRevision, WorkItemTypeField,
} from "../core/integration-types";
import { IntegrationError } from "../core/integration-error";
import { jiraApiBase, jiraFetch, type JiraAccessTokenSupplier, type JiraAuth, type JiraTokenKind, type JiraUnauthorizedHooks } from "./jira-http";

type Json = Record<string, unknown>;

export type JiraCloudFieldMapping = {
  bugIssueTypeId?: string;
  taskIssueTypeId?: string;
  severityFieldId?: string;
  priorityIds?: Partial<Record<1 | 2 | 3 | 4, string>>;
  acceptanceCriteriaFieldId?: string;
  storyPointsFieldId?: string;
};

/**
 * Credential shape mirrors jira_connections' discriminator: the api_token arm
 * keeps its historical field layout (credentialKind optional so existing
 * construction sites read unchanged); the oauth arm supplies an async bearer
 * getter owned by the connection service, so a token refreshed mid-run is
 * picked up per request.
 */
export type JiraCloudSettings = {
  cloudId: string;
  siteUrl: string;
  fieldMapping?: JiraCloudFieldMapping;
} & (
  | { credentialKind?: "api_token"; email: string; apiToken: string; tokenKind: JiraTokenKind }
  | { credentialKind: "oauth"; getAccessToken: JiraAccessTokenSupplier }
);

export type JiraCloudHooks = JiraUnauthorizedHooks;

export type JiraCloudProjectScope = {
  jiraProjectId: string;
  jiraProjectKey: string;
  jiraProjectName: string;
};

const ISSUE_FIELDS = [
  "project", "issuetype", "summary", "description", "status", "assignee", "priority", "labels",
  "created", "updated", "resolutiondate", "parent", "subtasks", "issuelinks", "fixVersions", "components",
];
const RESERVED_CREATE_FIELDS = new Set(["project", "issuetype", "summary", "description", "priority", "assignee", "parent"]);

export class JiraCloudAdapter implements WorkManagementProvider, TestManagementProvider {
  private readonly baseUrl: string;
  private readonly siteUrl: string;
  private readonly auth: JiraAuth;
  private readonly hooks?: JiraCloudHooks;
  private readonly scope?: JiraCloudProjectScope;
  private readonly mapping: JiraCloudFieldMapping;

  constructor(settings: JiraCloudSettings, scope?: JiraCloudProjectScope, hooks?: JiraCloudHooks) {
    this.baseUrl = jiraApiBase(settings);
    this.siteUrl = settings.siteUrl.replace(/\/+$/, "");
    this.auth = settings.credentialKind === "oauth"
      ? { kind: "bearer", getToken: settings.getAccessToken }
      : { kind: "basic", email: settings.email, apiToken: settings.apiToken };
    this.hooks = hooks;
    this.scope = scope;
    this.mapping = settings.fieldMapping ?? {};
  }

  async testConnection(): Promise<boolean> {
    try { await this.fetchAuthenticatedUser(); return true; } catch { return false; }
  }

  /** Classic tokens with restricted profile visibility may omit the email; consumers must tolerate an absent uniqueName/emailAddress. */
  async fetchAuthenticatedUser(): Promise<ProviderAuthenticatedUser> {
    const user = await this.requestJson<Json>("/myself");
    return {
      id: text(user.accountId),
      displayName: text(user.displayName) ?? "Jira user",
      uniqueName: text(user.emailAddress),
      emailAddress: text(user.emailAddress),
      imageUrl: text(object(user.avatarUrls)?.["48x48"]),
    };
  }

  async fetchProjects(): Promise<ProviderProject[]> {
    const projects: Json[] = [];
    let startAt = 0;
    while (true) {
      const response = await this.requestJson<{ values?: Json[]; total?: number; startAt?: number; maxResults?: number }>(`/project/search?startAt=${startAt}`);
      projects.push(...(response.values ?? []));
      const pageSize = response.maxResults ?? response.values?.length ?? 0;
      startAt = (response.startAt ?? startAt) + pageSize;
      if (!pageSize || response.total === undefined || startAt >= response.total) break;
    }
    return projects.map((project) => ({
      id: requiredText(project.id),
      key: text(project.key),
      name: requiredText(project.name),
      url: text(project.key) ? `${this.siteUrl}/jira/software/projects/${encodeURIComponent(requiredText(project.key))}` : undefined,
      state: text(project.projectTypeKey),
    }));
  }

  async fetchIterations(input: { projectId: string }): Promise<Iteration[]> {
    this.assertProjectInput(input.projectId);
    const versions = await this.requestJson<Json[]>(`/project/${encodeURIComponent(input.projectId)}/versions`);
    return versions.map((version) => ({
      id: requiredText(version.id), name: requiredText(version.name), path: requiredText(version.name),
      startDate: text(version.startDate), finishDate: text(version.releaseDate),
    }));
  }

  async fetchAreas(input: { projectId: string }): Promise<Area[]> {
    this.assertProjectInput(input.projectId);
    const components = await this.requestJson<Json[]>(`/project/${encodeURIComponent(input.projectId)}/components`);
    return components.map((component) => ({ id: requiredText(component.id), name: requiredText(component.name), path: requiredText(component.name) }));
  }

  async fetchProjectUsers(input: { projectId: string }): Promise<ProjectUser[]> {
    this.assertProjectInput(input.projectId);
    const users = await this.requestJson<Json[]>(`/user/assignable/search?project=${encodeURIComponent(input.projectId)}&maxResults=1000`);
    return users.map((user) => ({
      id: requiredText(user.accountId), displayName: requiredText(user.displayName),
      uniqueName: text(user.emailAddress), imageUrl: text(object(user.avatarUrls)?.["48x48"]),
    }));
  }

  async fetchProjectWorkItemMetadata(input: { projectId: string; includeStates?: boolean }): Promise<ProjectWorkItemMetadata> {
    this.assertProjectInput(input.projectId);
    const project = await this.requestJson<Json>(`/project/${encodeURIComponent(input.projectId)}?expand=description,lead,issueTypes`);
    const workItemTypes = array(project.issueTypes).map((type) => text(type.name)).filter(defined);
    if (input.includeStates === false) return { workItemTypes, states: [] };
    const statuses = await this.requestJson<Json[]>(`/project/${encodeURIComponent(input.projectId)}/statuses`);
    return { workItemTypes, states: unique(statuses.flatMap((type) => array(type.statuses).map((status) => text(status.name)).filter(defined))) };
  }

  async fetchWorkItemTypeFields(input: { projectId: string; workItemType: string }): Promise<WorkItemTypeField[]> {
    this.assertProjectInput(input.projectId);
    const response = await this.requestJson<{ projects?: Json[] }>(
      `/issue/createmeta?projectIds=${encodeURIComponent(input.projectId)}&issuetypeNames=${encodeURIComponent(input.workItemType)}&expand=projects.issuetypes.fields`,
    );
    const fields = object(array(array(response.projects)[0]?.issuetypes)[0]?.fields) ?? {};
    return Object.entries(fields).map(([referenceName, value]) => {
      const field = object(value) ?? {};
      return {
        name: text(field.name) ?? referenceName,
        referenceName,
        type: text(object(field.schema)?.type),
        required: field.required === true,
        allowedValues: array(field.allowedValues).map((item) => text(item.value) ?? text(item.name) ?? text(item.id)).filter(defined),
      };
    });
  }

  async fetchWorkItems(input: {
    projectId: string; workItemTypes?: string[]; states?: string[]; areaPath?: string; iterationPath?: string;
    assignedTo?: string; assignedToMe?: boolean; limit?: number;
  }): Promise<Requirement[]> {
    this.assertProjectInput(input.projectId);
    const clauses = [`project = ${jqlString(input.projectId)}`];
    if (input.workItemTypes?.length) clauses.push(`issuetype IN (${input.workItemTypes.map(jqlString).join(",")})`);
    if (input.states?.length) clauses.push(`status IN (${input.states.map(jqlString).join(",")})`);
    if (input.areaPath) clauses.push(`component = ${jqlString(input.areaPath)}`);
    if (input.iterationPath) clauses.push(`fixVersion = ${jqlString(input.iterationPath)}`);
    if (input.assignedToMe) clauses.push("assignee = currentUser()");
    else if (input.assignedTo) clauses.push(`assignee = ${jqlString(input.assignedTo)}`);
    const limit = input.limit ?? 200;
    const issues = await this.searchIssues(clauses.join(" AND "), limit);
    return issues.slice(0, limit).map((issue) => this.mapIssue(issue));
  }

  async fetchWorkItemById(input: { projectId: string; workItemId: string }): Promise<Requirement> {
    this.assertProjectInput(input.projectId);
    const issue = await this.requestJson<Json>(`/issue/${encodeURIComponent(input.workItemId)}?fields=${encodeURIComponent(this.fields().join(","))}`);
    this.assertIssueScope(issue);
    return this.mapIssue(issue);
  }

  async fetchWorkItemAttachments(input: { projectId: string; workItemId: string }): Promise<WorkItemAttachment[]> {
    return (await this.readIssueAttachments(input)).attachments;
  }

  async downloadWorkItemAttachment(input: {
    projectId: string;
    workItemId: string;
    attachmentId: string;
  }): Promise<WorkItemAttachmentDownload> {
    const { attachments } = await this.readIssueAttachments(input);
    const attachment = attachments.find((candidate) => candidate.id === input.attachmentId.trim());
    if (!attachment) throw jiraAttachmentNotFoundError();

    const downloaded = await this.requestAttachmentBytes(`/attachment/content/${encodeURIComponent(attachment.id)}?redirect=false`);
    return {
      attachment: {
        ...attachment,
        contentType: downloaded.contentType ?? attachment.contentType,
        size: downloaded.content.byteLength,
      },
      content: downloaded.content,
    };
  }

  async fetchWorkItemsByIds(input: { projectId: string; workItemIds: string[] }): Promise<Requirement[]> {
    if (!input.workItemIds.length) return [];
    this.assertProjectInput(input.projectId);
    const issues = await this.searchIssues(
      `project = ${jqlString(input.projectId)} AND key IN (${input.workItemIds.map(jqlString).join(",")})`,
      input.workItemIds.length,
    );
    return issues.map((issue) => this.mapIssue(issue));
  }

  async fetchLinkedWorkItems(input: { projectId: string; workItemId: string }): Promise<Requirement[]> {
    this.assertProjectInput(input.projectId);
    const issue = await this.requestJson<Json>(`/issue/${encodeURIComponent(input.workItemId)}?fields=project,issuelinks,parent,subtasks`);
    this.assertIssueScope(issue);
    const fields = object(issue.fields) ?? {};
    const keys = unique([
      text(object(fields.parent)?.key),
      ...array(fields.subtasks).map((item) => text(item.key)),
      ...array(fields.issuelinks).flatMap((link) => [text(object(link.inwardIssue)?.key), text(object(link.outwardIssue)?.key)]),
    ].filter(defined));
    return this.fetchWorkItemsByIds({ projectId: input.projectId, workItemIds: keys });
  }

  async fetchLinkedRequirementWorkItems(input: { projectId: string; workItemId: string; workItemTypes: string[] }): Promise<Requirement[]> {
    return (await this.fetchLinkedWorkItems(input)).filter((item) => input.workItemTypes.includes(item.workItemType));
  }

  async fetchWorkItemRevisions(input: { projectId: string; workItemTypes: string[]; startDateTime: string; fields: string[]; limit?: number }): Promise<WorkItemRevision[]> {
    this.assertProjectInput(input.projectId);
    throw new IntegrationError({
      providerId: "jira-cloud", code: "integration_unsupported_capability",
      message: "Jira Cloud revision history is not supported by this provider version.",
    });
  }

  async addWorkItemComment(input: { projectId: string; workItemId: string; commentBody: string }) {
    await this.fetchWorkItemById({ projectId: input.projectId, workItemId: input.workItemId });
    const response = await this.requestJson<Json>(`/issue/${encodeURIComponent(input.workItemId)}/comment`, {
      method: "POST", body: JSON.stringify({ body: adf(input.commentBody) }),
    });
    return { success: true, commentId: text(response.id) };
  }

  async createChildTask(input: { projectId: string; parentStoryId: string; title: string; description?: string; assignedTo?: string; originalEstimate?: number; copyEstimateToRemainingWork?: boolean; areaPath?: string; iterationPath?: string }) {
    if (!this.mapping.taskIssueTypeId) return { success: false, error: "Jira task issue type mapping is not configured." };
    await this.fetchWorkItemById({ projectId: input.projectId, workItemId: input.parentStoryId });
    const response = await this.createIssue(input.projectId, {
      summary: input.title, issuetype: { id: this.mapping.taskIssueTypeId }, parent: { key: input.parentStoryId },
      ...(input.description ? { description: adf(input.description) } : {}),
      ...(input.assignedTo ? { assignee: { accountId: input.assignedTo } } : {}),
    });
    return { success: true, azureTaskId: text(response.key) ?? text(response.id) };
  }

  async createBug(input: { projectId: string; bug: BugWorkItemInput }) {
    if (!this.mapping.bugIssueTypeId) return { success: false, error: "Jira bug issue type mapping is not configured." };
    const customEntries = input.bug.customFields ?? [];
    const invalid = customEntries.find((field) => isReservedCreateField(field.referenceName));
    if (invalid) throw new Error(`Custom field ${invalid.referenceName} is a reserved Jira field.`);
    if (this.mapping.severityFieldId && isReservedCreateField(this.mapping.severityFieldId)) {
      throw new Error(`Configured severity field ${this.mapping.severityFieldId} is a reserved Jira field.`);
    }
    if (input.bug.parentStoryId) {
      await this.fetchWorkItemById({ projectId: input.projectId, workItemId: input.bug.parentStoryId });
    }
    const custom = Object.fromEntries(customEntries.map((field) => [field.referenceName, field.value]));
    if (this.mapping.severityFieldId) custom[this.mapping.severityFieldId] = input.bug.severity;
    const response = await this.createIssue(input.projectId, {
      ...custom,
      summary: input.bug.title, description: adf(input.bug.reproStepsHtml), issuetype: { id: this.mapping.bugIssueTypeId },
      ...(this.mapping.priorityIds?.[input.bug.priority] ? { priority: { id: this.mapping.priorityIds[input.bug.priority] } } : {}),
      ...(input.bug.assignedTo ? { assignee: { accountId: input.bug.assignedTo } } : {}),
      ...(input.bug.parentStoryId ? { parent: { key: input.bug.parentStoryId } } : {}),
    });
    return { success: true, azureBugId: text(response.key) ?? text(response.id) };
  }

  async uploadWorkItemAttachment(input: { projectId: string; attachment: AttachmentUpload }) {
    this.assertProjectInput(input.projectId);
    return { success: false, error: "Jira attachments require a target issue and are not enabled in this provider version." };
  }

  async attachFileToWorkItem(input: { projectId: string; workItemId: string; attachmentUrl: string; fileName: string; comment?: string }) {
    const body = input.comment ? `${input.comment}\n\n${input.fileName}: ${input.attachmentUrl}` : `${input.fileName}: ${input.attachmentUrl}`;
    await this.addWorkItemComment({ projectId: input.projectId, workItemId: input.workItemId, commentBody: body });
    return { success: true };
  }

  buildWorkItemWebUrl(input: { projectId: string; projectName?: string; workItemId: string }): string {
    return `${this.siteUrl}/browse/${encodeURIComponent(input.workItemId)}`;
  }

  async updateIssueFields(input: { issueKey: string; fields: Record<string, unknown> }): Promise<void> {
    const issueKey = input.issueKey.trim();
    if (!issueKey || !input.fields || Object.keys(input.fields).length === 0) throw new Error("Jira sync field update is invalid.");
    const keys = Object.keys(input.fields);
    if (keys.some((field) => !/^(summary|description|labels|priority|customfield_[0-9]+)$/.test(field))) {
      throw new Error("Jira sync field update contains an unsupported field.");
    }
    await this.fetchScopedIssue(issueKey);
    await this.requestJson(`/issue/${encodeURIComponent(issueKey)}`, { method: "PUT", body: JSON.stringify({ fields: input.fields }) });
  }

  async transitionIssue(input: { issueKey: string; statusName: string }): Promise<void> {
    const issueKey = input.issueKey.trim();
    const statusName = input.statusName.trim();
    if (!issueKey || !statusName) throw new Error("Jira sync transition is invalid.");
    await this.fetchScopedIssue(issueKey);
    const response = await this.requestJson<{ transitions?: Array<{ id?: string; to?: { name?: string } }> }>(`/issue/${encodeURIComponent(issueKey)}/transitions`);
    const matches = (response.transitions ?? []).filter((transition) => transition.to?.name?.toLocaleLowerCase() === statusName.toLocaleLowerCase() && transition.id);
    if (matches.length !== 1) throw new Error("The requested Jira status transition is not uniquely available.");
    await this.requestJson(`/issue/${encodeURIComponent(issueKey)}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: matches[0].id } }) });
  }

  fetchLinkedTestCases(): Promise<never> { return this.unsupportedTestManagement(); }
  fetchTestCasesByIds(): Promise<never> { return this.unsupportedTestManagement(); }
  fetchTestPlans(): Promise<never> { return this.unsupportedTestManagement(); }
  fetchTestSuites(): Promise<never> { return this.unsupportedTestManagement(); }
  fetchTestSuiteTree(): Promise<never> { return this.unsupportedTestManagement(); }
  createTestSuite(): Promise<never> { return this.unsupportedTestManagement(); }
  deleteTestSuite(): Promise<never> { return this.unsupportedTestManagement(); }
  fetchTestPoints(): Promise<never> { return this.unsupportedTestManagement(); }
  fetchTestRuns(): Promise<never> { return this.unsupportedTestManagement(); }
  fetchTestResults(): Promise<never> { return this.unsupportedTestManagement(); }
  addTestCasesToSuite(): Promise<never> { return this.unsupportedTestManagement(); }
  addTestCaseToSuite(): Promise<never> { return this.unsupportedTestManagement(); }
  updateTestPoints(): Promise<never> { return this.unsupportedTestManagement(); }
  createTestCase(): Promise<never> { return this.unsupportedTestManagement(); }
  createRequirementBasedSuite(): Promise<never> { return this.unsupportedTestManagement(); }
  linkTestCaseToUserStory(): Promise<never> { return this.unsupportedTestManagement(); }
  linkTestCaseToWorkItem(): Promise<never> { return this.unsupportedTestManagement(); }

  private fields() {
    return unique([...ISSUE_FIELDS, ...Object.values(this.mapping).filter((value): value is string => typeof value === "string")]);
  }

  private async searchIssues(jql: string, limit: number): Promise<Json[]> {
    const issues: Json[] = [];
    let nextPageToken: string | undefined;
    do {
      const response = await this.requestJson<{ issues?: Json[]; nextPageToken?: string; isLast?: boolean }>("/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql, fields: this.fields(), maxResults: Math.min(100, limit - issues.length),
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
      });
      issues.push(...(response.issues ?? []));
      nextPageToken = response.isLast ? undefined : response.nextPageToken;
    } while (nextPageToken && issues.length < limit);
    return issues.slice(0, limit);
  }

  private unsupportedTestManagement(): Promise<never> {
    return Promise.reject(new IntegrationError({
      providerId: "jira-cloud",
      code: "integration_unsupported_capability",
      message: "This test management operation requires a configured backend and is not yet available for Jira Cloud projects. A workspace owner or admin can choose Plain Jira, Xray, or Zephyr Scale in Settings → Connections.",
    }));
  }

  private async createIssue(projectId: string, fields: Json) {
    this.assertProjectInput(projectId);
    return this.requestJson<Json>("/issue", { method: "POST", body: JSON.stringify({ fields: { ...fields, project: { id: projectId } } }) });
  }

  private async readIssueAttachments(input: { projectId: string; workItemId: string }): Promise<{
    sourceWorkItemId: string;
    attachments: WorkItemAttachment[];
  }> {
    this.assertProjectInput(input.projectId);
    const issue = await this.requestJson<Json>(
      `/issue/${encodeURIComponent(input.workItemId)}?fields=${encodeURIComponent("project,attachment")}`,
    );
    this.assertIssueScope(issue);
    const sourceWorkItemId = canonicalJiraIssueId(issue.id);
    if (!sourceWorkItemId) {
      throw new IntegrationError({
        providerId: "jira-cloud",
        code: "integration_invalid_response",
        message: "Jira Cloud returned an invalid attachment response.",
      });
    }
    const fields = object(issue.fields) ?? {};
    return {
      sourceWorkItemId,
      attachments: array(fields.attachment)
        .map((attachment) => mapJiraAttachment(attachment, sourceWorkItemId))
        .filter(defined),
    };
  }

  private async requestAttachmentBytes(path: string): Promise<{ content: ArrayBuffer; contentType?: string }> {
    const response = await jiraFetch(`${this.baseUrl}${path}`, {
      headers: { Accept: "application/octet-stream" },
      redirect: "error",
    }, this.auth, this.hooks);
    try {
      return {
        content: await readBoundedDocumentResponse(response),
        contentType: safeJiraAttachmentContentType(response.headers.get("content-type")),
      };
    } catch {
      throw new IntegrationError({
        providerId: "jira-cloud",
        code: "integration_unavailable",
        message: "Jira Cloud attachment download failed.",
      });
    }
  }

  private mapIssue(issue: Json): Requirement {
    this.assertIssueScope(issue);
    const fields = object(issue.fields) ?? {};
    const project = object(fields.project) ?? {};
    const mapping = this.mapping;
    return {
      id: text(issue.key) ?? requiredText(issue.id), revision: number(issue.id), azureProjectId: requiredText(project.id),
      teamProject: text(project.name), workItemType: text(object(fields.issuetype)?.name) ?? "Issue",
      title: text(fields.summary) ?? "Untitled Jira issue", description: adfText(fields.description),
      acceptanceCriteria: mapping.acceptanceCriteriaFieldId ? text(fields[mapping.acceptanceCriteriaFieldId]) : undefined,
      state: text(object(fields.status)?.name), assignedTo: text(object(fields.assignee)?.displayName),
      priority: number(object(fields.priority)?.id), tags: strings(fields.labels),
      areaPath: text(array(fields.components)[0]?.name), iterationPath: text(array(fields.fixVersions)[0]?.name),
      storyPoints: mapping.storyPointsFieldId ? number(fields[mapping.storyPointsFieldId]) : undefined,
      parentLinks: [text(object(fields.parent)?.key)].filter(defined), childLinks: array(fields.subtasks).map((item) => text(item.key)).filter(defined),
      relatedLinks: array(fields.issuelinks).flatMap((link) => [text(object(link.inwardIssue)?.key), text(object(link.outwardIssue)?.key)]).filter(defined),
      createdDate: text(fields.created), updatedDate: text(fields.updated), closedDate: text(fields.resolutiondate), raw: issue,
    };
  }

  private assertProjectInput(projectId: string) {
    if (!this.scope) throw new Error("A Jira project scope is required for this operation.");
    if (projectId !== this.scope.jiraProjectId && projectId !== this.scope.jiraProjectKey) {
      throw new Error(`Project ${projectId} is not the selected Jira project.`);
    }
  }

  private async fetchScopedIssue(issueKey: string) {
    if (!this.scope) throw new Error("A Jira project scope is required for this operation.");
    return this.fetchWorkItemById({ projectId: this.scope.jiraProjectId, workItemId: issueKey });
  }

  private assertIssueScope(issue: Json) {
    if (!this.scope) return;
    const project = object(object(issue.fields)?.project) ?? {};
    if (text(project.id) !== this.scope.jiraProjectId && text(project.key) !== this.scope.jiraProjectKey) {
      throw new Error(`Issue ${text(issue.key) ?? text(issue.id) ?? "unknown"} is not in the selected Jira project.`);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await jiraFetch(`${this.baseUrl}${path}`, init, this.auth, this.hooks);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

function adf(value: string) { return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] }; }
function adfText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const root = object(value); if (!root) return undefined;
  const parts: string[] = [];
  const visit = (node: unknown) => { const item = object(node); if (!item) return; if (typeof item.text === "string") parts.push(item.text); for (const child of array(item.content)) visit(child); };
  visit(root); return parts.join("\n") || undefined;
}
function jqlString(value: string) { return `"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"')}"`; }
function isReservedCreateField(value: string) { return RESERVED_CREATE_FIELDS.has(value.trim().toLocaleLowerCase()); }
function object(value: unknown): Json | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined; }
function array(value: unknown): Json[] { return Array.isArray(value) ? value.map(object).filter(defined) : []; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined; }
function requiredText(value: unknown): string { const result = text(value); if (!result) throw new Error("Jira Cloud returned an invalid response."); return result; }
function number(value: unknown): number | undefined { const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function defined<T>(value: T | undefined): value is T { return value !== undefined; }

function mapJiraAttachment(attachment: Json, sourceWorkItemId: string): WorkItemAttachment | undefined {
  const id = text(attachment.id)?.trim();
  if (!id) return undefined;
  return {
    id,
    sourceWorkItemId,
    fileName: safeJiraAttachmentFileName(attachment.filename, `Attachment ${id}`),
    contentType: safeJiraAttachmentContentType(attachment.mimeType),
    size: jiraAttachmentSize(attachment.size),
    createdAt: normalizedJiraAttachmentDate(attachment.created),
  };
}

function canonicalJiraIssueId(value: unknown): string | undefined {
  const candidate = text(value)?.trim();
  return candidate && /^\d+$/.test(candidate) ? candidate : undefined;
}

function safeJiraAttachmentFileName(value: unknown, fallback: string): string {
  const candidate = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 255)
    : "";
  return candidate || fallback;
}

function safeJiraAttachmentContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLocaleLowerCase();
  return candidate && candidate.length <= 255 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*[^;]+)?$/.test(candidate)
    ? candidate
    : undefined;
}

function jiraAttachmentSize(value: unknown): number | undefined {
  const candidate = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function normalizedJiraAttachmentDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function jiraAttachmentNotFoundError(): IntegrationError {
  return new IntegrationError({
    providerId: "jira-cloud",
    code: "integration_not_found",
    message: "The requested attachment is not attached to this Jira issue.",
  });
}
