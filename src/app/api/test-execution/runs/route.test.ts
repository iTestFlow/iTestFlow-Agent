import { beforeEach, describe, expect, it, vi } from "vitest";

import { jsonRequest, projectScope } from "@/test/factories";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  createRunWithSnapshots: vi.fn(),
  listRuns: vi.fn(),
  findActiveRun: vi.fn(),
  getEnvironmentProfile: vi.fn(),
  startWorkflowRun: vi.fn(() => "analytics-run-1"),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/test-execution/run.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/test-execution/run.service")>();
  return {
    ...actual,
    createRunWithSnapshots: mocks.createRunWithSnapshots,
    listRuns: mocks.listRuns,
    findActiveRun: mocks.findActiveRun,
  };
});
vi.mock("@/modules/test-execution/environment-profile.service", () => ({
  getEnvironmentProfile: mocks.getEnvironmentProfile,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  completeWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));
vi.mock("@/modules/security/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/security/rate-limit")>();
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import {
  ActiveRunConflictError,
  RunPlanValidationError,
} from "@/modules/test-execution/run.service";
import { TestExecutionUnavailableError } from "@/modules/jobs/test-execution-jobs.service";
import { GET, POST } from "./route";

const scope = projectScope();
const ctx = { userId: "user-1", workspace: { id: scope.workspaceId ?? "ws-1", azureOrgUrl: scope.azureOrganizationUrl } };

const validBody = {
  scope,
  environment: {
    mode: "one_time",
    config: {
      initialUrl: "https://app.example.com/login",
      allowedOrigin: "https://app.example.com",
    },
    secrets: [],
  },
  story: null,
  cases: [
    {
      title: "Manual case",
      sourceKind: "manual",
      plan: {
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Open the dashboard", expectedResult: "Welcome banner is visible" }],
      },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.requireWorkflowContext.mockResolvedValue(ctx);
  mocks.resolveProjectScope.mockResolvedValue(scope);
  mocks.getUserAzureAdapter.mockResolvedValue({});
  mocks.createRunWithSnapshots.mockResolvedValue({ runId: "trun_1", jobId: "job_1" });
});

describe("POST /api/test-execution/runs", () => {
  it("creates and enqueues a run (202) with analytics provenance", async () => {
    const response = await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ runId: "trun_1", jobId: "job_1", analyticsRunId: "analytics-run-1" });
    expect(mocks.resolveProjectScope).toHaveBeenCalledWith(ctx, scope);
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowType: "test_execution" }),
    );
  });

  it("rejects unauthenticated callers with the auth mapping", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new WorkflowAuthError("Sign in first.", 401));
    const response = await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(response.status).toBe(401);
  });

  it("rejects structurally invalid plans with 400 before any service call", async () => {
    const bad = structuredClone(validBody);
    bad.cases[0].plan.steps = [] as never;
    const response = await POST(jsonRequest("/api/test-execution/runs", bad));
    expect(response.status).toBe(400);
    expect(mocks.createRunWithSnapshots).not.toHaveBeenCalled();
  });

  it("maps RunPlanValidationError to 422 with findings", async () => {
    mocks.createRunWithSnapshots.mockRejectedValue(
      new RunPlanValidationError([
        { severity: "error", code: "invalid_plan", message: "Case 1: steps: Array must contain at least 1 element(s)" },
      ]),
    );
    const response = await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.findings).toHaveLength(1);
  });

  it("maps ActiveRunConflictError to 409 with the active run id", async () => {
    mocks.createRunWithSnapshots.mockRejectedValue(new ActiveRunConflictError("trun_active"));
    const response = await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(response.status).toBe(409);
    expect((await response.json()).activeRunId).toBe("trun_active");
  });

  it("maps worker-capacity unavailability to 503 with Retry-After", async () => {
    mocks.createRunWithSnapshots.mockRejectedValue(new TestExecutionUnavailableError());
    const response = await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("rate limits with 429", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const response = await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(response.status).toBe(429);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("returns 404 when the selected environment profile does not exist", async () => {
    mocks.getEnvironmentProfile.mockResolvedValue(null);
    const body = {
      ...validBody,
      environment: { mode: "profile", environmentProfileId: "tenv_missing" },
    };
    const response = await POST(jsonRequest("/api/test-execution/runs", body));
    expect(response.status).toBe(404);
    expect(mocks.createRunWithSnapshots).not.toHaveBeenCalled();
  });
});

describe("GET /api/test-execution/runs", () => {
  it("lists runs under the trusted scope", async () => {
    mocks.listRuns.mockResolvedValue([{ id: "trun_1", status: "completed" }]);
    mocks.findActiveRun.mockResolvedValue(null);
    const url = new URL("https://test.local/api/test-execution/runs");
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value === "string") url.searchParams.set(key, value);
    }
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs).toHaveLength(1);
    expect(mocks.resolveProjectScope).toHaveBeenCalled();
  });

  it("rejects requests without a project scope", async () => {
    const response = await GET(new Request("https://test.local/api/test-execution/runs"));
    expect(response.status).toBe(400);
  });
});

