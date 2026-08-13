import { beforeEach, describe, expect, it, vi } from "vitest";
import { XrayCloudBackend } from "./xray-cloud-backend";

describe("XrayCloudBackend", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("authenticates without exposing credentials and paginates tests at Xray's 100 item bound", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("xray-token"))
      .mockResolvedValueOnce(graphql({ getTests: { total: 101, start: 0, limit: 100, results: [xrayTest("10001", "First")] } }))
      .mockResolvedValueOnce(graphql({ getTests: { total: 101, start: 100, limit: 1, results: [xrayTest("10101", "Last")] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend().listTests(101)).resolves.toEqual([
      { id: "10001", title: "First", steps: [{ id: "step-1", action: "Act", expectedResult: "Result" }] },
      { id: "10101", title: "Last", steps: [{ id: "step-1", action: "Act", expectedResult: "Result" }] },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://xray.cloud.getxray.app/api/v2/authenticate");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ client_id: "client-id", client_secret: "client-secret" });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer xray-token" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).variables).toEqual({ projectId: "10000", limit: 100, start: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).variables).toEqual({ projectId: "10000", limit: 1, start: 100 });
  });

  it("creates an idempotent manual Test with trusted Jira project and steps", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("token"))
      .mockResolvedValueOnce(graphql({ getTests: { total: 0, results: [] } }))
      .mockResolvedValueOnce(graphql({ createTest: { test: { issueId: "10009" }, warnings: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(backend().createTestCase({
      projectId: "QA",
      testCase: { localId: "case-1", targetUserStoryId: "QA-7", title: "Checkout", description: "Pay", steps: [{ action: "Submit", expectedResult: "Created" }] },
    })).resolves.toEqual({ success: true, azureTestCaseId: "10009" });
    const mutation = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(mutation.variables.jira.fields).toMatchObject({ project: { id: "10000" }, summary: "Checkout", customfield_10100: "case-1" });
    expect(mutation.variables.steps).toEqual([{ action: "Submit", data: "", result: "Created" }]);
  });

  it("creates plans and executions then updates run and step outcomes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("token"))
      .mockResolvedValueOnce(graphql({ getTests: { total: 1, results: [{ issueId: "10009" }] } }))
      .mockResolvedValueOnce(graphql({ getTestPlans: { total: 0, results: [] } }))
      .mockResolvedValueOnce(graphql({ createTestPlan: { testPlan: { issueId: "20001" }, warnings: [] } }))
      .mockResolvedValueOnce(graphql({ getTestPlan: { projectId: "10000", tests: { results: [] } } }))
      .mockResolvedValueOnce(graphql({ addTestsToTestPlan: { addedTests: ["10009"] } }))
      .mockResolvedValueOnce(graphql({ getTests: { total: 1, results: [{ issueId: "10009" }] } }))
      .mockResolvedValueOnce(graphql({ getTestExecutions: { total: 0, results: [] } }))
      .mockResolvedValueOnce(graphql({ createTestExecution: { testExecution: { issueId: "30001" }, warnings: [] } }))
      .mockResolvedValueOnce(graphql({ getTestExecution: { projectId: "10000", testEnvironments: [], tests: { results: [] } } }))
      .mockResolvedValueOnce(graphql({ addTestsToTestExecution: { addedTests: ["10009"] } }))
      .mockResolvedValueOnce(graphql({ addTestEnvironmentsToTestExecution: { associatedTestEnvironments: ["Chrome"] } }))
      .mockResolvedValueOnce(graphql({ getTestRunById: scopedRun("run-1", ["step-1"]) }))
      .mockResolvedValueOnce(graphql({ updateTestRunStatus: "run-1" }))
      .mockResolvedValueOnce(graphql({ getTestRunById: scopedRun("run-1", ["step-1"]) }))
      .mockResolvedValueOnce(graphql({ updateTestRunStepStatus: { warnings: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const xray = backend();

    await expect(xray.createTestPlan({ projectId: "10000", localId: "plan-local-1", name: "Release", testIssueIds: ["10009"] })).resolves.toBe("20001");
    await expect(xray.createTestExecution({ projectId: "10000", localId: "execution-local-1", name: "CI", testIssueIds: ["10009"], environments: ["Chrome"] })).resolves.toBe("30001");
    await xray.updateTestRunStatus({ runId: "run-1", status: "PASSED" });
    await xray.updateTestRunStepStatus({ runId: "run-1", stepId: "step-1", status: "PASSED" });
    expect(fetchMock.mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)).query)).toEqual(expect.arrayContaining([
      expect.stringContaining("createTestPlan"), expect.stringContaining("createTestExecution"),
      expect.stringContaining("addTestsToTestPlan"), expect.stringContaining("addTestsToTestExecution"),
      expect.stringContaining("addTestEnvironmentsToTestExecution"),
      expect.stringContaining("updateTestRunStatus"), expect.stringContaining("updateTestRunStepStatus"),
    ]));
  });

  it("repairs missing associations when recovering a Plan and Test Execution", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("token"))
      .mockResolvedValueOnce(graphql({ getTests: { total: 1, results: [{ issueId: "10009" }] } }))
      .mockResolvedValueOnce(graphql({ getTestPlans: { total: 1, results: [{ issueId: "20001" }] } }))
      .mockResolvedValueOnce(graphql({ getTestPlan: { projectId: "10000", tests: { results: [] } } }))
      .mockResolvedValueOnce(graphql({ addTestsToTestPlan: { addedTests: ["10009"] } }))
      .mockResolvedValueOnce(graphql({ getTests: { total: 1, results: [{ issueId: "10009" }] } }))
      .mockResolvedValueOnce(graphql({ getTestExecutions: { total: 1, results: [{ issueId: "30001" }] } }))
      .mockResolvedValueOnce(graphql({ getTestExecution: { projectId: "10000", testEnvironments: [], tests: { results: [] } } }))
      .mockResolvedValueOnce(graphql({ addTestsToTestExecution: { addedTests: ["10009"] } }))
      .mockResolvedValueOnce(graphql({ addTestEnvironmentsToTestExecution: { associatedTestEnvironments: ["Chrome"] } }));
    vi.stubGlobal("fetch", fetchMock);
    const xray = backend();

    await expect(xray.createTestPlan({ projectId: "10000", localId: "plan-local-1", name: "Release", testIssueIds: ["10009"] })).resolves.toBe("20001");
    await expect(xray.createTestExecution({ projectId: "10000", localId: "execution-local-1", name: "CI", testIssueIds: ["10009"], environments: ["Chrome"] })).resolves.toBe("30001");
    const queries = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body ?? "{}"))).map((body) => body.query ?? "");
    expect(queries.some((query) => query.includes("createTestPlan"))).toBe(false);
    expect(queries.some((query) => query.includes("createTestExecution"))).toBe(false);
    expect(queries).toEqual(expect.arrayContaining([expect.stringContaining("addTestsToTestPlan"), expect.stringContaining("addTestEnvironmentsToTestExecution")]));
  });

  it("rejects cross-project Tests before creating or repairing Plans", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("token"))
      .mockResolvedValueOnce(graphql({ getTests: { total: 0, results: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend().createTestPlan({ projectId: "10000", localId: "plan-1", name: "Release", testIssueIds: ["other-test"] })).rejects.toThrow("selected Jira project");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads project-scoped plans, executions, and runs through bounded native queries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("token"))
      .mockResolvedValueOnce(graphql({ getTestPlans: { total: 1, start: 0, limit: 1, results: [{ issueId: "20001", jira: { summary: "Release" } }] } }))
      .mockResolvedValueOnce(graphql({ getTestExecutions: { total: 1, start: 0, limit: 1, results: [{ issueId: "30001", jira: { summary: "CI" }, testEnvironments: ["Chrome"] }] } }))
      .mockResolvedValueOnce(graphql({ getTestExecutions: { total: 1, results: [{ issueId: "30001", projectId: "10000" }] } }))
      .mockResolvedValueOnce(graphql({ getTestRuns: { total: 1, start: 0, limit: 1, results: [{ ...scopedRun("run-1", ["run-step-1"]), status: { name: "PASSED" }, test: { issueId: "10009" } }] } }));
    vi.stubGlobal("fetch", fetchMock);
    const xray = backend();

    await expect(xray.listTestPlans(1)).resolves.toEqual([{ id: "20001", name: "Release", raw: expect.any(Object) }]);
    await expect(xray.listTestExecutions(1)).resolves.toEqual([{ id: "30001", name: "CI", environments: ["Chrome"] }]);
    await expect(xray.listTestRuns({ testExecutionIds: ["30001"], limit: 1 })).resolves.toEqual([
      { id: "run-1", name: "Xray Test Run run-1", state: "PASSED", raw: expect.objectContaining({ steps: [{ id: "run-step-1" }] }) },
    ]);
    const calls = fetchMock.mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)));
    expect(calls.filter((call) => "start" in call.variables).every((call) => call.variables.limit === 1 && call.variables.start === 0)).toBe(true);
    expect(calls[0].variables.projectId).toBe("10000");
    expect(calls[1].variables.projectId).toBe("10000");
    expect(calls[3].variables.testExecutionIds).toEqual(["30001"]);
  });

  it("rejects cross-project run reads and mutations before changing status", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("token"))
      .mockResolvedValueOnce(graphql({ getTestExecutions: { total: 0, results: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend().listTestRuns({ testExecutionIds: ["other-execution"] })).rejects.toThrow("selected Jira project");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondFetch = vi.fn()
      .mockResolvedValueOnce(json("token"))
      .mockResolvedValueOnce(graphql({ getTestRunById: { ...scopedRun("other-run", ["step-1"]), testExecution: { issueId: "40001", projectId: "20000" } } }));
    vi.stubGlobal("fetch", secondFetch);
    await expect(backend().updateTestRunStatus({ runId: "other-run", status: "PASSED" })).rejects.toThrow("selected Jira project");
    expect(secondFetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired Xray bearer token once", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json("expired-token"))
      .mockResolvedValueOnce(json({ message: "expired detail" }, 401))
      .mockResolvedValueOnce(json("fresh-token"))
      .mockResolvedValueOnce(graphql({ getTestPlans: { total: 0, results: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(backend().listTestPlans()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({ Authorization: "Bearer fresh-token" });
  });

  it("fails closed on project mismatch and redacts GraphQL error details", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(backend().createTestPlan({ projectId: "OTHER", localId: "plan-nope", name: "Nope" })).rejects.toThrow("selected Jira project");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json("token")).mockResolvedValueOnce(graphql(undefined, [{ message: "client-secret leaked" }]));
    const error = await backend().listTestPlans().catch((caught: unknown) => caught);
    expect(error).toEqual(new Error("Xray Cloud GraphQL request failed."));
    expect(String(error)).not.toContain("client-secret leaked");
  });
});

function backend() { return new XrayCloudBackend({ clientId: "client-id", clientSecret: "client-secret", jiraProjectId: "10000", jiraProjectKey: "QA", localIdFieldId: "customfield_10100" }); }
function xrayTest(id: string, summary: string) { return { issueId: id, jira: { summary }, steps: [{ id: "step-1", action: "Act", result: "Result" }] }; }
function scopedRun(id: string, stepIds: string[]) { return { id, testExecution: { issueId: "30001", projectId: "10000" }, steps: stepIds.map((stepId) => ({ id: stepId })) }; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function graphql(data?: unknown, errors?: unknown[]) { return json({ data, errors }); }
