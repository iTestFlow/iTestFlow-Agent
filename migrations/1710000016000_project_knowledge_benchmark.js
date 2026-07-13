exports.shorthands = undefined;

exports.up = (pgm) => {
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
      UNIQUE (project_id, azure_project_id, source_type, question_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_project_knowledge_benchmark_project
      ON project_knowledge_benchmark_cases(project_id, azure_project_id, active, last_seen_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_project_knowledge_benchmark_project;
    DROP TABLE IF EXISTS project_knowledge_benchmark_cases;
  `);
};
