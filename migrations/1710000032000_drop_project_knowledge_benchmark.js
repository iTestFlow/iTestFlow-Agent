/**
 * Drops the retrieval-benchmark case store. The feature (silent question
 * collection from the Business Owner Assistant, admin labeling in Knowledge Hub,
 * and the npm run benchmark:run scorer) was removed: scores were only reachable
 * from a developer shell, so the collected questions and labels had no consumer.
 *
 * A forward drop instead of deleting migrations 1710000016000/1710000029000:
 * removing already-shipped migration files breaks node-pg-migrate's ordering
 * check on deployed databases (the failure db:fix-migration-history repairs).
 *
 * down() restores the merged schema (base table plus the label columns added by
 * 1710000029000) so the revert path is runnable, but the dropped rows —
 * collected questions and human labels — are not recoverable.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_project_knowledge_benchmark_project;
    DROP TABLE IF EXISTS project_knowledge_benchmark_cases;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS project_knowledge_benchmark_cases (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      source_type text NOT NULL,
      question_hash text NOT NULL,
      sanitized_question text NOT NULL,
      usage_count integer NOT NULL DEFAULT 1,
      first_seen_at text NOT NULL,
      last_seen_at text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      expected_work_item_id text,
      expected_answer_snippet text,
      labeled_at text,
      labeled_by text,
      UNIQUE (project_id, azure_project_id, source_type, question_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_project_knowledge_benchmark_project
      ON project_knowledge_benchmark_cases(project_id, azure_project_id, active, last_seen_at DESC);
  `);
};
