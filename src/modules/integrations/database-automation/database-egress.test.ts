import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertDatabaseEgressAllowed, connectPinnedDatabaseSocket } from "./database-egress";
import { checkDatabaseConnection } from "./database-executor.factory";
import type { DatabaseExecutorConfig } from "./database-executor.port";
import { MysqlDatabaseExecutor } from "./mysql-database-executor";
import { PostgresDatabaseExecutor } from "./postgres-database-executor";
import { SqlServerDatabaseExecutor } from "./sqlserver-database-executor";

const executors: PostgresDatabaseExecutor[] = [];
afterEach(async () => { await Promise.all(executors.splice(0).map((executor) => executor.dispose())); });

function config(overrides: Partial<DatabaseExecutorConfig> = {}): DatabaseExecutorConfig {
  return {
    driver: "postgres", host: "DB.Example.Test.", port: 5432,
    databaseName: "qa", username: "tester", tlsMode: "verify-full",
    connectTimeoutMs: 1_000, statementTimeoutMs: 1_000, allowWrites: false,
    credentials: { password: "secret" }, signal: new AbortController().signal,
    authorizeTarget: vi.fn(async () => ({ resolvedAddresses: ["203.0.113.10"] })),
    ...overrides,
  };
}

describe("database egress and credentials", () => {
  it("authorizes normalized hostname and returns only approved IP", async () => {
    const authorizeTarget = vi.fn(async () => ({ resolvedAddresses: ["203.0.113.10"] }));
    const binding = await assertDatabaseEgressAllowed(config({ authorizeTarget }));
    expect(authorizeTarget).toHaveBeenCalledWith({ host: "db.example.test", port: 5432 });
    expect(binding).toEqual({ hostname: "db.example.test", port: 5432, address: "203.0.113.10" });
  });

  it("fails closed on missing authorization or non-IP result", async () => {
    await expect(assertDatabaseEgressAllowed(config({ authorizeTarget: undefined as never }))).rejects.toMatchObject({ category: "policy" });
    await expect(assertDatabaseEgressAllowed(config({ authorizeTarget: vi.fn(async () => ({ resolvedAddresses: ["evil.example"] })) }))).rejects.toMatchObject({ category: "policy" });
  });

  it("never opens driver connection after egress denial", async () => {
    const createClient = vi.fn();
    const executor = new PostgresDatabaseExecutor(config({ authorizeTarget: vi.fn(async () => { throw new Error("denied"); }) }), createClient as never);
    executors.push(executor);
    await expect(executor.discoverObjects()).rejects.toMatchObject({ category: "policy" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(["postgres", "mysql", "sqlserver"] as const)("blocks %s writes before connecting", async (driver) => {
    const createClient = vi.fn();
    const settings = config({ driver, allowWrites: false });
    const executor = driver === "postgres"
      ? new PostgresDatabaseExecutor(settings, createClient as never)
      : driver === "mysql"
        ? new MysqlDatabaseExecutor(settings, createClient as never)
        : new SqlServerDatabaseExecutor(settings, createClient as never);
    await expect(executor.execute({ kind: "mutation", sql: "DELETE FROM public.orders WHERE id=:id", parameters: { id: 1 } }))
      .rejects.toMatchObject({ category: "policy", code: "writes-disabled", uncertainSideEffect: false });
    expect(settings.authorizeTarget).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("pins socket to authorized address", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const socket = await connectPinnedDatabaseSocket({ hostname: "db.invalid", address: "127.0.0.1", port }, new AbortController().signal, 1_000);
      expect(socket.remoteAddress).toBe("127.0.0.1");
      socket.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps password out of display config and error serialization", async () => {
    const connection = config({ authorizeTarget: vi.fn(async () => { throw new Error("secret: denied"); }) });
    const result = await checkDatabaseConnection(connection);
    expect(result).toEqual({ connected: false, authenticated: false, message: "Database connection failed." });
    expect(JSON.stringify(result)).not.toContain("secret");
    try { await assertDatabaseEgressAllowed(connection); } catch (error) { expect(JSON.stringify(error)).not.toContain("secret"); }
  });
});
