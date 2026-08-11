import { describe, expect, it, vi } from "vitest";

import { MysqlDatabaseExecutor } from "./mysql-database-executor";
import { PostgresDatabaseExecutor } from "./postgres-database-executor";
import { SqlServerDatabaseExecutor } from "./sqlserver-database-executor";
import type { DatabaseExecutorConfig } from "./database-executor.port";

function config(
  driver: "postgres" | "mysql" | "sqlserver",
  signal: AbortSignal = new AbortController().signal,
): DatabaseExecutorConfig {
  return {
    driver,
    host: "db.example.test",
    port: driver === "postgres" ? 5432 : driver === "mysql" ? 3306 : 1433,
    databaseName: "qa",
    username: "tester",
    password: "secret",
    tlsMode: "require",
    schemas: [driver === "postgres" ? "public" : driver === "mysql" ? "qa" : "dbo"],
    accessMode: "cataloged_dml",
    connectTimeoutMs: 1_000,
    statementTimeoutMs: 1_000,
    signal,
    assertTarget: vi.fn(async () => ({
      ruleId: "test-rule",
      resolvedAddresses: ["203.0.113.10"],
    })),
  };
}

function pgResult(command = "UPDATE") {
  return { command, rowCount: 1, rows: [], fields: [] };
}

function pgNetworkError(code = "ECONNRESET") {
  return Object.assign(new Error("socket closed"), { code });
}

function pgServerError() {
  return Object.assign(new Error("syntax error"), { code: "42601", severity: "ERROR" });
}

function mysqlNetworkError(code = "PROTOCOL_CONNECTION_LOST") {
  return Object.assign(new Error("connection lost"), { code });
}

function mysqlServerError() {
  return Object.assign(new Error("syntax error"), {
    code: "ER_PARSE_ERROR",
    errno: 1064,
    sqlState: "42000",
  });
}

describe("database mutation error classification", () => {
  it("marks a PostgreSQL network failure after dispatch as uncertain", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn()
        .mockResolvedValueOnce(pgResult("BEGIN"))
        .mockRejectedValueOnce(pgNetworkError())
        .mockResolvedValueOnce(pgResult("ROLLBACK")),
    };
    const executor = new PostgresDatabaseExecutor(config("postgres"), (() => client) as never);

    await expect(executor.execute({
      kind: "mutation",
      sql: "UPDATE public.orders SET status=:status WHERE id=:id",
      parameters: { status: "ready", id: 1 },
    })).rejects.toMatchObject({ category: "transport", uncertainSideEffect: true });
  });

  it("marks any PostgreSQL COMMIT ambiguity as uncertain, including a server SQLSTATE", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn()
        .mockResolvedValueOnce(pgResult("BEGIN"))
        .mockResolvedValueOnce(pgResult())
        .mockRejectedValueOnce(Object.assign(new Error("serialization failure at commit"), {
          code: "40001",
          severity: "ERROR",
        }))
        .mockResolvedValueOnce(pgResult("ROLLBACK")),
    };
    const executor = new PostgresDatabaseExecutor(config("postgres"), (() => client) as never);

    await expect(executor.execute({
      kind: "mutation",
      sql: "UPDATE public.orders SET status=:status WHERE id=:id",
      parameters: { status: "ready", id: 1 },
    })).rejects.toMatchObject({ category: "transport", uncertainSideEffect: true });
  });

  it("keeps a PostgreSQL server SQLSTATE as an inspectable query error", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn()
        .mockResolvedValueOnce(pgResult("BEGIN"))
        .mockRejectedValueOnce(pgServerError())
        .mockResolvedValueOnce(pgResult("ROLLBACK")),
    };
    const executor = new PostgresDatabaseExecutor(config("postgres"), (() => client) as never);

    await expect(executor.execute({
      kind: "mutation",
      sql: "UPDATE public.orders SET status=:status WHERE id=:id",
      parameters: { status: "ready", id: 1 },
    })).resolves.toMatchObject({ status: "query_error", sqlState: "42601" });
  });

  it("marks a MySQL network failure after dispatch as uncertain", async () => {
    const connection = mysqlConnection({
      query: vi.fn().mockRejectedValueOnce(mysqlNetworkError()),
    });
    const executor = new MysqlDatabaseExecutor(config("mysql"), (async () => connection) as never);

    await expect(executor.execute({
      kind: "mutation",
      sql: "UPDATE qa.orders SET status=:status WHERE id=:id",
      parameters: { status: "ready", id: 1 },
    })).rejects.toMatchObject({ category: "transport", uncertainSideEffect: true });
  });

  it("marks any MySQL COMMIT ambiguity as uncertain, including a server SQLSTATE", async () => {
    const connection = mysqlConnection({
      query: vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, undefined]),
      commit: vi.fn().mockRejectedValueOnce(mysqlServerError()),
    });
    const executor = new MysqlDatabaseExecutor(config("mysql"), (async () => connection) as never);

    await expect(executor.execute({
      kind: "mutation",
      sql: "UPDATE qa.orders SET status=:status WHERE id=:id",
      parameters: { status: "ready", id: 1 },
    })).rejects.toMatchObject({ category: "transport", uncertainSideEffect: true });
  });

  it("keeps a MySQL server SQLSTATE as an inspectable query error", async () => {
    const connection = mysqlConnection({
      query: vi.fn().mockRejectedValueOnce(mysqlServerError()),
    });
    const executor = new MysqlDatabaseExecutor(config("mysql"), (async () => connection) as never);

    await expect(executor.execute({
      kind: "mutation",
      sql: "UPDATE qa.orders SET status=:status WHERE id=:id",
      parameters: { status: "ready", id: 1 },
    })).resolves.toMatchObject({ status: "query_error", sqlState: "42000" });
  });
});

describe("database cancellation transaction boundary", () => {
  it.each(["postgres", "mysql", "sqlserver"] as const)(
    "rejects an already-aborted %s execution before creating a connection",
    async (driver) => {
      const controller = new AbortController();
      controller.abort();
      const factory = vi.fn();
      const executor = driver === "postgres"
        ? new PostgresDatabaseExecutor(config(driver, controller.signal), factory as never)
        : driver === "mysql"
          ? new MysqlDatabaseExecutor(config(driver, controller.signal), factory as never)
          : new SqlServerDatabaseExecutor(config(driver, controller.signal), factory as never);

      await expect(executor.execute({
        kind: "mutation",
        sql: "UPDATE public.orders SET status=:status WHERE id=:id",
        parameters: { status: "ready", id: 1 },
      })).rejects.toMatchObject({ category: "transport", uncertainSideEffect: false });
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["confirmed rollback", false],
    ["failed rollback", true],
  ] as const)(
    "rolls PostgreSQL back instead of committing after cancellation with %s",
    async (_description, rollbackFails) => {
      const controller = new AbortController();
      const query = vi.fn(async (statement: unknown) => {
        if (typeof statement === "string" && statement.startsWith("BEGIN")) return pgResult("BEGIN");
        if (statement === "ROLLBACK") {
          if (rollbackFails) throw new Error("rollback connection lost");
          return pgResult("ROLLBACK");
        }
        if (statement === "COMMIT") return pgResult("COMMIT");
        controller.abort();
        return pgResult();
      });
      const client = {
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query,
      };
      const executor = new PostgresDatabaseExecutor(
        config("postgres", controller.signal),
        (() => client) as never,
      );

      await expect(executor.execute({
        kind: "mutation",
        sql: "UPDATE public.orders SET status=:status WHERE id=:id",
        parameters: { status: "ready", id: 1 },
      })).rejects.toMatchObject({
        category: "transport",
        uncertainSideEffect: rollbackFails,
      });
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(query).not.toHaveBeenCalledWith("COMMIT");
    },
  );

  it.each([
    ["confirmed rollback", false],
    ["failed rollback", true],
  ] as const)(
    "rolls MySQL back instead of committing after cancellation with %s",
    async (_description, rollbackFails) => {
      const controller = new AbortController();
      const commit = vi.fn(async () => undefined);
      const rollback = rollbackFails
        ? vi.fn(async () => { throw new Error("rollback connection lost"); })
        : vi.fn(async () => undefined);
      const connection = mysqlConnection({
        query: vi.fn(async () => {
          controller.abort();
          return [{ affectedRows: 1 }, undefined];
        }),
        commit,
        rollback,
      });
      const executor = new MysqlDatabaseExecutor(
        config("mysql", controller.signal),
        (async () => connection) as never,
      );

      await expect(executor.execute({
        kind: "mutation",
        sql: "UPDATE qa.orders SET status=:status WHERE id=:id",
        parameters: { status: "ready", id: 1 },
      })).rejects.toMatchObject({
        category: "transport",
        uncertainSideEffect: rollbackFails,
      });
      expect(rollback).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["confirmed rollback", false],
    ["failed rollback", true],
  ] as const)(
    "rolls SQL Server back instead of committing after cancellation with %s",
    async (_description, rollbackFails) => {
      const controller = new AbortController();
      const commit = vi.fn(async () => undefined);
      const rollback = rollbackFails
        ? vi.fn(async () => { throw new Error("rollback connection lost"); })
        : vi.fn(async () => undefined);
      const activeRequest = {
        input: vi.fn(),
        query: vi.fn(async () => {
          controller.abort();
          return { recordset: [], rowsAffected: [1] };
        }),
        cancel: vi.fn(),
      };
      activeRequest.input.mockReturnValue(activeRequest);
      const transaction = {
        begin: vi.fn(async () => undefined),
        commit,
        rollback,
        request: vi.fn(() => activeRequest),
      };
      const pool = {
        connect: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        request: vi.fn(() => activeRequest),
        transaction: vi.fn(() => transaction),
      };
      const executor = new SqlServerDatabaseExecutor(
        config("sqlserver", controller.signal),
        (() => pool) as never,
      );

      await expect(executor.execute({
        kind: "mutation",
        sql: "UPDATE dbo.orders SET status=:status WHERE id=:id",
        parameters: { status: "ready", id: 1 },
      })).rejects.toMatchObject({
        category: "transport",
        uncertainSideEffect: rollbackFails,
      });
      expect(activeRequest.cancel).toHaveBeenCalledOnce();
      expect(rollback).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
    },
  );
});

function mysqlConnection(overrides: Record<string, unknown>) {
  return {
    query: vi.fn(),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    destroy: vi.fn(),
    ...overrides,
  };
}
