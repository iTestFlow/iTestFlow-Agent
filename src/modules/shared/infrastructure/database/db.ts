import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { randomUUID } from "crypto";

/**
 * PostgreSQL access layer.
 *
 * The previous implementation used the synchronous `node:sqlite` `DatabaseSync`
 * API. PostgreSQL access is asynchronous, so the data layer exposes three async
 * helpers — {@link sqlAll}, {@link sqlGet}, {@link sqlRun} — plus
 * {@link withTransaction}. Call sites keep their existing SQL strings and named
 * (`@name`) parameter objects; {@link translateNamedParameters} rewrites
 * `@name` placeholders into PostgreSQL positional `$n` placeholders so the port
 * stays mechanical.
 *
 * The pool is created lazily on first query and memoized on `globalThis` so that
 * Next.js dev hot-reload does not leak connection pools. Importing this module
 * never opens a connection, which keeps typecheck/build independent of a running
 * database.
 */

type GlobalWithPool = typeof globalThis & {
  __itestflowPgPool?: Pool;
};

const globalForPool = globalThis as GlobalWithPool;

export function getPool(): Pool {
  if (globalForPool.__itestflowPgPool) return globalForPool.__itestflowPgPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Start PostgreSQL (docker compose up -d postgres) and set DATABASE_URL — see .env.example.",
    );
  }

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? "10"),
  });
  // A pool-level error handler prevents an idle-client error from crashing the
  // process; the next acquisition recreates the connection.
  pool.on("error", (error) => {
    console.error("[db] idle PostgreSQL client error", error);
  });

  globalForPool.__itestflowPgPool = pool;
  return pool;
}

const NAMED_PARAMETER_PATTERN = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Rewrites `@name` placeholders into positional `$n` placeholders and builds the
 * ordered values array. A name reused in the SQL maps to the same positional
 * placeholder (and a single value). Throws when the SQL references a name that
 * is absent from `params`, mirroring the strictness of the previous driver and
 * surfacing typos instead of silently binding NULL.
 */
export function translateNamedParameters(
  sql: string,
  params: Record<string, unknown> = {},
): { text: string; values: unknown[] } {
  const indexByName = new Map<string, number>();
  const values: unknown[] = [];

  const text = sql.replace(NAMED_PARAMETER_PATTERN, (_match, name: string) => {
    let index = indexByName.get(name);
    if (index === undefined) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new Error(`SQL references @${name} but no value was provided.`);
      }
      values.push(params[name]);
      index = values.length;
      indexByName.set(name, index);
    }
    return `$${index}`;
  });

  return { text, values };
}

/** Run a query and return all rows. */
export async function sqlAll<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: Record<string, unknown> = {},
  client?: PoolClient,
): Promise<T[]> {
  const { text, values } = translateNamedParameters(sql, params);
  const executor = client ?? getPool();
  const result = await executor.query<T>(text, values);
  return result.rows;
}

/** Run a query and return the first row, or `undefined` when none match. */
export async function sqlGet<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: Record<string, unknown> = {},
  client?: PoolClient,
): Promise<T | undefined> {
  const rows = await sqlAll<T>(sql, params, client);
  return rows[0];
}

/** Run a statement for its side effects and return the affected row count. */
export async function sqlRun(
  sql: string,
  params: Record<string, unknown> = {},
  client?: PoolClient,
): Promise<number> {
  const { text, values } = translateNamedParameters(sql, params);
  const executor = client ?? getPool();
  const result = await executor.query(text, values);
  return result.rowCount ?? 0;
}

/**
 * Run `fn` inside a transaction on a single dedicated client. Commits on success,
 * rolls back on any thrown error, and always releases the client. Pass the
 * provided client to {@link sqlAll}/{@link sqlGet}/{@link sqlRun} so every
 * statement participates in the transaction.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("[db] ROLLBACK failed", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Serialized queue for best-effort, fire-and-forget writes (audit logs, LLM
 * request logs, analytics instrumentation). These were synchronous — and thus
 * implicitly ordered and never threw into the request path — under node:sqlite.
 * PostgreSQL writes are async, so they are enqueued here: tasks run one at a time
 * in submission order (preserving e.g. start→update→complete ordering for a single
 * analytics run) and failures are logged and swallowed, never surfaced to callers.
 */
let backgroundWriteChain: Promise<unknown> = Promise.resolve();

export function enqueueBackgroundWrite(label: string, task: () => Promise<unknown>): void {
  backgroundWriteChain = backgroundWriteChain
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.error(`[db] background write failed (${label}); skipping.`, error);
    });
}

/**
 * Await all currently-enqueued background writes. Intended for tests and graceful
 * shutdown so deferred writes are observable/flushed before assertions or exit.
 */
export async function flushBackgroundWrites(): Promise<void> {
  let tail: Promise<unknown>;
  do {
    tail = backgroundWriteChain;
    await tail.catch(() => undefined);
  } while (tail !== backgroundWriteChain);
}

/** Test-only: close and drop the memoized pool so the next call reconnects. */
export async function resetDatabaseForTests() {
  await flushBackgroundWrites();
  const pool = globalForPool.__itestflowPgPool;
  globalForPool.__itestflowPgPool = undefined;
  if (pool) await pool.end();
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}
