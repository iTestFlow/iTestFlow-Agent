/* eslint-disable camelcase */

/**
 * Drop the dormant legacy `documents` table.
 *
 * The table shipped with the initial schema as a placeholder for uploaded
 * files but was never written or read by any code path (grep-verified before
 * this migration).  Uploaded documents now live in `project_source_documents`
 * plus `project_source_document_versions` (1710000033000).  The drop lives in
 * its own migration so 1710000033000 stays purely additive.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS documents;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    /* Restore the legacy shape exactly as the initial schema defined it. */
    CREATE TABLE IF NOT EXISTS documents (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      azure_project_name text,
      source_type text NOT NULL,
      document_name text NOT NULL,
      document_type text NOT NULL,
      file_path text,
      parse_status text NOT NULL,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
  `);
};
