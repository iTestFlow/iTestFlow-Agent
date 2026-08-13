import "server-only";

import { isIP } from "node:net";
import sql, { type config as SqlServerConfig, type IResult, type IRecordSet } from "mssql";

import { boundedDatabaseRows } from "./database-result";
import {
  assertDatabaseEgressAllowed,
  connectPinnedDatabaseSocket,
  type DatabaseEgressBinding,
} from "./database-egress";
import {
  assertNotCanceled,
  cancellationError,
  certificateFailureMessage,
  escapeLikePattern,
  foldDiscoveredColumns,
  MAX_DISCOVERED_COLUMNS,
  queryError,
  rollbackOutcome,
} from "./database-executor.shared";
import {
  DatabaseExecutorError,
  type DatabaseAccess,
  type DatabaseExecutionRequest,
  type DatabaseExecutionResult,
  type DatabaseExecutor,
  type DatabaseExecutorConfig,
  type DiscoveredDatabaseObjects,
} from "./database-executor.port";
import { compileNamedParameters, validateSql } from "./sql-policy";

/**
 * System schemas the discovery sweep never reports. Unlike PostgreSQL and
 * MySQL, SQL Server's INFORMATION_SCHEMA is not privilege-filtered — it lists
 * every object in the database — so visibility is established explicitly with
 * HAS_PERMS_BY_NAME at the call site.
 */
const SQLSERVER_SYSTEM_SCHEMA_FILTER = `TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
          AND TABLE_SCHEMA NOT LIKE 'db[_]%'`;

type SqlRequestLike = {
  input(name: string, value: unknown): SqlRequestLike;
  query<T extends Record<string, unknown> = Record<string, unknown>>(command: string): Promise<IResult<T>>;
  cancel(): void;
};
type SqlTransactionLike = {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  request(): SqlRequestLike;
};
type SqlPoolLike = {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  request(): SqlRequestLike;
  transaction(): SqlTransactionLike;
};

export class SqlServerDatabaseExecutor implements DatabaseExecutor {
  readonly driver = "sqlserver" as const;
  private pool: SqlPoolLike | null = null;
  /** Empty until discovery runs; every statement is bound to it. */
  private access: DatabaseAccess = { schemas: [], tables: new Set() };

  constructor(
    private readonly config: DatabaseExecutorConfig,
    private readonly createPool: (config: SqlServerConfig) => SqlPoolLike = (config) => new sql.ConnectionPool(config) as unknown as SqlPoolLike,
  ) {}

  setDatabaseAccess(access: DatabaseAccess): void {
    this.access = access;
  }

  async discoverObjects(): Promise<DiscoveredDatabaseObjects> {
    assertNotCanceled(this.config.signal, "SQL Server");
    const pool = await this.ensureConnected();
    try {
      const request = pool.request();
      request.input("maxColumns", MAX_DISCOVERED_COLUMNS + 1);
      const result = await request.query<Record<string, unknown>>(`
        SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE ${SQLSERVER_SYSTEM_SCHEMA_FILTER}
          AND HAS_PERMS_BY_NAME(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME), 'OBJECT', 'SELECT') = 1
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
        OFFSET 0 ROWS FETCH NEXT @maxColumns ROWS ONLY`);
      return foldDiscoveredColumns(Array.from(result.recordset ?? []).map((row) => ({
        schema: row.TABLE_SCHEMA,
        table: row.TABLE_NAME,
        column: row.COLUMN_NAME,
        dataType: row.DATA_TYPE,
      })));
    } catch (error) {
      if (error instanceof DatabaseExecutorError) throw error;
      this.resetConnection();
      throw new DatabaseExecutorError("SQL Server object discovery failed.", "transport", false, error);
    }
  }

  async execute(request: DatabaseExecutionRequest): Promise<DatabaseExecutionResult> {
    assertNotCanceled(this.config.signal, "SQL Server");
    const pool = await this.ensureConnected();
    assertNotCanceled(this.config.signal, "SQL Server");
    if (request.kind === "schema") return this.inspectSchema(pool, request.tablePattern);
    const parameters = request.parameters ?? {};
    const validated = validateSql({ sql: request.sql, intent: request.kind === "select" ? "select" : "mutation", driver: this.driver, allowedSchemas: this.access.schemas, allowedTables: this.access.tables, parameters });
    const compiled = compileNamedParameters(validated, parameters, this.driver);
    const transaction = pool.transaction();
    const started = Date.now();
    let transactionStarted = false;
    let mutationDispatched = false;
    let commitStarted = false;
    let activeRequest: SqlRequestLike | null = null;
    const cancel = () => {
      try {
        activeRequest?.cancel();
      } catch {
        // The transaction rollback path below is authoritative. A synchronous
        // request-cancel failure must not escape the AbortSignal callback.
      }
    };
    this.config.signal.addEventListener("abort", cancel, { once: true });
    try {
      await transaction.begin();
      transactionStarted = true;
      if (this.config.signal.aborted) {
        const rollback = await rollbackOutcome(() => transaction.rollback());
        transactionStarted = false;
        throw cancellationError("SQL Server", false, rollback);
      }
      activeRequest = transaction.request();
      for (const [name, value] of Object.entries(compiled.named)) activeRequest.input(name, normalizeParameter(value));
      mutationDispatched = request.kind === "mutation";
      const result = await activeRequest.query(compiled.sql);
      if (this.config.signal.aborted) {
        const rollback = await rollbackOutcome(() => transaction.rollback());
        transactionStarted = false;
        throw cancellationError(
          "SQL Server",
          request.kind === "mutation" && !rollback.ok,
          rollback,
        );
      }
      if (request.kind === "mutation") {
        commitStarted = true;
        await transaction.commit();
      } else await transaction.rollback();
      transactionStarted = false;
      return normalizeSqlServer(result, validated.command, Date.now() - started, this.config);
    } catch (error) {
      const rollback = transactionStarted
        ? await rollbackOutcome(() => transaction.rollback())
        : { ok: true as const };
      if (error instanceof DatabaseExecutorError) throw error;
      if (this.config.signal.aborted) {
        this.resetConnection();
        throw cancellationError(
          "SQL Server",
          request.kind === "mutation" && (commitStarted || !rollback.ok),
          rollback.ok ? undefined : rollback,
        );
      }
      if (!rollback.ok && mutationDispatched) {
        this.resetConnection();
        throw new DatabaseExecutorError(
          "SQL Server transport failed and rollback could not be confirmed.",
          "transport",
          true,
          rollback.error,
        );
      }
      if (isSqlServerQueryError(error) && !(request.kind === "mutation" && commitStarted)) {
        return queryError(validated.command, Date.now() - started, error.code, error.message);
      }
      const timeout = /timeout|cancel/i.test(errorMessage(error));
      this.resetConnection();
      throw new DatabaseExecutorError(timeout ? "SQL Server query timed out or was canceled." : "SQL Server transport failed.", timeout ? "timeout" : "transport", mutationDispatched, error);
    } finally {
      this.config.signal.removeEventListener("abort", cancel);
    }
  }

  async dispose(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.close().catch(() => undefined);
  }

  /** Drop a possibly poisoned pool so ensureConnected rebuilds cleanly. */
  private resetConnection(): void {
    const pool = this.pool;
    this.pool = null;
    if (pool) void pool.close().catch(() => undefined);
  }

  private async ensureConnected() {
    assertNotCanceled(this.config.signal, "SQL Server");
    if (this.pool) return this.pool;
    const binding = await assertDatabaseEgressAllowed(this.config);
    assertNotCanceled(this.config.signal, "SQL Server");
    // Tedious may ask its connector for another physical socket when a pool
    // connection is recreated (or when a server sends routing metadata). Each
    // such attempt is freshly authorized and pinned. Server-directed routing
    // cannot escape policy: the connector never resolves the routed hostname.
    let initialBinding: DatabaseEgressBinding | null = binding;
    const connector = async () => {
      const authorized = initialBinding ?? await assertDatabaseEgressAllowed(this.config);
      initialBinding = null;
      return connectPinnedDatabaseSocket(
        authorized,
        this.config.signal,
        this.config.connectTimeoutMs,
      );
    };
    const pool = this.createPool({
      server: binding.hostname,
      port: this.config.port,
      database: this.config.databaseName,
      user: this.config.username,
      password: this.config.password,
      connectionTimeout: this.config.connectTimeoutMs,
      requestTimeout: this.config.statementTimeoutMs,
      pool: { min: 0, max: 1, idleTimeoutMillis: 5_000 },
      options: {
        encrypt: this.config.tlsMode !== "disable",
        trustServerCertificate: this.config.tlsMode !== "verify-full",
        ...(isIP(binding.hostname) === 0 ? { serverName: binding.hostname } : {}),
        connector,
        appName: this.config.applicationName ?? "itestflow-test-execution",
        enableArithAbort: true,
      },
    });
    try {
      await pool.connect();
      this.pool = pool;
      return pool;
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw new DatabaseExecutorError(
        certificateFailureMessage(error) ?? "SQL Server connection failed.",
        "transport",
        false,
        error,
      );
    }
  }

  private async inspectSchema(pool: SqlPoolLike, tablePattern?: string) {
    const started = Date.now();
    // Inside the classified error path: a schema-introspection failure is a
    // normal query error/transport failure, never a whole-step infra error.
    try {
      const request = pool.request();
      const escaped = tablePattern ? escapeLikePattern(tablePattern) : null;
      request.input("schemas", this.access.schemas.join(","));
      request.input("pattern", escaped ? `%${escaped}%` : null);
      const result = await request.query<Record<string, unknown>>(`
        SELECT TOP (500) TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
               COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(@schemas, ','))
          AND (@pattern IS NULL OR TABLE_NAME LIKE @pattern ESCAPE '\\')
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`);
      return normalizeSqlServer(result, "SELECT", Date.now() - started, this.config);
    } catch (error) {
      if (error instanceof DatabaseExecutorError) throw error;
      if (isSqlServerQueryError(error)) {
        return queryError("SELECT", Date.now() - started, error.code, error.message);
      }
      this.resetConnection();
      throw new DatabaseExecutorError("SQL Server schema inspection failed.", "transport", false, error);
    }
  }
}

function normalizeSqlServer(
  result: IResult<Record<string, unknown>>,
  command: string,
  durationMs: number,
  config: DatabaseExecutorConfig,
): DatabaseExecutionResult {
  const records = Array.from(result.recordset ?? []) as Record<string, unknown>[];
  const bounded = boundedDatabaseRows(records, config.maxRows ?? 200, config.maxPreviewBytes ?? 64 * 1024);
  return {
    status: "ok",
    command,
    rowCount: result.rowsAffected?.reduce((sum, count) => sum + count, 0) ?? records.length,
    columns: columnsOf(result.recordset),
    ...bounded,
    durationMs,
  };
}

function columnsOf(recordset?: IRecordSet<Record<string, unknown>>) {
  if (!recordset) return [];
  const metadata = (recordset as IRecordSet<Record<string, unknown>> & { columns?: Record<string, unknown> }).columns;
  return metadata ? Object.keys(metadata) : Object.keys(recordset[0] ?? {});
}

function normalizeParameter(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  return value;
}

function isSqlServerQueryError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^(EREQUEST|EARGS|EINJECT)$/.test(code);
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : ""; }
