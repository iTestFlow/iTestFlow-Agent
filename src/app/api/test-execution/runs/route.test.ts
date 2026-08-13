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
  freezeSameOriginOpenApiContract: vi.fn(),
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
vi.mock("@/modules/test-execution/openapi-contract.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/test-execution/openapi-contract.service")>();
  return { ...actual, freezeSameOriginOpenApiContract: mocks.freezeSameOriginOpenApiContract };
});
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
  RunEnvironmentSnapshotConflictError,
  RunPlanValidationError,
} from "@/modules/test-execution/run.service";
import { OpenApiContractImportError } from "@/modules/test-execution/openapi-contract.service";
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
  mocks.freezeSameOriginOpenApiContract.mockResolvedValue({
    revisionId: "tacr_frozen_1",
    revision: 1,
    operationCount: 1,
    reused: false,
  });
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

  it("stamps the intent-v1 execution policy into the frozen config", async () => {
    await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(mocks.createRunWithSnapshots).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({
        config: expect.objectContaining({ executionPolicyVersion: "intent-v1" }),
      }),
    }));
  });

  it("accepts and ignores deprecated authorization fields from old clients", async () => {
    const body = structuredClone(validBody) as Record<string, unknown>;
    // Pre-simplification clients sent operation pins and access modes; both
    // are stripped, never rejected, so old clients still get a 202.
    body.capabilityRevisionIds = ["tior_old_1"];
    Object.assign((body.environment as { config: Record<string, unknown> }).config, {
      api: {
        baseUrl: "https://api.example.test/v1",
        auth: { type: "none" },
        mutationMode: "approved_catalog",
      },
    });

    const response = await POST(jsonRequest("/api/test-execution/runs", body));

    expect(response.status).toBe(202);
    const input = mocks.createRunWithSnapshots.mock.calls[0][0];
    expect(input).not.toHaveProperty("capabilityRevisionIds");
    expect(input.environment.config.api).not.toHaveProperty("mutationMode");
  });

  it("freezes a same-origin OpenAPI URL before snapshotting the run", async () => {
    const body = structuredClone(validBody);
    Object.assign(body.environment.config, {
      api: {
        baseUrl: "https://api.example.test/v1",
        contract: { kind: "same_origin_url", url: "https://api.example.test/openapi.json" },
        auth: { type: "none" },
        requestTimeoutMs: 2_500,
        mutationMode: "disabled",
      },
    });

    const response = await POST(jsonRequest("/api/test-execution/runs", body));

    expect(response.status).toBe(202);
    expect(mocks.freezeSameOriginOpenApiContract).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: ctx.workspace.id,
      baseUrl: "https://api.example.test/v1",
      sourceUrl: "https://api.example.test/openapi.json",
      // Discovery downloads a whole OpenAPI document: the tight per-request
      // budget is floored (V4-5) instead of reused verbatim.
      timeoutMs: 30_000,
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.createRunWithSnapshots).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({
        config: expect.objectContaining({
          api: expect.objectContaining({
            contract: { kind: "revision", revisionId: "tacr_frozen_1" },
          }),
        }),
      }),
    }));
  });

  it("returns the safe OpenAPI import failure without creating a run", async () => {
    const body = structuredClone(validBody);
    Object.assign(body.environment.config, {
      api: {
        baseUrl: "https://api.example.test/v1",
        contract: { kind: "same_origin_url", url: "https://api.example.test/openapi.json" },
        auth: { type: "none" },
        requestTimeoutMs: 2_500,
        mutationMode: "disabled",
      },
    });
    mocks.freezeSameOriginOpenApiContract.mockRejectedValue(
      new OpenApiContractImportError("The OpenAPI URL is not allowed by the workspace egress policy.", 403),
    );

    const response = await POST(jsonRequest("/api/test-execution/runs", body));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/egress policy/i);
    expect(mocks.createRunWithSnapshots).not.toHaveBeenCalled();
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

  it("requires review again when a saved environment changed before freezing", async () => {
    mocks.createRunWithSnapshots.mockRejectedValue(new RunEnvironmentSnapshotConflictError());
    const response = await POST(jsonRequest("/api/test-execution/runs", validBody));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/changed after review/i);
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
      environment: {
        mode: "profile",
        environmentProfileId: "tenv_missing",
        reviewedProfileUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const response = await POST(jsonRequest("/api/test-execution/runs", body));
    expect(response.status).toBe(404);
    expect(mocks.createRunWithSnapshots).not.toHaveBeenCalled();
  });

  it("rejects a profile selection without the reviewed version token", async () => {
    const body = {
      ...validBody,
      environment: { mode: "profile", environmentProfileId: "tenv_1" },
    };
    const response = await POST(jsonRequest("/api/test-execution/runs", body));
    expect(response.status).toBe(400);
    expect(mocks.createRunWithSnapshots).not.toHaveBeenCalled();
  });

  it("freezes the CLIENT's reviewed profile version, not the re-fetched one (V7-1)", async () => {
    mocks.getEnvironmentProfile.mockResolvedValue({
      id: "tenv_1",
      lifecycleStatus: "active",
      // The server-side row has already moved on...
      updatedAt: "2026-02-02T00:00:00.000Z",
      name: "Staging",
      initialUrl: "",
      allowedOrigin: "",
      viewportWidth: 1280,
      viewportHeight: 720,
      headless: true,
      defaultTimeoutMs: 10_000,
      navigationTimeoutMs: 30_000,
      evidenceLevel: "on_failure",
      loginPlan: null,
      loginMode: "session",
      loggedInText: "",
      executionNotes: "",
      users: [],
      api: null,
      database: null,
      secrets: [],
      sessionCapturedAt: null,
    });
    const body = {
      ...validBody,
      environment: {
        mode: "profile",
        environmentProfileId: "tenv_1",
        // ...but the approver reviewed THIS version; the lock check must
        // compare against it so a changed profile 409s instead of freezing.
        reviewedProfileUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const response = await POST(jsonRequest("/api/test-execution/runs", body));
    expect(response.status).toBe(202);
    expect(mocks.createRunWithSnapshots).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({
        profileId: "tenv_1",
        profileUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
    }));
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
