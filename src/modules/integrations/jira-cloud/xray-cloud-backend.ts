import "server-only";

import type { FinalApprovedTestCase, TestPlan, TestRun } from "../core/integration-types";

export type XrayCloudSettings = {
  clientId: string;
  clientSecret: string;
  jiraProjectId: string;
  jiraProjectKey: string;
  localIdFieldId: string;
};

type Connection<T> = { total?: number; start?: number; limit?: number; results?: T[] };
type XrayTest = { issueId?: string; jira?: { summary?: string }; steps?: Array<{ id?: string; action?: string; result?: string }> };
type XrayPlan = { issueId?: string; jira?: { summary?: string } };
type XrayExecution = { issueId?: string; projectId?: string; testEnvironments?: string[]; jira?: { summary?: string } };
type XrayRun = { id?: string; status?: { name?: string }; testExecution?: { issueId?: string; projectId?: string }; test?: { issueId?: string }; steps?: Array<{ id?: string }> };

const AUTH_URL = "https://xray.cloud.getxray.app/api/v2/authenticate";
const GRAPHQL_URL = "https://xray.cloud.getxray.app/api/v2/graphql";
const MAX_PAGE = 100;
const MAX_RESULTS = 5000;

export class XrayCloudBackend {
  private token?: string;

  constructor(private readonly settings: XrayCloudSettings) {
    if (!settings.clientId.trim() || !settings.clientSecret.trim()) throw new Error("Xray Cloud credentials are required.");
    if (!settings.jiraProjectId.trim() || !settings.jiraProjectKey.trim()) throw new Error("Xray Cloud requires a Jira project.");
    if (!/^customfield_[0-9]+$/.test(settings.localIdFieldId)) throw new Error("Xray Cloud local identity field is invalid.");
  }

  async listTests(requestedLimit = 200): Promise<Array<{ id: string; title: string; steps: Array<{ id?: string; action: string; expectedResult: string }> }>> {
    const results = await this.paginate<XrayTest>("getTests", TESTS_QUERY, requestedLimit, { projectId: this.settings.jiraProjectId });
    return results.map((test) => ({
      id: required(test.issueId, "Xray Cloud returned a Test without an ID."),
      title: test.jira?.summary?.trim() || `Xray Test ${test.issueId}`,
      steps: (test.steps ?? []).map((step) => ({ id: step.id, action: step.action ?? "", expectedResult: step.result ?? "" })),
    }));
  }

  async listTestPlans(requestedLimit = 200): Promise<TestPlan[]> {
    const results = await this.paginate<XrayPlan>("getTestPlans", PLANS_QUERY, requestedLimit, { projectId: this.settings.jiraProjectId });
    return results.map((plan) => ({ id: required(plan.issueId, "Xray Cloud returned a Test Plan without an ID."), name: plan.jira?.summary?.trim() || `Xray Test Plan ${plan.issueId}`, raw: plan }));
  }

  async listTestRuns(input: { testExecutionIds: string[]; limit?: number }): Promise<TestRun[]> {
    if (!input.testExecutionIds.length) return [];
    await this.assertExecutionsInScope(input.testExecutionIds);
    const results = await this.paginate<XrayRun>("getTestRuns", RUNS_QUERY, input.limit ?? 200, { testExecutionIds: input.testExecutionIds });
    return results.map((run) => ({
      id: required(run.id, "Xray Cloud returned a Test Run without an ID."),
      name: `Xray Test Run ${run.id}`,
      state: run.status?.name,
      raw: run,
    }));
  }

  async listTestExecutions(requestedLimit = 200): Promise<Array<{ id: string; name: string; environments: string[] }>> {
    const results = await this.paginate<XrayExecution>("getTestExecutions", EXECUTIONS_QUERY, requestedLimit, { projectId: this.settings.jiraProjectId });
    return results.map((execution) => ({
      id: required(execution.issueId, "Xray Cloud returned a Test Execution without an ID."),
      name: execution.jira?.summary?.trim() || `Xray Test Execution ${execution.issueId}`,
      environments: execution.testEnvironments ?? [],
    }));
  }

  async createTestCase(input: { projectId: string; testCase: FinalApprovedTestCase }): Promise<{ success: boolean; azureTestCaseId?: string; error?: string }> {
    this.assertProject(input.projectId);
    const existing = await this.graphql<{ getTests?: Connection<XrayTest> }>(FIND_TEST_QUERY, {
      jql: `project = "${escapeJql(this.settings.jiraProjectKey)}" AND ${this.settings.localIdFieldId} = "${escapeJql(input.testCase.localId)}"`,
      limit: 2,
    });
    const found = existing.getTests?.results ?? [];
    if (found.length > 1) throw new Error("Multiple Xray Tests use the same iTestFlow identity.");
    if (found[0]?.issueId) return { success: true, azureTestCaseId: found[0].issueId };
    const fields: Record<string, unknown> = {
      summary: input.testCase.title,
      description: input.testCase.description,
      project: { id: this.settings.jiraProjectId },
      [this.settings.localIdFieldId]: input.testCase.localId,
    };
    const data = await this.graphql<{ createTest?: { test?: { issueId?: string }; warnings?: string[] } }>(CREATE_TEST_MUTATION, {
      jira: { fields },
      steps: input.testCase.steps.map((step) => ({ action: step.action, data: "", result: step.expectedResult })),
    });
    assertNoWarnings(data.createTest?.warnings);
    return { success: true, azureTestCaseId: required(data.createTest?.test?.issueId, "Xray Cloud returned an invalid Test.") };
  }

  async createTestPlan(input: { projectId: string; localId: string; name: string; testIssueIds?: string[] }): Promise<string> {
    this.assertProject(input.projectId);
    const testIssueIds = await this.assertTestsInScope(input.testIssueIds ?? []);
    const existing = await this.findArtifactByLocalId<XrayPlan>("getTestPlans", FIND_PLAN_QUERY, input.localId);
    let issueId = existing;
    let warnings: string[] | undefined;
    if (!issueId) {
      const data = await this.graphql<{ createTestPlan?: { testPlan?: { issueId?: string }; warnings?: string[] } }>(CREATE_PLAN_MUTATION, {
        jira: { fields: { summary: requiredText(input.name, "Test Plan name is required."), project: { id: this.settings.jiraProjectId }, [this.settings.localIdFieldId]: requiredText(input.localId, "Test Plan local ID is required.") } },
        testIssueIds: [],
      });
      issueId = required(data.createTestPlan?.testPlan?.issueId, "Xray Cloud returned an invalid Test Plan.");
      warnings = data.createTestPlan?.warnings;
    }
    await this.reconcilePlan(issueId, testIssueIds);
    assertNoWarnings(warnings);
    return issueId;
  }

  async createTestExecution(input: { projectId: string; localId: string; name: string; testIssueIds: string[]; environments?: string[] }): Promise<string> {
    this.assertProject(input.projectId);
    const testIssueIds = await this.assertTestsInScope(input.testIssueIds);
    const environments = uniqueNonblank(input.environments ?? [], "Test Environment is required.");
    const existing = await this.findArtifactByLocalId<XrayExecution>("getTestExecutions", FIND_EXECUTION_QUERY, input.localId);
    let issueId = existing;
    let warnings: string[] | undefined;
    if (!issueId) {
      const data = await this.graphql<{ createTestExecution?: { testExecution?: { issueId?: string }; warnings?: string[] } }>(CREATE_EXECUTION_MUTATION, {
        jira: { fields: { summary: requiredText(input.name, "Test Execution name is required."), project: { id: this.settings.jiraProjectId }, [this.settings.localIdFieldId]: requiredText(input.localId, "Test Execution local ID is required.") } },
        testIssueIds: [], environments: [],
      });
      issueId = required(data.createTestExecution?.testExecution?.issueId, "Xray Cloud returned an invalid Test Execution.");
      warnings = data.createTestExecution?.warnings;
    }
    await this.reconcileExecution(issueId, testIssueIds, environments);
    assertNoWarnings(warnings);
    return issueId;
  }

  async updateTestRunStatus(input: { runId: string; status: string }): Promise<void> {
    await this.assertRunInScope(input.runId);
    await this.graphql(UPDATE_RUN_MUTATION, { id: requiredText(input.runId, "Test Run ID is required."), status: requiredText(input.status, "Test Run status is required.") });
  }

  async updateTestRunStepStatus(input: { runId: string; stepId: string; status: string }): Promise<void> {
    const run = await this.assertRunInScope(input.runId);
    if (!(run.steps ?? []).some((step) => step.id === input.stepId)) throw new Error("The selected Xray Test Run step does not belong to the scoped run.");
    const data = await this.graphql<{ updateTestRunStepStatus?: { warnings?: string[] } }>(UPDATE_STEP_MUTATION, {
      runId: requiredText(input.runId, "Test Run ID is required."), stepId: requiredText(input.stepId, "Test Run step ID is required."), status: requiredText(input.status, "Test Run step status is required."),
    });
    assertNoWarnings(data.updateTestRunStepStatus?.warnings);
  }

  private assertProject(projectId: string) {
    if (projectId !== this.settings.jiraProjectId && projectId !== this.settings.jiraProjectKey) throw new Error("The selected Jira project does not match the Xray target.");
  }

  private async findArtifactByLocalId<T extends { issueId?: string }>(field: string, query: string, localId: string): Promise<string | undefined> {
    const jql = `project = "${escapeJql(this.settings.jiraProjectKey)}" AND ${this.settings.localIdFieldId} = "${escapeJql(requiredText(localId, "Xray artifact local ID is required."))}"`;
    const data = await this.graphql<Record<string, Connection<T>>>(query, { jql, limit: 2 });
    const results = data[field]?.results ?? [];
    if (results.length > 1) throw new Error("Multiple Xray artifacts use the same iTestFlow identity.");
    return results[0]?.issueId;
  }

  private async assertExecutionsInScope(issueIds: string[]): Promise<void> {
    const unique = [...new Set(issueIds.map((id) => requiredText(id, "Test Execution ID is required.")))];
    if (unique.length > MAX_PAGE) throw new Error("At most 100 Xray Test Executions may be read at once.");
    const data = await this.graphql<{ getTestExecutions?: Connection<XrayExecution> }>(SCOPED_EXECUTIONS_QUERY, { projectId: this.settings.jiraProjectId, issueIds: unique, limit: unique.length });
    const found = new Set((data.getTestExecutions?.results ?? []).filter((item) => item.projectId === this.settings.jiraProjectId).map((item) => item.issueId));
    if (unique.some((id) => !found.has(id))) throw new Error("The selected Xray Test Execution is not in the selected Jira project.");
  }

  private async assertTestsInScope(issueIds: string[]): Promise<string[]> {
    const unique = uniqueNonblank(issueIds, "Xray Test ID is required.");
    if (unique.length > MAX_PAGE) throw new Error("At most 100 Xray Tests may be associated at once.");
    if (!unique.length) return [];
    const data = await this.graphql<{ getTests?: Connection<XrayTest> }>(SCOPED_TESTS_QUERY, { projectId: this.settings.jiraProjectId, issueIds: unique, limit: unique.length });
    const found = new Set((data.getTests?.results ?? []).map((item) => item.issueId));
    if (unique.some((id) => !found.has(id))) throw new Error("The selected Xray Test is not in the selected Jira project.");
    return unique;
  }

  private async reconcilePlan(issueId: string, requestedTests: string[]): Promise<void> {
    if (!requestedTests.length) return;
    const data = await this.graphql<{ getTestPlan?: { projectId?: string; tests?: Connection<XrayTest> } }>(PLAN_STATE_QUERY, { issueId, issueIds: requestedTests, limit: requestedTests.length });
    if (data.getTestPlan?.projectId !== this.settings.jiraProjectId) throw new Error("The selected Xray Test Plan is not in the selected Jira project.");
    const current = new Set((data.getTestPlan.tests?.results ?? []).map((test) => test.issueId));
    const missing = requestedTests.filter((id) => !current.has(id));
    if (!missing.length) return;
    const added = await this.graphql<{ addTestsToTestPlan?: { warning?: string } }>(ADD_PLAN_TESTS_MUTATION, { issueId, testIssueIds: missing });
    assertNoWarning(added.addTestsToTestPlan?.warning);
  }

  private async reconcileExecution(issueId: string, requestedTests: string[], requestedEnvironments: string[]): Promise<void> {
    const data = await this.graphql<{ getTestExecution?: { projectId?: string; testEnvironments?: string[]; tests?: Connection<XrayTest> } }>(EXECUTION_STATE_QUERY, { issueId, issueIds: requestedTests, limit: Math.max(requestedTests.length, 1) });
    if (data.getTestExecution?.projectId !== this.settings.jiraProjectId) throw new Error("The selected Xray Test Execution is not in the selected Jira project.");
    const currentTests = new Set((data.getTestExecution.tests?.results ?? []).map((test) => test.issueId));
    const missingTests = requestedTests.filter((id) => !currentTests.has(id));
    if (missingTests.length) {
      const added = await this.graphql<{ addTestsToTestExecution?: { warning?: string } }>(ADD_EXECUTION_TESTS_MUTATION, { issueId, testIssueIds: missingTests });
      assertNoWarning(added.addTestsToTestExecution?.warning);
    }
    const currentEnvironments = new Set(data.getTestExecution.testEnvironments ?? []);
    const missingEnvironments = requestedEnvironments.filter((environment) => !currentEnvironments.has(environment));
    if (missingEnvironments.length) {
      const added = await this.graphql<{ addTestEnvironmentsToTestExecution?: { warning?: string } }>(ADD_EXECUTION_ENVIRONMENTS_MUTATION, { issueId, environments: missingEnvironments });
      assertNoWarning(added.addTestEnvironmentsToTestExecution?.warning);
    }
  }

  private async assertRunInScope(runId: string): Promise<XrayRun> {
    const data = await this.graphql<{ getTestRunById?: XrayRun }>(SCOPED_RUN_QUERY, { id: requiredText(runId, "Test Run ID is required.") });
    const run = data.getTestRunById;
    if (!run?.id || run.testExecution?.projectId !== this.settings.jiraProjectId) throw new Error("The selected Xray Test Run is not in the selected Jira project.");
    return run;
  }

  private async paginate<T>(field: string, query: string, requestedLimit: number, variables: Record<string, unknown>): Promise<T[]> {
    const limit = clampLimit(requestedLimit);
    const results: T[] = [];
    let start = 0;
    while (start < limit) {
      const pageLimit = Math.min(MAX_PAGE, limit - start);
      const data = await this.graphql<Record<string, Connection<T>>>(query, { ...variables, limit: pageLimit, start });
      const page = data[field];
      const batch = page?.results ?? [];
      results.push(...batch);
      const nextStart = (page?.start ?? start) + (page?.limit ?? pageLimit);
      if (batch.length === 0 || nextStart >= (page?.total ?? nextStart) || nextStart <= start) break;
      start = nextStart;
    }
    return results.slice(0, limit);
  }

  private async authenticate(): Promise<string> {
    if (this.token) return this.token;
    const response = await safeFetch(AUTH_URL, {
      method: "POST", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.settings.clientId, client_secret: this.settings.clientSecret }),
    }, "Xray Cloud authentication is unavailable.");
    if (!response.ok) throw new Error("Xray Cloud authentication failed.");
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error("Xray Cloud authentication returned an invalid response."); }
    if (typeof value !== "string" || !value.trim()) throw new Error("Xray Cloud authentication returned an invalid token.");
    this.token = value;
    return value;
  }

  private async graphql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response = await this.graphqlFetch(query, variables);
    if (response.status === 401) {
      this.token = undefined;
      response = await this.graphqlFetch(query, variables);
    }
    if (!response.ok) throw new Error("Xray Cloud GraphQL request failed.");
    let payload: { data?: T; errors?: unknown[] };
    try { payload = await response.json() as { data?: T; errors?: unknown[] }; } catch { throw new Error("Xray Cloud GraphQL returned an invalid response."); }
    if (payload.errors?.length || !payload.data) throw new Error("Xray Cloud GraphQL request failed.");
    return payload.data;
  }

  private async graphqlFetch(query: string, variables: Record<string, unknown>): Promise<Response> {
    const token = await this.authenticate();
    return safeFetch(GRAPHQL_URL, {
      method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, "Xray Cloud GraphQL is unavailable.");
  }
}

async function safeFetch(url: string, init: RequestInit, message: string) {
  try { return await fetch(url, init); } catch { throw new Error(message); }
}
function clampLimit(value: number) { return Math.min(Math.max(Math.trunc(Number.isFinite(value) ? value : 0), 1), MAX_RESULTS); }
function required(value: string | undefined, message: string) { if (!value?.trim()) throw new Error(message); return value; }
function requiredText(value: string, message: string) { if (!value.trim()) throw new Error(message); return value; }
function assertNoWarnings(warnings?: string[]) { if (warnings?.length) throw new Error("Xray Cloud completed with warnings; no local state was advanced."); }
function assertNoWarning(warning?: string) { if (warning?.trim()) throw new Error("Xray Cloud completed with warnings; no local state was advanced."); }
function uniqueNonblank(values: string[], message: string) { return [...new Set(values.map((value) => requiredText(value, message)))]; }
function escapeJql(value: string) { return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

const TESTS_QUERY = `query Tests($projectId: String!, $limit: Int!, $start: Int!) { getTests(projectId: $projectId, limit: $limit, start: $start) { total start limit results { issueId jira(fields: ["summary"]) steps { id action result } } } }`;
const PLANS_QUERY = `query Plans($projectId: String!, $limit: Int!, $start: Int!) { getTestPlans(projectId: $projectId, limit: $limit, start: $start) { total start limit results { issueId jira(fields: ["summary"]) } } }`;
const EXECUTIONS_QUERY = `query Executions($projectId: String!, $limit: Int!, $start: Int!) { getTestExecutions(projectId: $projectId, limit: $limit, start: $start) { total start limit results { issueId testEnvironments jira(fields: ["summary"]) } } }`;
const RUNS_QUERY = `query Runs($testExecutionIds: [String], $limit: Int!, $start: Int!) { getTestRuns(testExecIssueIds: $testExecutionIds, limit: $limit, start: $start) { total start limit results { id status { name } steps { id } test { issueId } testExecution { issueId projectId } } } }`;
const FIND_TEST_QUERY = `query FindTest($jql: String!, $limit: Int!) { getTests(jql: $jql, limit: $limit) { total results { issueId } } }`;
const FIND_PLAN_QUERY = `query FindPlan($jql: String!, $limit: Int!) { getTestPlans(jql: $jql, limit: $limit) { total results { issueId } } }`;
const FIND_EXECUTION_QUERY = `query FindExecution($jql: String!, $limit: Int!) { getTestExecutions(jql: $jql, limit: $limit) { total results { issueId } } }`;
const SCOPED_EXECUTIONS_QUERY = `query ScopedExecutions($projectId: String!, $issueIds: [String], $limit: Int!) { getTestExecutions(projectId: $projectId, issueIds: $issueIds, limit: $limit) { total results { issueId projectId } } }`;
const SCOPED_TESTS_QUERY = `query ScopedTests($projectId: String!, $issueIds: [String], $limit: Int!) { getTests(projectId: $projectId, issueIds: $issueIds, limit: $limit) { total results { issueId projectId } } }`;
const SCOPED_RUN_QUERY = `query ScopedRun($id: String!) { getTestRunById(id: $id) { id steps { id } testExecution { issueId projectId } } }`;
const PLAN_STATE_QUERY = `query PlanState($issueId: String!, $issueIds: [String], $limit: Int!) { getTestPlan(issueId: $issueId) { projectId tests(issueIds: $issueIds, limit: $limit) { results { issueId } } } }`;
const EXECUTION_STATE_QUERY = `query ExecutionState($issueId: String!, $issueIds: [String], $limit: Int!) { getTestExecution(issueId: $issueId) { projectId testEnvironments tests(issueIds: $issueIds, limit: $limit) { results { issueId } } } }`;
const CREATE_TEST_MUTATION = `mutation CreateTest($jira: JSON!, $steps: [CreateStepInput]) { createTest(testType: { name: "Manual" }, jira: $jira, steps: $steps) { test { issueId } warnings } }`;
const CREATE_PLAN_MUTATION = `mutation CreateTestPlan($jira: JSON!, $testIssueIds: [String]) { createTestPlan(jira: $jira, testIssueIds: $testIssueIds) { testPlan { issueId } warnings } }`;
const CREATE_EXECUTION_MUTATION = `mutation CreateTestExecution($jira: JSON!, $testIssueIds: [String], $environments: [String]) { createTestExecution(jira: $jira, testIssueIds: $testIssueIds, testEnvironments: $environments) { testExecution { issueId } warnings } }`;
const ADD_PLAN_TESTS_MUTATION = `mutation AddPlanTests($issueId: String!, $testIssueIds: [String]!) { addTestsToTestPlan(issueId: $issueId, testIssueIds: $testIssueIds) { addedTests warning } }`;
const ADD_EXECUTION_TESTS_MUTATION = `mutation AddExecutionTests($issueId: String!, $testIssueIds: [String]) { addTestsToTestExecution(issueId: $issueId, testIssueIds: $testIssueIds) { addedTests warning } }`;
const ADD_EXECUTION_ENVIRONMENTS_MUTATION = `mutation AddExecutionEnvironments($issueId: String!, $environments: [String]!) { addTestEnvironmentsToTestExecution(issueId: $issueId, testEnvironments: $environments) { associatedTestEnvironments createdTestEnvironments warning } }`;
const UPDATE_RUN_MUTATION = `mutation UpdateTestRunStatus($id: String!, $status: String!) { updateTestRunStatus(id: $id, status: $status) }`;
const UPDATE_STEP_MUTATION = `mutation UpdateTestRunStepStatus($runId: String!, $stepId: String!, $status: String!) { updateTestRunStepStatus(testRunId: $runId, stepId: $stepId, status: $status) { warnings } }`;
