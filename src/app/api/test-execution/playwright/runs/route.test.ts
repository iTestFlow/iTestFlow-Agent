import { beforeEach, describe, expect, it, vi } from "vitest";

const requireWorkflowContext = vi.fn();
const resolveProjectScope = vi.fn();
const getSummary = vi.fn();
const resolveConfig = vi.fn();
const hasHealthyWorkerCapability = vi.fn();
const getUserAzureAdapter = vi.fn();
const createExecutionRun = vi.fn();
const resolveTestDataEntries = vi.fn();

vi.mock("@/modules/credentials/scoped-resolution.service", () => ({
  requireWorkflowContext: (...args: unknown[]) => requireWorkflowContext(...args),
  getUserAzureAdapter: (...args: unknown[]) => getUserAzureAdapter(...args),
  authErrorResponse: () => null,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: (...args: unknown[]) => resolveProjectScope(...args) }));
vi.mock("@/modules/test-execution/playwright-mcp-config.service", () => ({ getPlaywrightMcpConfigSummary: (...args: unknown[]) => getSummary(...args), resolvePlaywrightMcpConfig: (...args: unknown[]) => resolveConfig(...args) }));
vi.mock("@/modules/jobs/worker-registry.service", () => ({ hasHealthyWorkerCapability: (...args: unknown[]) => hasHealthyWorkerCapability(...args) }));
vi.mock("@/modules/test-execution/execution-store.service", () => ({ createExecutionRun: (...args: unknown[]) => createExecutionRun(...args) }));
vi.mock("@/modules/test-execution/execution-test-data.service", () => ({ resolveTestDataEntries: (...args: unknown[]) => resolveTestDataEntries(...args) }));

import { POST } from "./route";
import { TestDataResolutionError } from "@/modules/test-execution/execution-test-data.shared";

const scope = { workspaceId: "w", projectId: "p", azureProjectId: "ap", azureProjectName: "P", azureOrganizationUrl: "https://dev.azure.com/o" };

const validBody = {
  scope,
  baseUrl: "https://app.example.com/login",
  screenshotPolicy: "validation-points",
  testData: [],
  cases: [{ title: "Manual case", steps: [{ action: "Open the home page", expectedResult: "The home page loads" }] }],
};

function postRequest(body: unknown): Request {
  return new Request("http://local", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS;
  requireWorkflowContext.mockResolvedValue({ userId: "u", workspace: { id: "w" } });
  resolveProjectScope.mockResolvedValue(scope);
  getSummary.mockResolvedValue({ status: "configured", transport: "http", endpoint: "https://mcp.example/mcp", artifactBaseUrl: null });
  resolveConfig.mockResolvedValue({ status: "configured", transport: "http", endpoint: "https://mcp.example/mcp", artifactBaseUrl: null, bearerToken: null });
  hasHealthyWorkerCapability.mockResolvedValue(true);
  resolveTestDataEntries.mockResolvedValue([]);
  createExecutionRun.mockResolvedValue({ runId: "run-1", jobId: "job-1" });
});

describe("Playwright execution start", () => {
  it("rejects payloads without cases or base URL before any lookup", async () => {
    const response = await POST(postRequest({ scope, baseUrl: "https://a.example", screenshotPolicy: "none", cases: [] }));
    expect(response.status).toBe(400);
    expect(requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("fails before Azure reads when no compatible worker is healthy", async () => {
    hasHealthyWorkerCapability.mockResolvedValue(false);
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(503);
    expect(hasHealthyWorkerCapability).toHaveBeenCalledWith("playwright_mcp_execution");
    expect(getUserAzureAdapter).not.toHaveBeenCalled();
    expect(createExecutionRun).not.toHaveBeenCalled();
  });

  it("revalidates stored transport policy before enqueue", async () => {
    resolveConfig.mockRejectedValue(new Error("Stored Playwright MCP HTTP origin is no longer allowed by deployment policy."));
    await POST(postRequest(validBody));
    expect(resolveConfig).toHaveBeenCalledWith("w");
    expect(createExecutionRun).not.toHaveBeenCalled();
  });

  it("rejects a base URL outside the deployment allowlist when this process knows it", async () => {
    process.env.PLAYWRIGHT_EXECUTION_ALLOWED_ORIGINS = "https://allowed.example.com";
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/allowed test origins/);
    expect(createExecutionRun).not.toHaveBeenCalled();
  });

  it("requires point-carrying cases to also carry case, plan, and suite ids", async () => {
    const response = await POST(postRequest({
      ...validBody,
      cases: [{ azureTestPointId: 9, title: "Imported", steps: [{ action: "Do" }] }],
    }));
    expect(response.status).toBe(400);
  });

  it("surfaces test-data resolution problems as 422", async () => {
    resolveTestDataEntries.mockRejectedValue(new TestDataResolutionError('Enter a value for "Password" or remove it.'));
    const response = await POST(postRequest({
      ...validBody,
      testData: [{ title: "Password", isSecret: true, fromRunId: "run-0" }],
    }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/Password/);
    expect(createExecutionRun).not.toHaveBeenCalled();
  });

  it("maps the active-run unique violation to a friendly 409", async () => {
    createExecutionRun.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already running/);
  });

  it("creates the run from caller-supplied cases with settings and provenance", async () => {
    const response = await POST(postRequest({
      ...validBody,
      name: "Nightly smoke",
      executionNotes: "  Log in with the default account first.  ",
      headless: false,
      viewportWidth: 1280,
      viewportHeight: 720,
      planId: 7,
      suiteId: 8,
      testData: [{ title: "Username", isSecret: false, value: "qa@example.com" }],
      cases: [{
        azureTestCaseId: 100, azureTestPointId: 200, azurePlanId: 7, azureSuiteId: 8,
        title: "Imported case", steps: [{ action: "Open", expectedResult: "Loads" }],
      }],
    }));
    expect(response.status).toBe(202);
    expect(resolveTestDataEntries).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "w", projectId: "p",
      entries: [{ title: "Username", isSecret: false, value: "qa@example.com" }],
    }));
    expect(createExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      planId: 7,
      suiteId: 8,
      name: "Nightly smoke",
      settings: expect.objectContaining({
        baseUrl: "https://app.example.com/login",
        executionNotes: "Log in with the default account first.",
        screenshotPolicy: "validation-points",
        headless: false,
        viewportWidth: 1280,
        viewportHeight: 720,
      }),
      cases: [expect.objectContaining({ testCaseId: 100, testPointId: 200, planId: 7, suiteId: 8 })],
    }));
    expect(getUserAzureAdapter).not.toHaveBeenCalled();
  });

  it("defaults the browser settings and stores no name when they are omitted", async () => {
    const response = await POST(postRequest(validBody));
    expect(response.status).toBe(202);
    expect(createExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      name: null,
      settings: expect.objectContaining({ headless: true, viewportWidth: 1920, viewportHeight: 1080 }),
    }));
  });

  it("rejects out-of-range viewport dimensions with the authored message", async () => {
    const response = await POST(postRequest({ ...validBody, viewportWidth: 100 }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Viewport width must be between 320 and 3840 pixels.");
    expect(createExecutionRun).not.toHaveBeenCalled();
  });
});
