/* eslint-disable camelcase */

/**
 * Story-scoped AI evidence. These objects deliberately do not reuse the
 * project document blob namespace: attachment deletion owns a private object
 * tree, so equal bytes on another story can never be removed by accident.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_story_attachment_scope
      ON projects (id, workspace_id, provider_id);

    CREATE TABLE story_attachments (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      project_id text NOT NULL,
      provider_id text NOT NULL CHECK (provider_id IN ('azure-devops', 'jira-cloud')),
      canonical_story_id text NOT NULL CHECK (canonical_story_id <> ''),
      story_display_key text NOT NULL CHECK (story_display_key <> ''),
      source_kind text NOT NULL CHECK (source_kind IN ('upload', 'azure_devops_attachment', 'jira_attachment')),
      source_attachment_id text,
      source_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      original_file_name text NOT NULL CHECK (original_file_name <> ''),
      mime_type text NOT NULL CHECK (mime_type <> ''),
      file_format text NOT NULL CHECK (file_format IN ('pdf', 'docx', 'xlsx', 'csv', 'txt', 'md', 'png', 'jpeg', 'webp')),
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      storage_key text NOT NULL CHECK (storage_key <> ''),
      parse_status text NOT NULL DEFAULT 'pending'
        CHECK (parse_status IN ('pending', 'parsing', 'parsed', 'partially_parsed', 'parse_failed')),
      parse_generation integer NOT NULL DEFAULT 1 CHECK (parse_generation >= 1),
      parsed_text text,
      parsed_sections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      parse_warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      parse_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      parse_error text,
      parse_recipe_version text,
      lifecycle_status text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'deleted')),
      storage_cleanup_status text NOT NULL DEFAULT 'not_requested'
        CHECK (storage_cleanup_status IN ('not_requested', 'pending', 'completed')),
      deleted_at text,
      deleted_by text,
      created_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_story_attachments_source_reference CHECK (
        (source_kind = 'upload' AND source_attachment_id IS NULL)
        OR (source_kind IN ('azure_devops_attachment', 'jira_attachment') AND source_attachment_id IS NOT NULL)
      ),
      CONSTRAINT chk_story_attachments_source_metadata_object
        CHECK (jsonb_typeof(source_metadata_json) = 'object'),
      CONSTRAINT chk_story_attachments_sections_array
        CHECK (jsonb_typeof(parsed_sections_json) = 'array'),
      CONSTRAINT chk_story_attachments_warnings_array
        CHECK (jsonb_typeof(parse_warnings_json) = 'array'),
      CONSTRAINT chk_story_attachments_metadata_object
        CHECK (jsonb_typeof(parse_metadata_json) = 'object'),
      CONSTRAINT chk_story_attachments_tombstone CHECK (
        (lifecycle_status = 'active'
          AND deleted_at IS NULL
          AND deleted_by IS NULL
          AND storage_cleanup_status = 'not_requested')
        OR (lifecycle_status = 'deleted'
          AND deleted_at IS NOT NULL
          AND deleted_by IS NOT NULL
          AND storage_cleanup_status IN ('pending', 'completed'))
      ),
      CONSTRAINT fk_story_attachments_project_scope
        FOREIGN KEY (project_id, workspace_id, provider_id)
        REFERENCES projects (id, workspace_id, provider_id)
        ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX uq_story_attachments_active_content
      ON story_attachments (
        workspace_id, project_id, provider_id, canonical_story_id, content_hash
      )
      WHERE lifecycle_status = 'active';
    CREATE INDEX idx_story_attachments_story
      ON story_attachments (
        workspace_id, project_id, provider_id, canonical_story_id, created_at DESC
      )
      WHERE lifecycle_status = 'active';
    CREATE INDEX idx_story_attachments_parse_pending
      ON story_attachments (parse_status, updated_at)
      WHERE lifecycle_status = 'active' AND parse_status IN ('pending', 'parsing');

    CREATE TABLE story_attachment_visuals (
      id text PRIMARY KEY,
      attachment_id text NOT NULL REFERENCES story_attachments(id) ON DELETE CASCADE,
      parse_generation integer NOT NULL CHECK (parse_generation >= 1),
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      visual_source text NOT NULL CHECK (visual_source IN ('original', 'pdf_page', 'docx_embedded')),
      source_locator text NOT NULL CHECK (source_locator <> ''),
      storage_key text NOT NULL CHECK (storage_key <> ''),
      mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
      byte_size bigint NOT NULL CHECK (byte_size > 0),
      width integer NOT NULL CHECK (width > 0),
      height integer NOT NULL CHECK (height > 0),
      created_at text NOT NULL,
      UNIQUE (attachment_id, parse_generation, ordinal)
    );
    CREATE INDEX idx_story_attachment_visuals_attachment
      ON story_attachment_visuals (attachment_id, parse_generation, ordinal);

    CREATE OR REPLACE FUNCTION prevent_story_attachment_identity_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
         OR NEW.project_id IS DISTINCT FROM OLD.project_id
         OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
         OR NEW.canonical_story_id IS DISTINCT FROM OLD.canonical_story_id
         OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
         OR NEW.source_attachment_id IS DISTINCT FROM OLD.source_attachment_id
         OR NEW.source_metadata_json IS DISTINCT FROM OLD.source_metadata_json
         OR NEW.original_file_name IS DISTINCT FROM OLD.original_file_name
         OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
         OR NEW.file_format IS DISTINCT FROM OLD.file_format
         OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
         OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
         OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Story attachment content identity is immutable.'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_story_attachments_immutable_identity
      BEFORE UPDATE ON story_attachments
      FOR EACH ROW
      EXECUTE FUNCTION prevent_story_attachment_identity_mutation();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_story_attachments_immutable_identity ON story_attachments;
    DROP FUNCTION IF EXISTS prevent_story_attachment_identity_mutation();
    DROP TABLE IF EXISTS story_attachment_visuals;
    DROP INDEX IF EXISTS idx_story_attachments_parse_pending;
    DROP INDEX IF EXISTS idx_story_attachments_story;
    DROP INDEX IF EXISTS uq_story_attachments_active_content;
    DROP TABLE IF EXISTS story_attachments;
    DROP INDEX IF EXISTS idx_projects_story_attachment_scope;
  `);
};
