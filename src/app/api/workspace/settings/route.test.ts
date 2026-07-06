import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  upsertWorkspaceSettings: vi.fn(),
}));

vi.mock("@/modules/workspace/workspace-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-request")>();
  return { ...actual, resolveWorkspaceRequest: mocks.resolveWorkspaceRequest };
});
vi.mock("@/modules/workspace/workspace-settings.service", () => ({
  getWorkspaceSettings: mocks.getWorkspaceSettings,
  upsertWorkspaceSettings: mocks.upsertWorkspaceSettings,
}));

import { WorkspaceAccessError } from "@/modules/workspace/workspace-access.service";
import { jsonRequest } from "@/test/factories";
import { GET, PUT } from "./route";

describe("workspace settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "admin-1",
      workspace: { id: "ws-1" },
    });
    mocks.getWorkspaceSettings.mockResolvedValue(null);
    mocks.upsertWorkspaceSettings.mockImplementation(async (input) => input);
  });

  it("returns inherited defaults without caching when no row exists", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // Role guard requires owner/admin.
    expect(mocks.resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
    expect(await response.json()).toMatchObject({
      workspaceId: "ws-1",
      settings: {
        retrievalTopK: null,
        maxOutputTokenCap: null,
        llmRetryAttempts: null,
      },
    });
  });

  it("updates only validated settings under the server-resolved workspace", async () => {
    const response = await PUT(jsonRequest("/api/workspace/settings", {
      retrievalTopK: 12,
      maxOutputTokenCap: 16000,
      llmRetryAttempts: 2,
    }));
    expect(response.status).toBe(200);
    // Role guard requires owner/admin.
    expect(mocks.resolveWorkspaceRequest).toHaveBeenCalledWith(["owner", "admin"]);
    expect(mocks.upsertWorkspaceSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        updatedByUserId: "admin-1",
        retrievalTopK: 12,
        maxOutputTokenCap: 16000,
        llmRetryAttempts: 2,
      }),
    );
  });

  it.each([
    [{}, "Provide a setting to update."],
    [{ maxOutputTokenCap: 17000 }, "LLM output cap must be one of"],
    [{ retrievalTopK: 1000 }, "less than or equal to 25"],
  ])("rejects invalid settings without writing", async (body, message) => {
    const response = await PUT(jsonRequest("/api/workspace/settings", body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
    expect(mocks.upsertWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("maps a denied workspace role before reading settings", async () => {
    mocks.resolveWorkspaceRequest.mockRejectedValue(new WorkspaceAccessError("Role denied."));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.getWorkspaceSettings).not.toHaveBeenCalled();
  });

  it("rethrows unexpected resolution and persistence failures", async () => {
    const resolutionFailure = new Error("session store unavailable");
    mocks.resolveWorkspaceRequest.mockRejectedValueOnce(resolutionFailure);
    await expect(GET()).rejects.toBe(resolutionFailure);

    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "admin-1",
      workspace: { id: "ws-1" },
    });
    const persistenceFailure = new Error("settings write failed");
    mocks.upsertWorkspaceSettings.mockRejectedValueOnce(persistenceFailure);
    await expect(PUT(jsonRequest("/api/workspace/settings", {
      retrievalTopK: 12,
    }))).rejects.toBe(persistenceFailure);
  });
});
