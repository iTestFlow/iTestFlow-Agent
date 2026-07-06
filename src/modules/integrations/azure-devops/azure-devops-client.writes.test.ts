import { beforeEach, describe, expect, it, vi } from "vitest";

import { AzureDevOpsRestAdapter } from "./azure-devops-client";

const ORG = "https://dev.azure.com/fabrikam";

function adapter() {
  return new AzureDevOpsRestAdapter(
    { organizationUrl: ORG, personalAccessToken: "pat" },
    { azureProjectId: "proj-1", azureProjectName: "Fabrikam Project" },
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function call(mock: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = mock.mock.calls[index] as [RequestInfo | URL, RequestInit | undefined];
  return { url: String(url), init };
}

describe("AzureDevOpsRestAdapter write contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts a test-case JSON patch with the required content type", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 901 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter().createTestCase({
      projectId: "proj-1",
      testCase: {
        localId: "local-1",
        targetUserStoryId: "42",
        title: "Successful checkout",
        preconditions: "Customer has a cart",
        steps: [{ action: "Submit payment", expectedResult: "Order is created" }],
        priority: 1,
      },
    });

    expect(result).toEqual({ success: true, azureTestCaseId: "901" });
    const write = call(fetchMock, 0);
    expect(write.url).toBe(`${ORG}/proj-1/_apis/wit/workitems/$Test%20Case?api-version=7.1`);
    expect(write.init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "Content-Type": "application/json-patch+json" }),
    });
    expect(JSON.parse(String(write.init?.body))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/fields/System.Title", value: "Successful checkout" }),
      ]),
    );
  });

  it("returns a stable test-case failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "invalid patch" }, 400)));
    await expect(adapter().createTestCase({
      projectId: "proj-1",
      testCase: {
        localId: "local-1",
        targetUserStoryId: "42",
        title: "Case",
        steps: [{ action: "Act", expectedResult: "Result" }],
      },
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining("invalid patch") });
  });

  it("creates a bug patch while filtering reserved custom fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 902 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter().createBug({
      projectId: "proj-1",
      bug: {
        title: "Checkout fails",
        reproStepsHtml: "<p>Submit payment</p>",
        priority: 2,
        severity: "2 - High",
        customFields: [
          { referenceName: "Custom.Release", value: "R2" },
          { referenceName: "System.Title", value: "forged" },
          { referenceName: "Custom/Path~Name", value: true },
        ],
      },
    });

    expect(result).toEqual({ success: true, azureBugId: "902" });
    const patch = JSON.parse(String(call(fetchMock, 0).init?.body)) as Array<{ path: string; value: unknown }>;
    expect(patch).toContainEqual({ op: "add", path: "/fields/Custom.Release", value: "R2" });
    expect(patch).toContainEqual({ op: "add", path: "/fields/Custom~1Path~0Name", value: true });
    expect(patch.filter((entry) => entry.path === "/fields/System.Title")).toEqual([
      expect.objectContaining({ value: "Checkout fails" }),
    ]);
  });

  it("blocks suite creation when the plan belongs to another project", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      project: { id: "other-project", name: "Other Project" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter().createTestSuite({
      projectId: "proj-1",
      testPlanId: "10",
      parentSuiteId: "20",
      name: "Migrated suite",
    });
    expect(result).toEqual({
      success: false,
      error: "Test plan 10 is not in the selected Azure DevOps project.",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("creates a suite only after validating plan ownership", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/_apis/testplan/plans/10?")) {
        return jsonResponse({ project: { id: "proj-1", name: "Fabrikam Project" } });
      }
      return jsonResponse({ id: 30, name: "Migrated suite", suiteType: "staticTestSuite" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter().createTestSuite({
      projectId: "proj-1",
      testPlanId: "10",
      parentSuiteId: "20",
      name: "Migrated suite",
      defaultConfigurations: [{ id: "5" }],
    });
    expect(result).toMatchObject({ success: true, suite: { id: "30", name: "Migrated suite" } });
    expect(call(fetchMock, 1).init?.method).toBe("POST");
    expect(JSON.parse(String(call(fetchMock, 1).init?.body))).toMatchObject({
      suiteType: "staticTestSuite",
      name: "Migrated suite",
      parentSuite: { id: 20 },
      defaultConfigurations: [{ id: 5 }],
    });
  });

  it("deletes a validated suite with the exact scoped URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/_apis/testplan/plans/10?")) {
        return jsonResponse({ project: { id: "proj-1" } });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter().deleteTestSuite({
      projectId: "proj-1",
      testPlanId: "10",
      testSuiteId: "30",
    })).resolves.toEqual({ success: true });
    expect(call(fetchMock, 1)).toMatchObject({
      url: `${ORG}/proj-1/_apis/testplan/Plans/10/suites/30?api-version=7.1`,
      init: { method: "DELETE" },
    });
  });

  it("uploads binary attachment content and returns its Azure URL", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ url: "https://files/attachment-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter().uploadWorkItemAttachment({
      projectId: "proj-1",
      attachment: {
        fileName: "failure log.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("failure").buffer,
      },
    });
    expect(result).toEqual({ success: true, attachmentUrl: "https://files/attachment-1" });
    const write = call(fetchMock, 0);
    expect(write.url).toContain("fileName=failure%20log.txt");
    expect(write.init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "Content-Type": "application/octet-stream" }),
    });
    expect(write.init?.body).toBeInstanceOf(Blob);
  });

  it("pre-checks work-item ownership before attaching a file", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("fields=System.TeamProject")) {
        return jsonResponse({ fields: { "System.TeamProject": "Fabrikam Project" } });
      }
      return jsonResponse({ id: 902 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await adapter().attachFileToWorkItem({
      projectId: "proj-1",
      workItemId: "902",
      attachmentUrl: "https://files/attachment-1",
      fileName: "log.txt",
    });

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(call(fetchMock, 1).init?.body))).toEqual([
      expect.objectContaining({
        path: "/relations/-",
        value: expect.objectContaining({
          rel: "AttachedFile",
          url: "https://files/attachment-1",
        }),
      }),
    ]);
  });
});
