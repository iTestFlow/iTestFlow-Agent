/* eslint-disable camelcase */

/**
 * Test Execution Phase 1 — defect candidates and the publication ledger.
 *
 * Execution produces defect *candidates*, never automatic bugs. A candidate is
 * generated deterministically from a failed case run (one per case — sequential
 * execution stops a case at its first failure), reviewed and optionally edited
 * by the user, and only published to Azure DevOps on explicit request through
 * the existing bug-posting service.
 *
 * test_defect_publications is the idempotency ledger the repo's bug flow has
 * lacked: publish inserts a 'publishing' row first, so a concurrent duplicate
 * loses the partial-unique-index race and surfaces as a 409 instead of a
 * second Azure bug. Failed attempts keep their row (status 'failed') for audit
 * but do not block a retry.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS test_defect_candidates (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      case_run_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      status text NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'selected', 'dismissed', 'published')),
      draft_json jsonb NOT NULL,
      evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      updated_by text,
      CONSTRAINT chk_test_defect_candidates_draft_object
        CHECK (jsonb_typeof(draft_json) = 'object'),
      CONSTRAINT chk_test_defect_candidates_evidence_array
        CHECK (jsonb_typeof(evidence_json) = 'array'),
      CONSTRAINT fk_test_defect_candidates_run_scope
        FOREIGN KEY (run_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_execution_runs (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT fk_test_defect_candidates_case
        FOREIGN KEY (case_run_id, run_id)
        REFERENCES test_execution_case_runs (id, run_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_defect_candidates_case
        UNIQUE (case_run_id),
      /* Used by the publication ledger's trusted-scope foreign key. */
      CONSTRAINT uq_test_defect_candidates_scope_identity
        UNIQUE (id, workspace_id, project_id, azure_project_id)
    );

    CREATE TABLE IF NOT EXISTS test_defect_publications (
      id text PRIMARY KEY,
      candidate_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      status text NOT NULL DEFAULT 'publishing'
        CHECK (status IN ('publishing', 'succeeded', 'failed')),
      azure_bug_id text,
      azure_bug_url text,
      attachment_results_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      error_message text,
      published_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_test_defect_publications_attachments_array
        CHECK (jsonb_typeof(attachment_results_json) = 'array'),
      CONSTRAINT chk_test_defect_publications_success_has_bug
        CHECK (status <> 'succeeded' OR azure_bug_id IS NOT NULL),
      CONSTRAINT fk_test_defect_publications_candidate_scope
        FOREIGN KEY (candidate_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_defect_candidates (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE
    );

    /*
     * The idempotency guarantee: at most one non-failed publication per
     * candidate. Inserting the 'publishing' row is the lock acquisition.
     */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_test_defect_publications_active
      ON test_defect_publications (candidate_id)
      WHERE status <> 'failed';

    CREATE INDEX IF NOT EXISTS idx_test_defect_publications_candidate
      ON test_defect_publications (candidate_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_test_defect_publications_candidate;
    DROP INDEX IF EXISTS uq_test_defect_publications_active;
    DROP TABLE IF EXISTS test_defect_publications;
    DROP TABLE IF EXISTS test_defect_candidates;
  `);
};
