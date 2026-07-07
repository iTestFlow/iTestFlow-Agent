import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  postBugReportToAzureDevOps: vi.fn(),
  completeWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
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
vi.mock("@/modules/bug-reporting/bug-posting.service", () => ({
  postBugReportToAzureDevOps: mocks.postBugReportToAzureDevOps,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  completeWorkflowRun: mocks.completeWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { SessionError } from "@/modules/auth/session.service";
import { fakeAzureAdapter, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function report() {
  return {
    title: "Checkout fails",
    precondition: "Customer has items",
    stepsToReproduce: "Submit checkout",
    expectedResult: "Order succeeds",
    actualResult: "An error appears",
    systemInfo: "Chrome",
    severity: "2 - High",
    priority: 2,
    contextUsed: [],
  };
}

function request(payload: unknown, attachments: File[] = []) {
  const form = new FormData();
  form.set("payload", typeof payload === "string" ? payload : JSON.stringify(payload));
  for (const attachment of attachments) form.append("attachments", attachment);
  return new Request("http://localhost/api/bugs/post", { method: "POST", body: form });
}

describe("POST /api/bugs/post", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter());
    mocks.postBugReportToAzureDevOps.mockResolvedValue({
      bugId: "900",
      webUrl: "https://dev.azure.com/demo/_workitems/edit/900",
      attachmentResults: [],
    });
  });

  it("rejects a missing, malformed, or schema-invalid payload before authentication", async () => {
    const missing = await POST(new Request("http://localhost/api/bugs/post", {
      method: "POST",
      body: new FormData(),
    }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Bug post payload is required." });

    const malformed = await POST(request("{"));
    expect(malformed.status).toBe(400);

    const invalid = await POST(request({ scope: { ...trustedScope, workspaceId: "ws-1" } }));
    expect(invalid.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("forwards real attachments and completes the trusted analytics run", async () => {
    mocks.postBugReportToAzureDevOps.mockResolvedValue({
      bugId: "900",
      webUrl: "https://dev.azure.com/demo/_workitems/edit/900",
      attachmentResults: [
        { fileName: "one.txt", success: true },
        { fileName: "two.txt", success: false, error: "rejected" },
      ],
    });
    const response = await POST(request({
      scope: { ...trustedScope, workspaceId: "ws-1" },
      report: report(),
      analyticsRunId: "run-1",
    }, [
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]));

    expect(response.status).toBe(200);
    expect(mocks.postBugReportToAzureDevOps).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: trustedScope,
        actor: "user-1",
        attachments: [
          expect.objectContaining({ fileName: "one.txt", contentType: "text/plain" }),
          expect.objectContaining({ fileName: "two.txt", contentType: "text/plain" }),
        ],
      }),
    );
    expect(mocks.completeWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      status: "published",
      valueRealized: true,
      patch: {
        itemsSelected: 1,
        itemsPublished: 1,
        manualActionsAvoided: 2,
      },
    });
  });

  it("does not write analytics when the request carries no run ID", async () => {
    const response = await POST(request({
      scope: { ...trustedScope, workspaceId: "ws-1" },
      report: report(),
    }));
    expect(response.status).toBe(200);
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("fails an established analytics run when downstream posting rejects", async () => {
    mocks.postBugReportToAzureDevOps.mockRejectedValue(new Error("Azure unavailable"));
    const response = await POST(request({
      scope: { ...trustedScope, workspaceId: "ws-1" },
      report: report(),
      analyticsRunId: "run-1",
    }));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("The service is temporarily unavailable. Try again in a moment.");
    expect(body.technicalDetails).toContain("Azure unavailable");
    expect(mocks.failWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      error: "Azure unavailable",
    });
  });

  it("maps authentication failure without posting or finalizing analytics", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new SessionError());
    const response = await POST(request({
      scope: { ...trustedScope, workspaceId: "ws-1" },
      report: report(),
      analyticsRunId: "run-forged",
    }));

    expect(response.status).toBe(401);
    expect(mocks.postBugReportToAzureDevOps).not.toHaveBeenCalled();
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });
});
