import "server-only";

import mysql, { type Connection, type ConnectionOptions, type FieldPacket, type ResultSetHeader } from "mysql2/promise";

import { boundedDatabaseRows } from "./database-result";
import {
  assertDatabaseEgressAllowed,
  createPinnedDatabaseSocket,
  type DatabaseEgressBinding,
} from "./database-egress";
import {
  assertNotCanceled,
  cancellationError,
  escapeLikePattern,
  queryError,
  rollbackOutcome,
} from "./database-executor.shared";
import {
  DatabaseExecutorError,
  type DatabaseExecutionRequest,
  type DatabaseExecutionResult,
  type DatabaseExecutor,
  type DatabaseExecutorConfig,
} from "./database-executor.port";
import { compileNamedParameters, validateSql } from "./sql-policy";

type MysqlConnectionLike = Pick<Connection, "query" | "beginTransaction" | "commit" | "rollback" | "end" | "destroy"> & {
  threadId?: number;
};

/** Bounds for the KILL QUERY control connection so cancellation cannot hang. */
const CONTROL_CONNECT_TIMEOUT_MS = 5_000;
const CONTROL_STATEMENT_TIMEOUT_MS = 5_000;

export class MysqlDatabaseExecutor implements DatabaseExecutor {
  readonly driver = "mysql" as const;
  private connection: MysqlConnectionLike | null = null;
  private binding: DatabaseEgressBinding | null = null;

  constructor(
    private readonly config: DatabaseExecutorConfig,
    private readonly createConnection: (config: ConnectionOptions) => Promise<MysqlConnectionLike> = (config) => mysql.createConnection(config),
  ) {}

  async execute(request: DatabaseExecutionRequest): Promise<DatabaseExecutionResult> {
    assertNotCanceled(this.config.signal, "MySQL");
    const connection = await this.ensureConnected();
    assertNotCanceled(this.config.signal, "MySQL");
    if (request.kind === "schema") return this.inspectSchema(connection, request.tablePattern);
    const parameters = request.parameters ?? {};
    const validated = validateSql({ sql: request.sql, intent: request.kind === "select" ? "select" : "mutation", driver: this.driver, allowedSchemas: this.config.schemas, parameters });
    const compiled = compileNamedParameters(validated, parameters, this.driver);
    const started = Date.now();
    let transactionStarted = false;
    let mutationDispatched = false;
    let commitStarted = false;
    // mysql2's client-side `timeout` abandons the socket without cancelling
    // the server statement. Server-side KILL QUERY (through a bounded control
    // connection pinned to the same authorized address) is the real cancel;
    // if it cannot be issued the poisoned connection is destroyed instead.
    const cancel = () => {
      void this.killActiveStatement(connection);
    };
    this.config.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (request.kind === "select") await connection.query("START TRANSACTION READ ONLY");
      else await connection.beginTransaction();
      transactionStarted = true;
      if (this.config.signal.aborted) {
        const rollback = await rollbackOutcome(() => connection.rollback());
        transactionStarted = false;
        throw cancellationError("MySQL", false, rollback);
      }
      mutationDispatched = request.kind === "mutation";
      const [rows, fields] = await connection.query({ sql: compiled.sql, values: compiled.ordered, timeout: this.config.statementTimeoutMs });
      if (this.config.signal.aborted) {
        const rollback = await rollbackOutcome(() => connection.rollback());
        transactionStarted = false;
        throw cancellationError(
          "MySQL",
          request.kind === "mutation" && !rollback.ok,
          rollback,
        );
      }
      if (request.kind === "mutation") {
        commitStarted = true;
        await connection.commit();
      } else await connection.rollback();
      transactionStarted = false;
      return normalizeMysql(rows, fields as FieldPacket[] | undefined, validated.command, Date.now() - started, this.config);
    } catch (error) {
      const rollback = transactionStarted
        ? await rollbackOutcome(() => connection.rollback())
        : { ok: true as const };
      if (error instanceof DatabaseExecutorError) throw error;
      if (this.config.signal.aborted) {
        this.resetConnection();
        throw cancellationError(
          "MySQL",
          request.kind === "mutation" && (commitStarted || !rollback.ok),
          rollback.ok ? undefined : rollback,
        );
      }
      if (!rollback.ok && mutationDispatched) {
        this.resetConnection();
        throw new DatabaseExecutorError(
          "MySQL transport failed and rollback could not be confirmed.",
          "transport",
          true,
          rollback.error,
        );
      }
      // COMMIT errors are never downgraded to ordinary query observations;
      // durability is ambiguous until independently verified.
      if (isMysqlQueryError(error) && !(request.kind === "mutation" && commitStarted)) {
        return queryError(validated.command, Date.now() - started, error.sqlState, error.message);
      }
      const timedOut = /timeout/i.test(errorMessage(error));
      // A client-side statement timeout leaves the server statement running
      // and the connection mid-protocol: cancel server-side, then discard the
      // connection either way so the next call reconnects cleanly.
      if (timedOut) await this.killActiveStatement(connection);
      this.resetConnection();
      throw new DatabaseExecutorError(
        timedOut ? "MySQL query timed out." : "MySQL transport failed.",
        timedOut ? "timeout" : "transport",
        mutationDispatched,
        error,
      );
    } finally {
      this.config.signal.removeEventListener("abort", cancel);
    }
  }

  async dispose(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection) await connection.end().catch(() => undefined);
  }

  /** Drop a possibly poisoned connection so ensureConnected rebuilds cleanly. */
  private resetConnection(): void {
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        connection.destroy();
      } catch {
        // The socket is already gone; nothing to release.
      }
    }
  }

  /**
   * Best-effort server-side cancellation via KILL QUERY on a short-lived
   * control connection. The control connection reuses the already-authorized
   * pinned address — never a fresh hostname resolution — so the cancel path
   * cannot become a DNS-rebinding hole in the egress policy. On any failure
   * the primary connection is destroyed and never reused.
   */
  private async killActiveStatement(connection: MysqlConnectionLike): Promise<void> {
    const threadId = connection.threadId;
    const binding = this.binding;
    if (!binding || typeof threadId !== "number" || !Number.isInteger(threadId) || threadId <= 0) {
      this.resetConnection();
      return;
    }
    let control: MysqlConnectionLike | null = null;
    try {
      const controlSignal = AbortSignal.timeout(CONTROL_CONNECT_TIMEOUT_MS + CONTROL_STATEMENT_TIMEOUT_MS);
      control = await this.createConnection({
        host: binding.hostname,
        port: this.config.port,
        database: this.config.databaseName,
        user: this.config.username,
        password: this.config.password,
        connectTimeout: Math.min(this.config.connectTimeoutMs, CONTROL_CONNECT_TIMEOUT_MS),
        ssl: this.config.tlsMode === "disable"
          ? undefined
          : {
              rejectUnauthorized: this.config.tlsMode === "verify-full",
              verifyIdentity: this.config.tlsMode === "verify-full",
            },
        stream: () => createPinnedDatabaseSocket(binding, controlSignal),
        namedPlaceholders: false,
      });
      await control.query({ sql: `KILL QUERY ${threadId}`, timeout: CONTROL_STATEMENT_TIMEOUT_MS });
    } catch {
      // Cancellation could not be confirmed: the primary connection must not
      // be returned to reuse.
      this.resetConnection();
    } finally {
      if (control) {
        try {
          control.destroy();
        } catch {
          // Control connection teardown is best-effort.
        }
      }
    }
  }

  private async ensureConnected() {
    assertNotCanceled(this.config.signal, "MySQL");
    if (this.connection) return this.connection;
    const binding = await assertDatabaseEgressAllowed(this.config);
    assertNotCanceled(this.config.signal, "MySQL");
    try {
      const connection = await this.createConnection({
        // Keep the configured hostname for MySQL TLS SNI/identity checks while
        // supplying a socket that is already pinned to the authorized IP.
        host: binding.hostname,
        port: this.config.port,
        database: this.config.databaseName,
        user: this.config.username,
        password: this.config.password,
        connectTimeout: this.config.connectTimeoutMs,
        ssl: this.config.tlsMode === "disable"
          ? undefined
          : {
              rejectUnauthorized: this.config.tlsMode === "verify-full",
              verifyIdentity: this.config.tlsMode === "verify-full",
            },
        stream: () => createPinnedDatabaseSocket(binding, this.config.signal),
        namedPlaceholders: false,
      });
      this.connection = connection;
      this.binding = binding;
      return connection;
    } catch (error) {
      throw new DatabaseExecutorError("MySQL connection failed.", "transport", false, error);
    }
  }

  private async inspectSchema(connection: MysqlConnectionLike, tablePattern?: string) {
    const started = Date.now();
    // Inside the classified error path: a schema-introspection failure is a
    // normal query error/transport failure, never a whole-step infra error.
    try {
      const escaped = tablePattern ? escapeLikePattern(tablePattern) : null;
      const [rows, fields] = await connection.query({
        sql: `SELECT table_schema, table_name, column_name, data_type, is_nullable
              FROM information_schema.columns
              WHERE table_schema IN (?) AND (? IS NULL OR table_name LIKE ?)
              ORDER BY table_schema, table_name, ordinal_position
              LIMIT 500`,
        values: [this.config.schemas, escaped, escaped ? `%${escaped}%` : null],
        timeout: this.config.statementTimeoutMs,
      });
      return normalizeMysql(rows, fields as FieldPacket[] | undefined, "SELECT", Date.now() - started, this.config);
    } catch (error) {
      if (error instanceof DatabaseExecutorError) throw error;
      if (isMysqlQueryError(error)) {
        return queryError("SELECT", Date.now() - started, error.sqlState, error.message);
      }
      this.resetConnection();
      throw new DatabaseExecutorError("MySQL schema inspection failed.", "transport", false, error);
    }
  }
}

function normalizeMysql(rows: unknown, fields: FieldPacket[] | undefined, command: string, durationMs: number, config: DatabaseExecutorConfig): DatabaseExecutionResult {
  const records = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
  const header = !Array.isArray(rows) ? rows as ResultSetHeader : null;
  const bounded = boundedDatabaseRows(records, config.maxRows ?? 200, config.maxPreviewBytes ?? 64 * 1024);
  return { status: "ok", command, rowCount: header?.affectedRows ?? records.length, columns: fields?.map((field) => field.name) ?? Object.keys(records[0] ?? {}), ...bounded, durationMs };
}

function isMysqlQueryError(error: unknown): error is Error & { code: string; errno: number; sqlState: string } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; errno?: unknown; sqlState?: unknown };
  // mysql2 server errors include numeric errno + five-character SQLSTATE.
  // Transport errors also have string codes, but no valid server SQLSTATE.
  return (
    typeof candidate.code === "string" &&
    typeof candidate.errno === "number" &&
    Number.isInteger(candidate.errno) &&
    typeof candidate.sqlState === "string" &&
    /^[0-9A-Z]{5}$/.test(candidate.sqlState)
  );
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : ""; }
