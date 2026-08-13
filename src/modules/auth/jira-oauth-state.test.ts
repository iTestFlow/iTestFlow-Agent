import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`,
  nowIso: () => "2026-08-13T10:00:00.000Z",
  sqlGet: mocks.sqlGet,
  sqlRun: mocks.sqlRun,
}));

import { consumeJiraOAuthState, createJiraOAuthState, JiraOAuthStateError } from "./jira-oauth-state";

describe("Jira OAuth state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores only a hash of a strong opaque state with a short expiry", async () => {
    mocks.sqlRun.mockResolvedValue(1);

    const state = await createJiraOAuthState("/settings/integrations", "browser-secret");

    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mocks.sqlRun).toHaveBeenCalledOnce();
    const [, params] = mocks.sqlRun.mock.calls[0];
    expect(params).toMatchObject({ id: "oauthstate_fixed", returnTo: "/settings/integrations" });
    expect(params.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(params.stateHash).not.toContain(state);
    expect(params.browserBindingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(params.browserBindingHash).not.toContain("browser-secret");
    expect(Date.parse(params.expiresAt) - Date.parse(params.now)).toBe(10 * 60 * 1000);
  });

  it("atomically consumes a matching unexpired state exactly once", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ return_to: "/settings/integrations" }).mockResolvedValueOnce(undefined);

    await expect(consumeJiraOAuthState("opaque-state", "browser-secret")).resolves.toEqual({ returnTo: "/settings/integrations" });
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("DELETE FROM jira_oauth_states");
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("expires_at > @now");
    expect(mocks.sqlGet.mock.calls[0][1].stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.sqlGet.mock.calls[0][1].browserBindingHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(consumeJiraOAuthState("opaque-state", "different-browser")).rejects.toBeInstanceOf(JiraOAuthStateError);
  });

  it("rejects unsafe return destinations before persistence", async () => {
    for (const destination of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/\\evil.example/steal",
      "/%5cevil.example/steal",
    ]) {
      await expect(createJiraOAuthState(destination, "browser-secret")).rejects.toThrow("return destination");
    }
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });
});
