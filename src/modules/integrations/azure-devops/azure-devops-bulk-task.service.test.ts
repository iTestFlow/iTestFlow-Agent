import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createId: vi.fn(() => "audit-1"),
  nowIso: vi.fn(() => "2026-07-06T00:00:00.000Z"),
  sqlRun: vi.fn<(sql: string, params: Record<string, unknown>) => Promise<number>>(async () => 1),
  enqueueBackgroundWrite: vi.fn((_label: string, operation: () => unknown) => operation()),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => db);

import { ProjectIsolationError } from "@/modules/projects/project-isolation.guard";
import { fakeAzureAdapter, projectScope, requirement } from "@/test/factories";
import { createBulkTasks } from "./azure-devops-bulk-task.service";

const DUPLICATE_ERROR = "Skipped: matching child task already exists";

function auditParams() {
  return db.sqlRun.mock.calls[0][1];
}

describe("createBulkTasks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates tasks with trimmed template fields, per-target overrides, and the story's area/iteration", async () => {
    const fetchWorkItemById = vi.fn(async ({ workItemId }: { projectId: string; workItemId: string }) =>
      requirement({ id: workItemId, areaPath: "Demo\\Team", iterationPath: "Demo\\Sprint 9" }),
    );
    // Story has no childLinks, so the dedupe pass must not fetch children at all.
    const fetchWorkItemsByIds = vi.fn(async () => []);
    const createChildTask = vi.fn(async () => ({ success: true, azureTaskId: "9001" }));
    const adapter = fakeAzureAdapter({ fetchWorkItemById, fetchWorkItemsByIds, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [
        {
          templateId: " tpl-dev ",
          title: "  Implement feature  ",
          description: "  Do the work  ",
          assignedTo: "  Template Owner  ",
          originalEstimate: 8,
          copyEstimateToRemainingWork: false,
        },
        // Blank assignedTo normalizes to undefined; copyEstimateToRemainingWork defaults to true.
        { templateId: "tpl-qa", title: "Test feature", assignedTo: "   " },
      ],
      targets: [{
        storyId: " 301 ",
        taskOverrides: [{ templateId: " tpl-dev ", assignedTo: " Override Owner ", originalEstimate: 3 }],
      }],
    });

    expect(fetchWorkItemById).toHaveBeenCalledWith({ projectId: "azure-project-1", workItemId: "301" });
    expect(fetchWorkItemsByIds).not.toHaveBeenCalled();
    expect(createChildTask).toHaveBeenNthCalledWith(1, {
      projectId: "azure-project-1",
      parentStoryId: "301",
      title: "Implement feature",
      description: "Do the work",
      assignedTo: "Override Owner",
      originalEstimate: 3,
      copyEstimateToRemainingWork: false,
      areaPath: "Demo\\Team",
      iterationPath: "Demo\\Sprint 9",
    });
    expect(createChildTask).toHaveBeenNthCalledWith(2, {
      projectId: "azure-project-1",
      parentStoryId: "301",
      title: "Test feature",
      description: undefined,
      assignedTo: undefined,
      originalEstimate: undefined,
      copyEstimateToRemainingWork: true,
      areaPath: "Demo\\Team",
      iterationPath: "Demo\\Sprint 9",
    });
    expect(result).toMatchObject({
      requestedCount: 2,
      taskTemplateCount: 2,
      targetStoryCount: 1,
      skipped: [],
      failed: [],
    });
    expect(result.created).toEqual([
      { templateId: "tpl-dev", storyId: "301", taskId: "9001", title: "Implement feature" },
      { templateId: "tpl-qa", storyId: "301", taskId: "9001", title: "Test feature" },
    ]);
  });

  it("skips a template whose title matches an existing child Task case/whitespace-insensitively", async () => {
    const fetchWorkItemById = vi.fn(async () => requirement({ id: "301", childLinks: ["11", "12"] }));
    const fetchWorkItemsByIds = vi.fn(async () => [
      requirement({ id: "11", workItemType: "Task", title: "  IMPLEMENT   Feature " }),
      // Non-Task children never count toward the dedupe set.
      requirement({ id: "12", workItemType: "Bug", title: "Test feature" }),
    ]);
    const createChildTask = vi.fn(async () => ({ success: true, azureTaskId: "9002" }));
    const adapter = fakeAzureAdapter({ fetchWorkItemById, fetchWorkItemsByIds, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [
        { templateId: "tpl-dev", title: "Implement feature" },
        { templateId: "tpl-qa", title: "Test feature" },
      ],
      targets: [{ storyId: "301" }],
    });

    expect(fetchWorkItemsByIds).toHaveBeenCalledWith({ projectId: "azure-project-1", workItemIds: ["11", "12"] });
    expect(createChildTask).toHaveBeenCalledTimes(1);
    expect(createChildTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Test feature" }));
    expect(result.skipped).toEqual([
      { templateId: "tpl-dev", storyId: "301", title: "Implement feature", error: DUPLICATE_ERROR },
    ]);
    expect(result.created).toEqual([
      { templateId: "tpl-qa", storyId: "301", taskId: "9002", title: "Test feature" },
    ]);
    // Skips alone do not degrade the audit status.
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        status: "Success",
        message: "Created 1 of 2 requested Azure DevOps tasks.",
      }),
    );
  });

  it("skips a title already created earlier in the same run for the same story", async () => {
    const fetchWorkItemById = vi.fn(async () => requirement({ id: "301" }));
    const createChildTask = vi.fn(async () => ({ success: true, azureTaskId: "9003" }));
    const adapter = fakeAzureAdapter({ fetchWorkItemById, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [
        { templateId: "tpl-a", title: "Ship it" },
        { templateId: "tpl-b", title: "  Ship   IT  " },
      ],
      targets: [{ storyId: "301" }],
    });

    expect(createChildTask).toHaveBeenCalledTimes(1);
    expect(createChildTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Ship it" }));
    expect(result.created).toEqual([
      { templateId: "tpl-a", storyId: "301", taskId: "9003", title: "Ship it" },
    ]);
    expect(result.skipped).toEqual([
      { templateId: "tpl-b", storyId: "301", title: "Ship   IT", error: DUPLICATE_ERROR },
    ]);
  });

  it("records a sanitized createChildTask rejection for one story and still processes the other", async () => {
    const fetchWorkItemById = vi.fn(async ({ workItemId }: { projectId: string; workItemId: string }) =>
      requirement({ id: workItemId }),
    );
    const createChildTask = vi.fn(async ({ parentStoryId }: { parentStoryId: string }) => {
      if (parentStoryId === "401") {
        throw new Error("Azure DevOps request failed (401): Authorization: Basic dXNlcjpwYXQtc2VjcmV0");
      }
      return { success: true, azureTaskId: "9004" };
    });
    const adapter = fakeAzureAdapter({ fetchWorkItemById, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [{ templateId: "tpl-1", title: "Deploy" }],
      targets: [{ storyId: "401" }, { storyId: "402" }],
    });

    expect(createChildTask).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([
      {
        templateId: "tpl-1",
        storyId: "401",
        title: "Deploy",
        error: "Azure DevOps request failed (401): Authorization: Basic [redacted]",
      },
    ]);
    expect(result.created).toEqual([
      { templateId: "tpl-1", storyId: "402", taskId: "9004", title: "Deploy" },
    ]);
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        status: "Partial failure",
        message: "Created 1 of 2 requested Azure DevOps tasks.",
      }),
    );
  });

  it("continues past unsuccessful and malformed create results within a story", async () => {
    const fetchWorkItemById = vi.fn(async () => requirement({ id: "301" }));
    const createChildTask = vi.fn(async ({ title }: { title: string }) => {
      if (title === "Reported failure") return { success: false, error: "Azure DevOps request failed (400): invalid area path" };
      if (title === "Missing id") return { success: true };
      if (title === "Thrown string") throw "boom";
      return { success: true, azureTaskId: "9005" };
    });
    const adapter = fakeAzureAdapter({ fetchWorkItemById, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [
        { templateId: "tpl-1", title: "Reported failure" },
        { templateId: "tpl-2", title: "Missing id" },
        { templateId: "tpl-3", title: "Thrown string" },
        { templateId: "tpl-4", title: "Works" },
      ],
      targets: [{ storyId: "301" }],
    });

    expect(createChildTask).toHaveBeenCalledTimes(4);
    expect(result.failed).toEqual([
      { templateId: "tpl-1", storyId: "301", title: "Reported failure", error: "Azure DevOps request failed (400): invalid area path" },
      { templateId: "tpl-2", storyId: "301", title: "Missing id", error: "Azure DevOps task creation failed." },
      { templateId: "tpl-3", storyId: "301", title: "Thrown string", error: "Azure DevOps task creation failed." },
    ]);
    expect(result.created).toEqual([
      { templateId: "tpl-4", storyId: "301", taskId: "9005", title: "Works" },
    ]);
  });

  it("fails every template for a story whose fetch rejects or that is not a User Story", async () => {
    const fetchWorkItemById = vi.fn(async ({ workItemId }: { projectId: string; workItemId: string }) => {
      if (workItemId === "666") throw new Error("Azure DevOps request failed (404): missing");
      return requirement({ id: workItemId, workItemType: "Bug" });
    });
    const createChildTask = vi.fn(async () => ({ success: true, azureTaskId: "never" }));
    const adapter = fakeAzureAdapter({ fetchWorkItemById, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [
        { templateId: "tpl-1", title: "Build" },
        { templateId: "tpl-2", title: "Verify" },
      ],
      targets: [{ storyId: "666" }, { storyId: "777" }],
    });

    expect(createChildTask).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual(expect.arrayContaining([
      { templateId: "tpl-1", storyId: "666", title: "Build", error: "Azure DevOps request failed (404): missing" },
      { templateId: "tpl-2", storyId: "666", title: "Verify", error: "Azure DevOps request failed (404): missing" },
      { templateId: "tpl-1", storyId: "777", title: "Build", error: "Expected User Story but found Bug." },
      { templateId: "tpl-2", storyId: "777", title: "Verify", error: "Expected User Story but found Bug." },
    ]));
    expect(result.failed).toHaveLength(4);
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        status: "Failed",
        message: "Created 0 of 4 requested Azure DevOps tasks.",
      }),
    );
  });

  it("fails the story's templates when fetching existing child tasks rejects", async () => {
    const fetchWorkItemById = vi.fn(async () => requirement({ id: "301", childLinks: ["9"] }));
    const fetchWorkItemsByIds = vi.fn(async () => {
      throw new Error("Azure DevOps request failed (500): oops");
    });
    const createChildTask = vi.fn(async () => ({ success: true, azureTaskId: "never" }));
    const adapter = fakeAzureAdapter({ fetchWorkItemById, fetchWorkItemsByIds, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [{ templateId: "tpl-1", title: "Build" }],
      targets: [{ storyId: "301" }],
    });

    expect(createChildTask).not.toHaveBeenCalled();
    expect(result.failed).toEqual([
      { templateId: "tpl-1", storyId: "301", title: "Build", error: "Azure DevOps request failed (500): oops" },
    ]);
  });

  it("writes one audit row with counts and full per-task detail", async () => {
    const fetchWorkItemById = vi.fn(async () => requirement({ id: "301" }));
    const createChildTask = vi.fn(async () => ({ success: true, azureTaskId: "9006" }));
    const adapter = fakeAzureAdapter({ fetchWorkItemById, createChildTask });

    await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [{ templateId: "tpl-1", title: "Build" }],
      targets: [{ storyId: "301" }],
    });

    expect(db.enqueueBackgroundWrite).toHaveBeenCalledWith(
      "audit:azure_devops.bulk_create_tasks",
      expect.any(Function),
    );
    expect(db.sqlRun).toHaveBeenCalledTimes(1);
    expect(db.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.objectContaining({
        projectId: "project-1",
        azureProjectId: "azure-project-1",
        azureProjectName: "Demo Project",
        azureOrganizationUrl: "https://dev.azure.com/demo",
        actor: "qa",
        entityType: "work_item",
        entityId: "bulk-tasks",
        action: "azure_devops.bulk_create_tasks",
        status: "Success",
        message: "Created 1 of 1 requested Azure DevOps tasks.",
      }),
    );
    expect(JSON.parse(String(auditParams().detailsJson))).toMatchObject({
      requestedCount: 1,
      taskTemplateCount: 1,
      targetStoryCount: 1,
      created: [{ templateId: "tpl-1", storyId: "301", taskId: "9006", title: "Build" }],
      skipped: [],
      failed: [],
      results: [{ templateId: "tpl-1", storyId: "301", title: "Build", status: "created", taskId: "9006" }],
    });
  });

  it("rejects an invalid project scope before touching Azure or the audit log", async () => {
    const adapter = fakeAzureAdapter();
    await expect(createBulkTasks(adapter, { projectId: "" } as never, {
      actor: "qa",
      taskTemplates: [{ templateId: "tpl-1", title: "Build" }],
      targets: [{ storyId: "301" }],
    })).rejects.toBeInstanceOf(ProjectIsolationError);
    expect(db.enqueueBackgroundWrite).not.toHaveBeenCalled();
  });

  it("processes at most four stories at once and reports results in target order", async () => {
    let inFlight = 0;
    const observed: number[] = [];
    const fetchWorkItemById = vi.fn(async ({ workItemId }: { projectId: string; workItemId: string }) => {
      inFlight += 1;
      observed.push(inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return requirement({ id: workItemId });
    });
    const createChildTask = vi.fn(async ({ parentStoryId }: { parentStoryId: string }) =>
      ({ success: true, azureTaskId: `task-${parentStoryId}` }),
    );
    const adapter = fakeAzureAdapter({ fetchWorkItemById, createChildTask });

    const result = await createBulkTasks(adapter, projectScope(), {
      actor: "qa",
      taskTemplates: [{ templateId: "tpl-1", title: "Deploy" }],
      targets: ["1", "2", "3", "4", "5", "6"].map((storyId) => ({ storyId })),
    });

    expect(Math.max(...observed)).toBe(4);
    expect(result.results.map((entry) => entry.storyId)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(result.created.map((entry) => entry.taskId)).toEqual([
      "task-1", "task-2", "task-3", "task-4", "task-5", "task-6",
    ]);
  });
});
