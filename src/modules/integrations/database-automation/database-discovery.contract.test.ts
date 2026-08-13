import { beforeEach, describe, expect, it, vi } from "vitest";

const egress = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
}));

vi.mock("@/modules/test-execution/egress-policy.service", async (importOriginal) => ({
  // Keep the real pure hostname normalization; only the policy check is mocked.
  ...(await importOriginal<typeof import("@/modules/test-execution/egress-policy.service")>()),
  assertBoundaryEgressAllowed: egress.assertAllowed,
}));

import type { ExecutionBoundary } from "@/modules/test-execution/execution-boundary";

import { MysqlDatabaseExecutor } from "./mysql-database-executor";
import { PostgresDatabaseExecutor } from "./postgres-database-executor";
import { SqlServerDatabaseExecutor } from "./sqlserver-database-executor";
import { databaseObjectKey } from "./database-executor.shared";
import type {
  DatabaseAccess,
  DatabaseExecutor,
  DatabaseExecutorConfig,
  DiscoveredDatabaseObjects,
} from "./database-executor.port";

/* ------------------------------------------------------------------------ *
 * Driver matrix
 * ------------------------------------------------------------------------ */

type DriverName = DatabaseExecutorConfig["driver"];
type DiscoveryRow = Record<string, unknown>;

type DriverSpec = {
  driver: DriverName;
  schema: string;
  /** Fragments the discovery statement must carry for this driver. */
  discoveryFragments: string[];
  row(schema: string, table: string, column: string, dataType: string): DiscoveryRow;
};

function lowerCaseRow(schema: string, table: string, column: string, dataType: string): DiscoveryRow {
  return { table_schema: schema, table_name: table, column_name: column, data_type: dataType };
}

function upperCaseRow(schema: string, table: string, column: string, dataType: string): DiscoveryRow {
  return { TABLE_SCHEMA: schema, TABLE_NAME: table, COLUMN_NAME: column, DATA_TYPE: dataType };
}

const DRIVERS: DriverSpec[] = [
  {
    driver: "postgres",
    schema: "public",
    discoveryFragments: ["information_schema.columns", "pg_catalog", "pg\\_toast%", "LIMIT $1"],
    row: lowerCaseRow,
  },
  {
    driver: "mysql",
    schema: "qa",
    discoveryFragments: ["information_schema.columns", "'mysql'", "'performance_schema'", "'sys'", "LIMIT ?"],
    row: lowerCaseRow,
  },
  {
    driver: "sqlserver",
    schema: "dbo",
    discoveryFragments: [
      "INFORMATION_SCHEMA.COLUMNS",
      "'sys'",
      "'INFORMATION_SCHEMA'",
      "db[_]%",
      "HAS_PERMS_BY_NAME",
      "@maxColumns",
    ],
    row: upperCaseRow,
  },
];

const PORTS: Record<DriverName, number> = { postgres: 5432, sqlserver: 1433, mysql: 3306 };

function boundaryFor(port: number): ExecutionBoundary {
  return {
    version: "itestflow.boundary.v1",
    targets: [{ kind: "database", protocol: "tcp", host: "db.example.test", port }],
  };
}

function config(driver: DriverName): DatabaseExecutorConfig {
  const port = PORTS[driver];
  return {
    boundary: boundaryFor(port),
    driver,
    host: "db.example.test",
    port,
    databaseName: "qa",
    username: "tester",
    password: "secret",
    tlsMode: "require",
    // Still on the config type, but no longer read by the executors: the
    // discovered objects are the only bound.
    schemas: [],
    connectTimeoutMs: 1_000,
    statementTimeoutMs: 1_000,
    signal: new AbortController().signal,
  };
}

/* ------------------------------------------------------------------------ *
 * Driver client doubles
 * ------------------------------------------------------------------------ */

type Harness = {
  executor: DatabaseExecutor;
  /** Every SQL string handed to the driver client, in dispatch order. */
  statements: string[];
};

function harnessFor(
  spec: DriverSpec,
  options: { rows?: DiscoveryRow[]; connectError?: unknown } = {},
): Harness {
  const rows = options.rows ?? [];
  const statements: string[] = [];
  const failConnect = () => {
    if (options.connectError) throw options.connectError;
  };

  if (spec.driver === "postgres") {
    const client = {
      connect: vi.fn(async () => { failConnect(); }),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (query: string | { text: string }) => {
        statements.push(typeof query === "string" ? query : query.text);
        return { command: "SELECT", rowCount: rows.length, rows, fields: [] };
      }),
    };
    return {
      executor: new PostgresDatabaseExecutor(config(spec.driver), (() => client) as never),
      statements,
    };
  }

  if (spec.driver === "mysql") {
    const connection = {
      query: vi.fn(async (query: string | { sql: string }) => {
        statements.push(typeof query === "string" ? query : query.sql);
        return [rows, []];
      }),
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      destroy: vi.fn(),
    };
    const createConnection = vi.fn(async () => {
      failConnect();
      return connection;
    });
    return {
      executor: new MysqlDatabaseExecutor(config(spec.driver), createConnection as never),
      statements,
    };
  }

  const request = {
    input: vi.fn(),
    query: vi.fn(async (command: string) => {
      statements.push(command);
      return { recordset: rows, rowsAffected: [] };
    }),
    cancel: vi.fn(),
  };
  request.input.mockReturnValue(request);
  const transaction = {
    begin: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    request: vi.fn(() => request),
  };
  const pool = {
    connect: vi.fn(async () => { failConnect(); }),
    close: vi.fn(async () => undefined),
    request: vi.fn(() => request),
    transaction: vi.fn(() => transaction),
  };
  return {
    executor: new SqlServerDatabaseExecutor(config(spec.driver), (() => pool) as never),
    statements,
  };
}

/** Derive the run's bound access set from what discovery reported. */
function accessFrom(discovered: DiscoveredDatabaseObjects): DatabaseAccess {
  return {
    schemas: [...new Set(discovered.objects.map((object) => object.schema))],
    tables: new Set(discovered.objects.map((object) => databaseObjectKey(object.schema, object.table))),
  };
}

function sampleRows(spec: DriverSpec, schema = spec.schema, table = "orders"): DiscoveryRow[] {
  return [
    spec.row(schema, table, "id", "integer"),
    spec.row(schema, table, "status", "text"),
    spec.row(schema, "customers", "email", "text"),
  ];
}

describe("database object discovery contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    egress.assertAllowed.mockResolvedValue({ resolvedAddresses: ["203.0.113.10"] });
  });

  it.each(DRIVERS)("excludes $driver system schemas from the discovery sweep", async (spec) => {
    const harness = harnessFor(spec, { rows: [] });

    await harness.executor.discoverObjects();

    expect(harness.statements).toHaveLength(1);
    const [statement] = harness.statements;
    for (const fragment of spec.discoveryFragments) expect(statement).toContain(fragment);
  });

  it.each(DRIVERS)("folds $driver column rows into objects grouped by table", async (spec) => {
    const harness = harnessFor(spec, { rows: sampleRows(spec) });

    await expect(harness.executor.discoverObjects()).resolves.toEqual({
      truncated: false,
      objects: [
        {
          schema: spec.schema,
          table: "orders",
          columns: [
            { name: "id", dataType: "integer" },
            { name: "status", dataType: "text" },
          ],
        },
        {
          schema: spec.schema,
          table: "customers",
          columns: [{ name: "email", dataType: "text" }],
        },
      ],
    });
  });

  it.each(DRIVERS)("runs a $driver SELECT against a discovered table", async (spec) => {
    const harness = harnessFor(spec, { rows: sampleRows(spec) });
    harness.executor.setDatabaseAccess(accessFrom(await harness.executor.discoverObjects()));

    await expect(harness.executor.execute({
      kind: "select",
      sql: `SELECT id FROM ${spec.schema}.orders WHERE id = :id`,
      parameters: { id: 42 },
    })).resolves.toMatchObject({ status: "ok" });

    expect(harness.statements.some((statement) => /FROM\s+\S*orders/i.test(statement))).toBe(true);
  });

  it.each(DRIVERS)("rejects a $driver SELECT against an undiscovered table", async (spec) => {
    const harness = harnessFor(spec, { rows: sampleRows(spec) });
    harness.executor.setDatabaseAccess(accessFrom(await harness.executor.discoverObjects()));
    const dispatched = harness.statements.length;

    await expect(harness.executor.execute({
      kind: "select",
      sql: `SELECT id FROM ${spec.schema}.payments`,
      parameters: {},
    })).rejects.toMatchObject({
      name: "DatabaseExecutorError",
      category: "policy",
      message: expect.stringContaining("not among the discovered database objects"),
    });

    // The statement never reaches the server.
    expect(harness.statements).toHaveLength(dispatched);
  });

  it.each(DRIVERS)("authorizes $driver objects by canonical identifier, not by case", async (spec) => {
    const mixedSchema = `${spec.schema[0].toUpperCase()}${spec.schema.slice(1)}`;

    // Discovered in mixed case, queried in lower case.
    const discoveredMixed = harnessFor(spec, { rows: sampleRows(spec, mixedSchema, "Orders") });
    discoveredMixed.executor.setDatabaseAccess(accessFrom(await discoveredMixed.executor.discoverObjects()));
    await expect(discoveredMixed.executor.execute({
      kind: "select",
      sql: `SELECT id FROM ${spec.schema}.orders`,
      parameters: {},
    })).resolves.toMatchObject({ status: "ok" });

    // Discovered in lower case, queried in mixed case.
    const discoveredLower = harnessFor(spec, { rows: sampleRows(spec) });
    discoveredLower.executor.setDatabaseAccess(accessFrom(await discoveredLower.executor.discoverObjects()));
    await expect(discoveredLower.executor.execute({
      kind: "select",
      sql: `SELECT id FROM ${mixedSchema}.Orders`,
      parameters: {},
    })).resolves.toMatchObject({ status: "ok" });
  });

  it.each(DRIVERS)("surfaces the certificate remedy when $driver cannot verify the server", async (spec) => {
    const connectError = Object.assign(new Error("connect failed"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    const harness = harnessFor(spec, { connectError });

    await expect(harness.executor.discoverObjects()).rejects.toMatchObject({
      name: "DatabaseExecutorError",
      category: "transport",
      uncertainSideEffect: false,
      message: expect.stringContaining("Allow encrypted connection without certificate verification"),
    });
  });
});
