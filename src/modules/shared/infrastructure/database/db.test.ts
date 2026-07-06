import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    on: vi.fn(),
    query: vi.fn(),
    connect: vi.fn(async () => client),
    end: vi.fn(),
  };
  return {
    client,
    pool,
    Pool: vi.fn(function MockPool() {
      return pool;
    }),
  };
});

vi.mock("pg", () => ({ Pool: mocks.Pool }));

import {
  enqueueBackgroundWrite,
  flushBackgroundWrites,
  getPool,
  resetDatabaseForTests,
  sqlAll,
  sqlGet,
  sqlRun,
  translateNamedParameters,
  withTransaction,
} from "./db";

describe("PostgreSQL infrastructure", () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgresql://unit.test/db");
    mocks.pool.connect.mockResolvedValue(mocks.client);
  });

  it("strictly translates named parameters and reuses repeated placeholders", () => {
    expect(translateNamedParameters(
      "SELECT * FROM rows WHERE workspace_id = @workspaceId OR owner_id = @userId OR updated_by = @userId",
      { workspaceId: "ws-1", userId: "user-1" },
    )).toEqual({
      text: "SELECT * FROM rows WHERE workspace_id = $1 OR owner_id = $2 OR updated_by = $2",
      values: ["ws-1", "user-1"],
    });
    expect(() => translateNamedParameters("SELECT @missing")).toThrow(
      "SQL references @missing but no value was provided.",
    );
  });

  it("creates and memoizes a bounded pool with an idle-error handler", async () => {
    vi.stubEnv("DATABASE_POOL_MAX", "7");
    expect(getPool()).toBe(mocks.pool);
    expect(getPool()).toBe(mocks.pool);
    expect(mocks.Pool).toHaveBeenCalledOnce();
    expect(mocks.Pool).toHaveBeenCalledWith({
      connectionString: "postgresql://unit.test/db",
      max: 7,
    });
    expect(mocks.pool.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("fails clearly when no connection string is configured", async () => {
    await resetDatabaseForTests();
    vi.stubEnv("DATABASE_URL", "");
    expect(() => getPool()).toThrow("DATABASE_URL is not set");
  });

  it("executes all/get/run queries with positional values and optional clients", async () => {
    mocks.pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }] })
      .mockResolvedValueOnce({ rowCount: 4 });

    await expect(sqlAll<{ id: number }>("SELECT @id", { id: 1 })).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    await expect(sqlGet<{ id: number }>("SELECT @id", { id: 3 })).resolves.toEqual({ id: 3 });
    await expect(sqlRun("DELETE FROM rows WHERE id = @id", { id: 4 })).resolves.toBe(4);
    expect(mocks.pool.query).toHaveBeenNthCalledWith(1, "SELECT $1", [1]);
  });

  it("commits successful work and always releases the dedicated client", async () => {
    mocks.client.query.mockResolvedValue({});
    await expect(withTransaction(async (client) => {
      expect(client).toBe(mocks.client);
      await client.query("SELECT 1");
      return "done";
    })).resolves.toBe("done");

    expect(mocks.client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a failed callback and preserves the original error", async () => {
    mocks.client.query.mockResolvedValue({});
    const failure = new Error("write failed");
    await expect(withTransaction(async () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(mocks.client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });

  it("still releases and rethrows the callback error when rollback itself fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.client.query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("rollback failed"));
    const original = new Error("original failure");

    await expect(withTransaction(async () => {
      throw original;
    })).rejects.toBe(original);
    expect(log).toHaveBeenCalledWith("[db] ROLLBACK failed", expect.any(Error));
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });

  it("runs background writes in order, isolates failures, and flushes the tail", async () => {
    const events: string[] = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    enqueueBackgroundWrite("first", async () => {
      events.push("first");
      throw new Error("telemetry unavailable");
    });
    enqueueBackgroundWrite("second", async () => {
      events.push("second");
    });

    await flushBackgroundWrites();
    expect(events).toEqual(["first", "second"]);
    expect(log).toHaveBeenCalledWith(
      "[db] background write failed (first); skipping.",
      expect.any(Error),
    );
  });
});
