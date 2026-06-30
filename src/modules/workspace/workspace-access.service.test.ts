import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  sqlGet: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => database);

import {
  getWorkspaceMembership,
  requireWorkspaceAccess,
  requireWorkspaceRole,
  WorkspaceAccessError,
} from "./workspace-access.service";

describe("workspace access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps an active membership and uses parameterized identity filters", async () => {
    database.sqlGet.mockResolvedValue({
      id: "member-1",
      workspace_id: "ws-1",
      user_id: "user-1",
      role: "admin",
      status: "active",
    });
    await expect(getWorkspaceMembership("user-1", "ws-1")).resolves.toEqual({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "admin",
      status: "active",
    });
    expect(database.sqlGet).toHaveBeenCalledWith(
      expect.stringContaining("user_id = @userId"),
      { userId: "user-1", workspaceId: "ws-1" },
    );
  });

  it.each([undefined, { status: "disabled" }])(
    "treats absent or inactive membership as inaccessible",
    async (row) => {
      database.sqlGet.mockResolvedValue(row);
      await expect(getWorkspaceMembership("user", "ws")).resolves.toBeNull();
      await expect(requireWorkspaceAccess("user", "ws")).rejects.toBeInstanceOf(WorkspaceAccessError);
    },
  );

  it("allows listed roles and rejects all others", async () => {
    database.sqlGet.mockResolvedValue({
      id: "member-1", workspace_id: "ws", user_id: "user", role: "member", status: "active",
    });
    await expect(requireWorkspaceRole("user", "ws", ["member"])).resolves.toMatchObject({ role: "member" });
    await expect(requireWorkspaceRole("user", "ws", ["owner"])).rejects.toThrow("not permitted");
  });
});
