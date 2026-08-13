import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ createId: () => "config-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet }));
vi.mock("@/modules/security/encryption.service", () => ({ encryptSecret: mocks.encryptSecret, decryptSecret: mocks.decryptSecret }));
import { resolveXrayCloudConfig, storeXrayCloudConfig } from "./xray-cloud-config.service";

describe("Xray Cloud configuration", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.encryptSecret.mockReturnValue({ ciphertext: "encrypted", iv: "iv", tag: "tag", keyVersion: 1 }); });

  it("stores the client secret encrypted behind an owner/admin project authorization predicate", async () => {
    mocks.sqlGet.mockResolvedValue({ id: "config-1" });
    await storeXrayCloudConfig({ workspaceId: "ws-1", projectId: "project-1", actorUserId: "owner-1", clientId: "client-id", clientSecret: " opaque-secret ", localIdFieldId: "customfield_10100" });
    expect(mocks.encryptSecret).toHaveBeenCalledWith(" opaque-secret ");
    const [sql, params] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("wm.role IN ('owner', 'admin')");
    expect(sql).toContain("backend_type = 'xray_cloud'");
    expect(JSON.stringify(params)).not.toContain("opaque-secret");
    expect(params).toMatchObject({ encryptedSecret: "encrypted", secretIv: "iv", secretTag: "tag", keyVersion: 1 });
  });

  it("rejects unauthorized writes and invalid inputs without exposing or encrypting secrets", async () => {
    await expect(storeXrayCloudConfig({ workspaceId: "ws-1", projectId: "project-1", actorUserId: "user-1", clientId: "", clientSecret: "secret", localIdFieldId: "summary" })).rejects.toThrow("invalid");
    expect(mocks.encryptSecret).not.toHaveBeenCalled();
    expect(mocks.sqlGet).not.toHaveBeenCalled();

    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(storeXrayCloudConfig({ workspaceId: "ws-1", projectId: "project-1", actorUserId: "user-1", clientId: "client", clientSecret: "secret", localIdFieldId: "customfield_10100" })).rejects.toThrow("not authorized");
  });

  it("resolves a decrypted config only for an active member and Jira project", async () => {
    mocks.sqlGet.mockResolvedValue({
      config_json: JSON.stringify({ clientId: "client-id", localIdFieldId: "customfield_10100" }), encrypted_secret: "encrypted", secret_iv: "iv", secret_tag: "tag", key_version: 1,
      provider_project_id: "10000", provider_project_key: "QA",
    });
    mocks.decryptSecret.mockReturnValue("client-secret");
    await expect(resolveXrayCloudConfig({ workspaceId: "ws-1", projectId: "project-1", actorUserId: "member-1" })).resolves.toEqual({
      clientId: "client-id", clientSecret: "client-secret", localIdFieldId: "customfield_10100", jiraProjectId: "10000", jiraProjectKey: "QA",
    });
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("wm.status = 'active'");
    expect(mocks.decryptSecret).toHaveBeenCalledWith({ ciphertext: "encrypted", iv: "iv", tag: "tag", keyVersion: 1 });
  });
});
