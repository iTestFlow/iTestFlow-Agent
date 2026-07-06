import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBulkTasks: vi.fn(),
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  startWorkflowRun: vi.fn(),
  completeWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

vi.mock("@/modules/integrations/azure-devops/azure-devops-bulk-task.service", () => ({
  createBulkTasks: mocks.createBulkTasks,
}));
// importOriginal keeps the REAL authErrorResponse and auth error classes so the
// auth mapping tests below exercise the route's actual SessionError /
// WorkflowAuthError catch branch; only the context/adapter resolvers are stubbed.
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  completeWorkflowRun: mocks.completeWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));

import { SessionError } from "@/modules/auth/session.service";
import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const context = {
  userId: "user-1",
  workspace: { id: "ws-1", azureOrgUrl: "https://dev.azure.com/demo" },
};
// Server-resolved scope, deliberately distinct from the client-supplied one so
// the "route never trusts client scope" assertions are meaningful.
const trustedScope = projectScope({ projectId: "trusted-project-1" });
const adapter = { adapter: "azure" };

const ESTIMATE_ERROR = "Original estimate must be a non-negative whole number or decimal.";

function body(overrides: { taskTemplates?: unknown[]; targets?: unknown[] } = {}) {
  return {
    scope: projectScope({ workspaceId: "ws-1" }),
    taskTemplates: overrides.taskTemplates ?? [{ templateId: "t1", title: "Alpha task" }],
    targets: overrides.targets ?? [{ storyId: "123" }],
  };
}

async function post(payload: unknown) {
  return POST(jsonRequest("/api/azure-devops/bulk-tasks", payload));
}

describe("POST /api/azure-devops/bulk-tasks", () => {
  beforeEach(() => {
    mocks.requireWorkflowContext.mockReset().mockResolvedValue(context);
    mocks.resolveProjectScope.mockReset().mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockReset().mockResolvedValue(adapter);
    mocks.startWorkflowRun.mockReset().mockReturnValue("run-1");
    mocks.completeWorkflowRun.mockReset();
    mocks.failWorkflowRun.mockReset();
    mocks.createBulkTasks.mockReset().mockResolvedValue({
      requestedCount: 1,
      created: [{ templateId: "t1", storyId: "123", taskId: 900, title: "Alpha task" }],
      skipped: [],
      failed: [],
    });
  });

  it("coerces string estimates to numbers and blank estimates to undefined before calling the service", async () => {
    const response = await post(
      body({
        taskTemplates: [
          { templateId: "t1", title: "Alpha task", originalEstimate: "2.5" },
          { templateId: "t2", title: "Beta task", originalEstimate: "" },
          { templateId: "t3", title: "Gamma task", originalEstimate: "   " },
          { templateId: "t4", title: "Delta task", originalEstimate: 4 },
        ],
        targets: [{ storyId: "123", taskOverrides: [{ templateId: "t1", originalEstimate: "3.5" }] }],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createBulkTasks).toHaveBeenCalledWith(adapter, trustedScope, {
      actor: "user-1",
      taskTemplates: [
        { templateId: "t1", title: "Alpha task", copyEstimateToRemainingWork: true, originalEstimate: 2.5 },
        { templateId: "t2", title: "Beta task", copyEstimateToRemainingWork: true },
        { templateId: "t3", title: "Gamma task", copyEstimateToRemainingWork: true },
        { templateId: "t4", title: "Delta task", copyEstimateToRemainingWork: true, originalEstimate: 4 },
      ],
      targets: [{ storyId: "123", taskOverrides: [{ templateId: "t1", originalEstimate: 3.5 }] }],
    });
  });

  it.each([
    ["negative", "-1"],
    ["non-numeric", "abc"],
    ["scientific notation", "1e3"],
  ])("rejects a %s estimate string with 400 before auth or the service run", async (_name, estimate) => {
    const response = await post(
      body({ taskTemplates: [{ templateId: "t1", title: "Alpha task", originalEstimate: estimate }] }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(ESTIMATE_ERROR);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.createBulkTasks).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects duplicate template IDs after trimming", async () => {
    const response = await post(
      body({
        taskTemplates: [
          { templateId: "t1", title: "Alpha task" },
          { templateId: " t1 ", title: "Beta task" },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Duplicate task definition ID t1.");
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects titles that differ only by case and whitespace", async () => {
    const response = await post(
      body({
        taskTemplates: [
          { templateId: "t1", title: "Write  API   tests" },
          { templateId: "t2", title: "  write api TESTS  " },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Duplicate task title "write api TESTS".');
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects duplicate story IDs after trimming", async () => {
    const response = await post(body({ targets: [{ storyId: "123" }, { storyId: " 123 " }] }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Duplicate story ID 123.");
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects an override referencing an unknown template ID", async () => {
    const response = await post(
      body({ targets: [{ storyId: "123", taskOverrides: [{ templateId: "ghost" }] }] }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "Task override references unknown task definition ID ghost.",
    );
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects two overrides for the same template within one story", async () => {
    const response = await post(
      body({
        targets: [
          {
            storyId: "123",
            taskOverrides: [{ templateId: "t1" }, { templateId: "t1", assignedTo: "someone" }],
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "Duplicate override for task definition ID t1 in story 123.",
    );
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects a batch whose templates x targets product exceeds 1000", async () => {
    // 20 templates (per-array max) x 51 stories = 1020 requested tasks.
    const response = await post(
      body({
        taskTemplates: Array.from({ length: 20 }, (_, i) => ({
          templateId: `t${i}`,
          title: `Task ${i}`,
        })),
        targets: Array.from({ length: 51 }, (_, i) => ({ storyId: `${100 + i}` })),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "This batch would create 1020 tasks. The maximum is 1000.",
    );
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("runs against the server-resolved scope and completes the analytics run from the service result", async () => {
    mocks.createBulkTasks.mockResolvedValue({
      requestedCount: 3,
      created: [
        { templateId: "t1", storyId: "123", taskId: 900, title: "Alpha task" },
        { templateId: "t1", storyId: "124", taskId: 901, title: "Alpha task" },
      ],
      skipped: [],
      failed: [{ templateId: "t1", storyId: "125", title: "Alpha task", error: "boom" }],
    });

    const response = await post(
      body({ targets: [{ storyId: "123" }, { storyId: "124" }, { storyId: "125" }] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestedCount: 3,
      created: [
        { templateId: "t1", storyId: "123", taskId: 900 },
        { templateId: "t1", storyId: "124", taskId: 901 },
      ],
      failed: [{ storyId: "125", error: "boom" }],
      analyticsRunId: "run-1",
    });

    // Workspace hint comes from the client scope; everything downstream uses the
    // server-resolved scope, never the client-supplied one.
    expect(mocks.requireWorkflowContext).toHaveBeenCalledWith("ws-1");
    expect(mocks.resolveProjectScope).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ projectId: "project-1", workspaceId: "ws-1" }),
    );
    expect(mocks.getUserAzureAdapter).toHaveBeenCalledWith(context, trustedScope);
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      workflowType: "bulk_task_creation",
      workItemId: "bulk-tasks",
      userId: "user-1",
    });
    expect(mocks.completeWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      valueRealized: true,
      patch: {
        itemsGenerated: 3,
        itemsSelected: 3,
        itemsPublished: 2,
        itemsRejected: 1,
        manualActionsAvoided: 2,
      },
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("fails the analytics run when nothing was created, but still returns the service result", async () => {
    mocks.createBulkTasks.mockResolvedValue({
      requestedCount: 1,
      created: [],
      skipped: [],
      failed: [{ templateId: "t1", storyId: "123", title: "Alpha task", error: "boom" }],
    });

    const response = await post(body());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: [], analyticsRunId: "run-1" });
    expect(mocks.failWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      error: "No bulk tasks were created.",
    });
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it("maps a SessionError from requireWorkflowContext to 401 before any analytics run starts", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new SessionError());

    const response = await post(body());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.createBulkTasks).not.toHaveBeenCalled();
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("maps a missing-PAT WorkflowAuthError to its own status, not the sanitized 503", async () => {
    mocks.getUserAzureAdapter.mockRejectedValue(
      new WorkflowAuthError("Add your Azure DevOps Personal Access Token first.", 400),
    );

    const response = await post(body());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Add your Azure DevOps Personal Access Token first.",
    });
    expect(mocks.createBulkTasks).not.toHaveBeenCalled();
    // Auth errors return before the catch block's failWorkflowRun fallback,
    // even though the analytics run had already started.
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("maps a service throw to a sanitized 503 and fails the analytics run with the raw message", async () => {
    mocks.createBulkTasks.mockRejectedValue(new Error("Azure DevOps request failed with pat=abc123"));

    const response = await post(body());

    expect(response.status).toBe(503);
    // Credentials are redacted from the client-facing body.
    expect(await response.json()).toEqual({
      error: "Azure DevOps request failed with PAT: [redacted]",
    });
    expect(mocks.failWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      error: "Azure DevOps request failed with pat=abc123",
    });
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
  });
});
