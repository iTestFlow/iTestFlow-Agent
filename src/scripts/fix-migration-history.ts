/**
 * One-time reconciliation for migration histories recorded under filenames that no
 * longer exist in this repository.
 *
 * The canonical ordering is now:
 *
 *   1710000022000_workspace_external_llm_setting
 *   1710000023000_workspace_model_input_limit_override
 *   1710000023100_embeddings_indexes
 *   1710000023200_trigram_search
 *
 * Fork-era databases can contain either the pre-rename embeddings/trigram names
 * (22000/23000), the short-lived merge-window names (21100/21200), or the
 * transient workspace names (30000/31000). The first two pairs are renamed to
 * the canonical embeddings/trigram names. The transient workspace records are
 * renamed, rather than deleted: deleting them stranded databases because
 * node-pg-migrate then believed the real workspace migrations had never run.
 *
 * A prior version also tried to move individual timestamps between anchors. That
 * fails for healthy CLI histories where a single transaction gives several rows
 * the same `run_on`. This repair instead canonicalizes the complete `(run_on, id)`
 * ordering on the server, which is exactly the ordering node-pg-migrate compares
 * with filenames. It also applies either missing workspace migration when later
 * history proves it was skipped; both migrations use idempotent `ADD COLUMN IF
 * NOT EXISTS` statements.
 *
 * Safe to run on fresh, healthy, already-repaired, and empty databases. The only
 * required operator action is for a fork-era history that needs reconciliation.
 *
 * Run: node --env-file=.env --conditions=react-server --import tsx src/scripts/fix-migration-history.ts
 * Env: DATABASE_URL
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { PoolClient } from "pg";

import { withTransaction } from "@/modules/shared/infrastructure/database/db";

type SqlMigration = {
  up: (pgm: { sql: (statement: string) => void }) => void;
};

const require = createRequire(import.meta.url);

const RENAMES: Array<{ from: string; to: string }> = [
  { from: "1710000022000_embeddings_indexes", to: "1710000023100_embeddings_indexes" },
  { from: "1710000021100_embeddings_indexes", to: "1710000023100_embeddings_indexes" },
  { from: "1710000023000_trigram_search", to: "1710000023200_trigram_search" },
  { from: "1710000021200_trigram_search", to: "1710000023200_trigram_search" },
  {
    from: "1710000030000_workspace_external_llm_setting",
    to: "1710000022000_workspace_external_llm_setting",
  },
  {
    from: "1710000031000_workspace_model_input_limit_override",
    to: "1710000023000_workspace_model_input_limit_override",
  },
];

const REMOVED = [
  "1710000025000_workspace_settings_embeddings",
  "1710000026000_drop_workspace_settings_embeddings",
];

const WORKSPACE_MIGRATIONS = [
  {
    name: "1710000022000_workspace_external_llm_setting",
    file: "1710000022000_workspace_external_llm_setting",
  },
  {
    name: "1710000023000_workspace_model_input_limit_override",
    file: "1710000023000_workspace_model_input_limit_override",
  },
];

function migrationSql(file: string): string[] {
  const migration = require(`../../migrations/${file}.js`) as SqlMigration;
  const statements: string[] = [];
  migration.up({ sql: (statement) => statements.push(statement) });
  return statements;
}

async function renameMigration(client: PoolClient, from: string, to: string): Promise<void> {
  const duplicate = await client.query(
    `DELETE FROM pgmigrations
     WHERE name = $1
       AND EXISTS (SELECT 1 FROM pgmigrations WHERE name = $2)`,
    [from, to],
  );
  const renamed = await client.query(`UPDATE pgmigrations SET name = $2 WHERE name = $1`, [from, to]);

  if (duplicate.rowCount) console.log(`removed duplicate record: ${from} (canonical ${to} already exists)`);
  if (renamed.rowCount) console.log(`renamed: ${from} -> ${to}`);
}

async function applyMissedWorkspaceMigration(
  client: PoolClient,
  migration: (typeof WORKSPACE_MIGRATIONS)[number],
): Promise<void> {
  const result = await client.query<{ should_apply: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = $1)
         AND EXISTS (SELECT 1 FROM pgmigrations WHERE name > $1) AS should_apply`,
    [migration.name],
  );
  if (!result.rows[0]?.should_apply) return;

  for (const statement of migrationSql(migration.file)) {
    await client.query(statement);
  }
  await client.query(
    `INSERT INTO pgmigrations (name, run_on)
     SELECT $1::varchar(255), MIN(run_on)
     FROM pgmigrations
     WHERE name > $1::varchar(255)`,
    [migration.name],
  );
  console.log(`applied and recorded missed workspace migration: ${migration.name}`);
}

async function canonicalizeOrder(client: PoolClient): Promise<void> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM (
       SELECT ROW_NUMBER() OVER (ORDER BY run_on, id) AS run_order,
              ROW_NUMBER() OVER (ORDER BY name) AS name_order
       FROM pgmigrations
     ) AS ordered
     WHERE run_order <> name_order`,
  );
  if (Number(result.rows[0]?.count ?? 0) === 0) return;

  await client.query(
    `WITH ordered AS (
       SELECT id AS old_id,
              ((SELECT MAX(id) FROM pgmigrations) + ROW_NUMBER() OVER (ORDER BY name))::int AS canonical_id,
              MAX(run_on) OVER (
                ORDER BY name
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS canonical_run_on
       FROM pgmigrations
     )
     UPDATE pgmigrations AS migrations
     SET id = ordered.canonical_id,
         run_on = ordered.canonical_run_on
     FROM ordered
     WHERE migrations.id = ordered.old_id`,
  );
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence('pgmigrations', 'id')::regclass,
       (SELECT MAX(id) FROM pgmigrations),
       true
     )`,
  );
  console.log("canonicalized pgmigrations order");
}

/**
 * Repair a `pgmigrations` history using the caller's transaction/client.
 *
 * The CLI entry point below wraps this transform in `withTransaction`; accepting a
 * client keeps the transform independently testable inside an integration-test
 * transaction.
 */
export async function repairMigrationHistory(client: PoolClient): Promise<void> {
  const table = await client.query<{ migration_table: string | null }>(
    `SELECT to_regclass('pgmigrations')::text AS migration_table`,
  );
  if (!table.rows[0]?.migration_table) {
    console.log("pgmigrations does not exist; nothing to repair.");
    return;
  }

  for (const { from, to } of RENAMES) {
    await renameMigration(client, from, to);
  }
  for (const name of REMOVED) {
    const removed = await client.query(`DELETE FROM pgmigrations WHERE name = $1`, [name]);
    if (removed.rowCount) console.log(`removed dead migration record: ${name}`);
  }
  for (const migration of WORKSPACE_MIGRATIONS) {
    await applyMissedWorkspaceMigration(client, migration);
  }
  await canonicalizeOrder(client);
}

async function main(): Promise<void> {
  await withTransaction(repairMigrationHistory);
  console.log("Done. `npm run db:migrate` can now verify the repaired history.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
