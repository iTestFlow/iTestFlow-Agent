/* eslint-disable camelcase */

/**
 * Test Execution — monotonic change cursor for incremental run-detail polling.
 *
 * Every insert/update of a run/case/step/action row stamps change_seq from ONE
 * global sequence via a trigger (writes are scattered raw-SQL statements
 * across services; a trigger guarantees no write path can forget the bump).
 * Uniqueness per changed row-version makes cursor pagination safe: a page
 * boundary can never skip a row that shares a sequence value.
 *
 * Run-detail rows are insert/update-only during an active run — nothing is
 * physically deleted — so the incremental protocol needs no tombstones. If a
 * delete path is ever added, the polling protocol must move to tombstones.
 */

exports.shorthands = undefined;

const TABLES = [
  "test_execution_runs",
  "test_execution_case_runs",
  "test_execution_step_runs",
  "test_execution_action_runs",
];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE SEQUENCE IF NOT EXISTS test_execution_change_seq;

    CREATE OR REPLACE FUNCTION test_execution_bump_change_seq() RETURNS trigger AS $$
    BEGIN
      NEW.change_seq := nextval('test_execution_change_seq');
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  for (const table of TABLES) {
    pgm.sql(`
      ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS change_seq bigint NOT NULL DEFAULT nextval('test_execution_change_seq');

      DROP TRIGGER IF EXISTS trg_${table}_change_seq ON ${table};
      CREATE TRIGGER trg_${table}_change_seq
        BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION test_execution_bump_change_seq();
    `);
  }
  // Incremental polling filters by run + cursor; runs themselves poll by id.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_test_execution_case_runs_change_seq ON test_execution_case_runs (run_id, change_seq);
    CREATE INDEX IF NOT EXISTS idx_test_execution_step_runs_change_seq ON test_execution_step_runs (run_id, change_seq);
    CREATE INDEX IF NOT EXISTS idx_test_execution_action_runs_change_seq ON test_execution_action_runs (run_id, change_seq);
  `);
};

exports.down = (pgm) => {
  for (const table of TABLES) {
    pgm.sql(`
      DROP TRIGGER IF EXISTS trg_${table}_change_seq ON ${table};
      ALTER TABLE ${table} DROP COLUMN IF EXISTS change_seq;
    `);
  }
  pgm.sql(`
    DROP INDEX IF EXISTS idx_test_execution_case_runs_change_seq;
    DROP INDEX IF EXISTS idx_test_execution_step_runs_change_seq;
    DROP INDEX IF EXISTS idx_test_execution_action_runs_change_seq;
    DROP FUNCTION IF EXISTS test_execution_bump_change_seq();
    DROP SEQUENCE IF EXISTS test_execution_change_seq;
  `);
};
