import { describe, expect, it } from "vitest";

import {
  buildSystemDashboardEffectiveScope,
  resolveSystemDashboardAccess,
} from "./system-dashboard-scope";

describe("system dashboard scope resolution", () => {
  it("forces members to their own analytics rows", () => {
    const access = resolveSystemDashboardAccess({
      role: "member",
      requestedUserId: null,
      currentUserId: "user_member",
    });

    expect(access.permissions.canViewWorkspaceUsers).toBe(false);
    expect(access.userId).toBe("user_member");
    expect(buildSystemDashboardEffectiveScope({
      userId: access.userId,
      currentUserId: "user_member",
    })).toEqual({ mode: "mine", label: "My activity", userId: "user_member" });
  });

  it("allows owners to request team-wide analytics", () => {
    const access = resolveSystemDashboardAccess({
      role: "owner",
      requestedUserId: null,
      currentUserId: "user_owner",
    });

    expect(access.permissions.canViewWorkspaceUsers).toBe(true);
    expect(access.userId).toBeNull();
    expect(buildSystemDashboardEffectiveScope({
      userId: access.userId,
      currentUserId: "user_owner",
    })).toEqual({ mode: "team", label: "All users", userId: null });
  });

  it("allows admins to request a specific user's analytics", () => {
    const access = resolveSystemDashboardAccess({
      role: "admin",
      requestedUserId: " user_member ",
      currentUserId: "user_admin",
    });

    expect(access.permissions.canViewWorkspaceUsers).toBe(true);
    expect(access.userId).toBe("user_member");
    expect(buildSystemDashboardEffectiveScope({
      userId: access.userId,
      currentUserId: "user_admin",
      userLabel: "Morgan Member",
    })).toEqual({ mode: "user", label: "Morgan Member", userId: "user_member" });
  });

  it("labels an owner's self-filter as my activity", () => {
    const access = resolveSystemDashboardAccess({
      role: "owner",
      requestedUserId: "user_owner",
      currentUserId: "user_owner",
    });

    expect(access.userId).toBe("user_owner");
    expect(buildSystemDashboardEffectiveScope({
      userId: access.userId,
      currentUserId: "user_owner",
      userLabel: "Olivia Owner",
    })).toEqual({ mode: "mine", label: "My activity", userId: "user_owner" });
  });
});
