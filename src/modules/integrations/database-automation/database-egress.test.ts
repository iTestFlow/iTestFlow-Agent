import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";

const egress = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
}));

vi.mock("@/modules/test-execution/egress-policy.service", async (importOriginal) => ({
  // Keep the real pure hostname normalization; only the policy check is mocked.
  ...(await importOriginal<typeof import("@/modules/test-execution/egress-policy.service")>()),
  assertTestExecutionEgressAllowed: egress.assertAllowed,
}));

import { MysqlDatabaseExecutor } from "./mysql-database-executor";
import { PostgresDatabaseExecutor } from "./postgres-database-executor";
import { SqlServerDatabaseExecutor } from "./sqlserver-database-executor";
import type { DatabaseExecutorConfig } from "./database-executor.port";
import {
  assertDatabaseEgressAllowed,
  connectPinnedDatabaseSocket,
  createPinnedDatabaseSocket,
} from "./database-egress";

function config(driver: DatabaseExecutorConfig["driver"]): DatabaseExecutorConfig {
  return {
    workspaceId: "workspace-1",
    driver,
    host: "db.example.test",
    port: driver === "postgres" ? 5432 : driver === "sqlserver" ? 1433 : 3306,
    databaseName: "qa",
    username: "tester",
    password: "secret",
    tlsMode: "require",
    schemas: [driver === "sqlserver" ? "dbo" : driver === "mysql" ? "qa" : "public"],
    accessMode: "read_only",
    connectTimeoutMs: 1_000,
    statementTimeoutMs: 1_000,
    signal: new AbortController().signal,
  };
}

describe("database executor egress enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    egress.assertAllowed.mockResolvedValue({ ruleId: "rule-1", resolvedAddresses: ["203.0.113.10"] });
  });

  it("passes the workspace and environment-derived endpoint before opening PostgreSQL", async () => {
    const events: string[] = [];
    egress.assertAllowed.mockImplementation(async () => {
      events.push("guard");
      return { ruleId: "rule-1", resolvedAddresses: ["203.0.113.10"] };
    });
    const client = {
      connect: vi.fn(async () => { events.push("connect"); }),
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ command: "SELECT", rowCount: 0, rows: [], fields: [] })),
    };
    const createClient = vi.fn(() => {
      events.push("create");
      return client;
    });
    const executor = new PostgresDatabaseExecutor(config("postgres"), createClient as never);

    await executor.execute({ kind: "schema" });
    await executor.execute({ kind: "schema" });

    expect(egress.assertAllowed).toHaveBeenCalledOnce();
    expect(egress.assertAllowed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetKind: "database",
      protocol: "tcp",
      host: "db.example.test",
      port: 5432,
    });
    expect(events.slice(0, 3)).toEqual(["guard", "create", "connect"]);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      host: "203.0.113.10",
      ssl: expect.objectContaining({ servername: "db.example.test" }),
    }));
  });

  it("pins MySQL's socket while retaining the DNS name for TLS identity", async () => {
    const connection = {
      query: vi.fn(async () => [[], []]),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      end: vi.fn(async () => undefined),
      destroy: vi.fn(),
    };
    const createConnection = vi.fn(async () => connection);
    const executor = new MysqlDatabaseExecutor(config("mysql"), createConnection as never);

    await executor.execute({ kind: "schema" });

    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: "db.example.test",
      stream: expect.any(Function),
      ssl: expect.objectContaining({
        rejectUnauthorized: false,
        verifyIdentity: false,
      }),
    }));
  });

  it("pins every SQL Server pool socket and preserves the TLS server name", async () => {
    const request = {
      input: vi.fn(),
      query: vi.fn(async () => ({ recordset: [], rowsAffected: [] })),
      cancel: vi.fn(),
    };
    request.input.mockReturnValue(request);
    const pool = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      request: vi.fn(() => request),
      transaction: vi.fn(),
    };
    const createPool = vi.fn(() => pool);
    const executor = new SqlServerDatabaseExecutor(config("sqlserver"), createPool as never);

    await executor.execute({ kind: "schema" });

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      server: "db.example.test",
      options: expect.objectContaining({
        connector: expect.any(Function),
        serverName: "db.example.test",
      }),
    }));
  });

  it("re-authorizes a recreated SQL Server pool socket before pinning it", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sockets: Socket[] = [];
    try {
      const port = (server.address() as AddressInfo).port;
      egress.assertAllowed.mockResolvedValue({
        ruleId: "rule-1",
        resolvedAddresses: ["127.0.0.1"],
      });
      const request = {
        input: vi.fn(),
        query: vi.fn(async () => ({ recordset: [], rowsAffected: [] })),
        cancel: vi.fn(),
      };
      request.input.mockReturnValue(request);
      const pool = {
        connect: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        request: vi.fn(() => request),
        transaction: vi.fn(),
      };
      const createPool = vi.fn((poolConfig: unknown) => {
        void poolConfig;
        return pool;
      });
      const executor = new SqlServerDatabaseExecutor(
        { ...config("sqlserver"), port },
        createPool as never,
      );
      await executor.execute({ kind: "schema" });
      const poolConfig = createPool.mock.calls[0]?.[0] as {
        options?: { connector?: () => Promise<Socket> };
      };
      const connector = poolConfig.options?.connector;
      expect(connector).toBeTypeOf("function");

      sockets.push(await connector!());
      sockets.push(await connector!());

      // Initial authorization is consumed by the first physical socket. A
      // replacement socket obtains a new authorization/address.
      expect(egress.assertAllowed).toHaveBeenCalledTimes(2);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(["postgres", "sqlserver", "mysql"] as const)(
    "denies %s before constructing a driver client",
    async (driver) => {
      const denied = vi.fn(async () => { throw new Error("denied"); });
      const createClient = vi.fn();
      const guardedConfig = { ...config(driver), workspaceId: undefined, assertTarget: denied };
      const executor = driver === "postgres"
        ? new PostgresDatabaseExecutor(guardedConfig, createClient as never)
        : driver === "sqlserver"
          ? new SqlServerDatabaseExecutor(guardedConfig, createClient as never)
          : new MysqlDatabaseExecutor(guardedConfig, createClient as never);

      await expect(executor.execute({ kind: "schema" })).rejects.toMatchObject({
        category: "policy",
        uncertainSideEffect: false,
      });
      expect(denied).toHaveBeenCalledWith({
        host: "db.example.test",
        port: guardedConfig.port,
      });
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("fails closed when no workspace or injected authorization context is present", async () => {
    const createClient = vi.fn();
    const withoutContext = config("postgres");
    delete withoutContext.workspaceId;
    const executor = new PostgresDatabaseExecutor(withoutContext, createClient as never);

    await expect(executor.execute({ kind: "schema" })).rejects.toMatchObject({ category: "policy" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects missing concrete addresses and invalid or canceled socket bindings", async () => {
    const missingAddress = {
      ...config("postgres"),
      workspaceId: undefined,
      assertTarget: vi.fn(async () => ({
        ruleId: "rule-without-addresses",
        resolvedAddresses: [],
      })),
    };
    await expect(assertDatabaseEgressAllowed(missingAddress)).rejects.toMatchObject({ category: "policy" });

    expect(() => createPinnedDatabaseSocket(
      { hostname: "db.example.test", address: "not-an-ip", port: 5432 },
      new AbortController().signal,
    )).toThrow("not an IP address");

    const controller = new AbortController();
    controller.abort(new Error("canceled"));
    expect(() => createPinnedDatabaseSocket(
      { hostname: "db.example.test", address: "127.0.0.1", port: 5432 },
      controller.signal,
    )).toThrow();
    await expect(connectPinnedDatabaseSocket(
      { hostname: "db.example.test", address: "127.0.0.1", port: 5432 },
      controller.signal,
      50,
    )).rejects.toThrow("canceled");
  });

  it("rejects a pinned TCP connection error and clears its listeners", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    await expect(connectPinnedDatabaseSocket(
      { hostname: "db.example.test", address: "127.0.0.1", port },
      new AbortController().signal,
      1_000,
    )).rejects.toBeInstanceOf(Error);
  });

  it.each([
    { host: "[2001:db8::5]", address: "2001:db8::5", expected: "2001:db8::5" },
    { host: "TÄST.example.", address: "203.0.113.15", expected: "xn--tst-qla.example" },
  ])("normalizes the authorized hostname for TLS identity: $host", async ({ host, address, expected }) => {
    const configured = {
      ...config("postgres"),
      workspaceId: undefined,
      host,
      assertTarget: vi.fn(async () => ({ ruleId: "rule-1", resolvedAddresses: [address] })),
    };

    await expect(assertDatabaseEgressAllowed(configured)).resolves.toEqual({
      hostname: expected,
      port: 5432,
      address,
    });
  });

  it("closes a pinned socket when the run is canceled while connecting", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    const socket = createPinnedDatabaseSocket(
      { hostname: "db.example.test", address: "127.0.0.1", port },
      controller.signal,
    );
    try {
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.once("error", () => undefined);
      controller.abort("run canceled");
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails closed when the authorized TLS hostname cannot be normalized", async () => {
    const configured = {
      ...config("postgres"),
      workspaceId: undefined,
      host: "\uD800",
      assertTarget: vi.fn(async () => ({
        ruleId: "rule-1",
        resolvedAddresses: ["203.0.113.15"],
      })),
    };

    await expect(assertDatabaseEgressAllowed(configured)).rejects.toMatchObject({ category: "policy" });
  });
});
