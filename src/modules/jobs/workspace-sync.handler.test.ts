import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  sqlAll: vi.fn(),
}));
const credentials = vi.hoisted(() => ({ resolveWorkspaceSyncPat: vi.fn() }));
const azure = vi.hoisted(() => ({ AzureDevOpsRestAdapter: vi.fn() }));
const contextStore = vi.hoisted(() => ({ indexAzureWorkItemsAsProjectContext: vi.fn() }));
const jobQueue = vi.hoisted(() => ({ enqueueJob: vi.fn() }));

vi.mock("@/modules/shared/infrastructure/database/db", () => database);
vi.mock("@/modules/credentials/credential.service", () => credentials);
vi.mock("@/modules/integrations/azure-devops/azure-devops-client", () => azure);
vi.mock("@/modules/rag/project-context-store.service", () => contextStore);
vi.mock("./job-queue.service", () => jobQueue);

import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults";
import type { Job } from "./job-queue.service";
import {
  enqueueWorkspaceContextSync,
  runWorkspaceContextSync,
  WORKSPACE_CONTEXT_SYNC,
} from "./workspace-sync.handler";

const projectRow = {
  azure_project_id: "azp-1",
  azure_project_name: "Contoso",
  azure_organization_url: "https://dev.azure.com/contoso",
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    workspaceId: "ws-1",
    jobType: WORKSPACE_CONTEXT_SYNC,
    payload: { projectId: "proj-1" },
    dedupeKey: null,
    status: "running",
    priority: 100,
    attempts: 1,
    maxAttempts: 3,
    lockedBy: "worker-1",
    lockedAt: "2026-07-06T00:00:00.000Z",
    runAfter: "2026-07-06T00:00:00.000Z",
    errorMessage: null,
    createdByUserId: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("runWorkspaceContextSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.sqlGet.mockResolvedValue(projectRow);
    credentials.resolveWorkspaceSyncPat.mockResolvedValue("sync-pat");
    contextStore.indexAzureWorkItemsAsProjectContext.mockResolvedValue(undefined);
  });

  it("rejects a job without a workspaceId before touching the database", async () => {
    await expect(runWorkspaceContextSync(makeJob({ workspaceId: null }))).rejects.toThrow(
      "workspace_context_sync requires a workspaceId.",
    );
    expect(database.sqlGet).not.toHaveBeenCalled();
    expect(credentials.resolveWorkspaceSyncPat).not.toHaveBeenCalled();
  });

  it.each([{}, { projectId: "" }, { projectId: 42 }])(
    "rejects malformed payload %o without resolving credentials",
    async (payload) => {
      await expect(runWorkspaceContextSync(makeJob({ payload }))).rejects.toThrow(
        "workspace_context_sync payload requires projectId.",
      );
      expect(credentials.resolveWorkspaceSyncPat).not.toHaveBeenCalled();
      expect(contextStore.indexAzureWorkItemsAsProjectContext).not.toHaveBeenCalled();
    },
  );

  it("resolves the project scoped to the job's workspace and fails when it is missing", async () => {
    database.sqlGet.mockResolvedValue(undefined);
    await expect(runWorkspaceContextSync(makeJob())).rejects.toThrow(
      "Project not found in this workspace.",
    );
    expect(database.sqlGet).toHaveBeenCalledWith(
      expect.stringContaining("workspace_id = @workspaceId"),
      { projectId: "proj-1", workspaceId: "ws-1" },
    );
    expect(credentials.resolveWorkspaceSyncPat).not.toHaveBeenCalled();
  });

  it("surfaces an actionable error when no workspace sync credential is configured", async () => {
    credentials.resolveWorkspaceSyncPat.mockResolvedValue(null);
    await expect(runWorkspaceContextSync(makeJob())).rejects.toThrow(
      "No workspace sync credential configured. Set one in Workspace settings.",
    );
    expect(credentials.resolveWorkspaceSyncPat).toHaveBeenCalledWith("ws-1");
    expect(azure.AzureDevOpsRestAdapter).not.toHaveBeenCalled();
    expect(contextStore.indexAzureWorkItemsAsProjectContext).not.toHaveBeenCalled();
  });

  it("indexes with the DB-resolved trusted scope, sync-PAT adapter, and payload filters", async () => {
    await runWorkspaceContextSync(
      makeJob({ payload: { projectId: "proj-1", workItemTypes: ["Bug"], states: ["Active"] } }),
    );
    // The adapter is built from the workspace sync PAT, never a user credential.
    expect(azure.AzureDevOpsRestAdapter).toHaveBeenCalledWith(
      { organizationUrl: "https://dev.azure.com/contoso", personalAccessToken: "sync-pat" },
      { azureProjectId: "azp-1", azureProjectName: "Contoso" },
    );
    expect(contextStore.indexAzureWorkItemsAsProjectContext).toHaveBeenCalledTimes(1);
    // Scope comes from the projects row, not the job payload.
    expect(contextStore.indexAzureWorkItemsAsProjectContext).toHaveBeenCalledWith({
      scope: {
        projectId: "proj-1",
        azureProjectId: "azp-1",
        azureProjectName: "Contoso",
        azureOrganizationUrl: "https://dev.azure.com/contoso",
      },
      actor: "system:worker",
      adapter: azure.AzureDevOpsRestAdapter.mock.instances[0],
      workItemTypes: ["Bug"],
      states: ["Active"],
      mode: "incremental",
    });
  });

  it.each([
    {},
    { workItemTypes: [], states: [] },
    { workItemTypes: "Bug", states: "Active" },
  ])("applies default filters when the payload carries %o", async (filters) => {
    await runWorkspaceContextSync(makeJob({ payload: { projectId: "proj-1", ...filters } }));
    expect(contextStore.indexAzureWorkItemsAsProjectContext).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemTypes: DEFAULT_CONTEXT_WORK_ITEM_TYPES,
        states: DEFAULT_CONTEXT_STATES,
      }),
    );
  });
});

describe("enqueueWorkspaceContextSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.sqlAll.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    jobQueue.enqueueJob.mockResolvedValue("job-new");
  });

  it("enqueues one deduped job per active workspace project, not counting dedupe skips", async () => {
    // Second project already has an active job: enqueueJob reports null.
    jobQueue.enqueueJob.mockResolvedValueOnce("job-a").mockResolvedValueOnce(null);
    await expect(enqueueWorkspaceContextSync("ws-1", "user-1")).resolves.toBe(1);
    expect(database.sqlAll).toHaveBeenCalledWith(
      expect.stringContaining("workspace_id = @workspaceId AND status = 'active'"),
      { workspaceId: "ws-1" },
    );
    expect(jobQueue.enqueueJob).toHaveBeenNthCalledWith(1, {
      jobType: WORKSPACE_CONTEXT_SYNC,
      workspaceId: "ws-1",
      payload: { projectId: "p1" },
      dedupeKey: "context_sync:p1",
      createdByUserId: "user-1",
    });
    expect(jobQueue.enqueueJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ dedupeKey: "context_sync:p2" }),
    );
  });

  it.each([undefined, { workItemTypes: [], states: [] }])(
    "omits filter keys from the payload when filters are %o",
    async (filters) => {
      await enqueueWorkspaceContextSync("ws-1", null, filters);
      // Exact payload equality: absent filters must not appear as keys at all.
      expect(jobQueue.enqueueJob).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { projectId: "p1" }, createdByUserId: null }),
      );
    },
  );

  it("passes non-empty filters through to every project's payload", async () => {
    await expect(
      enqueueWorkspaceContextSync("ws-1", "user-1", { workItemTypes: ["Bug"], states: ["New"] }),
    ).resolves.toBe(2);
    expect(jobQueue.enqueueJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: { projectId: "p2", workItemTypes: ["Bug"], states: ["New"] },
      }),
    );
  });

  it("enqueues nothing when the workspace has no active projects", async () => {
    database.sqlAll.mockResolvedValue([]);
    await expect(enqueueWorkspaceContextSync("ws-1", null)).resolves.toBe(0);
    expect(jobQueue.enqueueJob).not.toHaveBeenCalled();
  });
});
