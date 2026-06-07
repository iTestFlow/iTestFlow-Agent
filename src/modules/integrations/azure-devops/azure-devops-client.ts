import "server-only";

import { ProjectIsolationError, workItemNotInProjectMessage } from "@/modules/projects/project-isolation.guard";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";
import { mapAzureTestCase, mapAzureWorkItem } from "./azure-devops-mapper";
import type {
  AddSuiteTestCaseInput,
  AzureAuthenticatedUser,
  AzureArea,
  AzureAttachmentUpload,
  AzureBugWorkItemInput,
  AzureDevOpsSettings,
  AzureIdentityRef,
  AzureIteration,
  AzureProject,
  AzureProjectUser,
  AzureProjectWorkItemMetadata,
  AzureTestPoint,
  AzureWorkItemFieldValue,
  AzureWorkItemTypeField,
  CreateTestSuiteInput,
  FinalApprovedTestCase,
  Requirement,
  TestCase,
  TestConfigurationReference,
  TestPlan,
  TestSuite,
  UpdateTestPointInput,
} from "./azure-devops-types";

type JsonValue = Record<string, unknown>;

type AzureClassificationNode = {
  id?: number;
  identifier?: string;
  name?: string;
  path?: string;
  attributes?: {
    startDate?: string;
    finishDate?: string;
  };
  children?: AzureClassificationNode[];
};

type AzureTeam = {
  id?: string;
  name?: string;
};

type AzureTeamMember = {
  identity?: {
    id?: string;
    displayName?: string;
    uniqueName?: string;
    imageUrl?: string;
  };
};

/**
 * Identity of the active Azure DevOps project. When an adapter is constructed
 * with a bound scope, every by-ID work item read/write and test-plan/suite
 * operation is validated against this project, because Azure DevOps ignores the
 * project segment in by-ID URLs and would otherwise return/modify work items
 * from any project in the organization.
 */
export type AzureDevOpsProjectScope = {
  azureProjectId: string;
  azureProjectName: string;
};

export class AzureDevOpsRestAdapter implements AzureDevOpsAdapter {
  private readonly organizationUrl: string;
  private readonly pat: string;
  private readonly projectScope?: AzureDevOpsProjectScope;

  constructor(settings: AzureDevOpsSettings, projectScope?: AzureDevOpsProjectScope) {
    this.organizationUrl = settings.organizationUrl.replace(/\/$/, "");
    this.pat = settings.personalAccessToken;
    this.projectScope = projectScope;
  }

  /**
   * Whether a work item's fields belong to the bound project. Compares the
   * work item's real System.TeamProject (a project NAME) against the bound
   * project name, case-insensitively. Always true when no scope is bound.
   */
  private isFieldsInScope(fields: Record<string, unknown> | undefined): boolean {
    if (!this.projectScope) return true;
    const teamProject = typeof fields?.["System.TeamProject"] === "string" ? (fields["System.TeamProject"] as string) : undefined;
    return normalizeProjectName(teamProject) === normalizeProjectName(this.projectScope.azureProjectName);
  }

  /**
   * Throws ProjectIsolationError if the work item does not belong to the bound
   * project. A cross-project work item is treated as not-found-in-project so it
   * is indistinguishable from a missing item.
   */
  private assertFieldsInScope(fields: Record<string, unknown> | undefined, workItemId: string | number): void {
    if (this.isFieldsInScope(fields)) return;
    throw new ProjectIsolationError(workItemNotInProjectMessage(workItemId));
  }

  /**
   * Fetches a work item by ID and asserts it belongs to the bound project.
   * Used as an ownership pre-check before by-ID write operations. No-op (no
   * fetch) when no scope is bound.
   */
  private async assertWorkItemInScopeById(workItemId: string | number): Promise<void> {
    if (!this.projectScope) return;
    const item = await this.requestJson<{ fields?: Record<string, unknown> }>(
      `${encodeURIComponent(this.projectScope.azureProjectId)}/_apis/wit/workitems/${workItemId}?fields=System.TeamProject&api-version=7.1`,
    );
    this.assertFieldsInScope(item.fields, workItemId);
  }

  /**
   * Asserts a test plan belongs to the bound project before suite/test-point
   * writes. Azure DevOps does not enforce the URL project for by-ID test-plan
   * operations, so the plan's own project is checked. No-op when unbound.
   */
  private async assertTestPlanInScope(testPlanId: string): Promise<void> {
    if (!this.projectScope) return;
    const plan = await this.requestJson<{ project?: { id?: string; name?: string } }>(
      `${encodeURIComponent(this.projectScope.azureProjectId)}/_apis/testplan/plans/${encodeURIComponent(testPlanId)}?api-version=7.1`,
    );
    const projectId = plan.project?.id;
    const projectName = plan.project?.name;
    const matches =
      (projectId !== undefined && String(projectId) === this.projectScope.azureProjectId) ||
      normalizeProjectName(projectName) === normalizeProjectName(this.projectScope.azureProjectName);
    if (!matches) {
      throw new ProjectIsolationError(
        `Test plan ${testPlanId} is not in the selected Azure DevOps project.`,
      );
    }
  }

  buildWorkItemWebUrl(input: { projectId: string; projectName?: string; workItemId: string }): string {
    const projectSegment = encodeURIComponent(input.projectName?.trim() || input.projectId);
    return `${this.organizationUrl}/${projectSegment}/_workitems/edit/${encodeURIComponent(input.workItemId)}`;
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

  async fetchIterations(input: { projectId: string }): Promise<AzureIteration[]> {
    const root = await this.requestJson<AzureClassificationNode>(
      `${encodeURIComponent(input.projectId)}/_apis/wit/classificationnodes/iterations?$depth=10&api-version=7.1`,
    );
    return flattenIterations(root).sort((a, b) => a.path.localeCompare(b.path));
  }

  async fetchAreas(input: { projectId: string }): Promise<AzureArea[]> {
    const root = await this.requestJson<AzureClassificationNode>(
      `${encodeURIComponent(input.projectId)}/_apis/wit/classificationnodes/areas?$depth=10&api-version=7.1`,
    );
    return flattenAreas(root).sort((a, b) => a.path.localeCompare(b.path));
  }

  async fetchProjectUsers(input: { projectId: string }): Promise<AzureProjectUser[]> {
    const teams = await this.requestJson<{ value?: AzureTeam[] }>(
      `_apis/projects/${encodeURIComponent(input.projectId)}/teams?api-version=7.1`,
    );
    const users = new Map<string, AzureProjectUser>();

    for (const team of teams.value ?? []) {
      if (!team.id) continue;
      const members = await this.requestJson<{ value?: AzureTeamMember[] }>(
        `_apis/projects/${encodeURIComponent(input.projectId)}/teams/${encodeURIComponent(team.id)}/members?api-version=7.1`,
      );

      for (const member of members.value ?? []) {
        const identity = member.identity;
        const displayName = identity?.displayName?.trim();
        if (!identity?.id || !displayName) continue;
        const user = {
          id: identity.id,
          displayName,
          uniqueName: identity.uniqueName,
          imageUrl: identity.imageUrl,
        };
        users.set(user.uniqueName ?? user.id, user);
      }
    }

    return [...users.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async fetchProjectWorkItemMetadata(input: { projectId: string }): Promise<AzureProjectWorkItemMetadata> {
    const projectId = encodeURIComponent(input.projectId);
    const typesResponse = await this.requestJson<{ value?: Array<{ name?: string }> }>(
      `${projectId}/_apis/wit/workitemtypes?api-version=7.1`,
    );
    const workItemTypes = uniqueSortedValues(
      (typesResponse.value ?? []).map((type) => type.name ?? ""),
    );
    const stateResponses = await Promise.all(
      workItemTypes.map((workItemType) =>
        this.requestJson<{ value?: Array<{ name?: string }> }>(
          `${projectId}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states?api-version=7.1`,
        ),
      ),
    );
    const states = uniqueSortedValues(
      stateResponses.flatMap((response) => (response.value ?? []).map((state) => state.name ?? "")),
    );

    return { workItemTypes, states };
  }

  async fetchWorkItemTypeFields(input: { projectId: string; workItemType: string }): Promise<AzureWorkItemTypeField[]> {
    const json = await this.requestJson<{ value?: Array<JsonValue> }>(
      `${encodeURIComponent(input.projectId)}/_apis/wit/workitemtypes/${encodeURIComponent(input.workItemType)}/fields?$expand=All&api-version=7.1`,
    );

    return (json.value ?? [])
      .map(mapWorkItemTypeField)
      .filter((field): field is AzureWorkItemTypeField => Boolean(field?.referenceName && field.name));
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
    const iterationPath = normalizeIterationPathForWiql(input.iterationPath);
    if (input.areaPath) where.push(`[System.AreaPath] UNDER '${escapeWiqlValue(input.areaPath)}'`);
    if (iterationPath) where.push(`[System.IterationPath] UNDER '${escapeWiqlValue(iterationPath)}'`);

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
    this.assertFieldsInScope((item as { fields?: Record<string, unknown> }).fields, input.workItemId);
    return mapAzureWorkItem(item as never, input.projectId);
  }

  async fetchWorkItemsByIds(input: { projectId: string; workItemIds: string[] }): Promise<Requirement[]> {
    const ids = input.workItemIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
    if (!ids.length) return [];
    return this.fetchWorkItemsBatch(input.projectId, ids);
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
    return (workItems.value ?? [])
      .filter((workItem) => this.isFieldsInScope((workItem as { fields?: Record<string, unknown> }).fields))
      .map((workItem) => mapAzureTestCase(workItem as never, input.projectId));
  }

  async addWorkItemComment(input: {
    projectId: string;
    workItemId: string;
    commentBody: string;
  }): Promise<{ success: boolean; commentId?: string; error?: string }> {
    try {
      await this.assertWorkItemInScopeById(input.workItemId);
      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workItems/${input.workItemId}/comments?format=markdown&api-version=7.1-preview.4`,
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
    const suites: TestSuite[] = [];
    let continuationToken: string | undefined;

    do {
      const query = new URLSearchParams({ "api-version": "7.1" });
      if (continuationToken) query.set("continuationToken", continuationToken);
      const { json, headers } = await this.requestJsonWithHeaders<{ value?: Array<JsonValue> }>(
        `${encodeURIComponent(input.projectId)}/_apis/testplan/Plans/${input.testPlanId}/suites?${query.toString()}`,
      );
      suites.push(...(json.value ?? []).map((suite) => mapAzureTestSuite(suite, input.testPlanId)));
      continuationToken = headers.get("x-ms-continuationtoken") ?? undefined;
    } while (continuationToken);

    return suites;
  }

  async fetchTestSuiteTree(input: { projectId: string; testPlanId: string }): Promise<TestSuite[]> {
    const suites: TestSuite[] = [];
    let continuationToken: string | undefined;

    do {
      const query = new URLSearchParams({
        asTreeView: "true",
        expand: "children",
        "api-version": "7.1",
      });
      if (continuationToken) query.set("continuationToken", continuationToken);
      const { json, headers } = await this.requestJsonWithHeaders<{ value?: Array<JsonValue> }>(
        `${encodeURIComponent(input.projectId)}/_apis/testplan/Plans/${input.testPlanId}/suites?${query.toString()}`,
      );
      suites.push(...(json.value ?? []).map((suite) => mapAzureTestSuite(suite, input.testPlanId)));
      continuationToken = headers.get("x-ms-continuationtoken") ?? undefined;
    } while (continuationToken);

    return suites;
  }

  async createTestSuite(input: CreateTestSuiteInput): Promise<{ success: boolean; suite?: TestSuite; error?: string }> {
    try {
      await this.assertTestPlanInScope(input.testPlanId);
      const body: JsonValue = {
        suiteType: input.suiteType ?? "staticTestSuite",
        name: input.name,
        parentSuite: { id: Number(input.parentSuiteId) },
      };
      if (input.requirementId) body.requirementId = Number(input.requirementId);
      if (input.queryString) body.queryString = input.queryString;
      if (input.inheritDefaultConfigurations !== undefined) {
        body.inheritDefaultConfigurations = input.inheritDefaultConfigurations;
      }
      if (input.defaultConfigurations?.length) {
        body.defaultConfigurations = input.defaultConfigurations.map((configuration) => ({ id: Number(configuration.id) }));
      }
      if (input.defaultTesters?.length) {
        body.defaultTesters = input.defaultTesters.map(toAzureIdentityBody);
      }

      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/testplan/Plans/${input.testPlanId}/suites?api-version=7.1`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return { success: true, suite: mapAzureTestSuite(json, input.testPlanId) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps suite creation error" };
    }
  }

  async deleteTestSuite(input: { projectId: string; testPlanId: string; testSuiteId: string }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.assertTestPlanInScope(input.testPlanId);
      await this.requestNoJson(
        `${encodeURIComponent(input.projectId)}/_apis/testplan/Plans/${input.testPlanId}/suites/${input.testSuiteId}?api-version=7.1`,
        { method: "DELETE" },
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps suite deletion error" };
    }
  }

  async fetchTestPoints(input: { projectId: string; testPlanId: string; testSuiteId: string }): Promise<AzureTestPoint[]> {
    const top = 200;
    let skip = 0;
    const points: AzureTestPoint[] = [];

    while (true) {
      const query = new URLSearchParams({
        includePointDetails: "true",
        "$skip": String(skip),
        "$top": String(top),
        "api-version": "7.1",
      });
      const json = await this.requestJson<Array<JsonValue> | { value?: Array<JsonValue> }>(
        `${encodeURIComponent(input.projectId)}/_apis/test/Plans/${input.testPlanId}/Suites/${input.testSuiteId}/points?${query.toString()}`,
      );
      const batch = extractArrayPayload(json).map(mapAzureTestPoint);
      points.push(...batch);
      if (batch.length < top) break;
      skip += top;
    }

    return points;
  }

  async addTestCasesToSuite(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
    testCases: AddSuiteTestCaseInput[];
  }): Promise<{ success: boolean; addedCount: number; errors: Array<{ testCaseId: string; error: string }> }> {
    let addedCount = 0;
    const errors: Array<{ testCaseId: string; error: string }> = [];

    try {
      await this.assertTestPlanInScope(input.testPlanId);
    } catch (error) {
      return {
        success: false,
        addedCount: 0,
        errors: input.testCases.map((testCase) => ({
          testCaseId: testCase.testCaseId,
          error: error instanceof Error ? error.message : "Test plan is not in the selected Azure DevOps project.",
        })),
      };
    }

    for (const testCase of input.testCases) {
      try {
        const configurationIds = [...new Set(testCase.configurationIds ?? [])].filter(Boolean);
        if (configurationIds.length) {
          await this.requestJson<JsonValue>(
            `${encodeURIComponent(input.projectId)}/_apis/testplan/Plans/${input.testPlanId}/Suites/${input.testSuiteId}/TestCase?api-version=7.1`,
            {
              method: "POST",
              body: JSON.stringify({
                workItem: { id: Number(testCase.testCaseId) },
                pointAssignments: configurationIds.map((configurationId) => ({
                  configurationId: Number(configurationId),
                })),
              }),
            },
          );
        } else {
          await this.requestJson<JsonValue>(
            `${encodeURIComponent(input.projectId)}/_apis/test/Plans/${input.testPlanId}/suites/${input.testSuiteId}/testcases/${testCase.testCaseId}?api-version=7.1`,
            { method: "POST" },
          );
        }
        addedCount += 1;
      } catch (error) {
        errors.push({
          testCaseId: testCase.testCaseId,
          error: error instanceof Error ? error.message : "Azure DevOps suite test case add failed.",
        });
      }
    }

    return { success: errors.length === 0, addedCount, errors };
  }

  async updateTestPoints(input: UpdateTestPointInput): Promise<{ success: boolean; updatedPoints?: AzureTestPoint[]; error?: string }> {
    if (!input.pointIds.length) return { success: true, updatedPoints: [] };
    try {
      await this.assertTestPlanInScope(input.testPlanId);
      const body: JsonValue = {};
      if (input.outcome) body.outcome = input.outcome;
      if (input.tester) body.tester = toAzureIdentityBody(input.tester);
      const json = await this.requestJson<Array<JsonValue> | { value?: Array<JsonValue> }>(
        `${encodeURIComponent(input.projectId)}/_apis/test/Plans/${input.testPlanId}/Suites/${input.testSuiteId}/points/${input.pointIds.join(",")}?api-version=7.1`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      return { success: true, updatedPoints: extractArrayPayload(json).map(mapAzureTestPoint) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps test point update error" };
    }
  }

  async createTestCase(input: {
    projectId: string;
    testCase: FinalApprovedTestCase;
  }): Promise<{ success: boolean; azureTestCaseId?: string; error?: string }> {
    try {
      const patch = [
        { op: "add", path: "/fields/System.Title", value: input.testCase.title },
        { op: "add", path: "/fields/System.Description", value: input.testCase.description ?? "" },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: input.testCase.priority },
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

  async createBug(input: {
    projectId: string;
    bug: AzureBugWorkItemInput;
  }): Promise<{ success: boolean; azureBugId?: string; error?: string }> {
    try {
      if (input.bug.parentStoryId) {
        await this.assertWorkItemInScopeById(input.bug.parentStoryId);
      }
      const parentUrl = input.bug.parentStoryId
        ? `${this.organizationUrl}/${encodeURIComponent(input.projectId)}/_apis/wit/workItems/${input.bug.parentStoryId}`
        : undefined;
      const standardFields = new Set([
        "System.Title",
        "System.State",
        "Microsoft.VSTS.TCM.ReproSteps",
        "Microsoft.VSTS.Common.Priority",
        "Microsoft.VSTS.Common.Severity",
        "System.AssignedTo",
        "System.AreaPath",
        "System.AreaId",
        "System.IterationPath",
        "System.IterationId",
        "Microsoft.VSTS.Common.ValueArea",
      ]);
      const customFields = (input.bug.customFields ?? []).filter(
        (field) => field.referenceName && !standardFields.has(field.referenceName),
      );
      const patch: Array<{ op: "add"; path: string; value: unknown }> = [
        { op: "add", path: "/fields/System.Title", value: input.bug.title },
        { op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: input.bug.reproStepsHtml },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: input.bug.priority },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Severity", value: input.bug.severity },
        ...(input.bug.areaPath ? [{ op: "add" as const, path: "/fields/System.AreaPath", value: input.bug.areaPath }] : []),
        ...(input.bug.iterationPath
          ? [{ op: "add" as const, path: "/fields/System.IterationPath", value: input.bug.iterationPath }]
          : []),
        ...(input.bug.assignedTo ? [{ op: "add" as const, path: "/fields/System.AssignedTo", value: input.bug.assignedTo }] : []),
        ...customFields.map((field) => ({
          op: "add" as const,
          path: `/fields/${escapeJsonPointerSegment(field.referenceName)}`,
          value: field.value,
        })),
        ...(parentUrl
          ? [
              {
                op: "add" as const,
                path: "/relations/-",
                value: {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: parentUrl,
                },
              },
            ]
          : []),
      ];

      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workitems/$Bug?api-version=7.1`,
        {
          method: "POST",
          body: JSON.stringify(patch),
          contentType: "application/json-patch+json",
        },
      );
      return { success: true, azureBugId: String(json.id) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps bug creation error" };
    }
  }

  async uploadWorkItemAttachment(input: {
    projectId: string;
    attachment: AzureAttachmentUpload;
  }): Promise<{ success: boolean; attachmentUrl?: string; error?: string }> {
    try {
      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/attachments?fileName=${encodeURIComponent(input.attachment.fileName)}&api-version=7.1`,
        {
          method: "POST",
          body: new Blob([input.attachment.content]),
          contentType: "application/octet-stream",
        },
      );
      return { success: true, attachmentUrl: textValue(json.url) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps attachment upload error" };
    }
  }

  async attachFileToWorkItem(input: {
    projectId: string;
    workItemId: string;
    attachmentUrl: string;
    fileName: string;
    comment?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.assertWorkItemInScopeById(input.workItemId);
      await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workitems/${input.workItemId}?api-version=7.1`,
        {
          method: "PATCH",
          contentType: "application/json-patch+json",
          body: JSON.stringify([
            {
              op: "add",
              path: "/relations/-",
              value: {
                rel: "AttachedFile",
                url: input.attachmentUrl,
                attributes: {
                  comment: input.comment ?? input.fileName,
                },
              },
            },
          ]),
        },
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps attachment link error" };
    }
  }

  async createChildTask(input: {
    projectId: string;
    parentStoryId: string;
    title: string;
    description?: string;
    assignedTo?: string;
    originalEstimate?: number;
    copyEstimateToRemainingWork?: boolean;
    areaPath?: string;
    iterationPath?: string;
  }): Promise<{ success: boolean; azureTaskId?: string; error?: string }> {
    try {
      await this.assertWorkItemInScopeById(input.parentStoryId);
      const parentUrl = `${this.organizationUrl}/${encodeURIComponent(input.projectId)}/_apis/wit/workItems/${input.parentStoryId}`;
      const patch: Array<{ op: "add"; path: string; value: unknown }> = [
        { op: "add", path: "/fields/System.Title", value: input.title },
        ...(input.description ? [{ op: "add" as const, path: "/fields/System.Description", value: input.description }] : []),
        ...(input.areaPath ? [{ op: "add" as const, path: "/fields/System.AreaPath", value: input.areaPath }] : []),
        ...(input.iterationPath ? [{ op: "add" as const, path: "/fields/System.IterationPath", value: input.iterationPath }] : []),
        ...(input.assignedTo ? [{ op: "add" as const, path: "/fields/System.AssignedTo", value: input.assignedTo }] : []),
        ...(input.originalEstimate !== undefined
          ? [{ op: "add" as const, path: "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", value: input.originalEstimate }]
          : []),
        ...(input.originalEstimate !== undefined && (input.copyEstimateToRemainingWork ?? true)
          ? [{ op: "add" as const, path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: input.originalEstimate }]
          : []),
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: parentUrl,
          },
        },
      ];
      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workitems/$Task?api-version=7.1`,
        {
          method: "POST",
          body: JSON.stringify(patch),
          contentType: "application/json-patch+json",
        },
      );
      return { success: true, azureTaskId: String(json.id) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps task creation error" };
    }
  }

  async addTestCaseToSuite(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
    azureTestCaseId: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.assertTestPlanInScope(input.testPlanId);
      await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/test/Plans/${input.testPlanId}/suites/${input.testSuiteId}/testcases/${input.azureTestCaseId}?api-version=7.1`,
        { method: "POST" },
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps suite add error" };
    }
  }

  async createRequirementBasedSuite(input: {
    projectId: string;
    testPlanId: string;
    parentSuiteId: string;
    requirementId: string;
    name: string;
  }): Promise<{ success: boolean; suite?: TestSuite; error?: string }> {
    try {
      await this.assertTestPlanInScope(input.testPlanId);
      await this.assertWorkItemInScopeById(input.requirementId);
      const json = await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/testplan/Plans/${input.testPlanId}/suites?api-version=7.1`,
        {
          method: "POST",
          body: JSON.stringify({
            suiteType: "requirementTestSuite",
            name: input.name,
            requirementId: Number(input.requirementId),
            parentSuite: { id: Number(input.parentSuiteId) },
          }),
        },
      );
      return {
        success: true,
        suite: {
          id: String(json.id),
          name: String(json.name ?? input.name),
          planId: input.testPlanId,
          suiteType: typeof json.suiteType === "string" ? json.suiteType : "requirementTestSuite",
          requirementId: json.requirementId !== undefined ? String(json.requirementId) : input.requirementId,
          raw: json,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Unknown Azure DevOps requirement suite creation error" };
    }
  }

  async linkTestCaseToUserStory(input: {
    projectId: string;
    userStoryId: string;
    azureTestCaseId: string;
  }): Promise<{ success: boolean; error?: string }> {
    return this.linkTestCaseToWorkItem({
      projectId: input.projectId,
      workItemId: input.userStoryId,
      azureTestCaseId: input.azureTestCaseId,
    });
  }

  async linkTestCaseToWorkItem(input: {
    projectId: string;
    workItemId: string;
    azureTestCaseId: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.assertWorkItemInScopeById(input.workItemId);
      await this.assertWorkItemInScopeById(input.azureTestCaseId);
      const testCaseUrl = `${this.organizationUrl}/${encodeURIComponent(input.projectId)}/_apis/wit/workItems/${input.azureTestCaseId}`;
      await this.requestJson<JsonValue>(
        `${encodeURIComponent(input.projectId)}/_apis/wit/workitems/${input.workItemId}?api-version=7.1`,
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
    return (json.value ?? [])
      .filter((workItem) => this.isFieldsInScope((workItem as { fields?: Record<string, unknown> }).fields))
      .map((workItem) => mapAzureWorkItem(workItem as never, projectId));
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
    const { json } = await this.requestJsonWithHeaders<T>(path, init);
    return json;
  }

  private async requestJsonWithHeaders<T>(path: string, init?: RequestInit & { contentType?: string }): Promise<{ json: T; headers: Headers }> {
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
      return { json: JSON.parse(body) as T, headers: response.headers };
    } catch {
      throw new Error(
        `Azure DevOps returned malformed JSON (${response.status}). Check that the organization URL and Personal Access Token are valid.`,
      );
    }
  }

  private async requestNoJson(path: string, init?: RequestInit & { contentType?: string }) {
    const response = await this.request(path, init);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Azure DevOps request failed (${response.status}): ${body}`);
    }
  }

  private async request(path: string, init?: RequestInit & { contentType?: string }) {
    const token = Buffer.from(`:${this.pat}`).toString("base64");
    let response: Response | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(`${this.organizationUrl}/${path}`, {
          ...init,
          headers: {
            Authorization: `Basic ${token}`,
            Accept: "application/json",
            "Content-Type": init?.contentType ?? "application/json",
            ...(init?.headers ?? {}),
          },
        });
        if (!isTransientStatus(response.status) || attempt === 2) return response;
        await delay(retryDelayMs(response, attempt));
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
        await delay(250 * (attempt + 1));
      }
    }

    if (response) return response;
    throw lastError instanceof Error ? lastError : new Error("Azure DevOps request failed.");
  }
}

function isJsonResponse(response: Response) {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

function isTransientStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 300 * (attempt + 1);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractArrayPayload(value: Array<JsonValue> | { value?: Array<JsonValue> }) {
  return Array.isArray(value) ? value : value.value ?? [];
}

function mapWorkItemTypeField(value: JsonValue): AzureWorkItemTypeField | undefined {
  const referenceName = textValue(value.referenceName);
  const name = textValue(value.name);
  if (!referenceName || !name) return undefined;
  return {
    name,
    referenceName,
    type: textValue(value.type),
    helpText: textValue(value.helpText),
    required: booleanValue(value.required) ?? booleanValue(value.alwaysRequired),
    alwaysRequired: booleanValue(value.alwaysRequired),
    readOnly: booleanValue(value.readOnly),
    defaultValue: value.defaultValue,
    allowedValues: primitiveArrayValue(value.allowedValues),
  };
}

function mapAzureTestSuite(suite: JsonValue, planId: string): TestSuite {
  const parentSuite = objectValue(suite.parentSuite) ?? objectValue(suite.parent);
  return {
    id: stringValue(suite.id),
    name: stringValue(suite.name),
    planId,
    parentSuiteId: idValue(parentSuite?.id),
    parentSuiteName: textValue(parentSuite?.name),
    suiteType: textValue(suite.suiteType),
    requirementId: idValue(suite.requirementId),
    queryString: textValue(suite.queryString),
    inheritDefaultConfigurations:
      typeof suite.inheritDefaultConfigurations === "boolean" ? suite.inheritDefaultConfigurations : undefined,
    defaultConfigurations: arrayValue(suite.defaultConfigurations).map(mapConfigurationReference).filter(isDefined),
    defaultTesters: arrayValue(suite.defaultTesters).map(mapIdentityRef).filter(isDefined),
    children: arrayValue(suite.children).map((child) => mapAzureTestSuite(child, planId)),
    raw: suite,
  };
}

function mapAzureTestPoint(point: JsonValue): AzureTestPoint {
  const testCase = objectValue(point.testCase) ?? objectValue(point.testCaseReference);
  const configuration = objectValue(point.configuration);
  const suite = objectValue(point.suite) ?? objectValue(point.testSuite);
  const plan = objectValue(point.testPlan);
  const results = objectValue(point.results);
  const lastResultDetails = objectValue(point.lastResultDetails) ?? objectValue(results?.lastResultDetails);

  return {
    id: stringValue(point.id),
    testCaseId: idValue(testCase?.id),
    testCaseTitle: textValue(testCase?.name),
    configurationId: idValue(configuration?.id),
    configurationName: textValue(configuration?.name),
    suiteId: idValue(suite?.id),
    suiteName: textValue(suite?.name),
    planId: idValue(plan?.id),
    outcome: textValue(point.outcome) ?? textValue(results?.outcome),
    state: textValue(point.state) ?? textValue(results?.state),
    lastUpdatedDate: textValue(point.lastUpdatedDate),
    lastRunDate: textValue(lastResultDetails?.dateCompleted) ?? textValue(point.lastRunDate),
    tester: mapIdentityRef(objectValue(point.tester)),
    assignedTo: mapIdentityRef(objectValue(point.assignedTo)),
    raw: point,
  };
}

function mapConfigurationReference(value: unknown): TestConfigurationReference | undefined {
  const item = objectValue(value);
  const id = idValue(item?.id);
  if (!id) return undefined;
  return { id, name: textValue(item?.name) };
}

function mapIdentityRef(value: unknown): AzureIdentityRef | undefined {
  const item = objectValue(value);
  if (!item) return undefined;
  const identity: AzureIdentityRef = {
    id: textValue(item.id),
    displayName: textValue(item.displayName),
    uniqueName: textValue(item.uniqueName),
    descriptor: textValue(item.descriptor),
    imageUrl: textValue(item.imageUrl),
    url: textValue(item.url),
  };
  return Object.values(identity).some(Boolean) ? identity : undefined;
}

function toAzureIdentityBody(identity: AzureIdentityRef): JsonValue {
  return {
    ...(identity.id ? { id: identity.id } : {}),
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    ...(identity.uniqueName ? { uniqueName: identity.uniqueName } : {}),
    ...(identity.descriptor ? { descriptor: identity.descriptor } : {}),
  };
}

function objectValue(value: unknown): JsonValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonValue) : undefined;
}

function arrayValue(value: unknown): JsonValue[] {
  return Array.isArray(value) ? value.filter((item): item is JsonValue => Boolean(objectValue(item))) : [];
}

function primitiveArrayValue(value: unknown): AzureWorkItemFieldValue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return item;
      const objectItem = objectValue(item);
      if (objectItem?.value !== undefined) return primitiveFieldValue(objectItem.value);
      if (objectItem?.name !== undefined) return primitiveFieldValue(objectItem.name);
      return undefined;
    })
    .filter((item): item is AzureWorkItemFieldValue => item !== undefined);
}

function primitiveFieldValue(value: unknown): AzureWorkItemFieldValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return value === undefined || value === null ? undefined : String(value);
}

function idValue(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function stringValue(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? undefined : String(value);
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
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

function escapeJsonPointerSegment(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function escapeWiqlValue(value: string) {
  return value.replace(/'/g, "''");
}

function normalizeProjectName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function uniqueSortedValues(values: string[]) {
  const unique = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (trimmed && !unique.has(key)) unique.set(key, trimmed);
  }
  return [...unique.values()].sort((first, second) => first.localeCompare(second));
}

function flattenIterations(node: AzureClassificationNode): AzureIteration[] {
  const items: AzureIteration[] = [];
  const path = normalizeClassificationPath(node.path, "iteration");
  if (path) {
    items.push({
      id: node.identifier ?? String(node.id ?? path),
      name: node.name ?? path.split("\\").pop() ?? path,
      path,
      startDate: node.attributes?.startDate,
      finishDate: node.attributes?.finishDate,
    });
  }

  for (const child of node.children ?? []) {
    items.push(...flattenIterations(child));
  }

  return items;
}

function flattenAreas(node: AzureClassificationNode): AzureArea[] {
  const items: AzureArea[] = [];
  const path = normalizeClassificationPath(node.path, "area");
  if (path) {
    items.push({
      id: node.identifier ?? String(node.id ?? path),
      name: node.name ?? path.split("\\").pop() ?? path,
      path,
    });
  }

  for (const child of node.children ?? []) {
    items.push(...flattenAreas(child));
  }

  return items;
}

function normalizeClassificationPath(value: string | undefined, kind: "area" | "iteration") {
  const parts = value?.replace(/^\\+/, "").split("\\").filter(Boolean) ?? [];
  const segmentIndex = parts.findIndex((part) => part.toLocaleLowerCase() === kind);
  if (segmentIndex >= 0) parts.splice(segmentIndex, 1);
  return parts.join("\\");
}

function normalizeIterationPathForWiql(value?: string) {
  return normalizeClassificationPath(value, "iteration");
}
