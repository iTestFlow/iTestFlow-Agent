import "server-only";

import { isIP } from "node:net";
import { Client, type ClientConfig, type QueryResult } from "pg";

import { boundedDatabaseRows } from "./database-result";
import { assertDatabaseEgressAllowed } from "./database-egress";
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
 * System schemas the discovery sweep never reports. information_schema itself
 * is privilege-filtered by PostgreSQL, so what remains is exactly what this
 * account can see.
 */
const POSTGRES_SYSTEM_SCHEMA_FILTER = `table_schema NOT IN ('pg_catalog', 'information_schema')
  AND table_schema NOT LIKE 'pg\\_toast%'
  AND table_schema NOT LIKE 'pg\\_temp%'`;

type PgClientLike = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(query: string | { text: string; values?: unknown[] }): Promise<QueryResult<Record<string, unknown>>>;
};

export class PostgresDatabaseExecutor implements DatabaseExecutor {
  readonly driver = "postgres" as const;
  private client: PgClientLike | null = null;
  private connected = false;
  /** Empty until discovery runs; every statement is bound to it. */
  private access: DatabaseAccess = { schemas: [], tables: new Set() };

  constructor(
    private readonly config: DatabaseExecutorConfig,
    private readonly createClient: (config: ClientConfig) => PgClientLike = (config) => new Client(config) as unknown as PgClientLike,
  ) {}

  setDatabaseAccess(access: DatabaseAccess): void {
    this.access = access;
  }

  async discoverObjects(): Promise<DiscoveredDatabaseObjects> {
    assertNotCanceled(this.config.signal, "PostgreSQL");
    const client = await this.ensureConnected();
    try {
      const result = await client.query({
        text: `SELECT table_schema, table_name, column_name, data_type
               FROM information_schema.columns
               WHERE ${POSTGRES_SYSTEM_SCHEMA_FILTER}
               ORDER BY table_schema, table_name, ordinal_position
               LIMIT $1`,
        values: [MAX_DISCOVERED_COLUMNS + 1],
      });
      return foldDiscoveredColumns((result.rows ?? []).map((row) => ({
        schema: row.table_schema,
        table: row.table_name,
        column: row.column_name,
        dataType: row.data_type,
      })));
    } catch (error) {
      if (error instanceof DatabaseExecutorError) throw error;
      this.resetConnection();
      throw new DatabaseExecutorError("PostgreSQL object discovery failed.", "transport", false, error);
    }
  }

  async execute(request: DatabaseExecutionRequest): Promise<DatabaseExecutionResult> {
    assertNotCanceled(this.config.signal, "PostgreSQL");
    const client = await this.ensureConnected();
    assertNotCanceled(this.config.signal, "PostgreSQL");
    if (request.kind === "schema") return this.inspectSchema(client, request.tablePattern);
    const parameters = request.parameters ?? {};
    const validated = validateSql({
      sql: request.sql,
      intent: request.kind === "select" ? "select" : "mutation",
      driver: this.driver,
      allowedSchemas: this.access.schemas,
      allowedTables: this.access.tables,
      parameters,
    });
    const compiled = compileNamedParameters(validated, parameters, this.driver);
    const started = Date.now();
    let transactionStarted = false;
    let mutationDispatched = false;
    let commitStarted = false;
    try {
      await client.query(request.kind === "select" ? "BEGIN READ ONLY" : "BEGIN");
      transactionStarted = true;
      if (this.config.signal.aborted) {
        const rollback = await rollbackOutcome(() => client.query("ROLLBACK"));
        transactionStarted = false;
        throw cancellationError("PostgreSQL", false, rollback);
      }
      mutationDispatched = request.kind === "mutation";
      const result = await client.query({
        text: compiled.sql,
        values: compiled.ordered,
      });
      if (this.config.signal.aborted) {
        const rollback = await rollbackOutcome(() => client.query("ROLLBACK"));
        transactionStarted = false;
        throw cancellationError(
          "PostgreSQL",
          request.kind === "mutation" && !rollback.ok,
          rollback,
        );
      }
      if (request.kind === "mutation") {
        commitStarted = true;
        await client.query("COMMIT");
      }
      else await client.query("ROLLBACK");
      transactionStarted = false;
      return normalizeResult(result, validated.command, Date.now() - started, this.config);
    } catch (error) {
      const rollback = transactionStarted
        ? await rollbackOutcome(() => client.query("ROLLBACK"))
        : { ok: true as const };
      if (error instanceof DatabaseExecutorError) throw error;
      if (this.config.signal.aborted) {
        this.resetConnection();
        throw cancellationError(
          "PostgreSQL",
          request.kind === "mutation" && (commitStarted || !rollback.ok),
          rollback.ok ? undefined : rollback,
        );
      }
      if (!rollback.ok && mutationDispatched) {
        this.resetConnection();
        throw new DatabaseExecutorError(
          "PostgreSQL transport failed and rollback could not be confirmed.",
          "transport",
          true,
          rollback.error,
        );
      }
      // Even a server-classified error received while COMMIT is in flight is
      // treated as uncertain: the executor cannot prove the durable outcome.
      if (isPgQueryError(error) && !(request.kind === "mutation" && commitStarted)) {
        return queryError(validated.command, Date.now() - started, error.code, error.message);
      }
      this.resetConnection();
      throw connectionError(error, mutationDispatched);
    }
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) await client.end().catch(() => undefined);
  }

  /** Drop a possibly poisoned client so ensureConnected rebuilds cleanly. */
  private resetConnection(): void {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) void client.end().catch(() => undefined);
  }

  private async ensureConnected() {
    assertNotCanceled(this.config.signal, "PostgreSQL");
    if (this.connected && this.client) return this.client;
    const binding = await assertDatabaseEgressAllowed(this.config);
    assertNotCanceled(this.config.signal, "PostgreSQL");
    const client = this.createClient({
      // The socket connects to the address authorized above. For TLS, pg
      // retains the explicit servername below and verifies the certificate
      // against the configured hostname rather than this IP.
      host: binding.address,
      port: this.config.port,
      database: this.config.databaseName,
      user: this.config.username,
      password: this.config.password,
      application_name: this.config.applicationName ?? "itestflow-test-execution",
      connectionTimeoutMillis: this.config.connectTimeoutMs,
      statement_timeout: this.config.statementTimeoutMs,
      query_timeout: this.config.statementTimeoutMs,
      ssl: this.config.tlsMode === "disable"
        ? false
        : {
            rejectUnauthorized: this.config.tlsMode === "verify-full",
            ...(isIP(binding.hostname) === 0 ? { servername: binding.hostname } : {}),
          },
    });
    try {
      await client.connect();
      this.client = client;
      this.connected = true;
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw new DatabaseExecutorError(
        certificateFailureMessage(error) ?? "PostgreSQL connection failed.",
        "transport",
        false,
        error,
      );
    }
  }

  private async inspectSchema(client: PgClientLike, tablePattern?: string): Promise<DatabaseExecutionResult> {
    const started = Date.now();
    // Inside the classified error path: a schema-introspection failure is a
    // normal query error/transport failure, never a whole-step infra error.
    try {
      const escaped = tablePattern ? escapeLikePattern(tablePattern) : null;
      const result = await client.query({
        text: `SELECT table_schema, table_name, column_name, data_type, is_nullable
               FROM information_schema.columns
               WHERE table_schema = ANY($1::text[])
                 AND ($2::text IS NULL OR table_name ILIKE $2)
               ORDER BY table_schema, table_name, ordinal_position
               LIMIT 500`,
        values: [this.access.schemas, escaped ? `%${escaped}%` : null],
      });
      return normalizeResult(result, "SELECT", Date.now() - started, this.config);
    } catch (error) {
      if (error instanceof DatabaseExecutorError) throw error;
      if (isPgQueryError(error)) {
        return queryError("SELECT", Date.now() - started, error.code, error.message);
      }
      this.resetConnection();
      throw new DatabaseExecutorError("PostgreSQL schema inspection failed.", "transport", false, error);
    }
  }
}

function normalizeResult(
  result: QueryResult<Record<string, unknown>>,
  command: string,
  durationMs: number,
  config: DatabaseExecutorConfig,
): DatabaseExecutionResult {
  const bounded = boundedDatabaseRows(result.rows ?? [], config.maxRows ?? 200, config.maxPreviewBytes ?? 64 * 1024);
  return {
    status: "ok",
    command: result.command || command,
    rowCount: result.rowCount ?? result.rows?.length ?? 0,
    columns: result.fields?.map((field) => field.name) ?? Object.keys(result.rows?.[0] ?? {}),
    ...bounded,
    durationMs,
  };
}

function isPgQueryError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; severity?: unknown };
  // PostgreSQL server errors carry a five-character SQLSTATE and severity.
  // Node/socket errors also expose a string `code` (ECONNRESET, EPIPE, ...),
  // so accepting code alone can incorrectly mark an ambiguous COMMIT as a
  // completed query error.
  return (
    typeof candidate.code === "string" &&
    /^[0-9A-Z]{5}$/.test(candidate.code) &&
    typeof candidate.severity === "string"
  );
}

function connectionError(error: unknown, uncertain: boolean) {
  const message = error instanceof Error && /timeout/i.test(error.message)
    ? "PostgreSQL query timed out."
    : "PostgreSQL transport failed.";
  return new DatabaseExecutorError(message, /timeout/i.test(message) ? "timeout" : "transport", uncertain, error);
}

