import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ createId: () => "config-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet }));
vi.mock("@/modules/security/encryption.service", () => ({ encryptSecret: mocks.encryptSecret, decryptSecret: mocks.decryptSecret }));
import { resolveZephyrScaleConfig, storeZephyrScaleConfig } from "./zephyr-scale-config.service";

describe("Zephyr Scale configuration", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.encryptSecret.mockReturnValue({ ciphertext: "encrypted", iv: "iv", tag: "tag", keyVersion: 1 }); });
  it("stores the token encrypted for an owner/admin Jira project", async () => {
    mocks.sqlGet.mockResolvedValue({ id: "config-1" });
    await storeZephyrScaleConfig({ workspaceId: "ws-1", projectId: "project-1", actorUserId: "owner-1", apiToken: " opaque-token ", region: "eu", localIdFieldName: "iTestFlow ID" });
    expect(mocks.encryptSecret).toHaveBeenCalledWith(" opaque-token ");
    const [sql, params] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("wm.role IN ('owner', 'admin')");
    expect(sql).toContain("backend_type = 'zephyr_scale'");
    expect(JSON.stringify(params)).not.toContain("opaque-token");
    expect(params).toMatchObject({ encryptedSecret: "encrypted", region: "eu" });
  });
  it("rejects arbitrary regions and unauthorized writes before persistence", async () => {
    await expect(storeZephyrScaleConfig({ workspaceId: "ws", projectId: "p", actorUserId: "u", apiToken: "token", region: "https://evil.example", localIdFieldName: "ID" })).rejects.toThrow("invalid");
    expect(mocks.encryptSecret).not.toHaveBeenCalled();
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(storeZephyrScaleConfig({ workspaceId: "ws", projectId: "p", actorUserId: "u", apiToken: "token", region: "us", localIdFieldName: "ID" })).rejects.toThrow("not authorized");
  });
  it("resolves the decrypted token only for an active project member", async () => {
    mocks.sqlGet.mockResolvedValue({ config_json: '{"localIdFieldName":"iTestFlow ID"}', encrypted_secret: "encrypted", secret_iv: "iv", secret_tag: "tag", key_version: 1, region: "au", provider_project_key: "QA" });
    mocks.decryptSecret.mockReturnValue("token");
    await expect(resolveZephyrScaleConfig({ workspaceId: "ws", projectId: "p", actorUserId: "member" })).resolves.toEqual({ apiToken: "token", region: "au", jiraProjectKey: "QA", localIdFieldName: "iTestFlow ID" });
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("wm.status = 'active'");
  });
});
