import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlRun: vi.fn(), sqlGet: vi.fn(), encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`, nowIso: () => "2026-08-13T10:00:00.000Z",
  sqlRun: mocks.sqlRun, sqlGet: mocks.sqlGet,
}));
vi.mock("@/modules/security/encryption.service", () => ({
  encryptSecret: mocks.encryptSecret, decryptSecret: mocks.decryptSecret,
}));

import { consumeJiraSiteSelection, createJiraSiteSelection, getJiraSiteSelectionOptions } from "./jira-site-selection.service";

describe("Jira multi-site selection continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ATLASSIAN_ALLOWED_CLOUD_IDS", "cloud-a,cloud-b");
    mocks.encryptSecret
      .mockReturnValueOnce({ ciphertext: "enc-a", iv: "iv-a", tag: "tag-a", keyVersion: 1 })
      .mockReturnValueOnce({ ciphertext: "enc-r", iv: "iv-r", tag: "tag-r", keyVersion: 1 });
  });

  it("stores a one-time browser-bound continuation with encrypted tokens", async () => {
    const continuation = await createJiraSiteSelection({
      browserBinding: "browser-secret", returnTo: "/settings", accessToken: "access", refreshToken: "refresh",
      expiresInSeconds: 3600, scopes: "offline_access",
      resources: [
        { id: "cloud-a", name: "A", url: "https://a.atlassian.net", scopes: [] },
        { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
      ],
    });
    expect(continuation).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const [, params] = mocks.sqlRun.mock.calls[0];
    expect(params).toMatchObject({ encryptedAccessToken: "enc-a", encryptedRefreshToken: "enc-r" });
    expect(JSON.stringify(params)).not.toContain('"access"');
    expect(JSON.stringify(params)).not.toContain('"refresh"');
  });

  it("atomically consumes only a selected resource present in the continuation", async () => {
    mocks.sqlGet.mockResolvedValue({
      encrypted_access_token: "enc-a", access_token_iv: "iv-a", access_token_tag: "tag-a",
      encrypted_refresh_token: "enc-r", refresh_token_iv: "iv-r", refresh_token_tag: "tag-r", key_version: 1,
      access_expires_at: "2026-08-13T11:00:00.000Z", scopes: "offline_access", return_to: "/settings",
      resources_json: JSON.stringify([
        { id: "cloud-a", name: "A", url: "https://a.atlassian.net", scopes: [] },
        { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
      ]),
    });
    mocks.decryptSecret.mockReturnValueOnce("access").mockReturnValueOnce("refresh");
    await expect(consumeJiraSiteSelection("continuation", "browser-secret", "cloud-a")).resolves.toMatchObject({
      resource: { id: "cloud-a" }, accessToken: "access", refreshToken: "refresh", returnTo: "/settings",
    });
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("DELETE FROM jira_oauth_selections");
    await expect(consumeJiraSiteSelection("continuation", "browser-secret", "cloud-c")).rejects.toThrow("selected site");
  });

  it("reads only safe site metadata for the bound browser without consuming tokens", async () => {
    mocks.sqlGet.mockResolvedValue({ resources_json: JSON.stringify([
      { id: "cloud-a", name: "A", url: "https://a.atlassian.net", scopes: ["read:jira-work"] },
      { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
    ]) });
    await expect(getJiraSiteSelectionOptions("continuation", "browser-secret")).resolves.toEqual([
      { id: "cloud-a", name: "A", url: "https://a.atlassian.net" },
      { id: "cloud-b", name: "B", url: "https://b.atlassian.net" },
    ]);
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("SELECT resources_json");
    expect(mocks.sqlGet.mock.calls[0][0]).not.toContain("encrypted_access_token");
  });

  it("rejects invalid creation inputs and encryption key mismatches before persistence", async () => {
    await expect(createJiraSiteSelection({
      browserBinding: " ", returnTo: "/", accessToken: "access", refreshToken: "refresh", expiresInSeconds: 60,
      scopes: "", resources: [],
    })).rejects.toThrow("required");
    mocks.encryptSecret.mockReset()
      .mockReturnValueOnce({ ciphertext: "a", iv: "a", tag: "a", keyVersion: 1 })
      .mockReturnValueOnce({ ciphertext: "r", iv: "r", tag: "r", keyVersion: 2 });
    await expect(createJiraSiteSelection({
      browserBinding: "browser", returnTo: "/", accessToken: "access", refreshToken: "refresh", expiresInSeconds: 60,
      scopes: "", resources: [
        { id: "cloud-a", name: "A", url: "https://a.atlassian.net", scopes: [] },
        { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
      ],
    })).rejects.toThrow("key versions");
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("rejects missing, expired, and wrong-browser continuations", async () => {
    await expect(getJiraSiteSelectionOptions(" ", "browser")).rejects.toThrow("invalid");
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(getJiraSiteSelectionOptions("continuation", "browser")).rejects.toThrow("expired");
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(consumeJiraSiteSelection("continuation", "browser", "cloud-a")).rejects.toThrow("already used");
  });

  it("rejects a consumed selection whose access token expired while choosing", async () => {
    mocks.sqlGet.mockResolvedValue({
      encrypted_access_token: "enc-a", access_token_iv: "iv-a", access_token_tag: "tag-a",
      encrypted_refresh_token: "enc-r", refresh_token_iv: "iv-r", refresh_token_tag: "tag-r", key_version: 1,
      access_expires_at: "2026-08-13T09:59:59.000Z", scopes: "", return_to: "/",
      resources_json: JSON.stringify([
        { id: "cloud-a", name: "A", url: "https://a.atlassian.net", scopes: [] },
        { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
      ]),
    });
    await expect(consumeJiraSiteSelection("continuation", "browser", "cloud-a")).rejects.toThrow("expired");
  });
});
