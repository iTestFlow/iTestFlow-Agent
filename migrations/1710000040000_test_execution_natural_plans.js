/* eslint-disable camelcase */

/**
 * Test Execution Phase 1.5 — natural-language plans.
 *
 * Plans are no longer compiled typed actions: cases carry natural steps
 * (instruction + expected result) and an LLM agent chooses validated actions
 * at run time. compile_source gains 'natural_text' for these rows; the old
 * values remain valid for any pre-existing rows.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE test_execution_case_runs
      DROP CONSTRAINT IF EXISTS test_execution_case_runs_compile_source_check;
    ALTER TABLE test_execution_case_runs
      ADD CONSTRAINT test_execution_case_runs_compile_source_check
      CHECK (compile_source IN ('manual_typed', 'llm_compiled', 'natural_text')) NOT VALID;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE test_execution_case_runs
      DROP CONSTRAINT IF EXISTS test_execution_case_runs_compile_source_check;
    ALTER TABLE test_execution_case_runs
      ADD CONSTRAINT test_execution_case_runs_compile_source_check
      CHECK (compile_source IN ('manual_typed', 'llm_compiled', 'natural_text')) NOT VALID;
  `);
};
