import { beforeEach, describe, expect, it, vi } from "vitest";
const requireWorkflowContext = vi.fn(); const resolveProjectScope = vi.fn(); const requestExecutionCancellation = vi.fn();
const executionRunJobId = vi.fn(); const requestJobCancellation = vi.fn(); const finishRun = vi.fn();
vi.mock("@/modules/credentials/scoped-resolution.service", () => ({ requireWorkflowContext: (...a: unknown[]) => requireWorkflowContext(...a), authErrorResponse: () => null }));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: (...a: unknown[]) => resolveProjectScope(...a) }));
vi.mock("@/modules/test-execution/execution-store.service", () => ({ requestExecutionCancellation: (...a: unknown[]) => requestExecutionCancellation(...a), executionRunJobId: (...a: unknown[]) => executionRunJobId(...a), finishRun: (...a: unknown[]) => finishRun(...a) }));
vi.mock("@/modules/jobs/job-queue.service", () => ({ requestJobCancellation: (...a: unknown[]) => requestJobCancellation(...a) }));
import { POST } from "./route";
const scope = { projectId: "p", azureProjectId: "ap", azureProjectName: "P", azureOrganizationUrl: "https://dev.azure.com/o", workspaceId: "w" };
beforeEach(() => { vi.resetAllMocks(); requireWorkflowContext.mockResolvedValue({ userId: "u", workspace: { id: "w" } }); resolveProjectScope.mockResolvedValue(scope); requestExecutionCancellation.mockResolvedValue(true); executionRunJobId.mockResolvedValue("job-1"); requestJobCancellation.mockResolvedValue({ status: "running" }); });
describe("Playwright execution cancellation", () => {
  it("requests both run and durable job cancellation", async () => {
    const response = await POST(new Request("http://local", { method: "POST", body: JSON.stringify({ scope }) }), { params: Promise.resolve({ runId: "run-1" }) });
    expect(response.status).toBe(200); expect(requestJobCancellation).toHaveBeenCalledWith({ id: "job-1", workspaceId: "w", projectId: "p" });
  });
  it("finishes a job cancelled before claim", async () => {
    requestJobCancellation.mockResolvedValue({ status: "cancelled" });
    await POST(new Request("http://local", { method: "POST", body: JSON.stringify({ scope }) }), { params: Promise.resolve({ runId: "run-1" }) });
    expect(finishRun).toHaveBeenCalledWith("run-1", "cancelled", expect.any(String));
  });
});
