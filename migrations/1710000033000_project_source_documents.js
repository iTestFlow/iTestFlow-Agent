/* eslint-disable camelcase */

/**
 * M0 document-source foundation.
 *
 * `documents` intentionally remains untouched here.  It is a dormant legacy
 * table with a different, file-path based shape; dropping or repurposing it
 * would make this otherwise additive migration destructive.  New source
 * documents live in their own registry and point to immutable content-version
 * rows.  The dormant table is dropped separately in 1710000036000.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    /*
     * A project id is globally unique today, but this composite unique index
     * lets the source-document FK assert its stable workspace/project anchor.
     * Display fields such as azure_project_name must not participate: the
     * selection flow refreshes that name whenever Azure DevOps renames a
     * project, and a normal rename must not be blocked by source documents.
     */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_document_source_scope
      ON projects (
        id,
        workspace_id,
        azure_project_id
      );

    CREATE TABLE IF NOT EXISTS project_source_documents (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text NOT NULL,
      azure_organization_url text NOT NULL,
      document_name text NOT NULL,
      description text,
      tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      language_hint text,
      document_kind text NOT NULL CHECK (document_kind IN ('document', 'image')),
      source_connector text NOT NULL DEFAULT 'upload'
        CHECK (source_connector IN ('upload', 'sharepoint', 'confluence', 'drive', 'url', 'jira')),
      external_reference text,
      current_version_id text,
      lifecycle_status text NOT NULL DEFAULT 'active'
        CHECK (lifecycle_status IN ('active', 'archived')),
      archived_at text,
      archived_by text,
      archived_reason text,
      created_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_project_source_documents_tags_array
        CHECK (jsonb_typeof(tags_json) = 'array'),
      CONSTRAINT chk_project_source_documents_archive_state
        CHECK (
          (lifecycle_status = 'active'
            AND archived_at IS NULL
            AND archived_by IS NULL
            AND archived_reason IS NULL)
          OR (lifecycle_status = 'archived' AND archived_at IS NOT NULL)
        ),
      CONSTRAINT fk_project_source_documents_project_scope
        FOREIGN KEY (
          project_id,
          workspace_id,
          azure_project_id
        ) REFERENCES projects (
          id,
          workspace_id,
          azure_project_id
        ) ON DELETE RESTRICT,
      CONSTRAINT uq_project_source_documents_scope_identity
        UNIQUE (id, workspace_id, project_id, azure_project_id)
    );

    CREATE TABLE IF NOT EXISTS project_source_document_versions (
      id text PRIMARY KEY,
      document_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      version_number integer NOT NULL CHECK (version_number > 0),
      storage_backend text NOT NULL DEFAULT 'local_fs'
        CHECK (storage_backend IN ('local_fs', 's3', 'azure_blob')),
      storage_key text NOT NULL CHECK (storage_key <> ''),
      original_file_name text NOT NULL,
      mime_type text NOT NULL,
      file_format text NOT NULL
        CHECK (file_format IN ('pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'md', 'png', 'jpeg', 'webp')),
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      parse_status text NOT NULL DEFAULT 'pending'
        CHECK (parse_status IN ('pending', 'parsing', 'parsed', 'partially_parsed', 'parse_failed')),
      parse_error text,
      parse_warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      parse_recipe_version text,
      chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      uploaded_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_project_source_document_versions_warnings_array
        CHECK (jsonb_typeof(parse_warnings_json) = 'array'),
      CONSTRAINT chk_project_source_document_versions_metadata_object
        CHECK (jsonb_typeof(metadata_json) = 'object'),
      CONSTRAINT fk_project_source_document_versions_document_scope
        FOREIGN KEY (document_id, workspace_id, project_id, azure_project_id)
        REFERENCES project_source_documents (id, workspace_id, project_id, azure_project_id)
        ON DELETE RESTRICT,
      CONSTRAINT uq_project_source_document_versions_number
        UNIQUE (document_id, version_number),
      /* Used by the registry's current-version composite foreign key. */
      CONSTRAINT uq_project_source_document_versions_document_identity
        UNIQUE (id, document_id),
      /* Used by document_chunks' full trusted-scope provenance foreign key. */
      CONSTRAINT uq_project_source_document_versions_scope_identity
        UNIQUE (id, document_id, workspace_id, project_id, azure_project_id)
    );

    /*
     * A simple FK to version id would allow a document to point at another
     * document's version.  The composite key prevents that class of corrupt
     * provenance while leaving a newly-created document temporarily versionless
     * inside the transaction that creates its first version.
     */
    ALTER TABLE project_source_documents
      ADD CONSTRAINT fk_project_source_documents_current_version
      FOREIGN KEY (current_version_id, id)
      REFERENCES project_source_document_versions (id, document_id)
      ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED;

    /*
     * Version content identity is immutable: parsing can update its derived
     * status/metadata, but no code can silently repoint a provenance anchor to
     * different bytes, a different object key, or another document.
     */
    CREATE OR REPLACE FUNCTION prevent_project_source_document_version_identity_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.document_id IS DISTINCT FROM OLD.document_id
         OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
         OR NEW.project_id IS DISTINCT FROM OLD.project_id
         OR NEW.azure_project_id IS DISTINCT FROM OLD.azure_project_id
         OR NEW.version_number IS DISTINCT FROM OLD.version_number
         OR NEW.storage_backend IS DISTINCT FROM OLD.storage_backend
         OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.original_file_name IS DISTINCT FROM OLD.original_file_name
         OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
         OR NEW.file_format IS DISTINCT FROM OLD.file_format
         OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
         OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
         OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
          'Project source document version content identity is immutable.'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_project_source_document_versions_immutable_identity
      ON project_source_document_versions;
    CREATE TRIGGER trg_project_source_document_versions_immutable_identity
      BEFORE UPDATE ON project_source_document_versions
      FOR EACH ROW
      EXECUTE FUNCTION prevent_project_source_document_version_identity_mutation();

    CREATE INDEX IF NOT EXISTS idx_project_source_documents_project
      ON project_source_documents (workspace_id, project_id, azure_project_id);
    CREATE INDEX IF NOT EXISTS idx_project_source_documents_lifecycle
      ON project_source_documents (
        workspace_id,
        project_id,
        azure_project_id,
        lifecycle_status,
        updated_at DESC
      );
    CREATE INDEX IF NOT EXISTS idx_project_source_documents_current_version
      ON project_source_documents (current_version_id)
      WHERE current_version_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_project_source_document_versions_document
      ON project_source_document_versions (
        workspace_id,
        project_id,
        azure_project_id,
        document_id,
        version_number DESC
      );
    CREATE INDEX IF NOT EXISTS idx_project_source_document_versions_content_hash
      ON project_source_document_versions (
        workspace_id,
        project_id,
        azure_project_id,
        content_hash
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_project_source_document_versions_immutable_identity
      ON project_source_document_versions;
    DROP FUNCTION IF EXISTS prevent_project_source_document_version_identity_mutation();

    ALTER TABLE IF EXISTS project_source_documents
      DROP CONSTRAINT IF EXISTS fk_project_source_documents_current_version;

    DROP INDEX IF EXISTS idx_project_source_document_versions_content_hash;
    DROP INDEX IF EXISTS idx_project_source_document_versions_document;
    DROP INDEX IF EXISTS idx_project_source_documents_current_version;
    DROP INDEX IF EXISTS idx_project_source_documents_lifecycle;
    DROP INDEX IF EXISTS idx_project_source_documents_project;

    DROP TABLE IF EXISTS project_source_document_versions;
    DROP TABLE IF EXISTS project_source_documents;
    DROP INDEX IF EXISTS idx_projects_document_source_scope;
  `);
};
