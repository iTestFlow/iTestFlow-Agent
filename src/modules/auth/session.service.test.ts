import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  createId: vi.fn(() => "sess-1"),
  nowIso: vi.fn(() => "2026-07-06T00:00:00.000Z"),
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
}));
const cookieStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));
const headers = vi.hoisted(() => ({
  cookies: vi.fn(async () => cookieStore),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => database);
vi.mock("next/headers", () => headers);

import {
  createSession,
  destroySession,
  getOptionalSession,
  persistSession,
  requireSession,
  resolveSessionToken,
  revokeSessionToken,
  SessionError,
} from "./session.service";

describe("session service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.sqlRun.mockResolvedValue(1);
  });

  it("persists only a SHA-256 token hash and the requested workspace", async () => {
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const result = await persistSession({
      userId: "user-1",
      workspaceId: "ws-1",
      ip: "127.0.0.1",
      userAgent: "vitest",
      ttlMs: 60_000,
    });

    expect(result).toMatchObject({
      sessionId: "sess-1",
      expiresAt: "2026-07-06T00:01:00.000Z",
    });
    const params = database.sqlRun.mock.calls[0][1];
    expect(params).toMatchObject({
      id: "sess-1",
      userId: "user-1",
      activeWorkspaceId: "ws-1",
      ip: "127.0.0.1",
      userAgent: "vitest",
    });
    expect(params.hashedToken).toMatch(/^[a-f0-9]{64}$/);
    expect(params.hashedToken).not.toBe(result.token);
    expect(JSON.stringify(database.sqlRun.mock.calls[0])).not.toContain(result.token);
  });

  it("resolves an active session and rejects missing, revoked, and expired tokens", async () => {
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    await expect(resolveSessionToken("")).resolves.toBeNull();
    expect(database.sqlGet).not.toHaveBeenCalled();

    database.sqlGet.mockResolvedValueOnce(undefined);
    await expect(resolveSessionToken("unknown")).resolves.toBeNull();

    database.sqlGet.mockResolvedValueOnce({
      id: "sess-1",
      user_id: "user-1",
      active_workspace_id: "ws-1",
      expires_at: "2026-07-07T00:00:00.000Z",
      revoked_at: "2026-07-05T00:00:00.000Z",
    });
    await expect(resolveSessionToken("revoked")).resolves.toBeNull();

    database.sqlGet.mockResolvedValueOnce({
      id: "sess-1",
      user_id: "user-1",
      active_workspace_id: "ws-1",
      expires_at: "2026-07-05T00:00:00.000Z",
      revoked_at: null,
    });
    await expect(resolveSessionToken("expired")).resolves.toBeNull();

    database.sqlGet.mockResolvedValueOnce({
      id: "sess-1",
      user_id: "user-1",
      active_workspace_id: "ws-1",
      expires_at: "2026-07-07T00:00:00.000Z",
      revoked_at: null,
    });
    await expect(resolveSessionToken("active")).resolves.toEqual({
      sessionId: "sess-1",
      userId: "user-1",
      activeWorkspaceId: "ws-1",
    });
  });

  it("revokes idempotently and ignores an absent token", async () => {
    await revokeSessionToken("");
    expect(database.sqlRun).not.toHaveBeenCalled();

    await revokeSessionToken("secret");
    expect(database.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("revoked_at IS NULL"),
      expect.objectContaining({ now: "2026-07-06T00:00:00.000Z" }),
    );
    expect(database.sqlRun.mock.calls[0][1].hashedToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sets an opaque httpOnly cookie with production security attributes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createSession({ userId: "user-1", workspaceId: "ws-1" });

    expect(cookieStore.set).toHaveBeenCalledWith(
      "itf_session",
      expect.any(String),
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
      },
    );
  });

  it("returns null without a cookie and requireSession throws the public auth error", async () => {
    cookieStore.get.mockReturnValue(undefined);
    await expect(getOptionalSession()).resolves.toBeNull();
    await expect(requireSession()).rejects.toBeInstanceOf(SessionError);
    expect(database.sqlGet).not.toHaveBeenCalled();
  });

  it("destroys the persisted session before clearing its cookie", async () => {
    cookieStore.get.mockReturnValue({ value: "raw-token" });
    await destroySession();

    expect(database.sqlRun).toHaveBeenCalledTimes(1);
    expect(cookieStore.delete).toHaveBeenCalledWith("itf_session");
    expect(database.sqlRun.mock.invocationCallOrder[0]).toBeLessThan(
      cookieStore.delete.mock.invocationCallOrder[0],
    );
  });
});
