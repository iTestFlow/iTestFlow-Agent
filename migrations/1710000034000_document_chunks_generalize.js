/* eslint-disable camelcase */

/**
 * Adds the document-source provenance fields to the generic chunk stores.
 *
 * Existing chunk rows predate these columns and remain valid ADO rows.  The
 * source-document foreign keys are NOT VALID so a historical, dormant legacy
 * `documents` reference cannot make this additive migration fail; PostgreSQL
 * still enforces each constraint for every new or changed row.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE document_chunks
      ADD COLUMN IF NOT EXISTS source_document_version_id text;

    ALTER TABLE document_chunks
      ADD CONSTRAINT fk_document_chunks_source_document_scope
      FOREIGN KEY (document_id, workspace_id, project_id, azure_project_id)
      REFERENCES project_source_documents(id, workspace_id, project_id, azure_project_id)
      ON DELETE RESTRICT
      NOT VALID;

    ALTER TABLE document_chunks
      ADD CONSTRAINT fk_document_chunks_source_document_version_scope
      FOREIGN KEY (
        source_document_version_id, document_id, workspace_id, project_id, azure_project_id
      )
      REFERENCES project_source_document_versions(
        id, document_id, workspace_id, project_id, azure_project_id
      )
      ON DELETE RESTRICT
      NOT VALID;

    ALTER TABLE document_chunks
      ADD CONSTRAINT chk_document_chunks_version_requires_document
      CHECK (source_document_version_id IS NULL OR document_id IS NOT NULL)
      NOT VALID;

    /* New document chunks must carry the full scope that their FK verifies. */
    ALTER TABLE document_chunks
      ADD CONSTRAINT chk_uploaded_document_chunks_have_scoped_provenance
      CHECK (
        source_type <> 'uploaded_document'
        OR (
          document_id IS NOT NULL
          AND source_document_version_id IS NOT NULL
          AND workspace_id IS NOT NULL
        )
      )
      NOT VALID;

    /*
     * The FTS table is an application-maintained mirror, intentionally without
     * foreign keys.  Its explicit provenance columns let all retrieval signals
     * return document context without rejoining the primary chunk table.
     */
    ALTER TABLE document_chunks_fts
      ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'azure_work_item',
      ADD COLUMN IF NOT EXISTS document_id text,
      ADD COLUMN IF NOT EXISTS source_document_version_id text,
      ADD COLUMN IF NOT EXISTS section text,
      ADD COLUMN IF NOT EXISTS page_number integer;

    CREATE INDEX IF NOT EXISTS idx_document_chunks_source_document_lookup
      ON document_chunks (
        workspace_id,
        project_id,
        azure_project_id,
        document_id,
        source_document_version_id,
        chunk_index
      )
      WHERE document_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_document_chunks_fts_source_document_lookup
      ON document_chunks_fts (
        project_id,
        azure_project_id,
        source_type,
        document_id,
        source_document_version_id,
        chunk_id
      )
      WHERE document_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_document_chunks_fts_source_document_lookup;
    DROP INDEX IF EXISTS idx_document_chunks_source_document_lookup;

    ALTER TABLE document_chunks_fts
      DROP COLUMN IF EXISTS page_number,
      DROP COLUMN IF EXISTS section,
      DROP COLUMN IF EXISTS source_document_version_id,
      DROP COLUMN IF EXISTS document_id,
      DROP COLUMN IF EXISTS source_type;

    ALTER TABLE document_chunks
      DROP CONSTRAINT IF EXISTS chk_uploaded_document_chunks_have_scoped_provenance,
      DROP CONSTRAINT IF EXISTS chk_document_chunks_version_requires_document,
      DROP CONSTRAINT IF EXISTS fk_document_chunks_source_document_version_scope,
      DROP CONSTRAINT IF EXISTS fk_document_chunks_source_document_scope;

    ALTER TABLE document_chunks
      DROP COLUMN IF EXISTS source_document_version_id;
  `);
};
