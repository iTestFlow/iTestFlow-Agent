import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
}));

vi.mock("@/modules/workspace/workspace-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-request")>();
  return { ...actual, resolveWorkspaceRequest: mocks.resolveWorkspaceRequest };
});
vi.mock("@/modules/workspace/workspace-access.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-access.service")>();
  return { ...actual, getWorkspaceMembership: mocks.getWorkspaceMembership };
});
vi.mock("@/modules/workspace/workspace-members.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/workspace/workspace-members.service")>();
  return {
    ...actual,
    updateMemberRole: mocks.updateMemberRole,
    removeMember: mocks.removeMember,
  };
});

import { SessionError } from "@/modules/auth/session.service";
import { WorkspaceAccessError } from "@/modules/workspace/workspace-access.service";
import { MemberActionError } from "@/modules/workspace/workspace-members.service";
import { jsonRequest } from "@/test/factories";
import { DELETE, PATCH } from "./route";

const params = { params: Promise.resolve({ membershipId: "mbr-target" }) };

describe("workspace member mutation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "owner-1",
      workspace: { id: "ws-1" },
    });
    mocks.getWorkspaceMembership.mockResolvedValue({ role: "owner" });
  });

  it("rejects an invalid role without invoking the service", async () => {
    const response = await PATCH(
      jsonRequest("/api/workspace/members/mbr-target", { role: "superuser" }),
      params,
    );
    expect(response.status).toBe(400);
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it("updates a membership with the server-resolved workspace and actor role", async () => {
    const response = await PATCH(
      jsonRequest("/api/workspace/members/mbr-target", { role: "admin" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.updateMemberRole).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      membershipId: "mbr-target",
      newRole: "admin",
      actor: { userId: "owner-1", role: "owner" },
    });
  });

  it("uses the least-privileged actor role when the membership lookup disappears", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue(null);
    const response = await PATCH(
      jsonRequest("/api/workspace/members/mbr-target", { role: "member" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(mocks.updateMemberRole).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { userId: "owner-1", role: "member" } }),
    );
  });

  it("handles malformed JSON as a validation failure", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/workspace/members/mbr-target", {
        method: "PATCH",
        body: "{",
        headers: { "content-type": "application/json" },
      }),
      params,
    );
    expect(response.status).toBe(400);
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it("removes a membership with the same trusted actor context", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/workspace/members/mbr-target", { method: "DELETE" }),
      params,
    );
    expect(response.status).toBe(200);
    expect(mocks.removeMember).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      membershipId: "mbr-target",
      actor: { userId: "owner-1", role: "owner" },
    });
  });

  it("maps member invariants to their service status", async () => {
    mocks.updateMemberRole.mockRejectedValue(
      new MemberActionError("The last owner cannot be demoted.", 409),
    );
    const response = await PATCH(
      jsonRequest("/api/workspace/members/mbr-target", { role: "member" }),
      params,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The last owner cannot be demoted." });
  });

  it("maps remove-member invariants through the same status contract", async () => {
    mocks.removeMember.mockRejectedValue(new MemberActionError("Cannot remove last admin.", 409));
    const response = await DELETE(
      new Request("http://localhost/api/workspace/members/mbr-target", { method: "DELETE" }),
      params,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Cannot remove last admin." });
  });

  it("rethrows unexpected membership and service failures", async () => {
    const resolutionFailure = new Error("membership database unavailable");
    mocks.resolveWorkspaceRequest.mockRejectedValueOnce(resolutionFailure);
    await expect(PATCH(
      jsonRequest("/api/workspace/members/mbr-target", { role: "member" }),
      params,
    )).rejects.toBe(resolutionFailure);

    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "owner-1",
      workspace: { id: "ws-1" },
    });
    mocks.getWorkspaceMembership.mockResolvedValue({ role: "owner" });
    const updateFailure = new Error("update failed");
    mocks.updateMemberRole.mockRejectedValueOnce(updateFailure);
    await expect(PATCH(
      jsonRequest("/api/workspace/members/mbr-target", { role: "member" }),
      params,
    )).rejects.toBe(updateFailure);

    const removeFailure = new Error("remove failed");
    mocks.removeMember.mockRejectedValueOnce(removeFailure);
    await expect(DELETE(
      new Request("http://localhost/api/workspace/members/mbr-target", { method: "DELETE" }),
      params,
    )).rejects.toBe(removeFailure);
  });

  it.each([
    [new SessionError(), 401],
    [new WorkspaceAccessError("Role denied."), 403],
  ])("maps workspace resolution errors without mutating", async (error, status) => {
    mocks.resolveWorkspaceRequest.mockRejectedValue(error);
    const response = await DELETE(
      new Request("http://localhost/api/workspace/members/mbr-target", { method: "DELETE" }),
      params,
    );
    expect(response.status).toBe(status);
    expect(mocks.removeMember).not.toHaveBeenCalled();
  });
});
