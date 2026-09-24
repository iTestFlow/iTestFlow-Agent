import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlGet = vi.fn();
vi.mock("@/modules/shared/infrastructure/database/db", () => ({ sqlGet: (...args: unknown[]) => sqlGet(...args), sqlAll: vi.fn() }));
vi.mock("@/modules/security/encryption.service", () => ({
  encryptSecret: (value: string) => ({ ciphertext: Buffer.from(value).toString("base64"), iv: "iv", tag: "tag", keyVersion: 1 }),
  decryptSecret: (value: { ciphertext: string }) => Buffer.from(value.ciphertext, "base64").toString(),
}));

import { ConnectionResolutionError, prepareConnections } from "./execution-connections.service";

const api = (alias: string) => ({ kind: "api" as const, alias, baseUrl: "https://api.example.test",
  auth: { type: "bearer" as const }, allowWrites: false });

describe("execution connection preparation", () => {
  beforeEach(() => sqlGet.mockReset());

  it("separates credentials from public settings and rejects duplicate aliases", async () => {
    const [prepared] = await prepareConnections({ workspaceId: "w", projectId: "p", connections: [
      { ...api("orders-api"), credentials: { bearerToken: { value: "private-token" } } },
    ] });
    expect(JSON.stringify(prepared.settings)).not.toContain("private-token");
    expect(prepared.credentialFields).toEqual(["bearerToken"]);
    expect(prepared.encryptedCredentials?.ciphertext).toBe(Buffer.from('{"bearerToken":"private-token"}').toString("base64"));
    await expect(prepareConnections({ workspaceId: "w", projectId: "p", connections: [
      { ...api("orders-api"), credentials: { bearerToken: { value: "one" } } },
      { ...api("orders-api"), credentials: { bearerToken: { value: "two" } } },
    ] })).rejects.toThrow(/used more than once/);
  });

  it("does not resolve a saved secret when scoped source lookup misses", async () => {
    sqlGet.mockResolvedValue(null);
    await expect(prepareConnections({ workspaceId: "w", projectId: "other-project", connections: [
      { ...api("orders-api"), credentials: { bearerToken: { fromProfileId: "profile-in-p" } } },
    ] })).rejects.toThrow(/Enter the bearerToken credential/);
    expect(sqlGet).toHaveBeenCalledWith(expect.stringContaining("p.project_id = @projectId"),
      expect.objectContaining({ workspaceId: "w", projectId: "other-project", sourceId: "profile-in-p" }));
  });

  it("binds saved API secrets to their original endpoint and auth settings", async () => {
    sqlGet.mockResolvedValue({ settings_json: api("orders-api"), encrypted_credentials: Buffer.from('{"bearerToken":"saved-token"}').toString("base64"),
      credentials_iv: "iv", credentials_tag: "tag", credentials_key_version: 1 });
    const reference = { bearerToken: { fromProfileId: "profile-in-p" } };
    await expect(prepareConnections({ workspaceId: "w", projectId: "p", connections: [
      { ...api("orders-api"), baseUrl: "https://attacker.example", credentials: reference },
    ] })).rejects.toThrow(/original connection destination/);
    await expect(prepareConnections({ workspaceId: "w", projectId: "p", connections: [
      { ...api("orders-api"), auth: { type: "basic", username: "qa" }, credentials: { basicPassword: { fromProfileId: "profile-in-p", sourceField: "bearerToken" } } },
    ] })).rejects.toThrow(/original connection destination/);
    const [sameTarget] = await prepareConnections({ workspaceId: "w", projectId: "p", connections: [
      { ...api("orders-api"), allowWrites: true, credentials: reference },
    ] });
    expect(sameTarget.credentialFields).toEqual(["bearerToken"]);
  });

  it("rejects saved database secrets when endpoint or TLS settings change", async () => {
    const original = { kind: "database" as const, alias: "orders-db", engine: "postgres" as const,
      host: "db.example.test", database: "orders", username: "qa", tlsMode: "verify-full" as const, allowWrites: false };
    sqlGet.mockResolvedValue({ settings_json: original, encrypted_credentials: Buffer.from('{"password":"saved-password"}').toString("base64"),
      credentials_iv: "iv", credentials_tag: "tag", credentials_key_version: 1 });
    for (const change of [{ host: "attacker.example" }, { tlsMode: "disable" as const }, { database: "other" }]) {
      await expect(prepareConnections({ workspaceId: "w", projectId: "p", connections: [
        { ...original, ...change, credentials: { password: { fromProfileId: "profile-in-p" } } },
      ] })).rejects.toThrow(/original connection destination/);
    }
  });

  it("rejects incomplete and irrelevant credentials before queueing a run", async () => {
    await expect(prepareConnections({ workspaceId: "w", projectId: "p", connections: [api("orders-api")] }))
      .rejects.toThrow(/Enter the bearerToken credential/);
    await expect(prepareConnections({ workspaceId: "w", projectId: "p", connections: [
      { kind: "api", alias: "public-api", baseUrl: "https://api.example.test", auth: { type: "none" }, allowWrites: false,
        credentials: { bearerToken: { value: "unneeded" } } },
    ] })).rejects.toThrow(/not used/);
    await expect(prepareConnections({ workspaceId: "w", projectId: "p", connections: [
      { kind: "database", alias: "orders-db", engine: "postgres", host: "db.example.test", database: "orders", username: "qa", allowWrites: false },
    ] })).rejects.toThrow(/complete database connection details/);
  });
});
