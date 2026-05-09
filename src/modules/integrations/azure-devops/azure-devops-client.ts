import "server-only";

import type { AzureDevOpsAdapter } from "./azure-devops-adapter";
import { mapAzureTestCase, mapAzureWorkItem } from "./azure-devops-mapper";
import type {
  AzureAuthenticatedUser,
  AzureDevOpsSettings,
  AzureProject,
  FinalApprovedTestCase,
  Requirement,
  TestCase,
  TestPlan,
  TestSuite,
} from "./azure-devops-types";

type JsonValue = Record<string, unknown>;

export class AzureDevOpsRestAdapter implements AzureDevOpsAdapter {
  private readonly organizationUrl: string;
  private readonly pat: string;

  constructor(settings: AzureDevOpsSettings) {
    this.organizationUrl = settings.organizationUrl.replace(/\/$/, "");
    this.pat = settings.personalAccessToken;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.requestJson<{ value?: Array<JsonValue> }>("_apis/projects?api-version=7.1");
      return true;
    } catch {
      return false;
    }
  }

  async fetchAuthenticatedUser(): Promise<AzureAuthenticatedUser> {
    const json = await this.requestJson<{
      authenticatedUser?: {
        id?: string;
        providerDisplayName?: string;
        customDisplayName?: string;
        displayName?: string;
        userName?: string;
        uniqueName?: string;
        imageUrl?: string;
      };
    }>("_apis/connectionData?api-version=7.1-preview.1");
    const user = json.authenticatedUser;
    return {
      id: user?.id,
      displayName: user?.providerDisplayName ?? user?.customDisplayName ?? user?.displayName ?? user?.userName ?? "Azure DevOps user",
      uniqueName: user?.uniqueName ?? user?.userName,
      imageUrl: user?.imageUrl,
    };
  }

  async fetchProjects(): Promise<AzureProject[]> {
    const json = await this.requestJson<{ value?: Array<JsonValue> }>("_apis/projects?api-version=7.1");
    return (json.value ?? []).map((project) => ({
      id: String(project.id),
      name: String(project.name),
      url: typeof project.url === "string" ? project.url : undefined,
      state: typeof project.state === "string" ? project.state : undefined,
      visibility: typeof project.visibility === "string" ? project.visibility : undefined,
    }));
  }

  async fetchWorkItems(input: {
    projectId: string;
    workItemTypes?: string[];
    states?: string[];
    areaPath?: string;
    iterationPath?: string;
  }): Promise<Requirement[]> {
    const types = input.workItemTypes?.length ? input.workItemTypes : ["Epic", "Feature", "User Story", "Bug"];
    const where = [
      `[System.TeamProject] = @project`,
      `[System.WorkItemType] IN (${types.map((type) => `'${escapeWiqlValue(type)}'`).join(", ")})`,
    ];
    if (input.states?.length) {
      where.push(`[System.State] IN (${input.states.map((state) => `'${escapeWiqlValue(state)}'`).join(", ")})`);
    }
    if (input.areaPath) where.push(`[System.AreaPath] UNDER '${escapeWiqlValue(input.areaPath)}'`);
    if (input.iterationPath) where.push(`[System.IterationPath] UNDER '${escapeWiqlValue(input.iterationPath)}'`);

    const wiql = {
      query: `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`,
    };
    const query = await this.requestJson<{ workItems?: Array<{ id: number }> }>(
      `${encodeURIComponent(input.projectId)}/_apis/wit/wiql?api-version=7.1`,
      { method: "POST", body: JSON.stringify(wiql) },
    );
    const ids = (query.workItems ?? []).slice(0, 200).map((item) => item.id);
    if (!ids.length) return [];
    return this.fetchWorkItemsBatch(input.projectId, ids);
  }

  async fetchWorkItemById(input: { projectId: string; workItemId: string }): Promise<Requirement> {
    const item = await this.requestJson<JsonValue>(
      `${encodeURIComponent(input.projectId)}/_apis/wit/workitems/${input.workItemId}?$expand=Relations&api-version=7.1`,
    );
    return mapAzureWorkItem(item as never, input.projectId);
  }

  async fetchLinkedWorkItems(input: { projectId: string; workItemId: string }): Promise<Requirement[]> {
    const item = await this.fetchWorkItemById(input);
    const ids = [...(item.parentLinks ?? []), ...(item.childLinks ?? []), ...(item.relatedLinks ?? [])];
    if (!ids.length) return [];
    return this.fetchWorkItemsBatch(input.projectId, ids.map(Number));
  }

  async fetchLinkedRequirementWorkItems(input: {
    projectId: string;
    workItemId: string;
    workItemTypes: string[];
  }): Promise<Requirement[]> {
    if (!input.workItemTypes.length) return [];
    const workItemId = Number(input.workItemId);
    if (!Number.isFinite(workItemId)) return [];
    const ids = new Set<number>();
    const linkTypes = [
      "System.LinkTypes.Hierarchy-Forward",
      "System.LinkTypes.Hierarchy-Reverse",
      "System.LinkTypes.Related",
    ];
    const typeFilter = input.workItemTypes.map((type) => `'${escapeWiqlValue(type)}'`).join(", ");
    const linkTypeFilter = linkTypes.map((type) => `'${type}'`).join(", ");

    const outgoing = await this.queryLinkedWorkItemIds(
      input.projectId,
      `SELECT [System.Id] FROM workItemLinks
       WHERE ([Source].[System.TeamProject] = @project AND [Source].[System.Id] = ${workItemId})
         AND ([System.Links.LinkType] IN (${linkTypeFilter}))
         AND ([Target].[System.TeamProject] = @project AND [Target].[System.WorkItemType] IN (${typeFilter}))
       MODE (MustContain)`,
      "target",
    );
    outgoing.forEach((id) => ids.add(id));

    const incoming = await this.queryLinkedWorkItemIds(
      input.projectId,
      `SELECT [System.Id] FROM workItemLinks
       WHERE ([Target].[System.TeamProject] = @project AND [Target].[System.Id] = ${workItemId})
         AND ([System.Links.LinkType] IN (${linkTypeFilter}))
         AND ([Source].[System.TeamProject] = @project AND [Source].[System.WorkItemType] IN (${typeFilter}))
       MODE (MustContain)`,
      "source",
    );
    incoming.forEach((id) => ids.add(id));

    if (!ids.size) return [];
    return this.fetchWorkItemsBatch(input.projectId, [...ids]);
  }

  async fetchLinkedTestCases(input: { projectId: string; userStoryId: string }): Promise<TestCase[]> {
    const item = await this.fetchWorkItemById({ projectId: input.projectId, workItemId: input.userStoryId });
    const ids = [...(item.testedByLinks ?? []), ...(item.testsLinks ?? [])];
    if (!ids.length) return [];
    const workItems = await this.requestJson<{ value?: Array<JsonValue> }>(
      `${encodeURIComponent(input.projectId)}/_apis/wit/workitemsbatch?api-version=7.1`,
      {
        method: "POST",
        body: JSON.stringify({ ids: ids.map(Number), $expand: "Relations" }),
      },
    );
    return (workItems.value ?? []).map((workItem) => mapAzureTestCase(workItem as never, input.projectId));
  }

  async addWorkItemComment(input: {
    projectId: string;
    workItemId: string;
    commentBody: string;
  }): Promise<{ success: boolean; commentId?: string; error?: string }> {
    try {
      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workItems/${input.workItemId}/comments?api-version=7.1-preview.4`,
        { method: "POST", body: JSON.stringify({ text: input.commentBody }) },
      );
      return { success: true, commentId: String(json.id ?? "") };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps comment error" };
    }
  }

  async fetchTestPlans(input: { projectId: string }): Promise<TestPlan[]> {
    const json = await this.requestJson<{ value?: Array<JsonValue> }>(
      `${encodeURIComponent(input.projectId)}/_apis/testplan/plans?api-version=7.1`,
    );
    return (json.value ?? []).map((plan) => ({ id: String(plan.id), name: String(plan.name), raw: plan }));
  }

  async fetchTestSuites(input: { projectId: string; testPlanId: string }): Promise<TestSuite[]> {
    const json = await this.requestJson<{ value?: Array<JsonValue> }>(
      `${encodeURIComponent(input.projectId)}/_apis/testplan/Plans/${input.testPlanId}/suites?api-version=7.1`,
    );
    return (json.value ?? []).map((suite) => ({
      id: String(suite.id),
      name: String(suite.name),
      planId: input.testPlanId,
      raw: suite,
    }));
  }

  async createTestCase(input: {
    projectId: string;
    testCase: FinalApprovedTestCase;
  }): Promise<{ success: boolean; azureTestCaseId?: string; error?: string }> {
    try {
      const patch = [
        { op: "add", path: "/fields/System.Title", value: input.testCase.title },
        { op: "add", path: "/fields/System.Description", value: input.testCase.description ?? "" },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: mapPriority(input.testCase.priority) },
        { op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: toAzureStepsXml(input.testCase.steps) },
        ...(input.testCase.tags?.length ? [{ op: "add", path: "/fields/System.Tags", value: input.testCase.tags.join("; ") }] : []),
      ];
      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workitems/$Test%20Case?api-version=7.1`,
        {
          method: "POST",
          body: JSON.stringify(patch),
          contentType: "application/json-patch+json",
        },
      );
      return { success: true, azureTestCaseId: String(json.id) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps test case creation error" };
    }
  }

  async addTestCaseToSuite(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
    azureTestCaseId: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/test/Plans/${input.testPlanId}/suites/${input.testSuiteId}/testcases/${input.azureTestCaseId}?api-version=7.1`,
        { method: "POST" },
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps suite add error" };
    }
  }

  async linkTestCaseToUserStory(input: {
    projectId: string;
    userStoryId: string;
    azureTestCaseId: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const testCaseUrl = `${this.organizationUrl}/${encodeURIComponent(input.projectId)}/_apis/wit/workItems/${input.azureTestCaseId}`;
      await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workitems/${input.userStoryId}?api-version=7.1`,
        {
          method: "PATCH",
          contentType: "application/json-patch+json",
          body: JSON.stringify([{ op: "add", path: "/relations/-", value: { rel: "Microsoft.VSTS.Common.TestedBy-Forward", url: testCaseUrl } }]),
        },
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps link error" };
    }
  }

  private async fetchWorkItemsBatch(projectId: string, ids: number[]): Promise<Requirement[]> {
    const json = await this.requestJson<{ value?: Array<JsonValue> }>(
      `${encodeURIComponent(projectId)}/_apis/wit/workitemsbatch?api-version=7.1`,
      { method: "POST", body: JSON.stringify({ ids, $expand: "Relations" }) },
    );
    return (json.value ?? []).map((workItem) => mapAzureWorkItem(workItem as never, projectId));
  }

  private async queryLinkedWorkItemIds(projectId: string, query: string, side: "source" | "target") {
    const result = await this.requestJson<{
      workItemRelations?: Array<{
        source?: { id?: number };
        target?: { id?: number };
      }>;
    }>(
      `${encodeURIComponent(projectId)}/_apis/wit/wiql?api-version=7.1`,
      { method: "POST", body: JSON.stringify({ query }) },
    );
    return (result.workItemRelations ?? [])
      .map((relation) => relation[side]?.id)
      .filter((id): id is number => typeof id === "number");
  }

  private async requestJson<T>(path: string, init?: RequestInit & { contentType?: string }): Promise<T> {
    const response = await this.request(path, init);
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Azure DevOps request failed (${response.status}): ${body}`);
    }
    if (!isJsonResponse(response)) {
      throw new Error(
        `Azure DevOps returned a non-JSON response (${response.status}). Check that the organization URL and Personal Access Token are valid.`,
      );
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(
        `Azure DevOps returned malformed JSON (${response.status}). Check that the organization URL and Personal Access Token are valid.`,
      );
    }
  }

  private request(path: string, init?: RequestInit & { contentType?: string }) {
    const token = Buffer.from(`:${this.pat}`).toString("base64");
    return fetch(`${this.organizationUrl}/${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${token}`,
        Accept: "application/json",
        "Content-Type": init?.contentType ?? "application/json",
        ...(init?.headers ?? {}),
      },
    });
  }
}

function isJsonResponse(response: Response) {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

function mapPriority(priority?: string) {
  if (priority === "critical" || priority === "high" || priority === "High") return 1;
  if (priority === "low" || priority === "Low") return 3;
  return 2;
}

function toAzureStepsXml(steps: FinalApprovedTestCase["steps"]) {
  const stepXml = steps
    .map(
      (step, index) =>
        `<step id="${index + 1}" type="ActionStep"><parameterizedString isformatted="true">${escapeXml(
          step.action,
        )}</parameterizedString><parameterizedString isformatted="true">${escapeXml(
          step.expectedResult,
        )}</parameterizedString><description/></step>`,
    )
    .join("");
  return `<steps id="0" last="${steps.length}">${stepXml}</steps>`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeWiqlValue(value: string) {
  return value.replace(/'/g, "''");
}
