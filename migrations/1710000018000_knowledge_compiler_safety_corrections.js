/* eslint-disable camelcase */

/**
 * Idempotent repair for databases that applied the knowledge compiler
 * foundation before its pre-merge ordering and provenance corrections.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE project_knowledge_base
      ADD COLUMN IF NOT EXISTS semantic_hash_version text,
      ADD COLUMN IF NOT EXISTS provenance_hash_version text;

    ALTER TABLE project_knowledge_revisions
      ADD COLUMN IF NOT EXISTS semantic_hash_version text,
      ADD COLUMN IF NOT EXISTS provenance_hash_version text;

    ALTER TABLE project_knowledge_drafts
      ADD COLUMN IF NOT EXISTS review_ready_at text;

    DROP INDEX IF EXISTS idx_project_knowledge_revision_number_unique;

    WITH chronological_revisions AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY project_id, azure_project_id
               ORDER BY created_at, id
             ) AS chronological_revision
      FROM project_knowledge_revisions
    )
    UPDATE project_knowledge_revisions revisions
    SET revision_number = chronological_revisions.chronological_revision
    FROM chronological_revisions
    WHERE revisions.id = chronological_revisions.id
      AND revisions.revision_number IS DISTINCT FROM chronological_revisions.chronological_revision;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_knowledge_revision_number_unique
      ON project_knowledge_revisions(project_id, azure_project_id, revision_number);

    UPDATE project_knowledge_base
    SET semantic_hash_version = CASE
          WHEN semantic_hash IS NULL THEN semantic_hash_version
          WHEN compiler_contract_version = '2.0.0' THEN 'semantic-v2'
          ELSE 'semantic-v1-backfill'
        END,
        provenance_hash_version = CASE
          WHEN provenance_hash IS NULL THEN provenance_hash_version
          WHEN compiler_contract_version = '2.0.0' THEN 'provenance-v2'
          ELSE 'provenance-v1-legacy'
        END
    WHERE (semantic_hash IS NOT NULL AND semantic_hash_version IS NULL)
       OR (provenance_hash IS NOT NULL AND provenance_hash_version IS NULL);

    UPDATE project_knowledge_revisions
    SET semantic_hash_version = CASE
          WHEN semantic_hash IS NULL THEN semantic_hash_version
          WHEN compiler_contract_version = '2.0.0' THEN 'semantic-v2'
          ELSE 'semantic-v1-backfill'
        END,
        provenance_hash_version = CASE
          WHEN provenance_hash IS NULL THEN provenance_hash_version
          WHEN compiler_contract_version = '2.0.0' THEN 'provenance-v2'
          ELSE 'provenance-v1-legacy'
        END
    WHERE (semantic_hash IS NOT NULL AND semantic_hash_version IS NULL)
       OR (provenance_hash IS NOT NULL AND provenance_hash_version IS NULL);

    WITH parsed_revisions AS (
      SELECT snapshots.id AS snapshot_id,
             snapshots.project_id,
             snapshots.azure_project_id,
             snapshots.azure_work_item_id,
             snapshots.content_hash,
             substring(items.raw_json from '"rev"[[:space:]]*:[[:space:]]*([0-9]+)')::integer AS ado_revision
      FROM azure_devops_work_item_snapshots snapshots
      JOIN azure_devops_work_items items
        ON items.project_id = snapshots.project_id
       AND items.azure_project_id = snapshots.azure_project_id
       AND items.azure_work_item_id = snapshots.azure_work_item_id
       AND items.current_snapshot_id = snapshots.id
      WHERE snapshots.ado_revision IS NULL
        AND items.raw_json ~ '"rev"[[:space:]]*:[[:space:]]*[0-9]+'
    ), safely_recoverable AS (
      SELECT parsed.snapshot_id, parsed.ado_revision
      FROM parsed_revisions parsed
      WHERE NOT EXISTS (
        SELECT 1
        FROM azure_devops_work_item_snapshots sibling
        WHERE sibling.project_id = parsed.project_id
          AND sibling.azure_project_id = parsed.azure_project_id
          AND sibling.azure_work_item_id = parsed.azure_work_item_id
          AND sibling.content_hash = parsed.content_hash
          AND COALESCE(sibling.ado_revision, -1) = parsed.ado_revision
          AND sibling.id <> parsed.snapshot_id
      )
    )
    UPDATE azure_devops_work_item_snapshots snapshots
    SET ado_revision = safely_recoverable.ado_revision
    FROM safely_recoverable
    WHERE snapshots.id = safely_recoverable.snapshot_id
      AND snapshots.ado_revision IS NULL;

    UPDATE project_knowledge_base
    SET stale_since = COALESCE(stale_since, updated_at, created_at),
        stale_reason_json = CASE
          WHEN stale_reason_json IS NULL OR stale_reason_json IN ('null'::jsonb, '[]'::jsonb)
            THEN jsonb_build_array(jsonb_build_object(
              'type', 'legacy_source_state',
              'detectedAt', COALESCE(stale_since, updated_at, created_at)
            ))
          ELSE stale_reason_json
        END
    WHERE freshness_status = 'stale'
      AND (
        stale_since IS NULL
        OR stale_reason_json IS NULL
        OR stale_reason_json IN ('null'::jsonb, '[]'::jsonb)
      );

    UPDATE project_knowledge_drafts
    SET review_ready_at = COALESCE(review_ready_at, updated_at)
    WHERE review_ready_at IS NULL
      AND status IN ('ready_for_review', 'blocked', 'published');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Intentionally irreversible. Chronological revision renumbering and
    -- recovered provenance metadata must not be discarded on rollback.
    SELECT 1;
  `);
};
