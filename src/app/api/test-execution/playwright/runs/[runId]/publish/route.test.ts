import { beforeEach, describe, expect, it, vi } from "vitest";
const requireWorkflowContext = vi.fn(); const resolveProjectScope = vi.fn(); const getUserAzureAdapter = vi.fn();
const getExecutionRun = vi.fn(); const publishableCases = vi.fn(); const beginPublication = vi.fn(); const finishPublication = vi.fn(); const updateTestPoints = vi.fn();
const beginRetry = vi.fn();
vi.mock("@/modules/credentials/scoped-resolution.service", () => ({ requireWorkflowContext: (...a: unknown[]) => requireWorkflowContext(...a), getUserAzureAdapter: (...a: unknown[]) => getUserAzureAdapter(...a), authErrorResponse: () => null }));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: (...a: unknown[]) => resolveProjectScope(...a) }));
vi.mock("@/modules/test-execution/execution-store.service", () => ({ getExecutionRun: (...a: unknown[]) => getExecutionRun(...a), publishableCases: (...a: unknown[]) => publishableCases(...a), beginExecutionPublication: (...a: unknown[]) => beginPublication(...a), beginFailedExecutionPublicationRetry: (...a: unknown[]) => beginRetry(...a), finishExecutionPublication: (...a: unknown[]) => finishPublication(...a) }));
import { POST } from "./route";
const scope = { projectId: "p", azureProjectId: "ap", azureProjectName: "P", azureOrganizationUrl: "https://dev.azure.com/o", workspaceId: "w" };
function request(body: unknown) { return new Request("http://local", { method: "POST", body: JSON.stringify(body) }); }
beforeEach(() => { vi.resetAllMocks(); requireWorkflowContext.mockResolvedValue({ userId: "u", workspace: { id: "w" } }); resolveProjectScope.mockResolvedValue(scope); getExecutionRun.mockResolvedValue({ status: "passed", azurePlanId: 1 }); publishableCases.mockResolvedValue([{ azureTestCaseId: 4, azureTestPointId: 5, azureSuiteId: 2, outcome: "passed" }]); beginPublication.mockResolvedValue("pub-1"); updateTestPoints.mockResolvedValue({ success: true }); getUserAzureAdapter.mockResolvedValue({ updateTestPoints }); });
describe("reviewed Azure publication", () => {
  it("requires explicit reviewed confirmation", async () => { expect((await POST(request({ scope }), { params: Promise.resolve({ runId: "r" }) })).status).toBe(400); expect(updateTestPoints).not.toHaveBeenCalled(); });
  it("reserves one publication before updating points", async () => { const response = await POST(request({ scope, confirmedReviewed: true }), { params: Promise.resolve({ runId: "r" }) }); expect(response.status).toBe(200); expect(beginPublication).toHaveBeenCalledBefore(updateTestPoints); expect(finishPublication).toHaveBeenCalledWith({ id: "pub-1", status: "completed", result: expect.any(Array) }); });
  it("rejects repeat publication without another Azure write", async () => { beginPublication.mockResolvedValue(null); expect((await POST(request({ scope, confirmedReviewed: true }), { params: Promise.resolve({ runId: "r" }) })).status).toBe(409); expect(updateTestPoints).not.toHaveBeenCalled(); });
  it("retries only failed points while preserving prior successes", async () => {
    publishableCases.mockResolvedValue([{ azureTestCaseId: 4, azureTestPointId: 5, azureSuiteId: 2, outcome: "passed" }, { azureTestCaseId: 4, azureTestPointId: 7, azureSuiteId: 2, outcome: "failed" }]);
    beginRetry.mockResolvedValue({ id: "pub-1", prior: [{ testCaseId: 4, testPointId: 5, success: true }, { testCaseId: 4, testPointId: 7, success: false, error: "prior failure" }] });
    const response = await POST(request({ scope, confirmedReviewed: true, retryFailed: true }), { params: Promise.resolve({ runId: "r" }) });
    expect(response.status).toBe(200); expect(updateTestPoints).toHaveBeenCalledOnce();
    expect(updateTestPoints).toHaveBeenCalledWith(expect.objectContaining({ pointIds: ["7"] }));
    expect(finishPublication).toHaveBeenCalledWith({ id: "pub-1", status: "completed", result: [{ testCaseId: 4, testPointId: 5, success: true }, { testCaseId: 4, testPointId: 7, success: true, error: undefined }] });
  });
  it("retries unattempted points after an interrupted publication", async () => {
    publishableCases.mockResolvedValue([{ azureTestCaseId: 4, azureTestPointId: 5, azureSuiteId: 2, outcome: "passed" }, { azureTestCaseId: 4, azureTestPointId: 7, azureSuiteId: 2, outcome: "failed" }]);
    beginRetry.mockResolvedValue({ id: "pub-1", prior: [{ testCaseId: 4, testPointId: 5, success: true }] });
    const response = await POST(request({ scope, confirmedReviewed: true, retryFailed: true }), { params: Promise.resolve({ runId: "r" }) });
    expect(response.status).toBe(200);
    expect(updateTestPoints).toHaveBeenCalledOnce();
    expect(updateTestPoints).toHaveBeenCalledWith(expect.objectContaining({ pointIds: ["7"] }));
  });
  it("persists point receipts as an array when Azure publication throws", async () => {
    updateTestPoints.mockRejectedValue(new Error("Azure unavailable"));
    const response = await POST(request({ scope, confirmedReviewed: true }), { params: Promise.resolve({ runId: "r" }) });
    expect(response.status).toBe(503);
    expect(finishPublication).toHaveBeenCalledWith({ id: "pub-1", status: "failed", result: [] });
  });
});
