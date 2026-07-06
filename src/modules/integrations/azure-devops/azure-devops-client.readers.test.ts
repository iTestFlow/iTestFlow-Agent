import { beforeEach, describe, expect, it, vi } from "vitest";

import { AzureDevOpsRestAdapter } from "./azure-devops-client";

const ORG = "https://dev.azure.com/fabrikam";

function adapter() {
  return new AzureDevOpsRestAdapter(
    { organizationUrl: ORG, personalAccessToken: "pat" },
    { azureProjectId: "proj-1", azureProjectName: "Fabrikam Project" },
  );
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchUrl(mock: ReturnType<typeof vi.fn>, index: number) {
  const call = mock.mock.calls[index] as [RequestInfo | URL] | undefined;
  if (!call) throw new Error(`fetch call ${index} was never made`);
  return new URL(String(call[0]));
}

describe("AzureDevOpsRestAdapter paginated test readers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads test points in 200-item pages until Azure returns a short page", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      testCase: { id: 1000 + index, name: `Case ${index + 1}` },
      configuration: { id: 5, name: "Chrome" },
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ value: firstPage }))
      .mockResolvedValueOnce(jsonResponse({
        value: [{
          id: 201,
          testCase: { id: 1200, name: "Last case" },
          results: { outcome: "Passed" },
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const points = await adapter().fetchTestPoints({
      projectId: "proj-1",
      testPlanId: "10",
      testSuiteId: "20",
    });

    expect(points).toHaveLength(201);
    expect(points[0]).toMatchObject({
      id: "1",
      testCaseId: "1000",
      testCaseTitle: "Case 1",
      configurationName: "Chrome",
    });
    expect(points[200]).toMatchObject({
      id: "201",
      testCaseId: "1200",
      outcome: "Passed",
    });
    expect(fetchUrl(fetchMock, 0).searchParams.get("$skip")).toBe("0");
    expect(fetchUrl(fetchMock, 0).searchParams.get("$top")).toBe("200");
    expect(fetchUrl(fetchMock, 1).searchParams.get("$skip")).toBe("200");
  });

  it("paginates test runs only to the requested limit and preserves the plan filter", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Run ${index + 1}`,
      plan: { id: 10 },
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ value: firstPage }))
      .mockResolvedValueOnce(jsonResponse({
        value: [{ id: 101, name: "Run 101", state: "Completed", passedTests: 9 }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const runs = await adapter().fetchTestRuns({
      projectId: "proj-1",
      testPlanId: "10",
      limit: 101,
    });

    expect(runs).toHaveLength(101);
    expect(runs[100]).toMatchObject({
      id: "101",
      name: "Run 101",
      state: "Completed",
      passedTests: 9,
    });
    expect(fetchUrl(fetchMock, 0).searchParams.get("$top")).toBe("100");
    expect(fetchUrl(fetchMock, 0).searchParams.get("planId")).toBe("10");
    expect(fetchUrl(fetchMock, 1).searchParams.get("$skip")).toBe("100");
    expect(fetchUrl(fetchMock, 1).searchParams.get("$top")).toBe("1");
  });

  it("clamps a non-positive test-run limit to one", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      value: [{ id: 1, name: "Only run" }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const runs = await adapter().fetchTestRuns({ projectId: "proj-1", limit: 0 });

    expect(fetchUrl(fetchMock, 0).searchParams.get("$top")).toBe("1");
    expect(runs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("paginates test results to the requested limit and maps associated bugs", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      testCase: { id: 2000 + index, name: `Case ${index + 1}` },
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ value: firstPage }))
      .mockResolvedValueOnce(jsonResponse({
        value: [{
          id: 201,
          testCaseTitle: "Final result",
          outcome: "Failed",
          associatedBugs: [{ id: 77 }, { id: "78" }],
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await adapter().fetchTestResults({
      projectId: "proj-1",
      runId: "300",
      limit: 201,
    });

    expect(results).toHaveLength(201);
    expect(results[200]).toMatchObject({
      id: "201",
      runId: "300",
      testCaseTitle: "Final result",
      outcome: "Failed",
      associatedBugIds: ["77", "78"],
    });
    expect(fetchUrl(fetchMock, 0).searchParams.get("$top")).toBe("200");
    expect(fetchUrl(fetchMock, 1).searchParams.get("$skip")).toBe("200");
    expect(fetchUrl(fetchMock, 1).searchParams.get("$top")).toBe("1");
  });
});

describe("AzureDevOpsRestAdapter metadata readers", () => {
  it("flattens and sorts nested iterations while retaining date attributes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: 1,
      name: "Iteration",
      path: "\\Project\\Iteration",
      children: [
        {
          identifier: "sprint-2",
          name: "Sprint 2",
          path: "\\Project\\Iteration\\Sprint 2",
          attributes: { startDate: "2026-07-15", finishDate: "2026-07-28" },
        },
        {
          identifier: "sprint-1",
          name: "Sprint 1",
          path: "\\Project\\Iteration\\Sprint 1",
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const iterations = await adapter().fetchIterations({ projectId: "proj-1" });

    expect(iterations.map((item) => item.path)).toEqual([
      "Project",
      "Project\\Sprint 1",
      "Project\\Sprint 2",
    ]);
    expect(iterations[2]).toMatchObject({
      id: "sprint-2",
      startDate: "2026-07-15",
      finishDate: "2026-07-28",
    });
    expect(fetchUrl(fetchMock, 0).pathname).toContain("/proj-1/_apis/wit/classificationnodes/iterations");
  });

  it("flattens and sorts nested area paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      id: 1,
      name: "Area",
      path: "\\Project\\Area",
      children: [
        { identifier: "z", name: "Zulu", path: "\\Project\\Area\\Zulu" },
        { identifier: "a", name: "Alpha", path: "\\Project\\Area\\Alpha" },
      ],
    })));

    await expect(adapter().fetchAreas({ projectId: "proj-1" })).resolves.toEqual([
      { id: "1", name: "Area", path: "Project" },
      { id: "a", name: "Alpha", path: "Project\\Alpha" },
      { id: "z", name: "Zulu", path: "Project\\Zulu" },
    ]);
  });

  it("deduplicates metadata and skips per-type state requests when states are not requested", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      value: [{ name: "Bug" }, { name: "User Story" }, { name: "Bug" }, { name: "" }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const metadata = await adapter().fetchProjectWorkItemMetadata({
      projectId: "proj-1",
      includeStates: false,
    });

    expect(metadata).toEqual({ workItemTypes: ["Bug", "User Story"], states: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("loads each work-item type's states and returns unique sorted values", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/workitemtypes?api-version=7.1")) {
        return jsonResponse({ value: [{ name: "User Story" }, { name: "Bug" }] });
      }
      if (url.includes("/workitemtypes/Bug/states?")) {
        return jsonResponse({ value: [{ name: "New" }, { name: "Closed" }] });
      }
      if (url.includes("/workitemtypes/User%20Story/states?")) {
        return jsonResponse({ value: [{ name: "Active" }, { name: "Closed" }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter().fetchProjectWorkItemMetadata({ projectId: "proj-1" }))
      .resolves.toEqual({
        workItemTypes: ["Bug", "User Story"],
        states: ["Active", "Closed", "New"],
      });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps field metadata, preserves primitive allowed values, and drops malformed fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      value: [
        {
          name: "Customer Impact",
          referenceName: "Custom.CustomerImpact",
          type: "picklistInteger",
          helpText: "Impact score",
          alwaysRequired: true,
          readOnly: false,
          defaultValue: 2,
          allowedValues: [1, 2, "3", { invalid: true }],
        },
        { name: "Missing reference" },
      ],
    })));

    await expect(adapter().fetchWorkItemTypeFields({
      projectId: "proj-1",
      workItemType: "Bug",
    })).resolves.toEqual([{
      name: "Customer Impact",
      referenceName: "Custom.CustomerImpact",
      type: "picklistInteger",
      helpText: "Impact score",
      required: true,
      alwaysRequired: true,
      readOnly: false,
      defaultValue: 2,
      allowedValues: [1, 2, "3"],
    }]);
  });
});
