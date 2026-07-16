import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireWorkflowContext: vi.fn(), requireWorkflowRole: vi.fn(), resolveProjectScope: vi.fn() }));
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const requestScope = { ...trustedScope, workspaceId: "workspace-1" };
const params = { params: Promise.resolve({ draftId: "draft-parent" }) };

describe("retired rebase endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
  });

  it("validates project scope before authentication", async () => {
    const response = await POST(jsonRequest("/rebase", { scope: { workspaceId: "workspace-1" } }), params);
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("remains role guarded", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));
    const response = await POST(jsonRequest("/rebase", { scope: requestScope }), params);
    expect(response.status).toBe(403);
  });

  it("returns 410 without invoking a rebase workflow", async () => {
    const response = await POST(jsonRequest("/rebase", { scope: requestScope }), params);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "Rebase was removed in Project Knowledge v4. Start a new build to include newer sources.",
      code: "rebase_removed",
    });
  });
});
