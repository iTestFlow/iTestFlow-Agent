/* eslint-disable camelcase */

/**
 * M2: make immutable uploaded-document versions first-class knowledge evidence.
 *
 * Work-item provenance stays physically and semantically intact.  The new
 * discriminator is additive so historical evidence rows parse as work-item
 * evidence and publication never has to infer an identity from denormalized
 * JSON output.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE project_knowledge_entry_evidence_refs
      ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'work_item',
      ADD COLUMN IF NOT EXISTS source_document_id text,
      ADD COLUMN IF NOT EXISTS source_document_version_id text;

    ALTER TABLE project_knowledge_entry_evidence_refs
      DROP CONSTRAINT IF EXISTS chk_project_knowledge_evidence_source_kind;
    /*
     * NOT VALID matches the FK constraints below: every pre-existing row
     * trivially satisfies these checks (source_kind defaults to 'work_item'
     * and the document columns default to NULL), so skipping the validation
     * scan avoids holding the ACCESS EXCLUSIVE lock over a full-table read
     * on large evidence tables.  New and updated rows are still enforced.
     */
    ALTER TABLE project_knowledge_entry_evidence_refs
      ADD CONSTRAINT chk_project_knowledge_evidence_source_kind
      CHECK (source_kind IN ('work_item', 'document'))
      NOT VALID;

    ALTER TABLE project_knowledge_entry_evidence_refs
      ALTER COLUMN source_snapshot_id DROP NOT NULL,
      ALTER COLUMN source_work_item_id DROP NOT NULL;

    ALTER TABLE project_knowledge_entry_evidence_refs
      DROP CONSTRAINT IF EXISTS chk_project_knowledge_evidence_identity;
    ALTER TABLE project_knowledge_entry_evidence_refs
      ADD CONSTRAINT chk_project_knowledge_evidence_identity
      CHECK (
        (source_kind = 'work_item'
          AND source_snapshot_id IS NOT NULL
          AND source_work_item_id IS NOT NULL
          AND source_document_id IS NULL
          AND source_document_version_id IS NULL)
        OR
        (source_kind = 'document'
          AND source_snapshot_id IS NULL
          AND source_work_item_id IS NULL
          AND source_document_id IS NOT NULL
          AND source_document_version_id IS NOT NULL)
      )
      NOT VALID;

    ALTER TABLE project_knowledge_entry_evidence_refs
      DROP CONSTRAINT IF EXISTS fk_project_knowledge_evidence_source_document;
    ALTER TABLE project_knowledge_entry_evidence_refs
      ADD CONSTRAINT fk_project_knowledge_evidence_source_document
      FOREIGN KEY (source_document_id, workspace_id, project_id, azure_project_id)
      REFERENCES project_source_documents(id, workspace_id, project_id, azure_project_id)
      ON DELETE RESTRICT
      NOT VALID;

    ALTER TABLE project_knowledge_entry_evidence_refs
      DROP CONSTRAINT IF EXISTS fk_project_knowledge_evidence_source_document_version;
    ALTER TABLE project_knowledge_entry_evidence_refs
      ADD CONSTRAINT fk_project_knowledge_evidence_source_document_version
      FOREIGN KEY (
        source_document_version_id, source_document_id, workspace_id, project_id, azure_project_id
      )
      REFERENCES project_source_document_versions(
        id, document_id, workspace_id, project_id, azure_project_id
      )
      ON DELETE RESTRICT
      NOT VALID;

    CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_document
      ON project_knowledge_entry_evidence_refs (
        project_id,
        azure_project_id,
        source_document_id,
        entry_version_id
      )
      WHERE source_kind = 'document';

    CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_document_version
      ON project_knowledge_entry_evidence_refs (source_document_version_id)
      WHERE source_kind = 'document';

    /*
     * Contract 5.0.0 adds a source kind and a distinct handle namespace. An
     * in-flight draft cannot be safely reinterpreted under that contract, so
     * it must be rebuilt from its frozen source manifest.
     */
    UPDATE project_knowledge_drafts
    SET status = 'superseded',
        status_reason = 'documents_evidence_upgrade_requires_new_build',
        pending_drift = false,
        updated_at = COALESCE(updated_at, created_at)
    WHERE compiler_contract_version IS DISTINCT FROM '5.0.0'
      AND status IN ('generating', 'awaiting_input', 'ready_for_review', 'ready_to_publish', 'blocked', 'rebase_required');

    UPDATE project_knowledge_base
    SET compiler_compatibility = 'upgrade_required'
    WHERE compiler_contract_version IS DISTINCT FROM '5.0.0';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    /* A rollback cannot retain document refs because the legacy columns are NOT NULL. */
    DELETE FROM project_knowledge_entry_evidence_refs
    WHERE source_kind = 'document';

    DROP INDEX IF EXISTS idx_knowledge_evidence_document_version;
    DROP INDEX IF EXISTS idx_knowledge_evidence_document;

    ALTER TABLE project_knowledge_entry_evidence_refs
      DROP CONSTRAINT IF EXISTS fk_project_knowledge_evidence_source_document_version,
      DROP CONSTRAINT IF EXISTS fk_project_knowledge_evidence_source_document,
      DROP CONSTRAINT IF EXISTS chk_project_knowledge_evidence_identity,
      DROP CONSTRAINT IF EXISTS chk_project_knowledge_evidence_source_kind;

    ALTER TABLE project_knowledge_entry_evidence_refs
      ALTER COLUMN source_snapshot_id SET NOT NULL,
      ALTER COLUMN source_work_item_id SET NOT NULL,
      DROP COLUMN IF EXISTS source_document_version_id,
      DROP COLUMN IF EXISTS source_document_id,
      DROP COLUMN IF EXISTS source_kind;
  `);
};
